import type {
  OperationType,
  OperationsSchemaResponse,
  CallbackEventType,
  SseEventType,
  SseOperationProgressData,
  SseOperationCompletedData,
  SseOperationFailedData,
  SseJobCompletedData,
  SseJobFailedData,
  SseWorkflowTerminalData,
  MultipartInitiateRequestMetadataHint,
  UploadProbeResponse,
} from '@giveitsmaller/contracts/openapi';
import type { JobInputV2RoleEnum } from '@giveitsmaller/contracts/openapi';

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Operation definition (typed replacement for generated `any`)
// ---------------------------------------------------------------------------

export interface OperationDef {
  type: OperationType;
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// v2 source variants — discriminated by `type` wire key
// ---------------------------------------------------------------------------

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

export type WorkflowSourcePayload =
  | UploadSourcePayload
  | JobOutputSourcePayload
  | ExternalImportSourcePayload
  | ConnectionSourcePayload;

// ---------------------------------------------------------------------------
// Source factories — return wire-format objects with the `type` discriminator
// ---------------------------------------------------------------------------

export function uploadSource(fileId: string): UploadSourcePayload {
  return { type: 'upload', file_id: fileId };
}

export function jobOutputSource(
  from: string,
  operation?: string,
): JobOutputSourcePayload {
  return operation === undefined
    ? { type: 'job_output', from }
    : { type: 'job_output', from, operation };
}

export function externalImportSource(
  externalSourceId: string,
): ExternalImportSourcePayload {
  return { type: 'external_import', external_source_id: externalSourceId };
}

export function connectionSource(
  connectionId: string,
  path: string,
): ConnectionSourcePayload {
  return { type: 'connection', connection_id: connectionId, path };
}

// ---------------------------------------------------------------------------
// JobInputV2 — multi-input entry per ADR-0004
// ---------------------------------------------------------------------------

export interface JobInputV2Payload {
  source: WorkflowSourcePayload;
  role?: JobInputV2RoleEnum;
  per_input_options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JobDefinition (single shape; `source` XOR `inputs[]` — runtime-enforced)
// ---------------------------------------------------------------------------

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
  /**
   * Per-job opt-out of the "compress required in every chain" gate.
   * When `true`, the server accepts a chain that doesn't terminate in a
   * `compress` operation — required for chains that observe multi-output
   * fan-out (e.g. convert PDF -> N images per ADR-0009 §D2) without
   * collapsing the N outputs through a trailing chained compress.
   *
   * Accepted by the API at `compression/src/Jobs/.../JobDefinition.php`
   * (`skipCompression`) and validated against the chain-ordering rule at
   * `Job::validateChainOrdering`. Currently undocumented in
   * `contracts/openapi/api.yaml` JobDefinition schema — spec follow-up
   * pending; the SDK exposes the field to unblock e2e A8-FLIP.
   */
  skip_compression?: boolean;
}

// ---------------------------------------------------------------------------
// External destination (workflow-level export). Discriminated union over
// `connection` | `external_import`. Replaces V1 `ExportConfig`.
// ---------------------------------------------------------------------------

export type ExternalDestinationPayload =
  | { type: 'connection'; connection_id: string; path: string }
  | { type: 'external_import'; external_source_id: string };

// ---------------------------------------------------------------------------
// Delivery (workflow-level) per ADR-0003
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Workflow processing hint (workflow-level) per I15-CONS
// ---------------------------------------------------------------------------

export type ProcessingClassHintPayload =
  | 'auto'
  | 'short_form_only'
  | 'long_form_allowed'
  | 'long_form_preferred';

export interface WorkflowProcessingPayload {
  class_hint?: ProcessingClassHintPayload;
}

// ---------------------------------------------------------------------------
// Workflow creation request (SDK-level, wire-format ready, snake_case)
// ---------------------------------------------------------------------------

export interface WorkflowCreatePayload {
  jobs: JobDefinitionPayload[];
  workflow_edges?: Array<{ from: string; to: string }>;
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
export const WORKFLOW_CREATE_PAYLOAD_KEYS = Object.freeze([
  'jobs',
  'workflow_edges',
  'callback_url',
  'callback_events',
  'export',
  'delivery',
  'processing',
] as const);

// Compile-time invariant: WORKFLOW_CREATE_PAYLOAD_KEYS must exactly equal
// keyof WorkflowCreatePayload. The tuple wraps are load-bearing — a naked
// `A extends B` would distribute over the union and silently pass. tsc fails
// at the `_AssertTrue<...>` line below with the specific extra/missing keys
// named in the error tuple. This lives in src/ (not tests/) because
// tsconfig.json excludes tests from the build; and is pure-type (no `const`
// / `void`) so no runtime JS is emitted to the shipped module.
type _ExpectedWorkflowCreatePayloadKey = (typeof WORKFLOW_CREATE_PAYLOAD_KEYS)[number];
type _ExcessPayload = Exclude<keyof WorkflowCreatePayload, _ExpectedWorkflowCreatePayloadKey>;
type _ExcessExpected = Exclude<_ExpectedWorkflowCreatePayloadKey, keyof WorkflowCreatePayload>;
type _WorkflowCreatePayloadDrift =
  [_ExcessPayload] extends [never]
    ? [_ExcessExpected] extends [never]
      ? true
      : ['DRIFT: WorkflowCreatePayload is missing keys declared in WORKFLOW_CREATE_PAYLOAD_KEYS', _ExcessExpected]
    : ['DRIFT: WorkflowCreatePayload has EXTRA keys not in WORKFLOW_CREATE_PAYLOAD_KEYS', _ExcessPayload];
type _AssertTrue<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WorkflowCreatePayloadDriftAssertion = _AssertTrue<_WorkflowCreatePayloadDrift>;

// ---------------------------------------------------------------------------
// Schema fetch options
// ---------------------------------------------------------------------------

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

export type GetSchemaResult =
  | {
      notModified: false;
      data: OperationsSchemaResponse;
      etag?: string;
      lastModified?: string;
    }
  | {
      notModified: true;
      etag?: string;
      lastModified?: string;
    };

// ---------------------------------------------------------------------------
// Credits / billing
// ---------------------------------------------------------------------------

export interface CreditsUsageOptions {
  /**
   * Page size. Server defaults to 20 and rejects values outside `[1, 100]`
   * with a 400 validation envelope.
   */
  limit?: number;
  /** Page offset (zero-based). Server default is 0. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Upload probe / preflight
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Polling options
// ---------------------------------------------------------------------------

export interface WaitOptions {
  /** Poll interval in milliseconds (default: 2000) */
  intervalMs?: number;
  /** Maximum wait time in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Called after each poll with current status */
  onPoll?: (status: string) => void;
}

// ---------------------------------------------------------------------------
// SSE event types (SDK-level typed discriminated union)
// ---------------------------------------------------------------------------

export type GislSseEvent =
  | { event: typeof SseEventType.operation_progress; data: SseOperationProgressData }
  | { event: typeof SseEventType.operation_completed; data: SseOperationCompletedData }
  | { event: typeof SseEventType.operation_failed; data: SseOperationFailedData }
  | { event: typeof SseEventType.job_completed; data: SseJobCompletedData }
  | { event: typeof SseEventType.job_failed; data: SseJobFailedData }
  | { event: typeof SseEventType.workflow_completed; data: SseWorkflowTerminalData }
  | { event: typeof SseEventType.workflow_failed; data: SseWorkflowTerminalData }
  | { event: typeof SseEventType.workflow_partially_failed; data: SseWorkflowTerminalData }
  | { event: string; data: unknown };

// ---------------------------------------------------------------------------
// Upload options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SDK-3 hand-coded resume-support shapes (TODO(HxUmVr3Y): replace on regen).
//
// API-2 / PR #283 shipped the 3 resume-support endpoints (`/status`,
// `/presign`, `/keepalive`); contracts ticket HxUmVr3Y will add the OpenAPI
// schemas that drive the openapi-generator output. Until that regen lands,
// these types are hand-coded so SDK-3 ships unblocked. Every public type and
// call-site is prefixed `_Sdk3HandCoded` so the eventual regen sweep is a
// mechanical grep — find every reference and re-point at the generated
// `@giveitsmaller/contracts/openapi` types.
//
// Wire shape is snake_case (matches API-2's PHP response writer); the TS
// surface here uses camelCase consistent with the rest of the SDK's
// hand-written types. The client.ts code path that SENDS the `/presign`
// request body marshals to the snake_case wire object inline; the response
// shapes are read in camelCase after the `handleResponse` envelope unwrap
// (callers narrow on field names from these interfaces).
// ---------------------------------------------------------------------------

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
