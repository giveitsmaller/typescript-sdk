import type { WorkflowCreateResponse } from '@giveitsmaller/contracts/openapi';
import type { GislClient } from './client.js';
import type { WorkflowCreatePayload } from './types.js';
/** A landed probe ends the gate server-side, so 3 creates is headroom, not a retry policy. */
export declare const PROBE_PENDING_MAX_CREATE_ATTEMPTS = 3;
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
export declare function createWorkflowAwaitingProbe(client: Pick<GislClient, 'createWorkflow' | 'waitForProbe'>, payload: WorkflowCreatePayload, options?: CreateAwaitingProbeOptions): Promise<WorkflowCreateResponse>;
/**
 * The upload file ids a refusal is about. `jobRef` is the job's own `id`, or
 * the server's `job_N` token for an id-less job at index N. An unmatched ref
 * yields [] so the caller rethrows rather than guessing.
 */
export declare function uploadFileIdsForJob(payload: WorkflowCreatePayload, jobRef: string | undefined): string[];
