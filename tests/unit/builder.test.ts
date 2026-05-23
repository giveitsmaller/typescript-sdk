import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationBuilder, type Result, type ProgressEvent } from '../../src/builder.js';
import { GislTimeoutError } from '../../src/errors.js';
import type { GislClient } from '../../src/client.js';

// ---------------------------------------------------------------------------
// Test doubles — vi.fn-replaced GislClient methods + a fetch stub for any
// unexpected escape (the builder MUST NOT touch fetch directly; it only
// calls through the client methods).
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;

interface MockClientHandles {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  client: GislClient;
}

function makeMockClient(): MockClientHandles {
  const uploadFile = vi.fn(async (_path: string) => ({
    fileId: 'file_1',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({
    workflowId: 'wf_1',
    status: 'running',
    webhookSecret: 'wh_secret_abc',
  }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    createdAt: '2026-05-23T09:00:00Z',
    updatedAt: '2026-05-23T09:05:00Z',
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
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
    // Empty generator — forces fall-through to poll in tests that want it.
    return;
    // eslint-disable-next-line no-unreachable
    yield;
  });
  const client = {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
  } as unknown as GislClient;
  return { uploadFile, createWorkflow, getWorkflowStatus, getWorkflowDownloads, streamEvents, client };
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('OperationBuilder.run', () => {
  it('orchestrates upload → create → status → downloads and projects to Result', async () => {
    const mock = makeMockClient();
    const builder = new OperationBuilder(mock.client, 'compress', 'photo.jpg', {});
    const result: Result = await builder.run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    expect(mock.getWorkflowDownloads).toHaveBeenCalledOnce();
    expect(result.workflowId).toBe('wf_1');
    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].url).toBe('https://signed.example.com/photo_compressed.jpg');
    expect(result.artifacts[0].filename).toBe('photo_compressed.jpg');
    expect(result.artifacts[0].operation).toBe('compress');
    expect(result.artifacts[0].jobId).toBe('job_1');
    expect(result.artifacts[0].ref).toBe('op');
  });

  it('sets .url sugar when artifacts.length === 1', async () => {
    const mock = makeMockClient();
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
    });
    expect(result.url).toBe('https://signed.example.com/photo_compressed.jpg');
  });

  it('omits .url sugar when artifacts.length is 0', async () => {
    const mock = makeMockClient();
    mock.getWorkflowDownloads.mockResolvedValueOnce({ downloads: [] });
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
    });
    expect(result.artifacts).toHaveLength(0);
    expect(result.url).toBeUndefined();
  });

  it('omits .url sugar when artifacts.length > 1 (multi-output)', async () => {
    const mock = makeMockClient();
    mock.getWorkflowDownloads.mockResolvedValueOnce({
      downloads: [
        {
          jobId: 'job_1',
          ref: 'op',
          files: [
            {
              operation: 'convert',
              operationId: 'opid_1',
              filename: 'page_1.png',
              sizeBytes: 100,
              downloadUrl: 'https://signed.example.com/page_1.png',
              pageIndex: 1,
            },
            {
              operation: 'convert',
              operationId: 'opid_1',
              filename: 'page_2.png',
              sizeBytes: 110,
              downloadUrl: 'https://signed.example.com/page_2.png',
              pageIndex: 2,
            },
          ],
        },
      ],
    });
    const result = await new OperationBuilder(mock.client, 'convert', 'doc.pdf', {
      to: 'png',
      pages: '1-2',
    }).run({ maxWait: '30s' });
    expect(result.artifacts).toHaveLength(2);
    expect(result.url).toBeUndefined();
    expect(result.artifacts[0].pageIndex).toBe(1);
    expect(result.artifacts[1].pageIndex).toBe(2);
  });

  it('passes the wire payload to createWorkflow with id="op" + single source job', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'photo.jpg', { quality: 80 }).run({
      maxWait: '30s',
    });
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].id).toBe('op');
    expect(payload.jobs[0].source.type).toBe('upload');
    expect(payload.jobs[0].operations[0].type).toBe('compress');
    expect(payload.jobs[0].operations[0].options).toEqual({ quality: 80 });
  });

  it('throws GislTimeoutError synchronously when maxWait is already in the past', async () => {
    const mock = makeMockClient();
    // Make poll always return non-terminal so the deadline test fires.
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'running',
    });
    const builder = new OperationBuilder(mock.client, 'compress', 'p.jpg', {});
    await expect(builder.run({ maxWait: 1, pollIntervalMs: 5 })).rejects.toBeInstanceOf(
      GislTimeoutError,
    );
  });

  it('rejects an invalid maxWait string format with a TypeError', async () => {
    const mock = makeMockClient();
    const builder = new OperationBuilder(mock.client, 'compress', 'p.jpg', {});
    await expect(builder.run({ maxWait: 'forever' })).rejects.toBeInstanceOf(TypeError);
  });

  it('parses maxWait suffixes (ms / s / m / h)', async () => {
    // All four units exercised through happy-path completion.
    const mock = makeMockClient();
    for (const unit of ['500ms', '30s', '5m', '1h']) {
      await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({ maxWait: unit });
    }
    // No assertion needed — non-throw is the test.
  });

  it('emits {phase: "upload"} progress events from UploadOptions.onProgress (SDK-synthesised)', async () => {
    const mock = makeMockClient();
    // Have the uploadFile mock invoke its caller's onProgress callback to
    // simulate the multipart byte counter.
    mock.uploadFile.mockImplementationOnce(async (_path: string, opts: { onProgress?: (u: number, t: number) => void }) => {
      opts?.onProgress?.(100, 1000);
      opts?.onProgress?.(1000, 1000);
      return { fileId: 'file_1', contentType: 'image/jpeg', sizeBytes: 1000 };
    });
    const events: ProgressEvent[] = [];
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
      onProgress: (e) => events.push(e),
    });
    const uploadEvents = events.filter((e) => e.phase === 'upload');
    expect(uploadEvents).toHaveLength(2);
    expect(uploadEvents[0]).toMatchObject({ phase: 'upload', uploadedBytes: 100, totalBytes: 1000 });
    expect(uploadEvents[1]).toMatchObject({ phase: 'upload', uploadedBytes: 1000, totalBytes: 1000 });
  });

  it('does NOT call fetch directly (orchestration goes through GislClient methods only)', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({ maxWait: '30s' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useSSE=false skips streamEvents entirely and uses the poll path', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
      useSSE: false,
    });
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
  });

  it('aborts the run when signal fires before completion', async () => {
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_1', status: 'running' });
    const controller = new AbortController();
    const builder = new OperationBuilder(mock.client, 'compress', 'p.jpg', {});
    const pending = builder.run({
      maxWait: '30s',
      useSSE: false,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/Aborted/);
  });

  it('resolvedOptions is a data property (not method) so JSON.stringify round-trips', async () => {
    // Codex-reviewer P1: methods silently drop on JSON.stringify. Verify the
    // shape is plain data, present in stringify output, and matches the T2
    // placeholder contract (preset:null, presetVersion:1.0).
    const mock = makeMockClient();
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {
      quality: 80,
    }).run({ maxWait: '30s' });
    const resolved = result.resolvedOptions;
    expect(typeof resolved).toBe('object');
    expect(resolved.preset).toBeNull();
    expect(resolved.applied).toEqual({ quality: 80 });
    expect(resolved.overrides).toEqual([]);
    expect(resolved.presetVersion).toBe('1.0');
    const roundtrip = JSON.parse(JSON.stringify(result));
    expect(roundtrip.resolvedOptions).toEqual(resolved);
  });

  it('SSE rejecting (e.g. connect error) falls through to poll fallback cleanly', async () => {
    // Codex-reviewer P1: test the SSE → poll fall-through that lives in
    // the bare `catch` inside awaitTerminal. Without this, a contract
    // mistake (catching too much / too little) goes uncaught.
    const mock = makeMockClient();
    mock.streamEvents.mockRejectedValueOnce(new Error('SSE connect refused'));
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
    });
    expect(result.status).toBe('completed');
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
  });

  it('caller-aborted run during SSE propagates AbortError (no swallow into poll path)', async () => {
    // Codex-reviewer P0: the SSE-catch must re-throw AbortError. If the
    // catch silently fell through to poll, the abort would be silently
    // honoured later by `checkAborted` — but the timing window is open
    // for the poll to succeed before the abort registers.
    const mock = makeMockClient();
    // Make SSE block indefinitely so we can abort during the stream.
    mock.streamEvents.mockImplementationOnce(async function* (
      _id: string,
      opts: { signal?: AbortSignal },
    ) {
      await new Promise<void>((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
        // Never resolve; only reject on abort.
      });
      return;
      // eslint-disable-next-line no-unreachable
      yield;
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const pending = new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
      signal: controller.signal,
    });
    await expect(pending).rejects.toThrow(/Aborted/);
    // The poll path MUST NOT have been entered after the abort.
    expect(mock.getWorkflowStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('codex R1 regression guards', () => {
  it('deserialises SSE operation_progress data from snake_case to camelCase (d6485d3e35f9)', async () => {
    // Previously: data was cast directly to SseOperationProgressData and
    // read as camelCase, but streamEvents yields raw snake_case wire data
    // → data.jobRef / data.operationId were undefined at runtime.
    const mock = makeMockClient();
    mock.streamEvents.mockImplementationOnce(async function* (_id: string, _opts: unknown) {
      yield {
        event: 'operation.progress',
        data: {
          job_ref: 'op',
          operation_id: 'opid_xyz',
          type: 'compress',
          status: 'encoding',
          progress: 42,
          stage: 'two-pass second pass',
        },
      };
      yield {
        event: 'workflow.completed',
        data: { workflow_id: 'wf_1', status: 'completed' },
      };
    });
    const events: ProgressEvent[] = [];
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
      onProgress: (e) => events.push(e),
    });
    const procEvents = events.filter((e) => e.phase === 'processing');
    expect(procEvents).toHaveLength(1);
    const ev = procEvents[0] as Extract<ProgressEvent, { phase: 'processing' }>;
    expect(ev.jobRef).toBe('op');
    expect(ev.operationId).toBe('opid_xyz');
    expect(ev.progress).toBe(42);
    expect(ev.status).toBe('encoding');
    expect(ev.stage).toBe('two-pass second pass');
  });

  it('SSE deadline timer fires GislTimeoutError on a quiet but still-open stream (06f8dceefd76)', async () => {
    // Without the deadline timer arming sseAbort, a quiet stream that never
    // emits and never closes would hang past maxWait. Test: SSE returns a
    // generator that suspends indefinitely on its first yield.
    const mock = makeMockClient();
    mock.streamEvents.mockImplementationOnce(async function* (
      _id: string,
      opts: { signal?: AbortSignal },
    ) {
      // Block forever; only release on abort.
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
      return;
      // eslint-disable-next-line no-unreachable
      yield;
    });
    const pending = new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: 50, // 50ms — the deadline timer must fire
      useSSE: true,
    });
    await expect(pending).rejects.toBeInstanceOf(GislTimeoutError);
  });

  it('JobBreakdown surfaces errorCode/errorMessage on operations[] (5d098e0f135e)', async () => {
    // Previously the projection read errorCode/errorMessage from the JOB
    // level — but the wire shape puts them on operations[].
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValueOnce({
      workflowId: 'wf_1',
      status: 'partially_failed',
      jobs: [
        {
          jobId: 'job_1',
          ref: 'op',
          status: 'failed',
          operations: [
            {
              id: 'op_1',
              type: 'compress',
              status: 'failed',
              errorCode: 'INPUT_CORRUPT',
              errorMessage: 'File is not a valid JPEG',
            },
          ],
        },
      ],
    });
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].operations).toHaveLength(1);
    expect(result.jobs[0].operations[0].errorCode).toBe('INPUT_CORRUPT');
    expect(result.jobs[0].operations[0].errorMessage).toBe('File is not a valid JPEG');
  });

  it('clamps non-finite/negative/tiny pollIntervalMs to a safe minimum (89130e3ea75d)', async () => {
    // 0, -1, NaN, Infinity all clamp to 100ms — the test just verifies the
    // run completes without hammering (i.e. doesn't throw a busy-loop error).
    const mock = makeMockClient();
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
        maxWait: '30s',
        useSSE: false,
        pollIntervalMs: bad,
      });
    }
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
  });

  it('SSE progress maps phase_input_index / phase_total_inputs (codex r2 ed873d706d96)', async () => {
    // Previously: looked for `inputIndex` only; the generated FromJSON
    // emits `phaseInputIndex` + `phaseTotalInputs` — multi-input progress
    // was silently dropped.
    const mock = makeMockClient();
    mock.streamEvents.mockImplementationOnce(async function* (_id: string, _opts: unknown) {
      yield {
        event: 'operation.progress',
        data: {
          job_ref: 'op',
          operation_id: 'opid_z',
          type: 'merge',
          status: 'probing',
          progress: 25,
          phase_input_index: 2,
          phase_total_inputs: 4,
        },
      };
      yield { event: 'workflow.completed', data: {} };
    });
    const events: ProgressEvent[] = [];
    await new OperationBuilder(mock.client, 'merge', 'a.mp4', {}).run({
      maxWait: '30s',
      onProgress: (e) => events.push(e),
    });
    const procEvents = events.filter((e) => e.phase === 'processing');
    const ev = procEvents[0] as Extract<ProgressEvent, { phase: 'processing' }>;
    expect(ev.phaseInputIndex).toBe(2);
    expect(ev.phaseTotalInputs).toBe(4);
  });

  it('preserves ISO-8601 timestamps when status fields are Date objects (codex r2 3d229f9bc1fb)', async () => {
    // Generated FromJSON emits Date for createdAt/updatedAt; the previous
    // `String(date)` cast lost the wire shape.
    const mock = makeMockClient();
    const createdAt = new Date('2026-05-23T09:00:00.000Z');
    const updatedAt = new Date('2026-05-23T09:05:30.250Z');
    mock.getWorkflowStatus.mockResolvedValueOnce({
      workflowId: 'wf_1',
      status: 'completed',
      createdAt,
      updatedAt,
      jobs: [],
    });
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: '30s',
    });
    expect(result.createdAt).toBe('2026-05-23T09:00:00.000Z');
    expect(result.updatedAt).toBe('2026-05-23T09:05:30.250Z');
  });

  it('throws GislTimeoutError BEFORE createWorkflow if maxWait expired during upload (codex r2 9a117f04eb59)', async () => {
    const mock = makeMockClient();
    // Make uploadFile take 50ms, set maxWait to 20ms — the post-upload
    // deadline check should fire before createWorkflow is called.
    mock.uploadFile.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { fileId: 'file_1', contentType: 'image/jpeg', sizeBytes: 100 };
    });
    const pending = new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({
      maxWait: 20,
    });
    await expect(pending).rejects.toBeInstanceOf(GislTimeoutError);
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });

  it('Blob input type-checks through the ergonomic factory (89cae59f4f04)', async () => {
    // Compile-test: previously the factory only accepted `string`, so
    // valid Blob/File uploads (supported by the low-level uploadFile)
    // were rejected at the type level.
    const mock = makeMockClient();
    const blob = new Blob(['hello'], { type: 'text/plain' });
    await new OperationBuilder(mock.client, 'compress', blob, {}).run({ maxWait: '30s' });
    expect(mock.uploadFile).toHaveBeenCalled();
  });
});

describe('ergonomic-client Proxy interaction (T2 + T1 layering)', () => {
  it('the ErgonomicClient returned from gisl.create() is still instanceof GislClient', async () => {
    // Codex-reviewer P1: the Proxy must preserve instanceof so downstream
    // code that already type-checks against GislClient keeps working.
    const { GislClient } = await import('../../src/client.js');
    const { create } = await import('../../src/gisl.js');
    process.env.GISL_API_KEY = 'k';
    const client = await create();
    expect(client).toBeInstanceOf(GislClient);
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------

describe('OperationBuilder.submit', () => {
  it('wires the webhook to WorkflowCreateRequest.callback_url + returns Handle', async () => {
    const mock = makeMockClient();
    const handle = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(handle.workflowId).toBe('wf_1');
    expect(handle.webhookSecret).toBe('wh_secret_abc');
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.callback_url).toBe('https://my.app/cb');
  });

  it('does NOT call streamEvents / getWorkflowStatus / getWorkflowDownloads (fire-and-forget)', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).not.toHaveBeenCalled();
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
  });

  it('omits webhookSecret on Handle when the server does not return one', async () => {
    const mock = makeMockClient();
    mock.createWorkflow.mockResolvedValueOnce({
      workflowId: 'wf_no_secret',
      status: 'running',
      webhookSecret: null,
    });
    const handle = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(handle.workflowId).toBe('wf_no_secret');
    expect(handle.webhookSecret).toBeUndefined();
  });

  it('does NOT call fetch directly (orchestration through GislClient methods only)', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
