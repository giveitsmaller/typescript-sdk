import type { AudioWatermarkDecodeRequest, AudioWatermarkDecodeResponse, ExternalImportCreatedResponse, ExternalImportRequest, LoginUserRequest, LoginUser200ResponseData, ContactRequest, BillingCheckoutRequest, BillingCheckoutSession, AccountLimits, CreditsBalanceResponse, CreditsUsageResponse, UploadResponse, UploadProbeResponse, WorkflowCancelResponse, WorkflowArchiveResponse, WorkflowRestoreResponse, WorkflowCreateResponse, WorkflowResumeResponse, WorkflowStatusResponse, WorkflowListResponse, WorkflowSummary, WorkflowDownloadResponse, MetadataResponse, RetryResponse } from '@giveitsmaller/contracts/openapi';
import type { CreditsUsageOptions, ListWorkflowsOptions, GetSchemaOptions, GetSchemaResult, GislClientConfig, GislSseEvent, GislSseParseFailure, PreflightClipsResult, ProbeWaitOptions, ProbeWaitResult, ReadCapabilityOptions, UploadOptions, WaitOptions, WorkflowCreatePayload, _Sdk3HandCodedKeepaliveResult, _Sdk3HandCodedMultipartStatusResult, _Sdk3HandCodedPresignPartsResult } from './types.js';
export declare const MULTIPART_CONCURRENCY_DEFAULT: 4;
export declare const DEFAULT_MULTIPART_FIRST_CHUNK_SIZE: number;
/**
 * THE ONE DEADLINE DEFAULT (36AZ98FV). One wall-clock deadline covers the whole
 * operation — upload, create, wait, downloads. Every entry point that takes a
 * `maxWait` defaults to THIS value; a caller who passes one overrides it, and a
 * caller who does not gets the same deadline whichever spelling they used.
 *
 * ⚠️ EXPORTED FOR REUSE, NOT FOR CONSUMERS. It is deliberately absent from the
 * package entry points, so it does not reach the public API surface and the
 * committed export snapshots do not move. Before this ticket the number was
 * already named here and in PHP's `WorkflowConstants`, and hard-coded at
 * FOURTEEN defaulting sites anyway — which is the duplication this replaces.
 */
export declare const DEFAULT_POLL_TIMEOUT_MS = 600000;
export interface ValidationDetail {
    message: string;
    field?: string;
    operation?: string;
    option?: string;
    messageKey?: string;
    locale?: string;
    messageParams?: Record<string, unknown>;
}
export declare class GislClient {
    private readonly baseUrl;
    /**
     * Declared SSE stream host, or `null` when nothing declares one for this
     * configuration. `null` is a legitimate state, not a misconfiguration —
     * see `streamEvents`, which fails closed on it rather than falling back to
     * `baseUrl`.
     */
    private readonly streamBaseUrl;
    private readonly headers;
    private readonly timeoutMs;
    private readonly multipartThreshold;
    private readonly multipartConcurrency;
    private readonly multipartMaxAttempts;
    private readonly multipartRetryBaseMs;
    private readonly useSessionCookie;
    constructor(config: GislClientConfig);
    private request;
    private handleResponse;
    private isAuthErrorType;
    /**
     * Upload a file. Automatically uses multipart upload for files exceeding
     * the configured threshold (default 10 MB).
     *
     * @param file  File path (string) or a Blob/File instance.
     * @param options  Upload options including progress callback.
     */
    uploadFile(file: string | Blob, options?: UploadOptions): Promise<UploadResponse>;
    private singleUpload;
    /**
     * Direct-to-S3 multipart upload for files above the threshold.
     *
     * The /multipart/complete response (MultipartCompleteResponse) only carries
     * { upload_id, status }. The server's upload_id is the same UUID callers
     * pass as file_id to POST /api/workflows — so fileId is synthesised from
     * upload_id and a full UploadResponse is returned to keep the public
     * uploadFile() API uniform across single and multipart paths. The mimeType
     * comes from the initiate response's first-chunk detection; for authoritative
     * post-upload metadata callers should use getMetadata(fileId).
     */
    private multipartUpload;
    /**
     * SDK-3 (Wb6ebOMM): resume an in-progress multipart upload.
     *
     * Skips `/multipart/initiate` entirely (the original initiate happened in a
     * prior process). Walks `/status` for the authoritative list of recorded
     * parts, re-presigns the missing ones in batches of <=100, PUTs only those,
     * and finalises with `/complete`. Caller's `source` MUST be byte-identical
     * to the originally-uploaded file at the same offsets (parts whose etags
     * don't match server state will fail `/complete`).
     *
     * Re-runs the same `uploadId` / `chunkSize` / `totalParts` / plan-consistency
     * guards as the fresh-upload path (`multipartUpload`), using the /status
     * envelope as the equivalent of the initiate envelope. Reuses the same
     * `failureController` sibling-wake + `drainResponseBody` cleanup discipline
     * as the fresh-upload PUT loop. `onProgress` fires on entry seeded from
     * (uploadedPartNumbers.length * chunkSize) and again after every successful
     * PUT. `onCheckpoint` fires OUTSIDE the retry-scoped path after every
     * successful PUT — a callback-throw must not trigger a duplicate PUT.
     *
     * TODO(HxUmVr3Y): replace inline hand-coded request body marshalling on regen.
     */
    private multipartResume;
    /**
     * Fetch the durable status of an in-progress multipart upload session.
     *
     * Walks every page of `GET /api/uploads/multipart/{uploadId}/status`
     * (paginated via `next_part_number_marker` + `is_truncated`) and returns
     * the aggregated state. Callers see the complete set of recorded parts
     * across pages without driving the cursor themselves.
     *
     * Anonymous-initiated sessions return 403 → `GislMultipartSessionAuthRequiredError`.
     * Non-existent / expired sessions return 404 → `GislMultipartSessionNotFoundError`.
     * Authed-but-non-owning callers return 403 → `GislMultipartSessionOwnershipError`.
     *
     * TODO(HxUmVr3Y): replace hand-coded response shape on regen.
     */
    getUploadStatus(uploadId: string, opts?: {
        signal?: AbortSignal;
    }): Promise<_Sdk3HandCodedMultipartStatusResult>;
    /**
     * Re-presign a batch of missing part numbers on an in-progress multipart
     * session.
     *
     * Validates client-side BEFORE the HTTP round-trip:
     * - `partNumbers` non-empty
     * - length <=100 (server raw-body cap is 8 KiB before json_decode)
     * - every entry an integer in `[2, totalParts]` — part 1 is sealed at
     *   initiate (re-presigning it would break the etag recorded server-side
     *   for /complete)
     * - entries unique
     * - `totalParts` <=10 000 (S3 hard limit; mirrors the SDK-1 ceiling guard)
     *
     * TODO(HxUmVr3Y): replace hand-coded request/response shapes on regen.
     */
    presignParts(uploadId: string, partNumbers: readonly number[], totalParts: number, opts?: {
        signal?: AbortSignal;
    }): Promise<_Sdk3HandCodedPresignPartsResult>;
    /**
     * Extend the manifest TTL of an in-progress multipart upload session.
     *
     * The durable session manifest defaults to a 48 h TTL (decoupled from the
     * shorter presigned-URL TTL). For a long-running resume that spans days
     * (e.g. an upload paused overnight on flaky Wi-Fi), callers SHOULD invoke
     * `keepaliveUpload` every **12-24 h** while resuming — the 12-24 h band
     * leaves >=24 h of slack against the 48 h ceiling even with worst-case
     * clock skew between client and server. The server atomically refreshes
     * the Redis EXPIRE for the manifest key; the call is idempotent.
     *
     * TODO(HxUmVr3Y): replace hand-coded response shape on regen.
     */
    keepaliveUpload(uploadId: string, opts?: {
        signal?: AbortSignal;
    }): Promise<_Sdk3HandCodedKeepaliveResult>;
    /**
     * Private walk-pagination helper for /status. Aggregates every page into
     * a single `_Sdk3HandCodedMultipartStatusResult`. AbortSignal short-circuits
     * the loop between page fetches AND propagates into each fetch.
     *
     * Limit pinned to 1000 (max per page) so we make the minimum number of
     * round-trips even for the worst-case ~10 pages on a 10 000-part upload.
     */
    private walkUploadStatus;
    /**
     * Create a new workflow.
     */
    createWorkflow(payload: WorkflowCreatePayload): Promise<WorkflowCreateResponse>;
    /**
     * Get current workflow status.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    getWorkflowStatus(workflowId: string, opts?: ReadCapabilityOptions): Promise<WorkflowStatusResponse>;
    /**
     * Poll until the workflow reaches a terminal status.
     */
    waitForWorkflow(workflowId: string, options?: WaitOptions): Promise<WorkflowStatusResponse>;
    /**
     * Cancel a workflow. Idempotent — cancelling an already-cancelled
     * workflow returns 200 with the same shape (and the original
     * `cancelledAt`). Cancelling a `completed` / `failed` /
     * `partially_failed` / `expired` workflow returns 409.
     *
     * The response's `billingEffect` field tells the caller what
     * happened to outstanding reservations:
     * - `unspent_reservation_released` — workflow was active or paused
     *   and the unspent portion of the reservation has been refunded.
     *   The refund appears as a separate `CreditTransaction` with
     *   `type: refund`.
     * - `none` — no refund (all reserved credits were already consumed
     *   by completed jobs, or this is an idempotent re-cancel).
     *
     * In-flight operations may continue running briefly after the
     * cancel response while their Lambda processes terminate; the
     * response is the binding "no further reservations will be made"
     * signal.
     */
    cancelWorkflow(workflowId: string): Promise<WorkflowCancelResponse>;
    /**
     * Archive a TERMINAL workflow (mWQsiUun): a recoverable declutter, not a delete.
     * It drops out of {@link listWorkflows} by default; every record stays readable
     * via {@link getWorkflowStatus} and its downloads, and {@link restoreWorkflow}
     * brings it back. Idempotent: archiving an already-archived workflow is a 200.
     *
     * @throws {GislApiError} 409 while the workflow is still `pending` /
     *   `in_progress` / `paused_insufficient_credits` - only terminal workflows are
     *   archivable (cancel it first); 404 when it does not exist or is not the
     *   caller's (the same shape, so ownership does not leak).
     */
    archiveWorkflow(workflowId: string): Promise<WorkflowArchiveResponse>;
    /**
     * Restore an archived workflow to the default {@link listWorkflows} view
     * (mWQsiUun). The inverse of {@link archiveWorkflow}; idempotent.
     */
    restoreWorkflow(workflowId: string): Promise<WorkflowRestoreResponse>;
    /**
     * Resume a workflow that is in `paused_insufficient_credits`.
     *
     * Resume succeeds only when `availableCredits` covers the next
     * reservation. If the balance is still insufficient, throws
     * `GislBalanceExhaustedError` (402, same envelope as the workflow-
     * create 402 path) and the workflow stays paused. If the workflow
     * is past its `expiresAt` (default 7-day TTL from `pausedAt`),
     * throws `GislWorkflowExpiredError` (422) and the workflow has
     * transitioned to `expired` — callers cannot un-expire a workflow.
     * Resuming a workflow that is not in `paused_insufficient_credits`
     * is a 409 (no-op).
     */
    resumeWorkflow(workflowId: string): Promise<WorkflowResumeResponse>;
    /**
     * Get download URLs for a completed workflow.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    getWorkflowDownloads(workflowId: string, opts?: ReadCapabilityOptions): Promise<WorkflowDownloadResponse>;
    /**
     * Stream SSE events for a workflow. Returns an async iterable.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    streamEvents(workflowId: string, opts?: {
        signal?: AbortSignal;
        capability?: string;
        /**
         * Observe malformed-JSON SSE frames (TYNjcjpo). A frame whose `data:` body
         * fails to parse is SKIPPED from the stream (kept resilient) and reported
         * here as a typed {@link GislSseParseFailure} instead of being silently lost.
         * Omit to drop malformed frames silently (the default; PHP parity).
         */
        onParseError?: (diagnostic: GislSseParseFailure) => void;
    }): Promise<AsyncGenerator<GislSseEvent>>;
    /**
     * Get metadata for an uploaded file.
     */
    getMetadata(fileId: string): Promise<MetadataResponse>;
    /**
     * Get the operations schema (available types, options, constraints).
     *
     * Returns raw JSON (no envelope). The response is **per-tier private**
     * (cache key includes the caller's `user_tier`); CDN-style public
     * caching is not used. Pass `ifNoneMatch` / `ifModifiedSince` from a
     * previous response to revalidate — a 304 surfaces as
     * `{ notModified: true, etag, lastModified }` so callers can keep
     * using their cached copy.
     *
     * NOTE: this schema describes available types/options/availability — it does
     * NOT carry per-tier processing-class size/duration caps (the response shape
     * has no `processing_class` / `per_tier_constraints`). The typed operation
     * metadata's `AvailabilityEntry.constraints` is the conservative baseline
     * only. Per-tier caps are enforced server-side: the caps that applied to an
     * upload are reported on a successful `UploadResponse.constraintsApplied`,
     * and an exceeded limit throws `GislUploadCapExceededError` (the 422 path
     * carries a typed payload; the 413 absolute-cap path is a plain envelope).
     * There is no read-ahead per-tier-cap API today.
     */
    getSchema(options?: GetSchemaOptions): Promise<GetSchemaResult>;
    /**
     * Retry a failed operation.
     */
    retryOperation(operationId: string): Promise<RetryResponse>;
    /**
     * Submit a contact-form message. The endpoint returns 204 No Content on
     * success, so this method resolves to `void`.
     *
     * Validation errors (e.g. missing `email`, non-empty honeypot `website`)
     * surface as `GislValidationError` from the standard error envelope.
     */
    submitContact(payload: ContactRequest): Promise<void>;
    /**
     * Start a Stripe hosted-Checkout session for a subscription upgrade or a
     * credit pack (2AkFcgxY). `POST /api/billing/checkout`; redirect the browser to
     * the returned `checkoutUrl`. The redirect targets are server-set.
     *
     * A credit PACK's grant is ASYNCHRONOUS: the balance may still show the
     * pre-purchase value when the user returns. Correlate by polling
     * {@link getCreditsUsage} for a transaction whose `referenceType` is
     * `stripe_checkout_session` and whose `referenceId` equals `sessionId` - do
     * not filter on `type` (a pack grant is an `adjustment`). No timing is
     * contracted; an absent grant is pending, not failed. The contract defines
     * this ledger row for packs only - not for a subscription checkout.
     *
     * The two deployment failures stay distinguishable - they mean opposite
     * things:
     * @throws {GislFeatureNotAvailableError} 422 `feature_not_available`:
     *   checkout is flagged OFF on this server.
     * @throws {GislApiError} `statusCode` 503, `errorCode` `SERVICE_UNAVAILABLE`:
     *   the flag is ON but Stripe is not configured.
     * @throws {GislApiError} 422 `VALIDATION_FAILED` / `UNPROCESSABLE_ENTITY`
     *   for a missing or unresolvable `type` + `key` pair (pairing is checked
     *   server-side).
     */
    createCheckoutSession(payload: BillingCheckoutRequest): Promise<BillingCheckoutSession>;
    /**
     * Get a snapshot of the caller's current credit position. The canonical
     * billing-state surface — `BalanceExhaustedResponse` (402) on workflow
     * creation includes pre-error counters for context, but UIs should drive
     * spend-now affordances and tier-upgrade prompts off this endpoint, not
     * off the error envelope.
     */
    getCreditsBalance(): Promise<CreditsBalanceResponse>;
    /**
     * Fetch the caller's effective account limits (the tier-resolved caps:
     * upload/merge size + total caps, surfaced override-aware). `GET
     * /api/v2/account/limits`. The success envelope's `data` is unwrapped to the
     * {@link AccountLimits} model (mirrors {@link getCreditsBalance}).
     */
    getAccountLimits(): Promise<AccountLimits>;
    /**
     * Authenticate with email/password. On success the server issues a
     * session cookie via `Set-Cookie`; subsequent requests authenticate
     * via that cookie when the client is configured with
     * `useSessionCookie: true`.
     *
     * Failure modes per ticket FX6mbTJD (login narrowed at contracts
     * v2.166.0 authsec — no 403 account-state branch on login):
     * - **401** `invalid_credentials` (wrong password, unverified, OR
     *   unknown account — all collapsed for anti-enumeration) →
     *   `GislAuthError`.
     * - **429** infrastructure rate-limit → `GislApiError` with
     *   the `Retry-After` header echoed on the response.
     *
     * The account-status error types (`account_locked` / `account_disabled`
     * / `account_deleted` / `account_deletion_expired`) still exist but are
     * emitted on the API-key path + live-session enforcement, not on login.
     *
     * Node session persistence (cookie-jar across processes) is out of
     * scope — this method only touches the request side.
     */
    login(credentials: LoginUserRequest): Promise<LoginUser200ResponseData>;
    /**
     * Invalidate the current session.
     *
     * Idempotent: calling logout without an active session returns 401,
     * but the SDK collapses both 200 and 401 into a single "logged out"
     * outcome — `logout()` resolves to `void` in either case so caller
     * cleanup code does not need to special-case the not-currently-
     * authenticated path. Other errors (e.g. 500, network failures)
     * still throw.
     */
    logout(): Promise<void>;
    /**
     * Register a one-shot bearer URL (S3 presigned, GCS signed, Azure
     * SAS, Dropbox shared link, public HTTPS) and receive an opaque
     * `externalSourceId` handle. Subsequent workflows reference the
     * handle via `WorkflowSource` of `type: external_import` —
     * compose with the [`externalImportSource()`](./types.ts) factory.
     *
     * Per ADR-0005 §"SSRF posture": the server validates 8 rules at
     * registration time AND again at fetch time. HTTPS-only;
     * private/loopback/cloud-metadata IPs are rejected (403). The
     * original URL + password are encrypted at rest and never
     * returned in any response.
     *
     * Currently `availability: planned` — the runtime endpoint returns
     * 422 `feature_not_available` (or 404, per the cross-repo rollout)
     * until the external-import infrastructure ships. The method
     * exists today so consumers can write the integration ahead of
     * time.
     *
     * Auth-ownership: the import id this returns is owned by the
     * authenticated caller that created it. Referencing it from a client
     * with a different auth context 404s `upload_not_found` at
     * workflow-create — same ownership rule as `fileInput.uploadId` (api
     * PqpD9ySv).
     */
    createExternalImport(payload: ExternalImportRequest): Promise<ExternalImportCreatedResponse>;
    /**
     * Decode a previously-embedded steganographic audio watermark
     * (per ticket I20). Pairs with the `audio_watermark` operation —
     * the operation embeds; this endpoint decodes.
     *
     * **Enterprise tier only.** Free / pro callers receive
     * `GislFeatureTierRestrictedError` (403).
     *
     * **Own watermarks only.** The decoder will refuse to extract from
     * media the caller did not mark themselves — mismatches return 404
     * (rather than leaking that *some* watermark was detected).
     *
     * Currently `availability: planned` — calls return
     * `GislFeatureNotAvailableError` (422) until the cross-repo Lambda
     * support ships. Decode requests are rate-limited independently
     * from workflow-create.
     */
    decodeAudioWatermark(payload: AudioWatermarkDecodeRequest): Promise<AudioWatermarkDecodeResponse>;
    /**
     * Probe an uploaded file for workflow-readiness — detects corruption,
     * unsupported codecs, and pre-assigns the processing class the server
     * would route the file to. For video uploads the probe also lands the
     * codec + duration the server needs to admit the parallel split, so
     * calling this (or {@link waitForProbe}) before workflow-create is the
     * structural unlock for the fast video path on the multipart flow.
     *
     * Endpoint availability is `stable`. The probe runs asynchronously after
     * upload: until the result has landed, this returns `422`
     * `feature_not_available` (surfaced as {@link GislFeatureNotAvailableError})
     * — i.e. that 422 means "probe not landed yet", NOT "not implemented". Once
     * landed it returns a `200` with any `probeStatus`. Idempotent: probing the
     * same `fileId` twice returns the cached result. See {@link waitForProbe}
     * for a bounded poll that turns this into a single ready/gave-up answer.
     */
    probeUpload(fileId: string, options?: {
        signal?: AbortSignal;
    }): Promise<UploadProbeResponse>;
    /**
     * Bounded poll of {@link probeUpload} until the probe lands — the helper
     * frontends call between upload-complete and workflow-create so the server
     * sees the video's codec + duration and admits the ~3× parallel split.
     *
     * Loop (per the API wire contract):
     * - `422 feature_not_available` → probe not landed yet → keep polling
     *   (exponential full-jitter backoff, honouring a `Retry-After` header when
     *   present, clamped to the remaining budget).
     * - any `200` → STOP. Resolves `{ landed: true, probe }` regardless of
     *   `probeStatus` (ok / corrupt / unsupported_codec / missing_metadata) —
     *   the server + fan-out gate decide split-vs-single from the landed
     *   metadata; the SDK does not interpret it.
     * - `5xx` (prober crash) → retry a couple of times, then give up.
     * - timeout → give up.
     *
     * **Never bounces:** on give-up (timeout / repeated 5xx / transport) it
     * resolves `{ landed: false, reason }` rather than throwing, so the caller
     * proceeds to create the workflow anyway (the server's size heuristic routes
     * it; worst case = today's single-task behaviour). Genuine failures —
     * `404 upload_not_found`, auth errors, or caller abort — DO propagate (they
     * are not "probe not ready"), so a real problem is never silently swallowed.
     *
     * `timeoutMs` bounds the OVERALL poll, checked between attempts; each
     * in-flight probe request is bounded by the client's own per-request timeout
     * (a hung request surfaces as a transient and the next deadline check gives
     * up). So a single slow probe may run up to one client-request-timeout before
     * the wait returns.
     */
    waitForProbe(fileId: string, options?: ProbeWaitOptions): Promise<ProbeWaitResult>;
    /**
     * Best-effort probe-before-create for a VIDEO upload that went multipart.
     * No-op unless enabled AND isVideo AND the upload exceeded the multipart
     * threshold (i.e. it was a multipart upload — small single-shot videos skip
     * the wait). Delegates to {@link waitForProbe} (never-bounce): a give-up just
     * returns; genuine failures / caller abort propagate. The caller passes
     * `isVideo` so the low-level client never imports ergonomic media detection.
     */
    maybeWaitForVideoProbe(fileId: string, opts: {
        enabled: boolean;
        isVideo: boolean;
        sizeBytes?: number;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<void>;
    /**
     * Probe N uploaded files in parallel and partition the results by
     * outcome. Returns `{ ok, rejected, errors }` so the caller can
     * cleanly drop bad clips before submitting a long-form merge
     * workflow. Probe-call failures (including the
     * `feature_not_available` 422 returned while the endpoint is
     * `availability: planned`) land in `errors` rather than throwing,
     * so a partially-successful batch still yields useful aggregation.
     */
    preflightClips(fileIds: string[]): Promise<PreflightClipsResult>;
    /**
     * Get a paginated page of credit transaction history for the caller.
     * Server defaults: `limit=20`, `offset=0`. Most-recent-first.
     */
    getCreditsUsage(options?: CreditsUsageOptions): Promise<CreditsUsageResponse>;
    /**
     * List the caller's workflows — a cursor-paginated, user-scoped summary
     * list, most-recent-first. Each row is a lightweight {@link WorkflowSummary}
     * (id / status / created_at + per-job type+status + a deliverable-output
     * count); it does NOT inline per-op `result_metadata` or output details —
     * drill in via {@link getWorkflowStatus} / {@link getWorkflowDownloads}.
     *
     * Auth is REQUIRED (the list is user-scoped; an anonymous caller gets a 401
     * → `GislAuthError`). Walk pages by passing each response's `nextCursor` as
     * the next call's `cursor` until `isTruncated` is false, or use
     * {@link workflows} to auto-paginate. Mirrors the PHP
     * `GislClient::listWorkflows`.
     */
    listWorkflows(options?: ListWorkflowsOptions): Promise<WorkflowListResponse>;
    /**
     * Auto-paginating async iterator over ALL of the caller's workflows,
     * yielding each {@link WorkflowSummary} most-recent-first across page
     * boundaries — the ergonomic companion to {@link listWorkflows}. Walks
     * `nextCursor` until the server reports `isTruncated: false`. Mirrors the
     * PHP `workflows()` generator.
     *
     * ```ts
     * for await (const wf of client.workflows()) {
     *   console.log(wf.workflowId, wf.status);
     * }
     * ```
     */
    workflows(options?: {
        limit?: number;
        archived?: boolean;
    }): AsyncGenerator<WorkflowSummary, void, undefined>;
}
