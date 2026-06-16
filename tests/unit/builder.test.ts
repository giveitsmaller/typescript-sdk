import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationBuilder, type Result, type ProgressEvent } from '../../src/builder.js';
import { GislTimeoutError } from '../../src/errors.js';
import { Handle } from '../../src/handle.js';
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
  maybeWaitForVideoProbe: ReturnType<typeof vi.fn>;
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
  // YOA6FpFr PR2 — no-op gate stub (OperationBuilder.run/submit call it before create).
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
    // shape is plain data, present in stringify output, and (T4b) populated
    // by the preset resolver — no-optimize case: preset:null, quality lands
    // in sources.explicit (and the back-compat .overrides mirror).
    const mock = makeMockClient();
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {
      quality: 80,
    }).run({ maxWait: '30s' });
    const resolved = result.resolvedOptions;
    expect(typeof resolved).toBe('object');
    expect(resolved.preset).toBeNull();
    expect(resolved.applied).toEqual({ quality: 80 });
    // Back-compat (deprecated): `.overrides` mirrors `.sources.explicit`.
    expect(resolved.overrides).toEqual(['quality']);
    expect(resolved.presetVersion).toBe('1.0');
    // T4b — sources buckets populated by the resolver. Layer-3 (scoped)
    // stays empty until T4c lands `withPresetDefaults`.
    expect(resolved.sources).toEqual({
      sdkDefault: [],
      clientDefault: [],
      scopedDefault: [],
      callPresetOverride: [],
      explicit: ['quality'],
    });
    // No clientDefault / scopedDefault / callPresetOverride participated,
    // so presetConfigHash is absent.
    expect(resolved.presetConfigHash).toBeUndefined();
    const roundtrip = JSON.parse(JSON.stringify(result));
    expect(roundtrip.resolvedOptions).toEqual(resolved);
  });

  it('SSE rejecting (transport connect error) falls through to poll fallback cleanly', async () => {
    // Codex-reviewer P1: test the SSE → poll fall-through inside awaitTerminal.
    // A genuine connect transport failure surfaces as a fetch TypeError, which
    // the SDK wraps as GislNetworkError → poll fallback (TDqmkWpX: only transport
    // / clean stream-end fall back; other errors propagate).
    const mock = makeMockClient();
    mock.streamEvents.mockRejectedValueOnce(new TypeError('SSE connect refused'));
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

describe('T6 — .mapEach fan-out', () => {
  it('GislChainCardinalityMismatchError carries previousOperation + attemptedOperation fields', async () => {
    // T6 ships the error class for the FUTURE chain methods (.compress() etc.
    // on OperationBuilder result). The error itself is dormant — no chain
    // method throws it today — but the type + audit registration land here
    // so the future chain-method PR is a pure addition.
    const { GislChainCardinalityMismatchError } = await import('../../src/errors.js');
    const e = new GislChainCardinalityMismatchError('convert', 'compress');
    expect(e.previousOperation).toBe('convert');
    expect(e.attemptedOperation).toBe('compress');
    expect(e.message).toMatch(/multiple artifacts/);
    expect(e.message).toMatch(/mapEach/);
    expect(e.name).toBe('GislChainCardinalityMismatchError');
  });

  it('mapEach on a multi-output parent (3 artifacts) calls fn 3× and combines child artifacts', async () => {
    const mock = makeMockClient();
    let parentCallSeen = false;
    mock.getWorkflowDownloads.mockImplementation(async () => {
      if (!parentCallSeen) {
        parentCallSeen = true;
        return {
          downloads: [
            {
              jobId: 'job_parent',
              ref: 'op',
              files: [
                { operation: 'convert', operationId: 'opid_1', filename: 'page_1.png', sizeBytes: 100, downloadUrl: 'https://signed.example.com/page_1.png', pageIndex: 1 },
                { operation: 'convert', operationId: 'opid_2', filename: 'page_2.png', sizeBytes: 100, downloadUrl: 'https://signed.example.com/page_2.png', pageIndex: 2 },
                { operation: 'convert', operationId: 'opid_3', filename: 'page_3.png', sizeBytes: 100, downloadUrl: 'https://signed.example.com/page_3.png', pageIndex: 3 },
              ],
            },
          ],
        };
      }
      // Each child returns 1 artifact.
      return {
        downloads: [
          {
            jobId: `job_child`,
            ref: 'op',
            files: [
              { operation: 'compress', operationId: 'opid_c', filename: 'compressed.png', sizeBytes: 50, downloadUrl: 'https://signed.example.com/compressed.png' },
            ],
          },
        ],
      };
    });
    let fnCalls = 0;
    const result = await new OperationBuilder(mock.client, 'convert', 'doc.pdf', { to: 'png', pages: '1-3' })
      .mapEach((art) => {
        fnCalls += 1;
        expect(art.url).toMatch(/page_\d\.png/);
        return new OperationBuilder(mock.client, 'compress', 'noop', {});
      })
      .run({ maxWait: '60s' });
    expect(fnCalls).toBe(3);
    expect(result.artifacts).toHaveLength(3);
  });

  it('mapEach on a single-output parent calls fn exactly ONCE', async () => {
    const mock = makeMockClient();
    let fnCalls = 0;
    const result = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {})
      .mapEach(() => {
        fnCalls += 1;
        return new OperationBuilder(mock.client, 'thumbnail', 'noop', {});
      })
      .run({ maxWait: '30s' });
    expect(fnCalls).toBe(1);
    expect(result.artifacts).toHaveLength(1);
  });

  it('mapEach propagates GislTimeoutError when parent.run() exceeds maxWait', async () => {
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_1', status: 'running' });
    let fnCalls = 0;
    const pending = new OperationBuilder(mock.client, 'compress', 'p.jpg', {})
      .mapEach(() => {
        fnCalls += 1;
        return new OperationBuilder(mock.client, 'thumbnail', 'noop', {});
      })
      .run({ maxWait: 5, useSSE: false, pollIntervalMs: 100 });
    await expect(pending).rejects.toBeInstanceOf(GislTimeoutError);
    expect(fnCalls).toBe(0);
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

  // FF5a back-compat regression: submit() now returns a `Handle` CLASS, but its
  // toJSON()/toArray() shape must stay byte-identical to the prior plain-object
  // `{ workflowId, webhookSecret }` — no `client` leakage, no extra keys.
  it('returns a Handle whose toJSON/toArray is {workflowId, webhookSecret} byte-identical', async () => {
    const mock = makeMockClient();
    const handle = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(handle).toBeInstanceOf(Handle);
    expect(handle.toJSON()).toEqual({ workflowId: 'wf_1', webhookSecret: 'wh_secret_abc' });
    expect(handle.toArray()).toEqual({ workflowId: 'wf_1', webhookSecret: 'wh_secret_abc' });
    expect(Object.keys(handle.toJSON())).toEqual(['workflowId', 'webhookSecret']);
    // The bound client is NEVER serialised.
    expect('client' in handle.toJSON()).toBe(false);
    expect(JSON.parse(JSON.stringify(handle))).toEqual({
      workflowId: 'wf_1',
      webhookSecret: 'wh_secret_abc',
    });
  });

  it('returns a Handle that drops webhookSecret from toJSON when the server omits it', async () => {
    const mock = makeMockClient();
    mock.createWorkflow.mockResolvedValueOnce({
      workflowId: 'wf_no_secret',
      status: 'running',
      webhookSecret: null,
    });
    const handle = await new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(handle.toJSON()).toEqual({ workflowId: 'wf_no_secret' });
  });
});

// ---------------------------------------------------------------------------
// T4b — preset resolver fail-early + media detection + propagation
// ---------------------------------------------------------------------------

describe('T4b — OperationBuilder fail-early on GislConfigError (before any I/O)', () => {
  it('run() throws GislConfigError BEFORE client.uploadFile is called', async () => {
    const mock = makeMockClient();
    // mode=Lossless + quality is a post-merge missing_dependency.
    const builder = new OperationBuilder(mock.client, 'compress', 'p.jpg', {
      mode: 'lossless',
      quality: 90,
    });
    await expect(builder.run({ maxWait: '30s' })).rejects.toMatchObject({
      name: 'GislConfigError',
      reason: 'missing_dependency',
    });
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });

  it('submit() throws GislConfigError BEFORE client.uploadFile is called', async () => {
    const mock = makeMockClient();
    const builder = new OperationBuilder(mock.client, 'compress', 'p.jpg', {
      mode: 'lossless',
      quality: 90,
    });
    await expect(builder.submit({ webhook: 'https://x/cb' })).rejects.toMatchObject({
      name: 'GislConfigError',
      reason: 'missing_dependency',
    });
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });

  it('run() fail-early carries resolvedSnapshot so callers can debug pre-network', async () => {
    const mock = makeMockClient();
    const builder = new OperationBuilder(mock.client, 'compress', 'v.mp4', {
      codec: 'h265',
      targetSize: '50MB',
    });
    try {
      await builder.run({ maxWait: '30s' });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { name: string; reason?: string; resolvedSnapshot?: Record<string, unknown> };
      expect(e.name).toBe('GislConfigError');
      expect(e.reason).toBe('invalid_combination');
      expect(e.resolvedSnapshot).toBeDefined();
      expect(e.resolvedSnapshot?.codec).toBe('h265');
    }
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });
});

describe('T4b — _detectCompressMedia (input → media classification)', () => {
  // Import the internal helper directly.
  it('Blob with image MIME → image', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    const b = new Blob(['x'], { type: 'image/png' });
    expect(_detectCompressMedia(b)).toBe('image');
  });

  it('Blob with audio MIME → audio', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia(new Blob(['x'], { type: 'audio/mpeg' }))).toBe('audio');
  });

  it('Blob with video MIME → video', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia(new Blob(['x'], { type: 'video/mp4' }))).toBe('video');
  });

  it('application/pdf MIME → document_pdf', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia(new Blob(['x'], { type: 'application/pdf' }))).toBe('document_pdf');
  });

  it('application/epub+zip MIME → document_epub', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia(new Blob(['x'], { type: 'application/epub+zip' }))).toBe('document_epub');
  });

  it('docx MIME → document_office', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(_detectCompressMedia(new Blob(['x'], { type: docx }))).toBe('document_office');
  });

  it('odt MIME → document_odf', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia(new Blob(['x'], { type: 'application/vnd.oasis.opendocument.text' }))).toBe('document_odf');
  });

  it('filename extension fallback — .jpg → image', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('photo.jpg')).toBe('image');
    expect(_detectCompressMedia('PHOTO.JPEG')).toBe('image');
    expect(_detectCompressMedia('x.heic')).toBe('image');
  });

  it('filename extension fallback — .mp3 → audio', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('song.mp3')).toBe('audio');
    expect(_detectCompressMedia('clip.opus')).toBe('audio');
  });

  it('filename extension fallback — .mp4 → video', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('clip.mp4')).toBe('video');
    expect(_detectCompressMedia('CLIP.MOV')).toBe('video');
  });

  it('filename extension fallback — .pdf → document_pdf', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('paper.pdf')).toBe('document_pdf');
  });

  it('filename extension fallback — .docx → document_office', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('doc.docx')).toBe('document_office');
    expect(_detectCompressMedia('sheet.xlsx')).toBe('document_office');
  });

  it('unrecognised input → undefined (falls back to passthrough)', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    expect(_detectCompressMedia('mystery.zzz')).toBeUndefined();
    expect(_detectCompressMedia(new Blob(['x']))).toBeUndefined(); // no .type, no .name
  });

  it('blob.name overrides MIME-less Blob input', async () => {
    const { _detectCompressMedia } = await import('../../src/builder.js');
    // A File-shaped object — Blob with a name property
    const f = new Blob(['x']);
    Object.defineProperty(f, 'name', { value: 'photo.png' });
    expect(_detectCompressMedia(f)).toBe('image');
  });
});

describe('0Vcogefw — _detectAudioLossless (audio input → lossless classification)', () => {
  it.each(['song.flac', 'a.wav', 'PATH/X.FLAC', 'audio/clip.WAV'])(
    'filename %s → true (case-insensitive, flac/wav only)',
    async (input) => {
      const { _detectAudioLossless } = await import('../../src/builder.js');
      expect(_detectAudioLossless(input)).toBe(true);
    },
  );

  it.each([
    'song.mp3',
    'a.aac',
    'b.m4a',
    'c.ogg',
    'd.oga',
    'e.opus',
    'f.unknownext',
    'noextension',
  ])('lossy / unknown filename %s → false', async (input) => {
    const { _detectAudioLossless } = await import('../../src/builder.js');
    expect(_detectAudioLossless(input)).toBe(false);
  });

  it.each(['audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav', 'audio/wave'])(
    'Blob with lossless audio MIME %s → true',
    async (type) => {
      const { _detectAudioLossless } = await import('../../src/builder.js');
      expect(_detectAudioLossless(new Blob(['x'], { type }))).toBe(true);
    },
  );

  it('Blob with lossy audio MIME audio/mpeg → false', async () => {
    const { _detectAudioLossless } = await import('../../src/builder.js');
    expect(_detectAudioLossless(new Blob(['x'], { type: 'audio/mpeg' }))).toBe(false);
  });

  it('Blob with a parameterised lossless MIME (audio/flac; codecs=flac) → true', async () => {
    // MIME params must be stripped before the exact-set lookup — media is
    // already audio via the prefix check, so a miss would wrongly KEEP the
    // shipped bitrate on a lossless input (codex 18b6b684).
    const { _detectAudioLossless } = await import('../../src/builder.js');
    expect(_detectAudioLossless(new Blob(['x'], { type: 'audio/flac; codecs=flac' }))).toBe(true);
  });

  it('MIME-first only applies to audio/* — a non-audio MIME falls back to the extension', async () => {
    // Edge case: a Blob typed application/octet-stream but named x.flac is
    // NOT matched by the audio/* MIME branch, so it falls through to the
    // extension fallback → flac → TRUE. (Document this fall-through.)
    const { _detectAudioLossless } = await import('../../src/builder.js');
    const b = new Blob(['x'], { type: 'application/octet-stream' });
    Object.defineProperty(b, 'name', { value: 'x.flac' });
    expect(_detectAudioLossless(b)).toBe(true);
  });

  it('typeless / nameless Blob → false (no inferable signal)', async () => {
    const { _detectAudioLossless } = await import('../../src/builder.js');
    expect(_detectAudioLossless(new Blob(['x']))).toBe(false);
  });
});

describe('0Vcogefw — operation-first end-to-end audio bitrate drop (both call-sites)', () => {
  it('compress(optimize: Size) on a *.flac input lowers WITHOUT bitrate', async () => {
    const { OptimizeFor } = await import('../../src/generated/sdk_spec/enums.js');
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'track.flac', {
      optimize: OptimizeFor.Size,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    const options = payload.jobs[0].operations[0].options as Record<string, unknown>;
    expect('bitrate' in options).toBe(false);
    // The rest of the audio Size cell survives.
    expect(options.sample_rate).toBe(44100);
    expect(options.normalize).toBe(true);
  });

  it('compress(optimize: Size) on a *.mp3 input KEEPS bitrate 96', async () => {
    const { OptimizeFor } = await import('../../src/generated/sdk_spec/enums.js');
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'song.mp3', {
      optimize: OptimizeFor.Size,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    const options = payload.jobs[0].operations[0].options as Record<string, unknown>;
    expect(options.bitrate).toBe(96);
    expect(options.sample_rate).toBe(44100);
  });
});

describe('T4b — non-compress ops bypass the resolver (passthrough)', () => {
  it('opType="convert" wireOptions === opOptions verbatim (no preset resolution)', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'convert', 'p.jpg', {
      output_format: 'png',
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].operations[0].options).toEqual({ output_format: 'png' });
  });

  it('opType="thumbnail" passes opOptions through unchanged', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'thumbnail', 'p.jpg', {
      width: 200,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].operations[0].options).toEqual({ width: 200 });
  });

  it('compress op with unknown media (e.g. Blob without type/name) passes opOptions through verbatim', async () => {
    const mock = makeMockClient();
    const blob = new Blob(['x']); // no type, no name → _detectCompressMedia → undefined
    await new OperationBuilder(mock.client, 'compress', blob, {
      quality: 80,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    // Resolver bypassed — opOptions verbatim, no snake_case translation.
    expect(payload.jobs[0].operations[0].options).toEqual({ quality: 80 });
  });
});

describe('T4b — MapEachBuilder child inherits client presetDefaults via Proxy', () => {
  it("child builder constructed by user's fn(art) carries the SAME presetDefaults the parent ergonomic-client closes over", async () => {
    // Architect adjustment e1 — pins that the user-supplied fn(art)
    // calling `client.compress(art, ...)` routes through the wrapErgonomic
    // Proxy, which transparently passes the closed-over presetDefaults
    // into the new OperationBuilder for the child. We construct the
    // child builder via the actual gisl.create() Proxy path.
    process.env.GISL_API_KEY = 'k';
    const { create } = await import('../../src/gisl.js');
    const { presetDefaults } = await import('../../src/ergonomic/presets/index.js');
    const { OptimizeFor } = await import('../../src/generated/sdk_spec/enums.js');

    const defaults = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 88 });
    const client = await create({ apiKey: 'k', presetDefaults: defaults });

    // Capture the OperationBuilder produced by client.compress(art) to
    // assert the presetDefaults handle ends up on the resolver-side.
    const builder = client.compress('child.jpg', { optimize: OptimizeFor.Size });
    // The builder's presetDefaults is private — assert observable behaviour
    // instead by running it through a mock-injected client. Simplest path
    // here: spy on `_resolve()` outputs via the public Result chain.
    // We assert the builder TYPE — the Proxy returned a real OperationBuilder
    // with .run, and the run() output's resolvedOptions includes the
    // client-default delta.
    expect(builder).toBeDefined();
    expect(typeof builder.run).toBe('function');

    // Now drive a full run with the real ergonomic surface, mocking only
    // the network calls via a vi.spyOn on the underlying GislClient.
    const { GislClient } = await import('../../src/client.js');
    vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'image/jpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<GislClient['uploadFile']>>);
    vi.spyOn(GislClient.prototype, 'createWorkflow').mockResolvedValue({
      workflowId: 'wf_kid',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<GislClient['createWorkflow']>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowDownloads').mockResolvedValue({
      downloads: [{ jobId: 'j', ref: 'op', files: [] }],
    } as unknown as Awaited<ReturnType<GislClient['getWorkflowDownloads']>>);
    vi.spyOn(GislClient.prototype, 'getWorkflowStatus').mockResolvedValue({
      workflowId: 'wf_kid',
      status: 'completed',
      jobs: [{ jobId: 'j', ref: 'op', status: 'completed' }],
    } as unknown as Awaited<ReturnType<GislClient['getWorkflowStatus']>>);

    const result = await builder.run({ maxWait: '30s', useSSE: false });
    // clientDefault layer participated → presetConfigHash present.
    expect(result.resolvedOptions.presetConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // quality came from client default, NOT sdkDefault.
    expect(result.resolvedOptions.sources.clientDefault).toContain('quality');
    expect(result.resolvedOptions.applied.quality).toBe(88);

    vi.restoreAllMocks();
    delete process.env.GISL_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// TDqmkWpX — SSE await-terminal sealed-marker discipline + downloads deadline.
// ---------------------------------------------------------------------------

describe('OperationBuilder.run — TDqmkWpX await-terminal discipline', () => {
  it('propagates an onProgress callback throw during SSE (does NOT poll-fallback then succeed)', async () => {
    const mock = makeMockClient();
    // Stream a single progress event so onProgress fires, then a terminal —
    // but onProgress throws on the progress event, before any terminal.
    mock.streamEvents.mockImplementationOnce(async function* (_id: string, _opts: unknown) {
      yield {
        event: 'operation.progress',
        data: { job_ref: 'op', operation_id: 'opid_1', type: 'compress', status: 'encoding', progress: 10 },
      };
      yield { event: 'workflow.completed', data: { workflow_id: 'wf_1', status: 'completed' } };
    });
    // Throw a TypeError specifically — it must NOT be confused with a mid-stream
    // transport TypeError (which DOES poll-fallback). The callback error always
    // propagates verbatim.
    const onProgress = vi.fn(() => {
      throw new TypeError('onProgress boom');
    });
    await expect(
      new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({ maxWait: '30s', onProgress }),
    ).rejects.toThrow('onProgress boom');
    // The throw MUST NOT be masked by a poll fallback: _pollToTerminal probes
    // getWorkflowStatus, which must never be called here. Before TDqmkWpX the
    // throw was swallowed → poll → the run succeeded, hiding the user's bug.
    expect(mock.getWorkflowStatus).not.toHaveBeenCalled();
  });

  it('throws GislTimeoutError when getWorkflowDownloads completes after the maxWait deadline', async () => {
    const mock = makeMockClient();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // deadline = now (1_000_000) + 30s. The empty SSE stream falls through to a
    // poll that resolves terminal immediately at base time (< deadline). The
    // downloads fetch itself runs long — bump the clock PAST the deadline when
    // it is invoked, so the post-fetch re-check must time out rather than
    // returning a success after the advertised whole-run deadline.
    mock.getWorkflowDownloads.mockImplementationOnce(async (_id: string) => {
      now += 31_000;
      return { downloads: [] };
    });
    await expect(
      new OperationBuilder(mock.client, 'compress', 'p.jpg', {}).run({ maxWait: '30s' }),
    ).rejects.toBeInstanceOf(GislTimeoutError);
    expect(mock.getWorkflowDownloads).toHaveBeenCalledOnce();
  });
});
