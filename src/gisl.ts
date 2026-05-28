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
import type { GislClientConfig } from './types.js';
import { OperationBuilder } from './builder.js';
import { MergeBuilder, asset, type Asset, type MergeOptions } from './merge.js';
import type { PresetDefaults } from './ergonomic/presets/index.js';

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
  return wrapErgonomic(await _createInternal(opts));
}

/**
 * Compose the ergonomic operation surface (`.compress` / `.convert` /
 * `.thumbnail`) on top of a `GislClient` via Proxy — matches the
 * `wrapAnonymous` precedent (no prototype mutation). Layer order is
 * builder-wrap INSIDE, anonymous-wrap OUTSIDE so the allowlist gate
 * runs last in `_internalAnonymous` (see `_createInternal`).
 */
function wrapErgonomic(client: GislClient): ErgonomicClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'compress' || prop === 'convert' || prop === 'thumbnail') {
        return (input: string | Blob, options: Record<string, unknown> = {}): OperationBuilder => {
          return new OperationBuilder(target, prop, input, options);
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
 * The ergonomic-client surface: `GislClient` (verbatim low-level API)
 * plus three ergonomic op-builder factories. Intersection type — at
 * runtime the Proxy synthesises the three methods on-demand. `input`
 * accepts `string | Blob` matching `GislClient.uploadFile` (codex r1
 * low 89cae59f4f04 — Blob/File uploads were previously rejected by the
 * ergonomic factory's narrower string-only typing).
 */
export type ErgonomicClient = GislClient & {
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
