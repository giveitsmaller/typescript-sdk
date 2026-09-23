// dql51via: recovery from a `422 probe_pending` on workflow create. A module
// function over two client methods (not a GislClient method body) so every
// ergonomic create site shares it and a test double needs only
// `createWorkflow` + `waitForProbe`.
import type { WorkflowCreateResponse } from '@giveitsmaller/contracts/openapi';

import type { GislClient } from './client.js';
import { GislAbortError, GislProbePendingError, GislTimeoutError } from './errors.js';
import { parseRetryAfterMs } from './retry-metadata.js';
import type { WorkflowCreatePayload } from './types.js';

/** A landed probe ends the gate server-side, so 3 creates is headroom, not a retry policy. */
export const PROBE_PENDING_MAX_CREATE_ATTEMPTS = 3;

/** Default recovery budget when the caller gives no `timeoutMs`. */
const DEFAULT_RECOVERY_BUDGET_MS = 30_000;

export interface CreateAwaitingProbeOptions {
  /**
   * ONE budget (ms) for the whole recovery - the refusal's Retry-After plus
   * every probe wait. Default 30 s. Past it the original refusal is rethrown.
   */
  timeoutMs?: number;
  /** Whole-run deadline (epoch ms): nothing starts past it (GislTimeoutError). */
  deadline?: number;
  signal?: AbortSignal;
  /**
   * `false` = do not recover: a refusal is rethrown at once. The ergonomic
   * paths pass `probeBeforeCreate` here, so opting out of the probe wait opts
   * out of this one too (codex ccbe063d8a34). Default true.
   */
  enabled?: boolean;
}

/**
 * `createWorkflow`, recovering from {@link GislProbePendingError}. Per the
 * contract's recovery rule it honours the refusal's Retry-After, waits for the
 * named job's upload probe(s), then re-creates the SAME payload. A no-op when
 * the server never refuses.
 *
 * Rethrows the ORIGINAL typed refusal when recovery is disabled, the budget
 * (`timeoutMs`) cannot fit the Retry-After or the probe does not land within
 * it, the probe lands `corrupt` / `unsupported_codec` (the contract says do
 * not retry), the refusal names no job whose upload is in the payload, or
 * {@link PROBE_PENDING_MAX_CREATE_ATTEMPTS} creates were all refused. Throws
 * {@link GislTimeoutError} when `deadline` would pass first.
 */
export async function createWorkflowAwaitingProbe(
  client: Pick<GislClient, 'createWorkflow' | 'waitForProbe'>,
  payload: WorkflowCreatePayload,
  options: CreateAwaitingProbeOptions = {},
): Promise<WorkflowCreateResponse> {
  let budgetEnd: number | undefined;
  for (let attempt = 1; ; attempt++) {
    // Before EVERY create, the first included: a cancelled run must not create (codex ae65d4f34b8e).
    if (options.signal?.aborted) throw new GislAbortError('Aborted before the workflow could be created');
    let refusal: GislProbePendingError;
    try {
      return await client.createWorkflow(payload);
    } catch (err) {
      if (!(err instanceof GislProbePendingError) || attempt >= PROBE_PENDING_MAX_CREATE_ATTEMPTS) {
        throw err;
      }
      refusal = err;
    }
    if (options.enabled === false) throw refusal;
    const fileIds = uploadFileIdsForJob(payload, refusal.payload?.jobRef);
    if (fileIds.length === 0) throw refusal;
    // One budget for the WHOLE recovery, Retry-After included (codex b08a5036e468):
    // submit() has no run deadline, so without it a server delay was unbounded.
    budgetEnd ??= Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_RECOVERY_BUDGET_MS);
    const until = budgetEnd;
    /** Ms left before the next step would cross the deadline (timeout) or the budget (refusal). */
    const leftBefore = (stepMs: number): number => {
      const now = Date.now();
      if (options.deadline !== undefined && now + stepMs >= options.deadline) {
        throw new GislTimeoutError('maxWait elapsed while recovering from probe_pending');
      }
      if (now + stepMs > until) throw refusal;
      return until - now;
    };
    // The contract's Retry-After is the suggested delay before the next poll/retry (codex 089af94beb8e).
    const retryAfterMs = parseRetryAfterMs(refusal.responseHeaders?.['retry-after']);
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      leftBefore(retryAfterMs);
      await abortableSleep(retryAfterMs, options.signal);
    }
    for (const fileId of fileIds) {
      const budgetLeft = leftBefore(0);
      const deadlineLeft = options.deadline === undefined ? budgetLeft : options.deadline - Date.now();
      const waited = await client.waitForProbe(fileId, {
        timeoutMs: Math.min(budgetLeft, deadlineLeft),
        signal: options.signal,
      });
      const status = waited.probe?.probeStatus;
      if (!waited.landed || status === 'corrupt' || status === 'unsupported_codec') throw refusal;
    }
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      throw new GislTimeoutError('Probe landed but maxWait elapsed before the workflow could be re-created');
    }
  }
}

/**
 * The upload file ids a refusal is about. `jobRef` is the job's own `id`, or
 * the server's `job_N` token for an id-less job at index N. An unmatched ref
 * yields [] so the caller rethrows rather than guessing.
 */
export function uploadFileIdsForJob(payload: WorkflowCreatePayload, jobRef: string | undefined): string[] {
  if (jobRef === undefined) return [];
  let job = payload.jobs.find((j) => j.id === jobRef);
  const auto = /^job_(\d+)$/.exec(jobRef);
  if (job === undefined && auto !== null) {
    const candidate = payload.jobs[Number(auto[1])];
    if (candidate !== undefined && candidate.id === undefined) job = candidate;
  }
  if (job === undefined) return [];
  const ids: string[] = [];
  for (const source of [job.source, ...(job.inputs ?? []).map((input) => input.source)]) {
    const upload = source as { type?: unknown; file_id?: unknown } | undefined | null;
    if (upload?.type === 'upload' && typeof upload.file_id === 'string' && !ids.includes(upload.file_id)) {
      ids.push(upload.file_id);
    }
  }
  return ids;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(new GislAbortError('Aborted while waiting to re-create the workflow'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GislAbortError('Aborted while waiting to re-create the workflow'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
