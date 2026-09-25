// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.

export type ErrorCode =
  | "stream_host_not_declared"
  | "missing_credentials"
  | "feature_requires_auth"
  | "undeclared_asset"
  | "unused_asset"
  | "per_input_options_not_supported"
  | "chain_cardinality_mismatch"
  | "multipart_part_invalid"
  | "multipart_part_count_exceeded"
  | "timeout"
  | "transport_failed"
  | "request_not_sent"
  | "download_rejected"
  | "download_unavailable"
  | "aborted"
  | "validation_failed"
  | "validation_error"
  | "cyclic_workflow_edges"
  | "workflow_edge_references_unknown_job"
  | "reserved_job_id_pattern"
  | "cyclic_job_output_source_graph"
  | "auth_failed"
  | "feature_tier_restricted"
  | "tier_restriction"
  | "multipart_session_ownership"
  | "multipart_session_auth_required"
  | "multipart_session_not_found"
  | "upload_not_found"
  | "workflow_expired"
  | "balance_exhausted"
  | "feature_not_available"
  | "upload_size_exceeds_tier"
  | "upload_duration_exceeds_tier"
  | "probe_pending"
  | "inputs_not_concat_uniform"
  | "requires_reencode"
  | "invalid_options"
  | "invalid_combination"
  | "missing_dependency"
  | "unsupported_value"
  | "type_mismatch"
  | "image_dimensions_too_large"
  | "unsupported_file_type"
  | "upload_failed"
  | "workflow_failed"
  | "sse_connection_limit_exceeded"
  | "sse_capacity_exhausted"
  | "long_form_concurrency_limit_exceeded"
  | "unprocessable_entity"
  | "email_same"
  | "config_error"
  | "bundle_already_archived"
  | "fan_out_timeout"
  | "no_such_key"
  | "result_not_ready"
  | "sink_error"
  | "item_failed";

export type ErrorCategory =
  | 'api'
  | 'config'
  | 'network'
  | 'auth'
  | 'validation'
  | 'chain';

export type ErrorStatus = 'wired' | 'planned';

export interface ErrorEntry {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly source: string;
  readonly status: ErrorStatus;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly sdkClass: string;
  readonly description: string;
  readonly metadataSchema: Readonly<Record<string, string>>;
}

export const ERROR_CODES: Readonly<Record<ErrorCode, ErrorEntry>> = Object.freeze({
  "stream_host_not_declared": Object.freeze({
    code: "stream_host_not_declared",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislStreamHostNotDeclaredError",
    description: "streamEvents() was called with a configuration that declares no stream host (no environment, no streamBaseUrl). Pass streamBaseUrl, set GISL_STREAM_BASE_URL, or use an environment that declares one. run() does not raise it — it polls instead.",
    metadataSchema: Object.freeze({}),
  }),
  "missing_credentials": Object.freeze({
    code: "missing_credentials",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislMissingCredentialsError",
    description: "gisl.create() failed the credential chain (explicit → GISL_API_KEY env → ~/.gisl/credentials profile → fail-early).",
    metadataSchema: Object.freeze({
      "sourcesTried": "array",
    }),
  }),
  "feature_requires_auth": Object.freeze({
    code: "feature_requires_auth",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislFeatureRequiresAuthError",
    description: "SDK rejected an anonymous-mode call to a feature that requires authentication. Pre-flight gate; never reaches the API.",
    metadataSchema: Object.freeze({
      "feature": "string",
    }),
  }),
  "undeclared_asset": Object.freeze({
    code: "undeclared_asset",
    category: "chain" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislUndeclaredAssetError",
    description: "Merge / archive / mapEach referenced an asset handle that was not declared upstream in the chain.",
    metadataSchema: Object.freeze({
      "ref": "string",
    }),
  }),
  "unused_asset": Object.freeze({
    code: "unused_asset",
    category: "chain" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislUnusedAssetError",
    description: "A declared asset was never referenced in the chain (caller likely forgot to use it; escape via allowUnusedAssets).",
    metadataSchema: Object.freeze({
      "ref": "string",
    }),
  }),
  "per_input_options_not_supported": Object.freeze({
    code: "per_input_options_not_supported",
    category: "chain" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislPerInputOptionsNotSupportedError",
    description: "per_input_options provided on a multi-input op role that doesn't accept it (e.g. role-less branch).",
    metadataSchema: Object.freeze({
      "op": "string",
      "role": "string",
    }),
  }),
  "chain_cardinality_mismatch": Object.freeze({
    code: "chain_cardinality_mismatch",
    category: "chain" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislChainCardinalityMismatchError",
    description: "Chain step expects a single artifact but the upstream step produces N (e.g.\n.compress() chained after convert(pdf, pages: \"1-20\")). Recovery: branch\nto a single artifact OR use .mapEach() to fan out.\n",
    metadataSchema: Object.freeze({
      "upstreamArtifactCount": "integer",
      "operation": "string",
    }),
  }),
  "multipart_part_invalid": Object.freeze({
    code: "multipart_part_invalid",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislMultipartPartError",
    description: "SDK rejected a part configuration before upload (e.g. out-of-range part number, duplicate, missing).",
    metadataSchema: Object.freeze({
      "partNumber": "integer",
      "reason": "string",
    }),
  }),
  "multipart_part_count_exceeded": Object.freeze({
    code: "multipart_part_count_exceeded",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislMultipartPartCountError",
    description: "Multipart presign batch / total parts exceeds S3 ceilings (10 000 total, 100 per presign request).",
    metadataSchema: Object.freeze({
      "partCount": "integer",
      "ceiling": "integer",
    }),
  }),
  "timeout": Object.freeze({
    code: "timeout",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislTimeoutError",
    description: "SDK-set deadline exceeded (run({maxWait}), waitForCompletion, multipart attempt timeout).",
    metadataSchema: Object.freeze({
      "timeoutMs": "integer",
      "phase": "string",
    }),
  }),
  "transport_failed": Object.freeze({
    code: "transport_failed",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislTransportError",
    description: "A request or download failed below HTTP (DNS, TCP, TLS, a mid-stream disconnect) or a 2xx download delivered no bytes. Transient by nature.",
    metadataSchema: Object.freeze({}),
  }),
  "request_not_sent": Object.freeze({
    code: "request_not_sent",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislRequestNotSentError",
    description: "The client refused to send the request (for example a URL that does not parse). Re-sending it fails identically. The TS SDK detects fewer of these than the PHP SDK; the rest surface as transport_failed.",
    metadataSchema: Object.freeze({}),
  }),
  "download_rejected": Object.freeze({
    code: "download_rejected",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislDownloadHttpError",
    description: "A result download URL answered a non-2xx status other than 408, 429 or 5xx (for example 404 on an expired signed URL). Not a GISL API error: API non-2xx responses carry an envelope and surface as GislApiError subclasses.",
    metadataSchema: Object.freeze({
      "status": "integer",
    }),
  }),
  "download_unavailable": Object.freeze({
    code: "download_unavailable",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislDownloadHttpError",
    description: "A result download URL answered 408, 429 or 5xx. Retrying may succeed.",
    metadataSchema: Object.freeze({
      "status": "integer",
    }),
  }),
  "aborted": Object.freeze({
    code: "aborted",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislAbortError",
    description: "Caller-supplied AbortSignal triggered cancellation.",
    metadataSchema: Object.freeze({
      "reason": "string",
    }),
  }),
  "validation_failed": Object.freeze({
    code: "validation_failed",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "422 — request validation failure; emitted on the wire as `VALIDATION_FAILED` (e.g. invalid limit/offset on GET /api/v2/credits/usage). Carries `details[]`.",
    metadataSchema: Object.freeze({
      "details": "array",
    }),
  }),
  "validation_error": Object.freeze({
    code: "validation_error",
    category: "validation" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "422 — `error_type` discriminator on `ValidationErrorEnvelope` (ADR-0018/0019); distinct from `validation_failed` (the `error` code), same `GislValidationError`. Carries `details[]`.",
    metadataSchema: Object.freeze({
      "details": "array",
    }),
  }),
  "cyclic_workflow_edges": Object.freeze({
    code: "cyclic_workflow_edges",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "422 — cycle/self-edge in the explicit `workflow_edges` DAG. Wire `CYCLIC_WORKFLOW_EDGES` (g8PPkbNu); ValidationErrorEnvelope shape, `details[0].field`=`workflow_edges`.",
    metadataSchema: Object.freeze({
      "details": "array",
    }),
  }),
  "workflow_edge_references_unknown_job": Object.freeze({
    code: "workflow_edge_references_unknown_job",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 400,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "400 — a `workflow_edges` entry, job-level `source`, or `inputs[].source` references a job not in the request. Wire `WORKFLOW_EDGE_REFERENCES_UNKNOWN_JOB` (g8PPkbNu).",
    metadataSchema: Object.freeze({}),
  }),
  "reserved_job_id_pattern": Object.freeze({
    code: "reserved_job_id_pattern",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 400,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "400 — user job `id` matches the reserved `^job_\\d+$` pattern as the SOLE failure. Wire `RESERVED_JOB_ID_PATTERN` (g8PPkbNu); mixed violations keep generic `BAD_REQUEST`.",
    metadataSchema: Object.freeze({}),
  }),
  "cyclic_job_output_source_graph": Object.freeze({
    code: "cyclic_job_output_source_graph",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 400,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "400 — an implicit cycle in the `job_output` source graph, caught during effective-input-MIME resolution on POST /api/workflows. Wire `CYCLIC_JOB_OUTPUT_SOURCE_GRAPH` (g8PPkbNu).",
    metadataSchema: Object.freeze({}),
  }),
  "auth_failed": Object.freeze({
    code: "auth_failed",
    category: "auth" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 401,
    retryable: false,
    sdkClass: "GislAuthError",
    description: "401 — invalid / expired / missing API key.",
    metadataSchema: Object.freeze({
      "authErrorType": "string",
    }),
  }),
  "feature_tier_restricted": Object.freeze({
    code: "feature_tier_restricted",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 403,
    retryable: false,
    sdkClass: "GislFeatureTierRestrictedError",
    description: "403 — feature requires a higher subscription tier than the caller's.",
    metadataSchema: Object.freeze({
      "feature": "string",
      "requiredTier": "string",
      "currentTier": "string",
    }),
  }),
  "tier_restriction": Object.freeze({
    code: "tier_restriction",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 403,
    retryable: false,
    sdkClass: "GislTierRestrictedError",
    description: "403 — general tier restriction (not feature-specific). Wire emits `error_type: \"tier_restriction\"`; the SDK class name keeps the `TierRestricted` adjective form per packages/typescript/src/errors.ts.",
    metadataSchema: Object.freeze({
      "requiredTier": "string",
      "currentTier": "string",
    }),
  }),
  "multipart_session_ownership": Object.freeze({
    code: "multipart_session_ownership",
    category: "auth" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 403,
    retryable: false,
    sdkClass: "GislMultipartSessionOwnershipError",
    description: "403 on multipart resume — session exists but belongs to a different caller.",
    metadataSchema: Object.freeze({
      "uploadId": "string",
    }),
  }),
  "multipart_session_auth_required": Object.freeze({
    code: "multipart_session_auth_required",
    category: "auth" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 403,
    retryable: false,
    sdkClass: "GislMultipartSessionAuthRequiredError",
    description: "403 on multipart resume — session was initiated anonymously; resume requires auth (future-flip per upstream 8LABloaz).",
    metadataSchema: Object.freeze({
      "uploadId": "string",
    }),
  }),
  "multipart_session_not_found": Object.freeze({
    code: "multipart_session_not_found",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 404,
    retryable: false,
    sdkClass: "GislMultipartSessionNotFoundError",
    description: "404 on multipart resume — upload_id unknown or expired past 48h TTL.",
    metadataSchema: Object.freeze({
      "uploadId": "string",
    }),
  }),
  "upload_not_found": Object.freeze({
    code: "upload_not_found",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 404,
    retryable: false,
    sdkClass: "GislApiError",
    description: "404 on POST /api/workflows — a referenced upload was not found, OR exists but is owned by a different identity (deliberate BOLA/IDOR existence-mask: reported as not-found, never 403, so the response does not reveal another user's upload exists). message_key upload.not_found. Wire token UPLOAD_NOT_FOUND keyed on the `error` field. Per ADR-0016 amendment.",
    metadataSchema: Object.freeze({}),
  }),
  "workflow_expired": Object.freeze({
    code: "workflow_expired",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 410,
    retryable: false,
    sdkClass: "GislWorkflowExpiredError",
    description: "410 — workflow result TTL expired; outputs no longer downloadable.",
    metadataSchema: Object.freeze({
      "workflowId": "string",
    }),
  }),
  "balance_exhausted": Object.freeze({
    code: "balance_exhausted",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 402,
    retryable: false,
    sdkClass: "GislBalanceExhaustedError",
    description: "402 — workflow create rejected because cost estimate exceeds available credits (monthly + purchased + overdraft).",
    metadataSchema: Object.freeze({
      "requiredCredits": "integer",
      "availableCredits": "integer",
      "links": "object",
    }),
  }),
  "feature_not_available": Object.freeze({
    code: "feature_not_available",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislFeatureNotAvailableError",
    description: "422 — operation type is planned but not yet implemented server-side (e.g. custom_luma before Lambda support ships).",
    metadataSchema: Object.freeze({
      "feature": "string",
    }),
  }),
  "upload_size_exceeds_tier": Object.freeze({
    code: "upload_size_exceeds_tier",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislUploadCapExceededError",
    description: "422 — uploaded file size exceeds the per-tier cap. Wire `error_type: \"upload_size_exceeds_tier\"`. SDK class GislUploadCapExceededError covers this + upload_duration_exceeds_tier (sibling code below).",
    metadataSchema: Object.freeze({
      "size": "integer",
      "ceiling": "integer",
    }),
  }),
  "upload_duration_exceeds_tier": Object.freeze({
    code: "upload_duration_exceeds_tier",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislUploadCapExceededError",
    description: "422 — uploaded media duration exceeds the per-tier cap. Wire `error_type: \"upload_duration_exceeds_tier\"`. Shares SDK class GislUploadCapExceededError with upload_size_exceeds_tier; consumers branch on the metadata.",
    metadataSchema: Object.freeze({
      "duration": "integer",
      "ceiling": "integer",
    }),
  }),
  "probe_pending": Object.freeze({
    code: "probe_pending",
    category: "api" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: true,
    sdkClass: "GislProbePendingError",
    description: "422 on workflow create — upload probing not yet complete; retry after the upload finishes probing. Wire `error_type: \"probe_pending\"`.",
    metadataSchema: Object.freeze({
      "jobRef": "string",
    }),
  }),
  "inputs_not_concat_uniform": Object.freeze({
    code: "inputs_not_concat_uniform",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "planned" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "422 — a job routed to a processing class that concatenates without normalising (today merge.video long_form_re_encode) has inputs that differ in stream layout or a listed attribute. Wire `INPUTS_NOT_CONCAT_UNIFORM`; ValidationErrorEnvelope, one details[] entry per difference. The caller must change the inputs; retrying does not help. `planned` until api's nmYdwHAH ships the create-time refusal (MjzzPCWt).",
    metadataSchema: Object.freeze({}),
  }),
  "requires_reencode": Object.freeze({
    code: "requires_reencode",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislApiError",
    description: "422 on merge — inputs are byte-stream-incompatible (different codec / resolution / etc.); merge requires re-encode rather than concat.",
    metadataSchema: Object.freeze({
      "reason": "string",
    }),
  }),
  "invalid_options": Object.freeze({
    code: "invalid_options",
    category: "validation" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "422 — operation option failed server-side validation (range, depends_on, mutex). ⚠️ The API does NOT send this code on POST /api/workflows today — every create-time option failure arrives as validation_failed (measured on prod 2026-09-23; WorkflowController maps validation_error to VALIDATION_FAILED). Same SDK class, so dispatch is unaffected; do not key UI on this code for create.",
    metadataSchema: Object.freeze({
      "field": "string",
      "reason": "string",
    }),
  }),
  "invalid_combination": Object.freeze({
    code: "invalid_combination",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "Two or more options that are mutually exclusive per contract `depends_on` / mutex were both provided.",
    metadataSchema: Object.freeze({
      "fields": "array",
    }),
  }),
  "missing_dependency": Object.freeze({
    code: "missing_dependency",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "An option was set but its contract `depends_on` predicate was not satisfied (e.g. quality set but mode is not lossy).",
    metadataSchema: Object.freeze({
      "field": "string",
      "requires": "array",
    }),
  }),
  "unsupported_value": Object.freeze({
    code: "unsupported_value",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "A value was outside the allowed enum / range for an option.",
    metadataSchema: Object.freeze({
      "field": "string",
      "value": "string",
      "allowed": "array",
    }),
  }),
  "type_mismatch": Object.freeze({
    code: "type_mismatch",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislValidationError",
    description: "A value's type didn't match the schema (e.g. string where integer expected).",
    metadataSchema: Object.freeze({
      "field": "string",
      "expected": "string",
      "actual": "string",
    }),
  }),
  "image_dimensions_too_large": Object.freeze({
    code: "image_dimensions_too_large",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 413,
    retryable: false,
    sdkClass: "GislUploadCapExceededError",
    description: "413 — an upload rejected a decodable raster image whose pixel area (width × height) exceeds that path's ceiling, read from the file header before decode: POST /api/uploads uses the single-shot ceiling (UPLOAD_MAX_IMAGE_PIXELS, default 16 MP; I0Rqj4jo), and POST /api/uploads/multipart/initiate the separate multipart ceiling (UPLOAD_MAX_MULTIPART_IMAGE_PIXELS, default 50 MP; ae4Q1yCb). Wire `IMAGE_DIMENSIONS_TOO_LARGE`; flat ErrorEnvelope (no details[]). A pixel-dimension member of the upload-cap family — GislUploadCapExceededError, alongside the size/duration caps — matching the SDKs' existing status-based 413 dispatch (NOT GislValidationError, which is the structured-422 class). Retry only after downscaling the input.",
    metadataSchema: Object.freeze({}),
  }),
  "unsupported_file_type": Object.freeze({
    code: "unsupported_file_type",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 415,
    retryable: false,
    sdkClass: "GislUnsupportedFileTypeError",
    description: "415 — POST /api/uploads or POST /api/uploads/multipart/initiate refused a MIME type that NO tier can process. Wire `UNSUPPORTED_FILE_TYPE`; flat ErrorEnvelope (no details[]). Distinct from the 403 tier_restriction with restriction_kind mime_type, which some tier would accept — this one no upgrade fixes, so an SDK must never surface it as an upgrade prompt. A GislApiError subclass (sdks eWtnqHZm, on sdks main as of 24bbefddf). `wired` since 2026-09-24: api v1.12.0 (#739) is live on prod and returns it for random bytes (measured by api) (TOB5SvRQ).",
    metadataSchema: Object.freeze({}),
  }),
  "upload_failed": Object.freeze({
    code: "upload_failed",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislError",
    description: "Single-shot or multipart upload failed after retry exhaustion. Distinct from auth/balance/cap errors (those are typed above).",
    metadataSchema: Object.freeze({
      "reason": "string",
      "attempt": "integer",
    }),
  }),
  "workflow_failed": Object.freeze({
    code: "workflow_failed",
    category: "api" as ErrorCategory,
    source: "OperationResponse.error_code",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislApiError",
    description: "Workflow reached terminal failure status. Per-job error codes live on jobErrors[].errorCode.",
    metadataSchema: Object.freeze({
      "workflowId": "string",
      "jobErrors": "array",
    }),
  }),
  "sse_connection_limit_exceeded": Object.freeze({
    code: "sse_connection_limit_exceeded",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "planned" as ErrorStatus,
    httpStatus: 429,
    retryable: true,
    sdkClass: "GislSseConnectionLimitError",
    description: "429 — the CALLER's own concurrent event-stream allowance is exhausted. Same semantics as the tier long-form concurrency limit and therefore the same status. NOT for a global-capacity refusal; see sse_capacity_exhausted. `retryable` means AFTER Retry-After: a client MUST NOT request another stream before it elapses.",
    metadataSchema: Object.freeze({
      "openStreams": "integer",
      "maxStreams": "integer",
    }),
  }),
  "sse_capacity_exhausted": Object.freeze({
    code: "sse_capacity_exhausted",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "planned" as ErrorStatus,
    httpStatus: 503,
    retryable: true,
    sdkClass: "GislSseCapacityError",
    description: "503 — GLOBAL event-stream capacity is exhausted, and it says nothing about this caller. A caller who has opened no streams can receive it. ⚠️ A native `EventSource` does not expose the HTTP status to page script, so THAT client kind cannot distinguish this from 500; a `fetch`-based reader (the shipped frontend, the SDKs) can. A client that reads it MUST NOT request another stream before Retry-After elapses.",
    metadataSchema: Object.freeze({
      "links": "object",
    }),
  }),
  "long_form_concurrency_limit_exceeded": Object.freeze({
    code: "long_form_concurrency_limit_exceeded",
    category: "api" as ErrorCategory,
    source: "ErrorEnvelope.error",
    status: "wired" as ErrorStatus,
    httpStatus: 429,
    retryable: false,
    sdkClass: "GislLongFormConcurrencyError",
    description: "429 — the caller's tier long-form concurrency allowance is exhausted. Wire value is UPPERCASE `LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED` (api.yaml:1995); this file's `code:` follows the taxonomy's lowercase convention. Dispatched on the machine `error` code, NOT on the status: a generic infra rate-limit 429 carries a different/absent code and falls through to base GislApiError where retryAfterSeconds applies. Do not widen this entry to the status.",
    metadataSchema: Object.freeze({
      "currentTier": "string",
      "maxDurationSeconds": "number",
    }),
  }),
  "unprocessable_entity": Object.freeze({
    code: "unprocessable_entity",
    category: "auth" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislAuthRejectionError",
    description: "422 on an auth-side-effect endpoint (register / verify-email / api-keys) — the request was well-formed but rejected on domain grounds. Dispatched on MEMBERSHIP of AuthRejectionEnvelope.error_type, per ADR-0019.",
    metadataSchema: Object.freeze({
      "errorType": "string",
    }),
  }),
  "email_same": Object.freeze({
    code: "email_same",
    category: "auth" as ErrorCategory,
    source: "error_type",
    status: "wired" as ErrorStatus,
    httpStatus: 422,
    retryable: false,
    sdkClass: "GislAuthRejectionError",
    description: "422 on profile PATCH — the submitted email matches the current one, so there is nothing to change. Same envelope and sdkClass as unprocessable_entity; separate row because the wire value differs.",
    metadataSchema: Object.freeze({
      "errorType": "string",
    }),
  }),
  "config_error": Object.freeze({
    code: "config_error",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislConfigError",
    description: "Client-side configuration rejected before any request — thrown directly (preset resolver, output() gates), not only as a base class. `reason` carries the discriminator: `unknown_field` and `type_mismatch` are values of THIS field and deliberately have no rows of their own.",
    metadataSchema: Object.freeze({
      "reason": "string",
      "conflictingFields": "array",
      "resolvedSnapshot": "object",
      "suggestion": "string",
    }),
  }),
  "bundle_already_archived": Object.freeze({
    code: "bundle_already_archived",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "planned" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislBundleAlreadyArchivedError",
    description: "PLANNED — not reachable in any shipped build. Raised when a bundle operation targets an already-archived bundle, once `.bundle()` ships. Do not write handler code against this yet.",
    metadataSchema: Object.freeze({}),
  }),
  "fan_out_timeout": Object.freeze({
    code: "fan_out_timeout",
    category: "network" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislFanOutTimeoutError",
    description: "A fan-out deadline elapsed before all children finished. The three metadata fields are the reason this is declared separately from GislTimeoutError: completedWorkflowIds are the children that DID finish, parentWorkflowId ran to completion before the fan-out began, and the inherited workflowId is the in-flight child — absent on a clean between-children timeout.",
    metadataSchema: Object.freeze({
      "completedWorkflowIds": "array",
      "parentWorkflowId": "string",
      "workflowId": "string",
    }),
  }),
  "no_such_key": Object.freeze({
    code: "no_such_key",
    category: "chain" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislNoSuchKeyError",
    description: "The caller asked for a mapEach result key that does not exist in the output. NOTE the key itself is NOT captured in metadata today — it is interpolated into the message only, so consumers cannot branch on which key was missing.",
    metadataSchema: Object.freeze({}),
  }),
  "result_not_ready": Object.freeze({
    code: "result_not_ready",
    category: "validation" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: true,
    sdkClass: "GislResultNotReadyError",
    description: "The caller read a result before the workflow reached a terminal state. `state` carries the non-terminal status observed.",
    metadataSchema: Object.freeze({
      "workflowId": "string",
      "state": "string",
    }),
  }),
  "sink_error": Object.freeze({
    code: "sink_error",
    category: "config" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislSinkError",
    description: "A caller-supplied output sink could not be used. Branch on `reason` — the values span both caller setup (invalid_directory, duplicate_filename) and runtime write outcomes (write_failed, partial_failure), so the category is a best fit rather than an exact one.",
    metadataSchema: Object.freeze({
      "reason": "string",
    }),
  }),
  "item_failed": Object.freeze({
    code: "item_failed",
    category: "api" as ErrorCategory,
    source: "SDK_local",
    status: "wired" as ErrorStatus,
    httpStatus: null,
    retryable: false,
    sdkClass: "GislItemFailedError",
    description: "CARRIED, not thrown — an entry in a per-item failed[] collection describing one item's server-side failure. `errorCode` carries the server's own code where present; prefer branching on that over this entry.",
    metadataSchema: Object.freeze({
      "key": "string",
      "state": "string",
      "errorMessage": "string",
      "errorCode": "string",
    }),
  }),
});

export const ERROR_CATEGORIES: Readonly<Record<ErrorCategory, readonly ErrorCode[]>> = Object.freeze({
  api: Object.freeze([
    "feature_tier_restricted",
    "tier_restriction",
    "multipart_session_not_found",
    "upload_not_found",
    "workflow_expired",
    "balance_exhausted",
    "feature_not_available",
    "upload_size_exceeds_tier",
    "upload_duration_exceeds_tier",
    "probe_pending",
    "requires_reencode",
    "image_dimensions_too_large",
    "unsupported_file_type",
    "workflow_failed",
    "sse_connection_limit_exceeded",
    "sse_capacity_exhausted",
    "long_form_concurrency_limit_exceeded",
    "item_failed",
  ] as readonly ErrorCode[]),
  config: Object.freeze([
    "stream_host_not_declared",
    "missing_credentials",
    "feature_requires_auth",
    "config_error",
    "bundle_already_archived",
    "sink_error",
  ] as readonly ErrorCode[]),
  network: Object.freeze([
    "timeout",
    "transport_failed",
    "request_not_sent",
    "download_rejected",
    "download_unavailable",
    "aborted",
    "upload_failed",
    "fan_out_timeout",
  ] as readonly ErrorCode[]),
  auth: Object.freeze([
    "auth_failed",
    "multipart_session_ownership",
    "multipart_session_auth_required",
    "unprocessable_entity",
    "email_same",
  ] as readonly ErrorCode[]),
  validation: Object.freeze([
    "multipart_part_invalid",
    "multipart_part_count_exceeded",
    "validation_failed",
    "validation_error",
    "cyclic_workflow_edges",
    "workflow_edge_references_unknown_job",
    "reserved_job_id_pattern",
    "cyclic_job_output_source_graph",
    "inputs_not_concat_uniform",
    "invalid_options",
    "invalid_combination",
    "missing_dependency",
    "unsupported_value",
    "type_mismatch",
    "result_not_ready",
  ] as readonly ErrorCode[]),
  chain: Object.freeze([
    "undeclared_asset",
    "unused_asset",
    "per_input_options_not_supported",
    "chain_cardinality_mismatch",
    "no_such_key",
  ] as readonly ErrorCode[]),
});
