import type { WorkflowCreateResponse } from '@giveitsmaller/contracts/openapi';
import { type GislClient } from './client.js';
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
export declare const GUEST_BACKOFF_BASE_MS = 1000;
/** The longest the doubling create backoff grows to (guest and signed-in). */
export declare const GUEST_BACKOFF_MAX_MS = 30000;
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
export declare const PROBE_WAIT_BOUND_MS = 900000;
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
export declare function createWorkflowAwaitingProbe(client: Pick<GislClient, 'createWorkflow' | 'waitForProbe'>, payload: WorkflowCreatePayload, options?: CreateAwaitingProbeOptions): Promise<WorkflowCreateResponse>;
/**
 * The upload file ids a refusal is about. `jobRef` is the job's own `id`, or
 * the server's `job_N` token for an id-less job at index N. An unmatched ref
 * yields [] so the caller rethrows rather than guessing.
 */
export declare function uploadFileIdsForJob(payload: WorkflowCreatePayload, jobRef: string | undefined): string[];
