import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationBuilder } from '../../src/builder.js';
import { GislClient, _markAnonymousClient } from '../../src/client.js';
import {
  GislAbortError,
  GislApiError,
  GislLongFormConcurrencyError,
  GislProbePendingError,
  GislTimeoutError,
} from '../../src/errors.js';
import { FilesRecipe, Recipe, fileInput } from '../../src/file-first.js';
import { MergeBuilder, asset } from '../../src/merge.js';
import {
  GUEST_BACKOFF_BASE_MS,
  GUEST_BACKOFF_MAX_MS,
  PROBE_WAIT_BOUND_MS,
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

/** A plain rate-limit 429 on create: a base GislApiError carrying TOO_MANY_REQUESTS. */
function tooManyRequests(retryAfter?: string): GislApiError {
  return new GislApiError(429, 'Too many requests', '/api/workflows', undefined, {
    errorCode: 'TOO_MANY_REQUESTS',
    responseHeaders: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
}

const landed = (probeStatus: string) => ({ landed: true, probe: { fileId: 'f', probeStatus } });

/** The test-side mirror of the SDK's (private) boundary margin. */
const BOUNDARY_MARGIN_MS = 2_000;

/**
 * The API's probe gate (compression_api CreateWorkflowCommandHandler.php:3095-3096):
 * it stops refusing only when `waitedSeconds > 900`, STRICT, in whole seconds from
 * the upload. The upload is taken to be the first create's instant, the worst case
 * (an upload and first refusal in the same second). Records every create's clock.
 */
function boundServer() {
  const createdAt: number[] = [];
  const createImpl = async (): Promise<unknown> => {
    createdAt.push(Date.now());
    const waitedSeconds = Math.floor((Date.now() - createdAt[0]) / 1000);
    if (waitedSeconds > PROBE_WAIT_BOUND_MS / 1000) return { workflowId: 'wf' };
    throw refusal('op');
  };
  return { createImpl, createdAt };
}

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
    vi.useFakeTimers();
    // The probe wait gets the REMAINING budget, read from Date.now(). Freeze the
    // clock so "remaining" is exactly the budget; a live clock made this 4999
    // whenever a millisecond elapsed (flaked on the CI server, #461).
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
    expect(d.waitForProbe).toHaveBeenCalledOnce();
    expect(d.waitForProbe.mock.calls[0][0]).toBe('file_a');
    expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: 5_000 });
    expect(d.createWorkflow.mock.calls[1][0]).toBe(single);
  });

  it.each(['ok', 'missing_metadata'])('retries after a probe that landed %s', async (status) => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        return { workflowId: 'wf' };
      }, landed(status));
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(1_000);
      await created;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('skips a not_applicable upload and still waits for the job\'s other upload (8L4JJMx6)', async () => {
    // A watermark job: the video is gated, the logo image is never probed.
    const watermark = {
      jobs: [
        {
          id: 'wm',
          inputs: [
            { source: { type: 'upload', file_id: 'logo_png' } },
            { source: { type: 'upload', file_id: 'clip_mp4' } },
          ],
          operations: [{ type: 'watermark', options: {} }],
        },
      ],
    } as unknown as WorkflowCreatePayload;
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('wm');
        return { workflowId: 'wf' };
      });
      d.waitForProbe.mockImplementation(async (fileId: string) =>
        fileId === 'logo_png' ? { landed: false, reason: 'not_applicable' } : landed('ok'),
      );
      const created = createWorkflowAwaitingProbe(d.client, watermark);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
      expect(d.waitForProbe.mock.calls.map((c) => c[0])).toEqual(['logo_png', 'clip_mp4']);
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-creates without a probe wait when the only upload is not_applicable (nothing to wait for)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        return { workflowId: 'wf' };
      }, { landed: false, reason: 'not_applicable' });
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a not_applicable upload the server keeps refusing: the budget ends it, not a create count (Hal5c41E)', async () => {
    vi.useFakeTimers();
    try {
      const original = refusal('op');
      const d = doubles(async () => { throw original; }, { landed: false, reason: 'not_applicable' });
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 60_000 });
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(61_000);
      await outcome;
      // Paced creates at 0, 1, 3, 7, 15, 31 s; the next (61 s) is past the 60 s budget.
      expect(d.createWorkflow).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a not_applicable answer that arrives late (codex ab487dee4814)', () => {
    // The probe request itself outlives the budget / deadline: its answer must
    // not carry the recovery into a re-create.
    function lateNotApplicable() {
      let clock = 1_000_000;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const d = doubles(async () => {
        if (d.createWorkflow.mock.calls.length === 1) throw original;
        return { workflowId: 'wf' };
      });
      const original = refusal('op');
      d.waitForProbe.mockImplementation(async () => {
        clock += 10_000;
        return { landed: false, reason: 'not_applicable' };
      });
      return { d, original, now, at: () => clock };
    }

    it('past the recovery budget: rethrows the original refusal and does NOT re-create', async () => {
      const { d, original, now } = lateNotApplicable();
      try {
        await expect(createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 5_000 })).rejects.toBe(original);
      } finally {
        now.mockRestore();
      }
      expect(d.createWorkflow).toHaveBeenCalledOnce();
      expect(d.waitForProbe).toHaveBeenCalledOnce();
    });

    it('past the run deadline: GislTimeoutError, no re-create', async () => {
      const { d, now, at } = lateNotApplicable();
      try {
        await expect(
          createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 30_000, deadline: at() + 8_000 }),
        ).rejects.toThrow(GislTimeoutError);
      } finally {
        now.mockRestore();
      }
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    it('past the run deadline: the timeout does not claim a probe landed', async () => {
      // Without the check in the not_applicable branch, the post-loop deadline
      // check still throws GislTimeoutError, but says "Probe landed", which is false.
      const { d, now, at } = lateNotApplicable();
      try {
        await expect(
          createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 30_000, deadline: at() + 8_000 }),
        ).rejects.toThrow(/while recovering from probe_pending/);
      } finally {
        now.mockRestore();
      }
    });
  });

  it('rethrows when the refusal names no job in the payload', async () => {
    const original = refusal('job_7');
    const d = doubles(async () => { throw original; });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('refused creates go on past three until the budget ends them (Hal5c41E: no count cap)', async () => {
    vi.useFakeTimers();
    try {
      const original = refusal('op');
      const d = doubles(async () => { throw original; });
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 20_000 });
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(21_000);
      await outcome;
      // Paced creates at 0, 1, 3, 7, 15 s; the next (31 s) is past the 20 s budget.
      expect(d.createWorkflow).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait or re-create past the deadline', async () => {
    const d = doubles(async () => { throw refusal('op'); });
    await expect(createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
      GislTimeoutError,
    );
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('caps each wait at the time left before the deadline', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        return { workflowId: 'wf' };
      });
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 60_000, deadline: Date.now() + 2_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await created;
      const opts = d.waitForProbe.mock.calls[0][1] as { timeoutMs: number };
      // The fake clock has not moved before the probe wait, so the cap is exactly the 2 s left.
      expect(opts.timeoutMs).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op', '1');
        return { workflowId: 'wf' };
      });
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(999);
      expect(d.waitForProbe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(d.waitForProbe).toHaveBeenCalledOnce();
      await created;
      expect(d.waitForProbe.mock.invocationCallOrder[0]).toBeGreaterThan(d.createWorkflow.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      const m = mockClient();
      const run = new OperationBuilder(m.client, 'compress', 'clip.mp4', {}).run({ maxWait: '30s' });
      await vi.advanceTimersByTimeAsync(1_000);
      await run;
      expect(m.createWorkflow).toHaveBeenCalledTimes(2);
      expect(m.waitForProbe.mock.calls[0][0]).toBe('file_up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('run({ probeBeforeCreate: false }) opts out of recovery too', async () => {
    const m = mockClient();
    await expect(
      new OperationBuilder(m.client, 'compress', 'clip.mp4', {}).run({ maxWait: '30s', probeBeforeCreate: false }),
    ).rejects.toBeInstanceOf(GislProbePendingError);
    expect(m.waitForProbe).not.toHaveBeenCalled();
  });

  it('Recipe.run() recovers without the caller writing the loop', async () => {
    vi.useFakeTimers();
    try {
      const m = mockClient();
      const run = new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, m.client)
        .compress()
        .run({ maxWait: '30s' });
      await vi.advanceTimersByTimeAsync(1_000);
      await run;
      expect(m.createWorkflow).toHaveBeenCalledTimes(2);
      expect(m.waitForProbe.mock.calls[0][0]).toBe('file_up');
    } finally {
      vi.useRealTimers();
    }
  });
});

// f5ti3pik (contracts v2.235.0): a probe_pending refusal on a VIDEO merge names
// the FEEDER job `src_N` — the passthrough job wrapping that upload — not the
// `merge` job. Recovery must wait on exactly that upload's file id, through
// both merge entry points. No SDK change: this pins behaviour already shipped.
// The pre-create probe double returns without waiting (best-effort, never
// bounces), so the create is what meets the gate; probeBeforeCreate:false would
// disable the recovery under test (see the opt-out test above).
function mergeFeederClient() {
  let creates = 0;
  const createWorkflow = vi.fn(async (_payload: WorkflowCreatePayload) => {
    if (++creates === 1) throw refusal('src_1');
    return { workflowId: 'wf_merge', status: 'running' };
  });
  const waitForProbe = vi.fn(async (_fileId: string, _opts?: unknown) => landed('ok'));
  const client = {
    // Deterministic per-path ids, independent of upload order.
    uploadFile: vi.fn(async (input: string | Blob) => ({
      fileId: `up_${String(input)}`,
      contentType: 'video/mp4',
      sizeBytes: 1_000,
    })),
    createWorkflow,
    waitForProbe,
    maybeWaitForVideoProbe: vi.fn(async () => undefined),
    getWorkflowStatus: vi.fn(async () => ({ workflowId: 'wf_merge', status: 'completed', jobs: [] })),
    getWorkflowDownloads: vi.fn(async () => ({ downloads: [] })),
    streamEvents: vi.fn(async function* () {
      yield { event: 'workflow.completed', data: { status: 'completed' } };
    }),
  } as unknown as GislClient;
  return { client, createWorkflow, waitForProbe };
}

type JobShape = { id?: string; source?: { type: string; file_id?: string }; inputs?: unknown[] };
const jobsOf = (payload: WorkflowCreatePayload): JobShape[] => payload.jobs as unknown as JobShape[];

describe('merge probe_pending: the server names the feeder job src_N (f5ti3pik)', () => {
  it('files([...]).merge().run() waits on exactly src_1\'s upload, then re-creates', async () => {
    vi.useFakeTimers();
    try {
      const m = mergeFeederClient();
      const inputs = ['a.mp4', 'b.mp4', 'c.mp4'].map((p) => fileInput.path(p));
      const run = new FilesRecipe(inputs, [], undefined, undefined, m.client).merge({ mediaKind: 'video' }).run({ maxWait: '30s' });
      await vi.advanceTimersByTimeAsync(1_000);
      await run;

      expect(m.createWorkflow).toHaveBeenCalledTimes(2);
      const sent = m.createWorkflow.mock.calls[0][0];
      const src1 = jobsOf(sent).find((j) => j.id === 'src_1');
      expect(src1?.source).toEqual({ type: 'upload', file_id: 'up_b.mp4' });
      expect(m.waitForProbe.mock.calls.map((c) => c[0])).toEqual(['up_b.mp4']);
      // The SAME payload is re-sent.
      expect(m.createWorkflow.mock.calls[1][0]).toBe(sent);
    } finally {
      vi.useRealTimers();
    }
  });

  it('client.merge (MergeBuilder) with a repeated asset: src_1 is the second UNIQUE asset', async () => {
    vi.useFakeTimers();
    try {
      const m = mergeFeederClient();
      const a = asset('a.mp4');
      const b = asset('b.mp4');
      const c = asset('c.mp4');
      // Play order a, a, b, c: MergedRecipe would lower a src job per position
      // (src_1 = a); MergeBuilder dedups onto one src per asset (src_1 = b).
      const run = new MergeBuilder(m.client, [a, b, c], { mediaKind: 'video' }).sequence(a, a, b, c).run({ maxWait: '30s' });
      await vi.advanceTimersByTimeAsync(1_000);
      await run;

      expect(m.createWorkflow).toHaveBeenCalledTimes(2);
      const sent = m.createWorkflow.mock.calls[0][0];
      expect(jobsOf(sent).filter((j) => j.id?.startsWith('src_')).map((j) => [j.id, j.source?.file_id])).toEqual([
        ['src_0', 'up_a.mp4'],
        ['src_1', 'up_b.mp4'],
        ['src_2', 'up_c.mp4'],
      ]);
      expect(jobsOf(sent).find((j) => j.id === 'merge')?.inputs).toHaveLength(4);
      expect(m.waitForProbe.mock.calls.map((c) => c[0])).toEqual(['up_b.mp4']);
      expect(m.createWorkflow.mock.calls[1][0]).toBe(sent);
    } finally {
      vi.useRealTimers();
    }
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
    await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS - 60_000);
    // Still re-creating well inside the bound.
    const before = d.createWorkflow.mock.calls.length;
    expect(before).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });

  it('makes one last create just past the budget boundary, which the strict server gate accepts', async () => {
    // Headerless refusals until the server's `waitedSeconds > 900` (codex 781cae520a36, Hal5c41E).
    const server = boundServer();
    const d = guest(server.createImpl);
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    const last = server.createdAt[server.createdAt.length - 1] - server.createdAt[0];
    // budgetEnd = first refusal + bound; the boundary create starts at least the margin past it.
    expect(last).toBeGreaterThanOrEqual(PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS);
    expect(last).toBeLessThanOrEqual(PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS + 1_000);
  });

  it('a deadline before the boundary margin is a GislTimeoutError, with no boundary create', async () => {
    const server = boundServer();
    const d = guest(server.createImpl);
    const created = createWorkflowAwaitingProbe(d.client, single, {
      deadline: Date.now() + PROBE_WAIT_BOUND_MS + 1_000,
    });
    const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
    await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 1_000);
    await outcome;
    const last = server.createdAt[server.createdAt.length - 1] - server.createdAt[0];
    expect(last).toBeLessThan(PROBE_WAIT_BOUND_MS);
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
    const created = createWorkflowAwaitingProbe(d.client, single);
    // The signed-in re-create is paced GUEST_BACKOFF_BASE_MS from the first create (Hal5c41E).
    await vi.advanceTimersByTimeAsync(GUEST_BACKOFF_BASE_MS);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.waitForProbe).toHaveBeenCalledWith('file_a', expect.anything());
  });

  it('a guest create 429 TOO_MANY_REQUESTS mid-recovery is rethrown at once, not waited out', async () => {
    const limited = tooManyRequests('5');
    let calls = 0;
    const d = guest(async () => {
      if (++calls === 1) throw refusal('op');
      throw limited;
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    const outcome = expect(created).rejects.toBe(limited);
    await vi.advanceTimersByTimeAsync(GUEST_BACKOFF_BASE_MS);
    await outcome;
    expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    expect(d.waitForProbe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Hal5c41E: a signed-in recovery's default budget is the contract's
// video.probe_wait_bound_seconds (900 s), with no create-count cap, paced
// creates, a waited-out create 429, and one precise boundary create.
// ---------------------------------------------------------------------------

describe('createWorkflowAwaitingProbe signed in: the 900 s budget (Hal5c41E)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A probe wait that takes its whole `timeoutMs` (plus `overshootMs`) and does not land. */
  function neverLands(d: ReturnType<typeof doubles>, reason: 'timeout' | 'prober_error' = 'timeout', overshootMs = 0) {
    d.waitForProbe.mockImplementation(async (_fileId: string, opts?: unknown) => {
      const { timeoutMs } = opts as { timeoutMs: number };
      await new Promise((resolve) => setTimeout(resolve, timeoutMs + overshootMs));
      return { landed: false, reason };
    });
  }

  /** Records the clock at every create, relative to the first. */
  function createClock(d: ReturnType<typeof doubles>): number[] {
    const at: number[] = [];
    const impl = d.createWorkflow.getMockImplementation();
    d.createWorkflow.mockImplementation(async (payload: unknown) => {
      at.push(Date.now());
      return impl === undefined ? undefined : impl(payload);
    });
    return at;
  }

  const relative = (at: number[]) => at.map((t) => t - at[0]);

  it('defaults the budget to PROBE_WAIT_BOUND_MS and polls patiently', async () => {
    const original = refusal('op');
    const d = doubles(async () => { throw original; }, { landed: false, reason: 'prober_error' });
    await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
    expect(PROBE_WAIT_BOUND_MS).toBe(900_000);
    expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: PROBE_WAIT_BOUND_MS, patient: true });
  });

  it('a recovery longer than 30 s succeeds by default', async () => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op');
      return { workflowId: 'wf' };
    });
    d.waitForProbe.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return landed('ok');
    });
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(d.createWorkflow).toHaveBeenCalledTimes(2);
  });

  it('an explicit short timeoutMs is honoured: exactly 1 create, no boundary create', async () => {
    const original = refusal('op');
    const d = doubles(async () => { throw original; });
    neverLands(d);
    const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 5_000 });
    const outcome = expect(created).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(d.createWorkflow).toHaveBeenCalledOnce();
    expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: 5_000 });
  });

  it('a probe that does not land by the deadline is a GislTimeoutError, not the refusal', async () => {
    const d = doubles(async () => { throw refusal('op'); });
    neverLands(d);
    const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 20_000 });
    const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(d.createWorkflow).toHaveBeenCalledOnce();
    expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: 20_000 });
  });

  it('a probe that lands only after the deadline is a GislTimeoutError, not the refusal, with no re-create', async () => {
    const d = doubles(async () => { throw refusal('op'); });
    d.waitForProbe.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      return landed('ok');
    });
    const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 20_000 });
    const outcome = expect(created).rejects.toThrow(/Probe landed but maxWait elapsed/);
    await vi.advanceTimersByTimeAsync(25_000);
    await outcome;
    await expect(created).rejects.toBeInstanceOf(GislTimeoutError);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
  });

  it('a paced re-create whose sleep overran the deadline is a GislTimeoutError, not the refusal', async () => {
    const d = doubles(async () => { throw refusal('op'); });
    const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 5_000 });
    const outcome = expect(created).rejects.toThrow(/while recovering from probe_pending/);
    // Let the recovery reach its 1 s paced sleep, then wake 10 s late, past the deadline.
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    await expect(created).rejects.toBeInstanceOf(GislTimeoutError);
    expect(d.createWorkflow).toHaveBeenCalledOnce();
  });

  describe('the boundary create', () => {
    it('is made once, the margin past the default budget, and the strict server gate accepts it', async () => {
      const server = boundServer();
      const d = doubles(server.createImpl);
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
      // budgetEnd = first refusal + bound, and the boundary create starts >= budgetEnd + margin.
      expect(relative(server.createdAt)).toEqual([0, PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS]);
    });

    it('a create AT the bound would still be refused by the strict server gate (the model is not lax)', async () => {
      // Positive control on boundServer: at exactly 900 s waitedSeconds is 900, not > 900.
      const server = boundServer();
      await expect(server.createImpl()).rejects.toBeInstanceOf(GislProbePendingError);
      vi.setSystemTime(Date.now() + PROBE_WAIT_BOUND_MS + 999);
      await expect(server.createImpl()).rejects.toBeInstanceOf(GislProbePendingError);
      vi.setSystemTime(Date.now() + 1);
      await expect(server.createImpl()).resolves.toEqual({ workflowId: 'wf' });
    });

    it('a deadline before the boundary margin is a GislTimeoutError, with no boundary create', async () => {
      const server = boundServer();
      const d = doubles(server.createImpl);
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single, {
        deadline: Date.now() + PROBE_WAIT_BOUND_MS + 1_000,
      });
      const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 1_000);
      await outcome;
      expect(server.createdAt).toHaveLength(1);
    });

    it('a refused boundary create is the last: the FIRST refusal comes back, 2 creates in all', async () => {
      const original = refusal('op');
      let calls = 0;
      const d = doubles(async () => {
        throw ++calls === 1 ? original : refusal('op');
      });
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 60_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
      expect(d.waitForProbe).toHaveBeenCalledOnce();
    });

    it('is not made after a late probe answer past the timer slack', async () => {
      const original = refusal('op');
      const d = doubles(async () => { throw original; });
      // 2 s past the budget: beyond the 1 s timer slack but INSIDE paceCreate's
      // own margin + slack (3 s), so only the boundary's slack check refuses it.
      neverLands(d, 'timeout', 2_000);
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 5_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    it('is not made when the budget is shorter than the contract bound', async () => {
      const original = refusal('op');
      const d = doubles(async () => { throw original; });
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: PROBE_WAIT_BOUND_MS - 1 });
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    describe('an explicit timeoutMs is a strict cap, even at or past the contract bound (4v7Vwvcw)', () => {
      const explicitBudgets = [PROBE_WAIT_BOUND_MS, 1_200_000];

      // Shorter than bound + margin: the boundary create would land past the cap.
      it.each([PROBE_WAIT_BOUND_MS, PROBE_WAIT_BOUND_MS + 1_000])(
        'signed in, %i ms: no boundary create, and no create past the budget',
        async (timeoutMs) => {
          const original = refusal('op');
          const d = doubles(async () => { throw original; });
          neverLands(d);
          const at = createClock(d);
          const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs });
          const outcome = expect(created).rejects.toBe(original);
          await vi.advanceTimersByTimeAsync(timeoutMs + 60_000);
          await outcome;
          expect(relative(at)).toEqual([0]);
        },
      );

      it('signed in, 1 200 000 ms: one create at the gate + margin, inside the cap, which the strict server accepts', async () => {
        const server = boundServer();
        const d = doubles(server.createImpl);
        neverLands(d);
        const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 1_200_000 });
        // Not the 20 min budget: the probe wait stops when the server's gate opens.
        await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS);
        await expect(created).resolves.toEqual({ workflowId: 'wf' });
        expect(relative(server.createdAt)).toEqual([0, PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS]);
        expect(d.waitForProbe.mock.calls[0][1]).toMatchObject({ timeoutMs: PROBE_WAIT_BOUND_MS });
      });

      it('signed in, 1 200 000 ms: a refused boundary create is the last, the first refusal comes back', async () => {
        const original = refusal('op');
        let calls = 0;
        const d = doubles(async () => {
          throw ++calls === 1 ? original : refusal('op');
        });
        neverLands(d);
        const at = createClock(d);
        const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 1_200_000 });
        const outcome = expect(created).rejects.toBe(original);
        await vi.advanceTimersByTimeAsync(1_200_000 + 60_000);
        await outcome;
        expect(relative(at)).toEqual([0, PROBE_WAIT_BOUND_MS + BOUNDARY_MARGIN_MS]);
      });

      it.each(explicitBudgets)('signed in, %i ms: every paced create starts by the budget end', async (timeoutMs) => {
        const original = refusal('op');
        // The probe lands at once every time, so the creates run to the budget.
        const d = doubles(async () => { throw original; });
        const at = createClock(d);
        const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs });
        const outcome = expect(created).rejects.toBe(original);
        await vi.advanceTimersByTimeAsync(timeoutMs + 60_000);
        await outcome;
        const t = relative(at);
        expect(t.length).toBeGreaterThan(3);
        expect(Math.max(...t)).toBeLessThanOrEqual(timeoutMs);
      });

      it.each(explicitBudgets)('guest, %i ms: the last create lands AT the budget end, not past it', async (timeoutMs) => {
        const original = refusal('op');
        const d = doubles(async () => { throw original; });
        _markAnonymousClient(d.client);
        const at = createClock(d);
        const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs });
        const outcome = expect(created).rejects.toBe(original);
        await vi.advanceTimersByTimeAsync(timeoutMs + 60_000);
        await outcome;
        const t = relative(at);
        expect(Math.max(...t)).toBeLessThanOrEqual(timeoutMs);
        expect(t[t.length - 1]).toBe(timeoutMs);
      });
    });

    it('is not made when the probe wait gave up for another reason (prober_error)', async () => {
      const original = refusal('op');
      const d = doubles(async () => { throw original; });
      neverLands(d, 'prober_error');
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    it('is not made when the probe wait timed out early, before the budget ended', async () => {
      const original = refusal('op');
      const d = doubles(async () => { throw original; }, { landed: false, reason: 'timeout' });
      await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(original);
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    it('is not made when the deadline, not the budget, ended the wait', async () => {
      const d = doubles(async () => { throw refusal('op'); });
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + PROBE_WAIT_BOUND_MS });
      const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });

    it('a 429 on the boundary create is not waited out past the budget: the first refusal, no third create', async () => {
      const original = refusal('op');
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw original;
        throw tooManyRequests('60');
      });
      neverLands(d);
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 120_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    });
  });

  it('paces creates inside the Free workflow_create limits: <= 10 in any 60 s, <= 50 in all', async () => {
    const original = refusal('op');
    // The probe lands at once every time, so the pacing is the only gap.
    const d = doubles(async () => { throw original; });
    const at = createClock(d);
    const created = createWorkflowAwaitingProbe(d.client, single);
    const outcome = expect(created).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(PROBE_WAIT_BOUND_MS + 60_000);
    await outcome;
    const t = relative(at);
    for (const from of t) {
      expect(t.filter((x) => x >= from && x < from + 60_000).length).toBeLessThanOrEqual(10);
    }
    expect(t.length).toBeLessThanOrEqual(50);
    // No count cap: it kept going, and the budget is what ended it.
    expect(t.length).toBeGreaterThan(3);
    expect(t[t.length - 1]).toBeLessThanOrEqual(PROBE_WAIT_BOUND_MS);
    expect(t[t.length - 1]).toBeGreaterThan(PROBE_WAIT_BOUND_MS - 30_000);
    // Doubling from 1 s, capped at 30 s, from each create's start.
    expect(t.slice(0, 8)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000]);
  });

  it('the refusal Retry-After paces the next create when it is longer than the backoff', async () => {
    let calls = 0;
    const d = doubles(async () => {
      if (++calls === 1) throw refusal('op', '5');
      return { workflowId: 'wf' };
    });
    const at = createClock(d);
    const created = createWorkflowAwaitingProbe(d.client, single);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(relative(at)).toEqual([0, 5_000]);
  });

  describe('a create refused with 429 mid-recovery', () => {
    it('TOO_MANY_REQUESTS is waited out for its Retry-After, then re-created', async () => {
      let calls = 0;
      const d = doubles(async () => {
        calls++;
        if (calls === 1) throw refusal('op');
        if (calls === 2) throw tooManyRequests('20');
        return { workflowId: 'wf' };
      });
      const at = createClock(d);
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(21_000);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
      expect(relative(at)).toEqual([0, 1_000, 21_000]);
      expect(d.waitForProbe).toHaveBeenCalledOnce();
    });

    it('TOO_MANY_REQUESTS with no Retry-After is waited out with the create backoff', async () => {
      let calls = 0;
      const d = doubles(async () => {
        calls++;
        if (calls === 1) throw refusal('op');
        if (calls === 2) throw tooManyRequests();
        return { workflowId: 'wf' };
      });
      const at = createClock(d);
      const created = createWorkflowAwaitingProbe(d.client, single);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(created).resolves.toEqual({ workflowId: 'wf' });
      expect(relative(at)).toEqual([0, 1_000, 3_000]);
    });

    it('TOO_MANY_REQUESTS whose Retry-After outlasts the budget rethrows the first refusal at once', async () => {
      const original = refusal('op');
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw original;
        throw tooManyRequests('600');
      });
      const created = createWorkflowAwaitingProbe(d.client, single, { timeoutMs: 60_000 });
      const outcome = expect(created).rejects.toBe(original);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    });

    it('TOO_MANY_REQUESTS whose Retry-After outlasts the deadline is a GislTimeoutError', async () => {
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        throw tooManyRequests('600');
      });
      const created = createWorkflowAwaitingProbe(d.client, single, { deadline: Date.now() + 60_000 });
      const outcome = expect(created).rejects.toBeInstanceOf(GislTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    });

    it('DUPLICATE_IN_PROGRESS (also a 429) is rethrown at once', async () => {
      const duplicate = new GislApiError(429, 'duplicate in progress', '/api/workflows', undefined, {
        errorCode: 'DUPLICATE_IN_PROGRESS',
        responseHeaders: { 'retry-after': '1' },
      });
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        throw duplicate;
      });
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(duplicate);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    });

    it('the long-form concurrency 429 is rethrown at once, even carrying TOO_MANY_REQUESTS', async () => {
      // The code is set to TOO_MANY_REQUESTS so only the CLASS check can exclude it.
      const longForm = new GislLongFormConcurrencyError(
        429,
        'long-form limit',
        { error: 'LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED' } as unknown as ConstructorParameters<
          typeof GislLongFormConcurrencyError
        >[2],
        '/api/workflows',
        { errorCode: 'TOO_MANY_REQUESTS' },
      );
      let calls = 0;
      const d = doubles(async () => {
        if (++calls === 1) throw refusal('op');
        throw longForm;
      });
      const created = createWorkflowAwaitingProbe(d.client, single);
      const outcome = expect(created).rejects.toBe(longForm);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(d.createWorkflow).toHaveBeenCalledTimes(2);
    });

    it('a 429 on the FIRST create, before any probe_pending, is not ours to wait out', async () => {
      const limited = tooManyRequests('5');
      const d = doubles(async () => { throw limited; });
      await expect(createWorkflowAwaitingProbe(d.client, single)).rejects.toBe(limited);
      expect(d.createWorkflow).toHaveBeenCalledOnce();
    });
  });

  it('a probe 429 mid-recovery on a multi-file job is waited out, not fatal (real client, patient polling)', async () => {
    // Two uploads in one job: the second's probe hits the shared per-user
    // probe bucket. Through the real waitForProbe, `patient: true` waits it out.
    const client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    const twoUploads = {
      jobs: [
        {
          id: 'wm',
          inputs: [
            { source: { type: 'upload', file_id: 'clip_a' } },
            { source: { type: 'upload', file_id: 'clip_b' } },
          ],
          operations: [{ type: 'watermark', options: {} }],
        },
      ],
    } as unknown as WorkflowCreatePayload;
    let creates = 0;
    const createSpy = vi.spyOn(client, 'createWorkflow').mockImplementation(async () => {
      if (++creates === 1) throw refusal('wm');
      return { workflowId: 'wf' } as unknown as Awaited<ReturnType<GislClient['createWorkflow']>>;
    });
    const probeAnswer = { fileId: 'x', probeStatus: 'ok' } as unknown as Awaited<ReturnType<GislClient['probeUpload']>>;
    let clipBPolls = 0;
    const probeSpy = vi.spyOn(client, 'probeUpload').mockImplementation(async (fileId: string) => {
      if (fileId === 'clip_b' && ++clipBPolls === 1) throw tooManyRequests('15');
      return probeAnswer;
    });
    const created = createWorkflowAwaitingProbe(client, twoUploads);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(created).resolves.toEqual({ workflowId: 'wf' });
    expect(probeSpy.mock.calls.map((c) => c[0])).toEqual(['clip_a', 'clip_b', 'clip_b']);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
