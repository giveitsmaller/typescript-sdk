import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '../../src/gisl.js';
import { fileInput } from '../../src/file-first.js';
import {
  GISL_STREAM_HOST_NOT_DECLARED_WARNING,
  OperationBuilder,
  type ProgressEvent,
} from '../../src/builder.js';
import { GislStreamHostNotDeclaredError } from '../../src/errors.js';
import type { GislClient } from '../../src/client.js';

/**
 * v0JhuD8V — the transport a run actually used is visible on its result, and a
 * client that polls because no stream host is declared says so ONCE.
 *
 * Measured on staging with published sdk 0.38.0: `create({ apiKey, baseUrl })`
 * resolves no stream host (by design — the stream host is declared, never
 * derived from `baseUrl`), so `run()` polled GET /status for 125 s and never
 * opened /events, with no signal anywhere. Correct, and invisible.
 *
 * Driven FROM THE PUBLIC ENTRY POINT (`create()`) against a routing `fetch`
 * stub, so the stream-host resolution under test is the real one, and the
 * "no /events request" assertions are about what actually reached the network.
 *
 * Mirrors the PHP `RunTransportTest`.
 */

const WF = '01936fb2-0001-7000-8000-0000000071a2';
const STAGING_API = 'https://api.staging.giveitsmaller.com';
const STAGING_STREAM = 'https://stream.staging.giveitsmaller.com';
const ENDPOINT_ENV_VARS = ['GISL_STREAM_BASE_URL', 'GISL_ENVIRONMENT', 'GISL_BASE_URL'] as const;

const TERMINAL_SSE = `event: workflow.completed\ndata: {"workflow_id":"${WF}"}\n\n`;
const PROGRESS_ONLY_SSE =
  'event: operation.progress\n' +
  `data: {"workflow_id":"${WF}","job_ref":"op","operation_id":"o1","type":"compress","progress":40}\n\n`;

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const createdBody = {
  workflow_id: WF,
  status: 'pending',
  created_at: '2026-10-01T00:00:00Z',
  jobs: [],
  delivery_plan: { mode: 'individual', selection_type: 'terminal', outputs: [], hidden_outputs: [] },
  processing_plan: { jobs: [] },
  warnings: [],
};

const completedBody = {
  workflow_id: WF,
  status: 'completed',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:30Z',
  jobs: [{ job_id: 'j1', ref: 'op', status: 'completed', operations: [] }],
};

const downloadsBody = {
  downloads: [
    {
      job_id: 'j1',
      ref: 'op',
      files: [
        {
          operation: 'compress',
          operation_id: 'o1',
          filename: 'photo.webp',
          size_bytes: 20480,
          download_url: 'https://cdn.example.com/photo.webp',
        },
      ],
    },
  ],
};

/**
 * Route by method + path. `/events` serves `sseBody` (default: a terminal
 * frame). Every request URL is recorded so a test can assert what reached the
 * network — in particular, that a baseUrl-only client never asked for /events.
 */
function routedFetch(sseBody: string = TERMINAL_SSE): { fn: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    urls.push(url);
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/api/workflows') return json(201, createdBody);
    if (path.endsWith('/events')) {
      return new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path.endsWith('/status')) return json(200, completedBody);
    if (path.endsWith('/downloads')) return json(200, downloadsBody);
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { fn, urls };
}

const eventsRequests = (urls: string[]): string[] => urls.filter((u) => new URL(u).pathname.endsWith('/events'));

describe('run transport + the no-stream-host warning (v0JhuD8V)', () => {
  let savedEnv: Record<string, string | undefined>;
  let emitWarning: ReturnType<typeof vi.spyOn>;

  /** Only OUR warning: an unrelated Node warning must not be counted. */
  const ourWarnings = (): unknown[][] =>
    emitWarning.mock.calls.filter(
      (call) => (call[1] as { code?: string } | undefined)?.code === GISL_STREAM_HOST_NOT_DECLARED_WARNING,
    );

  beforeEach(() => {
    savedEnv = {};
    for (const name of ENDPOINT_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of ENDPOINT_ENV_VARS) {
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a baseUrl-only client polls, says so on the result, and warns exactly once across two runs', async () => {
    const { fn, urls } = routedFetch();
    vi.stubGlobal('fetch', fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });

    const first = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });
    const second = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });

    expect(first.transport).toBe('polling');
    expect(second.transport).toBe('polling');
    expect(eventsRequests(urls)).toEqual([]);
    expect(ourWarnings()).toHaveLength(1);
    const [message, options] = ourWarnings()[0] as [string, { type: string; code: string }];
    expect(options.type).toBe('GislWarning');
    // The warning names the fix, not just the symptom.
    expect(message).toContain('baseUrl does not move the stream host');
    expect(message).toContain('streamBaseUrl');
    expect(message).toContain('GISL_STREAM_BASE_URL');
    expect(message).toContain('useSSE: false');
  });

  it('warns once per CLIENT: a second client gets its own warning', async () => {
    vi.stubGlobal('fetch', routedFetch().fn);
    for (let i = 0; i < 2; i++) {
      const client = await create({ apiKey: 'k', baseUrl: STAGING_API });
      await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });
    }

    expect(ourWarnings()).toHaveLength(2);
  });

  it('an environment client streams and does not warn', async () => {
    const { fn, urls } = routedFetch();
    vi.stubGlobal('fetch', fn);
    const client = await create({ apiKey: 'k', environment: 'staging' });

    const result = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });

    expect(result.transport).toBe('sse');
    expect(eventsRequests(urls)).toEqual([`${STAGING_STREAM}/api/workflows/${WF}/events`]);
    expect(ourWarnings()).toEqual([]);
  });

  it('a streamBaseUrl client streams and does not warn', async () => {
    vi.stubGlobal('fetch', routedFetch().fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API, streamBaseUrl: STAGING_STREAM });

    const result = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });

    expect(result.transport).toBe('sse');
    expect(ourWarnings()).toEqual([]);
  });

  it('GISL_STREAM_BASE_URL also declares the host, so no warning', async () => {
    process.env.GISL_STREAM_BASE_URL = STAGING_STREAM;
    vi.stubGlobal('fetch', routedFetch().fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });

    const result = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });

    expect(result.transport).toBe('sse');
    expect(ourWarnings()).toEqual([]);
  });

  it('useSSE: false polls without a warning — the caller chose it', async () => {
    const { fn, urls } = routedFetch();
    vi.stubGlobal('fetch', fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });

    const result = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s', useSSE: false });

    expect(result.transport).toBe('polling');
    expect(eventsRequests(urls)).toEqual([]);
    expect(ourWarnings()).toEqual([]);
  });

  it('a stream that opens and then falls back reports the FINAL transport', async () => {
    // The stream delivers a progress event, then ends cleanly with no terminal
    // frame, so run() falls back to polling. The result says 'polling'; the
    // streamed progress is what onProgress saw.
    const { fn, urls } = routedFetch(PROGRESS_ONLY_SSE);
    vi.stubGlobal('fetch', fn);
    const client = await create({ apiKey: 'k', environment: 'staging' });
    const events: ProgressEvent[] = [];

    const result = await client
      .file(fileInput.uploadId('file_1'))
      .compress()
      .run({ maxWait: '30s', onProgress: (e) => events.push(e) });

    expect(result.transport).toBe('polling');
    expect(eventsRequests(urls)).toHaveLength(1);
    expect(events.map((e) => e.phase)).toEqual(['processing']);
    // A stream host WAS declared: the fallback is not a configuration problem.
    expect(ourWarnings()).toEqual([]);
  });

  it('serialises transport LAST in toJSON (PHP toArray parity)', async () => {
    vi.stubGlobal('fetch', routedFetch().fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });

    const result = await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s', useSSE: false });
    const keys = Object.keys(result.toJSON());

    expect(keys[keys.length - 1]).toBe('transport');
    expect(JSON.parse(JSON.stringify(result)).transport).toBe('polling');
  });

  it('Handle.wait() reports its transport; Handle.result() reports none (no wait happened)', async () => {
    vi.stubGlobal('fetch', routedFetch().fn);
    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });

    const waited = await client.workflow(WF).wait('30s');
    const fetched = await client.workflow(WF).result();

    expect(waited.transport).toBe('polling');
    expect(fetched.transport).toBeUndefined();
    expect('transport' in fetched.toJSON()).toBe(false);
    expect(ourWarnings()).toHaveLength(1);
  });

  it('falls back to console.warn where process.emitWarning does not exist (browsers)', async () => {
    vi.stubGlobal('fetch', routedFetch().fn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = process.emitWarning;
    (process as unknown as { emitWarning: unknown }).emitWarning = undefined;
    try {
      const client = await create({ apiKey: 'k', baseUrl: STAGING_API });
      await client.file(fileInput.uploadId('file_1')).compress().run({ maxWait: '30s' });
    } finally {
      process.emitWarning = original;
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(GISL_STREAM_HOST_NOT_DECLARED_WARNING);
  });
});

describe('operation-first Result.transport (v0JhuD8V)', () => {
  function mockClient(streamEvents: ReturnType<typeof vi.fn>): GislClient {
    return {
      uploadFile: vi.fn(async () => ({ fileId: 'file_1', contentType: 'image/jpeg', sizeBytes: 1024 })),
      maybeWaitForVideoProbe: vi.fn(async () => undefined),
      createWorkflow: vi.fn(async () => ({ workflowId: 'wf_1', status: 'running' })),
      getWorkflowStatus: vi.fn(async () => ({ workflowId: 'wf_1', status: 'completed', jobs: [] })),
      getWorkflowDownloads: vi.fn(async () => ({ downloads: [] })),
      streamEvents,
    } as unknown as GislClient;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is 'sse' when the stream delivers the terminal event", async () => {
    const client = mockClient(
      vi.fn(async function* () {
        yield { event: 'workflow.completed', data: { status: 'completed' } };
      }),
    );

    const result = await new OperationBuilder(client, 'compress', 'p.jpg', {}).run({ maxWait: '30s' });

    expect(result.transport).toBe('sse');
  });

  it("is 'polling', with one warning per client, when no stream host is declared", async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const client = mockClient(
      vi.fn(async () => {
        throw new GislStreamHostNotDeclaredError('No SSE stream host is declared for this configuration');
      }),
    );

    const first = await new OperationBuilder(client, 'compress', 'p.jpg', {}).run({ maxWait: '30s' });
    const second = await new OperationBuilder(client, 'compress', 'p.jpg', {}).run({ maxWait: '30s' });

    expect(first.transport).toBe('polling');
    expect(second.transport).toBe('polling');
    expect(emitWarning).toHaveBeenCalledTimes(1);
  });
});
