// dql51via: recovery from a `422 probe_pending` on workflow create. A module
// function over two client methods (not a GislClient method body) so every
// ergonomic create site shares it and a test double needs only
// `createWorkflow` + `waitForProbe`.
import type { WorkflowCreateResponse } from '@giveitsmaller/contracts/openapi';

import { _isAnonymousClient, type GislClient } from './client.js';
import {
  GislAbortError,
  GislApiError,
  GislLongFormConcurrencyError,
  GislProbePendingError,
  GislTimeoutError,
} from './errors.js';
import { parseRetryAfterMs } from './retry-metadata.js';
import type { WorkflowCreatePayload } from './types.js';

/**
 * The first gap between two creates of one recovery when no Retry-After asks
 * for more; doubles per create. Paces a guest's re-creates and, since Hal5c41E,
 * a signed-in caller's: a signed-in `probe_pending` refusal costs a
 * `workflow_create` token (compression_api WorkflowController.php:264-270), and
 * the Free tier allows 10/min, 50/h and 200/day (TieredRateLimiterService.php,
 * an API implementation fact, not contract). Measured from the previous
 * create's START, this schedule makes at most 6 creates in any 60 s and about
 * 36 in 900 s.
 */
export const GUEST_BACKOFF_BASE_MS = 1_000;
/** The longest the doubling create backoff grows to (guest and signed-in). */
export const GUEST_BACKOFF_MAX_MS = 30_000;
/**
 * Timer slack allowed for the last create at the budget boundary: a wake-up
 * later than this past the budget rethrows instead of creating (codex a7a76673694a).
 */
const BOUNDARY_SLACK_MS = 1_000;
/**
 * How far past the server's gate opening (the first refusal plus
 * PROBE_WAIT_BOUND_MS) the boundary create starts: past the DEFAULT budget's end,
 * or inside an explicit budget that reaches it (a shorter one gets none). The server stops gating only when `waitedSeconds > 900`,
 * strict, in WHOLE seconds from the upload's timestamp
 * (compression_api CreateWorkflowCommandHandler.php:3095-3096), so a create at
 * exactly 900 s can still be refused: it must land about 1 s plus the
 * truncation after the bound. 2 s covers both.
 */
const BOUNDARY_MARGIN_MS = 2_000;
/**
 * The default recovery budget for EVERY caller: the contract's
 * `video.probe_wait_bound_seconds` (900 s; anonymous-policy.yaml, api.yaml's
 * probe_pending description, and the API's PROBE_PENDING_MAX_WAIT_SECONDS).
 * Past that bound after the upload the API stops answering `probe_pending` and
 * proceeds, so waiting longer is pointless and giving up sooner fails a run the
 * server would accept (fNSQUeDS, Hal5c41E). No generated runtime constant
 * carries it, so it is a literal pinned to the policy by
 * scripts/tests/test_guest_create_cap.py. The caller's `timeoutMs` and
 * `deadline` still win.
 */
export const PROBE_WAIT_BOUND_MS = 900_000;

export interface CreateAwaitingProbeOptions {
  /**
   * ONE budget (ms) for the whole recovery - the refusal's Retry-After plus
   * every probe wait and create gap. Default {@link PROBE_WAIT_BOUND_MS}
   * (900 s), for guests and signed-in callers alike. Past it the original
   * refusal is rethrown. The DEFAULT budget ends with a boundary create about
   * 2 s past it; an explicit one is a strict cap: no create is scheduled past
   * it, and a late timer may start one at most 1 s past. An explicit budget of
   * at least about 902 s makes that one create once the server's 900 s bound has
   * passed, and stops polling there.
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
 * named job's upload probe(s), then re-creates the SAME payload. An upload whose
 * probe is `not_applicable` (never probed) is skipped, not waited on. A no-op
 * when the server never refuses.
 *
 * A signed-in recovery has no create-count cap: the budget alone ends it. It
 * polls the probe patiently (`waitForProbe({ patient: true })`), spaces its
 * creates by the doubling backoff above, and waits out a create refused with a
 * plain `429 TOO_MANY_REQUESTS` (Hal5c41E).
 *
 * Rethrows the ORIGINAL typed refusal when recovery is disabled, the budget
 * (`timeoutMs`) cannot fit the next wait or the probe does not land within
 * it, the probe lands `corrupt` / `unsupported_codec` (the contract says do
 * not retry), or the refusal names no job whose upload is in the payload.
 * Throws {@link GislTimeoutError} when `deadline` would pass first.
 */
export async function createWorkflowAwaitingProbe(
  client: Pick<GislClient, 'createWorkflow' | 'waitForProbe'>,
  payload: WorkflowCreatePayload,
  options: CreateAwaitingProbeOptions = {},
): Promise<WorkflowCreateResponse> {
  const budgetMs = Math.max(0, options.timeoutMs ?? PROBE_WAIT_BOUND_MS);
  // Only the DEFAULT budget waits for the server's bypass with a create past its
  // end; an explicit timeoutMs, however long, is a strict cap (codex DISCUSS on
  // #562, 4v7Vwvcw): its last create stays at its own end.
  const defaultBudget = options.timeoutMs === undefined;
  const boundaryMarginMs = defaultBudget ? BOUNDARY_MARGIN_MS : 0;
  let budgetEnd: number | undefined;
  // When the server's gate is known to be open: the contract bound after the
  // FIRST refusal, which comes after the upload the server measures from.
  let gateOpenAt: number | undefined;
  // Every give-up path rethrows the FIRST refusal, as documented; each retry's
  // own refusal is read only for its Retry-After and job_ref (codex d63a045d884c).
  let original: GislProbePendingError | undefined;
  const guest = _isAnonymousClient(client);
  // A guest's last create lands AT the budget boundary, not one backoff short of it.
  let guestFinalCreate = false;
  // Signed-in: when the previous create STARTED; the next one is paced from it.
  let lastCreateAt = 0;
  // Signed-in: the one create allowed at the budget boundary has been made.
  let boundaryCreateMade = false;
  const timeout = (): GislTimeoutError => new GislTimeoutError('maxWait elapsed while recovering from probe_pending');

  /**
   * Signed-in: sleep until the next create may start - the previous create's
   * start plus max(Retry-After, doubling backoff); the boundary create waits
   * until `boundaryAt`. A start past the budget rethrows `firstRefusal` without
   * creating (the default budget's boundary create: past `boundaryAt` plus timer
   * slack); one past the deadline throws GislTimeoutError.
   */
  const paceCreate = async (
    createsMade: number,
    retryAfterMs: number | undefined,
    until: number,
    boundaryAt: number | undefined,
    firstRefusal: GislProbePendingError,
  ): Promise<void> => {
    const pacedAt = lastCreateAt + createGapMs(createsMade, retryAfterMs);
    const startAt = boundaryAt !== undefined ? Math.max(pacedAt, boundaryAt) : pacedAt;
    const latestStart = (boundaryAt ?? until) + BOUNDARY_SLACK_MS;
    // The default budget's boundary create is scheduled past the budget by design;
    // under an explicit budget nothing is scheduled past it (strict cap).
    const scheduleLimit = boundaryAt !== undefined && defaultBudget ? latestStart : until;
    if (options.deadline !== undefined && startAt >= options.deadline) throw timeout();
    if (startAt > scheduleLimit) throw firstRefusal;
    const waitMs = startAt - Date.now();
    if (waitMs > 0) await abortableSleep(waitMs, options.signal);
    // A late timer must not create past the deadline, nor past the budget
    // beyond a timer's slack (codex 08b28b31ad2f, a7a76673694a).
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw timeout();
    if (Date.now() > latestStart) throw firstRefusal;
  };

  for (let attempt = 1; ; attempt++) {
    // Before EVERY create, the first included: a cancelled run must not create (codex ae65d4f34b8e).
    if (options.signal?.aborted) throw new GislAbortError('Aborted before the workflow could be created');
    let refusal: GislProbePendingError;
    lastCreateAt = Date.now();
    try {
      return await client.createWorkflow(payload);
    } catch (err) {
      // Signed-in, mid-recovery: our own re-creates spent the workflow_create
      // bucket, so a plain rate-limit 429 is waited out, not fatal (Hal5c41E).
      // A guest keeps rethrowing it, as do DUPLICATE_IN_PROGRESS (card 8EjLIvkE)
      // and the long-form concurrency 429, which no back-off clears.
      if (!guest && original !== undefined && budgetEnd !== undefined && isCreateRateLimit(err)) {
        const retryAfterMs = parseRetryAfterMs(err.responseHeaders?.['retry-after']);
        await paceCreate(attempt, retryAfterMs, budgetEnd, undefined, original);
        continue;
      }
      if (!(err instanceof GislProbePendingError)) throw err;
      original ??= err;
      refusal = err;
    }
    const firstRefusal = original;
    if (options.enabled === false) throw firstRefusal;
    // Signed-in: the boundary create was the last one.
    if (boundaryCreateMade) throw firstRefusal;
    const fileIds = uploadFileIdsForJob(payload, refusal.payload?.jobRef);
    if (!guest && fileIds.length === 0) throw firstRefusal;
    // One budget for the WHOLE recovery, Retry-After included (codex b08a5036e468):
    // submit() has no run deadline, so without it a server delay was unbounded.
    if (budgetEnd === undefined) {
      const recoveryStart = Date.now();
      budgetEnd = recoveryStart + budgetMs;
      gateOpenAt = recoveryStart + PROBE_WAIT_BOUND_MS;
    }
    const until = budgetEnd;
    const gateOpen = gateOpenAt as number;
    // ONE rule for every budget: the boundary create lands BOUNDARY_MARGIN_MS past
    // the open gate, when the caller gave no budget (the default, which then ends
    // that margin late) or an explicit one that reaches it (within its cap).
    const boundaryAt = gateOpen + BOUNDARY_MARGIN_MS;
    const boundaryAllowed = defaultBudget || boundaryAt <= until;
    /** Ms left before the next step would cross the deadline (timeout) or the budget (refusal). */
    const leftBefore = (stepMs: number): number => {
      const now = Date.now();
      if (options.deadline !== undefined && now + stepMs >= options.deadline) throw timeout();
      if (now + stepMs > until) throw firstRefusal;
      return until - now;
    };
    // The contract's Retry-After is the suggested delay before the next poll/retry (codex 089af94beb8e).
    const retryAfterMs = parseRetryAfterMs(refusal.responseHeaders?.['retry-after']);
    // anonymous-policy 2.1.0 (5dJrOdVC): the probe endpoint is sign-in only, so a
    // guest RETRIES THE CREATE after Retry-After, or a doubling backoff (capped at
    // GUEST_BACKOFF_MAX_MS) when the refusal carries none, until the budget runs out.
    const delayMs =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? retryAfterMs
        : guest
          ? Math.min(GUEST_BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 15), GUEST_BACKOFF_MAX_MS)
          : 0;
    if (guest) {
      if (guestFinalCreate) throw firstRefusal;
      // When the next wait would cross the budget, wait only what is left and make
      // ONE last create at the boundary: the server starts accepting just past the
      // policy bound (codex 781cae520a36). Under the default budget the wait runs
      // BOUNDARY_MARGIN_MS past it, since the server's check is strict on whole
      // seconds (Hal5c41E); an explicit budget is honoured exactly (4v7Vwvcw).
      // The deadline still wins.
      const now = Date.now();
      let waitMs = delayMs;
      if (now + waitMs >= until) {
        waitMs = Math.max(0, until + boundaryMarginMs - now);
        guestFinalCreate = true;
      }
      if (options.deadline !== undefined && now + waitMs >= options.deadline) throw timeout();
      if (waitMs > 0) await abortableSleep(waitMs, options.signal);
      // A late timer must not create past the deadline (codex 08b28b31ad2f), nor
      // past the budget beyond a timer's slack (codex a7a76673694a).
      if (options.deadline !== undefined && Date.now() >= options.deadline) throw timeout();
      if (Date.now() > until + boundaryMarginMs + BOUNDARY_SLACK_MS) throw firstRefusal;
      continue;
    }
    if (delayMs > 0) {
      leftBefore(delayMs);
      await abortableSleep(delayMs, options.signal);
    }
    let atBoundary = false;
    for (const fileId of fileIds) {
      // Polling stops once the server's gate is known to be open: past it a create
      // is accepted whether or not the probe has landed.
      const probeEnd = Math.min(until, gateOpen);
      const probeLeft = Math.max(0, Math.min(leftBefore(0), probeEnd - Date.now()));
      const deadlineLeft = options.deadline === undefined ? probeLeft : options.deadline - Date.now();
      const waited = await client.waitForProbe(fileId, {
        timeoutMs: Math.min(probeLeft, deadlineLeft),
        signal: options.signal,
        // Spaced polls, and a probe 429 waited out: the per-user probe bucket is
        // 10/min on Free, which a 900 s wait at the default cadence would exhaust.
        patient: true,
      });
      // A never-probed upload (e.g. a watermark image beside the video) has no
      // probe to wait for, so it cannot be what the gate is holding: move on to
      // the job's other uploads, then re-create (8L4JJMx6). A slow answer must not
      // carry the recovery past its budget (codex ab487dee4814).
      if (waited.reason === 'not_applicable') {
        leftBefore(0);
        continue;
      }
      if (waited.landed) {
        const status = waited.probe?.probeStatus;
        if (status === 'corrupt' || status === 'unsupported_codec') throw firstRefusal;
        continue;
      }
      // The probe did not land. A passed deadline is a timeout, not a refusal.
      const now = Date.now();
      if (options.deadline !== undefined && now >= options.deadline) throw timeout();
      // ONE last create past the open gate, when the boundary is allowed (above),
      // the gate clamp rather than the deadline ended the wait, and only on time.
      // Safe because the server's bound runs from the UPLOAD, while gateOpen is
      // measured from the first refusal, which comes after the upload: so
      // boundaryAt > upload + 900 s, and by then the server has stopped gating.
      if (
        waited.reason === 'timeout' &&
        boundaryAllowed &&
        probeLeft <= deadlineLeft &&
        now >= probeEnd &&
        now <= probeEnd + BOUNDARY_SLACK_MS
      ) {
        atBoundary = true;
        break;
      }
      throw firstRefusal;
    }
    if (!atBoundary && options.deadline !== undefined && Date.now() >= options.deadline) {
      throw new GislTimeoutError('Probe landed but maxWait elapsed before the workflow could be re-created');
    }
    await paceCreate(attempt, retryAfterMs, until, atBoundary ? boundaryAt : undefined, firstRefusal);
    boundaryCreateMade = atBoundary;
  }
}

/** The gap between a create's start and the next: max(Retry-After, doubling backoff). */
function createGapMs(createsMade: number, retryAfterMs: number | undefined): number {
  const backoffMs = Math.min(GUEST_BACKOFF_BASE_MS * 2 ** Math.min(createsMade - 1, 15), GUEST_BACKOFF_MAX_MS);
  return Math.max(retryAfterMs ?? 0, backoffMs);
}

/**
 * A plain rate-limit refusal of a create: a 429 carrying `TOO_MANY_REQUESTS`.
 * The SDK has no dedicated class for it, so it is a base GislApiError; the
 * long-form concurrency 429 is excluded by class, since waiting does not clear it.
 */
function isCreateRateLimit(err: unknown): err is GislApiError {
  return (
    err instanceof GislApiError &&
    !(err instanceof GislLongFormConcurrencyError) &&
    err.statusCode === 429 &&
    err.errorCode === 'TOO_MANY_REQUESTS'
  );
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
