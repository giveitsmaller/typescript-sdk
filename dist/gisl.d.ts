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
import { GislConfigError, GislFeatureRequiresAuthError, GislMissingCredentialsError } from './errors.js';
import { type ResolveCredentialsOptions, type ResolveEndpointOptions } from './credentials.js';
import type { CreditsUsageOptions, GislClientConfig, CapabilitiesSnapshot } from './types.js';
import type { AccountLimits, CreditsBalanceResponse, CreditsUsageResponse, OperationCapability, OperationType } from '@giveitsmaller/contracts/openapi';
import { OperationBuilder } from './builder.js';
import type { ConvertOptions, ThumbnailOptions } from './ergonomic/option_types.js';
import { MergeBuilder, type Asset, type MergeOptions } from './merge.js';
import { PresetDefaults } from './ergonomic/presets/index.js';
import { Recipe, FilesRecipe, BatchRecipe, type FileInput } from './file-first.js';
import { Handle } from './handle.js';
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
export declare const ANONYMOUS_ALLOWLIST: readonly [];
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
 * Operation types that need MORE THAN ONE input source, so they cannot be
 * driven through the single-input {@link ErgonomicClient.operation} escape
 * hatch — each has a dedicated multi-input builder (`merge(...)`,
 * `files(...).archive(...)`, `file(a).watermark(b)`). Excluded from
 * `operation()`'s op-type autocomplete.
 */
export type MultiInputOperationType = 'merge' | 'archive' | 'image_watermark' | 'video_watermark' | 'audio_overlay' | 'audio_to_video';
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
    operation<Op extends SingleInputOperationType>(opType: Op extends MultiInputOperationType ? never : Op, input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
};
/**
 * The `gisl` namespace — primary ergonomic-layer entry point.
 * Exports `gisl.create()` only for v0.7; `gisl.anonymous()` lands once
 * the anonymous-capable operation allowlist is non-empty (plan §12).
 */
export declare const gisl: {
    readonly create: typeof create;
};
export type { Environment } from './credentials.js';
/** @internal */
export declare function _internalAnonymous(opts?: GislCreateOptions): Promise<GislClient>;
export { GislConfigError, GislMissingCredentialsError, GislFeatureRequiresAuthError };
