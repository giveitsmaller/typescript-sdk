import type { OperationType, OperationsSchemaResponse, OperationCapability, OutputProperties, ImageEncodeCapabilities, CallbackEventType, SseEventType, SseOperationProgressData, SseOperationCompletedData, SseOperationFailedData, SseJobCompletedData, SseJobFailedData, SseWorkflowTerminalData, MultipartInitiateRequestMetadataHint, UploadProbeResponse } from '@giveitsmaller/contracts/openapi';
import type { JobInputV2RoleEnum } from '@giveitsmaller/contracts/openapi';
export interface GislClientConfig {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    timeout?: number;
    /**
     * Send credentials (cookies) on every fetch — required in browsers when
     * authenticating via the session cookie issued by `POST /api/auth/login`
     * (Symfony firewall). Default `false` — the SDK ships in API-key mode by
     * default. Set to `true` for browser SPAs that drive the auth flow via
     * `client.login()` / `client.logout()` so the session cookie persists
     * across requests.
     *
     * Node session persistence (cookie-jar across processes) is out of scope —
     * this flag only flips fetch's `credentials` option; cookie storage is the
     * environment's responsibility.
     */
    useSessionCookie?: boolean;
    /**
     * Preferred response language. When set, the SDK sends
     * `Accept-Language: <locale>` on every GISL-API request (e.g. `'fr-FR'`,
     * `'de'`). The server echoes the language it actually resolved via the
     * `Content-Language` response header, surfaced on
     * `GislApiError.contentLanguage`. When no supported language matches, the
     * server falls back to its default (typically `en-GB`).
     *
     * A dedicated `locale` wins over any `Accept-Language` passed through
     * `headers` (mirrors how `apiKey` wins over a caller-supplied
     * `Authorization` header); the conflicting `headers` entry is dropped
     * case-insensitively so the request never carries two variants.
     */
    locale?: string;
    /** Threshold in bytes above which multipart upload is used (default: 10MB) */
    multipartThreshold?: number;
    /**
     * Max concurrent chunk uploads for multipart (default: 4). Non-finite or
     * fractional values are coerced via `Math.floor`; `NaN`/`Infinity` and
     * non-positive values fall back to the default. Zero workers would produce
     * a multipart-complete with an incomplete parts array (silent corruption),
     * so the sanitiser snaps below-1 to default rather than to 1.
     */
    multipartConcurrency?: number;
    /**
     * Max total attempts per multipart S3 PUT, including the first try
     * (default: 3 — one initial + two retries). 0 or 1 disables retry.
     * Non-finite or fractional values are coerced via `Math.floor` and
     * floored at 1; `NaN`/`Infinity` fall back to the default.
     * Retries fire on 5xx/429 responses and on network TypeError; 4xx (other
     * than 429) and abort signals fail fast.
     */
    multipartMaxAttempts?: number;
    /**
     * Base milliseconds for full-jitter exponential backoff between multipart
     * retry attempts (default: 500). Each retry's delay is `random(0, base * 2^n)`
     * where n is the zero-indexed retry number. `0` opts out of backoff (retries
     * fire immediately) — useful for tests; not recommended for production where
     * jitter is the only defence against thundering-herd retry storms against
     * shared-throttling sources like S3. `NaN`/`Infinity` fall back to the default.
     */
    multipartRetryBaseMs?: number;
}
export interface OperationDef {
    type: OperationType;
    options?: Record<string, unknown>;
}
export interface UploadSourcePayload {
    type: 'upload';
    file_id: string;
}
export interface JobOutputSourcePayload {
    type: 'job_output';
    from: string;
    operation?: string;
}
export interface ExternalImportSourcePayload {
    type: 'external_import';
    external_source_id: string;
}
export interface ConnectionSourcePayload {
    type: 'connection';
    connection_id: string;
    path: string;
}
export type WorkflowSourcePayload = UploadSourcePayload | JobOutputSourcePayload | ExternalImportSourcePayload | ConnectionSourcePayload;
/**
 * The source leaves a multi-input `JobInputV2Payload.source` may take —
 * `WorkflowSourcePayload` minus the `upload` leaf. Per the contract
 * (`MultiInputSource` in `openapi/api.yaml`), multi-input operations
 * (merge / archive / image_watermark / custom_luma / audio_overlay) do NOT
 * accept upload-direct: an uploaded file enters a multi-input job via a
 * `passthrough` source job referenced downstream by `{ type: 'job_output' }`.
 * Single-input `JobDefinitionPayload.source` keeps the wider
 * `WorkflowSourcePayload` (upload-direct is valid there).
 *
 * Named with the SDK's `*Payload` suffix to match every sibling source type
 * and to avoid colliding with the generated `MultiInputSource` model (a
 * different, deep-import-only type family).
 */
export type MultiInputSourcePayload = JobOutputSourcePayload | ExternalImportSourcePayload | ConnectionSourcePayload;
export declare function uploadSource(fileId: string): UploadSourcePayload;
export declare function jobOutputSource(from: string, operation?: string): JobOutputSourcePayload;
export declare function externalImportSource(externalSourceId: string): ExternalImportSourcePayload;
export declare function connectionSource(connectionId: string, path: string): ConnectionSourcePayload;
export interface JobInputV2Payload {
    source: MultiInputSourcePayload;
    role?: JobInputV2RoleEnum;
    per_input_options?: Record<string, unknown>;
}
export interface JobDefinitionPayload {
    /**
     * Optional local identifier within the workflow. Server auto-generates
     * `^job_\d+$` when omitted; the SDK MUST NOT auto-generate. Required
     * when this job is referenced by another job's `JobOutputSource.from`,
     * `workflow_edges`, or `delivery.selection.explicit.refs[]`.
     */
    id?: string;
    /** Single-input source. Mutually exclusive with `inputs[]` (server enforces). */
    source?: WorkflowSourcePayload;
    /** Multi-input list for merge / archive / image_watermark / custom_luma / audio_overlay. */
    inputs?: JobInputV2Payload[];
    operations: OperationDef[];
    /** Per-job hide-intermediates promotion flag per ADR-0003. */
    deliver?: boolean;
}
/**
 * Single source of truth for JobDefinitionPayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec
 * at `JobDefinition`. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 *
 * The V1-only `skip_compression` field is deliberately absent (eQnUMW68);
 * the runtime drift test will fail if the spec re-introduces it OR adds
 * any other V1-leak field to the V2 JobDefinition schema.
 * @internal
 */
export declare const JOB_DEFINITION_PAYLOAD_KEYS: readonly ["id", "source", "inputs", "operations", "deliver"];
export type ExternalDestinationPayload = {
    type: 'connection';
    connection_id: string;
    path: string;
} | {
    type: 'external_import';
    external_source_id: string;
};
export type DeliveryModePayload = 'individual' | 'bundle' | 'both';
export type DeliveryBundleFormatPayload = 'zip' | 'tar_gz';
export type DeliverySelectionTypePayload = 'terminal' | 'all_outputs' | 'explicit';
export interface DeliveryOutputRefPayload {
    ref: string;
    operation?: string;
}
export interface DeliverySelectionPayload {
    type: DeliverySelectionTypePayload;
    refs?: DeliveryOutputRefPayload[];
}
export interface DeliveryPayload {
    mode?: DeliveryModePayload;
    bundle_format?: DeliveryBundleFormatPayload;
    bundle_filename?: string;
    include_metadata?: boolean;
    selection?: DeliverySelectionPayload;
}
export type ProcessingClassHintPayload = 'auto' | 'short_form_only' | 'long_form_allowed' | 'long_form_preferred';
export interface WorkflowProcessingPayload {
    class_hint?: ProcessingClassHintPayload;
}
export interface WorkflowCreatePayload {
    jobs: JobDefinitionPayload[];
    /**
     * Flat single-job form (with `operations`): top-level input source, exactly
     * equivalent to `jobs: [{ source, operations }]` (contracts D0Gsri8V, v2.64.0).
     * The spec's `oneOf` makes `jobs` and `source`+`operations` mutually exclusive;
     * the SDK builders always emit the explicit `jobs[]` form, so these are typed
     * optional for spec-completeness (a consumer hand-building the flat form omits
     * `jobs`). Builder adoption of the flat form is a follow-up.
     */
    source?: WorkflowSourcePayload;
    /** Flat-form operation set (with `source`); equivalent to one job's `operations`. */
    operations?: OperationDef[];
    workflow_edges?: Array<{
        from: string;
        to: string;
    }>;
    callback_url?: string;
    callback_events?: CallbackEventType[];
    export?: ExternalDestinationPayload;
    delivery?: DeliveryPayload;
    processing?: WorkflowProcessingPayload;
}
/**
 * Single source of truth for WorkflowCreatePayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec at
 * POST /api/workflows. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 * @internal
 */
export declare const WORKFLOW_CREATE_PAYLOAD_KEYS: readonly ["jobs", "source", "operations", "workflow_edges", "callback_url", "callback_events", "export", "delivery", "processing"];
export interface GetSchemaOptions {
    /** Filter the schema to operations that accept this MIME type (e.g. `image/jpeg`). */
    mimeType?: string;
    /** Filter the schema to a single operation type. */
    operation?: OperationType;
    /**
     * Conditional revalidation: send the previously-received `ETag` value to
     * receive a 304-not-modified sentinel when the cached response is still
     * fresh. Strong-ETag comparison.
     */
    ifNoneMatch?: string;
    /**
     * Conditional revalidation: send the previously-received `Last-Modified`
     * value (HTTP-date) to receive a 304-not-modified sentinel when the
     * cached response is still fresh.
     */
    ifModifiedSince?: string;
    /** Cancel an in-flight schema fetch. Surfaces as `GislAbortError`. */
    signal?: AbortSignal;
}
export type GetSchemaResult = {
    notModified: false;
    data: OperationsSchemaResponse;
    etag?: string;
    lastModified?: string;
} | {
    notModified: true;
    etag?: string;
    lastModified?: string;
};
/**
 * Typed projection of the operation-capability surface returned by
 * {@link ErgonomicClient.capabilities} (qUhxfDA5). Bundles the three v2.124
 * capability fields of `OperationsSchemaResponse` — previously typed but with
 * no ergonomic consumer — so a caller can read them without dropping to
 * `getSchema()` and its not-modified union.
 *
 * Mirrors the PHP `Gisl\Sdk\Ergonomic\CapabilitiesSnapshot` value object.
 */
export interface CapabilitiesSnapshot {
    /**
     * Tier-scoped operation-capability matrix, keyed by operation type
     * (`compress`, `convert`, …). Empty when the server omits the field.
     */
    readonly operations: Record<string, OperationCapability>;
    /**
     * Output-format property table (`hasAudioTrack` / `isAnimated`), keyed by
     * `output_format`. Tier-invariant. Empty when the server omits the field.
     */
    readonly outputProperties: Record<string, OutputProperties>;
    /**
     * Pre-flight image-encode capability matrix (`webpQualitySupported`,
     * `backgroundFlatten`). Tier-invariant. `undefined` when the server omits it.
     */
    readonly imageEncode?: ImageEncodeCapabilities;
}
export interface CreditsUsageOptions {
    /**
     * Page size. Server defaults to 20 and rejects values outside `[1, 100]`
     * with a 400 validation envelope.
     */
    limit?: number;
    /** Page offset (zero-based). Server default is 0. */
    offset?: number;
}
export interface ListWorkflowsOptions {
    /**
     * Opaque pagination cursor from a previous page's `nextCursor`. Omit for
     * the first page; treat the value as opaque (do not parse).
     */
    cursor?: string;
    /**
     * Rows per page. Server defaults to 20 and rejects values outside `[1, 100]`
     * with a 400 validation envelope.
     */
    limit?: number;
}
/**
 * Aggregated result of a `preflightClips()` batch probe — N parallel calls
 * to `POST /api/uploads/{id}/probe`, partitioned by outcome so the caller
 * can drop bad clips before submitting a long-form merge workflow (per
 * plan v5 round 10 / F11). Aggregation is structural — `ok` is everything
 * the server marked workflow-ready, `rejected` is everything else with a
 * typed probe response, and `errors` carries probe-call failures (e.g.
 * the 422 `feature_not_available` envelope returned while the endpoint is
 * still `availability: planned`).
 */
export interface PreflightClipsResult {
    /** Probes that returned `probe_status: 'ok'`. Safe to include in a workflow. */
    ok: UploadProbeResponse[];
    /**
     * Probes that returned a non-`ok` `probe_status` (`corrupt`,
     * `unsupported_codec`, `missing_metadata`). The caller should exclude
     * these or convert them first.
     */
    rejected: UploadProbeResponse[];
    /**
     * Probe calls that themselves failed. Includes the
     * `feature_not_available` (422) responses returned while the endpoint
     * is `availability: planned` — narrow on `instanceof
     * GislFeatureNotAvailableError` to detect that case.
     */
    errors: PreflightClipError[];
}
export interface PreflightClipError {
    fileId: string;
    error: unknown;
}
/**
 * Read-time options for a single anonymous-readable workflow query.
 *
 * Carries the one-time capability token returned by an anonymous (null-owner)
 * workflow create (`WorkflowCreateResponse.cap`). Pass it on status / downloads
 * / events reads so a session-less caller can read its own workflow; the SDK
 * sends it as the `X-Workflow-Capability` header. Omit it for authenticated
 * reads — the session authorizes those. A wrong or missing token on a
 * null-owner workflow returns 404 (deliberately no existence oracle).
 */
export interface ReadCapabilityOptions {
    /** Anonymous-workflow capability token (the `cap` from workflow-create). */
    capability?: string;
}
export interface WaitOptions {
    /** Poll interval in milliseconds (default: 2000) */
    intervalMs?: number;
    /** Maximum wait time in milliseconds (default: 300000 = 5 min) */
    timeoutMs?: number;
    /** Called after each poll with current status */
    onPoll?: (status: string) => void;
    /**
     * Anonymous-workflow capability token (the `cap` from workflow-create),
     * forwarded to each underlying status poll as the `X-Workflow-Capability`
     * header. Required to poll a null-owner workflow without a session; omit
     * for authenticated polling.
     */
    capability?: string;
}
export interface ProbeWaitOptions {
    /**
     * Overall wall-clock bound for the poll loop in ms (default: 30000). On
     * elapse the loop gives up and resolves `{ landed: false, reason: 'timeout' }`
     * — it never throws for a slow probe (the caller then creates anyway).
     */
    timeoutMs?: number;
    /** Abort the wait early; aborting rejects the promise with `GislAbortError`. */
    signal?: AbortSignal;
    /**
     * Fires once per poll attempt — drive an "analysing video…" UI in the gap
     * between upload-complete and workflow-create. `attempt` is 1-based;
     * `elapsedMs` is wall-clock since the wait started.
     */
    onPoll?: (info: {
        attempt: number;
        elapsedMs: number;
    }) => void;
}
export interface ProbeWaitResult {
    /**
     * True iff the probe landed — i.e. `POST /api/uploads/{id}/probe` returned
     * 200 (ANY `probeStatus`: ok / corrupt / unsupported_codec / missing_metadata).
     * The caller proceeds to create the workflow either way; a landed probe lets
     * the server admit the parallel video split.
     */
    landed: boolean;
    /** The landed probe response — present iff `landed`. */
    probe?: UploadProbeResponse;
    /**
     * Why the wait gave up WITHOUT a landed probe — present iff `!landed`.
     * `timeout` = the bound elapsed; `prober_error` = repeated 5xx from the
     * prober. In both cases the caller should create anyway (never-bounce); the
     * server's size heuristic routes the job (single-task worst case).
     */
    reason?: 'timeout' | 'prober_error';
}
export type GislSseEvent = {
    event: typeof SseEventType.operation_progress;
    data: SseOperationProgressData;
} | {
    event: typeof SseEventType.operation_completed;
    data: SseOperationCompletedData;
} | {
    event: typeof SseEventType.operation_failed;
    data: SseOperationFailedData;
} | {
    event: typeof SseEventType.job_completed;
    data: SseJobCompletedData;
} | {
    event: typeof SseEventType.job_failed;
    data: SseJobFailedData;
} | {
    event: typeof SseEventType.workflow_completed;
    data: SseWorkflowTerminalData;
} | {
    event: typeof SseEventType.workflow_failed;
    data: SseWorkflowTerminalData;
} | {
    event: typeof SseEventType.workflow_partially_failed;
    data: SseWorkflowTerminalData;
} | {
    event: string;
    data: unknown;
};
/**
 * A typed, non-throwing diagnostic surfaced when an SSE frame's `data:` body fails
 * to JSON-parse (TYNjcjpo). The malformed frame is SKIPPED from the event stream —
 * a long-running consumer must not break on one garbled server frame — but the
 * failure is observable via the `onParseError` callback on `streamEvents` /
 * `parseSseStream` rather than silently lost. Mirrors the PHP `GislSseParseFailure`
 * value object; the shape is identical across the two SDKs (cross-SDK parity).
 */
export interface GislSseParseFailure {
    /** The joined `data:` line(s) that failed to parse. */
    readonly raw: string;
    /** The frame's event type (or `'message'` when the frame had no `event:` field). */
    readonly event: string;
    /** The parse error message (e.g. the `JSON.parse` `SyntaxError` text). */
    readonly error: string;
}
export interface UploadOptions {
    /** Called with bytes uploaded so far (only for multipart) */
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
    /**
     * Cancel an in-flight upload. Aborting rejects the `uploadFile` promise with
     * `GislAbortError`. Applies to the API requests (initiate, complete) and
     * every S3 part PUT. Composes with the client-level per-request timeout —
     * whichever callback fires first determines the error class: user abort
     * first → `GislAbortError`; timer first → `GislTimeoutError`.
     */
    signal?: AbortSignal;
    /**
     * Optional metadata hint forwarded to multipart initiate so the server
     * can size-check and preflight-route based on caller-asserted dimensions.
     * Single-shot uploads ignore this field (the multipart initiate is the
     * only endpoint that accepts it). Wire-encoded as a JSON-stringified
     * single FormData field on the multipart/initiate request.
     */
    metadataHint?: MultipartInitiateRequestMetadataHint;
    /**
     * Resume an in-progress multipart upload (SDK-3 / Wb6ebOMM).
     *
     * When set, `uploadFile()` skips `/multipart/initiate` entirely. Instead it
     * walks `GET /api/uploads/multipart/{uploadId}/status` (paginated via
     * `next_part_number_marker` / `is_truncated`), computes which parts are
     * still missing, re-presigns them in batches of <=100 via
     * `POST /api/uploads/multipart/{uploadId}/presign`, PUTs only the missing
     * parts, then `POST /api/uploads/multipart/complete`.
     *
     * The caller's `file` argument MUST be byte-identical to the file used in
     * the original initiate call (same byte content at the same offsets).
     * Mismatched bytes will produce S3 etags that don't match the server's
     * recorded state, and `/multipart/complete` will reject.
     *
     * Anonymous-initiated sessions cannot be resumed by an authed caller
     * (server returns 403 → `GislMultipartSessionAuthRequiredError`); a
     * non-existent or expired session returns 404 →
     * `GislMultipartSessionNotFoundError`.
     */
    resumeUploadId?: string;
    /**
     * Called after every successful part PUT during fresh-upload AND resume
     * paths. Receives a JSON-serialisable snapshot of the upload state — round-
     * trippable via `JSON.stringify` for persistence across process restarts,
     * so a future `uploadFile({ resumeUploadId: state.uploadId, ... })` can
     * pick up where the prior process stopped.
     *
     * The callback is invoked OUTSIDE the per-part retry-scoped path: a throw
     * here will fail the upload but NEVER trigger a duplicate PUT (mirrors the
     * `onProgress` discipline at `client.ts:1195-1199`).
     */
    onCheckpoint?: (state: MultipartCheckpointState) => void;
}
/**
 * JSON-serialisable snapshot of an in-progress multipart upload, emitted
 * after every successful part PUT via `UploadOptions.onCheckpoint`. Designed
 * to round-trip through `JSON.stringify` / `JSON.parse` so consumers can
 * persist it across process restarts and resume via
 * `uploadFile({ resumeUploadId: state.uploadId, ... })`.
 *
 * All fields are primitive: no `Date` (use the ISO-8601 string on
 * `manifestExpiresAt`), no `Buffer`, no functions.
 */
export interface MultipartCheckpointState {
    /** The server-assigned `upload_id` (UUID) used as `resumeUploadId` later. */
    readonly uploadId: string;
    /** Total parts the server computed for this upload. <=10 000. */
    readonly totalParts: number;
    /**
     * Part numbers (1-indexed) that have been successfully PUT to S3 so far.
     * Includes part 1 (the initiate first chunk) once a part >= 2 lands. Sorted
     * ascending. Excluded numbers in `[1, totalParts]` are the still-missing
     * set a resume must re-PUT.
     */
    readonly uploadedPartNumbers: readonly number[];
    /**
     * ISO-8601 wall-clock instant at which the server's durable manifest for
     * this `uploadId` expires (currently a 48h TTL per the API-2 contract). On
     * resume, clients SHOULD call `keepaliveUpload(uploadId)` every 12-24h to
     * extend this, leaving >=24h of slack against the 48h ceiling even with
     * worst-case clock skew between client and server.
     */
    readonly manifestExpiresAt: string;
}
/**
 * One entry in `_Sdk3HandCodedMultipartStatusResult.uploadedParts`. Aggregated
 * across all pages of the underlying `GET /status` endpoint by the SDK's
 * walk-pagination loop.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedUploadedPart {
    readonly partNumber: number;
    readonly etag: string;
    readonly sizeBytes: number;
    /** ISO-8601 last-modified instant of the S3 part. */
    readonly lastModified: string;
}
/**
 * Aggregated result of `getUploadStatus()` after the SDK has walked every
 * page of the underlying `GET /api/uploads/multipart/{uploadId}/status`
 * endpoint (paginated via `next_part_number_marker` / `is_truncated`).
 * `uploadedParts` is the merged-and-sorted list of every part the server
 * has recorded across all pages — callers see the complete state without
 * needing to drive the pagination cursor themselves.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedMultipartStatusResult {
    readonly uploadId: string;
    readonly multipartUploadId: string;
    readonly cloudKey: string;
    readonly totalParts: number;
    /** Sorted ascending by `partNumber`; complete across all server-side pages. */
    readonly uploadedParts: readonly _Sdk3HandCodedUploadedPart[];
    /** ISO-8601 wall-clock when the durable session manifest expires. */
    readonly manifestExpiresAt: string;
    /** Server-recommended chunk size in bytes (matches the initiate envelope). */
    readonly recommendedChunkSize: number;
}
/**
 * One entry in `_Sdk3HandCodedPresignPartsResult.presignedUrls`. Shape mirrors
 * the contract-pinned `PresignedUrlPart` from the initiate envelope; kept
 * hand-coded here so the resume path does not depend on the generator's name
 * for that shape (decoupling for the HxUmVr3Y regen window).
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedPresignedPart {
    readonly partNumber: number;
    readonly url: string;
    readonly expiresAt: string;
}
/**
 * Result of `presignParts()` — the server-issued presigned PUT URLs for the
 * requested part numbers.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedPresignPartsResult {
    readonly uploadId: string;
    readonly presignedUrls: readonly _Sdk3HandCodedPresignedPart[];
}
/**
 * Result of `keepaliveUpload()` — the refreshed manifest TTL expiry instant.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedKeepaliveResult {
    readonly uploadId: string;
    readonly manifestExpiresAt: string;
}
