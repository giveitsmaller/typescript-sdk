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
}
