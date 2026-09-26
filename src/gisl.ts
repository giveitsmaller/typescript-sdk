/**
 * Ergonomic-layer entrypoint for the GISL SDK. Wraps the low-level
 * `GislClient` (transport, multipart, SSE, downloads) with credential-chain
 * resolution + ergonomic factory functions. Designed to feel native to a
 * developer writing `import { gisl } from '@giveitsmaller/sdk'` and then
 * `const client = await gisl.create();`.
 *
 * Two factories:
 * - `gisl.create()` — resolves credentials + endpoint via `credentials.ts`,
 *   fails early with `GislMissingCredentialsError` when no apiKey is found
 *   AND the caller hasn't opted into cookie-mode. It never falls back to
 *   anonymous: a missing key there is usually a misconfiguration.
 * - `gisl.anonymous()` — the explicit opt-in to the no-credential flow
 *   (`OuegCUtq`). Gated by `ANONYMOUS_ALLOWLIST`, which is pinned to the
 *   endpoints the vendored contract marks anonymous-capable.
 */

import { GislClient, _markAnonymousClient } from './client.js';
import {
  GislConfigError,
  GislFeatureRequiresAuthError,
  GislMissingCredentialsError,
} from './errors.js';
import {
  resolveApiKey,
  resolveEndpoint,
  resolveStreamEndpoint,
  type ResolveCredentialsOptions,
  type ResolveEndpointOptions,
} from './credentials.js';
import type { CreditsUsageOptions, GislClientConfig, CapabilitiesSnapshot } from './types.js';
import {
  UploadThresholdsSingleShotMaxBytesEnum,
  type AccountLimits,
  type CreditsBalanceResponse,
  type CreditsUsageResponse,
  type OperationCapability,
  type OperationType,
} from '@giveitsmaller/contracts/openapi';
import { OperationBuilder } from './builder.js';
import {
  validateVerbOptions,
  validateSingleOpConvertOptions,
  assertThumbnailDimensions,
} from './ergonomic/option_validation.js';
import type { ConvertOptions, ThumbnailOptions } from './ergonomic/option_types.js';
import { MergeBuilder, asset, type Asset, type MergeOptions } from './merge.js';
import { PresetDefaults } from './ergonomic/presets/index.js';
import { Recipe, FilesRecipe, BatchRecipe, fileInput, type FileInput } from './file-first.js';
import { Handle } from './handle.js';
import { createWorkflowAwaitingProbe, type CreateAwaitingProbeOptions } from './probe-pending.js';
import type { ReadCapabilityOptions, UploadOptions, WaitOptions, WorkflowCreatePayload } from './types.js';
// Remapped to the throwing browser stub by the package.json `browser` field,
// exactly as for client.ts: a path-string upload is Node-only either way.
import { stat } from './node-fs.js';

// ---------------------------------------------------------------------------
// Anonymous-capable operation allowlist (internal)
// ---------------------------------------------------------------------------

/**
 * Low-level `GislClient` methods that may be invoked on a `gisl.anonymous()`
 * client. Every other method throws `GislFeatureRequiresAuthError` before any
 * I/O.
 *
 * ⚠️ THIS LIST IS DERIVED, NOT CHOSEN (owner decision 610(4): the guest
 * surface is exactly what the API accepts). Each entry is here because every
 * endpoint it can reach on an anonymous client is marked `auth: optional` (or
 * `anonymous`) in the vendored `availability.json` AND is open to guests in the
 * API:
 *
 * | method | endpoint(s) |
 * |---|---|
 * | `uploadFile` | `POST /api/uploads` ONLY. A guest upload is single-shot: a file over the 10,000,000-byte single-shot cap, or a `resumeUploadId`, is refused locally before any request (see below). |
 * | `getMetadata` | `GET /api/uploads/{id}/metadata` |
 * | `createWorkflow` | `POST /api/workflows` |
 * | `createWorkflowAwaitingProbe` | `POST /api/workflows` (its probe wait goes back through this gate, so it cannot reach the `required` probe endpoint) |
 * | `getWorkflowStatus`, `waitForWorkflow` | `GET /api/workflows/{id}/status` |
 * | `getWorkflowDownloads` | `GET /api/workflows/{id}/downloads` |
 * | `streamEvents` | `GET /api/workflows/{id}/events` |
 * | `getSchema` | `GET /api/operations/schema` |
 * | `submitContact` | `POST /api/contact` |
 * | `maybeWaitForVideoProbe` | none — a no-op on an anonymous client, because the probe endpoint is `required` and the wait is best-effort by design |
 *
 * ⚠️ WHERE THE CONTRACT AND THE API DISAGREE, THE API WINS (hub directive).
 * Measured 2026-09-26 in compression_api `config/packages/security.yaml`
 * (origin/main 566d3350): `POST /api/uploads/multipart/initiate` and
 * `POST /api/operations/{id}/retry` are `IS_AUTHENTICATED_FULLY`, although
 * `availability.json` marks both `optional`. So multipart (initiate, and the
 * `/complete` that is useless without it) is NOT on the guest surface — which
 * makes 10,000,000 bytes (the single-shot cap, below the API's 10 MiB guest
 * cap) the effective guest file limit — and `retryOperation` is excluded.
 * Both are named, reasoned exclusions in the conformance test, to be removed
 * when the contract is corrected.
 *
 * `tests/unit/anonymous-allowlist-conformance.test.ts` fails in both
 * directions: an entry reaching a `required` endpoint, or a non-`required`
 * endpoint no entry reaches and no exclusion names.
 *
 * WHAT a guest may upload and run (today: images up to 10,000,000 bytes;
 * compress, convert, thumbnail; 30 creates/IP/day) is enforced by the API, not
 * here: the SDK surfaces the API's typed refusal rather than copying a list
 * that would drift. The one local check is the upload size, because above it
 * the only route is multipart, which a guest cannot use. See {@link anonymous}.
 *
 * @internal Not re-exported from the package entry points.
 */
export const ANONYMOUS_ALLOWLIST = [
  'uploadFile',
  'getMetadata',
  'createWorkflow',
  'createWorkflowAwaitingProbe',
  'getWorkflowStatus',
  'waitForWorkflow',
  'getWorkflowDownloads',
  'streamEvents',
  'getSchema',
  'submitContact',
  'maybeWaitForVideoProbe',
] as const satisfies readonly (keyof GislClient)[];

/**
 * The largest file a guest can upload: the contract's single-shot cap. The
 * API's own guest cap is 10 MiB, but multipart needs an account, so nothing
 * above single-shot can reach it.
 */
const ANONYMOUS_MAX_UPLOAD_BYTES: number =
  UploadThresholdsSingleShotMaxBytesEnum.NUMBER_10000000 satisfies number;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GislCreateOptions
  extends ResolveCredentialsOptions,
    ResolveEndpointOptions,
    // `streamBaseUrl` is omitted here and inherited from `ResolveEndpointOptions`
    // instead: both declare it, and the resolver's `readonly` form is the one
    // this factory's options should carry.
    Omit<GislClientConfig, 'baseUrl' | 'apiKey' | 'useSessionCookie' | 'streamBaseUrl'> {
  /**
   * Layered ergonomic preset defaults (T4a / VhIj4S7T). Built via
   * `presetDefaults().<cell>(level, overrides?)…`. The resolver wiring
   * that consumes this slot lands in T4b — until then, supplying this
   * field is a no-op at workflow-create time.
   */
  readonly presetDefaults?: PresetDefaults;
}

/**
 * Options for {@link anonymous} — {@link GislCreateOptions} minus every way of
 * supplying a credential. An anonymous client carries no API key, reads no
 * `GISL_API_KEY` / `~/.gisl/credentials` profile, and sends no session cookie;
 * it has no multipart knobs because a guest cannot upload multipart.
 */
export type GislAnonymousOptions = Omit<
  GislCreateOptions,
  | 'apiKey'
  | 'profile'
  | 'profilePath'
  | 'useSessionCookie'
  // Multipart needs an account, so a guest has no multipart to tune.
  | 'multipartThreshold'
  | 'multipartConcurrency'
  | 'multipartMaxAttempts'
  | 'multipartRetryBaseMs'
>;

/**
 * Internal options shape for `_createInternal()` — extends the public
 * `GislCreateOptions` with the `allowAnonymous` flag. Kept off the public
 * type so callers can NOT opt into anonymous mode via `gisl.create()`: the
 * only door is `gisl.anonymous()` (codex r1 medium 9d56061c3229).
 *
 * @internal
 */
interface _InternalCreateOptions extends GislCreateOptions {
  readonly allowAnonymous?: boolean;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Construct an ergonomic-layer client. Resolves the API key + base URL via
 * the credential chain (see `credentials.ts`) and constructs a low-level
 * `GislClient`. Throws `GislMissingCredentialsError` synchronously before
 * any HTTP I/O when no key is found AND neither `useSessionCookie` nor
 * `allowAnonymous` is set.
 *
 * Cookie-mode (`useSessionCookie: true`) explicitly bypasses the missing-
 * credentials check — browser SPAs that drive auth via `client.login()`
 * legitimately have no apiKey at construction time.
 */
export async function create(opts: GislCreateOptions = {}): Promise<ErgonomicClient> {
  // Extract presetDefaults BEFORE `_createInternal` destructures and
  // strips it — the resolver needs the value for every operation call,
  // not just construction. `_createInternal` still strips the slot
  // from the low-level `GislClient` config (no leak into transport).
  const presetDefaults = opts.presetDefaults;
  return wrapErgonomic(await _createInternal(opts), presetDefaults);
}

/**
 * Construct an ergonomic client with NO credential — the guest front door
 * (`OuegCUtq`):
 *
 * ```ts
 * const client = await gisl.anonymous({ environment: 'staging' });
 * const result = await client.file('photo.jpg').compress().run();
 * ```
 *
 * Never reads an API key from anywhere (explicit, `GISL_API_KEY`, or the
 * `~/.gisl/credentials` profile) and sends no session cookie, so no request it
 * makes carries a credential of any kind.
 *
 * Only the methods in the anonymous allowlist — upload, workflow create, status,
 * wait, downloads, events, metadata, schema, contact — work; everything else
 * (credits, limits, cancel, resume, retry, list, probe, profile, login/logout…)
 * throws `GislFeatureRequiresAuthError` before any I/O. The
 * file-first and single-op builders (`file()`, `files()`, `compress()`, `run()`,
 * `submit()`) work through that gate.
 *
 * The workflow capability token (`cap`) that an anonymous create returns is
 * remembered per workflow and sent as `X-Workflow-Capability` on that
 * workflow's status / downloads / events reads, so `run()` and
 * `submit().wait()` need nothing from you. It lives only in this client: a
 * workflow re-attached from another process (`client.workflow(id)`) has no
 * `cap`, so read it with the low-level `getWorkflowStatus(id, { capability })`.
 *
 * **What a guest may do is the API's rule, not the SDK's.** The SDK does not
 * pre-check the media, operation or quota rules, so they cannot drift from the
 * server's; it checks only the file size, which is a transport fact (above the
 * single-shot cap the only route is multipart). As the API enforces
 * it today (owner decision 610(4); not yet declared machine-readably in the
 * contract, so it is stated here rather than pinned):
 * - uploads: images only, at most 10,000,000 bytes per file, single-shot. The
 *   API's guest cap is 10 MiB, but multipart needs an account, so the
 *   single-shot cap is the one that binds. A larger file is refused HERE,
 *   before any request, with `GislFeatureRequiresAuthError`; a non-image is
 *   refused by the API as a `GislTierRestrictedError` (`restrictionKind`
 *   `mime_type`).
 * - operations: `compress`, `convert` and `thumbnail`. Anything else is a 403
 *   at workflow create: a `GislApiError` with `errorCode`
 *   `ANONYMOUS_OPERATION_NOT_ALLOWED`.
 * - 30 workflow creates per IP per 24 hours: then `GislApiError` with
 *   `errorCode` `ANONYMOUS_QUOTA_EXHAUSTED` (plus the usual per-minute 429s).
 *
 * `gisl.create()` is unchanged: without a key it still throws
 * `GislMissingCredentialsError` and never falls back to this mode.
 */
export async function anonymous(opts: GislAnonymousOptions = {}): Promise<ErgonomicClient> {
  const presetDefaults = opts.presetDefaults;
  return wrapErgonomic(await _internalAnonymous(opts), presetDefaults);
}

/**
 * Compose the ergonomic operation surface (`.compress` / `.convert` /
 * `.thumbnail`) on top of a `GislClient` via Proxy — matches the
 * `wrapAnonymous` precedent (no prototype mutation). For `gisl.anonymous()`
 * the anonymous gate is the INNER layer and this one wraps it, so the
 * builders this creates receive the gated client as their `target` and every
 * low-level call they make passes the allowlist.
 */
function wrapErgonomic(
  client: GislClient,
  presetDefaults?: PresetDefaults,
  scopedPresetDefaults?: PresetDefaults,
): ErgonomicClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'file') {
        // File-first entry point — the subject of the file-first surface.
        // A bare string is a filesystem path, a Blob/File an in-memory input;
        // pass a `FileInput` (e.g. `fileInput.uploadId(...)`) to reuse a
        // pre-uploaded file. `key` is RESULT-addressing only. The Proxy's
        // closure forwards the same preset-defaults references the op builders
        // get, so a file-first `compress()` resolves presets identically.
        return (input: string | Blob | FileInput, key?: string): Recipe => {
          const resolved: FileInput =
            typeof input === 'string'
              ? fileInput.path(input)
              : input instanceof Blob
                ? fileInput.blob(input)
                : input;
          return new Recipe(resolved, key, [], presetDefaults, scopedPresetDefaults, target);
        };
      }
      if (prop === 'files') {
        // Homogeneous fan-out entry point (FF3a) — apply ONE recipe (op chain)
        // to MANY input files in ONE workflow. Each element is coerced the same
        // way `file()` coerces its single input: a bare string is a filesystem
        // path, a Blob/File an in-memory input, a `FileInput` passed through.
        // The fan-out's RunResult partitions per input by 0-based index.
        return (inputs: ReadonlyArray<string | Blob | FileInput>): FilesRecipe => {
          if (inputs.length === 0) {
            // A zero-input fan-out is a caller error — "one failing input
            // doesn't sink the rest" is meaningless with no inputs, and it
            // would otherwise create an empty-jobs workflow the API 422s.
            throw new GislConfigError('files() requires at least one input file.', {
              reason: 'no_inputs',
            });
          }
          const resolved: FileInput[] = inputs.map((input) =>
            typeof input === 'string'
              ? fileInput.path(input)
              : input instanceof Blob
                ? fileInput.blob(input)
                : input,
          );
          return new FilesRecipe(resolved, [], presetDefaults, scopedPresetDefaults, target);
        };
      }
      if (prop === 'batch') {
        // Keyed multi-recipe batch entry point (FF7). Run N DISTINCT single-input
        // keyed recipes as ONE workflow; run() partitions the RunResult per entry
        // by the caller key given at `file(input, key)` time. Client-only ctor —
        // each entry already captured its own preset defaults at `client.file(...)`
        // time, so batch never re-plumbs presetDefaults/scopedPresetDefaults.
        return (recipes: ReadonlyArray<Recipe>): BatchRecipe =>
          new BatchRecipe(recipes, target);
      }
      if (prop === 'workflow') {
        // Reattach to a previously-created workflow (FF5a). Returns a
        // client-bound Handle with no webhookSecret and no recipe key —
        // its RunResult is therefore keyless (succeeded[].key === null).
        return (id: string): Handle => new Handle(id, undefined, target);
      }
      if (prop === 'compress' || prop === 'convert' || prop === 'thumbnail' || prop === 'transform') {
        return (input: string | Blob, options: Record<string, unknown> = {}): OperationBuilder => {
          // ExVcchMz — validate the option bag pre-upload for the exported
          // single-op builder so a bad bag (unknown key / missing thumbnail dims /
          // missing convert target) fails locally instead of as a server 422.
          // `compress` is EXCLUDED: it validates through the preset resolver
          // (resolveCompressOptions / KNOWN_WIRE_FIELDS), not these guards.
          // `convert` uses a SINGLE-OP-specific guard (NOT validateVerbOptions):
          // the single-op builder has no positional format, so its target rides
          // the bag as `output_format` — which the file-first convert guard would
          // reject as positional-owned. `thumbnail` reuses the file-first guards
          // (it has no positional-owned keys).
          if (prop === 'convert') validateSingleOpConvertOptions(options);
          if (prop === 'thumbnail') {
            validateVerbOptions('thumbnail', options);
            assertThumbnailDimensions(options);
          }
          // `transform` is a passthrough (rotate/flip); no positional-owned keys
          // and no required dims — just the generic key-validation.
          if (prop === 'transform') validateVerbOptions('transform', options);
          // T4b — pass client-scope presetDefaults into the builder so
          // .run()/.submit() consult the preset resolver. The Proxy's
          // closure carries the same reference for every per-call
          // builder construction.
          // T4c — also forward the scopedPresetDefaults closure (from
          // `withPresetDefaults`); `undefined` on root clients.
          return new OperationBuilder(
            target,
            prop,
            input,
            options,
            presetDefaults,
            scopedPresetDefaults,
          );
        };
      }
      if (prop === 'withPresetDefaults') {
        // T4c — immutable scoped derive. Computes mergedScoped =
        // (parent.scoped === undefined ? new : PresetDefaults.merge(
        // parent.scoped, new)) and returns a new Proxy wrapping the SAME
        // underlying GislClient `target` (identity preservation —
        // baseUrl / apiKey / headers / timeouts / multipart / session-
        // cookie all by reference). Does NOT re-trigger _createInternal
        // / resolveApiKey (codex r2 invariant — derives never re-read
        // env or profile).
        return (defaults: PresetDefaults): ErgonomicClient => {
          const mergedScoped =
            scopedPresetDefaults === undefined
              ? defaults
              : PresetDefaults.merge(scopedPresetDefaults, defaults);
          return wrapErgonomic(target, presetDefaults, mergedScoped);
        };
      }
      if (prop === 'merge') {
        // merge(...) accepts a mix of:
        // - Asset objects (handle/path) — declared explicitly
        // - string | Blob — wrapped via `asset()`
        // - MergeOptions (always LAST) — sniffed by the absence of asset shape
        return (...args: ReadonlyArray<string | Blob | Asset | MergeOptions>): MergeBuilder => {
          let mergeOpts: MergeOptions = {};
          let last = args.length > 0 ? args[args.length - 1] : undefined;
          if (isMergeOptions(last)) {
            mergeOpts = last;
            args = args.slice(0, -1);
          }
          const declared: Asset[] = args.map((a) => {
            if (typeof a === 'string' || a instanceof Blob) return asset(a);
            // Asset (handle or path).
            return a as Asset;
          });
          return new MergeBuilder(target, declared, mergeOpts);
        };
      }
      // 8yqUXLCS — first-class ergonomic billing/limits accessors (thin fluent
      // aliases over the low-level getters, surfaced + documented here rather
      // than relying on undocumented Proxy passthrough).
      if (prop === 'credits') {
        return (): Promise<CreditsBalanceResponse> => target.getCreditsBalance();
      }
      if (prop === 'creditsUsage') {
        return (options?: CreditsUsageOptions): Promise<CreditsUsageResponse> =>
          target.getCreditsUsage(options);
      }
      if (prop === 'limits') {
        return (): Promise<AccountLimits> => target.getAccountLimits();
      }
      if (prop === 'capabilities') {
        // qUhxfDA5 — READ/PROJECTION over getSchema() surfacing the three
        // v2.124 capability fields (previously typed but with no ergonomic
        // consumer). No arg → the full CapabilitiesSnapshot; an opType → that
        // op's OperationCapability (or undefined when absent).
        return async (
          opType?: OperationType | (string & {}),
        ): Promise<CapabilitiesSnapshot | OperationCapability | undefined> => {
          const schema = await target.getSchema();
          // capabilities() passes no conditional headers, so getSchema()
          // normally returns the 200 hit with data. A 304 is only possible if
          // the caller globally configured a conditional header (e.g. a static
          // `If-None-Match` in `config.headers`) — an unusual, self-inflicted
          // case. Rather than throw, degrade to an empty projection (documented
          // on the method); a caller who forces revalidation gets no snapshot.
          const data = schema.notModified ? undefined : schema.data;
          const operations: Record<string, OperationCapability> = data?.capabilities ?? {};
          if (opType !== undefined) {
            return operations[opType];
          }
          return {
            operations,
            outputProperties: data?.outputProperties ?? {},
            ...(data?.imageEncodeCapabilities !== undefined
              ? { imageEncode: data.imageEncodeCapabilities }
              : {}),
          };
        };
      }
      if (prop === 'operation') {
        // qUhxfDA5 — generic escape-hatch sibling of the single-op verbs
        // (compress/convert/thumbnail). Builds a SINGLE-input, SINGLE-operation
        // job for an op type with no typed verb (e.g. `text_watermark`, `split`,
        // or a not-yet-in-contract op). Options ride through to the wire
        // unchanged (no preset resolution unless opType is 'compress'); the only
        // pre-upload check is the planned-everywhere value gate (99Da2uyx) — the
        // server validates everything else.
        //
        // Multi-input operations canNOT be expressed here — they need multiple
        // sources. They are excluded from the op-type param; see
        // MultiInputOperationType for which have a builder and which have none.
        return (
          opType: SingleInputOperationType,
          input: string | Blob,
          options: Record<string, unknown> = {},
        ): OperationBuilder =>
          new OperationBuilder(target, opType, input, options, presetDefaults, scopedPresetDefaults);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as ErgonomicClient;
}

/**
 * Sniff whether the final argument to `merge(...)` is a `MergeOptions`
 * object rather than an `Asset`. Heuristic: an `Asset` always has a
 * `type` field with `'handle'` or `'path'`; a `MergeOptions` does not.
 */
function isMergeOptions(value: unknown): value is MergeOptions {
  if (value === null || typeof value !== 'object') return false;
  if (typeof (value as { then?: unknown }).then === 'function') return false;
  if (value instanceof Blob) return false;
  const t = (value as { type?: unknown }).type;
  if (t === 'handle' || t === 'path' || t === 'clip') return false;
  return true;
}

/**
 * Operation types that need MORE THAN ONE input source, so they cannot be
 * driven through the single-input {@link ErgonomicClient.operation} escape
 * hatch. Excluded from `operation()`'s op-type autocomplete.
 *
 * Four have a dedicated multi-input builder: `merge` → `merge(...)`, `archive`
 * → `files(...).archive(...)`, `image_watermark` / `video_watermark` →
 * `file(a).watermark(b)`. ⚠️ `audio_overlay`, `audio_to_video` and
 * `custom_luma` have NO builder: the contract marks all three `planned`
 * (workflow-create returns `feature_not_available`), so a builder could only
 * refuse. Only the low-level `createWorkflow()` can send them. A test fails when
 * any of them is re-listed, or when the contract adds a multi-input op this
 * list does not name.
 */
export type MultiInputOperationType = (typeof MULTI_INPUT_OPERATION_TYPES)[number];

/**
 * Runtime source of {@link MultiInputOperationType}, so the conformance test can
 * compare it to the contract at runtime; a type alone has no values to compare.
 *
 * @internal Not re-exported from the package entry points.
 */
export const MULTI_INPUT_OPERATION_TYPES = [
  'merge',
  'archive',
  'image_watermark',
  'video_watermark',
  'audio_overlay',
  'audio_to_video',
  'custom_luma',
] as const;

/**
 * Op types reachable via {@link ErgonomicClient.operation}: every
 * {@link OperationType} except the {@link MultiInputOperationType} ones, widened
 * with `(string & {})` so a genuinely-unknown (not-yet-in-contract) op type is
 * still accepted while known single-input ops keep autocomplete.
 */
export type SingleInputOperationType = Exclude<OperationType, MultiInputOperationType> | (string & {});

/**
 * The ergonomic-client surface: `GislClient` (verbatim low-level API)
 * plus three ergonomic op-builder factories. Intersection type — at
 * runtime the Proxy synthesises the three methods on-demand. `input`
 * accepts `string | Blob` matching `GislClient.uploadFile` (codex r1
 * low 89cae59f4f04 — Blob/File uploads were previously rejected by the
 * ergonomic factory's narrower string-only typing).
 */
export type ErgonomicClient = GislClient & {
  /**
   * File-first entry point (FF2a). Returns an immutable {@link Recipe} you
   * call operations on (`.compress()` / `.convert()` / `.thumbnail()` /
   * `.textWatermark()`), chaining sequentially. A bare string is a filesystem
   * path; pass a {@link FileInput} (e.g. `fileInput.uploadId(...)`) to reuse a
   * pre-uploaded file. `key` is RESULT-addressing only — never input wiring.
   * Execution (`run()`) lands in FF2b.
   */
  file(input: string | Blob | FileInput, key?: string): Recipe;
  /**
   * Homogeneous fan-out entry point (FF3a). Apply ONE recipe (op chain) to
   * MANY input files in ONE workflow. Each element is a filesystem path
   * (string), an in-memory {@link FileInput} via `fileInput.*`, or a Blob/File.
   * Returns an immutable {@link FilesRecipe} you call the same ops on
   * (`.compress()` / `.convert()` / `.thumbnail()` / `.textWatermark()`); the
   * chain applies to every input. `run()` returns a partitioned
   * {@link RunResult} keyed by each input's 0-based index — one bad input does
   * not sink the rest. `submit(webhook?)` is the fire-and-forget arm: it
   * returns a {@link Handle} whose `wait()`/`result()` partition per input.
   */
  files(inputs: ReadonlyArray<string | Blob | FileInput>): FilesRecipe;
  /**
   * Keyed multi-recipe batch entry point (FF7). Run N DISTINCT single-input
   * keyed {@link Recipe}s as ONE workflow — build each via
   * `client.file(input, key).<op>(...)` with a UNIQUE key, then
   * `client.batch([r1, r2, …]).run()`. The partitioned {@link RunResult}
   * addresses each entry's outputs by its caller key (`res.byKey('hero')`); one
   * failed entry lands in `failed` without sinking the rest.
   *
   * v1 accepts ONLY single-input {@link Recipe} entries — the multi-input
   * builders ({@link FilesRecipe} via `files(...)`, `merge(...)`, `archive(...)`,
   * `watermark(...)`) are rejected pre-upload with a typed {@link GislConfigError}.
   * `.run()`-only; `.submit()` / reattach are a follow-up.
   */
  batch(recipes: ReadonlyArray<Recipe>): BatchRecipe;
  /**
   * Reattach to a previously-created workflow (FF5a). Returns a client-bound
   * {@link Handle} you can `.status()` / `.wait()` / `.result()`. The handle
   * carries no `webhookSecret` and no recipe key, so the {@link RunResult}
   * from `wait()`/`result()` is keyless (`succeeded[].key === null`) — address
   * outputs positionally or via the sinks.
   */
  workflow(id: string): Handle;
  compress(input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
  /**
   * Single-op convert. The target format rides the bag as the required
   * `output_format` (the single-op builder has no positional format — that is
   * the file-first `Recipe.convert(format, …)` surface). Extra keys are the
   * typed {@link ConvertOptions}. A missing `output_format` is a compile-time
   * error (uFbM31dC); an unknown key is a compile-time error for an INLINE bag
   * only — aliased bags bypass TS excess-property checks — so the runtime guard
   * remains the backstop (also for untyped JS callers).
   */
  convert(input: string | Blob, options: ConvertOptions & { output_format: string }): OperationBuilder;
  /**
   * Single-op thumbnail. {@link ThumbnailOptions} requires `width` + `height`;
   * omitting either is a compile-time error (uFbM31dC). An unknown key is a
   * compile-time error for an INLINE bag only — aliased bags bypass TS
   * excess-property checks — so the runtime guard remains the backstop (also
   * for untyped JS callers).
   */
  thumbnail(input: string | Blob, options: ThumbnailOptions): OperationBuilder;
  /** Geometric transform (rotate/flip). Passthrough; the op is `planned` (server 422s until Lambdas ship). */
  transform(input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
  /**
   * Merge ordered-sequence factory (T3). Accepts a variadic list of assets
   * (strings/Blobs/`handle()`/`asset()`) optionally terminated by a
   * `MergeOptions` object. Returns a `MergeBuilder`; pin the play order
   * with `.sequence(...)`.
   */
  merge(...args: ReadonlyArray<string | Blob | Asset | MergeOptions>): MergeBuilder;
  /**
   * Immutable scoped derive (T4c — `ULAlOP6j`). Returns a new client
   * with `defaults` layered on top of the parent's scoped defaults.
   * Use for the "next N jobs" pattern — e.g. an evening batch needing
   * higher quality without mutating the long-lived parent client.
   *
   * Identity: the derived client shares the SAME underlying low-level
   * transport (baseUrl, apiKey, headers, timeouts, multipart, session
   * cookie) by reference. Safe for concurrent parent + derived use.
   *
   * Merge semantics (codex r2 #5 — scalar leaf): scoped per-cell fields
   * override the parent's scoped where defined; the parent's
   * `client.presetDefaults` layer is unaffected and still contributes
   * fields the scoped layer doesn't set.
   *
   * Does NOT re-resolve credentials. The derive never calls the
   * credential chain or constructor — it composes new closure values
   * over the existing transport.
   */
  withPresetDefaults(defaults: PresetDefaults): ErgonomicClient;
  /** Current credit balance (sugar for `getCreditsBalance()`). */
  credits(): Promise<CreditsBalanceResponse>;
  /** Credit usage history (sugar for `getCreditsUsage()`). */
  creditsUsage(options?: CreditsUsageOptions): Promise<CreditsUsageResponse>;
  /** Effective account limits / tier-resolved caps (sugar for `getAccountLimits()`). */
  limits(): Promise<AccountLimits>;
  /**
   * Operation-capability read helper (qUhxfDA5). A typed projection over
   * `getSchema()` that surfaces the tier-scoped operation-capability matrix,
   * the output-property table, and the image-encode capability matrix —
   * without dropping to the low-level `getSchema()` and its not-modified union.
   *
   * Called with no argument it returns the full {@link CapabilitiesSnapshot};
   * called with an operation type it returns just that op's
   * {@link OperationCapability}, or `undefined` when the op is absent from the
   * server's capability matrix.
   *
   * Degraded fallback: if the client is configured to force conditional
   * revalidation (a static `If-None-Match` in `config.headers`) the schema
   * fetch may 304 with no body — in that case the snapshot is empty / the
   * per-op lookup is `undefined`.
   */
  capabilities(): Promise<CapabilitiesSnapshot>;
  capabilities(opType: OperationType | (string & {})): Promise<OperationCapability | undefined>;
  /**
   * Generic operation escape hatch (qUhxfDA5). Build + run a SINGLE-input,
   * SINGLE-operation job for an op type with no first-class verb (e.g.
   * `text_watermark`, `split`, or a not-yet-in-contract op). `options` reach the
   * wire unchanged, with ONE pre-upload check: a value the contract marks
   * `planned` in every group that declares the option (e.g. split
   * `precision: 'exact'`) throws `GislConfigError` (`feature_not_available`)
   * before anything uploads. Everything else is validated by the server. NO
   * preset resolution unless `opType` is `compress`. Prefer the typed verbs
   * (`compress` / `convert` / `thumbnail`) when they exist — they add local
   * validation.
   *
   * Multi-input operations (see {@link MultiInputOperationType}) are REJECTED
   * at compile time: passing one of those literals is a type error. `merge`,
   * `archive` and the image/video watermarks have a builder (`merge(...)`,
   * `files(...).archive(...)`, `file(a).watermark(b)`); `audio_overlay`,
   * `audio_to_video` and `custom_luma` have none while the contract marks them
   * `planned`. A genuinely-unknown (not-yet-in-contract) op string is still
   * accepted.
   *
   * The generic parameter enforces the exclusion: a known single-input op or an
   * unknown string maps to itself, while a {@link MultiInputOperationType}
   * literal maps to `never` (so it cannot be passed).
   */
  operation<Op extends SingleInputOperationType>(
    opType: Op extends MultiInputOperationType ? never : Op,
    input: string | Blob,
    options?: Record<string, unknown>,
  ): OperationBuilder;
};

/**
 * Inner factory shared by `create()` and `_internalAnonymous()` — extracted
 * so the anonymous branch can ENTIRELY skip the credential chain rather
 * than just suppressing its throw (codex r1 high e9e1c1182d56 — without
 * this, env-resolved keys would silently attach an Authorization header
 * to anonymous calls and defeat the parking guarantee).
 *
 * @internal
 */
async function _createInternal(opts: _InternalCreateOptions): Promise<GislClient> {
  const {
    apiKey: explicitKey,
    profile,
    profilePath,
    useSessionCookie,
    baseUrl,
    environment,
    streamBaseUrl,
    allowAnonymous,
    // T4a slot — stripped from transportConfig so it does not leak
    // into the low-level `GislClientConfig` spread. The T4b resolver
    // reads `opts.presetDefaults` directly via its own path.
    presetDefaults: _presetDefaults,
    ...transportConfig
  } = opts;
  void _presetDefaults;

  const resolvedBaseUrl = resolveEndpoint({ baseUrl, environment });
  // Resolved SEPARATELY and never from `resolvedBaseUrl`. `null` here means
  // "nothing declares a stream host for this configuration" — a legitimate
  // state that `streamEvents` reports and `run()` handles by polling. Both
  // resolvers throw on an unknown explicit `environment`, so a typo cannot
  // split the two hosts across environments.
  const resolvedStreamBaseUrl = resolveStreamEndpoint({ baseUrl, environment, streamBaseUrl });

  // Anonymous mode entirely BYPASSES the credential chain. Any env / profile
  // key that happens to exist on the host MUST NOT leak into the request
  // (codex r1 high e9e1c1182d56). `apiKey` / `profile` / `useSessionCookie`
  // were destructured out above and are deliberately NOT re-applied: a
  // session cookie is a credential too, and an untyped JS caller could still
  // pass one. The client is built without them.
  if (allowAnonymous === true) {
    // No caller-supplied header may carry a credential either (codex on the
    // anonymous PR): Authorization and Cookie are dropped, case-insensitively.
    const guestHeaders = transportConfig.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(transportConfig.headers).filter(
            ([name]) => !['authorization', 'cookie'].includes(name.toLowerCase()),
          ),
        );
    const config: GislClientConfig = {
      baseUrl: resolvedBaseUrl,
      ...transportConfig,
      ...(guestHeaders === undefined ? {} : { headers: guestHeaders }),
      // Pinned, whatever an untyped caller passed: every upload the gate lets
      // through (<= the single-shot cap) must route single-shot.
      multipartThreshold: ANONYMOUS_MAX_UPLOAD_BYTES,
    };
    if (resolvedStreamBaseUrl !== null) {
      config.streamBaseUrl = resolvedStreamBaseUrl;
    }
    const guest = new GislClient(config);
    _markAnonymousClient(guest);
    return wrapAnonymous(guest);
  }

  // Cookie-mode: skip env / profile resolution entirely UNLESS the caller
  // ALSO passes an explicit `{apiKey}` (the mixed case is legitimate — a
  // cookie-authenticated SPA may also send a server-issued API key). Codex
  // r2 medium 913e4d8073f5 — without this, useSessionCookie=true could
  // silently pick up an ambient GISL_API_KEY or fail on a malformed local
  // profile, neither of which a cookie-auth caller expects.
  let resolvedKey: string | null;
  if (useSessionCookie === true && (explicitKey === undefined || explicitKey === '')) {
    resolvedKey = null;
  } else {
    resolvedKey = await resolveApiKey({
      apiKey: explicitKey,
      profile,
      profilePath,
      useSessionCookie,
    });
  }

  if (resolvedKey === null && useSessionCookie !== true) {
    throw new GislMissingCredentialsError(
      'No API key found via explicit arg, GISL_API_KEY env, or ~/.gisl/credentials profile. ' +
        'Pass {apiKey} explicitly, set GISL_API_KEY, populate ~/.gisl/credentials, ' +
        'or pass {useSessionCookie: true} for browser session-cookie authentication.',
    );
  }

  const config: GislClientConfig = {
    baseUrl: resolvedBaseUrl,
    ...transportConfig,
  };
  if (resolvedStreamBaseUrl !== null) {
    config.streamBaseUrl = resolvedStreamBaseUrl;
  }
  if (resolvedKey !== null) {
    config.apiKey = resolvedKey;
  }
  if (useSessionCookie !== undefined) {
    config.useSessionCookie = useSessionCookie;
  }

  return new GislClient(config);
}

/**
 * Wrap a `GislClient` so calls to non-allowlisted operations throw
 * `GislFeatureRequiresAuthError` BEFORE any I/O, and so the anonymous
 * workflow capability token is threaded automatically. Backs
 * `gisl.anonymous()`.
 *
 * Layering: the ergonomic Proxy wraps THIS Proxy, so every builder
 * (`file().compress().run()`, `submit()`, `Handle`) calls the low-level client
 * through the gate and through the `cap` store. A method on the raw client
 * that calls another method internally (`waitForWorkflow` ->
 * `getWorkflowStatus`) runs on the raw client, which is why the overrides below
 * inject `cap` at each entry point rather than relying on the inner call.
 *
 * @internal
 */
function wrapAnonymous(client: GislClient): GislClient {
  const allowlist: ReadonlySet<string> = new Set<string>(ANONYMOUS_ALLOWLIST);
  // workflowId -> `cap` from the anonymous create response. One entry per
  // workflow this client created; a guest's daily allowance bounds its size.
  const capabilityByWorkflow = new Map<string, string>();
  const withCapability = <T extends ReadCapabilityOptions>(workflowId: string, opts: T | undefined): T => {
    const remembered = capabilityByWorkflow.get(workflowId);
    return (opts?.capability === undefined && remembered !== undefined
      ? { ...opts, capability: remembered }
      : { ...opts }) as T;
  };

  // Entry points that need more than a pass-through. Each is ALSO in the
  // allowlist (a key outside it is unreachable: the gate throws first).
  const overrides: Partial<Record<keyof GislClient, unknown>> = {
    uploadFile: async (file: string | Blob, options?: UploadOptions) => {
      if (typeof options?.resumeUploadId === 'string' && options.resumeUploadId !== '') {
        // Resume walks `/status` and re-presigns via `/presign`: both need an
        // account.
        throw new GislFeatureRequiresAuthError(
          'uploadFile',
          'Resuming a multipart upload (resumeUploadId) is not available on an anonymous client: ' +
            'multipart uploads require an account. Use gisl.create({apiKey}).',
        );
      }
      // Multipart needs an account (the API requires auth on initiate), so a
      // guest upload is single-shot and capped at the single-shot size. Refuse
      // a larger file before any request rather than send an initiate the API
      // will 401. An unreadable path is left to uploadFile's own error.
      let size: number | undefined;
      if (typeof file === 'string') {
        try {
          size = (await stat(file)).size;
        } catch {
          size = undefined;
        }
      } else {
        size = file.size;
      }
      if (size !== undefined && size > ANONYMOUS_MAX_UPLOAD_BYTES) {
        throw new GislFeatureRequiresAuthError(
          'uploadFile',
          `This file is ${size} bytes. Anonymous uploads are single-shot, up to ` +
            `${ANONYMOUS_MAX_UPLOAD_BYTES} bytes; larger files need an account (multipart upload ` +
            'requires authentication). Use gisl.create({apiKey}).',
        );
      }
      return client.uploadFile(file, options);
    },
    createWorkflow: async (payload: WorkflowCreatePayload) => {
      const created = await client.createWorkflow(payload);
      if (typeof created.cap === 'string' && created.cap !== '') {
        capabilityByWorkflow.set(created.workflowId, created.cap);
      }
      return created;
    },
    // Routed through the gated proxy (not the raw client) so the create
    // records `cap`, and a `probe_pending` recovery's `waitForProbe` meets the
    // gate instead of calling the auth-required probe endpoint unauthenticated.
    createWorkflowAwaitingProbe: (payload: WorkflowCreatePayload, options?: CreateAwaitingProbeOptions) =>
      createWorkflowAwaitingProbe(gated, payload, options),
    getWorkflowStatus: (workflowId: string, opts?: ReadCapabilityOptions) =>
      client.getWorkflowStatus(workflowId, withCapability(workflowId, opts)),
    waitForWorkflow: (workflowId: string, options?: WaitOptions) =>
      client.waitForWorkflow(workflowId, withCapability(workflowId, options)),
    getWorkflowDownloads: (workflowId: string, opts?: ReadCapabilityOptions) =>
      client.getWorkflowDownloads(workflowId, withCapability(workflowId, opts)),
    streamEvents: (workflowId: string, opts?: Parameters<GislClient['streamEvents']>[1]) =>
      client.streamEvents(workflowId, withCapability(workflowId, opts)),
    // The probe endpoint is `required`, and the wait is best-effort by design
    // (a give-up already proceeds to create). An anonymous client therefore
    // skips it; the API then answers the create itself - for a guest's video,
    // with its typed anonymous refusal rather than a 401 from the probe.
    maybeWaitForVideoProbe: async (): Promise<void> => undefined,
  };

  const gated: GislClient = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'constructor') {
        return value;
      }
      if (!allowlist.has(prop)) {
        return () => {
          throw new GislFeatureRequiresAuthError(
            prop,
            `Operation '${prop}' is not available on an anonymous client: the API requires ` +
              'authentication for it. Use gisl.create({apiKey}) for authenticated access.',
          );
        };
      }
      const override = overrides[prop as keyof GislClient];
      return override !== undefined ? override : value.bind(target);
    },
  });
  return gated;
}

// ---------------------------------------------------------------------------
// Public `gisl` namespace
// ---------------------------------------------------------------------------

/**
 * The `gisl` namespace - primary ergonomic-layer entry point.
 * `gisl.create()` for an authenticated client; `gisl.anonymous()` for the
 * no-credential guest flow.
 */
export const gisl = {
  create,
  anonymous,
} as const;

// Re-export the option types so callers can satisfy them by name.
export type { Environment } from './credentials.js';

/**
 * The gated LOW-LEVEL client behind `gisl.anonymous()` (no ergonomic verbs).
 * Kept underscore-prefixed so it does not reach the audit gate as a public
 * symbol; the public door is `gisl.anonymous()`.
 *
 * @internal
 */
export async function _internalAnonymous(
  opts: GislAnonymousOptions = {},
): Promise<GislClient> {
  return _createInternal({ ...opts, allowAnonymous: true });
}

// Re-export error types for callers that want to `instanceof` them.
export { GislConfigError, GislMissingCredentialsError, GislFeatureRequiresAuthError };
