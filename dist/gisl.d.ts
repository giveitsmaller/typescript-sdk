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
import { GislClient } from './client.js';
import { GislConfigError, GislFeatureRequiresAuthError, GislMissingCredentialsError } from './errors.js';
import { type ResolveCredentialsOptions, type ResolveEndpointOptions } from './credentials.js';
import type { CreditsUsageOptions, GislClientConfig, CapabilitiesSnapshot } from './types.js';
import { type AccountLimits, type CreditsBalanceResponse, type CreditsUsageResponse, type OperationCapability, type OperationType } from '@giveitsmaller/contracts/openapi';
import { OperationBuilder } from './builder.js';
import type { ConvertOptions, ThumbnailOptions } from './ergonomic/option_types.js';
import { MergeBuilder, type Asset, type MergeOptions } from './merge.js';
import { PresetDefaults } from './ergonomic/presets/index.js';
import { Recipe, FilesRecipe, BatchRecipe, type FileInput } from './file-first.js';
import { Handle } from './handle.js';
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
export declare const ANONYMOUS_ALLOWLIST: readonly ["uploadFile", "getMetadata", "createWorkflow", "createWorkflowAwaitingProbe", "getWorkflowStatus", "waitForWorkflow", "getWorkflowDownloads", "streamEvents", "getSchema", "submitContact", "maybeWaitForVideoProbe"];
export interface GislCreateOptions extends ResolveCredentialsOptions, ResolveEndpointOptions, Omit<GislClientConfig, 'baseUrl' | 'apiKey' | 'useSessionCookie' | 'streamBaseUrl'> {
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
export type GislAnonymousOptions = Omit<GislCreateOptions, 'apiKey' | 'profile' | 'profilePath' | 'useSessionCookie' | 'multipartThreshold' | 'multipartConcurrency' | 'multipartMaxAttempts' | 'multipartRetryBaseMs'>;
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
export declare function create(opts?: GislCreateOptions): Promise<ErgonomicClient>;
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
export declare function anonymous(opts?: GislAnonymousOptions): Promise<ErgonomicClient>;
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
export declare const MULTI_INPUT_OPERATION_TYPES: readonly ["merge", "archive", "image_watermark", "video_watermark", "audio_overlay", "audio_to_video", "custom_luma"];
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
    convert(input: string | Blob, options: ConvertOptions & {
        output_format: string;
    }): OperationBuilder;
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
    operation<Op extends SingleInputOperationType>(opType: Op extends MultiInputOperationType ? never : Op, input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
};
/**
 * The `gisl` namespace - primary ergonomic-layer entry point.
 * `gisl.create()` for an authenticated client; `gisl.anonymous()` for the
 * no-credential guest flow.
 */
export declare const gisl: {
    readonly create: typeof create;
    readonly anonymous: typeof anonymous;
};
export type { Environment } from './credentials.js';
/**
 * The gated LOW-LEVEL client behind `gisl.anonymous()` (no ergonomic verbs).
 * Kept underscore-prefixed so it does not reach the audit gate as a public
 * symbol; the public door is `gisl.anonymous()`.
 *
 * @internal
 */
export declare function _internalAnonymous(opts?: GislAnonymousOptions): Promise<GislClient>;
export { GislConfigError, GislMissingCredentialsError, GislFeatureRequiresAuthError };
