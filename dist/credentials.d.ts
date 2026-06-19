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
/**
 * Named environments → base URLs. Kept colocated with the resolver so the
 * mapping table doesn't leak into `gisl.ts`.
 */
export declare const ENVIRONMENT_ENDPOINTS: {
    readonly prod: "https://api.giveitsmaller.com";
    readonly staging: "https://api.staging.giveitsmaller.com";
};
export type Environment = keyof typeof ENVIRONMENT_ENDPOINTS;
export declare const DEFAULT_ENDPOINT: "https://api.giveitsmaller.com";
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
