import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { gisl, _internalAnonymous } from '../../src/gisl.js';
import {
  GislApiError,
  GislFeatureRequiresAuthError,
  GislMissingCredentialsError,
  GislTierRestrictedError,
} from '../../src/errors.js';

/**
 * OuegCUtq — `gisl.anonymous()` end to end against a fake transport: no
 * credential on any request, every request lands on an endpoint the contract
 * marks anonymous-capable, and the `cap` from create is threaded into the
 * workflow's reads without the caller holding it.
 */

const require = createRequire(import.meta.url);
const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as { endpoints: Record<string, { auth: string }> };

const BASE = 'https://api.example.com';
const STREAM = 'https://stream.example.com';
const WORKFLOW_ID = '01936fb2-0000-7000-8000-0000000070e2';
const CAP = 'cap_plaintext_token_from_create';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  credentials?: string;
}

let seen: Seen[];
let createStatus: number;
let createBody: unknown;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(method: string, path: string): Response {
  if (method === 'POST' && path === '/api/uploads') {
    return json(201, {
      success: true,
      data: { file_id: '01936fb1-7bb3-7000-8000-0000000070e1', original_name: 'photo.jpg', mime_type: 'image/jpeg', size_bytes: 3 },
    });
  }
  if (method === 'POST' && path === '/api/workflows') return json(createStatus, createBody);
  if (method === 'GET' && path === `/api/workflows/${WORKFLOW_ID}/status`) {
    return json(200, {
      success: true,
      data: {
        workflow_id: WORKFLOW_ID,
        status: 'completed',
        created_at: '2026-09-26T11:00:00Z',
        updated_at: '2026-09-26T11:00:30Z',
        jobs: [
          {
            job_id: '01936fb3-0001-7000-8000-0000000070e3',
            ref: 'op',
            status: 'completed',
            operations: [{ id: '01936fb4-0001-7000-8000-0000000070e4', type: 'compress', status: 'completed', progress: 1.0 }],
          },
        ],
      },
    });
  }
  if (method === 'GET' && path === `/api/workflows/${WORKFLOW_ID}/downloads`) {
    return json(200, {
      success: true,
      data: {
        downloads: [
          {
            job_id: '01936fb3-0001-7000-8000-0000000070e3',
            ref: 'op',
            files: [
              {
                operation: 'compress',
                operation_id: '01936fb4-0001-7000-8000-0000000070e4',
                filename: 'photo.webp',
                size_bytes: 2,
                download_url: 'https://cdn.example.com/photo.webp',
              },
            ],
          },
        ],
      },
    });
  }
  if (method === 'GET' && path === `/api/workflows/${WORKFLOW_ID}/events`) {
    return new Response('event: workflow.completed\ndata: {"status":"completed"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return json(404, { success: false, error: 'NOT_FOUND' });
}

function anonymousCreateBody(): unknown {
  return {
    success: true,
    data: {
      workflow_id: WORKFLOW_ID,
      anonymous: true,
      status: 'pending',
      created_at: '2026-09-26T11:00:00Z',
      jobs: [],
      delivery_plan: { mode: 'individual', selection_type: 'terminal', outputs: [], hidden_outputs: [] },
      processing_plan: { jobs: [] },
      warnings: [],
      cap: CAP,
    },
  };
}

/** The contract endpoint key (`METHOD /template`) a concrete request matches. */
function endpointFor(method: string, path: string): string | undefined {
  return Object.keys(availability.endpoints).find((key) => {
    const [m, template] = key.split(' ') as [string, string];
    if (m !== method) return false;
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    return pattern.test(path);
  });
}

const TRACKED_ENV = ['GISL_API_KEY', 'GISL_BASE_URL', 'GISL_ENVIRONMENT', 'HOME', 'USERPROFILE'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of TRACKED_ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  seen = [];
  createStatus = 201;
  createBody = anonymousCreateBody();
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      credentials: init?.credentials,
    });
    return route(init?.method ?? 'GET', url.pathname);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fake as unknown as typeof fetch;
});

afterEach(() => {
  for (const name of TRACKED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.restoreAllMocks();
});

function hasCredential(s: Seen): boolean {
  const names = Object.keys(s.headers).map((h) => h.toLowerCase());
  return names.includes('authorization') || names.includes('cookie') || s.credentials === 'include';
}

describe('gisl.anonymous() — construction', () => {
  it('is on the gisl namespace, and gisl.create() still refuses a missing key', async () => {
    expect(typeof gisl.anonymous).toBe('function');
    await expect(gisl.create({ baseUrl: BASE })).rejects.toBeInstanceOf(GislMissingCredentialsError);
  });

  it('constructs with no key anywhere and ignores an ambient GISL_API_KEY', async () => {
    process.env.GISL_API_KEY = 'env_key_must_not_reach_a_guest_request';
    const client = await gisl.anonymous({ baseUrl: BASE });
    await client.getWorkflowStatus(WORKFLOW_ID);
    expect(seen).toHaveLength(1);
    expect(hasCredential(seen[0]!)).toBe(false);
  });

  it('drops a key or session cookie an untyped caller passes anyway', async () => {
    const untyped = { baseUrl: BASE, apiKey: 'smuggled', useSessionCookie: true } as unknown as Parameters<
      typeof gisl.anonymous
    >[0];
    const client = await gisl.anonymous(untyped);
    await client.getWorkflowStatus(WORKFLOW_ID);
    expect(hasCredential(seen[0]!)).toBe(false);
  });

  it('drops credential headers (any case), keeps other headers, and omits ambient cookies', async () => {
    const client = await gisl.anonymous({
      baseUrl: BASE,
      headers: { Authorization: 'Bearer smuggled', cookie: 'PHPSESSID=x', 'X-Trace': 't-1' },
    });
    await client.getWorkflowStatus(WORKFLOW_ID);
    const sent = seen[0]!;
    expect(hasCredential(sent)).toBe(false);
    expect(sent.headers['X-Trace']).toBe('t-1');
    // A browser's default credentials mode would still attach a same-origin cookie.
    expect(sent.credentials).toBe('omit');
  });
});

describe('gisl.anonymous() — the quick start', () => {
  it('file().compress().run() completes, credential-free, on anonymous-capable endpoints only, with cap threaded', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    const result = await client
      .file(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }))
      .compress()
      .run({ maxWait: '30s', useSSE: false });

    expect(result.workflowId).toBe(WORKFLOW_ID);
    expect(result.url).toBe('https://cdn.example.com/photo.webp');

    const paths = seen.map((s) => `${s.method} ${new URL(s.url).pathname}`);
    expect(paths).toEqual([
      'POST /api/uploads',
      'POST /api/workflows',
      `GET /api/workflows/${WORKFLOW_ID}/status`,
      `GET /api/workflows/${WORKFLOW_ID}/downloads`,
    ]);
    for (const s of seen) {
      expect(hasCredential(s)).toBe(false);
      const endpoint = endpointFor(s.method, new URL(s.url).pathname);
      expect(endpoint, `${s.method} ${s.url} matches no contract endpoint`).toBeDefined();
      expect(availability.endpoints[endpoint!]!.auth).not.toBe('required');
    }
    // The reads after create carry the create's cap; the caller never held it.
    expect(seen[0]!.headers['X-Workflow-Capability']).toBeUndefined();
    expect(seen[1]!.headers['X-Workflow-Capability']).toBeUndefined();
    expect(seen[2]!.headers['X-Workflow-Capability']).toBe(CAP);
    expect(seen[3]!.headers['X-Workflow-Capability']).toBe(CAP);
  });

  it('an upload exactly at the single-shot cap goes single-shot', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    const bytes = new Uint8Array(10_000_000);
    bytes.set([0xff, 0xd8, 0xff]);
    await client.uploadFile(new Blob([bytes], { type: 'image/jpeg' }));
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/uploads']);
  });

  it('an upload one byte over the single-shot cap is refused before any request (multipart needs an account)', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    const bytes = new Uint8Array(10_000_001);
    let thrown: unknown;
    try {
      await client.file(new Blob([bytes], { type: 'image/jpeg' })).compress().run({ useSSE: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('uploadFile');
    expect((thrown as Error).message).toContain('10000000');
    expect(seen).toHaveLength(0);
  });

  it('an untyped multipartThreshold cannot re-open multipart', async () => {
    const untyped = { baseUrl: BASE, multipartThreshold: 8 * 1024 * 1024 } as unknown as Parameters<
      typeof gisl.anonymous
    >[0];
    const client = await gisl.anonymous(untyped);
    await client.uploadFile(new Blob([new Uint8Array(9_000_000)], { type: 'image/jpeg' }));
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/uploads']);
  });

  // The guest rule is the API's (compression_api AnonymousOperationPolicy /
  // AnonymousUploadPolicy). The SDK sends the request and surfaces the refusal;
  // these pin that each refusal reaches the caller typed, not swallowed.
  it("an operation outside the guest rule reaches the caller as the API's 403, not a local guess", async () => {
    createStatus = 403;
    createBody = {
      success: false,
      error: 'ANONYMOUS_OPERATION_NOT_ALLOWED',
      error_type: 'anonymous_operation_not_allowed',
      message: 'This operation requires an account.',
      operation: 'text_watermark',
    };
    const client = await gisl.anonymous({ baseUrl: BASE });
    const run = client
      .operation('text_watermark', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }))
      .run({ useSSE: false });
    await expect(run).rejects.toBeInstanceOf(GislApiError);
    await expect(run).rejects.toMatchObject({ statusCode: 403, errorCode: 'ANONYMOUS_OPERATION_NOT_ALLOWED' });
    // It got as far as the create: the SDK did not refuse the op itself.
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toContain('POST /api/workflows');
  });

  it('an upload over the guest size cap reaches the caller as GislTierRestrictedError', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      json(403, {
        success: false,
        error: 'TIER_RESTRICTION',
        error_type: 'tier_restriction',
        message: 'File size exceeds the 10 MiB limit for visitors without an account.',
        restriction_kind: 'file_size',
        // The API sends the base tier's canonical value for a guest.
        current_tier: 'basic',
        required_tier: null,
      })) as unknown as typeof fetch;
    const upload = client.uploadFile(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }));
    await expect(upload).rejects.toBeInstanceOf(GislTierRestrictedError);
    await expect(upload).rejects.toMatchObject({ payload: { restrictionKind: 'file_size' } });
  });
});

describe('gisl.anonymous() — cap threading on the low-level methods', () => {
  it('sends the remembered cap on status, wait, downloads and events', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE, streamBaseUrl: STREAM });
    await client.createWorkflow({ jobs: [] } as never);
    await client.getWorkflowStatus(WORKFLOW_ID);
    await client.waitForWorkflow(WORKFLOW_ID, { intervalMs: 1, timeoutMs: 1000 });
    await client.getWorkflowDownloads(WORKFLOW_ID);
    await client.streamEvents(WORKFLOW_ID);

    const reads = seen.slice(1);
    expect(reads.map((s) => new URL(s.url).pathname)).toEqual([
      `/api/workflows/${WORKFLOW_ID}/status`,
      `/api/workflows/${WORKFLOW_ID}/status`,
      `/api/workflows/${WORKFLOW_ID}/downloads`,
      `/api/workflows/${WORKFLOW_ID}/events`,
    ]);
    for (const s of reads) expect(s.headers['X-Workflow-Capability']).toBe(CAP);
    expect(new URL(reads[3]!.url).origin).toBe(STREAM);
  });

  it('an explicit capability wins over the remembered one', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    await client.createWorkflow({ jobs: [] } as never);
    await client.getWorkflowStatus(WORKFLOW_ID, { capability: 'explicit' });
    expect(seen[1]!.headers['X-Workflow-Capability']).toBe('explicit');
  });

  it('sends no cap for a workflow this client did not create', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    await client.getWorkflowStatus(WORKFLOW_ID);
    expect(seen[0]!.headers['X-Workflow-Capability']).toBeUndefined();
  });

  it('remembers nothing when the create returns no cap', async () => {
    createBody = { ...(anonymousCreateBody() as { success: boolean; data: object }) };
    (createBody as { data: Record<string, unknown> }).data = {
      ...(anonymousCreateBody() as { data: Record<string, unknown> }).data,
      cap: null,
    };
    const client = await gisl.anonymous({ baseUrl: BASE });
    await client.createWorkflow({ jobs: [] } as never);
    await client.getWorkflowStatus(WORKFLOW_ID);
    expect(seen[1]!.headers['X-Workflow-Capability']).toBeUndefined();
  });
});

describe('gisl.anonymous() — local refusals before any I/O', () => {
  it('ergonomic sugar over an auth-only endpoint throws with the low-level operation name', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    let thrown: unknown;
    try {
      await client.credits();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('getCreditsBalance');
    expect(seen).toHaveLength(0);
  });

  it('refuses a multipart resume (its endpoints are auth-only) before touching the file', async () => {
    const client = await gisl.anonymous({ baseUrl: BASE });
    await expect(
      client.uploadFile('/definitely/not/a/real/path.jpg', { resumeUploadId: '019539ab-1111-7000-8000-000000000001' }),
    ).rejects.toBeInstanceOf(GislFeatureRequiresAuthError);
    expect(seen).toHaveLength(0);
  });

  it('makes the best-effort video probe wait a no-op (the probe endpoint is auth-only)', async () => {
    const client = await _internalAnonymous({ baseUrl: BASE });
    await client.maybeWaitForVideoProbe('019539ab-1111-7000-8000-000000000001', {
      enabled: true,
      isVideo: true,
      sizeBytes: 500 * 1024 * 1024,
    });
    expect(seen).toHaveLength(0);
  });

  it('a probe_pending recovery meets the gate instead of probing unauthenticated', async () => {
    createStatus = 422;
    createBody = {
      success: false,
      error: 'PROBE_PENDING',
      error_type: 'probe_pending',
      message: 'probe pending',
      job_ref: 'job_0',
    };
    const client = await _internalAnonymous({ baseUrl: BASE });
    const payload = { jobs: [{ source: { type: 'upload', file_id: 'f1' }, operations: [] }] } as never;
    let thrown: unknown;
    try {
      await client.createWorkflowAwaitingProbe(payload, { timeoutMs: 1000 });
    } catch (err) {
      thrown = err;
    }
    // The refusal names job_0 -> upload f1, so recovery reaches waitForProbe,
    // which the gate refuses: the create went out once and no probe did.
    expect(thrown).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((thrown as GislFeatureRequiresAuthError).operation).toBe('waitForProbe');
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/workflows']);
  });
});
