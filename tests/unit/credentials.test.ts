import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_ENDPOINT,
  ENVIRONMENT_ENDPOINTS,
  ENVIRONMENT_STREAM_ENDPOINTS,
  GISL_API_KEY_ENV,
  GISL_BASE_URL_ENV,
  GISL_ENVIRONMENT_ENV,
  GISL_STREAM_BASE_URL_ENV,
  resolveApiKey,
  resolveEndpoint,
  resolveStreamEndpoint,
} from '../../src/credentials.js';
import { GislConfigError } from '../../src/errors.js';

// Save + restore env vars that the resolvers read so a flaky CI environment
// can't pollute a test.
const TRACKED_ENV = [
  GISL_API_KEY_ENV,
  GISL_BASE_URL_ENV,
  GISL_ENVIRONMENT_ENV,
  GISL_STREAM_BASE_URL_ENV,
  'HOME',
  'USERPROFILE',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of TRACKED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TRACKED_ENV) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  it('returns explicit apiKey when supplied — highest precedence', async () => {
    process.env[GISL_API_KEY_ENV] = 'env_key';
    const resolved = await resolveApiKey({ apiKey: 'explicit_key' });
    expect(resolved).toBe('explicit_key');
  });

  it('falls back to GISL_API_KEY env when no explicit key', async () => {
    process.env[GISL_API_KEY_ENV] = 'env_key';
    const resolved = await resolveApiKey();
    expect(resolved).toBe('env_key');
  });

  it('reads from shared credentials file when env + explicit are absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(
        path,
        '[default]\napi_key = file_key\n[work]\napi_key = work_key\n',
      );
      const resolved = await resolveApiKey({ profilePath: path });
      expect(resolved).toBe('file_key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours the {profile} arg when reading the credentials file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(
        path,
        '[default]\napi_key = file_key\n[work]\napi_key = work_key\n',
      );
      const resolved = await resolveApiKey({ profilePath: path, profile: 'work' });
      expect(resolved).toBe('work_key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no source produces a key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      // No env vars set (beforeEach cleared them); a missing file path means
      // the profile branch returns null (ENOENT).
      const resolved = await resolveApiKey({ profilePath: join(dir, 'missing') });
      expect(resolved).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null without throwing when {useSessionCookie: true} and no key found', async () => {
    // Cookie-mode callers legitimately have no apiKey at construction time.
    // Plan §9 / lowering.md cookie-mode exemption.
    const resolved = await resolveApiKey({ useSessionCookie: true });
    expect(resolved).toBeNull();
  });

  it('throws GislConfigError when the profile name is absent from the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(path, '[default]\napi_key = file_key\n');
      await expect(
        resolveApiKey({ profilePath: path, profile: 'nonexistent' }),
      ).rejects.toBeInstanceOf(GislConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws GislConfigError on a malformed INI file (no section header)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(path, 'api_key = orphan_value\n');
      await expect(
        resolveApiKey({ profilePath: path }),
      ).rejects.toBeInstanceOf(GislConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws GislConfigError on a malformed INI file (missing equals)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(path, '[default]\napi_key value_without_equals\n');
      await expect(
        resolveApiKey({ profilePath: path }),
      ).rejects.toBeInstanceOf(GislConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER leaks credential values in malformed-INI error messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(path, 'sk_supersecret_should_never_appear_in_error\n');
      let thrown: unknown;
      try {
        await resolveApiKey({ profilePath: path });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GislConfigError);
      expect((thrown as Error).message).not.toContain('sk_supersecret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores blank lines and # / ; comments in the INI file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gisl-credentials-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(
        path,
        '# top comment\n; another comment\n\n[default]\n# section comment\napi_key = comment_safe_key\n',
      );
      const resolved = await resolveApiKey({ profilePath: path });
      expect(resolved).toBe('comment_safe_key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses ~/.gisl/credentials by default when HOME is set and no profilePath', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'gisl-home-'));
    try {
      const gislDir = join(homeDir, '.gisl');
      mkdirSync(gislDir, { recursive: true });
      writeFileSync(join(gislDir, 'credentials'), '[default]\napi_key = home_key\n');
      process.env.HOME = homeDir;
      const resolved = await resolveApiKey();
      expect(resolved).toBe('home_key');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('falls back to USERPROFILE on Windows-style envs when HOME is unset', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'gisl-userprofile-'));
    try {
      const gislDir = join(homeDir, '.gisl');
      mkdirSync(gislDir, { recursive: true });
      writeFileSync(join(gislDir, 'credentials'), '[default]\napi_key = winprofile_key\n');
      // beforeEach already cleared HOME; set only USERPROFILE.
      process.env.USERPROFILE = homeDir;
      const resolved = await resolveApiKey();
      expect(resolved).toBe('winprofile_key');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('GISL_API_KEY env takes precedence over the profile file when BOTH are present', async () => {
    // Regression guard: env-wins precedence is in the chain order, but no
    // test had previously exercised both sources simultaneously. Without
    // this test, a refactor that swapped the chain order (file before env)
    // would pass all the single-source tests.
    const dir = mkdtempSync(join(tmpdir(), 'gisl-precedence-'));
    try {
      const path = join(dir, 'credentials');
      writeFileSync(path, '[default]\napi_key = file_key\n');
      process.env[GISL_API_KEY_ENV] = 'env_key';
      const resolved = await resolveApiKey({ profilePath: path });
      expect(resolved).toBe('env_key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats empty-string apiKey as absent (falls through to env)', async () => {
    process.env[GISL_API_KEY_ENV] = 'env_key';
    const resolved = await resolveApiKey({ apiKey: '' });
    expect(resolved).toBe('env_key');
  });
});

// ---------------------------------------------------------------------------

describe('resolveEndpoint', () => {
  it('returns explicit baseUrl when supplied — highest precedence', () => {
    process.env[GISL_BASE_URL_ENV] = 'https://env.example.com';
    const resolved = resolveEndpoint({ baseUrl: 'https://explicit.example.com' });
    expect(resolved).toBe('https://explicit.example.com');
  });

  it('maps explicit {environment: "staging"} to the staging endpoint', () => {
    const resolved = resolveEndpoint({ environment: 'staging' });
    expect(resolved).toBe(ENVIRONMENT_ENDPOINTS.staging);
  });

  it('maps explicit {environment: "prod"} to the prod endpoint', () => {
    const resolved = resolveEndpoint({ environment: 'prod' });
    expect(resolved).toBe(ENVIRONMENT_ENDPOINTS.prod);
  });

  it('falls back to GISL_BASE_URL env when no explicit override', () => {
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    const resolved = resolveEndpoint();
    expect(resolved).toBe('https://env-base.example.com');
  });

  it('falls back to GISL_ENVIRONMENT env when no explicit override or base URL', () => {
    process.env[GISL_ENVIRONMENT_ENV] = 'staging';
    const resolved = resolveEndpoint();
    expect(resolved).toBe(ENVIRONMENT_ENDPOINTS.staging);
  });

  it('falls back to prod default when nothing is configured', () => {
    const resolved = resolveEndpoint();
    expect(resolved).toBe(DEFAULT_ENDPOINT);
  });

  it('throws GislConfigError on an unknown EXPLICIT environment value (fail-closed)', () => {
    // Codex r2 medium 23a17c1dbf75 — a typo on an explicit arg silently
    // routing to prod is a real footgun. Explicit unknown = throw.
    expect(() => resolveEndpoint({ environment: 'fictional' as unknown as 'prod' })).toThrow(GislConfigError);
  });

  it('ignores unknown environment NAMES from env vars (low-impact env-config fallthrough)', () => {
    // Env-var path is a less-typed surface; falling through to prod
    // default is the conservative choice (matches resolveApiKey's behaviour
    // on empty-env). Explicit arg is fail-closed; env arg is fall-through.
    process.env[GISL_ENVIRONMENT_ENV] = 'fictional';
    const resolved = resolveEndpoint();
    expect(resolved).toBe(DEFAULT_ENDPOINT);
  });

  it('REJECTS an empty-string baseUrl instead of falling through (OxqseYwd)', () => {
    // 🔴 THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-09-16, DELIBERATELY, AND THE
    // BEHAVIOUR IT PINNED WAS STILL WRONG. Its old name — "ignores empty-string
    // baseUrl (falls through chain)" — describes a MECHANISM, not a guarantee
    // anyone asked for, and neither compression_e2e nor I could construct the
    // caller who benefits: a caller with genuinely no base URL passes
    // `undefined`, which is unchanged.
    //
    // An empty string arrives from `process.env.X`, an unset CI variable, or a
    // `.env` line with nothing after the `=`. Falling through sent CREDENTIALED
    // traffic to the production host from a value the operator believed they had
    // set. A test proving a behaviour was INTENDED is not evidence it was RIGHT.
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    expect(() => resolveEndpoint({ baseUrl: '' })).toThrow(GislConfigError);
    expect(() => resolveEndpoint({ baseUrl: '   ' })).toThrow(GislConfigError);
  });

  it('still falls through the chain when baseUrl is ABSENT', () => {
    // The case the fallback was written for, pinned separately so the change
    // above cannot quietly widen into it.
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    expect(resolveEndpoint({})).toBe('https://env-base.example.com');
    expect(resolveEndpoint({ baseUrl: undefined })).toBe('https://env-base.example.com');
  });

  it('REJECTS a blank baseUrl in the STREAM resolver too (OxqseYwd)', () => {
    // The two resolvers disagreeing about what "unconfigured" means is how the
    // defect was born, so they move together.
    expect(() => resolveStreamEndpoint({ baseUrl: '' })).toThrow(GislConfigError);
    expect(resolveStreamEndpoint({ baseUrl: undefined, environment: 'staging' })).toBe(
      ENVIRONMENT_STREAM_ENDPOINTS.staging,
    );
  });

  it('GISL_BASE_URL takes precedence over GISL_ENVIRONMENT in env-only resolution', () => {
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    process.env[GISL_ENVIRONMENT_ENV] = 'staging';
    const resolved = resolveEndpoint();
    expect(resolved).toBe('https://env-base.example.com');
  });
});

/**
 * A WHITESPACE-ONLY ENV VAR IS UNSET (compression_e2e, 2026-09-15).
 *
 * `resolveStreamEndpoint` already trimmed the `streamBaseUrl` OPTION before its
 * presence check; the env path did not. So the two sides answered "is this set?"
 * differently, and a blank env var was returned verbatim as a host.
 *
 * ⚠️ The consumer-visible shape is worse than the internal one: a whitespace
 * string is TRUTHY in JavaScript, so a caller's `if (url)` guard passes, they
 * pass it to us, and the failure surfaces somewhere else entirely. e2e hit
 * exactly that wiring `streamBaseUrl` from an env var.
 */
describe('blank env vars are unset, not values', () => {
  it('THROWS on a whitespace-only GISL_STREAM_BASE_URL (superseded by OxqseYwd)', () => {
    // 🔴 THIS ASSERTED A FALL-THROUGH UNTIL 2026-09-16. #397 made a blank env var
    // mean "unset", which fixed a real asymmetry — a URL made of spaces was being
    // returned verbatim as a host — but "blank means unset" is the wrong general
    // rule for a HOST: it sends the caller to a DEFAULT they did not choose,
    // which for `GISL_BASE_URL` is production, with credentials attached.
    //
    // ⇒ Set-but-blank is now an error for the two URL variables. The value of the
    // #397 change survives (a space is never treated as a host); what changed is
    // where the caller ends up.
    process.env[GISL_STREAM_BASE_URL_ENV] = '   ';
    process.env[GISL_ENVIRONMENT_ENV] = 'staging';
    expect(() => resolveStreamEndpoint()).toThrow(GislConfigError);
  });

  it('still honours a real GISL_STREAM_BASE_URL (the value is not trimmed away)', () => {
    // The other direction, and it is the one that would make this fix a
    // regression: presence is decided on the trimmed value, the VALUE itself is
    // returned untouched. Silently altering a host the caller named is how you
    // connect somewhere they did not ask for.
    process.env[GISL_STREAM_BASE_URL_ENV] = 'https://stream.self-hosted.example';
    expect(resolveStreamEndpoint()).toBe('https://stream.self-hosted.example');
  });

  it('THROWS on a blank GISL_BASE_URL rather than deciding what it meant', () => {
    // Superseded by OxqseYwd for the same reason as the case above: the old
    // behaviour picked an outcome (the prod stream host) from a value the
    // operator believed they had set. Refusing is the only reading that cannot
    // be wrong.
    process.env[GISL_BASE_URL_ENV] = '  ';
    expect(() => resolveStreamEndpoint()).toThrow(GislConfigError);
  });

  it('treats a whitespace-only GISL_API_KEY as no key at all', async () => {
    // Same rule, different resolver — stated because "blank means unset" is now
    // a property of `readEnv` rather than of one call site, and a property with
    // one test is a coincidence.
    //
    // ⚠️ THE FIRST VERSION OF THIS TEST COULD NOT HAVE PASSED FOR THE RIGHT
    // REASON: it wrapped an ASYNC call in `expect(() => …).toThrow()`, which
    // never sees a rejection. It went red, so it was caught — but a test shaped
    // like that against a resolver that DOES throw synchronously would have gone
    // green while asserting nothing.
    //
    // `resolveApiKey` returns `Promise<string | null>` and does not throw here:
    // HOME and USERPROFILE are cleared by `beforeEach`, so the profile-file step
    // finds nothing and the chain ends at `null`. `null` is the assertion —
    // before the fix this resolved to '\t ', a key made of whitespace that the
    // API would have rejected with a 401 nobody could explain.
    process.env[GISL_API_KEY_ENV] = '\t ';
    await expect(resolveApiKey()).resolves.toBeNull();
  });
});

/**
 * OxqseYwd, round 2 — the env path the option guard's own message names.
 *
 * 🔴 The first version of this fix covered `{ baseUrl: '' }` and told operators
 * it "usually means GISL_BASE_URL is set to an empty string" — the path it did
 * NOT cover. `readEnv` returned null for a blank variable, so `create({apiKey})`
 * under `GISL_BASE_URL=''` still resolved to production with credentials
 * attached (second-identity, PR #404).
 */
describe('a URL environment variable that is set but blank', () => {
  it('is an error, not an absent value', () => {
    process.env[GISL_BASE_URL_ENV] = '';
    expect(() => resolveEndpoint({})).toThrow(GislConfigError);
    process.env[GISL_BASE_URL_ENV] = '   ';
    expect(() => resolveEndpoint({})).toThrow(GislConfigError);
  });

  it('applies to the stream host variable too', () => {
    process.env[GISL_STREAM_BASE_URL_ENV] = '  ';
    expect(() => resolveStreamEndpoint({})).toThrow(GislConfigError);
  });

  it('leaves a genuinely unset variable alone', () => {
    // The direction that keeps this a fix rather than a regression: absence is
    // still absence, and still reaches the documented default.
    delete process.env[GISL_BASE_URL_ENV];
    expect(resolveEndpoint({})).toBe(DEFAULT_ENDPOINT);
  });

  it('names the VARIABLE in the message, not the parameter', () => {
    // compression_e2e, as a consumer: the parameter is what the SDK sees, the
    // variable is what an operator can act on.
    process.env[GISL_BASE_URL_ENV] = '';
    expect(() => resolveEndpoint({})).toThrow(/GISL_BASE_URL/);
  });
});
