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
import { GislConfigError, GislFeatureRequiresAuthError, GislMissingCredentialsError, } from './errors.js';
import { resolveApiKey, resolveEndpoint, } from './credentials.js';
import { OperationBuilder } from './builder.js';
import { MergeBuilder, asset } from './merge.js';
import { PresetDefaults } from './ergonomic/presets/index.js';
import { Recipe, FilesRecipe, fileInput } from './file-first.js';
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
export const ANONYMOUS_ALLOWLIST = [];
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
export async function create(opts = {}) {
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
function wrapErgonomic(client, presetDefaults, scopedPresetDefaults) {
    return new Proxy(client, {
        get(target, prop, receiver) {
            if (prop === 'file') {
                // File-first entry point — the subject of the file-first surface.
                // A bare string is a filesystem path, a Blob/File an in-memory input;
                // pass a `FileInput` (e.g. `fileInput.uploadId(...)`) to reuse a
                // pre-uploaded file. `key` is RESULT-addressing only. The Proxy's
                // closure forwards the same preset-defaults references the op builders
                // get, so a file-first `compress()` resolves presets identically.
                return (input, key) => {
                    const resolved = typeof input === 'string'
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
                return (inputs) => {
                    if (inputs.length === 0) {
                        // A zero-input fan-out is a caller error — "one failing input
                        // doesn't sink the rest" is meaningless with no inputs, and it
                        // would otherwise create an empty-jobs workflow the API 422s.
                        throw new GislConfigError('files() requires at least one input file.', {
                            reason: 'no_inputs',
                        });
                    }
                    const resolved = inputs.map((input) => typeof input === 'string'
                        ? fileInput.path(input)
                        : input instanceof Blob
                            ? fileInput.blob(input)
                            : input);
                    return new FilesRecipe(resolved, [], presetDefaults, scopedPresetDefaults, target);
                };
            }
            if (prop === 'workflow') {
                // Reattach to a previously-created workflow (FF5a). Returns a
                // client-bound Handle with no webhookSecret and no recipe key —
                // its RunResult is therefore keyless (succeeded[].key === null).
                return (id) => new Handle(id, undefined, target);
            }
            if (prop === 'compress' || prop === 'convert' || prop === 'thumbnail') {
                return (input, options = {}) => {
                    // T4b — pass client-scope presetDefaults into the builder so
                    // .run()/.submit() consult the preset resolver. The Proxy's
                    // closure carries the same reference for every per-call
                    // builder construction.
                    // T4c — also forward the scopedPresetDefaults closure (from
                    // `withPresetDefaults`); `undefined` on root clients.
                    return new OperationBuilder(target, prop, input, options, presetDefaults, scopedPresetDefaults);
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
                return (defaults) => {
                    const mergedScoped = scopedPresetDefaults === undefined
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
                return (...args) => {
                    let mergeOpts = {};
                    let last = args.length > 0 ? args[args.length - 1] : undefined;
                    if (isMergeOptions(last)) {
                        mergeOpts = last;
                        args = args.slice(0, -1);
                    }
                    const declared = args.map((a) => {
                        if (typeof a === 'string' || a instanceof Blob)
                            return asset(a);
                        // Asset (handle or path).
                        return a;
                    });
                    return new MergeBuilder(target, declared, mergeOpts);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}
/**
 * Sniff whether the final argument to `merge(...)` is a `MergeOptions`
 * object rather than an `Asset`. Heuristic: an `Asset` always has a
 * `type` field with `'handle'` or `'path'`; a `MergeOptions` does not.
 */
function isMergeOptions(value) {
    if (value === null || typeof value !== 'object')
        return false;
    if (typeof value.then === 'function')
        return false;
    if (value instanceof Blob)
        return false;
    const t = value.type;
    if (t === 'handle' || t === 'path' || t === 'clip')
        return false;
    return true;
}
/**
 * Inner factory shared by `create()` and `_internalAnonymous()` — extracted
 * so the anonymous branch can ENTIRELY skip the credential chain rather
 * than just suppressing its throw (codex r1 high e9e1c1182d56 — without
 * this, env-resolved keys would silently attach an Authorization header
 * to anonymous calls and defeat the parking guarantee).
 *
 * @internal
 */
async function _createInternal(opts) {
    const { apiKey: explicitKey, profile, profilePath, useSessionCookie, baseUrl, environment, allowAnonymous, 
    // T4a slot — stripped from transportConfig so it does not leak
    // into the low-level `GislClientConfig` spread. The T4b resolver
    // reads `opts.presetDefaults` directly via its own path.
    presetDefaults: _presetDefaults, ...transportConfig } = opts;
    void _presetDefaults;
    const resolvedBaseUrl = resolveEndpoint({ baseUrl, environment });
    // Anonymous mode entirely BYPASSES the credential chain. Any env / profile
    // key that happens to exist on the host MUST NOT leak into the request
    // (codex r1 high e9e1c1182d56). Cookie-mode also bypasses, since the
    // caller authenticates via session cookie later.
    if (allowAnonymous === true) {
        const config = {
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
    let resolvedKey;
    if (useSessionCookie === true && (explicitKey === undefined || explicitKey === '')) {
        resolvedKey = null;
    }
    else {
        resolvedKey = await resolveApiKey({
            apiKey: explicitKey,
            profile,
            profilePath,
            useSessionCookie,
        });
    }
    if (resolvedKey === null && useSessionCookie !== true) {
        throw new GislMissingCredentialsError('No API key found via explicit arg, GISL_API_KEY env, or ~/.gisl/credentials profile. ' +
            'Pass {apiKey} explicitly, set GISL_API_KEY, populate ~/.gisl/credentials, ' +
            'or pass {useSessionCookie: true} for browser session-cookie authentication.');
    }
    const config = {
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
function wrapAnonymous(client) {
    // Explicit Set<string> — `ANONYMOUS_ALLOWLIST` is currently typed as the
    // empty tuple `readonly []` (audit-gate parking-invariant in _audit.ts).
    // Without this, `new Set(ANONYMOUS_ALLOWLIST)` would infer `Set<never>`.
    const allowlist = new Set(ANONYMOUS_ALLOWLIST);
    return new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function' || typeof prop !== 'string') {
                return value;
            }
            // Allow base infrastructure methods that don't carry user operations.
            if (prop.startsWith('_') ||
                prop === 'login' ||
                prop === 'logout' ||
                prop === 'getSchema' ||
                prop === 'submitContact' ||
                prop === 'constructor') {
                return value.bind(target);
            }
            // Allowlist gate: throw if the op isn't approved for anonymous use.
            if (!allowlist.has(prop)) {
                return () => {
                    throw new GislFeatureRequiresAuthError(prop, `Operation '${prop}' is not available on an anonymous client. ` +
                        `Use gisl.create({apiKey}) for authenticated access, or wait for the operation to be added to the anonymous allowlist.`);
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
};
// `_internalAnonymous` is the implementation behind the future public
// `gisl.anonymous()` export. Kept underscore-prefixed so it does not
// reach the audit gate as a public symbol.
/** @internal */
export async function _internalAnonymous(opts = {}) {
    return _createInternal({ ...opts, allowAnonymous: true });
}
// Re-export error types for callers that want to `instanceof` them.
export { GislConfigError, GislMissingCredentialsError, GislFeatureRequiresAuthError };
