import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_ENDPOINT,
  ENVIRONMENT_ENDPOINTS,
  GISL_API_KEY_ENV,
  GISL_BASE_URL_ENV,
  GISL_ENVIRONMENT_ENV,
  resolveApiKey,
  resolveEndpoint,
} from '../../src/credentials.js';
import { GislConfigError } from '../../src/errors.js';

// Save + restore env vars that the resolvers read so a flaky CI environment
// can't pollute a test.
const TRACKED_ENV = [
  GISL_API_KEY_ENV,
  GISL_BASE_URL_ENV,
  GISL_ENVIRONMENT_ENV,
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

  it('ignores empty-string baseUrl (falls through chain)', () => {
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    const resolved = resolveEndpoint({ baseUrl: '' });
    expect(resolved).toBe('https://env-base.example.com');
  });

  it('GISL_BASE_URL takes precedence over GISL_ENVIRONMENT in env-only resolution', () => {
    process.env[GISL_BASE_URL_ENV] = 'https://env-base.example.com';
    process.env[GISL_ENVIRONMENT_ENV] = 'staging';
    const resolved = resolveEndpoint();
    expect(resolved).toBe('https://env-base.example.com');
  });
});
