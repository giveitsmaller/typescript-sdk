/**
 * Operation-builder layer for the SDK ergonomic surface (T2 / xVDTIm8C).
 *
 * Composes `GislClient` — does NOT subclass. Each `client.<op>(input, options)`
 * returns an `OperationBuilder`; calling `.run()` orchestrates the full
 * upload → createWorkflow → wait → getWorkflowDownloads → flat `Result`
 * projection chain. `.submit({webhook})` skips the wait + downloads steps
 * and returns a lighter `Handle` instead.
 *
 * Wire-truth boundaries:
 * - `Result.artifacts` is a FLAT projection of `WorkflowDownloadResponse`
 *   (`downloads[].files[]`) with `url` aliasing `downloadUrl`. Every other
 *   field is verbatim from `OperationDownload` (`generated/typescript/openapi/
 *   models/OperationDownload.ts`). A drift-assertion in `index.ts` fires at
 *   `tsc --noEmit` if a contracts regen renames or drops any projected field.
 * - `onProgress` callbacks receive a **SDK-SYNTHESISED discriminated union**:
 *   `{phase: 'upload', uploadedBytes, totalBytes}` comes from
 *   `UploadOptions.onProgress` (byte-counter only, no wire field for it).
 *   `{phase: 'processing', status, progress, jobRef, ...}` projects
 *   `SseOperationProgressData`. The `phase` discriminator is SDK-added;
 *   `status` values pass through verbatim from `SseOperationProgressDataStatusEnum`.
 *   The wire does NOT carry a `phase` field — see karen reality-check 2026-05-23.
 * - `.run()` requires `maxWait` (no default). The underlying `waitForWorkflow`
 *   has a 300s default for the poll fallback path; the ergonomic layer makes
 *   it MANDATORY in the type so callers consciously choose a deadline.
 */

import type { GislClient } from './client.js';
import type {
  OperationDownload,
  WorkflowStatusResponse,
  SseOperationProgressData,
  SseOperationProgressDataStatusEnum,
} from '@giveitsmaller/contracts/openapi';
import {
  SseEventType,
  SseOperationProgressDataFromJSON,
} from '@giveitsmaller/contracts/openapi';
import type {
  GislSseEvent,
  JobDefinitionPayload,
  OperationDef,
  UploadOptions,
  WorkflowCreatePayload,
} from './types.js';
import { uploadSource } from './types.js';
import { GislTimeoutError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single deliverable output file. Flat projection of `OperationDownload`
 * (`generated/typescript/openapi/models/OperationDownload.ts`) with `url`
 * aliasing `downloadUrl` + the parent `JobDownload`'s `ref` + `jobId`
 * carried in. Drift-asserted against the source type.
 */
export interface Artifact {
  /** Pre-signed download URL (aliases `OperationDownload.downloadUrl`). */
  readonly url: string;
  /** Output filename. */
  readonly filename: string;
  /** Output file size in bytes. */
  readonly sizeBytes: number;
  /** Operation type that produced this file. */
  readonly operation: string;
  /** UUID v7 of the operation. */
  readonly operationId: string;
  /** Parent job UUID v7. */
  readonly jobId: string;
  /** Parent job reference label. */
  readonly ref: string;
  /** 1-based page number for PDF-page fan-out (mutually exclusive with `position`). */
  readonly pageIndex?: number;
  /** 0-based ordinal for non-PDF multi-output (mutually exclusive with `pageIndex`). */
  readonly position?: number;
}

/**
 * Per-job operation status entry — failure diagnostics live HERE
 * (`OperationResponse.errorCode`/`errorMessage`), NOT on the parent job.
 * Codex r1 medium 5d098e0f135e — previous JobBreakdown shape lost failure
 * details on `partially_failed` workflows.
 */
export interface OperationBreakdown {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly progress?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Per-job breakdown surfaced on `Result.jobs`. Used for inspecting partial
 * failures: when `status === 'partially_failed'` inspect `operations[]` —
 * each `OperationBreakdown` carries `errorCode`/`errorMessage`.
 */
export interface JobBreakdown {
  readonly jobId: string;
  readonly ref: string;
  readonly status: string;
  readonly operations: readonly OperationBreakdown[];
}

/**
 * Preset → resolved-options projection. T2 placeholder: `preset` is always
 * `null` until T4 ships the preset matrix. The shape itself is normative
 * per `docs/plans/sdk-ergonomics/plan.md` §11b.
 */
export interface ResolvedOptions {
  readonly preset: string | null;
  readonly applied: Record<string, unknown>;
  readonly overrides: readonly string[];
  readonly presetVersion: string;
}

/**
 * Flat result projection. `Result.artifacts` is always an array (empty
 * on failure); error info surfaces via `status === 'failed'` and
 * per-job `errorCode`/`errorMessage` on `jobs`.
 */
export interface Result {
  readonly workflowId: string;
  readonly status: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly artifacts: readonly Artifact[];
  readonly jobs: readonly JobBreakdown[];
  /** Sugar for `artifacts[0].url` when `artifacts.length === 1`; undefined otherwise. */
  readonly url?: string;
  /**
   * Preset-resolution introspection (placeholder until T4). Plain data
   * property — populated eagerly so `JSON.stringify(result)` round-trips
   * cleanly (codex-reviewer P1: method-valued fields silently drop on
   * `JSON.stringify`).
   */
  readonly resolvedOptions: ResolvedOptions;
}

/**
 * Lighter return value from `.submit({webhook})` — no SSE/poll wait,
 * caller reconciles completion via the webhook.
 */
export interface Handle {
  readonly workflowId: string;
  readonly webhookSecret?: string;
}

// ---------------------------------------------------------------------------
// Progress contract — SDK-SYNTHESISED, NOT a wire field
// ---------------------------------------------------------------------------

/**
 * Upload-phase progress event. The byte counter comes from
 * `UploadOptions.onProgress` — there is no `phase` field on the wire.
 */
export interface UploadProgressEvent {
  readonly phase: 'upload';
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

/**
 * Processing-phase progress event. Projects `SseOperationProgressData`
 * verbatim with the `phase` discriminator added by the SDK.
 * `status` passes through as-is from `SseOperationProgressDataStatusEnum`
 * (`started | downloading | probing | decoding | processing | encoding | uploading`).
 * Optional fields mirror the wire shape.
 */
export interface ProcessingProgressEvent {
  readonly phase: 'processing';
  readonly status?: SseOperationProgressDataStatusEnum;
  readonly progress: number;
  readonly jobRef: string;
  readonly operationId: string;
  readonly stage?: string;
  /**
   * 1-based index of the input currently being processed (e.g. "probing
   * input 2/4" on long-form merges). Wire field: `phase_input_index` ->
   * `phaseInputIndex` per codex r2 ed873d706d96.
   */
  readonly phaseInputIndex?: number;
  /** Total number of inputs in the current phase, paired with `phaseInputIndex`. */
  readonly phaseTotalInputs?: number;
}

export type ProgressEvent = UploadProgressEvent | ProcessingProgressEvent;

// ---------------------------------------------------------------------------
// Call-time options
// ---------------------------------------------------------------------------

export interface RunOptions {
  /**
   * Wall-clock deadline for the entire run (upload + create + wait + downloads).
   * MANDATORY — the SDK does NOT supply a default because the underlying
   * `waitForWorkflow` poll path has a 300s default that would otherwise
   * leak silently. Pass `'2h'` / `'30m'` / `'120s'` as a string suffix or
   * a number of milliseconds.
   */
  readonly maxWait: string | number;
  /** Abort signal — terminates upload, SSE, and poll cleanly. */
  readonly signal?: AbortSignal;
  /** Progress callback receiving the SDK-synthesised discriminated union. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /**
   * Force the poll fallback instead of attempting SSE. Default `true`
   * (SSE preferred; falls back to poll on connect failure). Set `false`
   * to skip SSE entirely — useful for environments where SSE is blocked
   * by an intermediary proxy.
   */
  readonly useSSE?: boolean;
  /** Override the poll interval used by the fallback (ms). */
  readonly pollIntervalMs?: number;
}

export interface SubmitOptions {
  /** Webhook URL — wired to `WorkflowCreateRequest.callback_url`. */
  readonly webhook: string;
}

// ---------------------------------------------------------------------------
// OperationBuilder
// ---------------------------------------------------------------------------

/**
 * Captures the (op-type, input, options) tuple for one ergonomic-layer
 * operation call. Holds a reference to the underlying `GislClient`;
 * does NOT extend or subclass it. Calling `.run()` or `.submit()`
 * triggers the orchestration; the builder itself is inert until then.
 */
export class OperationBuilder {
  constructor(
    private readonly client: GislClient,
    private readonly opType: string,
    // Widened to match `GislClient.uploadFile`'s `string | Blob` parameter
    // (codex r1 low 89cae59f4f04 — Blob/File uploads supported by the low-
    // level SDK must type-check through the ergonomic surface too).
    private readonly input: string | Blob,
    private readonly opOptions: Record<string, unknown>,
  ) {}

  /**
   * Execute the operation end-to-end. Uploads the input, creates the
   * workflow, waits to a terminal status (via SSE with poll fallback),
   * fetches downloads, and projects to a flat `Result`. Throws
   * `GislTimeoutError` if `maxWait` elapses before terminal status.
   */
  async run(options: RunOptions): Promise<Result> {
    const deadline = Date.now() + parseMaxWait(options.maxWait);
    const signal = options.signal;
    const onProgress = options.onProgress;
    const useSSE = options.useSSE ?? true;

    // 1. Upload — emits {phase:'upload'} progress events from byte-counter.
    const uploadOpts: UploadOptions = { signal };
    if (onProgress !== undefined) {
      uploadOpts.onProgress = (uploadedBytes: number, totalBytes: number) => {
        onProgress({ phase: 'upload', uploadedBytes, totalBytes });
      };
    }
    const uploadResp = await this.client.uploadFile(this.input, uploadOpts);
    checkAborted(signal);

    // Codex r2 medium 9a117f04eb59 — check deadline AFTER upload so a slow
    // upload doesn't proceed to createWorkflow past the caller's deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Upload completed but maxWait elapsed before workflow could be created`,
      );
    }

    // 2. Build + create the workflow.
    const job: JobDefinitionPayload = {
      id: 'op',
      source: uploadSource(uploadResp.fileId),
      operations: [{ type: this.opType as OperationDef['type'], options: this.opOptions }],
    };
    const payload: WorkflowCreatePayload = { jobs: [job] };
    const created = await this.client.createWorkflow(payload);
    checkAborted(signal);

    // 3. Wait to terminal status.
    const finalStatus = await this.awaitTerminal({
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      useSSE,
      pollIntervalMs: options.pollIntervalMs,
    });

    // 4. Fetch downloads + project. Codex r1 medium 42a6ea3b6102 — the
    // `maxWait` deadline covers upload + create + wait + downloads, so check
    // the deadline before issuing the downloads request rather than letting
    // a slow getWorkflowDownloads silently exceed it.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    return projectResult(finalStatus, downloads.downloads, this.opOptions);
  }

  /**
   * Fire-and-forget: upload the input + create the workflow with a
   * `callback_url` wired to the supplied `webhook`, then return a
   * `Handle` (workflowId + webhookSecret) without waiting. The webhook
   * receives completion + the `webhookSecret` is the verifier seed.
   */
  async submit(options: SubmitOptions): Promise<Handle> {
    const uploadResp = await this.client.uploadFile(this.input);

    const job: JobDefinitionPayload = {
      id: 'op',
      source: uploadSource(uploadResp.fileId),
      operations: [{ type: this.opType as OperationDef['type'], options: this.opOptions }],
    };
    const payload: WorkflowCreatePayload = {
      jobs: [job],
      callback_url: options.webhook,
    };
    const created = await this.client.createWorkflow(payload);

    const handle: Handle = {
      workflowId: created.workflowId,
      ...(created.webhookSecret != null ? { webhookSecret: created.webhookSecret } : {}),
    };
    return handle;
  }

  // -------------------------------------------------------------------------

  private async awaitTerminal(args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    onProgress: ((event: ProgressEvent) => void) | undefined;
    useSSE: boolean;
    pollIntervalMs?: number;
  }): Promise<WorkflowStatusResponse> {
    if (args.useSSE) {
      try {
        return await consumeSseToTerminal(this.client, args);
      } catch (err) {
        // Caller-aborted or deadline-elapsed errors MUST propagate — they
        // are NOT transient SSE failures. Only fall through to poll on a
        // genuine SSE connect/mid-stream error (codex-reviewer P0).
        if (err instanceof GislTimeoutError) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        // Genuine SSE connect / stream error — fall through to poll fallback.
      }
    }
    return await pollToTerminal(this.client, args);
  }
}

// ---------------------------------------------------------------------------
// Internals — SSE + poll
// ---------------------------------------------------------------------------

const TERMINAL_STATUS = new Set([
  'completed',
  'failed',
  'partially_failed',
  'cancelled',
  'expired',
  'paused_insufficient_credits',
]);

async function consumeSseToTerminal(
  client: GislClient,
  args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    onProgress: ((event: ProgressEvent) => void) | undefined;
  },
): Promise<WorkflowStatusResponse> {
  const remainingMs = args.deadline - Date.now();
  if (remainingMs <= 0) {
    throw new GislTimeoutError(
      `Workflow ${args.workflowId} did not complete before maxWait deadline`,
    );
  }
  const sseAbort = new AbortController();
  // Compose caller's signal + a SDK-internal one so we can tear down on terminal.
  const onCallerAbort = (): void => sseAbort.abort();
  if (args.signal !== undefined) {
    if (args.signal.aborted) sseAbort.abort();
    else args.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  // Codex r1 high 06f8dceefd76 — a quiet but still-open SSE stream would
  // block forever in `for await` since the deadline check inside the loop
  // only fires when an event arrives. Arm a remaining-time timer that
  // aborts the SSE; raise GislTimeoutError when it fires.
  let deadlineExpired = false;
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    sseAbort.abort();
  }, remainingMs);
  try {
    let events: AsyncIterableIterator<GislSseEvent>;
    try {
      events = await client.streamEvents(args.workflowId, { signal: sseAbort.signal });
    } catch (err) {
      // If streamEvents rejected because the deadline-armed sseAbort fired
      // before/during connect, surface as timeout (not raw AbortError).
      if (deadlineExpired && err instanceof DOMException && err.name === 'AbortError') {
        throw new GislTimeoutError(
          `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        );
      }
      throw err;
    }
    // for-await also throws if the iterator's .next() rejects (e.g. the
    // SSE generator awaiting on sseAbort.signal rejects with AbortError).
    // Same deadline-conversion guard applies to mid-stream rejections.
    try {
    for await (const event of events) {
      if (deadlineExpired) {
        throw new GislTimeoutError(
          `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        );
      }
      if (args.onProgress !== undefined && event.event === SseEventType.operation_progress) {
        // Codex r1 high d6485d3e35f9 — `streamEvents` yields raw snake_case
        // wire data. Deserialise via the generator-provided FromJSON helper
        // to map snake_case -> camelCase BEFORE projecting; otherwise
        // `data.jobRef` / `data.operationId` are undefined at runtime.
        const data = SseOperationProgressDataFromJSON(event.data) as SseOperationProgressData;
        const proj: ProcessingProgressEvent = {
          phase: 'processing',
          progress: data.progress,
          jobRef: data.jobRef,
          operationId: data.operationId,
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.stage !== undefined ? { stage: data.stage } : {}),
          ...((data as { phaseInputIndex?: number }).phaseInputIndex !== undefined
            ? { phaseInputIndex: (data as { phaseInputIndex?: number }).phaseInputIndex }
            : {}),
          ...((data as { phaseTotalInputs?: number }).phaseTotalInputs !== undefined
            ? { phaseTotalInputs: (data as { phaseTotalInputs?: number }).phaseTotalInputs }
            : {}),
        };
        args.onProgress(proj);
      }
      if (
        event.event === SseEventType.workflow_completed ||
        event.event === SseEventType.workflow_failed ||
        event.event === SseEventType.workflow_partially_failed
      ) {
        sseAbort.abort();
        // After terminal SSE, we still call getWorkflowStatus once for the
        // final shape — the SSE event carries partial data, but the status
        // endpoint is the canonical structured response.
        return await client.getWorkflowStatus(args.workflowId);
      }
      if (Date.now() >= args.deadline) {
        sseAbort.abort();
        throw new GislTimeoutError(
          `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        );
      }
    }
    // Stream ended cleanly without terminal. If the deadline timer fired
    // mid-stream and triggered the abort, surface that as the timeout.
    if (deadlineExpired) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
      );
    }
    // Otherwise it was a clean server-side close — fall back to poll.
    throw new Error('SSE stream ended without terminal event');
    } catch (innerErr) {
      // Same conversion as the outer catch: if deadline expired and the
      // iterator rejected with AbortError, surface as GislTimeoutError.
      if (
        deadlineExpired &&
        innerErr instanceof DOMException &&
        innerErr.name === 'AbortError'
      ) {
        throw new GislTimeoutError(
          `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        );
      }
      throw innerErr;
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (args.signal !== undefined) {
      args.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

async function pollToTerminal(
  client: GislClient,
  args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    pollIntervalMs?: number;
  },
): Promise<WorkflowStatusResponse> {
  // Codex r1 medium 89130e3ea75d — guard against 0/negative/NaN/Infinity
  // pollIntervalMs values that would hammer getWorkflowStatus until maxWait.
  const requested = args.pollIntervalMs;
  let intervalMs: number;
  if (requested === undefined) {
    intervalMs = 2_000;
  } else if (!Number.isFinite(requested) || requested < 100) {
    // Clamp to a safe minimum (100ms) rather than throw — small/zero/NaN
    // were almost certainly a caller mistake, but ergonomic-layer
    // shouldn't crash an otherwise valid run on this.
    intervalMs = 100;
  } else {
    intervalMs = requested;
  }
  while (true) {
    checkAborted(args.signal);
    if (Date.now() >= args.deadline) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
      );
    }
    const status = await client.getWorkflowStatus(args.workflowId);
    if (TERMINAL_STATUS.has(status.status)) {
      return status;
    }
    // Codex-reviewer P0: also check the deadline AFTER the status fetch — a
    // slow getWorkflowStatus call could put us past the deadline without the
    // pre-fetch check firing. Without this, a small `pollIntervalMs` against
    // a slow API can busy-spin past the deadline arbitrarily.
    if (Date.now() >= args.deadline) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
      );
    }
    if (Date.now() + intervalMs >= args.deadline) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
      );
    }
    await sleep(intervalMs, args.signal);
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function projectResult(
  status: WorkflowStatusResponse,
  jobDownloads: readonly { ref: string; jobId: string; files: readonly OperationDownload[] }[],
  appliedOptions: Record<string, unknown>,
): Result {
  const artifacts: Artifact[] = [];
  for (const job of jobDownloads) {
    for (const file of job.files) {
      const a: Artifact = {
        url: file.downloadUrl,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        operation: file.operation,
        operationId: file.operationId,
        jobId: job.jobId,
        ref: job.ref,
        ...(file.pageIndex !== undefined ? { pageIndex: file.pageIndex } : {}),
        ...(file.position !== undefined ? { position: file.position } : {}),
      };
      artifacts.push(a);
    }
  }

  // Codex r1 medium 5d098e0f135e — error diagnostics live on
  // OperationResponse.errorCode/errorMessage, NOT on JobResponse. Project
  // each operation explicitly so failed runs preserve the per-operation
  // failure details.
  type _RawJob = {
    jobId: string;
    ref: string;
    status: string;
    operations?: readonly _RawOperation[];
  };
  type _RawOperation = {
    id: string;
    type: string;
    status: string;
    progress?: number;
    errorCode?: string;
    errorMessage?: string;
  };
  const jobs: JobBreakdown[] = ((status as unknown as { jobs?: readonly _RawJob[] }).jobs ?? []).map(
    (j) => ({
      jobId: j.jobId,
      ref: j.ref,
      status: j.status,
      operations: (j.operations ?? []).map((op) => ({
        id: op.id,
        type: op.type,
        status: op.status,
        ...(op.progress !== undefined ? { progress: op.progress } : {}),
        ...(op.errorCode !== undefined ? { errorCode: op.errorCode } : {}),
        ...(op.errorMessage !== undefined ? { errorMessage: op.errorMessage } : {}),
      })),
    }),
  );

  // Codex r2 medium 3d229f9bc1fb — generated FromJSON deserializes timestamps
  // as Date objects. String(date) gives a locale/timezone-dependent toString();
  // we want canonical ISO-8601 round-trip with the wire shape.
  const isoIfDate = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  const result: Result = {
    workflowId: status.workflowId,
    status: status.status,
    ...(status.createdAt !== undefined ? { createdAt: isoIfDate(status.createdAt) } : {}),
    ...(status.updatedAt !== undefined ? { updatedAt: isoIfDate(status.updatedAt) } : {}),
    artifacts,
    jobs,
    ...(artifacts.length === 1 ? { url: artifacts[0].url } : {}),
    resolvedOptions: {
      preset: null,
      applied: { ...appliedOptions },
      overrides: [],
      presetVersion: '1.0',
    },
  };
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = (): void => {
      clearTimeout(t);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Parse a `maxWait` argument: number = milliseconds; string with suffix
 * `ms` / `s` / `m` / `h`. Throws if the string is malformed.
 */
function parseMaxWait(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`maxWait must be a positive finite number; got ${value}`);
    }
    return value;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (match === null) {
    throw new TypeError(
      `maxWait string must look like '500ms', '120s', '30m', '2h'; got '${value}'`,
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1_000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    /* istanbul ignore next */
    default:
      throw new TypeError(`Unknown maxWait unit '${unit}'`);
  }
}
