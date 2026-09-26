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

  it('exposes gisl.anonymous as the explicit guest door (OuegCUtq)', () => {
    // Parked until owner decision 610(4); the behaviour is covered in
    // anonymous.test.ts and the contract pin in anonymous-allowlist-conformance.
    expect(typeof gisl.anonymous).toBe('function');
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

describe('_internalAnonymous (the gated low-level client behind gisl.anonymous)', () => {
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

  it('throws GislFeatureRequiresAuthError for an operation outside the allowlist', async () => {
    const client = await _internalAnonymous();
    let thrown: unknown;
    try {
      await (client as unknown as { cancelWorkflow: (...args: unknown[]) => Promise<unknown> }).cancelWorkflow('wf');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect(thrown).toBeInstanceOf(GislConfigError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('cancelWorkflow');
  });

  it('does NOT fetch when an anonymous-gated operation is called (fail-early)', async () => {
    const client = await _internalAnonymous();
    try {
      await (client as unknown as { getCreditsBalance: () => Promise<unknown> }).getCreditsBalance();
    } catch {
      /* expected throw */
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets an allowlisted operation through the gate to the transport', async () => {
    const client = await _internalAnonymous({ baseUrl: 'https://api.example.com' });
    let thrown: unknown;
    try {
      await client.getSchema();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeInstanceOf(GislFeatureRequiresAuthError);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('gates login and logout: an anonymous client carries no credential of any kind', async () => {
    // login's endpoint accepts guests, but it would turn this client into a
    // session client; logout's endpoint is auth-only. Both are refused
    // locally (see EXCLUDED_METHODS.login in anonymous-allowlist-conformance).
    const client = await _internalAnonymous();
    for (const op of ['login', 'logout'] as const) {
      let thrown: unknown;
      try {
        await (client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[op]!({});
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
      expect((thrown as GislFeatureRequiresAuthError).operation).toBe(op);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('carries the actual operation name on GislFeatureRequiresAuthError (not hardcoded)', async () => {
    // Test-reviewer finding: a single-method test wouldn't catch a hardcoded
    // operation name in the error constructor.
    const client = await _internalAnonymous();
    let thrown: unknown;
    try {
      await (client as unknown as { resumeWorkflow: (...args: unknown[]) => Promise<unknown> }).resumeWorkflow('wf');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('resumeWorkflow');
  });
});

// ExVcchMz — the exported single-op builder (gisl().convert/thumbnail) must
// validate its option bag PRE-UPLOAD (mirroring the file-first chain) so a bad
// bag fails locally with a GislConfigError instead of a server 422. These tests
// drive the PROXY FACTORY (create().convert/thumbnail) — the direct
// OperationBuilder tests in builder.test.ts bypass the factory, so this is the
// only coverage of the factory-level guard. Every rejection asserts NO fetch
// fired, proving the check is pre-upload.
describe('single-op builder option validation (ExVcchMz)', () => {
  async function client() {
    return create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
  }

  describe('thumbnail', () => {
    it('rejects an empty bag (missing width + height) pre-upload, no fetch', async () => {
      const c = await client();
      // `as never` — the tightened compile-time type rejects this bag (uFbM31dC);
      // this test exercises the RUNTIME guard (vitest strips types), so it bypasses
      // the compile check. Compile-time rejection is asserted separately below.
      expect(() => c.thumbnail('photo.png', {} as never)).toThrow(GislConfigError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a width-only bag (missing height) pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.thumbnail('photo.png', { width: 320 } as never)).toThrow(/height/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects an unknown option key pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.thumbnail('photo.png', { width: 100, height: 100, bogus: 1 } as never)).toThrow(
        /unknown option 'bogus'/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accepts a valid bag (width + height) at the factory (no throw)', async () => {
      const c = await client();
      expect(() => c.thumbnail('photo.png', { width: 100, height: 100, fit: 'crop' })).not.toThrow();
    });
  });

  describe('convert', () => {
    it('rejects a missing output_format (empty bag) pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', {} as never)).toThrow(/output_format/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a bag with options but no output_format pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', { quality: 80 } as never)).toThrow(/output_format/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a null output_format pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', { output_format: null } as never)).toThrow(/output_format/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects an unknown option key pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', { output_format: 'webp', bogus: 1 } as never)).toThrow(
        /unknown option 'bogus'/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects the SDK alias `format` (single-op needs the wire key output_format) pre-upload, no fetch', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', { format: 'webp' } as never)).toThrow(/unknown option 'format'/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accepts a valid bag (output_format present) at the factory (no throw)', async () => {
      const c = await client();
      expect(() => c.convert('photo.png', { output_format: 'webp', quality: 80 })).not.toThrow();
    });
  });

  // uFbM31dC — the single-op `convert`/`thumbnail` factory signatures are typed
  // (`ConvertOptions & { output_format }` / `ThumbnailOptions`), so a bad bag is a
  // COMPILE error, not only a runtime throw. vitest strips types so these assert
  // nothing at runtime — the value is the `@ts-expect-error` compile guard; the
  // builders are never invoked, so no upload/create fires. Mirrors the multi-input
  // `operation()` type-guard block below.
  // Enforced by `npm run check:tests` (`tsc -p tsconfig.test.json`), which CI and
  // `make project/test` run since jKfm0IOu. Until then nothing invoked that config
  // and these guards were inert (04qIcrNk).
  it('rejects single-op convert/thumbnail bad bags at compile time (uFbM31dC)', async () => {
    const c = await client();
    // @ts-expect-error — single-op convert requires `output_format` in the bag.
    const badConvertEmpty = (): unknown => c.convert('a.png', {});
    // @ts-expect-error — `output_format` is required even alongside other options.
    const badConvertNoFormat = (): unknown => c.convert('a.png', { quality: 80 });
    // @ts-expect-error — unknown key rejected by ConvertOptions.
    const badConvertUnknown = (): unknown => c.convert('a.png', { output_format: 'webp', bogus: 1 });
    // @ts-expect-error — `format` is the file-first alias, not the single-op wire key.
    const badConvertAlias = (): unknown => c.convert('a.png', { format: 'webp' });
    // @ts-expect-error — thumbnail requires width + height.
    const badThumbEmpty = (): unknown => c.thumbnail('a.png', {});
    // @ts-expect-error — thumbnail requires height too.
    const badThumbWidthOnly = (): unknown => c.thumbnail('a.png', { width: 320 });
    // @ts-expect-error — unknown key rejected by ThumbnailOptions.
    const badThumbUnknown = (): unknown => c.thumbnail('a.png', { width: 1, height: 1, bogus: 1 });

    // Positive controls — these MUST compile; a regression that breaks them would
    // surface as a plain tsc error here (not an unused-`@ts-expect-error`).
    const okConvert = (): unknown => c.convert('a.png', { output_format: 'webp', quality: 80 });
    const okThumb = (): unknown => c.thumbnail('a.png', { width: 320, height: 240, fit: 'crop' });

    // Reference the closures (never invoked) so no-unused-var stays quiet.
    expect(
      [badConvertEmpty, badConvertNoFormat, badConvertUnknown, badConvertAlias,
        badThumbEmpty, badThumbWidthOnly, badThumbUnknown, okConvert, okThumb].every(
        (f) => typeof f === 'function',
      ),
    ).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT validate compress at the factory (preset resolver owns it) — no throw on an unknown key', async () => {
    // compress is EXCLUDED from the single-op guards; its options resolve via the
    // preset resolver at run-time, so an unknown key does not throw at the factory.
    const c = await client();
    expect(() => c.compress('photo.png', { bogus: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

// qUhxfDA5 — capabilities() read-projection over getSchema(). The schema
// endpoint is NOT enveloped: the raw body IS the OperationsSchemaResponse.
describe('capabilities() (qUhxfDA5)', () => {
  function schemaResponse(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fullSchema: Record<string, unknown> = {
    schema_version: '2.0.0',
    operations: {
      compress: { description: 'c', input_model: 'single', mime_groups: {}, options: {} },
    },
    capabilities: {
      compress: { accepts: ['image/jpeg'], availability: 'stable', sole_op: false },
      text_watermark: { accepts: ['image/png'], availability: 'stable' },
    },
    // NB: the output_properties BLOCK key is snake_case, but its per-format
    // sub-object props are camelCase on the wire (hasAudioTrack/isAnimated) — a
    // deliberate two-level casing asymmetry in the contract, read correctly by
    // OutputPropertiesFromJSON.
    output_properties: {
      webp: { hasAudioTrack: false, isAnimated: false },
    },
    image_encode_capabilities: { webp_quality_supported: true, background_flatten: 'supported' },
  };

  it('projects the three v2.124 capability fields into a CapabilitiesSnapshot', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(schemaResponse(fullSchema));

    const snapshot = await client.capabilities();

    // operations map (tier-scoped), snake_case decoded to camelCase.
    expect(Object.keys(snapshot.operations).sort()).toEqual(['compress', 'text_watermark']);
    expect(snapshot.operations.compress.soleOp).toBe(false);
    expect(snapshot.operations.compress.availability).toBe('stable');
    // output-property table, keyed by output_format, with camelCase props decoded.
    expect(snapshot.outputProperties.webp.hasAudioTrack).toBe(false);
    // image-encode matrix.
    expect(snapshot.imageEncode?.webpQualitySupported).toBe(true);
    expect(snapshot.imageEncode?.backgroundFlatten).toBe('supported');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/operations/schema');
    expect(init.method).toBe('GET');
  });

  it('capabilities(opType) returns just that op\'s OperationCapability', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(schemaResponse(fullSchema));

    const cap = await client.capabilities('compress');
    expect(cap?.availability).toBe('stable');
    expect(cap?.soleOp).toBe(false);
  });

  it('capabilities(opType) returns undefined for an op absent from the matrix', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(schemaResponse(fullSchema));

    const cap = await client.capabilities('no_such_op');
    expect(cap).toBeUndefined();
  });

  it('returns empty maps / undefined imageEncode when the server omits the fields', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      schemaResponse({
        schema_version: '2.0.0',
        operations: { compress: { description: 'c', input_model: 'single', mime_groups: {}, options: {} } },
      }),
    );

    const snapshot = await client.capabilities();
    expect(snapshot.operations).toEqual({});
    expect(snapshot.outputProperties).toEqual({});
    expect(snapshot.imageEncode).toBeUndefined();
  });

  it('degrades to an empty snapshot on a 304 not-modified response', async () => {
    // Defensive branch: capabilities() sends no conditional headers, but a
    // globally-configured static If-None-Match could still 304 (empty body).
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { ETag: '"v"' } }),
    );

    const snapshot = await client.capabilities();
    expect(snapshot.operations).toEqual({});
    expect(snapshot.outputProperties).toEqual({});
    expect(snapshot.imageEncode).toBeUndefined();
  });

  it('per-op lookup returns undefined on a 304 not-modified response', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"v"' } }));

    expect(await client.capabilities('compress')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

// qUhxfDA5 — generic operation() escape hatch. Asserts the ergonomic verb wires
// opType + input + options into a single-source, single-op createWorkflow
// payload. Mocks the upload (POST /api/uploads, enveloped) + createWorkflow
// (POST /api/workflows, enveloped) fetches; submit() does not wait.
describe('operation() generic escape hatch (qUhxfDA5)', () => {
  function uploadResponse(fileId: string): Response {
    return new Response(
      JSON.stringify({
        success: true,
        data: { file_id: fileId, original_name: 'x', mime_type: 'text/plain', size_bytes: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  function createResponse(): Response {
    return new Response(
      JSON.stringify({
        success: true,
        data: { workflow_id: 'wf-op', status: 'pending', jobs: [], created_at: '2026-07-01T00:00:00Z', warnings: [] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('builds a single-op job carrying the given opType + options on the wire', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(uploadResponse('file-xyz'));
    fetchSpy.mockResolvedValueOnce(createResponse());

    await client
      .operation('text_watermark', new Blob(['x']), { text: 'CONFIDENTIAL', position: 'bottom-right' })
      .submit({ webhook: 'https://example.com/hook' });

    // Second fetch = createWorkflow. Assert the wire payload.
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/workflows');
    const body = JSON.parse(init.body as string);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].operations).toEqual([
      { type: 'text_watermark', options: { text: 'CONFIDENTIAL', position: 'bottom-right' } },
    ]);
    expect(body.jobs[0].source).toEqual({ type: 'upload', file_id: 'file-xyz' });
  });

  it('passes options through unchanged for a not-yet-in-contract op type', async () => {
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    fetchSpy.mockResolvedValueOnce(uploadResponse('file-2'));
    fetchSpy.mockResolvedValueOnce(createResponse());

    await client
      .operation('some_future_op', new Blob(['y']), { foo: 'bar', n: 1 })
      .submit({ webhook: 'https://example.com/hook' });

    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.jobs[0].operations[0]).toEqual({
      type: 'some_future_op',
      options: { foo: 'bar', n: 1 },
    });
  });

  it('rejects multi-input op literals at compile time (type-level guard)', async () => {
    // The generic conditional signature maps a MultiInputOperationType literal to
    // `never`, so passing one is a type error. The @ts-expect-error lines fail
    // `tsc` if a regression ever widens the type to accept them. (vitest strips
    // types, so this asserts nothing at runtime — the value is the compile guard;
    // we never invoke the builders, so no upload/create fires.)
    const client = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    // @ts-expect-error — 'merge' is multi-input; use merge(...).
    const buildMerge = (): unknown => client.operation('merge', new Blob(['x']), {});
    // @ts-expect-error — 'archive' is multi-input; use files(...).archive(...).
    const buildArchive = (): unknown => client.operation('archive', new Blob(['x']), {});
    // @ts-expect-error — 'image_watermark' is multi-input; use file(a).watermark(b).
    const buildOverlay = (): unknown => client.operation('image_watermark', new Blob(['x']), {});
    // @ts-expect-error — 'audio_to_video' is multi-input (base + optional overlay).
    const buildAudioToVideo = (): unknown => client.operation('audio_to_video', new Blob(['x']), {});
    // @ts-expect-error — 'custom_luma' is multi-input (base + transition_mask).
    const buildCustomLuma = (): unknown => client.operation('custom_luma', new Blob(['x']), {});
    expect(typeof buildMerge).toBe('function');
    expect(typeof buildArchive).toBe('function');
    expect(typeof buildOverlay).toBe('function');
    expect(typeof buildAudioToVideo).toBe('function');
    expect(typeof buildCustomLuma).toBe('function');
  });
});
