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
export const GISL_STREAM_BASE_URL_ENV = 'GISL_STREAM_BASE_URL';

/**
 * Named environments → base URLs. Kept colocated with the resolver so the
 * mapping table doesn't leak into `gisl.ts`.
 */
export const ENVIRONMENT_ENDPOINTS = {
  prod: 'https://api.giveitsmaller.com',
  staging: 'https://api.staging.giveitsmaller.com',
} as const;

export type Environment = keyof typeof ENVIRONMENT_ENDPOINTS;

export const DEFAULT_ENDPOINT = ENVIRONMENT_ENDPOINTS.prod;

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
 * ⚠️ **THERE IS NO `prod` ENTRY, AND ITS ABSENCE IS THE CONTRACT'S, NOT AN
 * OVERSIGHT HERE.** The contract's `servers` block for the stream operation
 * carries localhost and staging only; contracts deliberately did not invent a
 * production URL. Until it is declared, a production configuration has **no
 * stream host** and {@link resolveStreamEndpoint} returns `null` — see
 * `GislClient.streamEvents`, which fails closed rather than quietly reusing
 * `baseUrl`. Add `prod` here in the same change that vendors the contract
 * entry, never ahead of it.
 *
 * `localhost` is intentionally absent too: it is declared in the contract as a
 * development server, but there is no `localhost` *environment* name to key it
 * off. Local callers pass `{streamBaseUrl}` or set `GISL_STREAM_BASE_URL`.
 */
export const ENVIRONMENT_STREAM_ENDPOINTS: Partial<Record<Environment, string>> = {
  staging: 'https://stream.staging.giveitsmaller.com',
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve the API key via the credential chain. Returns the resolved key,
 * or `null` if no source produced one. The ergonomic-layer factory is
 * responsible for deciding whether `null` is an error (default: yes, throw
 * `GislMissingCredentialsError`) or acceptable (anonymous / cookie-mode).
 */
export async function resolveApiKey(
  opts: ResolveCredentialsOptions = {},
): Promise<string | null> {
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
export function resolveEndpoint(opts: ResolveEndpointOptions = {}): string {
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
    throw new GislConfigError(
      `Unknown environment '${opts.environment}'. Valid values: ${Object.keys(ENVIRONMENT_ENDPOINTS).join(', ')}.`,
    );
  }

  const envBaseUrl = readEnv(GISL_BASE_URL_ENV);
  if (envBaseUrl !== null && envBaseUrl.length > 0) {
    return envBaseUrl;
  }

  const envEnvironment = readEnv(GISL_ENVIRONMENT_ENV);
  if (envEnvironment !== null) {
    const envMapped = ENVIRONMENT_ENDPOINTS[envEnvironment as Environment];
    if (envMapped !== undefined) {
      return envMapped;
    }
  }

  return DEFAULT_ENDPOINT;
}

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
export function resolveStreamEndpoint(opts: ResolveEndpointOptions = {}): string | null {
  // TRIM BEFORE THE PRESENCE CHECK. A whitespace-only value is unset (the
  // client normaliser treats it that way too), and if it were allowed to
  // count as "supplied" here it would SUPPRESS the environment's declared
  // host and then normalise to nothing — silently disabling a stream that
  // was perfectly well declared. codex a7f5ec9f0d32.
  const explicit = opts.streamBaseUrl?.trim() ?? '';
  if (explicit !== '') {
    return explicit;
  }

  if (typeof opts.environment === 'string') {
    if (!(opts.environment in ENVIRONMENT_ENDPOINTS)) {
      throw new GislConfigError(
        `Unknown environment '${opts.environment}'. Valid values: ${Object.keys(ENVIRONMENT_ENDPOINTS).join(', ')}.`,
      );
    }
    // A KNOWN environment with no declared stream host resolves to `null`, not
    // to an error and not to `baseUrl`. That is today's `prod`: the config is
    // valid, the declaration is simply missing upstream.
    return ENVIRONMENT_STREAM_ENDPOINTS[opts.environment] ?? null;
  }

  const envStreamBaseUrl = readEnv(GISL_STREAM_BASE_URL_ENV);
  if (envStreamBaseUrl !== null && envStreamBaseUrl.length > 0) {
    return envStreamBaseUrl;
  }

  const envEnvironment = readEnv(GISL_ENVIRONMENT_ENV);
  if (envEnvironment !== null) {
    const envMapped = ENVIRONMENT_STREAM_ENDPOINTS[envEnvironment as Environment];
    if (envMapped !== undefined) {
      return envMapped;
    }
  }

  return null;
}

/**
 * Human-readable list of the environments that currently declare a stream
 * host. Used in the fail-closed error message so the caller is told what IS
 * available rather than only what is missing.
 */
export function declaredStreamEnvironments(): readonly string[] {
  return Object.keys(ENVIRONMENT_STREAM_ENDPOINTS);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions !== undefined &&
    typeof process.versions.node === 'string'
  );
}

function readEnv(name: string): string | null {
  if (!isNodeRuntime()) {
    return null;
  }
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function defaultProfilePath(): string | null {
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
async function readProfile(
  path: string,
  profileName: string,
): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    // Lazy import keeps `node:fs` out of browser bundles. webpackIgnore stops
    // webpack bundling it for browser targets; Vite externalises node: builtins
    // itself (no @vite-ignore — that would also bypass test mocks of node:fs).
    const fs = await import(/* webpackIgnore: true */ 'node:fs/promises');
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    // ENOENT → no file = no credentials from this source (not an error).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw new GislConfigError(
      `Failed to read shared credentials file at ${path}: ${code ?? 'unknown error'}`,
    );
  }

  const parsed = parseIni(raw, path);
  const entries = parsed[profileName];
  if (entries === undefined) {
    throw new GislConfigError(
      `Profile '${profileName}' not found in shared credentials file at ${path}`,
    );
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
function parseIni(raw: string, sourcePath: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let currentSection: string | null = null;
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      if (currentSection === '') {
        throw new GislConfigError(
          `Empty section header at line ${i + 1} in ${sourcePath}`,
        );
      }
      if (sections[currentSection] === undefined) {
        sections[currentSection] = {};
      }
      continue;
    }
    if (currentSection === null) {
      throw new GislConfigError(
        `Key-value line at line ${i + 1} in ${sourcePath} is outside any section header`,
      );
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      throw new GislConfigError(
        `Malformed line ${i + 1} in ${sourcePath} (expected key=value)`,
      );
    }
    const key = line.slice(0, eqIndex).trim();
    if (key === '') {
      throw new GislConfigError(
        `Empty key at line ${i + 1} in ${sourcePath}`,
      );
    }
    const value = line.slice(eqIndex + 1).trim();
    sections[currentSection][key] = value;
  }

  return sections;
}
