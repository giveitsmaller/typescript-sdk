import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Recipe, RunResult, fileInput } from '../src/file-first.js';
import { Handle } from '../src/handle.js';
import type { ProgressEvent } from '../src/builder.js';
import { GislConfigError, GislNoSuchKeyError, GislTimeoutError } from '../src/errors.js';
import type { GislClient } from '../src/client.js';

/**
 * FF2b — `Recipe.run()` end-to-end execution: upload (when required) →
 * createWorkflow → await terminal (SSE-first, poll fallback) → flatten
 * downloads into a {@link RunResult}. Network-free: every call goes through
 * the `GislClient` methods, which are replaced with `vi.fn` doubles (mirrors
 * `builder.test.ts`). The downloader is exercised in isolation + via the
 * bound-downloader assertion. Mirrors the PHP `RecipeRunTest`.
 */

let fetchSpy: ReturnType<typeof vi.fn>;

interface MockClientHandles {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  maybeWaitForVideoProbe: ReturnType<typeof vi.fn>;
  client: GislClient;
}

function makeMockClient(): MockClientHandles {
  const uploadFile = vi.fn(async (_path: string | Blob, _opts?: unknown) => ({
    fileId: 'file_1',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({
    workflowId: 'wf_1',
    status: 'running',
  }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    jobs: [{ jobId: 'job_1', ref: 'op', status: 'completed' }],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      {
        jobId: 'job_1',
        ref: 'op',
        files: [
          {
            operation: 'compress',
            operationId: 'opid_1',
            filename: 'photo_compressed.jpg',
            sizeBytes: 512,
            downloadUrl: 'https://signed.example.com/photo_compressed.jpg',
          },
        ],
      },
    ],
  }));
  // Default: SSE yields a terminal completion (happy path).
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
  });
  // YOA6FpFr PR2 — the upload→create seam now calls maybeWaitForVideoProbe
  // before createWorkflow. A no-op default keeps the orchestration tests
  // network-free (the gate's own behaviour is covered in its unit test).
  const maybeWaitForVideoProbe = vi.fn(async () => undefined);
  const client = {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
    maybeWaitForVideoProbe,
  } as unknown as GislClient;
  return {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
    maybeWaitForVideoProbe,
    client,
  };
}

/** Build a Recipe carrying the mock client, mirroring the `gisl().file()` wiring. */
function recipe(
  mock: MockClientHandles,
  input = fileInput.path('photo.jpg'),
  key?: string,
): Recipe {
  return new Recipe(input, key, [], undefined, undefined, mock.client);
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('Recipe.run — happy path via SSE', () => {
  it('uploads, creates, awaits SSE terminal, flattens downloads into a RunResult', async () => {
    const mock = makeMockClient();
    const result: RunResult = await recipe(mock).compress().run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    expect(mock.streamEvents).toHaveBeenCalledOnce();
    expect(mock.getWorkflowDownloads).toHaveBeenCalledOnce();

    expect(result.workflowId).toBe('wf_1');
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    // Artifacts flattened from downloads[].files[] (url ← file.downloadUrl).
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toEqual({
      url: 'https://signed.example.com/photo_compressed.jpg',
      filename: 'photo_compressed.jpg',
      sizeBytes: 512,
      operation: 'compress',
    });
    // Single output → url sugar set.
    expect(result.url).toBe('https://signed.example.com/photo_compressed.jpg');
  });

  it('partitions a keyless success into succeeded=[{key:null, outputs}]', async () => {
    const mock = makeMockClient();
    const result = await recipe(mock).compress().run({ maxWait: '30s' });
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].key).toBeNull();
    expect(result.succeeded[0].outputs).toEqual(result.artifacts);
  });

  it('flattens multiple downloads[].files[] entries in order', async () => {
    const mock = makeMockClient();
    mock.getWorkflowDownloads.mockResolvedValueOnce({
      downloads: [
        {
          jobId: 'job_1',
          ref: 'op',
          files: [
            { operation: 'convert', operationId: 'o1', filename: 'page_1.png', sizeBytes: 100, downloadUrl: 'https://s.example.com/1.png' },
            { operation: 'convert', operationId: 'o1', filename: 'page_2.png', sizeBytes: 110, downloadUrl: 'https://s.example.com/2.png' },
          ],
        },
      ],
    });
    const result = await recipe(mock).convert('png').run({ maxWait: '30s' });
    expect(result.artifacts.map((a) => a.filename)).toEqual(['page_1.png', 'page_2.png']);
    // >1 output → url sugar undefined.
    expect(result.url).toBeUndefined();
  });
});

describe('Recipe.run — uploadId arm', () => {
  it('uses the pre-uploaded id verbatim and makes NO upload call', async () => {
    const mock = makeMockClient();
    const result = await recipe(mock, fileInput.uploadId('file_existing'))
      .convert('webp')
      .run({ maxWait: '30s' });

    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    // The lowered payload must reference the verbatim id, never an uploaded one.
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].source).toEqual({ type: 'upload', file_id: 'file_existing' });
    expect(result.state).toBe('completed');
  });
});

describe('Recipe.run — poll fallback', () => {
  it('falls back to polling when SSE transport fails, reaching the same RunResult', async () => {
    const mock = makeMockClient();
    // A genuine fetch transport failure surfaces as a TypeError; the SDK wraps it
    // as GislNetworkError and falls back to poll (TDqmkWpX: only a transport error
    // or a clean stream-end fall back — other errors propagate).
    mock.streamEvents.mockImplementation(async function* () {
      throw new TypeError('sse boom');
      // eslint-disable-next-line no-unreachable
      yield;
    });
    const result = await recipe(mock).compress().run({ maxWait: '30s' });
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(1);
  });

  it('falls back to polling when SSE ends without a terminal event', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'operation.progress', data: { progress: 50 } };
      // ends without workflow.completed → SSE helper throws → poll fallback
    });
    const result = await recipe(mock).compress().run({ maxWait: '30s' });
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
  });
});

describe('Recipe.run — timeout', () => {
  it('throws GislTimeoutError when the deadline elapses before terminal', async () => {
    const mock = makeMockClient();
    // SSE ends without terminal → poll; poll never terminal → deadline trips.
    mock.streamEvents.mockImplementation(async function* () {
      return;
      // eslint-disable-next-line no-unreachable
      yield;
    });
    mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_1', status: 'running' });
    await expect(recipe(mock).compress().run({ maxWait: 1, pollIntervalMs: 5 })).rejects.toBeInstanceOf(
      GislTimeoutError,
    );
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
  });
});

describe('Recipe.run — no-client guard', () => {
  it('throws GislConfigError(no_client) for a directly-constructed Recipe', async () => {
    const bare = new Recipe(fileInput.path('photo.jpg'));
    await expect(bare.compress().run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(bare.compress().run()).rejects.toMatchObject({ reason: 'no_client' });
  });
});

describe('Recipe.run — onProgress', () => {
  it('emits an upload event with byte counters and a processing event', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockImplementation(
      async (_input: string | Blob, opts?: { onProgress?: (u: number, t: number) => void }) => {
        opts?.onProgress?.(512, 1024);
        return { fileId: 'file_1', contentType: 'image/jpeg', sizeBytes: 1024 };
      },
    );
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'operation.progress', data: { progress: 60 } };
      yield { event: 'workflow.completed', data: { status: 'completed' } };
    });

    const events: ProgressEvent[] = [];
    await recipe(mock).compress().run({ maxWait: '30s', onProgress: (e) => events.push(e) });

    const upload = events.find((e) => e.phase === 'upload');
    expect(upload).toBeDefined();
    expect(upload).toMatchObject({ phase: 'upload', uploadedBytes: 512, totalBytes: 1024 });
    expect(events.some((e) => e.phase === 'processing')).toBe(true);
  });
});

describe('Recipe.run — failed terminal', () => {
  it('partitions a failed workflow into failed=[{key,error}] with ok=false', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.failed', data: { status: 'failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'failed',
      jobs: [{ operations: [{ errorMessage: 'codec exploded' }] }],
    });
    // SSE returns a terminal failed event, so getWorkflowStatus is not consulted
    // on the SSE path — drive the failed state purely off the SSE terminal.
    const result = await recipe(mock).compress().run({ maxWait: '30s' });

    expect(result.state).toBe('failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBeNull();
    expect(result.failed[0].error).toBeInstanceOf(Error);
    // The error message is "{state}: {firstOpErrorMessage}" — pin the content,
    // not just the type, so a misformatted partition message is caught.
    expect((result.failed[0].error as Error).message).toBe('failed: codec exploded');
  });

  it('picks the first DEFINED op errorMessage when an earlier op has none', async () => {
    // First operation carries no errorMessage; the partition must walk on to
    // the later op that does — pinning the find/break-2 selection.
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.failed', data: { status: 'failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'failed',
      jobs: [
        {
          operations: [
            { errorMessage: undefined },
            { errorMessage: 'later op blew up' },
          ],
        },
      ],
    });
    const result = await recipe(mock).compress().run({ maxWait: '30s' });

    expect(result.state).toBe('failed');
    expect((result.failed[0].error as Error).message).toBe('failed: later op blew up');
  });
});

describe('Recipe.run — partially_failed terminal', () => {
  it('treats partially_failed as a failure (succeeded=[], failed=1, ok=false)', async () => {
    // A partial failure must NOT be misclassified as success. The SSE yields
    // the workflow.partially_failed terminal event, then the status carries the
    // partially_failed state plus a per-op error message.
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.partially_failed', data: { status: 'partially_failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'partially_failed',
      jobs: [{ operations: [{ errorMessage: 'codec exploded' }] }],
    });
    const result = await recipe(mock).compress().run({ maxWait: '30s' });

    expect(result.state).toBe('partially_failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBeNull();
    expect(result.failed[0].error).toBeInstanceOf(Error);
    expect((result.failed[0].error as Error).message).toBe('partially_failed: codec exploded');
  });
});

describe('Recipe.run — empty downloads', () => {
  it('a completed workflow with no download files yields zero artifacts but ok=true', async () => {
    const mock = makeMockClient();
    mock.getWorkflowDownloads.mockResolvedValueOnce({ downloads: [] });
    const result = await recipe(mock).compress().run({ maxWait: '30s' });

    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual([]);
    // Zero outputs → url sugar undefined.
    expect(result.url).toBeUndefined();
    // Keyless completed run → succeeded=[{key:null, outputs:[]}].
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].outputs).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

describe('Recipe.run — downloader bound', () => {
  it('binds a downloader so toFile() does NOT throw downloader_unavailable', async () => {
    const mock = makeMockClient();
    const result = await recipe(mock).compress().run({ maxWait: '30s' });
    // The bound HttpDownloader fetches via the global fetch stub (200 OK, body
    // '{}'). Proving the call does NOT throw downloader_unavailable proves the
    // run() bound a real downloader into the RunResult.
    await expect(result.toFile('/tmp/ff-run-bound.out')).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('https://signed.example.com/photo_compressed.jpg');
  });

  it('a RunResult with no downloader throws downloader_unavailable (control)', async () => {
    // Sanity: prove the downloader_unavailable path is reachable, so the
    // bound-downloader assertion above is meaningful.
    const r = new RunResult('wf', 'completed', [
      { url: 'https://x', filename: 'a', sizeBytes: 1, operation: 'compress' },
    ], [], []);
    await expect(r.toFile('/tmp/x')).rejects.toMatchObject({ reason: 'downloader_unavailable' });
  });
});

describe('Recipe.run — key threading', () => {
  it("threads file(path, 'hero') into the result so byKey('hero') resolves", async () => {
    const mock = makeMockClient();
    const result = await recipe(mock, fileInput.path('photo.jpg'), 'hero')
      .compress()
      .run({ maxWait: '30s' });

    expect(result.succeeded[0].key).toBe('hero');
    const item = result.byKey('hero');
    expect(item.key).toBe('hero');
    expect(item.outputs).toEqual(result.artifacts);
  });
});

// ---------------------------------------------------------------------------
// FF5b — Recipe.submit(): fire-and-forget upload + create, returning a
// client-bound Handle that carries the recipe key, WITHOUT waiting.
// ---------------------------------------------------------------------------

describe('Recipe.submit — fire-and-forget', () => {
  it('uploads + creates exactly once, does NOT wait, and returns a Handle with the workflowId + webhookSecret', async () => {
    const mock = makeMockClient();
    mock.createWorkflow.mockResolvedValueOnce({
      workflowId: 'wf_1',
      status: 'pending',
      webhookSecret: 'whsec_abc',
    });

    const handle = await recipe(mock).compress().submit();

    // upload + create fire exactly once each.
    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    // submit() MUST NOT wait — none of the terminal-await / download paths run.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).not.toHaveBeenCalled();
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();

    expect(handle).toBeInstanceOf(Handle);
    expect(handle.workflowId).toBe('wf_1');
    expect(handle.webhookSecret).toBe('whsec_abc');
  });

  it('wires webhook → createWorkflow payload callback_url when a webhook is given', async () => {
    const mock = makeMockClient();
    await recipe(mock).compress().submit('https://example.com/cb');

    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.callback_url).toBe('https://example.com/cb');
  });

  it('omits callback_url from the createWorkflow payload when no webhook is given', async () => {
    const mock = makeMockClient();
    await recipe(mock).compress().submit();

    const payload = mock.createWorkflow.mock.calls[0][0];
    // No webhook → the lowered payload carries no callback_url at all.
    expect(payload.callback_url).toBeUndefined();
    expect('callback_url' in payload).toBe(false);
  });

  it('uploadId arm makes NO upload call and references the id verbatim in the create payload source', async () => {
    const mock = makeMockClient();
    const handle = await recipe(mock, fileInput.uploadId('file_x'))
      .convert('webp')
      .submit();

    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].source).toEqual({ type: 'upload', file_id: 'file_x' });
    expect(handle.workflowId).toBe('wf_1');
  });

  it('throws GislConfigError(no_client) for a directly-constructed Recipe', async () => {
    const bare = new Recipe(fileInput.path('photo.jpg'));
    await expect(bare.compress().submit()).rejects.toBeInstanceOf(GislConfigError);
    await expect(bare.compress().submit()).rejects.toMatchObject({ reason: 'no_client' });
  });
});

describe('Recipe.submit — keyed Handle', () => {
  it("threads file(input, 'hero') so the submitted handle's result() is KEYED", async () => {
    const mock = makeMockClient();
    const handle = await recipe(mock, fileInput.path('photo.jpg'), 'hero')
      .compress()
      .submit();

    // Driving the handle's non-blocking result() (status terminal + downloads).
    const result = await handle.result();

    expect(result.succeeded[0].key).toBe('hero');
    const item = result.byKey('hero');
    expect(item.key).toBe('hero');
    expect(item.outputs).toEqual(result.artifacts);
  });

  it('contrast: a reattached handle (no key) yields a keyless result and byKey throws', async () => {
    const mock = makeMockClient();
    // Reattach surface: a Handle built with no recipe key (client.workflow(id)).
    const reattached = new Handle('wf_1', undefined, mock.client);
    const result = await reattached.result();

    expect(result.succeeded[0].key).toBeNull();
    expect(() => result.byKey('hero')).toThrow(GislNoSuchKeyError);
  });
});

describe('Recipe.submit — Handle.toJSON back-compat', () => {
  it('a keyed handle still serialises to exactly {workflowId, webhookSecret} — key NOT present', () => {
    // 4th arg (key) set — toJSON/toArray must NOT leak it, so the
    // operation-first/merge submit() back-compat shape can never drift.
    const keyed = new Handle('wf_1', 'whsec_abc', undefined, 'hero');
    expect(keyed.toJSON()).toEqual({ workflowId: 'wf_1', webhookSecret: 'whsec_abc' });
    expect(keyed.toArray()).toEqual({ workflowId: 'wf_1', webhookSecret: 'whsec_abc' });
    expect('key' in keyed.toJSON()).toBe(false);
  });

  it('a keyed handle with no webhookSecret serialises to exactly {workflowId}', () => {
    const keyed = new Handle('wf_1', undefined, undefined, 'hero');
    expect(keyed.toJSON()).toEqual({ workflowId: 'wf_1' });
    expect('key' in keyed.toJSON()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser-primary path: `gisl...file(blob).compress().run()` (NJNEoKLr).
// Proves the Blob input arm runs end-to-end WITHOUT the path-upload fs seam —
// uploadFile receives a Blob (not a path string), so node:fs is never reached.
// ---------------------------------------------------------------------------

describe('Recipe.run — Blob input arm (browser primary path)', () => {
  it('uploads a Blob (not a path string) and returns a RunResult', async () => {
    const mock = makeMockClient();
    const blob = new Blob(['fake-image-bytes'], { type: 'image/jpeg' });

    const result: RunResult = await recipe(mock, fileInput.blob(blob))
      .compress()
      .run({ maxWait: '30s' });

    // The upload went through the Blob source — uploadFile's first arg is the
    // Blob itself, NOT a path string (the path arm is the only fs consumer).
    expect(mock.uploadFile).toHaveBeenCalledOnce();
    const firstArg = mock.uploadFile.mock.calls[0][0];
    expect(firstArg).toBeInstanceOf(Blob);
    expect(typeof firstArg).not.toBe('string');

    expect(result.workflowId).toBe('wf_1');
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.url).toBe('https://signed.example.com/photo_compressed.jpg');
  });
});
