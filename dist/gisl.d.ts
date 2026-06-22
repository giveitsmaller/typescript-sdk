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
import type { CreditsUsageOptions, GislClientConfig } from './types.js';
import type { AccountLimits, CreditsBalanceResponse, CreditsUsageResponse } from '@giveitsmaller/contracts/openapi';
import { OperationBuilder } from './builder.js';
import { MergeBuilder, type Asset, type MergeOptions } from './merge.js';
import { PresetDefaults } from './ergonomic/presets/index.js';
import { Recipe, FilesRecipe, type FileInput } from './file-first.js';
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
export interface GislCreateOptions extends ResolveCredentialsOptions, ResolveEndpointOptions, Omit<GislClientConfig, 'baseUrl' | 'apiKey' | 'useSessionCookie'> {
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
     * Reattach to a previously-created workflow (FF5a). Returns a client-bound
     * {@link Handle} you can `.status()` / `.wait()` / `.result()`. The handle
     * carries no `webhookSecret` and no recipe key, so the {@link RunResult}
     * from `wait()`/`result()` is keyless (`succeeded[].key === null`) — address
     * outputs positionally or via the sinks.
     */
    workflow(id: string): Handle;
    compress(input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
    convert(input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
    thumbnail(input: string | Blob, options?: Record<string, unknown>): OperationBuilder;
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
