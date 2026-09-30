import { _isAnonymousClient } from './client.js';
import { GislAbortError, GislProbePendingError, GislTimeoutError } from './errors.js';
import { parseRetryAfterMs } from './retry-metadata.js';
/** A landed probe ends the gate server-side, so 3 creates is headroom, not a retry policy. */
export const PROBE_PENDING_MAX_CREATE_ATTEMPTS = 3;
/** A guest's delay before its re-create when the refusal carries no Retry-After. */
export const GUEST_BACKOFF_BASE_MS = 1_000;
/**
 * A guest's create cap: `anonymous-policy.yaml` `per_minute.workflow_create`
 * (2). A third create inside the minute would be a 429, not a recovery, so a
 * guest gets ONE re-create (codex 855a879d80d6). Pinned to the policy by
 * scripts/tests/test_guest_create_cap.py.
 */
export const GUEST_MAX_CREATE_ATTEMPTS = 2;
/** Default recovery budget when the caller gives no `timeoutMs`. */
const DEFAULT_RECOVERY_BUDGET_MS = 30_000;
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
export async function createWorkflowAwaitingProbe(client, payload, options = {}) {
    let budgetEnd;
    // Every give-up path rethrows the FIRST refusal, as documented; each retry's
    // own refusal is read only for its Retry-After and job_ref (codex d63a045d884c).
    let original;
    const guest = _isAnonymousClient(client);
    const maxAttempts = guest ? GUEST_MAX_CREATE_ATTEMPTS : PROBE_PENDING_MAX_CREATE_ATTEMPTS;
    for (let attempt = 1;; attempt++) {
        // Before EVERY create, the first included: a cancelled run must not create (codex ae65d4f34b8e).
        if (options.signal?.aborted)
            throw new GislAbortError('Aborted before the workflow could be created');
        let refusal;
        try {
            return await client.createWorkflow(payload);
        }
        catch (err) {
            if (!(err instanceof GislProbePendingError))
                throw err;
            original ??= err;
            if (attempt >= maxAttempts)
                throw original;
            refusal = err;
        }
        const firstRefusal = original;
        if (options.enabled === false)
            throw firstRefusal;
        const fileIds = uploadFileIdsForJob(payload, refusal.payload?.jobRef);
        if (!guest && fileIds.length === 0)
            throw firstRefusal;
        // One budget for the WHOLE recovery, Retry-After included (codex b08a5036e468):
        // submit() has no run deadline, so without it a server delay was unbounded.
        budgetEnd ??= Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_RECOVERY_BUDGET_MS);
        const until = budgetEnd;
        /** Ms left before the next step would cross the deadline (timeout) or the budget (refusal). */
        const leftBefore = (stepMs) => {
            const now = Date.now();
            if (options.deadline !== undefined && now + stepMs >= options.deadline) {
                throw new GislTimeoutError('maxWait elapsed while recovering from probe_pending');
            }
            if (now + stepMs > until)
                throw firstRefusal;
            return until - now;
        };
        // The contract's Retry-After is the suggested delay before the next poll/retry (codex 089af94beb8e).
        const retryAfterMs = parseRetryAfterMs(refusal.responseHeaders?.['retry-after']);
        // anonymous-policy 2.1.0 (5dJrOdVC): the probe endpoint is sign-in only, so a
        // guest RETRIES THE CREATE after Retry-After, or a backoff when the refusal
        // carries none, within GUEST_MAX_CREATE_ATTEMPTS and the same budget.
        const delayMs = retryAfterMs !== undefined && retryAfterMs > 0
            ? retryAfterMs
            : guest
                ? GUEST_BACKOFF_BASE_MS
                : 0;
        if (delayMs > 0) {
            leftBefore(delayMs);
            await abortableSleep(delayMs, options.signal);
        }
        if (guest) {
            // After the sleep, before the re-create: a late timer must not create past
            // the deadline or the budget (codex 08b28b31ad2f).
            leftBefore(0);
            continue;
        }
        for (const fileId of fileIds) {
            const budgetLeft = leftBefore(0);
            const deadlineLeft = options.deadline === undefined ? budgetLeft : options.deadline - Date.now();
            const waited = await client.waitForProbe(fileId, {
                timeoutMs: Math.min(budgetLeft, deadlineLeft),
                signal: options.signal,
            });
            const status = waited.probe?.probeStatus;
            if (!waited.landed || status === 'corrupt' || status === 'unsupported_codec')
                throw firstRefusal;
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
export function uploadFileIdsForJob(payload, jobRef) {
    if (jobRef === undefined)
        return [];
    let job = payload.jobs.find((j) => j.id === jobRef);
    const auto = /^job_(\d+)$/.exec(jobRef);
    if (job === undefined && auto !== null) {
        const candidate = payload.jobs[Number(auto[1])];
        if (candidate !== undefined && candidate.id === undefined)
            job = candidate;
    }
    if (job === undefined)
        return [];
    const ids = [];
    for (const source of [job.source, ...(job.inputs ?? []).map((input) => input.source)]) {
        const upload = source;
        if (upload?.type === 'upload' && typeof upload.file_id === 'string' && !ids.includes(upload.file_id)) {
            ids.push(upload.file_id);
        }
    }
    return ids;
}
function abortableSleep(ms, signal) {
    if (signal?.aborted)
        return Promise.reject(new GislAbortError('Aborted while waiting to re-create the workflow'));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
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
