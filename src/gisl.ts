/**
 * Ergonomic-layer entrypoint for the GISL SDK. Wraps the low-level
 * `GislClient` (transport, multipart, SSE, downloads) with credential-chain
 * resolution + ergonomic factory functions. Designed to feel native to a
 * developer writing `import { gisl } from '@giveitsmaller/sdk'` and then
 * `const client = await gisl.create();`.
 *
 * Scope of this card (T1, `wVU4xHx3`):
 * - `gisl.create()` — full functionality. Resolves credentials + endpoint
 *   via `credentials.ts`, fails early with `GislMissingCredentialsError`
 *   when no apiKey is found AND the caller hasn't opted into cookie-mode
 *   or anonymous mode.
 * - INTERNAL `_gislAnonymous` capability + `ANONYMOUS_ALLOWLIST` constant
 *   are wired but NOT publicly exported until the free-tier launch decides
 *   which operations are anonymous-capable (plan §12 open decision). A
 *   non-empty allowlist + the named export will arrive in a follow-up PR
 *   the moment user picks; this card avoids shipping a dead `gisl.anonymous()`.
 */

import { GislClient } from './client.js';
import {
  GislConfigError,
  GislFeatureRequiresAuthError,
  GislMissingCredentialsError,
} from './errors.js';
import {
  resolveApiKey,
  resolveEndpoint,
  type ResolveCredentialsOptions,
  type ResolveEndpointOptions,
} from './credentials.js';
import type { CreditsUsageOptions, GislClientConfig, CapabilitiesSnapshot } from './types.js';
import type {
  AccountLimits,
  CreditsBalanceResponse,
  CreditsUsageResponse,
  OperationCapability,
  OperationType,
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

// ---------------------------------------------------------------------------
// Anonymous-capable operation allowlist (internal)
// ---------------------------------------------------------------------------

/**
 * Operations that may be invoked on a `gisl.anonymous()` client without
 * raising `GislFeatureRequiresAuthError`. Empty until the free-tier launch
 * decision lands (plan §12). Typed as a `readonly []` tuple (NOT
 * `readonly string[]`) so the audit-gate compile-time assertion in
 * `_audit.ts` fires if a future PR widens this without flipping the
 * parking-decision + adding the public `gisl.anonymous()` export.
 *
 * Consumers must not depend on its emptiness today — only `package.json`
 * `exports` keeps deep-imports blocked; the marker is internal.
 *
 * @internal
 */
export const ANONYMOUS_ALLOWLIST = [] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GislCreateOptions
  extends ResolveCredentialsOptions,
    ResolveEndpointOptions,
    Omit<GislClientConfig, 'baseUrl' | 'apiKey' | 'useSessionCookie'> {
  /**
   * Layered ergonomic preset defaults (T4a / VhIj4S7T). Built via
   * `presetDefaults().<cell>(level, overrides?)…`. The resolver wiring
   * that consumes this slot lands in T4b — until then, supplying this
   * field is a no-op at workflow-create time.
   */
  readonly presetDefaults?: PresetDefaults;
}

/**
 * Internal options shape for `_internalAnonymous()` — extends the public
 * `GislCreateOptions` with the `allowAnonymous` flag. Kept off the public
 * type so callers can NOT opt into anonymous mode via `gisl.create()`
 * before the allowlist user-decision lands (codex r1 medium 9d56061c3229).
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
 * Compose the ergonomic operation surface (`.compress` / `.convert` /
 * `.thumbnail`) on top of a `GislClient` via Proxy — matches the
 * `wrapAnonymous` precedent (no prototype mutation). Layer order is
 * builder-wrap INSIDE, anonymous-wrap OUTSIDE so the allowlist gate
 * runs last in `_internalAnonymous` (see `_createInternal`).
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
        // unchanged (no preset resolution unless opType is 'compress'); NO
        // pre-upload validation — the server validates.
        //
        // Multi-input operations (merge, archive, image/video/audio overlay
        // watermarks) canNOT be expressed here — they need multiple sources and
        // have dedicated builders (`merge(...)`, `files(...).archive(...)`,
        // `file(a).watermark(b)`). They are excluded from the op-type param.
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
 * hatch — each has a dedicated multi-input builder (`merge(...)`,
 * `files(...).archive(...)`, `file(a).watermark(b)`). Excluded from
 * `operation()`'s op-type autocomplete.
 */
export type MultiInputOperationType =
  | 'merge'
  | 'archive'
  | 'image_watermark'
  | 'video_watermark'
  | 'audio_overlay'
  | 'audio_to_video';

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
   * wire unchanged — there is NO pre-upload validation (the server validates) and
   * NO preset resolution unless `opType` is `compress`. Prefer the typed verbs
   * (`compress` / `convert` / `thumbnail`) when they exist — they add local
   * validation.
   *
   * Multi-input operations (`merge`, `archive`, overlay watermarks — see
   * {@link MultiInputOperationType}) are REJECTED at compile time: passing one
   * of those literals is a type error (its dedicated builder is `merge(...)`,
   * `files(...).archive(...)`, or `file(a).watermark(b)`). A genuinely-unknown
   * (not-yet-in-contract) op string is still accepted.
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
    allowAnonymous,
    // T4a slot — stripped from transportConfig so it does not leak
    // into the low-level `GislClientConfig` spread. The T4b resolver
    // reads `opts.presetDefaults` directly via its own path.
    presetDefaults: _presetDefaults,
    ...transportConfig
  } = opts;
  void _presetDefaults;

  const resolvedBaseUrl = resolveEndpoint({ baseUrl, environment });

  // Anonymous mode entirely BYPASSES the credential chain. Any env / profile
  // key that happens to exist on the host MUST NOT leak into the request
  // (codex r1 high e9e1c1182d56). Cookie-mode also bypasses, since the
  // caller authenticates via session cookie later.
  if (allowAnonymous === true) {
    const config: GislClientConfig = {
      baseUrl: resolvedBaseUrl,
      ...transportConfig,
    };
    if (useSessionCookie !== undefined) {
      config.useSessionCookie = useSessionCookie;
    }
    return wrapAnonymous(new GislClient(config));
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
 * `GislFeatureRequiresAuthError` BEFORE any I/O. This is the internal
 * capability that backs `gisl.anonymous()` once the allowlist is non-empty.
 *
 * @internal
 */
function wrapAnonymous(client: GislClient): GislClient {
  // Explicit Set<string> — `ANONYMOUS_ALLOWLIST` is currently typed as the
  // empty tuple `readonly []` (audit-gate parking-invariant in _audit.ts).
  // Without this, `new Set(ANONYMOUS_ALLOWLIST)` would infer `Set<never>`.
  const allowlist: Set<string> = new Set(ANONYMOUS_ALLOWLIST);
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value;
      }
      // Allow base infrastructure methods that don't carry user operations.
      if (
        prop.startsWith('_') ||
        prop === 'login' ||
        prop === 'logout' ||
        prop === 'getSchema' ||
        prop === 'submitContact' ||
        prop === 'constructor'
      ) {
        return value.bind(target);
      }
      // Allowlist gate: throw if the op isn't approved for anonymous use.
      if (!allowlist.has(prop)) {
        return () => {
          throw new GislFeatureRequiresAuthError(
            prop,
            `Operation '${prop}' is not available on an anonymous client. ` +
              `Use gisl.create({apiKey}) for authenticated access, or wait for the operation to be added to the anonymous allowlist.`,
          );
        };
      }
      return value.bind(target);
    },
  });
}

// ---------------------------------------------------------------------------
// Public `gisl` namespace
// ---------------------------------------------------------------------------

/**
 * The `gisl` namespace — primary ergonomic-layer entry point.
 * Exports `gisl.create()` only for v0.7; `gisl.anonymous()` lands once
 * the anonymous-capable operation allowlist is non-empty (plan §12).
 */
export const gisl = {
  create,
} as const;

// Re-export the option types so callers can satisfy them by name.
export type { Environment } from './credentials.js';

// `_internalAnonymous` is the implementation behind the future public
// `gisl.anonymous()` export. Kept underscore-prefixed so it does not
// reach the audit gate as a public symbol.
/** @internal */
export async function _internalAnonymous(
  opts: GislCreateOptions = {},
): Promise<GislClient> {
  return _createInternal({ ...opts, allowAnonymous: true });
}

// Re-export error types for callers that want to `instanceof` them.
export { GislConfigError, GislMissingCredentialsError, GislFeatureRequiresAuthError };
