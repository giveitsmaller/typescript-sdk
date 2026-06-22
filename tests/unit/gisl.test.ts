import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync as mkdirSyncT,
  mkdtempSync as mkdtempSyncT,
  rmSync as rmSyncT,
  writeFileSync as writeFileSyncT,
} from 'node:fs';
import { join as joinT } from 'node:path';
import { tmpdir as tmpdirT } from 'node:os';

import { gisl, create, _internalAnonymous } from '../../src/gisl.js';
import {
  GislConfigError,
  GislError,
  GislFeatureRequiresAuthError,
  GislMissingCredentialsError,
} from '../../src/errors.js';
import { ENVIRONMENT_ENDPOINTS } from '../../src/credentials.js';

// Save + restore the env vars the resolver reads so a flaky CI environment
// can't pollute a test.
const TRACKED_ENV = [
  'GISL_API_KEY',
  'GISL_BASE_URL',
  'GISL_ENVIRONMENT',
  'HOME',
  'USERPROFILE',
] as const;

let savedEnv: Record<string, string | undefined>;
// `vi.spyOn(globalThis, 'fetch')` has overload-resolution issues in this
// project's TS config; type-erase to MockInstance loosely.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  savedEnv = {};
  for (const name of TRACKED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  // Stub global fetch so we can assert "no fetch was made" for fail-early
  // tests without firing a real network request even if a code path
  // mistakenly tries.
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  for (const name of TRACKED_ENV) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('gisl.create', () => {
  it('exports a namespace whose `create` member matches the named export', () => {
    expect(gisl.create).toBe(create);
  });

  it('does NOT expose gisl.anonymous yet (parked pending allowlist user-pick)', () => {
    // The internal capability exists at `_internalAnonymous` (task 3); the
    // public `gisl.anonymous` named export should NOT be present in v0.7.
    expect((gisl as Record<string, unknown>).anonymous).toBeUndefined();
  });

  it('resolves apiKey from explicit arg (overriding env) — explicit wires through to GislClient', async () => {
    process.env.GISL_API_KEY = 'env_key';
    const client = await gisl.create({ apiKey: 'explicit_key' });
    // Read through the private apiKey-related field on GislClient: existing
    // requests attach Authorization from this. Without reading-through, a
    // regression that dropped the `config.apiKey = resolvedKey` line would
    // pass the construction tests but produce unauthenticated requests.
    const internal = client as unknown as { headers: Record<string, string> };
    expect(internal.headers?.Authorization).toBe('Bearer explicit_key');
  });

  it('resolves apiKey from GISL_API_KEY env when no explicit arg — env wires through', async () => {
    process.env.GISL_API_KEY = 'env_only_key';
    const client = await gisl.create();
    const internal = client as unknown as { headers: Record<string, string> };
    expect(internal.headers?.Authorization).toBe('Bearer env_only_key');
  });

  it('throws GislMissingCredentialsError synchronously when no key found and no cookie/anonymous flag', async () => {
    // No env vars (beforeEach cleared); no profile file in HOME (also cleared).
    await expect(gisl.create()).rejects.toBeInstanceOf(GislMissingCredentialsError);
    // Verify inheritance chain — instanceof for both intermediate + base.
    let thrown: unknown;
    try {
      await gisl.create();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislMissingCredentialsError);
    expect(thrown).toBeInstanceOf(GislConfigError);
    expect(thrown).toBeInstanceOf(GislError);
    expect(thrown).toBeInstanceOf(Error);
  });

  it('throws BEFORE any fetch / HTTP I/O when creds are missing', async () => {
    await expect(gisl.create()).rejects.toBeInstanceOf(GislMissingCredentialsError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('error message names HOW to fix the missing-creds problem (env / explicit / profile / cookie)', async () => {
    let thrown: unknown;
    try {
      await gisl.create();
    } catch (err) {
      thrown = err;
    }
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/GISL_API_KEY/);
    expect(msg).toMatch(/apiKey/);
    expect(msg).toMatch(/useSessionCookie/);
  });

  it('does NOT throw missing-creds when {useSessionCookie: true} (cookie-mode exemption)', async () => {
    // Browser SPA flow legitimately has no apiKey at construction time —
    // the caller authenticates via client.login() later.
    const client = await gisl.create({ useSessionCookie: true });
    expect(client).toBeDefined();
  });

  it('resolves baseUrl from explicit {environment: "staging"}', async () => {
    const client = await gisl.create({
      apiKey: 'k',
      environment: 'staging',
    });
    // GislClient stores config as private readonly fields — cast through unknown
    // to read for the assertion (test-only inspection of internal state).
    const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
    expect(baseUrl).toBe(ENVIRONMENT_ENDPOINTS.staging);
  });

  it('forwards extra transport config (e.g. timeout, multipartConcurrency) to GislClient', async () => {
    const client = await gisl.create({
      apiKey: 'k',
      timeout: 5_000,
      multipartConcurrency: 2,
    });
    const internal = client as unknown as {
      timeoutMs: number;
      multipartConcurrency: number;
    };
    expect(internal.timeoutMs).toBe(5_000);
    expect(internal.multipartConcurrency).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('ergonomic billing/limits accessors (8yqUXLCS)', () => {
  // The Proxy synthesises `credits()` / `creditsUsage()` / `limits()` as thin
  // fluent aliases over the low-level getters. Assert each hits the right
  // endpoint (the low-level method's literal path) and returns the right shape.
  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('credits() calls getCreditsBalance → GET /api/v2/credits/balance', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          monthly_balance: 1200,
          purchased_balance: 5000,
          overdraft_limit: 500,
          overdraft_debt: 0,
          available_credits: 6700,
          monthly_allowance: 2000,
          tier: 'pro',
        },
      }),
    );

    const balance = await client.credits();
    expect(balance.availableCredits).toBe(6700);
    expect(balance.tier).toBe('pro');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v2/credits/balance');
    expect(init.method).toBe('GET');
  });

  it('creditsUsage() with no options → GET /api/v2/credits/usage (no querystring)', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { transactions: [], total: 0, limit: 20, offset: 0 },
      }),
    );

    const page = await client.creditsUsage();
    expect(page.transactions).toEqual([]);
    expect(page.total).toBe(0);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v2/credits/usage');
  });

  it('creditsUsage({limit, offset}) forwards the query params', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { transactions: [], total: 7, limit: 5, offset: 5 },
      }),
    );

    const page = await client.creditsUsage({ limit: 5, offset: 5 });
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(5);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/credits/usage?');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=5');
  });

  it('limits() calls getAccountLimits → GET /api/v2/account/limits and decodes the limit entries', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          tier: 'pro',
          limits: {
            max_upload_size_bytes: {
              effective: 5368709120,
              tier_default: 5368709120,
              overridden: false,
            },
            max_total_input_size_bytes: {
              effective: 5368709120,
              tier_default: 1073741824,
              overridden: true,
            },
          },
        },
      }),
    );

    const accountLimits = await client.limits();
    expect(accountLimits.tier).toBe('pro');
    expect(accountLimits.limits.maxUploadSizeBytes.effective).toBe(5368709120);
    expect(accountLimits.limits.maxTotalInputSizeBytes.overridden).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v2/account/limits');
    expect(init.method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------

describe('_internalAnonymous (internal capability behind future gisl.anonymous)', () => {
  it('constructs without throwing even when no apiKey is configured', async () => {
    // Anonymous explicitly opts out of the missing-creds throw.
    const client = await _internalAnonymous();
    expect(client).toBeDefined();
  });

  it('does NOT attach an env-resolved apiKey on an anonymous client (codex r1 high)', async () => {
    // Regression guard: previously the anonymous branch suppressed the
    // missing-creds throw but still let resolveApiKey() find GISL_API_KEY
    // from env and attach an Authorization header — defeating the parking
    // guarantee and the anonymous claim. The fix entirely skips
    // resolveApiKey() when allowAnonymous=true; this test pins it.
    process.env.GISL_API_KEY = 'env_key_that_must_not_leak_to_anonymous';
    const client = await _internalAnonymous();
    const internal = client as unknown as { headers: Record<string, string> };
    expect(internal.headers?.Authorization).toBeUndefined();
  });

  it('does NOT attach a profile-file apiKey on an anonymous client (codex r1 high)', async () => {
    // Same regression class as above, exercised through the profile branch.
    const homeDir = mkdtempSyncT(joinT(tmpdirT(), 'gisl-anon-home-'));
    try {
      const gislDir = joinT(homeDir, '.gisl');
      mkdirSyncT(gislDir, { recursive: true });
      writeFileSyncT(joinT(gislDir, 'credentials'), '[default]\napi_key = profile_key_must_not_leak\n');
      process.env.HOME = homeDir;
      const client = await _internalAnonymous();
      const internal = client as unknown as { headers: Record<string, string> };
      expect(internal.headers?.Authorization).toBeUndefined();
    } finally {
      rmSyncT(homeDir, { recursive: true, force: true });
    }
  });

  it('throws GislFeatureRequiresAuthError for any current operation (allowlist empty in v0.7)', async () => {
    const client = await _internalAnonymous();
    // Any public operation method — for v0.7 this is the low-level GislClient
    // surface, since the ergonomic builders (T2+) haven't shipped yet.
    let thrown: unknown;
    try {
      await (client as unknown as { uploadFile: (...args: unknown[]) => Promise<unknown> }).uploadFile('photo.jpg');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect(thrown).toBeInstanceOf(GislConfigError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('uploadFile');
  });

  it('does NOT fetch when an anonymous-gated operation is called (fail-early)', async () => {
    const client = await _internalAnonymous();
    try {
      await (client as unknown as { createWorkflow: (...args: unknown[]) => Promise<unknown> }).createWorkflow({});
    } catch {
      /* expected throw */
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still permits getSchema (anonymous-safe public-metadata op)', async () => {
    // Public-metadata endpoints (schema introspection) MUST remain reachable
    // on an anonymous client; they're documented as separate from processing.
    const client = await _internalAnonymous();
    // Access the method without invoking; existence + correct type is the assertion.
    expect(typeof (client as unknown as { getSchema: () => unknown }).getSchema).toBe(
      'function',
    );
  });

  it('invokes login/logout WITHOUT the anonymous gate (passthrough branch positively tested)', async () => {
    // Test-reviewer finding: typeof-only assertions can't catch a regression
    // that inverts the passthrough branch. Invoke each method through the
    // proxy and assert NO GislFeatureRequiresAuthError is thrown — the call
    // reaches the transport (we don't care about the response shape here,
    // only that the gate didn't fire).
    const client = await _internalAnonymous();
    let loginErr: unknown;
    try {
      await (client as unknown as { login: (...args: unknown[]) => Promise<unknown> }).login(
        'user@example.com',
        'pw',
      );
    } catch (err) {
      loginErr = err;
    }
    expect(loginErr).not.toBeInstanceOf(GislFeatureRequiresAuthError);
    let logoutErr: unknown;
    try {
      await (client as unknown as { logout: () => Promise<unknown> }).logout();
    } catch (err) {
      logoutErr = err;
    }
    expect(logoutErr).not.toBeInstanceOf(GislFeatureRequiresAuthError);
  });

  it('carries the actual operation name on GislFeatureRequiresAuthError (not hardcoded)', async () => {
    // Test-reviewer finding: prior uploadFile-only test wouldn't catch
    // `this.operation = 'uploadFile'` hardcoded into the error constructor.
    const client = await _internalAnonymous();
    let thrown: unknown;
    try {
      await (client as unknown as { createWorkflow: (...args: unknown[]) => Promise<unknown> }).createWorkflow({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('createWorkflow');
  });
});
