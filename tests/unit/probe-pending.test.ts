import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationBuilder } from '../../src/builder.js';
import { _markAnonymousClient, type GislClient } from '../../src/client.js';
import { GislAbortError, GislApiError, GislProbePendingError, GislTimeoutError } from '../../src/errors.js';
import { Recipe, fileInput } from '../../src/file-first.js';
import {
  GUEST_BACKOFF_BASE_MS,
  GUEST_BACKOFF_MAX_MS,
  GUEST_PROBE_WAIT_BOUND_MS,
  PROBE_PENDING_MAX_CREATE_ATTEMPTS,
  createWorkflowAwaitingProbe,
  uploadFileIdsForJob,
} from '../../src/probe-pending.js';
import type { WorkflowCreatePayload } from '../../src/types.js';

/**
 * dql51via: a `422 probe_pending` on create is recovered per the contract -
 * wait for the named job's upload probe, then re-create the SAME payload.
 */

function refusal(jobRef: string, retryAfter?: string): GislProbePendingError {
  return new GislProbePendingError(
    422,
    'probe pending',
    {
      success: false,
      error: 'UNPROCESSABLE_ENTITY',
      errorType: 'probe_pending',
      jobRef,
    } as unknown as ConstructorParameters<typeof GislProbePendingError>[2],
    undefined,
    retryAfter === undefined ? undefined : { responseHeaders: { 'retry-after': retryAfter } },
  );
}

const landed = (probeStatus: string) => ({ landed: true, probe: { fileId: 'f', probeStatus } });

function doubles(createImpl: (payload: unknown) => Promise<unknown>, waitResult: unknown = landed('ok')) {
  const createWorkflow = vi.fn(createImpl);
  const waitForProbe = vi.fn(async (_fileId: string, _opts?: unknown) => waitResult);
  const client = { createWorkflow, waitForProbe } as unknown as Pick<GislClient, 'createWorkflow' | 'waitForProbe'>;
  return { createWorkflow, waitForProbe, client };
}

const single: WorkflowCreatePayload = {
  jobs: [{ id: 'op', source: { type: 'upload', file_id: 'file_a' }, operations: [{ type: 'compress', options: {} }] }],
} as unknown as WorkflowCreatePayload;

describe('uploadFileIdsForJob', () => {
  const payload = {
    jobs: [
      { source: { type: 'upload', file_id: 'f0' }, operations: [] },
      { id: 'named', source: { type: 'upload', file_id: 'f1' }, operations: [] },
      {
        id: 'merge',
        inputs: [
          { source: { type: 'upload', file_id: 'f2' } },
          { source: { type: 'job_output', from: 'named' } },
          { source: { type: 'upload', file_id: 'f2' } },
        ],
        operations: [],
      },
    ],
  } as unknown as WorkflowCreatePayload;

  it('matches a job by its own id', () => expect(uploadFileIdsForJob(payload, 'named')).toEqual(['f1']));
  it('matches the server job_N token to an id-less job at index N', () =>
    expect(uploadFileIdsForJob(payload, 'job_0')).toEqual(['f0']));
  it('does not match job_N to a job that carries its own id', () =>
    expect(uploadFileIdsForJob(payload, 'job_1')).toEqual([]));
  it('collects each upload input once, skipping job outputs', () =>
    expect(uploadFileIdsForJob(payload, 'merge')).toEqual(['f2']));
  it('yields nothing for an unknown or missing ref', () => {
    expect(uploadFileIdsForJob(payload, 'nope')).toEqual([]);
    expect(uploadFileIdsForJob(payload, undefined)).toEqual([]);
  });
});

describe('createWorkflowAwaitingProbe', () => {
  it('is a single create when the server does not refuse', async () => {
    const d = doubles(async () => ({ workflowId: 'wf' }));
    await expect(createWorkflowAwaitingProbe(d.client, single)).resolves.toEqual({ workflowId: 'wf' });
    expect(d.createWorkflow).toHaveBeenCalledOnce();
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('waits for the named upload then re-creates the SAME payload', async () => {
    let calls = 0;
    const d = doubles(async () => {
      calls++;
      if (calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    });
    // The probe wait gets the REMAINING budget, read from Date.now(). Freeze the
    // clock so "remaining" is exactly the budget; a live clock made this 4999
    // whenever a millisecond elapsed (flaked on the CI server, #461).
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await expect(createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 5_000 })).resolves.toEqual({ workflowId: 'wf' });
    } finally {
      now.mockRestore();
    }
    expect(d.waitForProbe).toHaveBeenCalledOnce();
    expect(d.waitForProbe.mock.calls[0][0]).toBe('file_a');
    expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: 5_000 });
    expect(d.createWorkflow.mock.calls[1][0]).toBe(single);
  });

  it.each(['ok', 'missing_metadata'])('retries after a probe that landed %s', async (status) => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    }, landed(status));
    await createWorkflowAwaitingProbe(d.client, single);
    expect(d.createWorkflow).toHaveBeenCalledTimes(2);
  });

  it.each(['corrupt', 'unsupported_codec'])('does NOT retry a probe that landed %s: the original refusal surfaces', async (status) => {
    const original = refusal('op');
    const d = doubles(async () => { throw original; }, landed(status));
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
  });

  it('gives up with the original refusal when the probe never lands', async () => {
    const original = refusal('op');
    const d = doubles(async () => { throw original; }, { landed: false, reason: 'timeout' });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
  });

  it('rethrows when the refusal names no job in the payload', async () => {
    const original = refusal('job_7');
    const d = doubles(async () => { throw original; });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it(`stops after ${PROBE_PENDING_MAX_CREATE_ATTEMPTS} refused creates`, async () => {
    const d = doubles(async () => { throw refusal('op'); });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBeInstanceOf(GislProbePendingError);
    expect(d.createWorkflow).toHaveBeenCalledTimes(PROBE_PENDING_MAX_CREATE_ATTEMPTS);
  });

  it('does not wait or re-create past the deadline', async () => {
    const d = doubles(async () => { throw refusal('op'); });
    await expect(createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
      GislTimeoutError,
    );
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('caps each wait at the time left before the deadline', async () => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    });
    await createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 60_000, deadline: Date.now() + 2_000 });
    const opts = d.waitForProbe.mock.calls[0][1] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeLessThanOrEqual(2_000);
  });

  it('does not create at all when the signal is already aborted (codex ae65d4f34b8e)', async () => {
    const d = doubles(async () => ({ workflowId: 'wf' }));
    const controller = new AbortController();
    controller.abort();
    await expect(createWorkflowAwaitingProbe(d.client, single, { signal: controller.signal })).rejects.toBeInstanceOf(
      GislAbortError,
    );
    expect(d.createWorkflow).not.toHaveBeenCalled();
  });

  it("honours the refusal's Retry-After before polling (codex 089af94beb8e)", async () => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op', '1');
      return { workflowId: 'wf' };
    });
    const started = Date.now();
    await createWorkflowAwaitingProbe(d.client, single);
    expect(d.waitForProbe.mock.invocationCallOrder[0]).toBeGreaterThan(d.createWorkflow.mock.invocationCallOrder[0]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('a Retry-After that ends past the deadline is a timeout now, not a wait', async () => {
    const d = doubles(async () => { throw refusal('op', '120'); });
    const started = Date.now();
    await expect(
      createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 5_000 }),
    ).rejects.toBeInstanceOf(GislTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('a Retry-After that does not fit the recovery budget rethrows the refusal, with no deadline (codex b08a5036e468)', async () => {
    const original = refusal('op', '120');
    const d = doubles(async () => { throw original; });
    const started = Date.now();
    await expect(createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 1_000 })).rejects.toBe(original);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('enabled:false rethrows the refusal at once (codex ccbe063d8a34)', async () => {
    const original = refusal('op');
    const d = doubles(async () => { throw original; });
    await expect(createWorkflowAwaitingProbe(d.client, single, { enabled: false })).rejects.toBe(original);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('passes any other error through untouched', async () => {
    const other = new GislApiError(422, 'validation');
    const d = doubles(async () => { throw other; });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(other);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
  });
});

// Through the PUBLIC entry points: a caller of run() writes no loop.
function mockClient() {
  let creates = 0;
  const createWorkflow = vi.fn(async (payload: WorkflowCreatePayload) => {
    if (++creates === 1) throw refusal(payload.jobs[0].id ?? 'job_0');
    return { workflowId: 'wf_1', status: 'running' };
  });
  const waitForProbe = vi.fn(async (_fileId: string) => landed('ok'));
  const client = {
    uploadFile: vi.fn(async () => ({ fileId: 'file_up', contentType: 'video/mp4', sizeBytes: 1_000 })),
    createWorkflow,
    waitForProbe,
    maybeWaitForVideoProbe: vi.fn(async () => undefined),
    getWorkflowStatus: vi.fn(async () => ({
      workflowId: 'wf_1',
      status: 'completed',
      jobs: [{ ref: 'op', status: 'completed', operations: [] }],
    })),
    getWorkflowDownloads: vi.fn(async () => ({ downloads: [] })),
    streamEvents: vi.fn(async function* () {
      yield { event: 'workflow.completed', data: { status: 'completed' } };
    }),
  } as unknown as GislClient;
  return { client, createWorkflow, waitForProbe };
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe('probe_pending recovery through run()', () => {
  it('OperationBuilder.run() recovers without the caller writing the loop', async () => {
    const m = mockClient();
    await new OperationBuilder(m.client, 'compress', 'clip.mp4', {}).run({ maxWait: '30s' });
    expect(m.createWorkflow).toHaveBeenCalledTimes(2);
    expect(m.waitForProbe.mock.calls[0][0]).toBe('file_up');
  });

  it('run({ probeBeforeCreate: false }) opts out of recovery too', async () => {
    const m = mockClient();
    await expect(
      new OperationBuilder(m.client, 'compress', 'clip.mp4', {}).run({ maxWait: '30s', probeBeforeCreate: false }),
    ).rejects.toBeInstanceOf(GislProbePendingError);
    expect(m.waitForProbe).not.toHaveBeenCalled();
  });

  it('Recipe.run() recovers without the caller writing the loop', async () => {
    const m = mockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, m.client).compress().run({ maxWait: '30s' });
    expect(m.createWorkflow).toHaveBeenCalledTimes(2);
    expect(m.waitForProbe.mock.calls[0][0]).toBe('file_up');
  });
});

// ---------------------------------------------------------------------------
// 5dJrOdVC — anonymous-policy 2.1.0: the probe endpoint is sign-in only, so a
// GUEST refused with probe_pending retries the CREATE (after Retry-After, or a
// doubling backoff) and never calls waitForProbe.
// ---------------------------------------------------------------------------

describe('createWorkflowAwaitingProbe on a guest client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const guest = (createImpl: (payload: unknown) => Promise<unknown>) => {
    const d = doubles(createImpl);
    _markAnonymousClient(d.client);
    return d;
  };

  it('re-creates after Retry-After without waiting for the probe', async () => {
    let calls = 0;
    const d = guest(async () => {
      if (++calls === 1) throw refusal('op', '2');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(d.createWorkflow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    expect(d.createWorkflow.mock.calls[1][0]).toBe(single);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('waits GUEST_BACKOFF_BASE_MS before re-creating when the refusal carries no Retry-After', async () => {
    let calls = 0;
    const d = guest(async () => {
      if (++calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(GUEST_BACKOFF_BASE_MS - 1);
    expect(d.createWorkflow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('re-creates even when the refusal names no job with an upload (no probe to wait for)', async () => {
    let calls = 0;
    const d = guest(async () => {
      if (++calls === 1) throw refusal('unknown_job');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(GUEST_BACKOFF_BASE_MS);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
  });

  it('keeps re-creating past three refusals (no count cap) and completes', async () => {
    // fNSQUeDS: anonymous-policy 2.2.0 lets a guest probe take up to 900 s, and a
    // refusal does not count against the guest create limit (2.1.0).
    let calls = 0;
    const d = guest(async () => {
      if (++calls <= 5) throw refusal('op');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    // 1 + 2 + 4 + 8 + 16 s of doubling backoff.
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.createWorkflow).toHaveBeenCalledTimes(6);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('caps the doubling backoff at GUEST_BACKOFF_MAX_MS', async () => {
    let calls = 0;
    const d = guest(async () => {
      if (++calls <= 7) throw refusal('op');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    // 1+2+4+8+16 = 31 s, then 32 s would exceed the cap: the 6th and 7th waits are 30 s each.
    await vi.advanceTimersByTimeAsync(31_000 + GUEST_BACKOFF_MAX_MS);
    expect(d.createWorkflow).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(GUEST_BACKOFF_MAX_MS);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.createWorkflow).toHaveBeenCalledTimes(8);
  });

  it('by default gives up at the policy probe-wait bound with the first refusal', async () => {
    const original = refusal('op', '30');
    const d = guest(async () => {
      throw original;
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    const outcome = expect(created).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(GUEST_PROBE_WAIT_BOUND_MS - 60_000);
    // Still re-creating well inside the bound.
    const before = d.createWorkflow.mock.calls.length;
    expect(before).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('makes one last create AT the budget boundary, which the server may accept', async () => {
    // Headerless refusals until exactly the bound, then accepted (codex 781cae520a36).
    const start = Date.now();
    const d = guest(async () => {
      if (Date.now() - start < GUEST_PROBE_WAIT_BOUND_MS) throw refusal('op');
      return { workflowId: 'wf' };
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(GUEST_PROBE_WAIT_BOUND_MS + 1_000);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
  });

  it('does not make the boundary create when the wake-up overshot the budget', async () => {
    // codex a7a76673694a: an explicit budget is not violated by a late timer.
    const original = refusal('op');
    const d = guest(async () => {
      throw original;
    });
    const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 1_500 });
    const outcome = expect(created).rejects.toBe(original);
    // First wait is 1 s; the next (2 s) would cross the 1.5 s budget, so the
    // last wait is the 0.5 s left - and the clock jumps 5 s past it meanwhile.
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(500);
    await outcome;
    expect(d.createWorkflow).toHaveBeenCalledTimes(2);
  });

  it("the caller's timeoutMs wins over the guest default", async () => {
    const original = refusal('op', '1');
    const d = guest(async () => {
      throw original;
    });
    const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 5_000 });
    const outcome = expect(created).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(6_000);
    await outcome;
    expect(d.createWorkflow.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('does not re-create when the sleep overran the deadline', async () => {
    const d = guest(async () => {
      throw refusal('op', '2');
    });
    // The pre-sleep check passes (2 s fits before the deadline); the clock then
    // jumps past it while sleeping, as a late timer would.
    const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 2_100 });
    const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
    vi.setSystemTime(Date.now() + 500);
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
    expect(d.createWorkflow).toHaveBeenCalledTimes(1);
  });

  it('gives back the FIRST refusal, not the last, when the budget runs out', async () => {
    let calls = 0;
    const refusals: GislProbePendingError[] = [];
    const d = guest(async () => {
      const r = refusal('op', '1');
      refusals.push(r);
      calls++;
      throw r;
    });
    const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 3_500 });
    const outcome = expect(created).rejects.toSatisfy((err: unknown) => err === refusals[0]);
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(calls).toBeGreaterThan(1);
  });

  it('a signed-in client still waits for the probe (control)', async () => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    });
    await expect(createWorkflowAwaitingProbe(d.client, single)).resolves.toEqual({ workflowId: 'wf' });
    expect(d.waitForProbe).toHaveBeenCalledWith('file_a', expect.anything());
  });
});
