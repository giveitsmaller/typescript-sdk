/**
 * Merge-compose layer for the SDK ergonomic surface (T3 / cuecCmb5).
 *
 * `client.merge(...assets, options?)` returns a `MergeBuilder`. The builder
 * separates WHAT (the asset set) from ORDER (the timeline):
 *
 * - `merge(a, b, c)` declares the asset set — each unique input is uploaded
 *   ONCE per run, even if referenced multiple times in the sequence.
 * - `.sequence(...refs)` defines the play order. References may repeat
 *   freely; entries may be bare asset refs or `clip(ref, opts)` objects
 *   carrying per-position options.
 * - No `.sequence(...)` => play in declared order, no transitions.
 *
 * Wire-truth boundaries (lowering.md §sequences):
 * - Video merge per-input options: `transition`, `crossfadeDuration` only.
 * - Audio merge per-input options: `transition`, `crossfadeDuration`,
 *   `gapDuration` only.
 * - Image merge has NO per-input options today — `clip(ref)` is reuse/order
 *   only. Per-position transitions on image merges throw locally as
 *   `GislPerInputOptionsNotSupportedError`.
 * - No per-clip `trimStart`/`trimEnd` today (contracts ticket iZzn5QrS
 *   tracks the fix). Workaround: pre-trim each clip via a chained
 *   `compress(file, trimStart, trimEnd)`.
 *
 * Local validation runs BEFORE any upload — undeclared refs and unused
 * assets both fail fast so the caller saves bandwidth on typo'd composes.
 */

import type { GislClient } from './client.js';
import type {
  JobDefinitionPayload,
  JobInputV2Payload,
  UploadOptions,
  WorkflowCreatePayload,
} from './types.js';
import { uploadSource, jobOutputSource } from './types.js';
import {
  GislConfigError,
  GislPerInputOptionsNotSupportedError,
  GislTimeoutError,
  GislUndeclaredAssetError,
  GislUnusedAssetError,
} from './errors.js';
import {
  _checkAborted,
  _consumeSseToTerminal,
  _parseMaxWait,
  _pollToTerminal,
  _projectResult,
  type ProgressEvent,
  type Result,
  type RunOptions,
  type SubmitOptions,
} from './builder.js';
import { Handle } from './handle.js';

// ---------------------------------------------------------------------------
// Asset + Clip types
// ---------------------------------------------------------------------------

/**
 * A declared merge asset. `path` carries a string or Blob (deduped by
 * normalised source key); `handle` wraps an already-uploaded file (deduped
 * by handle identity — same handle reference = same upload regardless of
 * path). Use a handle for guaranteed reuse.
 */
export type Asset =
  | { readonly type: 'path'; readonly path: string | Blob }
  | { readonly type: 'handle'; readonly fileId: string };

/**
 * Construct a path-asset. Bare-string arguments to `merge(...)` are
 * implicitly wrapped via this helper.
 */
export function asset(path: string | Blob): Asset {
  return { type: 'path', path };
}

/**
 * Wrap an already-uploaded file_id as a merge asset. Use this when the
 * SAME logical file should be referenced from multiple merge runs with
 * guaranteed-single-upload semantics.
 */
export function handle(fileId: string): Asset {
  return { type: 'handle', fileId };
}

/**
 * Per-position options carried by `clip(ref, opts)` entries. Image merges
 * reject ANY per-input options today (see module docstring).
 */
export interface ClipOptions {
  /** Transition to apply at this position (video/audio per-input only). */
  readonly transition?: string;
  /** Crossfade duration in seconds (when `transition` is crossfade). */
  readonly crossfadeDuration?: number;
  /** Gap duration in seconds (audio merge only). */
  readonly gapDuration?: number;
}

/**
 * A sequence entry that carries per-position options. Use the `clip(...)`
 * helper to construct.
 */
export interface ClipEntry {
  readonly type: 'clip';
  readonly asset: Asset;
  readonly options: ClipOptions;
}

/**
 * Construct a clip entry for `.sequence(...)`. The asset MUST already
 * be in the merge's declared asset set.
 */
export function clip(ref: Asset, options: ClipOptions = {}): ClipEntry {
  return { type: 'clip', asset: ref, options };
}

export type SequenceEntry = Asset | ClipEntry;

// ---------------------------------------------------------------------------
// Merge options
// ---------------------------------------------------------------------------

/**
 * Inferred media kind. `merge` picks the wire variant from the inferred
 * media; the SDK reads the FIRST asset's path/MIME to decide.
 */
export type MergeMediaKind = 'video' | 'audio' | 'image';

export interface MergeOptions {
  /** Merge-level transition (applies to every join — image merge ONLY uses this). */
  readonly transition?: string;
  readonly crossfadeDuration?: number;
  readonly gapDuration?: number;
  readonly normalizeAudio?: boolean;
  readonly codec?: string;
  readonly crf?: number;
  readonly preset?: string;
  readonly targetSize?: string | number;
  readonly transitionDuration?: number;
  readonly fps?: number;
  readonly durationPerImage?: number;
  readonly loopCount?: number;
  readonly output?: string;
  readonly videoFormat?: string;
  readonly outputType?: string;
  /** Force the inferred media kind (skip the first-asset sniff). */
  readonly mediaKind?: MergeMediaKind;
  /** Bypass the unused-asset validation (rarely needed; usually a bug indicator). */
  readonly allowUnusedAssets?: boolean;
}

// ---------------------------------------------------------------------------
// MergeBuilder
// ---------------------------------------------------------------------------

/**
 * Captures the (declared assets, options) for a merge. `.sequence(...)`
 * pins the play order; without it, the declared order is used as-is
 * with no per-input options.
 *
 * Local validation runs at `.run()`/`.submit()` time (BEFORE any upload)
 * and throws one of `GislUndeclaredAssetError`, `GislUnusedAssetError`,
 * or `GislPerInputOptionsNotSupportedError` if the compose is invalid.
 */
export class MergeBuilder {
  private sequenceEntries: SequenceEntry[] | null = null;

  constructor(
    private readonly client: GislClient,
    private readonly assets: readonly Asset[],
    private readonly opOptions: MergeOptions,
  ) {}

  /**
   * Pin the merge play order. Each entry must reference an asset that
   * was declared in the parent `merge(...)` call. Repeats are allowed
   * and deduped on upload (one upload per unique declared asset).
   */
  sequence(...entries: SequenceEntry[]): this {
    this.sequenceEntries = entries;
    return this;
  }

  async run(options: RunOptions): Promise<Result> {
    const deadline = Date.now() + _parseMaxWait(options.maxWait);
    const signal = options.signal;
    const onProgress = options.onProgress;
    const useSSE = options.useSSE ?? true;

    // 1. Validate locally BEFORE any upload.
    const plan = this.planSequence();

    // 2. Upload each unique asset exactly ONCE. Pass the deadline so the
    // upload loop can abort mid-batch on a slow connection.
    const uploadedByAssetId = await this.uploadUniqueAssets(plan.uniqueAssets, {
      signal,
      onProgress,
      deadline,
    });
    _checkAborted(signal);
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Upload(s) completed but maxWait elapsed before merge workflow could be created`,
      );
    }

    // 3. Build the merge JobDefinitionPayload (multi-input).
    const payload = this.buildPayload(plan, uploadedByAssetId);
    const created = await this.client.createWorkflow(payload);
    _checkAborted(signal);

    // 4. Wait to terminal status.
    const finalStatus = await this.awaitTerminal({
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      useSSE,
      pollIntervalMs: options.pollIntervalMs,
    });

    // 5. Fetch downloads + project.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Merge workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // p0SuJEeK — project ONLY the merge job's output. getWorkflowDownloads
    // returns a download group per terminal job, which now INCLUDES the
    // `passthrough` source jobs (their output is the unchanged upload). Those
    // are plumbing, not the merge deliverable — surfacing them as artifacts
    // would pollute the Result with the raw inputs. The merge job's ref is
    // 'merge' (see buildPayload); the source jobs are 'src_N'.
    const mergeDownloads = downloads.downloads.filter((d) => d.ref === 'merge');
    return _projectResult(finalStatus, mergeDownloads, this.opOptionsForResolved());
  }

  async submit(options: SubmitOptions): Promise<Handle> {
    const plan = this.planSequence();
    const uploadedByAssetId = await this.uploadUniqueAssets(plan.uniqueAssets, {});

    const payload = this.buildPayload(plan, uploadedByAssetId);
    payload.callback_url = options.webhook;
    const created = await this.client.createWorkflow(payload);

    // No client passed → the returned Handle's status()/wait()/result()
    // throw `no_client`; the merge submit reconciles via webhook.
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Resolve the declared assets + sequence (or fall back to declared order),
   * dedupe by identity, and run the local validators. The returned plan
   * carries the SEQUENCE (positional entries) + the UNIQUE assets to upload.
   */
  private planSequence(): SequencePlan {
    const declaredIds: string[] = this.assets.map(assetIdentity);
    const declaredSet: Map<string, Asset> = new Map();
    for (let i = 0; i < this.assets.length; i += 1) {
      const id = declaredIds[i];
      if (!declaredSet.has(id)) declaredSet.set(id, this.assets[i]);
    }

    // Use the explicit sequence if set; otherwise the declared order as-is.
    const rawEntries: SequenceEntry[] =
      this.sequenceEntries ?? this.assets.map((a) => a);

    // Validate per-entry: undeclared ref + image-merge-clip-with-opts.
    const mediaKind = this.inferMediaKind();
    const positions: PositionEntry[] = [];
    const refIds = new Set<string>();
    for (const entry of rawEntries) {
      const isClip = entry !== null && typeof entry === 'object' && 'type' in entry && entry.type === 'clip';
      const assetRef = isClip ? entry.asset : (entry as Asset);
      const id = assetIdentity(assetRef);
      if (!declaredSet.has(id)) {
        throw new GislUndeclaredAssetError(id, Array.from(declaredSet.keys()));
      }
      refIds.add(id);
      if (isClip) {
        const opts = entry.options;
        const hasOpts =
          opts.transition !== undefined ||
          opts.crossfadeDuration !== undefined ||
          opts.gapDuration !== undefined;
        if (hasOpts && mediaKind === 'image') {
          throw new GislPerInputOptionsNotSupportedError('image');
        }
        positions.push({ assetId: id, options: opts });
      } else {
        positions.push({ assetId: id, options: {} });
      }
    }

    // Unused-asset check.
    if (this.sequenceEntries !== null && this.opOptions.allowUnusedAssets !== true) {
      const unused = Array.from(declaredSet.keys()).filter((id) => !refIds.has(id));
      if (unused.length > 0) throw new GislUnusedAssetError(unused);
    }

    // Codex r1 medium edb1bb641d81 — when an explicit sequence is set,
    // restrict the upload set to only the referenced assets. This prevents
    // wasted uploads of declared-but-unsequenced assets (e.g. when the
    // user passes allowUnusedAssets: true).
    const uploadSet: Map<string, Asset> =
      this.sequenceEntries === null
        ? declaredSet
        : new Map(Array.from(declaredSet.entries()).filter(([id]) => refIds.has(id)));

    // Codex r1 medium 5c86b67c979b — enforce merge schema input bounds
    // (min_inputs: 2, max_inputs: 10 per generated/typescript/operations/merge.ts).
    // Validate sequence position count, NOT unique-asset count: the merge job
    // sends N inputs where N = position count (repeats included).
    if (positions.length < 2) {
      throw new GislConfigError(
        `merge requires at least 2 inputs (got ${positions.length}). Declare more assets or check the sequence.`,
      );
    }
    if (positions.length > 10) {
      throw new GislConfigError(
        `merge accepts at most 10 inputs (got ${positions.length}). Reduce the sequence or split the merge.`,
      );
    }

    return { mediaKind, positions, uniqueAssets: uploadSet };
  }

  private inferMediaKind(): MergeMediaKind {
    if (this.opOptions.mediaKind !== undefined) return this.opOptions.mediaKind;
    const first = this.assets[0];
    if (first === undefined) return 'video';
    if (first.type === 'path' && typeof first.path === 'string') {
      const lower = first.path.toLowerCase();
      if (/\.(jpe?g|png|webp|avif|gif|heic|tiff?)$/.test(lower)) return 'image';
      if (/\.(mp3|wav|flac|aac|ogg|m4a)$/.test(lower)) return 'audio';
      return 'video';
    }
    if (first.type === 'path' && first.path instanceof Blob) {
      if (first.path.type.startsWith('image/')) return 'image';
      if (first.path.type.startsWith('audio/')) return 'audio';
      return 'video';
    }
    return 'video';
  }

  private async uploadUniqueAssets(
    uniqueAssets: ReadonlyMap<string, Asset>,
    opts: { signal?: AbortSignal; onProgress?: (e: ProgressEvent) => void; deadline?: number },
  ): Promise<Map<string, string>> {
    const uploaded = new Map<string, string>();
    for (const [id, a] of uniqueAssets) {
      // Codex r1 medium 797b4113431f — check the deadline between uploads
      // so a multi-file merge doesn't keep uploading past `maxWait`.
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
        throw new GislTimeoutError(
          `maxWait elapsed mid-upload (after ${uploaded.size} of ${uniqueAssets.size} merge assets)`,
        );
      }
      if (a.type === 'handle') {
        uploaded.set(id, a.fileId);
        continue;
      }
      const uploadOpts: UploadOptions = {};
      if (opts.signal !== undefined) uploadOpts.signal = opts.signal;
      if (opts.onProgress !== undefined) {
        uploadOpts.onProgress = (uploadedBytes, totalBytes) => {
          opts.onProgress?.({ phase: 'upload', uploadedBytes, totalBytes });
        };
      }
      const resp = await this.client.uploadFile(a.path, uploadOpts);
      uploaded.set(id, resp.fileId);
    }
    return uploaded;
  }

  private buildPayload(
    plan: SequencePlan,
    uploadedByAssetId: ReadonlyMap<string, string>,
  ): WorkflowCreatePayload {
    // p0SuJEeK — the API rejects upload-direct multi-input
    // (`MultiInputSource` excludes the `upload` leaf: "use type=job_output").
    // So each uploaded asset is wrapped in its OWN single-input `passthrough`
    // source job, and the merge job references those via `job_output` — the
    // shape the v2.35.0 `v2_merge_two_uploads` example prescribes. One source
    // job per UNIQUE asset (in first-seen position order); a repeated asset
    // re-uses its src job. `passthrough` is a lossless inert op (it does NOT
    // get the implicit compress an empty `operations: []` job would).
    const srcIdByAsset = new Map<string, string>();
    const sourceJobs: JobDefinitionPayload[] = [];
    for (const pos of plan.positions) {
      if (srcIdByAsset.has(pos.assetId)) continue;
      const fileId = uploadedByAssetId.get(pos.assetId);
      if (fileId === undefined) {
        // Defensive — planSequence should have rejected this.
        throw new Error(`Asset '${pos.assetId}' was never uploaded — internal builder bug`);
      }
      const srcId = `src_${sourceJobs.length}`;
      srcIdByAsset.set(pos.assetId, srcId);
      sourceJobs.push({
        id: srcId,
        source: uploadSource(fileId),
        operations: [{ type: 'passthrough' }],
      });
    }

    const inputs: JobInputV2Payload[] = plan.positions.map((pos) => {
      // Defensive — srcIdByAsset was populated for every position's asset above.
      const srcId = srcIdByAsset.get(pos.assetId);
      if (srcId === undefined) {
        throw new Error(`Asset '${pos.assetId}' has no source job — internal builder bug`);
      }
      // Codex r1 HIGH 502c6bf232c2 — per_input_options goes on EACH
      // JobInputV2Payload (per-input entry), NOT on operations[0].options.
      // Skip emission for image merges (planSequence already rejects opts
      // on image-merge clips). Project per ClipOptions per media kind
      // (codex r1 medium 128404fa16a9 — gapDuration is audio-only).
      const wireOpts = plan.mediaKind === 'image'
        ? {}
        : wirePerInputOptions(pos.options, plan.mediaKind);
      const input: JobInputV2Payload = { source: jobOutputSource(srcId) };
      if (Object.keys(wireOpts).length > 0) {
        input.per_input_options = wireOpts;
      }
      return input;
    });

    // Merge-level options (excluding the SDK-side mediaKind/allowUnusedAssets).
    const mergeOpts = wireMergeOptions(this.opOptions, plan.mediaKind);

    const mergeJob: JobDefinitionPayload = {
      id: 'merge',
      inputs,
      operations: [{ type: 'merge', options: mergeOpts as Record<string, unknown> }],
    };
    return { jobs: [...sourceJobs, mergeJob] };
  }

  private opOptionsForResolved(): Record<string, unknown> {
    // Strip the SDK-only fields before exposing on resolvedOptions.applied.
    const { mediaKind: _m, allowUnusedAssets: _a, ...rest } = this.opOptions;
    void _m;
    void _a;
    return { ...rest };
  }

  private async awaitTerminal(args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    onProgress: ((event: ProgressEvent) => void) | undefined;
    useSSE: boolean;
    pollIntervalMs?: number;
  }): Promise<Awaited<ReturnType<typeof _consumeSseToTerminal>>> {
    if (args.useSSE) {
      try {
        return await _consumeSseToTerminal(this.client, args);
      } catch (err) {
        if (err instanceof GislTimeoutError) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
      }
    }
    return await _pollToTerminal(this.client, args);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface PositionEntry {
  readonly assetId: string;
  readonly options: ClipOptions;
}

interface SequencePlan {
  readonly mediaKind: MergeMediaKind;
  readonly positions: readonly PositionEntry[];
  readonly uniqueAssets: ReadonlyMap<string, Asset>;
}

/**
 * Per-Blob identity tokens — referential dedupe via WeakMap. Two distinct
 * Blob objects with the same size + MIME would otherwise hash to the
 * SAME identity (silent data loss; code-reviewer P1 conf 8). Reference
 * identity guarantees same-Blob = same-upload and different-Blob = two
 * uploads, irrespective of content sniffing.
 */
const _blobTokens = new WeakMap<Blob, string>();
let _blobCounter = 0;

/**
 * Asset identity for dedupe. Handles use their fileId; paths use a
 * trim+trailing-separator-strip normalised string (NOT case-folded —
 * case-insensitive dedupe would silently merge `A.mp4` and `a.mp4` on a
 * case-sensitive filesystem; code-reviewer P1 conf 7). Blobs use
 * referential identity via a WeakMap-backed token. Bare-string path
 * dedupe is best-effort — use `handle()` for guaranteed reuse.
 */
function assetIdentity(a: Asset): string {
  if (a.type === 'handle') return `handle:${a.fileId}`;
  if (a.path instanceof Blob) {
    let token = _blobTokens.get(a.path);
    if (token === undefined) {
      _blobCounter += 1;
      token = `${_blobCounter}`;
      _blobTokens.set(a.path, token);
    }
    return `blob:${token}`;
  }
  // Codex r2 medium bb500566a683 — dedupe by the EXACT caller-provided
  // string. Previous trim+trailing-slash-strip would collapse
  // `'clip.mp4'` and `'clip.mp4 '` into one upload while uploadFile later
  // received the original string. Exact-string dedupe = upload identity
  // matches dedupe identity. Best-effort = "two identical strings dedupe;
  // anything else is a separate upload" — predictable.
  return `path:${a.path}`;
}

function wireMergeOptions(opts: MergeOptions, mediaKind: MergeMediaKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.transition !== undefined) out.transition = opts.transition;
  if (opts.crossfadeDuration !== undefined) out.crossfade_duration = opts.crossfadeDuration;
  // Codex r2 medium ab2422e56ea0 — merge-level `gap_duration` is on
  // MergeAudioOptions only (not MergeVideoOptions or MergeImageOptions).
  // Drop it for non-audio merges instead of shipping an invalid payload.
  if (opts.gapDuration !== undefined && mediaKind === 'audio') out.gap_duration = opts.gapDuration;
  if (opts.normalizeAudio !== undefined) out.normalize_audio = opts.normalizeAudio;
  if (opts.codec !== undefined) out.codec = opts.codec;
  if (opts.crf !== undefined) out.crf = opts.crf;
  if (opts.preset !== undefined) out.preset = opts.preset;
  if (opts.targetSize !== undefined) {
    out.target_size_bytes = typeof opts.targetSize === 'number'
      ? opts.targetSize
      : parseSizeString(opts.targetSize);
    out.encoding_mode = 'target_size';
  }
  if (opts.transitionDuration !== undefined) out.transition_duration = opts.transitionDuration;
  if (opts.fps !== undefined) out.fps = opts.fps;
  if (opts.durationPerImage !== undefined) out.duration_per_image = opts.durationPerImage;
  if (opts.loopCount !== undefined) out.loop_count = opts.loopCount;
  if (opts.output !== undefined) out.output_type = opts.output;
  if (opts.outputType !== undefined) out.output_type = opts.outputType;
  if (opts.videoFormat !== undefined) out.video_format = opts.videoFormat;
  return out;
}

/**
 * Project a ClipOptions into the wire-shape per_input_options object.
 * Codex r1 medium 128404fa16a9 — `gap_duration` is on AUDIO per-input
 * only (`MergeAudioPerInputOptions`), NOT video. Splitting by mediaKind
 * here keeps the wire payload honest and prevents the server from
 * silently rejecting/ignoring an out-of-spec field.
 */
function wirePerInputOptions(opts: ClipOptions, mediaKind: MergeMediaKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts.transition !== undefined) out.transition = opts.transition;
  if (opts.crossfadeDuration !== undefined) out.crossfade_duration = opts.crossfadeDuration;
  if (opts.gapDuration !== undefined && mediaKind === 'audio') {
    out.gap_duration = opts.gapDuration;
  }
  return out;
}

function parseSizeString(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)?$/i.exec(s.trim());
  if (m === null) throw new TypeError(`Invalid targetSize string '${s}'`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  switch (unit) {
    case 'B': return Math.round(n);
    case 'KB': return Math.round(n * 1_000);
    case 'MB': return Math.round(n * 1_000_000);
    case 'GB': return Math.round(n * 1_000_000_000);
    /* istanbul ignore next */
    default: throw new TypeError(`Unknown size unit '${unit}'`);
  }
}
