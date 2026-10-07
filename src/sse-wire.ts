// iOcpCt6L — the WIRE shapes of the SSE `event.data` payloads.
//
// `parseSseStream` / `streamEvents` hand `event.data` over exactly as
// `JSON.parse` produced it: snake_case keys, no `*FromJSON` conversion. That is
// a deliberate cross-SDK decision (2026-05-16; see `GislSseEvent.php` and the
// shared `tests/parity/fixtures/sse_*.yaml`, which assert snake_case data for
// both SDKs). These interfaces describe THAT object. The camelCase
// `Sse*Data` models from `@giveitsmaller/contracts/openapi` describe the output
// of the generated `*FromJSON` helpers, which the stream never runs.
//
// They are hand-written, so they can drift from the contract. The drift gate is
// `tests/unit/sse-wire-drift.test.ts`: it compares every interface's key set
// (and which keys are required) with the vendored OpenAPI schema it mirrors,
// and fails when the contract adds, removes or renames a property. Edit the
// interface and that test's key list together.

import type { OperationType, ReEncodeDecision } from '@giveitsmaller/contracts/openapi';

/** `data` of `operation.progress`. Mirrors `SseOperationProgressData`. */
export interface SseOperationProgressWire {
  readonly job_ref: string;
  readonly operation_id: string;
  readonly type: OperationType;
  /** Absent means "processing"; the long-form phases are `probing` / `decoding` / `encoding`. */
  readonly status?:
    | 'started'
    | 'downloading'
    | 'probing'
    | 'decoding'
    | 'processing'
    | 'encoding'
    | 'uploading';
  /** 0-100. */
  readonly progress: number;
  readonly stage?: string;
  /** 1-based input being processed in this phase. */
  readonly phase_input_index?: number;
  readonly phase_total_inputs?: number;
}

/** `result.metrics` on a single-output completion. Mirrors `OperationResult.metrics`. */
export interface SseOperationResultMetricsWire {
  readonly compression_ratio?: number;
  readonly chosen_quality?: number;
  readonly target_size_met?: boolean;
  readonly measured_quality?: number;
  /** Advisory vocabulary: a value outside today's set is not an error. */
  readonly quality_metric?: string;
  readonly duration_ms?: number;
  /** Open enum in the contract: an unlisted value may arrive. */
  readonly re_encode_decision?: ReEncodeDecision | (string & {});
  /** Advisory vocabulary. */
  readonly re_encode_reason?: string;
}

/**
 * Single-output arm of `operation.completed`'s `result`
 * (`result_kind: 'single'`). Mirrors `SseSingleOutputCompletion`.
 */
export interface SseSingleOutputCompletionWire {
  readonly result_kind: 'single';
  readonly download_url: string;
  readonly size_bytes: number;
  readonly mime_type?: string;
  readonly export_key?: string;
  readonly metrics?: SseOperationResultMetricsWire;
}

/**
 * One file of a multi-output completion. Mirrors `SseMultiOutputResultEntry`.
 * `page_index` (1-based source page, PDF fan-out) and `position` (0-based
 * ordinal) are mutually exclusive; an entry may carry neither.
 */
export interface SseMultiOutputResultEntryWire {
  readonly download_url: string;
  readonly size_bytes: number;
  readonly page_index?: number;
  readonly position?: number;
}

/** Aggregate `result.metrics` on a multi-output completion. */
export interface SseMultiOutputCompletionMetricsWire {
  readonly compression_ratio?: number;
  readonly duration_ms?: number;
}

/**
 * Multi-output arm of `operation.completed`'s `result`
 * (`result_kind: 'multi'`). Mirrors `SseMultiOutputCompletionWithKind`.
 */
export interface SseMultiOutputCompletionWire {
  readonly result_kind: 'multi';
  /** 1-200 entries; use `outputs.length` for the count. */
  readonly outputs: readonly SseMultiOutputResultEntryWire[];
  /** Sum of `outputs[].size_bytes`; trust the per-entry sum if they disagree. */
  readonly total_output_size_bytes: number;
  readonly metrics?: SseMultiOutputCompletionMetricsWire;
}

/** `operation.completed`'s `result`: narrow on `result_kind`. */
export type SseOperationCompletionResultWire =
  | SseSingleOutputCompletionWire
  | SseMultiOutputCompletionWire;

/** `result_metadata` on `operation.completed`. Mirrors `OperationResultMetadata`. */
export interface SseOperationResultMetadataWire {
  readonly watermark_id?: string;
  readonly already_optimal?: boolean;
  readonly already_optimal_kind?: 'not_smaller';
  readonly estimated_saving_pct?: number;
}

/** `data` of `operation.completed`. Mirrors `SseOperationCompletedData`. */
export interface SseOperationCompletedWire {
  readonly job_ref: string;
  readonly operation_id: string;
  readonly type: OperationType;
  readonly status: 'completed';
  readonly progress: 100;
  /**
   * May be absent (multi-output completions on older servers, or a frame
   * published before the result resolved): fall back to the downloads endpoint.
   */
  readonly result?: SseOperationCompletionResultWire;
  /** Absent means "not carried on this frame", not "no metadata". */
  readonly result_metadata?: SseOperationResultMetadataWire;
}

/** `data` of `operation.failed`. Mirrors `SseOperationFailedData`. */
export interface SseOperationFailedWire {
  readonly job_ref: string;
  readonly operation_id: string;
  readonly type: OperationType;
  readonly status: 'failed';
  /** Same vocabulary as `OperationResponse.error_code`; degrade an unknown value to a generic reason. */
  readonly error_code: string;
  readonly error_message: string;
  readonly message_key?: string;
  readonly message_params?: Readonly<Record<string, string | number | boolean>>;
}

/** `data` of `job.completed`. Mirrors `SseJobCompletedData`. */
export interface SseJobCompletedWire {
  readonly job_ref: string;
  readonly job_id: string;
  readonly status: 'completed';
}

/** `data` of `job.failed`. Mirrors `SseJobFailedData`. */
export interface SseJobFailedWire {
  readonly job_ref: string;
  readonly job_id: string;
  readonly status: 'failed';
}

/**
 * `data` of `workflow.completed`, `workflow.failed` and
 * `workflow.partially_failed`. Mirrors `SseWorkflowTerminalData`.
 */
export interface SseWorkflowTerminalWire {
  readonly workflow_id: string;
  readonly status: 'completed' | 'failed' | 'partially_failed';
  /** Free-form advisory text; `status` is the binding terminal state. */
  readonly reason?: string;
}
