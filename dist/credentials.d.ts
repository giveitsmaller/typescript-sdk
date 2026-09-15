/**
 * Credential + endpoint resolution for the ergonomic-layer `gisl.create()`
 * factory. Implements an AWS-style short-circuiting chain:
 *   API key:    explicit arg → `GISL_API_KEY` env → `~/.gisl/credentials` profile
 *   Endpoint:   explicit arg → `GISL_ENVIRONMENT` / `GISL_BASE_URL` env → prod default
 *
 * Sources are tried in order; the first hit wins. Malformed profile files
 * surface as `GislConfigError` naming the offending profile (NEVER the value
 * — credential values must not appear in error messages).
 *
 * Browser-safe: profile-file lookups dynamic-import `node:fs/promises` only
 * when a profile path is requested AND a Node runtime is detected; missing
 * fs in the browser yields the typed
 * `GislConfigError('profile_unavailable_in_runtime')`.
 */
export declare const GISL_API_KEY_ENV = "GISL_API_KEY";
export declare const GISL_BASE_URL_ENV = "GISL_BASE_URL";
export declare const GISL_ENVIRONMENT_ENV = "GISL_ENVIRONMENT";
export declare const GISL_STREAM_BASE_URL_ENV = "GISL_STREAM_BASE_URL";
/**
 * Named environments → base URLs. Kept colocated with the resolver so the
 * mapping table doesn't leak into `gisl.ts`.
 */
export declare const ENVIRONMENT_ENDPOINTS: Readonly<{
    readonly prod: "https://api.giveitsmaller.com";
    readonly staging: "https://api.staging.giveitsmaller.com";
}>;
export type Environment = keyof typeof ENVIRONMENT_ENDPOINTS;
export declare const DEFAULT_ENDPOINT: "https://api.giveitsmaller.com";
/**
 * Named environments → **SSE stream host**. A SECOND host, deliberately
 * separate from {@link ENVIRONMENT_ENDPOINTS}: the API host fronts an
 * integration with no response-streaming mode, so the event stream lives on
 * its own public entry point.
 *
 * ⚠️ **DECLARED, NEVER DERIVED.** This table exists because the alternative —
 * transforming `api.*` into `stream.*` by string surgery — is a *convention*,
 * and a convention is exactly what put production on the gateway path: the
 * frontend's prod build had no `VITE_SSE_BASE_URL`, silently fell back to the
 * API host, and nobody could see it. A host is a fact somebody states, not a
 * pattern somebody guesses.
 *
 * PINNED to the generated `availability.json`
 * `endpoints['GET /api/workflows/{id}/events'].servers` by
 * `tests/unit/stream-host-conformance.test.ts`, which fails **closed**: if the
 * contract declares a host this table does not carry (or vice versa), the
 * build breaks. Hand-maintained rather than read at runtime because the SDK
 * ships a browser entry point and does not load `availability.json` — the same
 * table+conformance shape used by `COMPRESS_OPTION_VALUES`,
 * `OUTPUT_OPTION_DEPENDS_ON`, the preset planned gate and the watermark gate.
 *
 * `prod` landed with contracts `v2.195.0` (#410), which declared the production
 * stream host. It is here because the CONTRACT declares it — the entry and the
 * vendored declaration moved in the same change, never ahead of it.
 *
 * ⚠️ **A CONFIGURATION WITH NO DECLARED HOST STILL FAILS CLOSED.** Both entries
 * being present does not soften the rule: {@link resolveStreamEndpoint} returns
 * `null` for anything it cannot resolve from a declaration, and
 * `GislClient.streamEvents` raises rather than quietly reusing `baseUrl`.
 *
 * `localhost` is intentionally absent too: it is declared in the contract as a
 * development server, but there is no `localhost` *environment* name to key it
 * off. Local callers pass `{streamBaseUrl}` or set `GISL_STREAM_BASE_URL`.
 * ⚠️ **FROZEN, AND PART OF THE PUBLIC SURFACE.** Both tables are exported from the
 * package barrel because the SDK requires callers on the low-level surface to
 * supply `streamBaseUrl` and previously published no way to learn the declared
 * hosts. They are the SAME objects this module's resolvers read, so a consumer
 * mutating one would have repointed the SDK's own resolution — hence
 * `Object.freeze`, which makes that a no-op in sloppy mode and a `TypeError`
 * under `'use strict'` (every ES module) rather than a silent redirection.
 */
export declare const ENVIRONMENT_STREAM_ENDPOINTS: Readonly<Partial<Record<Environment, string>>>;
export interface ResolveCredentialsOptions {
    /** Explicit API key — highest precedence. */
    readonly apiKey?: string;
    /** Profile name from `~/.gisl/credentials`. Default: `'default'`. */
    readonly profile?: string;
    /**
     * Cookie-mode flag. When `true`, the caller is authenticating via
     * session cookie (browser SPA flow) and a missing apiKey is NOT a
     * configuration error — `resolveApiKey` returns `null` without
     * throwing, and the ergonomic-layer factory accepts it.
     */
    readonly useSessionCookie?: boolean;
    /** Override the profile-file path (testing). */
    readonly profilePath?: string;
}
export interface ResolveEndpointOptions {
    readonly baseUrl?: string;
    readonly environment?: Environment;
    /**
     * Explicit SSE stream host. Highest precedence for stream resolution, and
     * the ONLY knob that moves the stream **without** moving every other call —
     * overriding `baseUrl` moves uploads, workflow-create and downloads too.
     */
    readonly streamBaseUrl?: string;
}
/**
 * Resolve the API key via the credential chain. Returns the resolved key,
 * or `null` if no source produced one. The ergonomic-layer factory is
 * responsible for deciding whether `null` is an error (default: yes, throw
 * `GislMissingCredentialsError`) or acceptable (anonymous / cookie-mode).
 */
export declare function resolveApiKey(opts?: ResolveCredentialsOptions): Promise<string | null>;
/**
 * Resolve the base URL. Explicit `baseUrl` wins; otherwise an explicit
 * `environment` name; otherwise the `GISL_BASE_URL` / `GISL_ENVIRONMENT`
 * env vars; otherwise the prod default. Never throws — the chain always
 * resolves to a usable URL.
 */
export declare function resolveEndpoint(opts?: ResolveEndpointOptions): string;
/**
 * Resolve the **SSE stream host**, or `null` when no host is declared for this
 * configuration. Explicit `streamBaseUrl` wins; otherwise an explicit
 * `environment` name; otherwise `GISL_STREAM_BASE_URL`; otherwise the
 * `GISL_ENVIRONMENT` env var.
 *
 * ⚠️ **RETURNS `null` RATHER THAN FALLING BACK TO `baseUrl`, AND THAT IS THE
 * WHOLE POINT OF THIS FUNCTION.** Deriving the stream host from the API host
 * would reproduce, inside a published SDK, the exact failure this resolver
 * exists to prevent: prod had no stream host configured, fell back to the API
 * host by convention, and landed on the gateway path where the stream cannot
 * work. A silent fallback is not a lenient control — it is the absence of one
 * wearing the control's name. Callers decide what `null` means; see
 * `GislClient.streamEvents`, which fails closed and names the missing
 * declaration.
 *
 * Unlike {@link resolveEndpoint}, there is no default: prod has no declared
 * stream host yet (see {@link ENVIRONMENT_STREAM_ENDPOINTS}), so a default
 * could only be a guess.
 *
 * Throws `GislConfigError` on an unknown explicit `environment` name — the
 * same fail-closed behaviour as {@link resolveEndpoint}, for the same reason
 * (a typo must not silently re-route a stream).
 */
export declare function resolveStreamEndpoint(opts?: ResolveEndpointOptions): string | null;
/**
 * Human-readable list of the environments that currently declare a stream
 * host. Used in the fail-closed error message so the caller is told what IS
 * available rather than only what is missing.
 */
export declare function declaredStreamEnvironments(): readonly string[];
