import type {
  OperationType,
  CallbackEventType,
  SseEventType,
  SseOperationProgressData,
  SseOperationCompletedData,
  SseOperationFailedData,
  SseJobCompletedData,
  SseJobFailedData,
  SseWorkflowTerminalData,
} from '@giveitsmaller/contracts/openapi';

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface GislClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  /** Threshold in bytes above which multipart upload is used (default: 10MB) */
  multipartThreshold?: number;
  /** Max concurrent chunk uploads for multipart (default: 4) */
  multipartConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Job definition (typed replacement for generated `any`)
// ---------------------------------------------------------------------------

export interface OperationDef {
  type: OperationType;
  options?: Record<string, unknown>;
}

/** Job sourced from an uploaded file */
export interface FileJobPayload {
  ref: string;
  file_id: string;
  operations: OperationDef[];
}

/** Job sourced from a single upstream job's output */
export interface SourceJobPayload {
  ref: string;
  source: { ref: string; operation?: string };
  operations: OperationDef[];
}

/** Job sourced from multiple upstream jobs (merge/archive) */
export interface InputsJobPayload {
  ref: string;
  inputs: Array<{
    ref: string;
    operation?: string;
    per_input_options?: Record<string, unknown>;
  }>;
  operations: OperationDef[];
}

export type JobDefinitionPayload =
  | FileJobPayload
  | SourceJobPayload
  | InputsJobPayload;

// ---------------------------------------------------------------------------
// Job factory functions
// ---------------------------------------------------------------------------

export function fileJob(
  ref: string,
  fileId: string,
  operations: OperationDef[],
): FileJobPayload {
  return { ref, file_id: fileId, operations };
}

export function sourceJob(
  ref: string,
  source: { ref: string; operation?: string },
  operations: OperationDef[],
): SourceJobPayload {
  return { ref, source, operations };
}

export function inputsJob(
  ref: string,
  inputs: Array<{
    ref: string;
    operation?: string;
    per_input_options?: Record<string, unknown>;
  }>,
  operations: OperationDef[],
): InputsJobPayload {
  return { ref, inputs, operations };
}

// ---------------------------------------------------------------------------
// Workflow creation request (SDK-level, wire-format ready)
// ---------------------------------------------------------------------------

export interface WorkflowCreatePayload {
  jobs: JobDefinitionPayload[];
  workflow_edges?: Array<{ from: string; to: string }>;
  callback_url?: string;
  callback_events?: CallbackEventType[];
  export?: {
    service: 's3';
    bucket: string;
    key_prefix?: string;
    role_arn: string;
  };
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
}
