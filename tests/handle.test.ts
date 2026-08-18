import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Handle, StatusSnapshot } from '../src/handle.js';
import { RunResult } from '../src/file-first.js';
import {
  GislConfigError,
  GislItemFailedError,
  GislResultNotReadyError,
  GislStreamHostNotDeclaredError,
} from '../src/errors.js';
import type { GislClient } from '../src/client.js';

/**
 * FF5a — `Handle` + `StatusSnapshot` value objects + the `client.workflow(id)`
 * reattach surface. Network-free: every call goes through the `GislClient`
 * methods, replaced with `vi.fn` doubles (mirrors `file-first-run.test.ts`).
 * Mirrors the PHP `HandleTest`.
 */

let fetchSpy: ReturnType<typeof vi.fn>;

interface MockClientHandles {
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  client: GislClient;
}

function makeMockClient(): MockClientHandles {
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
  // Default: SSE yields a terminal completion (happy path for wait()).
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
  });
  const client = {
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
  } as unknown as GislClient;
  return { getWorkflowStatus, getWorkflowDownloads, streamEvents, client };
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// StatusSnapshot — pure value object
// ---------------------------------------------------------------------------

describe('StatusSnapshot', () => {
  it('exposes the raw wire state verbatim', () => {
    const snap = new StatusSnapshot('wf_1', 'in_progress');
    expect(snap.workflowId).toBe('wf_1');
    expect(snap.state).toBe('in_progress');
  });

  it.each([
    ['completed', true],
    ['failed', true],
    ['partially_failed', true],
    ['cancelled', true],
    ['expired', true],
    ['paused_insufficient_credits', true],
    ['pending', false],
    ['in_progress', false],
  ])('isTerminal(%s) === %s', (state, expected) => {
    expect(new StatusSnapshot('wf_1', state).isTerminal()).toBe(expected);
  });

  it('toJSON carries ONLY {workflowId, state} — no phase field exists', () => {
    const json = new StatusSnapshot('wf_1', 'completed').toJSON();
    expect(json).toEqual({ workflowId: 'wf_1', state: 'completed' });
    expect(Object.keys(json).sort()).toEqual(['state', 'workflowId']);
    expect('phase' in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

describe('Handle.status', () => {
  it('calls getWorkflowStatus once and projects the RAW wire state into a snapshot', async () => {
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValueOnce({ workflowId: 'wf_1', status: 'in_progress' });
    const handle = new Handle('wf_1', undefined, mock.client);
    const snap = await handle.status();

    expect(snap).toBeInstanceOf(StatusSnapshot);
    expect(mock.getWorkflowStatus).toHaveBeenCalledOnce();
    expect(mock.getWorkflowStatus).toHaveBeenCalledWith('wf_1');
    // RAW wire value verbatim, NOT remapped.
    expect(snap.state).toBe('in_progress');
    expect(snap.isTerminal()).toBe(false);
    // status() must NOT poll/SSE/download.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
  });

  it('reports a terminal snapshot when the wire state is completed', async () => {
    const mock = makeMockClient();
    const snap = await new Handle('wf_1', undefined, mock.client).status();
    expect(snap.state).toBe('completed');
    expect(snap.isTerminal()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wait()
// ---------------------------------------------------------------------------

describe('Handle.wait', () => {
  it('awaits SSE terminal → status → downloads → KEYLESS RunResult', async () => {
    const mock = makeMockClient();
    const result = await new Handle('wf_1', undefined, mock.client).wait('30s');

    expect(result).toBeInstanceOf(RunResult);
    expect(mock.streamEvents).toHaveBeenCalledOnce();
    expect(mock.getWorkflowDownloads).toHaveBeenCalledOnce();
    expect(result.workflowId).toBe('wf_1');
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.url).toBe('https://signed.example.com/photo_compressed.jpg');
    // A reattached handle carries NO recipe key → keyless RunResult.
    expect(result.succeeded[0].key).toBeNull();
    expect(() => result.byKey('anything')).toThrow();
  });

  it('falls back to polling when SSE ends without a terminal event', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'operation.progress', data: { progress: 50 } };
      // ends without workflow.completed → SSE helper throws → poll fallback
    });
    const result = await new Handle('wf_1', undefined, mock.client).wait('30s');
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(1);
  });

  it('falls back to polling when no stream host is declared (VUozk5Bc)', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockRejectedValue(
      new GislStreamHostNotDeclaredError('No SSE stream host is declared for this configuration'),
    );

    const result = await new Handle('wf_1', undefined, mock.client).wait('30s');

    // A `wait()`/`run()` caller asked for a RESULT, not for a transport. With
    // no declared stream host (today: any prod configuration) SSE is simply
    // unavailable, and polling is a working path — so the caller gets their
    // result rather than a hard failure about a host that does not exist yet.
    // A DIRECT `streamEvents()` caller still gets the error; see
    // `tests/unit/stream-host.test.ts`.
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
  });

  it('still propagates unrelated config errors instead of masking them with a poll', async () => {
    const mock = makeMockClient();
    // Negative control for the assertion above. The fallback is scoped to ONE
    // error type; widening it to `GislConfigError` would swallow real
    // misconfiguration and re-issue the same doomed request as a poll.
    mock.streamEvents.mockRejectedValue(new GislConfigError('some other configuration fault'));

    await expect(new Handle('wf_1', undefined, mock.client).wait('30s')).rejects.toThrow(
      GislConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// result() — NON-blocking
// ---------------------------------------------------------------------------

describe('Handle.result', () => {
  it('fetches downloads for a terminal workflow and does NOT poll/SSE', async () => {
    const mock = makeMockClient();
    const result = await new Handle('wf_1', undefined, mock.client).result();

    expect(result).toBeInstanceOf(RunResult);
    expect(mock.getWorkflowStatus).toHaveBeenCalledOnce();
    expect(mock.getWorkflowDownloads).toHaveBeenCalledOnce();
    // result() is NON-blocking — never opens an SSE stream.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    // Keyless.
    expect(result.succeeded[0].key).toBeNull();
    expect(() => result.byKey('hero')).toThrow();
  });

  it('a reattached failed terminal funnels through projectDownloadsToRunResult into the typed error', async () => {
    // A reattached Handle (no recipe key) on a single-input failed workflow goes
    // through projectDownloadsToRunResult — the SAME path the producers use — so
    // result.failed[0].error is the typed GislItemFailedError with state + fields.
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'failed',
      jobs: [{ jobId: 'job_1', ref: 'op', status: 'failed', operations: [{ errorMessage: 'boom', errorCode: 'bad_codec' }] }],
    });
    const result = await new Handle('wf_1', undefined, mock.client).result();

    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    const err = result.failed[0].error;
    expect(err).toBeInstanceOf(GislItemFailedError);
    expect(err.key).toBeNull();
    expect(err.state).toBe('failed');
    expect(err.errorMessage).toBe('boom');
    expect(err.errorCode).toBe('bad_codec');
    expect(err.message).toBe('failed: boom');
  });

  it.each(['pending', 'in_progress'])(
    'throws GislResultNotReadyError for a non-terminal (%s) workflow without downloading',
    async (state) => {
      const mock = makeMockClient();
      // Persistent (not ...Once): result() is asserted twice below, so both
      // calls must see the non-terminal status — a one-shot mock would let the
      // second call fall back to the default 'completed' and resolve.
      mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_1', status: state });
      const handle = new Handle('wf_1', undefined, mock.client);

      await expect(handle.result()).rejects.toBeInstanceOf(GislResultNotReadyError);
      // The thrown error carries the workflowId + the non-terminal state.
      await expect(handle.result()).rejects.toMatchObject({ workflowId: 'wf_1', state });
      // No downloads + no SSE/poll happened on a not-ready workflow.
      expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
      expect(mock.streamEvents).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// no_client guard
// ---------------------------------------------------------------------------

describe('Handle — no-client guard (submit() path)', () => {
  it.each([
    ['status', (h: Handle) => h.status()],
    ['wait', (h: Handle) => h.wait('30s')],
    ['result', (h: Handle) => h.result()],
  ])('%s() throws GislConfigError(no_client) on a clientless handle', async (_name, call) => {
    const handle = new Handle('wf_1', 'wh_secret');
    await expect(call(handle)).rejects.toBeInstanceOf(GislConfigError);
    await expect(call(handle)).rejects.toMatchObject({ reason: 'no_client' });
  });
});

// ---------------------------------------------------------------------------
// toJSON / toArray back-compat shape
// ---------------------------------------------------------------------------

describe('Handle.toJSON / toArray — back-compat shape', () => {
  it('omits webhookSecret when absent and never leaks the client', () => {
    const handle = new Handle('wf_1', undefined, makeMockClient().client);
    expect(handle.toJSON()).toEqual({ workflowId: 'wf_1' });
    expect(handle.toArray()).toEqual({ workflowId: 'wf_1' });
    expect('client' in handle.toJSON()).toBe(false);
  });

  it('includes webhookSecret when present, in {workflowId, webhookSecret} order', () => {
    const handle = new Handle('wf_1', 'wh_secret');
    expect(handle.toJSON()).toEqual({ workflowId: 'wf_1', webhookSecret: 'wh_secret' });
    expect(Object.keys(handle.toJSON())).toEqual(['workflowId', 'webhookSecret']);
    // toArray is a byte-identical alias of toJSON.
    expect(handle.toArray()).toEqual(handle.toJSON());
  });

  it('JSON.stringify of a clientless handle is byte-identical regardless of the bound client', () => {
    const bare = new Handle('wf_1', 'wh_secret');
    const bound = new Handle('wf_1', 'wh_secret', makeMockClient().client);
    expect(JSON.stringify(bound)).toBe(JSON.stringify(bare));
  });
});

// ---------------------------------------------------------------------------
// client.workflow(id) reattach
// ---------------------------------------------------------------------------

describe('client.workflow(id) reattach', () => {
  async function makeBoundClient(mock: MockClientHandles) {
    const { create } = await import('../src/gisl.js');
    process.env.GISL_API_KEY = 'k';
    const ergo = await create();
    delete process.env.GISL_API_KEY;
    // Splice the mocked transport methods onto the real client so workflow(id)
    // binds it without opening any socket.
    (ergo as unknown as Record<string, unknown>).getWorkflowStatus = mock.getWorkflowStatus;
    (ergo as unknown as Record<string, unknown>).getWorkflowDownloads = mock.getWorkflowDownloads;
    (ergo as unknown as Record<string, unknown>).streamEvents = mock.streamEvents;
    return ergo;
  }

  it('returns a client-bound Handle with the id, no webhookSecret', async () => {
    const mock = makeMockClient();
    const ergo = await makeBoundClient(mock);
    const handle = ergo.workflow('wf_reattach');

    expect(handle).toBeInstanceOf(Handle);
    expect(handle.workflowId).toBe('wf_reattach');
    expect(handle.webhookSecret).toBeUndefined();
    expect(handle.toJSON()).toEqual({ workflowId: 'wf_reattach' });
  });

  it('its result() drives a terminal status+downloads through the bound client into a KEYLESS RunResult', async () => {
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_reattach', status: 'completed' });
    const ergo = await makeBoundClient(mock);

    const result = await ergo.workflow('wf_reattach').result();
    expect(mock.getWorkflowStatus).toHaveBeenCalledWith('wf_reattach');
    expect(mock.getWorkflowDownloads).toHaveBeenCalledWith('wf_reattach');
    expect(result.state).toBe('completed');
    expect(result.succeeded[0].key).toBeNull();
    expect(() => result.byKey('x')).toThrow();
  });

  it('its wait() drives SSE terminal+downloads into a KEYLESS RunResult', async () => {
    const mock = makeMockClient();
    const ergo = await makeBoundClient(mock);

    const result = await ergo.workflow('wf_reattach').wait('30s');
    expect(mock.streamEvents).toHaveBeenCalled();
    expect(mock.getWorkflowDownloads).toHaveBeenCalledWith('wf_reattach');
    expect(result.state).toBe('completed');
    expect(result.succeeded[0].key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projectDownloadsToRunResult — partition invariant
// ---------------------------------------------------------------------------

describe('projectDownloadsToRunResult — partition invariant', () => {
  it('partitions a completed terminal into succeeded only', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult(
      'wf_1',
      { status: 'completed' } as never,
      [
        {
          files: [
            {
              operation: 'compress',
              filename: 'a.jpg',
              sizeBytes: 10,
              downloadUrl: 'https://x/a.jpg',
            } as never,
          ],
        },
      ],
      null,
    );
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].key).toBeNull();
    expect(result.artifacts).toHaveLength(1);
  });

  it.each(['failed', 'partially_failed', 'cancelled', 'expired', 'paused_insufficient_credits'])(
    'partitions a non-completed terminal (%s) into failed only with ok=false',
    async (state) => {
      const { projectDownloadsToRunResult } = await import('../src/file-first.js');
      const result = projectDownloadsToRunResult('wf_1', { status: state } as never, [], null);
      expect(result.ok).toBe(false);
      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].key).toBeNull();
      // Now a typed GislItemFailedError; with no failing op (no jobs[]) the human
      // + machine fields are BOTH absent — only the bare state is carried.
      expect(result.failed[0].error).toBeInstanceOf(GislItemFailedError);
      expect(result.failed[0].error.state).toBe(state);
      expect(result.failed[0].error.errorMessage).toBeUndefined();
      expect(result.failed[0].error.errorCode).toBeUndefined();
      expect(result.failed[0].error.message).toBe(state);
    },
  );

  it('reads BOTH error_code + error_message off the first failing op (single-input)', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult(
      'wf_1',
      {
        status: 'failed',
        jobs: [
          { operations: [{ errorMessage: 'output not smaller', errorCode: 'output_too_large' }] },
        ],
      } as never,
      [],
      'hero',
    );
    const err = result.failed[0].error;
    expect(err).toBeInstanceOf(GislItemFailedError);
    expect(err.key).toBe('hero');
    expect(err.state).toBe('failed');
    expect(err.errorMessage).toBe('output not smaller');
    expect(err.errorCode).toBe('output_too_large');
    expect(err.message).toBe('failed: output not smaller');
    // toJSON projects all five keys in order.
    expect(result.toJSON().failed[0]).toEqual({
      key: 'hero',
      error: 'failed: output not smaller',
      state: 'failed',
      errorMessage: 'output not smaller',
      errorCode: 'output_too_large',
    });
  });

  it('expired/cancelled with NO failing op → toJSON OMITS errorMessage + errorCode', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult('wf_1', { status: 'expired' } as never, [], null);
    const err = result.failed[0].error;
    expect(err.state).toBe('expired');
    expect(err.errorMessage).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
    const entry = result.toJSON().failed[0];
    // error === the bare state string (no trailing colon); the two optional keys
    // are OMITTED entirely (parity with PHP's omit-when-null, never `=> null`).
    expect(entry).toEqual({ key: null, error: 'expired', state: 'expired' });
    expect(Object.keys(entry)).toEqual(['key', 'error', 'state']);
    expect('errorMessage' in entry).toBe(false);
    expect('errorCode' in entry).toBe(false);
  });

  it('formats the failure message as `{state}: {firstOpErrorMessage}` (server reason preserved)', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult(
      'wf_1',
      { status: 'failed', jobs: [{ operations: [{ errorMessage: 'boom' }] }] } as never,
      [],
      null,
    );
    // The server-provided reason must survive + carry the state prefix — a
    // regression that drops or mis-formats it would otherwise pass.
    expect(result.failed[0].error).toBeInstanceOf(GislItemFailedError);
    expect(result.failed[0].error.message).toBe('failed: boom');
    expect(result.failed[0].error.errorMessage).toBe('boom');
  });

  it('falls back to the bare state when no op carries an errorMessage', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult(
      'wf_1',
      { status: 'failed', jobs: [{ operations: [{}] }] } as never,
      [],
      null,
    );
    expect(result.failed[0].error).toBeInstanceOf(GislItemFailedError);
    expect(result.failed[0].error.message).toBe('failed');
    // No op carried either field → both undefined (bare state, no colon).
    expect(result.failed[0].error.errorMessage).toBeUndefined();
    expect(result.failed[0].error.errorCode).toBeUndefined();
  });

  it('still flattens file-bearing downloads into artifacts on a non-completed terminal', async () => {
    const { projectDownloadsToRunResult } = await import('../src/file-first.js');
    const result = projectDownloadsToRunResult(
      'wf_1',
      { status: 'partially_failed', jobs: [{ operations: [{ errorMessage: 'half' }] }] } as never,
      [
        {
          files: [
            { operation: 'compress', filename: 'a.jpg', sizeBytes: 10, downloadUrl: 'https://x/a.jpg' } as never,
          ],
        },
      ],
      null,
    );
    // Downloads still flatten into artifacts even though the run is a failure;
    // the partition (succeeded=[]/failed=[…]) is independent of artifact presence.
    expect(result.ok).toBe(false);
    expect(result.artifacts).toHaveLength(1);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// uUnCtVAr (FF3a-submit) — data-driven per-job partitioning for a files()
// fan-out. The producer choice is made off the wire (`file-{i}` job refs),
// NOT a construction-time marker, so a REATTACHED fan-out handle
// (client.workflow(id), no key) still partitions per job.
// ---------------------------------------------------------------------------

function makeFanoutMockClient(): MockClientHandles {
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_fan',
    status: 'completed',
    jobs: [
      { jobId: 'job_0', ref: 'file-0', status: 'completed' },
      { jobId: 'job_1', ref: 'file-1', status: 'completed' },
    ],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      {
        jobId: 'job_0',
        ref: 'file-0',
        files: [
          {
            operation: 'compress',
            operationId: 'opid_0',
            filename: 'a_compressed.jpg',
            sizeBytes: 100,
            downloadUrl: 'https://signed.example.com/a.jpg',
          },
        ],
      },
      {
        jobId: 'job_1',
        ref: 'file-1',
        files: [
          {
            operation: 'compress',
            operationId: 'opid_1',
            filename: 'b_compressed.jpg',
            sizeBytes: 200,
            downloadUrl: 'https://signed.example.com/b.jpg',
          },
        ],
      },
    ],
  }));
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
  });
  const client = { getWorkflowStatus, getWorkflowDownloads, streamEvents } as unknown as GislClient;
  return { getWorkflowStatus, getWorkflowDownloads, streamEvents, client };
}

describe('Handle data-driven fan-out partitioning', () => {
  it('wait() on a fan-out (file-N refs) partitions PER JOB with index keys, even reattached/keyless', async () => {
    const mock = makeFanoutMockClient();
    // No key (reattach via client.workflow(id)) — keys MUST still come from refs.
    const result = await new Handle('wf_fan', undefined, mock.client).wait('30s');

    expect(result).toBeInstanceOf(RunResult);
    expect(result.ok).toBe(true);
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toEqual([]);
    // Keys recovered from the file-{i} refs (NOT null, NOT a single collapsed entry).
    expect(result.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(result.byKey('0').outputs[0].url).toBe('https://signed.example.com/a.jpg');
    expect(result.byKey('1').outputs[0].url).toBe('https://signed.example.com/b.jpg');
    expect(result.artifacts).toHaveLength(2);
  });

  it('result() on a fan-out partitions PER JOB (non-blocking path)', async () => {
    const mock = makeFanoutMockClient();
    const result = await new Handle('wf_fan', undefined, mock.client).result();
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(result.succeeded.map((s) => s.key)).toEqual(['0', '1']);
  });

  it('a single-input fan-out (one job, ref file-0) still partitions with key "0"', async () => {
    // Boundary: ONE job whose ref is `file-0` IS a fan-out (files([x])) — it
    // must key "0", NOT collapse to the single-output path. Guards against a
    // `jobs.length === 1 → single-output` regression.
    const mock = makeFanoutMockClient();
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_fan',
      status: 'completed',
      jobs: [{ jobId: 'job_0', ref: 'file-0', status: 'completed' }],
    });
    mock.getWorkflowDownloads.mockResolvedValue({
      downloads: [
        {
          jobId: 'job_0',
          ref: 'file-0',
          files: [
            {
              operation: 'compress',
              operationId: 'opid_0',
              filename: 'a_compressed.jpg',
              sizeBytes: 100,
              downloadUrl: 'https://signed.example.com/a.jpg',
            },
          ],
        },
      ],
    });
    const result = await new Handle('wf_fan', undefined, mock.client).result();
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].key).toBe('0');
    expect(result.byKey('0').outputs[0].url).toBe('https://signed.example.com/a.jpg');
  });

  it('partitions a partially-failed fan-out per job (one completed, one failed)', async () => {
    const mock = makeFanoutMockClient();
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_fan',
      status: 'partially_failed',
      jobs: [
        { jobId: 'job_0', ref: 'file-0', status: 'completed' },
        { jobId: 'job_1', ref: 'file-1', status: 'failed', operations: [{ errorMessage: 'boom' }] },
      ],
    });
    const result = await new Handle('wf_fan', undefined, mock.client).result();
    expect(result.ok).toBe(false);
    expect(result.succeeded.map((s) => s.key)).toEqual(['0']);
    expect(result.failed.map((f) => f.key)).toEqual(['1']);
    // The failed job's typed error is scoped to THAT job's per-job status + op.
    expect(result.failed[0].error).toBeInstanceOf(GislItemFailedError);
    expect(result.failed[0].error.key).toBe('1');
    expect(result.failed[0].error.state).toBe('failed');
    expect(result.failed[0].error.errorMessage).toBe('boom');
  });

  it('a single-file handle (ref "op") stays on the single-output path and keeps its key', async () => {
    const mock = makeMockClient(); // default mock: one job, ref 'op'
    const result = await new Handle('wf_1', undefined, mock.client, 'hero').result();
    // NOT treated as a fan-out: one keyed entry from the handle's #key.
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].key).toBe('hero');
    expect(result.byKey('hero').outputs[0].url).toBe('https://signed.example.com/photo_compressed.jpg');
  });
});
