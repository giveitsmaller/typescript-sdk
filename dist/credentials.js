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
import { GislConfigError } from './errors.js';
// ---------------------------------------------------------------------------
// Environment constants
// ---------------------------------------------------------------------------
export const GISL_API_KEY_ENV = 'GISL_API_KEY';
export const GISL_BASE_URL_ENV = 'GISL_BASE_URL';
export const GISL_ENVIRONMENT_ENV = 'GISL_ENVIRONMENT';
/**
 * Named environments → base URLs. Kept colocated with the resolver so the
 * mapping table doesn't leak into `gisl.ts`.
 */
export const ENVIRONMENT_ENDPOINTS = {
    prod: 'https://api.giveitsmaller.com',
    staging: 'https://api.staging.giveitsmaller.com',
};
export const DEFAULT_ENDPOINT = ENVIRONMENT_ENDPOINTS.prod;
// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------
/**
 * Resolve the API key via the credential chain. Returns the resolved key,
 * or `null` if no source produced one. The ergonomic-layer factory is
 * responsible for deciding whether `null` is an error (default: yes, throw
 * `GislMissingCredentialsError`) or acceptable (anonymous / cookie-mode).
 */
export async function resolveApiKey(opts = {}) {
    // 1. Explicit wins.
    if (typeof opts.apiKey === 'string' && opts.apiKey.length > 0) {
        return opts.apiKey;
    }
    // 2. Environment variable.
    const envKey = readEnv(GISL_API_KEY_ENV);
    if (envKey !== null && envKey.length > 0) {
        return envKey;
    }
    // 3. Shared-config profile (`~/.gisl/credentials`). Skipped silently
    //    when running in a non-Node runtime (browser, edge) — the resolver
    //    returns `null` and the caller decides whether that's fatal.
    if (!isNodeRuntime()) {
        return null;
    }
    const profileName = opts.profile ?? 'default';
    const profilePath = opts.profilePath ?? defaultProfilePath();
    if (profilePath === null) {
        return null;
    }
    const profileEntries = await readProfile(profilePath, profileName);
    if (profileEntries === null) {
        return null;
    }
    const profileKey = profileEntries.api_key;
    if (typeof profileKey === 'string' && profileKey.length > 0) {
        return profileKey;
    }
    return null;
}
/**
 * Resolve the base URL. Explicit `baseUrl` wins; otherwise an explicit
 * `environment` name; otherwise the `GISL_BASE_URL` / `GISL_ENVIRONMENT`
 * env vars; otherwise the prod default. Never throws — the chain always
 * resolves to a usable URL.
 */
export function resolveEndpoint(opts = {}) {
    if (typeof opts.baseUrl === 'string' && opts.baseUrl.length > 0) {
        return opts.baseUrl;
    }
    if (typeof opts.environment === 'string') {
        const explicitEnv = ENVIRONMENT_ENDPOINTS[opts.environment];
        if (explicitEnv !== undefined) {
            return explicitEnv;
        }
        // Codex r2 medium 23a17c1dbf75 — fail-closed on an unknown explicit
        // environment name. A typo or JS-side caller previously silently fell
        // through to env-var / prod default, which can mis-route a staging-
        // intended request to production. The env-var path still allows
        // unknown values to fall through (low-impact since it's an env config,
        // not a code-level arg).
        throw new GislConfigError(`Unknown environment '${opts.environment}'. Valid values: ${Object.keys(ENVIRONMENT_ENDPOINTS).join(', ')}.`);
    }
    const envBaseUrl = readEnv(GISL_BASE_URL_ENV);
    if (envBaseUrl !== null && envBaseUrl.length > 0) {
        return envBaseUrl;
    }
    const envEnvironment = readEnv(GISL_ENVIRONMENT_ENV);
    if (envEnvironment !== null) {
        const envMapped = ENVIRONMENT_ENDPOINTS[envEnvironment];
        if (envMapped !== undefined) {
            return envMapped;
        }
    }
    return DEFAULT_ENDPOINT;
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function isNodeRuntime() {
    return (typeof process !== 'undefined' &&
        process.versions !== undefined &&
        typeof process.versions.node === 'string');
}
function readEnv(name) {
    if (!isNodeRuntime()) {
        return null;
    }
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function defaultProfilePath() {
    const homeDir = readEnv('HOME') ?? readEnv('USERPROFILE');
    if (homeDir === null) {
        return null;
    }
    // Use forward-slash join — Node accepts it on every platform.
    return `${homeDir}/.gisl/credentials`;
}
/**
 * Read a single profile section from an INI-format credentials file.
 * Returns `null` when the file does not exist; throws `GislConfigError`
 * when the file exists but is malformed or the requested profile is
 * absent. Never includes credential VALUES in error messages.
 */
async function readProfile(path, profileName) {
    let raw;
    try {
        // Lazy import keeps `node:fs` out of browser bundles. webpackIgnore stops
        // webpack bundling it for browser targets; Vite externalises node: builtins
        // itself (no @vite-ignore — that would also bypass test mocks of node:fs).
        const fs = await import(/* webpackIgnore: true */ 'node:fs/promises');
        raw = await fs.readFile(path, 'utf8');
    }
    catch (err) {
        // ENOENT → no file = no credentials from this source (not an error).
        const code = err.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return null;
        }
        throw new GislConfigError(`Failed to read shared credentials file at ${path}: ${code ?? 'unknown error'}`);
    }
    const parsed = parseIni(raw, path);
    const entries = parsed[profileName];
    if (entries === undefined) {
        throw new GislConfigError(`Profile '${profileName}' not found in shared credentials file at ${path}`);
    }
    return entries;
}
/**
 * Minimal INI parser sufficient for AWS-style credentials files: section
 * headers `[name]`, `key = value` lines, `#` and `;` comments. Whitespace
 * around `=` is trimmed. No nested sections, no interpolation, no quoting.
 * Throws `GislConfigError` on malformed lines, naming only the LINE NUMBER
 * and PROFILE — never the value.
 */
function parseIni(raw, sourcePath) {
    const sections = {};
    let currentSection = null;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line === '' || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }
        if (line.startsWith('[') && line.endsWith(']')) {
            currentSection = line.slice(1, -1).trim();
            if (currentSection === '') {
                throw new GislConfigError(`Empty section header at line ${i + 1} in ${sourcePath}`);
            }
            if (sections[currentSection] === undefined) {
                sections[currentSection] = {};
            }
            continue;
        }
        if (currentSection === null) {
            throw new GislConfigError(`Key-value line at line ${i + 1} in ${sourcePath} is outside any section header`);
        }
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
            throw new GislConfigError(`Malformed line ${i + 1} in ${sourcePath} (expected key=value)`);
        }
        const key = line.slice(0, eqIndex).trim();
        if (key === '') {
            throw new GislConfigError(`Empty key at line ${i + 1} in ${sourcePath}`);
        }
        const value = line.slice(eqIndex + 1).trim();
        sections[currentSection][key] = value;
    }
    return sections;
}
