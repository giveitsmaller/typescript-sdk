export type ErrorCode = "missing_credentials" | "feature_requires_auth" | "undeclared_asset" | "unused_asset" | "per_input_options_not_supported" | "chain_cardinality_mismatch" | "multipart_part_invalid" | "multipart_part_count_exceeded" | "timeout" | "aborted" | "validation_failed" | "validation_error" | "cyclic_workflow_edges" | "workflow_edge_references_unknown_job" | "reserved_job_id_pattern" | "cyclic_job_output_source_graph" | "auth_failed" | "feature_tier_restricted" | "tier_restriction" | "multipart_session_ownership" | "multipart_session_auth_required" | "multipart_session_not_found" | "upload_not_found" | "workflow_expired" | "balance_exhausted" | "feature_not_available" | "upload_size_exceeds_tier" | "upload_duration_exceeds_tier" | "probe_pending" | "requires_reencode" | "invalid_options" | "invalid_combination" | "missing_dependency" | "unsupported_value" | "type_mismatch" | "image_dimensions_too_large" | "upload_failed" | "workflow_failed" | "sse_connection_limit_exceeded" | "sse_capacity_exhausted" | "long_form_concurrency_limit_exceeded" | "unprocessable_entity" | "email_same" | "config_error" | "bundle_already_archived" | "fan_out_timeout" | "no_such_key" | "result_not_ready" | "sink_error" | "item_failed";
export type ErrorCategory = 'api' | 'config' | 'network' | 'auth' | 'validation' | 'chain';
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
export declare const ERROR_CODES: Readonly<Record<ErrorCode, ErrorEntry>>;
export declare const ERROR_CATEGORIES: Readonly<Record<ErrorCategory, readonly ErrorCode[]>>;
