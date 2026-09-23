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
export const ENVIRONMENT_ENDPOINTS = Object.freeze({
  prod: 'https://api.giveitsmaller.com',
  staging: 'https://api.staging.giveitsmaller.com',
} as const);

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
export const ENVIRONMENT_STREAM_ENDPOINTS: Readonly<Partial<Record<Environment, string>>> =
  Object.freeze({
    prod: 'https://stream.giveitsmaller.com',
    staging: 'https://stream.staging.giveitsmaller.com',
  });

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
 * A `baseUrl` that is PRESENT but blank is a configuration ERROR, not an absent
 * value — and both resolvers must agree about that or they disagree about what
 * "unconfigured" means.
 *
 * 🔴 WHAT IT USED TO DO, MEASURED ON 0.26.0 BY `compression_e2e`:
 *
 *     resolveStreamEndpoint({ baseUrl: '' })  -> 'https://stream.giveitsmaller.com'
 *     resolveEndpoint({ baseUrl: '' })        -> 'https://api.giveitsmaller.com'
 *
 * An empty string was read as "the caller configured nothing" and therefore as
 * consent to the PRODUCTION default — while the caller is passing an `apiKey` at
 * the same time. So a blank value sent credentialed traffic to production,
 * through a path with no `GISL_*` variable in it, which means a consumer's guard
 * around the ambient variables cannot see it.
 *
 * ⚠️ `baseUrl: ''` is not an absent value. It is a present, wrong one, and it
 * almost always arrives from `process.env.X`, an unset CI variable, or a `.env`
 * line with nothing after the `=`.
 *
 * ⭐ `undefined` IS UNCHANGED. That is the case the production fallback was
 * written for, and narrowing this to the blank-string case keeps the change
 * obviously safe. `card OxqseYwd`.
 */
function assertBaseUrlNotBlank(baseUrl: unknown): void {
  if (typeof baseUrl === 'string' && baseUrl.trim() === '') {
    throw new GislConfigError(
      'baseUrl was supplied but is blank. That is a configuration error, not an ' +
        'absent value: it usually means GISL_BASE_URL (or whatever your wrapper ' +
        'reads it from) is set to an empty string.',
      {
        // 🔑 Its own code. `type_mismatch` said "you passed the wrong type",
        // which a consumer discriminating on `reason` cannot tell from a genuine
        // one — and the remediation is different: this value is the right type
        // and empty.
        reason: 'blank_value',
        conflictingFields: ['baseUrl'],
        suggestion:
          "Pass a real host such as 'https://api.staging.giveitsmaller.com', or an " +
          "`environment` ('staging' / 'prod'). ⚠️ Omitting it entirely falls back to " +
          'PRODUCTION when no GISL_* variable is set, which is rarely what an empty ' +
          'value was meant to express.',
      },
    );
  }
}

/**
 * Resolve the base URL. Explicit `baseUrl` wins; otherwise an explicit
 * `environment` name; otherwise the `GISL_BASE_URL` / `GISL_ENVIRONMENT`
 * env vars; otherwise the prod default. ⚠️ THROWS on a blank-but-present
 * `baseUrl` and on an unknown explicit environment; otherwise the chain always
 * resolves to a usable URL.
 */
export function resolveEndpoint(opts: ResolveEndpointOptions = {}): string {
  assertBaseUrlNotBlank(opts.baseUrl);
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

  const envBaseUrl = readUrlEnv(GISL_BASE_URL_ENV);
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
  // The same rule as `resolveEndpoint`, deliberately: the two disagreeing about
  // what "unconfigured" means is how the defect was born.
  assertBaseUrlNotBlank(opts.baseUrl);
  // TRIM BEFORE THE PRESENCE CHECK. A whitespace-only value is unset (the
  // client normaliser treats it that way too), and if it were allowed to
  // count as "supplied" here it would SUPPRESS the environment's declared
  // host and then normalise to nothing — silently disabling a stream that
  // was perfectly well declared. codex a7f5ec9f0d32.
  const explicit = opts.streamBaseUrl?.trim() ?? '';
  if (explicit !== '') {
    return explicit;
  }
  // vzVIw4ZZ: a PRESENT-but-blank option is remembered. It must not suppress a
  // host something else declares (the trim above keeps that working), but if
  // NOTHING else declares one it is a configuration error - not consent to the
  // production default, which is what it silently became.
  const streamOptionWasBlank = typeof opts.streamBaseUrl === 'string';

  if (typeof opts.environment === 'string') {
    if (!(opts.environment in ENVIRONMENT_ENDPOINTS)) {
      throw new GislConfigError(
        `Unknown environment '${opts.environment}'. Valid values: ${Object.keys(ENVIRONMENT_ENDPOINTS).join(', ')}.`,
      );
    }
    // A KNOWN environment with no declared stream host resolves to `null`, not
    // to an error and not to `baseUrl`: the config is valid, the declaration is
    // simply missing upstream. Both current environments declare one.
    return ENVIRONMENT_STREAM_ENDPOINTS[opts.environment] ?? null;
  }

  const envStreamBaseUrl = readUrlEnv(GISL_STREAM_BASE_URL_ENV);
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

  // SYMMETRY WITH `resolveEndpoint`, and a correctness fix rather than a
  // convenience (codex 480e8b865b90). `resolveEndpoint` FALLS THROUGH to the
  // production API host when nothing is configured — so an unconfigured
  // `gisl.create({apiKey})` already talks to production, while its stream
  // resolved to `null`. That made THE DEFAULT CONFIGURATION the one that could
  // not stream: `streamEvents()` threw and `run()` silently polled, against a
  // production host whose stream IS declared. The two resolvers have to agree
  // about what "unconfigured" means.
  //
  // ⚠️ ONLY when the API host ALSO defaulted. An explicit `baseUrl` (or
  // `GISL_BASE_URL`) names a host we were told about and cannot reason about —
  // a proxy, a self-host, a test double — so we still refuse rather than assume
  // production's stream host. Assuming there would be deriving one host from
  // another, which is precisely what this mechanism exists to refuse.
  const apiHostWasConfigured =
    (typeof opts.baseUrl === 'string' && opts.baseUrl.trim() !== '') ||
    readUrlEnv(GISL_BASE_URL_ENV) !== null;
  if (streamOptionWasBlank) {
    throwBlankStreamBaseUrl();
  }
  if (!apiHostWasConfigured) {
    return ENVIRONMENT_STREAM_ENDPOINTS.prod ?? null;
  }

  return null;
}

function throwBlankStreamBaseUrl(): never {
  throw new GislConfigError(
    'streamBaseUrl was supplied but is blank, and nothing else declares a stream host. ' +
      'That is a configuration error, not an absent value: it would otherwise have ' +
      'resolved to the PRODUCTION stream host.',
    {
      reason: 'blank_value',
      conflictingFields: ['streamBaseUrl'],
      suggestion:
        "Pass a real host such as 'https://stream.staging.giveitsmaller.com', or an " +
        "`environment` ('staging' / 'prod'), or omit streamBaseUrl entirely.",
    },
  );
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

/**
 * A URL environment variable that is SET BUT BLANK is an operator error.
 *
 * 🔴 THE HOLE MY OWN ERROR MESSAGE NAMED. The option guard above told operators
 * that a blank `baseUrl` "usually means GISL_BASE_URL is set to an empty
 * string" — and that path was not covered: `readEnv` returned null for a blank
 * variable, so `create({ apiKey })` under `GISL_BASE_URL=''` still resolved to
 * the PRODUCTION host with credentials attached (second-identity, PR #404).
 *
 * ⚠️ THIS SUPERSEDES PART OF #397 for the two URL variables. That change made a
 * whitespace-only env var mean "unset", which was right for the asymmetry it
 * fixed and wrong as a general rule for a HOST: `GISL_BASE_URL=` in a `.env`
 * file is a mistake somebody should hear about, not a default they opted into.
 * Other variables keep the unset treatment.
 */
function readUrlEnv(name: string): string | null {
  const raw = isNodeRuntime() ? process.env[name] : undefined;
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new GislConfigError(
      `${name} is set but blank. That is a configuration error, not an absent value — ` +
        'a set-but-empty host would otherwise fall through to the PRODUCTION default ' +
        'while your credentials are attached.',
      {
        reason: 'blank_value',
        conflictingFields: [name],
        suggestion: `Unset ${name} entirely to use the environment default, or give it a real host.`,
      },
    );
  }
  return readEnv(name);
}

function readEnv(name: string): string | null {
  if (!isNodeRuntime()) {
    return null;
  }
  const value = process.env[name];
  // 🔴 A WHITESPACE-ONLY ENV VAR IS UNSET, and the presence check is what says
  // so — the value itself is returned UNTOUCHED.
  //
  // `resolveStreamEndpoint` already trims the `streamBaseUrl` OPTION before its
  // presence check (codex a7f5ec9f0d32) and this path did not, so the two
  // disagreed about the same question: `GISL_STREAM_BASE_URL='   '` was returned
  // verbatim as the stream host — a URL made of spaces — while the equivalent
  // option resolved to the environment's declared host. The same asymmetry let a
  // blank `GISL_BASE_URL` count as "the API host was configured" and suppress
  // the production stream fallback.
  //
  // ⚠️ Presence only. A non-blank value is NOT trimmed here: silently altering a
  // value the caller supplied is how you end up connecting somewhere they did
  // not name. Blank means unset; anything else means what it says.
  //
  // Reported by compression_e2e, 2026-09-15: a whitespace-only value is TRUTHY
  // in JavaScript, so a consumer's `if (url)` guard passes and the SDK then
  // fails downstream — the mismatch only exists because the two sides answer
  // "is this set?" differently.
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value;
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
