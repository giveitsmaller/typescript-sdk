// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.

export type ErrorCode =
  | "missing_credentials"
  | "feature_requires_auth"
  | "undeclared_asset"
  | "unused_asset"
  | "per_input_options_not_supported"
  | "chain_cardinality_mismatch"
  | "multipart_part_invalid"
  | "multipart_part_count_exceeded"
  | "timeout"
  | "aborted"
  | "validation_failed"
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
  | "workflow_expired"
  | "balance_exhausted"
  | "feature_not_available"
  | "upload_size_exceeds_tier"
  | "upload_duration_exceeds_tier"
  | "probe_pending"
  | "requires_reencode"
  | "invalid_options"
  | "invalid_combination"
  | "missing_dependency"
  | "unsupported_value"
  | "type_mismatch"
  | "upload_failed"
  | "workflow_failed";

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
    sdkClass: "GislApiError",
    description: "422 on workflow create — upload probing not yet complete; retry after the upload finishes probing. Wire `error_type: \"probe_pending\"`.",
    metadataSchema: Object.freeze({
      "jobRef": "string",
    }),
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
    description: "422 — operation option failed server-side validation (range, depends_on, mutex). Often surfaces preflight rejections (e.g. split.cut_points len exceeds 200-output cap).",
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
});

export const ERROR_CATEGORIES: Readonly<Record<ErrorCategory, readonly ErrorCode[]>> = Object.freeze({
  api: Object.freeze([
    "feature_tier_restricted",
    "tier_restriction",
    "multipart_session_not_found",
    "workflow_expired",
    "balance_exhausted",
    "feature_not_available",
    "upload_size_exceeds_tier",
    "upload_duration_exceeds_tier",
    "probe_pending",
    "requires_reencode",
    "workflow_failed",
  ] as readonly ErrorCode[]),
  config: Object.freeze([
    "missing_credentials",
    "feature_requires_auth",
  ] as readonly ErrorCode[]),
  network: Object.freeze([
    "timeout",
    "aborted",
    "upload_failed",
  ] as readonly ErrorCode[]),
  auth: Object.freeze([
    "auth_failed",
    "multipart_session_ownership",
    "multipart_session_auth_required",
  ] as readonly ErrorCode[]),
  validation: Object.freeze([
    "multipart_part_invalid",
    "multipart_part_count_exceeded",
    "validation_failed",
    "cyclic_workflow_edges",
    "workflow_edge_references_unknown_job",
    "reserved_job_id_pattern",
    "cyclic_job_output_source_graph",
    "invalid_options",
    "invalid_combination",
    "missing_dependency",
    "unsupported_value",
    "type_mismatch",
  ] as readonly ErrorCode[]),
  chain: Object.freeze([
    "undeclared_asset",
    "unused_asset",
    "per_input_options_not_supported",
    "chain_cardinality_mismatch",
  ] as readonly ErrorCode[]),
});
