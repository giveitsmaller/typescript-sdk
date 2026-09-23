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
 * - `.run()` takes an OPTIONAL options bag; `maxWait` defaults to
 *   `DEFAULT_POLL_TIMEOUT_MS`, the same constant the poll fallback and every
 *   file-first builder use. It was mandatory until 36AZ98FV, on the grounds
 *   that inheriting that default would "leak silently" — while the SDK applied
 *   it at fourteen sites regardless.
 */

import type { GislClient } from './client.js';
import { DEFAULT_POLL_TIMEOUT_MS } from './client.js';
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
import { parseRetryAfterMs } from './retry-metadata.js';
import { GislApiError, GislTimeoutError, GislFanOutTimeoutError, GislNetworkError, GislStreamHostNotDeclaredError, GislTransportError, SseConnectRefused, SseEndedWithoutTerminal } from './errors.js';
// Deferred-usage-only import: `Handle` is constructed inside submit() at call
// time, not at module load, so the builder.ts <-> handle.ts cycle is safe
// under ESM (handle.ts imports the await-primitives from this module).
import { Handle } from './handle.js';
import type { PresetDefaults, PresetMedia, DetectedMedia } from './ergonomic/presets/index.js';
import type { OptimizeFor } from './generated/sdk_spec/enums.js';
import {
  resolveCompressOptions,
  type ResolveCompressOptionsInput,
} from './ergonomic/preset_resolver.js';

/**
 * Best-effort detection of the compress-operation media from the
 * builder's input. T4b only resolves presets for compress; the wire's
 * operation type union already narrows here (`compress_image`,
 * `compress_video`, …) but the ergonomic builder takes a single
 * `compress` op type and infers media from filename extension /
 * content type at call time. Returns `undefined` when the input is
 * unresolvable (e.g. raw `Blob` without `.type`) — caller then falls
 * back to passthrough (no preset resolution).
 *
 * @internal — exported for tests + the preset resolver.
 */
export function _detectCompressMedia(input: string | Blob): DetectedMedia | undefined {
  let filename: string | undefined;
  let mime: string | undefined;
  if (typeof input === 'string') {
    filename = input;
  } else {
    mime = input.type !== '' ? input.type : undefined;
    const named = (input as { name?: string }).name;
    if (typeof named === 'string') filename = named;
  }
  // MIME-first if present — Blob.type is canonical.
  if (mime !== undefined) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/epub+zip') return 'document_epub';
    if (mime === 'application/pdf') return 'document_pdf';
    if (
      mime === 'application/vnd.oasis.opendocument.text' ||
      mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
      mime === 'application/vnd.oasis.opendocument.presentation'
    ) {
      return 'document_odf';
    }
    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mime === 'application/msword' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'application/vnd.ms-powerpoint'
    ) {
      return 'document_office';
    }
  }
  if (filename === undefined) return undefined;
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === undefined) return undefined;
  if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'tif', 'bmp', 'heic', 'heif'].includes(ext)) return 'image';
  if (['mp3', 'aac', 'm4a', 'ogg', 'oga', 'flac', 'wav', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'm4v'].includes(ext)) return 'video';
  if (ext === 'epub') return 'document_epub';
  if (ext === 'pdf') return 'document_pdf';
  if (['odt', 'ods', 'odp'].includes(ext)) return 'document_odf';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'document_office';
  return undefined;
}

// LOSSLESS audio per the compress.yaml contract (contracts iakhSy3E) —
// flac/wav ONLY. Everything else audio (mp3/mpeg, aac, ogg, m4a/mp4, opus)
// and any unknown input is treated as lossy so the shipped-preset bitrate is
// kept. `aiff` is deliberately absent — not a contract audio format.
const LOSSLESS_AUDIO_MIMES = new Set([
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
]);
const LOSSLESS_AUDIO_EXTENSIONS = new Set(['flac', 'wav']);

/**
 * Best-effort classification of whether an audio input is LOSSLESS
 * (flac/wav) vs lossy. The worker rejects `bitrate` on lossless audio
 * (compress.yaml / contracts iakhSy3E), so the preset resolver uses this
 * to drop the shipped-preset bitrate for clear-cut lossless inputs.
 *
 * Detection is filename/MIME only — it CANNOT probe the actual codec, so
 * any ambiguous or unknown input classifies as lossy (keep bitrate). The
 * worker stays authoritative: a user-supplied bitrate on a lossless file
 * still reaches the wire and earns a deliberate 422.
 *
 * @internal — exported for tests + the preset resolver.
 */
export function _detectAudioLossless(input: string | Blob): boolean {
  let filename: string | undefined;
  let mime: string | undefined;
  if (typeof input === 'string') {
    filename = input;
  } else {
    mime = input.type !== '' ? input.type : undefined;
    const named = (input as { name?: string }).name;
    if (typeof named === 'string') filename = named;
  }
  // MIME-first if a recognised audio MIME is present — Blob.type is canonical.
  // Strip any MIME parameters (`audio/flac; codecs=flac`) before the exact-set
  // lookup so a parameterised type still classifies as lossless — `media` is
  // already `audio` via the prefix check, so a miss would wrongly keep the
  // bitrate (codex 18b6b684).
  if (mime !== undefined && mime.startsWith('audio/')) {
    const bareMime = mime.split(';')[0]!.trim().toLowerCase();
    return LOSSLESS_AUDIO_MIMES.has(bareMime);
  }
  if (filename === undefined) return false;
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === undefined) return false;
  return LOSSLESS_AUDIO_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// ArtifactRef — the shape passed to `.mapEach(fn)` callbacks.
// ---------------------------------------------------------------------------

/**
 * Lightweight artifact reference passed to a `.mapEach(...)` fn. Mirrors
 * the subset of `Artifact` a fan-out callback can use to construct the
 * downstream operation (typically `art.url` + `art.jobId` / `art.ref` for
 * provenance). Future chain methods will extend this with the artifact-
 * backed input helpers (e.g. `art.compress(...)`).
 */
export interface ArtifactRef {
  readonly url: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly operation: string;
  readonly operationId: string;
  readonly jobId: string;
  readonly ref: string;
  readonly pageIndex?: number;
  readonly position?: number;
}

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
 * Per-source field-name buckets surfaced on
 * {@link ResolvedOptions.sources}. Each bucket lists the wire field
 * names (snake_case) contributed by that layer of the preset resolver.
 * Buckets are populated in resolver order (lowest precedence first);
 * a field that appears in a higher-precedence bucket WAS NOT also
 * present in a lower one (the resolver records winners, not all
 * participants).
 *
 * `scopedDefault` is reserved for T4c (`ULAlOP6j`) — `withPresetDefaults`
 * scoped derive. T4b populates it as `[]`.
 */
export interface ResolvedOptionsSources {
  readonly sdkDefault: readonly string[];
  readonly clientDefault: readonly string[];
  readonly scopedDefault: readonly string[];
  readonly callPresetOverride: readonly string[];
  readonly explicit: readonly string[];
}

/**
 * Preset → resolved-options projection. Plan §11b normative shape with
 * the T4b extension: `sources` (per-layer field-name buckets) +
 * `presetConfigHash` (sha256 over caller-side deltas, present iff any
 * non-SDK layer participated).
 *
 * `overrides: readonly string[]` is RETAINED for backward compat (T2
 * surface; current callers may read it). It is now a duplicate of
 * `sources.explicit` and will be removed in a future major. New code
 * should read `sources` instead.
 */
export interface ResolvedOptions {
  readonly preset: string | null;
  readonly applied: Record<string, unknown>;
  /**
   * @deprecated Use {@link ResolvedOptions.sources}.explicit. Retained
   * for backward compat with T2; mirrors `sources.explicit` exactly.
   */
  readonly overrides: readonly string[];
  readonly presetVersion: string;
  /**
   * Per-layer field-name buckets for the preset resolver. Populated by
   * T4b (`27rE1fZn`); legacy placeholder rows emit empty buckets.
   */
  readonly sources: ResolvedOptionsSources;
  /**
   * SHA-256 over the canonical JSON of `{clientDefault, scopedDefault,
   * callPresetOverride}` (sorted keys, no whitespace), hex-encoded,
   * prefix `sha256:`. ABSENT when only `sdkDefault` participated (or
   * when no preset resolution ran at all — pre-T4b placeholder).
   */
  readonly presetConfigHash?: string;
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
  /** Percent complete, `0-100` (the wire integer) — NOT a 0..1 fraction. */
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
   * Optional; defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. Pass `'2h'` / `'30m'` /
   * `'120s'` as a string suffix or a number of milliseconds.
   *
   * ⚠️ THIS WAS MANDATORY, on the stated grounds that a 600s default "would
   * otherwise leak silently" (36AZ98FV). The same tree applied exactly that
   * default at FOURTEEN sites across both SDKs, so the prohibition was refuted
   * by the code it protected — and the file-first spelling of the same task
   * accepted no arguments at all. One shared constant is what makes the rule
   * unnecessary rather than what breaks it.
   */
  readonly maxWait?: string | number;
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
  /**
   * Best-effort probe-before-create for a VIDEO upload that went multipart:
   * after upload, before createWorkflow, wait for the server's probe to land
   * so it admits the parallel video split. Default `true`; set `false` to
   * skip the wait entirely. Never-bounce — a give-up just proceeds to create.
   */
  readonly probeBeforeCreate?: boolean;
  /** Overall timeout (ms) for the probe-before-create wait. */
  readonly probeTimeoutMs?: number;
}

export interface SubmitOptions {
  /**
   * Webhook URL — wired to `WorkflowCreateRequest.callback_url`.
   *
   * Optional. `callback_url` is not in `WorkflowCreateRequest`'s required set and
   * is typed `string | null`, so omitting it is contract-valid. It was mandatory
   * here because the returned {@link Handle} carried no client and its
   * `status()`/`wait()`/`result()` threw `no_client` — the webhook was the only
   * channel by which the outcome could be learned. The handle is bound now
   * (36AZ98FV), so omitting the webhook leaves a usable handle rather than a
   * dead end.
   */
  readonly webhook?: string;
  /**
   * Best-effort probe-before-create for a VIDEO upload that went multipart.
   * Default `true`; set `false` to skip the wait. See {@link RunOptions}.
   */
  readonly probeBeforeCreate?: boolean;
  /** Overall timeout (ms) for the probe-before-create wait. */
  readonly probeTimeoutMs?: number;
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
    /**
     * Client-scope preset defaults wired through `wrapErgonomic` from
     * `gisl.create({ presetDefaults })` (T4b). When provided AND the
     * op type is `compress`, `run()`/`submit()` walk the preset
     * resolver before constructing the workflow payload. `undefined`
     * preserves the pre-T4b behaviour: pass `opOptions` through
     * verbatim.
     */
    private readonly presetDefaults?: PresetDefaults,
    /**
     * Scoped preset defaults from `client.withPresetDefaults(...)`
     * (T4c — `ULAlOP6j`). Layered between `presetDefaults` and per-call
     * `presetOverrides` in the resolver chain. `undefined` on clients
     * that haven't been through a `withPresetDefaults` call. The
     * derived ergonomic client's Proxy closes over the merged stack
     * (parent's scoped ⊕ new defaults via `PresetDefaults.merge`).
     */
    private readonly scopedPresetDefaults?: PresetDefaults,
  ) {}

  /**
   * Run the preset resolver for compress operations and return the
   * resolved `{wireOptions, resolvedOptions}` tuple. For non-compress
   * operations (or when the op doesn't have a known compress media
   * fingerprint), returns the legacy passthrough — `opOptions` direct
   * to the wire, placeholder `ResolvedOptions`.
   *
   * Throws `GislConfigError` for invalid combos BEFORE any network
   * round-trip — caller's signal is propagated, but we want fail-early
   * before the upload too.
   */
  private _resolve(): { wireOptions: Record<string, unknown>; resolvedOptions?: ResolvedOptions } {
    if (this.opType !== 'compress') {
      return { wireOptions: { ...this.opOptions } };
    }
    const media = _detectCompressMedia(this.input);
    if (media === undefined) {
      // Unknown media (e.g. Blob without a recognised filename
      // extension) — fall back to passthrough. The wire will still
      // accept the call, just no preset resolution.
      return { wireOptions: { ...this.opOptions } };
    }
    const { optimize, presetOverrides, ...explicitOptions } = this.opOptions as {
      optimize?: OptimizeFor;
      presetOverrides?: Readonly<Record<string, unknown>>;
      [k: string]: unknown;
    };
    const input: ResolveCompressOptionsInput = {
      media,
      op: 'compress',
      explicitOptions,
    };
    if (media === 'audio') {
      (input as { audioLossless?: boolean }).audioLossless = _detectAudioLossless(this.input);
    }
    if (this.presetDefaults !== undefined) {
      (input as { presetDefaults?: PresetDefaults }).presetDefaults = this.presetDefaults;
    }
    if (this.scopedPresetDefaults !== undefined) {
      (input as { scopedPresetDefaults?: PresetDefaults }).scopedPresetDefaults = this.scopedPresetDefaults;
    }
    if (presetOverrides !== undefined) {
      (input as { presetOverrides?: Readonly<Record<string, unknown>> }).presetOverrides = presetOverrides;
    }
    if (optimize !== undefined) {
      (input as { optimize?: OptimizeFor }).optimize = optimize;
    }
    return resolveCompressOptions(input);
  }

  /**
   * Execute the operation end-to-end. Uploads the input, creates the
   * workflow, waits to a terminal status (via SSE with poll fallback),
   * fetches downloads, and projects to a flat `Result`. Throws
   * `GislTimeoutError` if `maxWait` elapses before terminal status.
   */
  async run(options: RunOptions = {}): Promise<Result> {
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? DEFAULT_POLL_TIMEOUT_MS);
    const signal = options.signal;
    const onProgress = options.onProgress;
    const useSSE = options.useSSE ?? true;

    // 0. Resolve presets FIRST so a GislConfigError fails the call
    // before any I/O — the SDK promised fail-early for invalid combos.
    const resolved = this._resolve();

    // 1. Upload — emits {phase:'upload'} progress events from byte-counter.
    const uploadOpts: UploadOptions = { signal };
    if (onProgress !== undefined) {
      uploadOpts.onProgress = (uploadedBytes: number, totalBytes: number) => {
        onProgress({ phase: 'upload', uploadedBytes, totalBytes });
      };
    }
    const uploadResp = await this.client.uploadFile(this.input, uploadOpts);
    _checkAborted(signal);

    // Codex r2 medium 9a117f04eb59 — check deadline AFTER upload so a slow
    // upload doesn't proceed to createWorkflow past the caller's deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Upload completed but maxWait elapsed before workflow could be created`,
      );
    }

    // Best-effort probe-before-create for a multipart video upload (never-bounce).
    // Capped to the remaining maxWait budget so a slow probe cannot push
    // createWorkflow past the caller's deadline.
    await this.client.maybeWaitForVideoProbe(uploadResp.fileId, {
      enabled: options.probeBeforeCreate ?? true,
      isVideo: _detectCompressMedia(this.input) === 'video',
      sizeBytes: uploadResp.sizeBytes,
      timeoutMs: _cappedProbeTimeoutMs(options.probeTimeoutMs, deadline),
      signal,
    });
    // A cancel arriving during the FINAL successful probe request must not still
    // create the workflow (maybeWaitForVideoProbe returns landed without a final
    // abort re-check), so check here BEFORE createWorkflow.
    _checkAborted(signal);
    // RE-CHECK the deadline AFTER the probe wait (it consumes time).
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Probe wait completed but maxWait elapsed before workflow could be created',
      );
    }

    // 2. Build + create the workflow.
    const job: JobDefinitionPayload = {
      id: 'op',
      source: uploadSource(uploadResp.fileId),
      operations: [{ type: this.opType as OperationDef['type'], options: resolved.wireOptions }],
    };
    const payload: WorkflowCreatePayload = { jobs: [job] };
    const created = await this.client.createWorkflow(payload);
    _checkAborted(signal);

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
        created.workflowId,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: the maxWait deadline also covers the downloads fetch itself — a
    // slow getWorkflowDownloads must not return a success after the advertised
    // whole-run deadline. Re-check AFTER the call (the check above is BEFORE).
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
        created.workflowId,
      );
    }
    return _projectResult(finalStatus, downloads.downloads, resolved.wireOptions, resolved.resolvedOptions);
  }

  /**
   * Fire-and-forget: upload the input + create the workflow with a
   * `callback_url` wired to the supplied `webhook`, then return a
   * `Handle` (workflowId + webhookSecret) without waiting. The webhook
   * receives completion + the `webhookSecret` is the verifier seed.
   */
  async submit(options: SubmitOptions = {}): Promise<Handle> {
    // Resolve presets before any I/O so a GislConfigError fails the
    // call before the upload — same fail-early contract as run().
    const resolved = this._resolve();
    const uploadResp = await this.client.uploadFile(this.input);

    // Best-effort probe-before-create for a multipart video upload (never-bounce).
    await this.client.maybeWaitForVideoProbe(uploadResp.fileId, {
      enabled: options.probeBeforeCreate ?? true,
      isVideo: _detectCompressMedia(this.input) === 'video',
      sizeBytes: uploadResp.sizeBytes,
      timeoutMs: options.probeTimeoutMs,
    });

    const job: JobDefinitionPayload = {
      id: 'op',
      source: uploadSource(uploadResp.fileId),
      operations: [{ type: this.opType as OperationDef['type'], options: resolved.wireOptions }],
    };
    // ⚠️ OMIT THE KEY, do not set it to `undefined`. `JSON.stringify` drops an
    // undefined value so the wire is the same either way — but an own property
    // that exists with no value makes `'callback_url' in payload` TRUE, so any
    // test asserting omission by key passes vacuously (codex 4763eb48189a).
    const payload: WorkflowCreatePayload = {
      jobs: [job],
      ...(options.webhook !== undefined ? { callback_url: options.webhook } : {}),
    };
    const created = await this.client.createWorkflow(payload);

    // ⚠️ THE CLIENT IS THE POINT (36AZ98FV). Without it the returned Handle's
    // status()/wait()/result() throw `no_client`, which made `webhook` the only
    // channel for this call's outcome and is why it used to be mandatory. The
    // file-first path has always passed it (`file-first.ts`); the operation-first
    // path did not, which is the same "demands what file-first does not" defect
    // this ticket is about, one layer down.
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      null,
    );
  }

  /**
   * Fan-out chain: run this builder to completion, then for each artifact
   * in the resulting `Result`, call `fn(artifactRef)` to construct a
   * downstream `OperationBuilder`, run that, and collect the child results
   * into a combined `Result`.
   *
   * **KNOWN LIMITATION (T6 — codex r1 HIGH 11cb690e12ae):** today the
   * downstream `OperationBuilder` constructor still takes `string | Blob`
   * inputs, NOT artifact URLs. Passing `art.url` into a child builder
   * would have `uploadFile` treat it as a local filesystem path — the
   * fan-out cannot actually consume parent artifacts without out-of-band
   * prefetching the caller does themselves. The proper fix is an
   * artifact-as-input path (chain via `JobOutputSource.from`) that
   * tracks as a follow-up card. T6 ships the SCAFFOLD: the method, the
   * `MapEachBuilder` class, the `GislChainCardinalityMismatchError`
   * error type (dormant), and orchestration that fans out fn — this
   * unblocks future work on the artifact-source feature without API
   * churn. Use today only for callbacks that construct child builders
   * from `string | Blob` inputs derived from the artifact (e.g. download +
   * re-upload bridges).
   *
   * Single-output parents degrade gracefully (1 artifact = 1 fn call =
   * 1 child run). Multi-output parents (PDF → N pages, future split ops)
   * fan out N child runs. Each child shares the SAME maxWait deadline
   * (subtracting elapsed); aborts propagate.
   *
   * `.submit()` is NOT supported on a `MapEachBuilder` — fan-out submit-
   * with-webhook is a future card.
   */
  mapEach(fn: (artifact: ArtifactRef) => OperationBuilder): MapEachBuilder {
    return new MapEachBuilder(this, fn);
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
        return await _consumeSseToTerminal(this.client, args);
      } catch (err) {
        // TDqmkWpX: poll-fallback ONLY on a clean SSE stream-end
        // (SseEndedWithoutTerminal) or a typed transport error (GislNetworkError).
        // Everything else — timeout, abort, API error, an onProgress callback
        // throw, anything unexpected — MUST propagate; re-issuing the same doomed
        // request via poll would mask the real failure.
        if (
          !(
            err instanceof SseEndedWithoutTerminal ||
            // 3OVNoRxh: the SSE CONNECT was refused with a retryable status
            // (a 429 on the `events_stream` bucket, or a 503). The contract
            // declares that retryable and it clears when another caller closes
            // a stream — so it is SSE being momentarily unavailable, not a
            // failure of the thing this caller asked for. The wrap happens at
            // the connect site ONLY, and only for `GislApiError.retryable`, so
            // a 401/402/404 still propagates.
            err instanceof SseConnectRefused ||
            err instanceof GislNetworkError ||
            // VUozk5Bc: no stream host is DECLARED for this configuration (a
            // configuration nothing declares; both named environments resolve as of
            // contracts v2.195.0). That is not a failure to recover from,
            // it is SSE being unavailable here, and polling is a working
            // transport. Failing hard instead would strand every caller on a host
            // nobody has declared yet. A DIRECT `streamEvents` caller still gets
            // the hard error — they asked for the stream specifically; a `run()`
            // caller asked for a result.
            err instanceof GislStreamHostNotDeclaredError
          )
        ) {
          throw err;
        }
        // Genuine SSE stream-end / transport error — fall through to poll fallback.
      }
    }
    return await _pollToTerminal(this.client, args);
  }
}

// ---------------------------------------------------------------------------
// MapEachBuilder — fan-out chain over a parent's artifacts.
// ---------------------------------------------------------------------------

export class MapEachBuilder {
  constructor(
    private readonly parent: OperationBuilder,
    private readonly fn: (artifact: ArtifactRef) => OperationBuilder,
  ) {}

  /**
   * Run the parent builder to completion, then fan out the fn over each
   * resulting artifact. The deadline (maxWait) covers the parent's full
   * run + every child's full run — each child sees the REMAINING budget
   * after the parent and prior children completed. Signal aborts cascade.
   */
  async run(options: RunOptions = {}): Promise<Result> {
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? DEFAULT_POLL_TIMEOUT_MS);

    // 1. Run the parent.
    const remainingForParent = Math.max(1, deadline - Date.now());
    const parentResult = await this.parent.run({
      ...options,
      maxWait: remainingForParent,
    });

    // 2. Fan out the fn over each artifact, sequentially. The downstream
    //    server may parallelise workflows on its end; we serialise here for
    //    deterministic semantics + easier abort/error propagation.
    const collectedArtifacts: Artifact[] = [];
    const collectedJobs: JobBreakdown[] = [];
    const collectedChildResults: Result[] = [];
    for (const art of parentResult.artifacts) {
      _checkAborted(options.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Clean timeout BETWEEN children (no child in flight): the parent + the
        // children completed so far are recoverable — carry their ids so the
        // caller polls them and re-runs ONLY the never-created children (4G4FaA9X).
        throw new GislFanOutTimeoutError(
          `maxWait elapsed during fan-out (after ${collectedChildResults.length} child runs)`,
          {
            completedWorkflowIds: collectedChildResults.map((r) => r.workflowId),
            parentWorkflowId: parentResult.workflowId,
          },
        );
      }
      const childBuilder = this.fn(art);
      let childResult: Result;
      try {
        childResult = await childBuilder.run({
          ...options,
          maxWait: remaining,
        });
      } catch (err) {
        // A CHILD's own deadline elapsed mid-run — the COMMON fan-out timeout
        // path. Re-throw as a fan-out timeout so the parent + already-completed
        // children + this in-flight child are ALL recoverable, instead of losing
        // them behind the child's bare GislTimeoutError (4G4FaA9X). Other errors
        // (config / API / item failure) propagate unchanged.
        if (err instanceof GislTimeoutError) {
          throw new GislFanOutTimeoutError(
            `maxWait elapsed during fan-out while a child was running (${collectedChildResults.length} completed)`,
            {
              completedWorkflowIds: collectedChildResults.map((r) => r.workflowId),
              parentWorkflowId: parentResult.workflowId,
              workflowId: err.workflowId,
              cause: err,
            },
          );
        }
        throw err;
      }
      collectedChildResults.push(childResult);
      for (const childArt of childResult.artifacts) collectedArtifacts.push(childArt);
      for (const childJob of childResult.jobs) collectedJobs.push(childJob);
    }

    // 3. Build a combined Result. workflowId is the parent's (codex r1
    //    medium ba14b2cebf47 — child workflowIds preserved on
    //    childWorkflowIds for inspection). Status aggregates worst-of
    //    parent + children (codex r1 HIGH 88e7186edc9a — previously
    //    always reported parent.status, masking failed children).
    const childWorkflowIds = collectedChildResults.map((r) => r.workflowId);
    const allStatuses = [parentResult.status, ...collectedChildResults.map((r) => r.status)];
    const aggregateStatus = aggregateWorkflowStatus(allStatuses);
    const combined: Result & { childWorkflowIds: readonly string[] } = {
      workflowId: parentResult.workflowId,
      status: aggregateStatus,
      ...(parentResult.createdAt !== undefined ? { createdAt: parentResult.createdAt } : {}),
      ...(parentResult.updatedAt !== undefined ? { updatedAt: parentResult.updatedAt } : {}),
      artifacts: collectedArtifacts,
      jobs: [...parentResult.jobs, ...collectedJobs],
      ...(collectedArtifacts.length === 1 ? { url: collectedArtifacts[0].url } : {}),
      resolvedOptions: parentResult.resolvedOptions,
      childWorkflowIds,
    };
    return combined;
  }
}

/**
 * Aggregate the worst-of N workflow statuses for a fan-out combined Result.
 * Precedence: failed > expired > paused_insufficient_credits > cancelled >
 * partially_failed > completed (anything not in this order falls through
 * as the original parent status — defensive default).
 */
function aggregateWorkflowStatus(statuses: readonly string[]): string {
  const order = [
    'failed',
    'expired',
    'paused_insufficient_credits',
    'cancelled',
    'partially_failed',
    'completed',
  ];
  for (const candidate of order) {
    if (statuses.includes(candidate)) return candidate === 'completed' && statuses.every((s) => s === 'completed') ? 'completed' : candidate === 'completed' ? 'completed' : candidate;
  }
  return statuses[0] ?? 'completed';
}

// ---------------------------------------------------------------------------
// Internals — SSE + poll
// ---------------------------------------------------------------------------

/**
 * Poll-fallback interval bounds, in milliseconds.
 *
 * 🔴 **THE FLOOR IS SIZED AGAINST A PUBLISHED RATE LIMIT, NOT AGAINST A
 * BUSY-LOOP.** Its predecessor was 100 ms and its comment said it guarded
 * against values "that would hammer getWorkflowStatus" — which is what you
 * write when you are stopping a `0`/`NaN` spin, not when you have asked what
 * the server allows. Same words, different standard, and nothing recorded
 * which one applied (`r7bpd7MY`).
 *
 * The limit, read from `compression_api` rather than relayed:
 * `Identity/Application/RateLimiting/TieredRateLimiterService.php:37-39`
 * declares the `status_poll` family — guarding `GET /api/workflows/{id}/status`
 * and `/downloads` — as a **sliding window of 60 requests per minute**, scaled
 * at consume time (`:177`, `:188`) by `UserTier::rateLimitMultiplier()`
 * (`Identity/Domain/Enums/UserTier.php:186-194`): Free and Basic ×1, Pro ×5,
 * Max ×15, Enterprise ×20.
 *
 * ⇒ 100 ms is **600 requests/minute**: ten times the Free ceiling, twice Pro's,
 * and inside budget only on Max and Enterprise. 1000 ms is the minimum legal
 * interval on the tightest tier, so it is correct on every tier and needs no
 * tier knowledge in the SDK.
 *
 * ⚠️ **THE WINDOW IS SLIDING, SO IT PUNISHES BURSTS, NOT JUST AVERAGES** — ten
 * polls in the first second genuinely consume ten of the sixty.
 *
 * 📌 **AND THE BUDGET IS SHARED**: keyed per user id when authenticated, per IP
 * when not. N SDK instances under one account spend one allowance between them,
 * which is the argument for the conservative floor even on a paid tier — this
 * process cannot see the other two.
 *
 * A tier-aware floor would need the caller's tier, which neither SDK reads
 * today, and api has carded the effective-limits field as `4cHoxAcm` (Backlog,
 * unscheduled — deliberately, because this flat floor ships without it).
 *
 * ⛔ **WHAT THIS DOES NOT DO, STATED SO NOBODY READS IT AS A GUARANTEE (codex
 * 6b56d75f126d).** This is a PER-CALL floor, not a per-credential budget:
 *
 *   - **Two concurrent `run()`s under one credential issue ~120 requests/minute**
 *     and blow a 60/minute bucket. Bounding that needs coordination the SDK does
 *     not have — a shared limiter across calls, processes and machines.
 *   - **`getWorkflowDownloads` draws on the SAME `status_poll` family**, so a run
 *     that spends the last token on a status poll can be 429'd on the terminal
 *     downloads call it needs to finish.
 *
 * ⇒ This change makes a SINGLE run legal on every tier. It does not make the SDK
 * rate-limit-safe under concurrency, and the honest next step is retry-on-429
 * with `Retry-After`, not a larger number here. Tracked separately.
 */
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * The clamp itself, exported for an EXACT test (codex d218bd6a0c62).
 *
 * ⚠️ **A behavioural test cannot pin this number, and that is why this seam
 * exists.** Counting requests over a real deadline discriminates 1000 ms from
 * 100 and from 500, but it cannot tell 1000 from 750 — the counts collide inside
 * scheduler jitter. Widening the window to separate them makes the suite slower
 * and the test flakier, in exchange for a weaker claim.
 *
 * ⇒ So the two tests do different jobs and neither is redundant: this one pins
 * the VALUE exactly, and the `run()` test proves the clamp is on the path a
 * caller actually travels. A value test alone would pass while nothing called
 * it; a path test alone would pass at 750 ms.
 *
 * @internal — not re-exported from the package barrel.
 */
export function _clampPollIntervalMs(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (!Number.isFinite(requested) || requested < MIN_POLL_INTERVAL_MS) {
    return MIN_POLL_INTERVAL_MS;
  }
  return requested;
}

// The POLL path's stop condition. Same question as the SSE one, same answer —
// see the long note at the terminal-event check in `_consumeSseToTerminal`
// (Fk8FWeyO): a terminal workflow status never returns to non-terminal, and api
// schedules an operation's retry BEFORE failing its job, so `failed` here means
// retries are exhausted. ⚠️ THIS PATH IS THE EASIER ONE TO MISS — a poll that
// observes `failed` and stops has exactly the defect the card described, and it
// is correct for the same reason rather than by luck.
const TERMINAL_STATUS = new Set([
  'completed',
  'failed',
  'partially_failed',
  'cancelled',
  'expired',
  'paused_insufficient_credits',
]);

/**
 * Internal marker (TDqmkWpX): tags an error thrown by the caller's `onProgress`
 * callback so the mid-stream transport-error wrap in {@link _consumeSseToTerminal}
 * cannot mistake it for a transport failure (a callback that throws a `TypeError`
 * would otherwise be wrapped as `GislNetworkError` → masked by poll-fallback).
 * The inner catch unwraps it and rethrows the ORIGINAL `cause`, so the caller
 * sees their own error and the run never silently succeeds.
 */
class _OnProgressThrew {
  constructor(readonly cause: unknown) {}
}

/**
 * Per-CLIENT SSE cooldown after a refused connect (Vf9R7gcV).
 *
 * contracts v2.208.0 REQUIRES `Retry-After` on the events 429
 * (`sse_connection_limit_exceeded`, 5 open streams per caller) and 503
 * (`sse_capacity_exhausted`), and the taxonomy says a client MUST NOT request
 * another stream before it elapses. Within one run that already held: a refused
 * connect falls back to polling and never reopens. ACROSS runs it did not -
 * nothing remembered the refusal, so the next `run()` or `Handle` wait on the
 * same client connected again at once. A caller with five waits already in flight
 * (concurrent runs; `.mapEach()` itself is serial, one stream at a time) had
 * every further wait refused and reconnecting.
 *
 * ⇒ The refusal is remembered here, keyed by the CLIENT: two clients are two
 * callers (different credentials), so this is per instance, never process-wide.
 * A WeakMap so a discarded client takes its entry with it and nothing is added to
 * `GislClient`'s public surface. While the window is open `_consumeSseToTerminal`
 * does not connect at all; it rethrows the remembered refusal, which every
 * await-terminal caller already treats as "poll instead".
 *
 * ⚠️ No `Retry-After` (an API older than v2.208.0) records NOTHING: there is no
 * window to honour, and inventing one would delay SSE for a caller the server
 * did not ask to wait. A DIRECT `streamEvents()` caller is untouched either way.
 */
const sseCooldowns = new WeakMap<GislClient, { untilMs: number; refusal: GislApiError }>();

/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export async function _consumeSseToTerminal(
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
      args.workflowId,
    );
  }
  const cooldown = sseCooldowns.get(client);
  if (cooldown !== undefined) {
    if (Date.now() < cooldown.untilMs) {
      throw new SseConnectRefused(
        `SSE for workflow ${args.workflowId} not attempted: a stream on this client was ` +
          `refused with ${cooldown.refusal.statusCode} and its Retry-After has not elapsed; polling`,
        cooldown.refusal,
      );
    }
    sseCooldowns.delete(client);
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
          args.workflowId,
        );
      }
      // TDqmkWpX: a genuine connect-phase TRANSPORT failure surfaces as a raw
      // `TypeError` from `fetch` (DNS/TCP/TLS) — wrap it as a typed
      // GislNetworkError so the await-terminal callers poll-fallback on it
      // (and ONLY on it / a clean stream-end), never on an onProgress throw.
      if (err instanceof TypeError) {
        throw new GislTransportError(
          `SSE connect to workflow ${args.workflowId} events failed: ${err.message}`,
        );
      }
      // 3OVNoRxh: the connect was REFUSED with a retryable status — a 429 on
      // the `events_stream` bucket, or a 503. The contract declares that
      // retryable, and it usually clears the moment another caller closes a
      // stream. Wrap it so the await-terminal callers can poll instead of
      // handing a `run()` caller a hard failure for a transport they never
      // asked about.
      //
      // ⚠️ `err.retryable`, NOT a literal 429/503 list. The property already
      // encodes 408/429/5xx PLUS the generated taxonomy's own `retryable` flag,
      // and a second copy of that rule here would be the one that goes stale.
      //
      // 🔴 THE NARROWING IS THE FEATURE. A 401, 402 or 404 on the connect is
      // NOT retryable, so it still propagates untouched — re-issuing the same
      // doomed request as a poll would mask the real failure, which is the
      // property the whole predicate below exists to preserve (TDqmkWpX).
      if (err instanceof GislApiError && err.retryable) {
        // MILLISECONDS, not `err.retryAfterSeconds`: that floors an HTTP-date,
        // so a window could end up to 999ms early, or vanish under a second
        // (codex c37f52484178). And never SHORTEN an open window: concurrent
        // refusals can land out of order, and the longest instruction still
        // binds (codex fd356dee2436).
        const retryAfterMs = parseRetryAfterMs(err.responseHeaders?.['retry-after']);
        if (retryAfterMs !== undefined) {
          const untilMs = Date.now() + retryAfterMs;
          const open = sseCooldowns.get(client);
          if (open === undefined || untilMs > open.untilMs) {
            sseCooldowns.set(client, { untilMs, refusal: err });
          }
        }
        throw new SseConnectRefused(
          `SSE connect to workflow ${args.workflowId} events was refused with ` +
            `${err.statusCode}; falling back to polling`,
          err,
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
          args.workflowId,
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
        // TDqmkWpX: an onProgress callback throw (ANY type, incl. TypeError)
        // must propagate, never be mistaken for a transport failure. Tag it so
        // the mid-stream TypeError wrap in the catch below skips it.
        try {
          args.onProgress(proj);
        } catch (cbErr) {
          throw new _OnProgressThrew(cbErr);
        }
      }
      // 🔴 WHY FIRST-TERMINAL IS CORRECT, AND IT IS NOT OBVIOUS (Fk8FWeyO).
      // contracts v2.193.0 declares that a second terminal OperationResult can
      // arrive for the same operation_id and that `completed` SUPERSEDES
      // `failed`, whichever order they arrive in. Read on its own, that makes
      // stopping at the first terminal event look like a bug — and the contract
      // says so itself: "a consumer that treats a workflow-level `failed` as
      // final is CORRECT per this contract and may still be wrong in fact".
      //
      // ⇒ IT IS NOT WRONG IN FACT, AND THE REASON IS AN ORDERING IN api.
      // MEASURED BY api AT THEIR main, 2026-09-18 (RELAYED — not re-run here):
      //   · WorkflowStatus::canTransitionTo() returns FALSE for every target
      //     from Completed/Failed/PartiallyFailed/Cancelled/Expired, so a
      //     terminal workflow never returns to non-terminal;
      //   · OperationResultHandler calls $operation->canRetry() and SCHEDULES
      //     THE RETRY *BEFORE* $job->fail(). On that path a job — and so the
      //     workflow — reaches `failed` only once retries are EXHAUSTED or the
      //     failure was non-retryable.
      // ⇒ On the AUTOMATIC retry path there is no window in which a superseding
      // operation.completed can land after a workflow-level `failed`. Nothing to
      // wait for, nothing to poll for, and no latency to add to a successful run.
      //
      // 🔴 THE SCOPE OF THAT CLAIM IS THE AUTOMATIC PATH, AND NOT MORE. api's
      // measurement said "cannot arise on the AUTOMATIC path"; an earlier draft of
      // this comment DROPPED THAT QUALIFIER and asserted a universal "no window",
      // which a reviewer rejected by pointing at RetryOperationCommandHandler —
      // the MANUAL `POST /retry` route, which the ordering above does not cover
      // and which has not been measured here.
      //
      // ⚠️ WHAT THAT MEANS IN PRACTICE, STATED RATHER THAN GLOSSED: a caller
      // inside `run()` is waiting on a workflow nobody has manually retried yet —
      // a manual retry is something a human or another service does AFTER being
      // told it failed. So the stop condition is right for `run()`. It is NOT a
      // licence to treat "first terminal" as universally final elsewhere.
      //
      // ⚠️ THE OTHER BOUNDARY, SO IT CAN BE RE-CHECKED: this rests on api's
      // ordering, not on the contract — the contract leaves the parent
      // explicitly undecided (asyncapi/events.yaml, "THE PARENT IS NOT COVERED
      // BY THIS RULE, AND THAT IS A GAP"). If api ever fails a job BEFORE
      // scheduling its retry, the window opens and Fk8FWeyO comes back.
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
          args.workflowId,
        );
      }
    }
    // Stream ended cleanly without terminal. If the deadline timer fired
    // mid-stream and triggered the abort, surface that as the timeout.
    if (deadlineExpired) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        args.workflowId,
      );
    }
    // Otherwise it was a clean server-side close — fall back to poll. TDqmkWpX:
    // a sealed marker (not a bare Error) so callers poll ONLY on this + a typed
    // transport error, never on an onProgress callback throw.
    throw new SseEndedWithoutTerminal();
    } catch (innerErr) {
      // TDqmkWpX: an onProgress callback throw was tagged so it is NEVER treated
      // as a transport failure — unwrap and rethrow the ORIGINAL cause so it
      // propagates to the caller (never masked by a poll retry), even when the
      // callback threw a TypeError.
      if (innerErr instanceof _OnProgressThrew) {
        throw innerErr.cause;
      }
      // If deadline expired and the iterator rejected with AbortError, surface
      // as GislTimeoutError.
      if (
        deadlineExpired &&
        innerErr instanceof DOMException &&
        innerErr.name === 'AbortError'
      ) {
        throw new GislTimeoutError(
          `Workflow ${args.workflowId} did not complete before maxWait deadline`,
          args.workflowId,
        );
      }
      // A genuine mid-stream TRANSPORT failure (reader disconnect) surfaces as a
      // raw `TypeError` from the iterator — wrap as GislTransportError so callers
      // poll-fallback. (An onProgress throw was already handled above, so a
      // TypeError here is unambiguously transport.) It stays a GislNetworkError
      // by inheritance, so the poll-fallback gates below are unchanged.
      if (innerErr instanceof TypeError) {
        throw new GislTransportError(
          `SSE stream for workflow ${args.workflowId} failed mid-stream: ${innerErr.message}`,
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

/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export async function _pollToTerminal(
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
  // Clamp rather than throw — a zero/NaN/tiny value is a caller mistake, and the
  // ergonomic layer should not crash an otherwise valid run over it. ONE call
  // site, so the exact test above and the behavioural test below are talking
  // about the same code.
  const intervalMs = _clampPollIntervalMs(args.pollIntervalMs);
  while (true) {
    _checkAborted(args.signal);
    if (Date.now() >= args.deadline) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        args.workflowId,
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
        args.workflowId,
      );
    }
    if (Date.now() + intervalMs >= args.deadline) {
      throw new GislTimeoutError(
        `Workflow ${args.workflowId} did not complete before maxWait deadline`,
        args.workflowId,
      );
    }
    await sleep(intervalMs, args.signal);
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** @internal — exported for reuse by `merge.ts` (T3) and future builders.
 *
 * T4b adds the optional `resolvedOptionsOverride` argument. When provided,
 * it supplants the placeholder ResolvedOptions the projector would
 * otherwise emit. `MergeBuilder` and other non-resolver builders omit
 * this argument and receive the legacy placeholder shape unchanged
 * (back-compat — merge does NOT go through the preset resolver in T4b).
 */
export function _projectResult(
  status: WorkflowStatusResponse,
  jobDownloads: readonly { ref: string; jobId: string; files: readonly OperationDownload[] }[],
  appliedOptions: Record<string, unknown>,
  resolvedOptionsOverride?: ResolvedOptions,
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
    resolvedOptions: resolvedOptionsOverride ?? {
      preset: null,
      applied: { ...appliedOptions },
      overrides: [],
      presetVersion: '1.0',
      sources: {
        sdkDefault: [],
        clientDefault: [],
        scopedDefault: [],
        callPresetOverride: [],
        explicit: [],
      },
    },
  };
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export function _checkAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Cap a best-effort probe-before-create timeout to the remaining `maxWait`
 * budget so the probe wait can never push createWorkflow past the caller's
 * deadline. Under a deadline an UNSET `probeTimeoutMs` becomes the remaining
 * budget (never the 30s waitForProbe default); a set value is clamped to the
 * remaining budget. With no deadline (the `submit()` fire-and-forget path),
 * `probeTimeoutMs` passes through unchanged.
 *
 * @internal — exported for reuse by `file-first.ts` + `merge.ts`.
 */
export function _cappedProbeTimeoutMs(
  probeTimeoutMs: number | undefined,
  deadline: number | undefined,
): number | undefined {
  if (deadline === undefined) {
    return probeTimeoutMs;
  }
  const remaining = Math.max(0, deadline - Date.now());
  return probeTimeoutMs !== undefined ? Math.min(probeTimeoutMs, remaining) : remaining;
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
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export function _parseMaxWait(value: string | number): number {
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
