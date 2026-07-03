/**
 * File-first result surface — the value the file-first layer's `run()` /
 * `Handle.wait()` / `Handle.result()` return (producers land in FF2b/FF5).
 *
 * Coexists with the operation-first `Result`/`Artifact` (in `builder.ts`)
 * until the operation-first layer is removed (FF6). The file-first shape is
 * flatter and adds an always-present per-input partition (`succeeded` /
 * `failed`) so one bad input in a multi-input run doesn't sink the rest.
 *
 * Mirrors `packages/php/src/FileFirst/*`.
 */

import { GislConfigError, GislItemFailedError, GislNetworkError, GislNoSuchKeyError, GislSinkError, GislTimeoutError, SseEndedWithoutTerminal } from './errors.js';
import {
  _detectCompressMedia,
  _detectAudioLossless,
  _consumeSseToTerminal,
  _pollToTerminal,
  _parseMaxWait,
  _checkAborted,
  _cappedProbeTimeoutMs,
  type ProgressEvent,
} from './builder.js';
import type { GislClient } from './client.js';
import type {
  OperationDownload,
  WorkflowCreateResponse,
  WorkflowStatusResponse,
} from '@giveitsmaller/contracts/openapi';
import { LazyHttpDownloader } from './lazy-downloader.js';
import {
  resolveCompressOptions,
  type ResolveCompressOptionsInput,
} from './ergonomic/preset_resolver.js';
import { validateVerbOptions, assertThumbnailDimensions } from './ergonomic/option_validation.js';
import type {
  ConvertOptions,
  ThumbnailOptions,
  TextWatermarkOptions,
  WatermarkOptions,
  OutputOptions,
  OutputFit,
} from './ergonomic/option_types.js';
import {
  resolveOutputRoute,
  tokenForMime,
  tokenForPath,
  isPlannedValue,
  FACADE_MANAGED_OUTPUTS,
} from './ergonomic/image_output_routes.js';
import { OptimizeFor } from './generated/sdk_spec/enums.js';
import type { PresetDefaults, PresetMedia } from './ergonomic/presets/index.js';
import type {
  JobDefinitionPayload,
  JobInputV2Payload,
  OperationDef,
  WorkflowCreatePayload,
} from './types.js';
import { uploadSource, jobOutputSource } from './types.js';
import type { MergeMediaKind, MergeOptions } from './merge.js';
// Value import used only at call-time (inside MergedRecipe.toWorkflowPayload),
// never at module-eval, so the file-first <-> merge <-> handle import cycle
// resolves cleanly under ESM (same deferred-usage discipline as `Handle`).
import { wireMergeOptions } from './merge.js';
// Deferred-usage-only import: `Handle` is constructed inside `submit()` at call
// time, never at module-eval, so the handle.ts <-> file-first.ts back-edge
// (handle.ts imports RunResult/projectDownloadsToRunResult from here) resolves
// cleanly under ESM. Mirrors builder.ts/merge.ts importing Handle the same way.
import { Handle } from './handle.js';

/**
 * Streams a single output URL to a local path. The seam between the
 * file-first {@link RunResult} sinks and the SDK's HTTP/auth layer.
 *
 * FF1 defines ONLY this type — the concrete implementation (fetch +
 * filesystem streamer) is wired by the producer tickets (`run()`/`submit()`,
 * FF2b/FF5), which construct a `RunResult` with a real downloader bound to
 * the client's auth context. Unit tests inject a small stub. A `RunResult`
 * built WITHOUT a downloader (e.g. in a browser, or any no-I/O context)
 * throws {@link GislSinkError} from its sinks rather than reaching for a
 * global client.
 *
 * Mirrors the PHP `Downloader` interface.
 *
 * STREAMING CONTRACT: implementations MUST stream the URL body to
 * `destPath` — they MUST NOT buffer the whole output in memory. The
 * `Promise<void>` return exists precisely so no buffered-bytes value can
 * leak into the calling convention.
 */
export interface Downloader {
  /**
   * Stream the body at `url` to the local filesystem path `destPath`.
   * Implementations create/overwrite `destPath`. Failures reject.
   */
  downloadTo(url: string, destPath: string): Promise<void>;
}

/**
 * A single deliverable output of a file-first run — the file-first layer's
 * flat output type. Leaner than the operation-first `Artifact`: just the
 * four fields a caller needs to identify + fetch an output.
 *
 * Mirrors the PHP `OutputFile`.
 */
export interface OutputFile {
  readonly url: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly operation: string;
  /**
   * For a `target_size` encode: the quality the encode-measure loop settled
   * on. Projected from the generated {@link OperationDownload.chosenQuality};
   * undefined (omitted) for non-target-size outputs. Pairs with
   * {@link targetSizeMet}.
   */
  readonly chosenQuality?: number;
  /**
   * For a `target_size` encode: whether the output landed at or under the
   * requested byte target. `false` is an honest best-effort outcome (target
   * unreachable at min quality), NOT a failure. Projected from the generated
   * {@link OperationDownload.targetSizeMet}; undefined for non-target-size
   * outputs.
   */
  readonly targetSizeMet?: boolean;
  /**
   * The measured perceptual quality of an `auto_quality` encode (0-1). Projected
   * from the generated {@link OperationDownload.measuredQuality}; undefined
   * (omitted) when the worker reported no measurement. Pairs with
   * {@link qualityMetric}, which names the metric it was measured on.
   */
  readonly measuredQuality?: number;
  /**
   * The metric {@link measuredQuality} was measured on (e.g. `ssimulacra2`).
   * Projected from the generated {@link OperationDownload.qualityMetric};
   * undefined when no measurement was reported.
   */
  readonly qualityMetric?: string;
}

/**
 * One succeeded entry in {@link RunResult.succeeded}: a single input's
 * outputs, addressable by the `key:` the caller gave that file (null when
 * no key was supplied). Mirrors the PHP `ItemResult`.
 */
export interface ItemResult {
  readonly key: string | null;
  readonly outputs: readonly OutputFile[];
}

/**
 * One failed entry in {@link RunResult.failed}: an input that did not produce a
 * deliverable, paired with the cause. One bad input does not sink the rest of a
 * multi-input run. `error` is a typed {@link GislItemFailedError} carrying the
 * terminal `state` plus the failing operation's `errorMessage`/`errorCode` (when
 * present), so the caller can branch on the failure WITHOUT string-parsing.
 * Mirrors the PHP `ItemFailure`.
 */
export interface ItemFailure {
  readonly key: string | null;
  readonly error: GislItemFailedError;
}

/**
 * Return value of {@link RunResult.downloadTo} — the local paths written,
 * in the SAME order as {@link RunResult.artifacts}. Mirrors the PHP
 * `Manifest`.
 */
export interface Manifest {
  readonly paths: readonly string[];
}

/**
 * Result of a file-first run. Coexists with the operation-first `Result`
 * (in `builder.ts`) until FF6.
 *
 * Mirrors the PHP `RunResult` class. A class (not a bare interface) because
 * it carries the `byKey()`/`toFile()`/`downloadTo()` behaviour; the data
 * fields stay public + readonly so `toArray()` round-trips.
 *
 * Field notes:
 *  - `url`: single-output sugar — the lone artifact's URL when exactly one
 *    output exists, else undefined.
 *  - `ok`: true iff `failed` is empty. (A boolean — the partition lists are
 *    `succeeded`/`failed`; resolves the design doc's `ok` bool-vs-list
 *    contradiction.)
 *  - `targetSizeMissed`: derived target-size signal — undefined when no output
 *    reports a target-size outcome (not a target_size run); otherwise true iff
 *    some artifact has `targetSizeMet === false`. Omitted from the JSON when
 *    undefined so non-target-size runs keep the common-case shape.
 *  - `state`: lifecycle state (`completed` | `failed` | ...). Named `state`,
 *    NOT `status`, matching the file-first `StatusSnapshot.state`.
 *  - sinks fetch via the injected {@link Downloader}; a result with no
 *    downloader throws {@link GislSinkError} (reason `downloader_unavailable`).
 */
export class RunResult {
  /** Single-output sugar: the lone artifact's URL, or undefined for 0 / >1. */
  readonly url?: string;
  /** True iff {@link failed} is empty. */
  readonly ok: boolean;
  /**
   * Whether any output missed its requested byte target. Derived from the
   * per-output {@link OutputFile.targetSizeMet}: undefined when NO artifact
   * reports a target-size outcome (every `targetSizeMet` undefined — not a
   * target_size run); otherwise true iff some artifact has
   * `targetSizeMet === false`.
   */
  readonly targetSizeMissed?: boolean;

  constructor(
    readonly workflowId: string,
    readonly state: string,
    readonly artifacts: readonly OutputFile[],
    readonly succeeded: readonly ItemResult[],
    readonly failed: readonly ItemFailure[],
    private readonly downloader?: Downloader,
  ) {
    this.url = artifacts.length === 1 ? artifacts[0].url : undefined;
    this.ok = failed.length === 0;
    this.targetSizeMissed = artifacts.every((a) => a.targetSizeMet === undefined)
      ? undefined
      : artifacts.some((a) => a.targetSizeMet === false);
  }

  /**
   * Address a succeeded input by the `key:` given to `file()`. Duplicate keys
   * are not valid input — the producer enforces key uniqueness (a later
   * ticket); the first match is returned.
   * @throws {GislNoSuchKeyError} when no succeeded entry has that key (a
   *   keyless run always throws — it is positionally addressable only).
   */
  byKey(key: string): ItemResult {
    const item = this.succeeded.find((i) => i.key === key);
    if (item === undefined) {
      throw new GislNoSuchKeyError(`No result for key '${key}'.`);
    }
    return item;
  }

  /**
   * Write the single output to `path`. Requires EXACTLY ONE artifact.
   * @throws {GislSinkError} reason `not_single_output` for 0/>1 outputs;
   *   reason `downloader_unavailable` when no downloader is bound.
   */
  async toFile(path: string): Promise<void> {
    if (this.artifacts.length !== 1) {
      throw new GislSinkError(
        `toFile() requires exactly one output; this run produced ${this.artifacts.length}. ` +
          'Use downloadTo() for multi-output runs.',
        { reason: 'not_single_output' },
      );
    }
    await this.requireDownloader().downloadTo(this.artifacts[0].url, path);
  }

  /**
   * Download every output into `dir` (filename per output), in output order.
   * Returns the {@link Manifest} of local paths written.
   * @throws {GislSinkError} reason `partial_failure` when `failOnPartial` and
   *   the run had failed inputs; reason `downloader_unavailable` when no
   *   downloader is bound.
   */
  async downloadTo(dir: string, options?: { failOnPartial?: boolean }): Promise<Manifest> {
    if (options?.failOnPartial && this.failed.length > 0) {
      throw new GislSinkError(
        `downloadTo({ failOnPartial: true }) but the run had ${this.failed.length} failed input(s).`,
        { reason: 'partial_failure' },
      );
    }
    if (dir === '') {
      throw new GislSinkError(
        "downloadTo(): the directory argument is empty. Pass a target directory (use '.' for the current directory).",
        { reason: 'invalid_directory' },
      );
    }
    const downloader = this.requireDownloader();
    const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
    // Resolve destinations first so a basename collision fails loudly BEFORE any
    // byte is written — silently overwriting an earlier output is data loss.
    const names = this.artifacts.map(
      // Strip any directory component from a server-supplied filename so a value
      // like "../x" or "a/b" cannot escape `dir` (mirrors PHP basename()).
      (a) => a.filename.split(/[/\\]/).pop() ?? a.filename,
    );
    // Collision key is case-folded: many destination filesystems (macOS, NTFS)
    // are case-insensitive, so `a.jpg` and `A.jpg` would target the same file.
    const seen = new Set<string>();
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new GislSinkError(
          `downloadTo(): two outputs resolve to the same filename '${name}' in '${dir}' ` +
            '(case-insensitively). Download them to separate directories.',
          { reason: 'duplicate_filename' },
        );
      }
      seen.add(key);
    }
    const paths: string[] = [];
    for (let i = 0; i < this.artifacts.length; i++) {
      const dest = `${dir}${sep}${names[i]}`;
      await downloader.downloadTo(this.artifacts[i].url, dest);
      paths.push(dest);
    }
    return { paths };
  }

  /**
   * Plain-object projection. Field ORDER (workflowId, state, ok,
   * targetSizeMissed?, url?, artifacts, succeeded, failed) is fixed to match
   * the PHP `toArray()` reference so JSON-string parity holds (FF1 shape
   * assertion + FF2b harness fixture). `targetSizeMissed` + `url` are omitted
   * entirely when undefined — `JSON.stringify` then produces the identical
   * shape to PHP's omit-when-null `toArray()`.
   */
  toJSON(): {
    workflowId: string;
    state: string;
    ok: boolean;
    targetSizeMissed?: boolean;
    url?: string;
    artifacts: readonly OutputFile[];
    succeeded: readonly { key: string | null; outputs: readonly OutputFile[] }[];
    failed: readonly {
      key: string | null;
      error: string;
      state: string;
      errorMessage?: string;
      errorCode?: string;
    }[];
  } {
    // Re-project each OutputFile to exactly its known fields so structurally
    // compatible inputs carrying extra properties can't leak into the JSON.
    // The projected optional fields (chosenQuality/targetSizeMet and the
    // auto_quality measuredQuality/qualityMetric) are OMITTED when undefined,
    // mirroring PHP's omit-when-null so outputs lacking them stay
    // byte-identical across languages.
    const file = (o: OutputFile): OutputFile => ({
      url: o.url,
      filename: o.filename,
      sizeBytes: o.sizeBytes,
      operation: o.operation,
      ...(o.chosenQuality !== undefined ? { chosenQuality: o.chosenQuality } : {}),
      ...(o.targetSizeMet !== undefined ? { targetSizeMet: o.targetSizeMet } : {}),
      ...(o.measuredQuality !== undefined ? { measuredQuality: o.measuredQuality } : {}),
      ...(o.qualityMetric !== undefined ? { qualityMetric: o.qualityMetric } : {}),
    });
    const rest = {
      artifacts: this.artifacts.map(file),
      succeeded: this.succeeded.map((i) => ({ key: i.key, outputs: i.outputs.map(file) })),
      // Field order (key, error, state, errorMessage?, errorCode?) is fixed to
      // match the PHP ItemFailure::toArray() so JSON-string parity holds; the two
      // optional keys are OMITTED when absent (cancel/expire carry only state),
      // mirroring PHP's omit-when-null (NOT emitted as `undefined`/`null`).
      failed: this.failed.map((f) => {
        const e = f.error;
        const base = { key: f.key, error: e.message, state: e.state };
        const withMsg = e.errorMessage === undefined ? base : { ...base, errorMessage: e.errorMessage };
        return e.errorCode === undefined ? withMsg : { ...withMsg, errorCode: e.errorCode };
      }),
    };
    const head = { workflowId: this.workflowId, state: this.state, ok: this.ok };
    // Insert `targetSizeMissed` immediately after `ok` (before `url`) when
    // present, then `url` BETWEEN it and artifacts, matching the PHP toArray()
    // field order (workflowId, state, ok, targetSizeMissed?, url?, artifacts,
    // ...) so JSON-string parity holds. Both are omitted entirely when
    // undefined (PHP omits null), so `JSON.stringify` produces the identical
    // shape.
    const headWithMissed =
      this.targetSizeMissed === undefined
        ? head
        : { ...head, targetSizeMissed: this.targetSizeMissed };
    return this.url === undefined
      ? { ...headWithMissed, ...rest }
      : { ...headWithMissed, url: this.url, ...rest };
  }

  private requireDownloader(): Downloader {
    if (this.downloader === undefined) {
      throw new GislSinkError(
        'This result has no downloader bound, so its outputs cannot be written to disk here ' +
          '(e.g. a browser / no-I/O context). Fetch each output from its URL instead.',
        { reason: 'downloader_unavailable' },
      );
    }
    return this.downloader;
  }
}

/**
 * Flatten the terminal workflow status + its downloads into a {@link RunResult}.
 *
 * Shared by {@link Recipe.run} (passes its recipe key) and the file-first
 * {@link Handle} reattach surface (`Handle.wait()`/`Handle.result()`, FF5a —
 * passes `null` because a reattached handle carries no recipe key).
 *
 * **Partition invariant (carries a prior codex-review fix — do NOT let it
 * drift):** success is ONLY `state === 'completed'`. Every other terminal
 * state — `failed`, `partially_failed`, `cancelled`, `expired`,
 * `paused_insufficient_credits` — partitions into `failed[]` so a caller's
 * `ok`/`succeeded` check can never treat a cancelled/expired/paused run as a
 * clean result.
 *
 * @internal Exported for reuse by the file-first `Handle`; not part of the
 *   caller-facing fluent surface.
 */
/** The error fields read off a terminal operation (`OperationResponse`). */
interface OpError {
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

/**
 * Extract the human + machine error from the FIRST failing operation in `ops`
 * (the first op carrying an `errorMessage` OR `errorCode`), reading BOTH from the
 * SAME op so a code from one op can't pair with a message from another. Both are
 * absent for terminal states with no failing op (cancel/expire/credit-pause).
 */
function firstOpError(ops: readonly OpError[]): OpError {
  const op = ops.find((o) => o.errorMessage !== undefined || o.errorCode !== undefined);
  return { errorMessage: op?.errorMessage, errorCode: op?.errorCode };
}

export function projectDownloadsToRunResult(
  workflowId: string,
  finalStatus: WorkflowStatusResponse,
  jobDownloads: readonly { files: readonly OperationDownload[] }[],
  key: string | null,
  downloader?: Downloader,
): RunResult {
  // Flatten to the lean OutputFile[] (the four file-first fields only).
  const artifacts: OutputFile[] = [];
  for (const job of jobDownloads) {
    for (const f of job.files) {
      artifacts.push({
        url: f.downloadUrl,
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        operation: f.operation,
        // Omit-when-absent on the LIVE OutputFile too (not just toJSON): a
        // non-target-size output carries no chosenQuality/targetSizeMet key.
        ...(f.chosenQuality !== undefined ? { chosenQuality: f.chosenQuality } : {}),
        ...(f.targetSizeMet !== undefined ? { targetSizeMet: f.targetSizeMet } : {}),
        ...(f.measuredQuality !== undefined ? { measuredQuality: f.measuredQuality } : {}),
        ...(f.qualityMetric !== undefined ? { qualityMetric: f.qualityMetric } : {}),
      });
    }
  }

  const state = finalStatus.status;
  let succeeded: ItemResult[];
  let failed: ItemFailure[];
  if (state === 'completed') {
    succeeded = [{ key, outputs: artifacts }];
    failed = [];
  } else {
    // First failing op across ALL jobs (downloads path is whole-workflow scoped).
    const { errorMessage, errorCode } = firstOpError(
      ((finalStatus as unknown as { jobs?: readonly { operations?: readonly OpError[] }[] }).jobs ?? []).flatMap(
        (j) => j.operations ?? [],
      ),
    );
    succeeded = [];
    failed = [{ key, error: new GislItemFailedError(key, state, errorMessage, errorCode) }];
  }

  return new RunResult(workflowId, state, artifacts, succeeded, failed, downloader);
}

/**
 * Flatten a terminal multi-job workflow (the `client.files([...])` fan-out)
 * into a partitioned {@link RunResult}. One job per input file, keyed by the
 * `file-{i}` job ref the {@link FilesRecipe} lowering assigns; the result's
 * `succeeded` / `failed` partition is PER JOB, so one bad input does not sink
 * the rest.
 *
 * Join model: `finalStatus.jobs[]` carries the per-job {@link JobStatus} +
 * `operations[]` (for the error message); `jobDownloads[]` carries the per-job
 * output files. Both are joined on the job `ref` ("file-{i}"); the partition
 * key is the index `"{i}"` parsed out of that ref. The flat `artifacts[]` is
 * every job's outputs in job order (the order `finalStatus.jobs[]` lists them).
 *
 * **Partition invariant (mirrors {@link projectDownloadsToRunResult} PER JOB —
 * do NOT let it drift):** a job is a SUCCESS only when its
 * {@link JobResponse.status} `=== 'completed'`. Any other per-job status —
 * `failed`, `pending`, `waiting`, `blocked_insufficient_credits`,
 * `in_progress` — partitions that job into `failed[]` (with that job's first
 * operation error message, scoped to THAT job only).
 *
 * @internal Exported for the file-first `client.files([...]).run()` producer;
 *   not part of the caller-facing fluent surface.
 */
export function projectMultiJobToRunResult(
  workflowId: string,
  finalStatus: WorkflowStatusResponse,
  jobDownloads: readonly { ref: string; files: readonly OperationDownload[] }[],
  keyByRef: ReadonlyMap<string, string | null>,
  downloader?: Downloader,
): RunResult {
  // Group downloads by job ref so a job's outputs can be flattened AFTER the
  // per-job partition is decided (grouping is unrecoverable post-flatten).
  const filesByRef = new Map<string, readonly OperationDownload[]>();
  for (const job of jobDownloads) {
    filesByRef.set(job.ref, job.files);
  }

  const artifacts: OutputFile[] = [];
  const succeeded: ItemResult[] = [];
  const failed: ItemFailure[] = [];

  const jobs = finalStatus.jobs ?? [];
  for (const job of jobs) {
    const key = keyByRef.get(job.ref) ?? jobIndexFromRef(job.ref);
    const outputs: OutputFile[] = (filesByRef.get(job.ref) ?? []).map((f) => ({
      url: f.downloadUrl,
      filename: f.filename,
      sizeBytes: f.sizeBytes,
      operation: f.operation,
      // Omit-when-absent on the LIVE OutputFile too (mirrors toJSON + the
      // single-job projector).
      ...(f.chosenQuality !== undefined ? { chosenQuality: f.chosenQuality } : {}),
      ...(f.targetSizeMet !== undefined ? { targetSizeMet: f.targetSizeMet } : {}),
      ...(f.measuredQuality !== undefined ? { measuredQuality: f.measuredQuality } : {}),
      ...(f.qualityMetric !== undefined ? { qualityMetric: f.qualityMetric } : {}),
    }));
    // The flat artifacts[] keeps every job's outputs in job order.
    artifacts.push(...outputs);

    if (job.status === 'completed') {
      succeeded.push({ key, outputs });
    } else {
      // Per-job scoped: read the error from THIS job's ops only.
      const { errorMessage, errorCode } = firstOpError(job.operations ?? []);
      failed.push({
        key,
        error: new GislItemFailedError(key, String(job.status), errorMessage, errorCode),
      });
    }
  }

  return new RunResult(workflowId, finalStatus.status, artifacts, succeeded, failed, downloader);
}

/** Derive the partition key `"{i}"` from a `file-{i}` job ref; the ref verbatim otherwise. */
function jobIndexFromRef(ref: string): string {
  return ref.startsWith('file-') ? ref.slice('file-'.length) : ref;
}

const _FANOUT_REF = /^file-\d+$/;

/**
 * True when a terminal status describes a homogeneous `files([...])` fan-out —
 * i.e. it has at least one job and EVERY job ref is `file-{i}` (the ids the
 * {@link FilesRecipe} lowering assigns). A single-file {@link Recipe} omits the
 * job id, so its job carries a non-`file-N` ref (e.g. `op`) and this is false.
 *
 * This is the data-driven seam that lets {@link Handle.wait}/{@link Handle.result}
 * pick the per-job producer ({@link projectMultiJobToRunResult}) over the
 * single-output one for a fan-out — WITHOUT a construction-time marker, so a
 * fan-out **reattached** via `client.workflow(id)` (which carries no marker)
 * still partitions per job. Keys are recovered from the `file-{i}` refs.
 *
 * @internal Exported for the file-first `Handle`; not part of the public API.
 */
export function isFanoutStatus(finalStatus: WorkflowStatusResponse): boolean {
  const jobs = finalStatus.jobs ?? [];
  return jobs.length > 0 && jobs.every((job) => _FANOUT_REF.test(job.ref));
}

const _MERGE_SRC_REF = /^src_\d+$/;

/**
 * True when a terminal status describes a fluent `files([...]).merge(...)`
 * combine — at least one job ref `merge` and every OTHER job ref is `src_{i}`
 * (the ids the {@link MergedRecipe} lowering assigns). The data-driven seam that
 * lets {@link Handle.wait}/{@link Handle.result} project ONLY the merged output
 * — filtering the `src_*` passthrough plumbing — even after a
 * `client.workflow(id)` reattach (no construction-time marker), matching
 * {@link MergedRecipe.run}'s `ref === 'merge'` filter. Mutually exclusive with
 * {@link isFanoutStatus} (a fan-out's refs are all `file-{i}`).
 *
 * @internal Exported for the file-first `Handle`; not part of the public API.
 */
export function isMergeStatus(finalStatus: WorkflowStatusResponse): boolean {
  const jobs = finalStatus.jobs ?? [];
  if (jobs.length === 0) return false;
  let hasMerge = false;
  for (const job of jobs) {
    if (job.ref === 'merge') {
      hasMerge = true;
      continue;
    }
    if (!_MERGE_SRC_REF.test(job.ref)) return false;
  }
  return hasMerge;
}

/**
 * True when a terminal status describes a fluent `files([...]).archive(...)`
 * bundle — at least one job ref `archive` and every OTHER job ref is `src_{i}`
 * (the ids the {@link ArchivedRecipe} lowering assigns). Lets
 * {@link Handle.wait}/{@link Handle.result} project ONLY the archive output —
 * filtering the `src_*` passthrough plumbing — even after a `client.workflow(id)`
 * reattach. Mutually exclusive with {@link isFanoutStatus} / {@link isMergeStatus}.
 *
 * @internal Exported for the file-first `Handle`; not part of the public API.
 */
export function isArchiveStatus(finalStatus: WorkflowStatusResponse): boolean {
  const jobs = finalStatus.jobs ?? [];
  if (jobs.length === 0) return false;
  let hasArchive = false;
  for (const job of jobs) {
    if (job.ref === 'archive') {
      hasArchive = true;
      continue;
    }
    if (!_MERGE_SRC_REF.test(job.ref)) return false;
  }
  return hasArchive;
}

/**
 * True when a terminal status describes a fluent `file(...).watermark(overlay)`
 * — at least one job ref `watermark` and every OTHER job ref is `src_{i}` (the
 * ids the {@link WatermarkedRecipe} lowering assigns: `src_0` base, `src_1`
 * overlay). Lets {@link Handle.wait}/{@link Handle.result} AND
 * {@link WatermarkedRecipe.run} project ONLY the watermark output — filtering
 * the `src_*` passthrough plumbing — even after a `client.workflow(id)` reattach.
 * Mutually exclusive with {@link isFanoutStatus} / {@link isMergeStatus} /
 * {@link isArchiveStatus}.
 *
 * @internal Exported for the file-first `Handle`; not part of the public API.
 */
export function isWatermarkStatus(finalStatus: WorkflowStatusResponse): boolean {
  const jobs = finalStatus.jobs ?? [];
  if (jobs.length === 0) return false;
  let hasWatermark = false;
  for (const job of jobs) {
    if (job.ref === 'watermark') {
      hasWatermark = true;
      continue;
    }
    if (!_MERGE_SRC_REF.test(job.ref)) return false;
  }
  return hasWatermark;
}

/**
 * The primary file a {@link Recipe} operates on — the "subject" of the
 * file-first surface. A discriminated union over the ways a caller names an
 * input:
 *
 *  - `path`     — a local filesystem path (Node; the common case).
 *  - `blob`     — an in-memory `Blob`/`File` (browser, or Node 18+).
 *  - `uploadId` — a previously-uploaded `file_id` (reuse across recipes).
 *
 * FF2a does NO upload, so only the `path` + `uploadId` arms are exercised
 * end-to-end here; the `blob` arm is DEFINED and type-checked but its upload
 * is wired by FF2b (`run()`). Mirrors the PHP `FileInput` value object.
 */
export type FileInput =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'uploadId'; readonly fileId: string };

/** Named constructors for {@link FileInput} — mirror the PHP static factories. */
export const fileInput = {
  path(path: string): FileInput {
    return { kind: 'path', path };
  },
  blob(blob: Blob): FileInput {
    return { kind: 'blob', blob };
  },
  /**
   * Reference an already-uploaded file by its upload id, instead of
   * re-uploading bytes.
   *
   * Auth-ownership: an upload created by an **authenticated** caller is owned
   * by that caller. If you reuse the id from a client configured with a
   * *different* auth context (a different `apiKey` / session), workflow-create
   * returns `404 upload_not_found` — the server enforces ownership (api
   * PqpD9ySv). Reference an upload id only under the SAME auth that created it.
   * The normal upload-then-create-in-one-client flow is consistent by
   * construction (the same `Authorization` rides every request). Ownerless
   * (anonymous-intake) uploads are unaffected.
   */
  uploadId(fileId: string): FileInput {
    return { kind: 'uploadId', fileId };
  },
} as const;

/** One step in a {@link Recipe}'s chain — an op kind + captured ergonomic args. */
interface RecipeStep {
  // `output` is an INTERNAL step kind (the image Output facade); it lowers to a
  // `compress` (same_format) or `convert` (format_change) wire op per the route
  // projection — see lowerOutputStep. The others lower 1:1 to their wire op.
  readonly opType: 'compress' | 'convert' | 'thumbnail' | 'text_watermark' | 'output';
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Await a workflow to a terminal status — SSE first with a poll fallback, or
 * poll-direct when `useSSE` is false. The single shared implementation behind
 * every file-first `run()` (Recipe, FilesRecipe, MergedRecipe, ArchivedRecipe,
 * WatermarkedRecipe), mirroring the operation-first
 * `OperationBuilder.awaitTerminal` (in `builder.ts`). Callers pass
 * `useSSE: options.useSSE ?? true` so the default stays SSE-first (today's
 * behaviour); `useSSE: false` skips the SSE attempt entirely and polls —
 * useful when an intermediary proxy blocks SSE.
 *
 * @internal Not part of the caller-facing fluent surface.
 */
async function _awaitTerminal(
  client: GislClient,
  args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    onProgress: ((event: ProgressEvent) => void) | undefined;
    pollIntervalMs?: number;
    useSSE: boolean;
  },
): Promise<WorkflowStatusResponse> {
  if (args.useSSE) {
    try {
      return await _consumeSseToTerminal(client, {
        workflowId: args.workflowId,
        deadline: args.deadline,
        signal: args.signal,
        onProgress: args.onProgress,
      });
    } catch (err) {
      // TDqmkWpX: poll-fallback ONLY on a clean SSE stream-end
      // (SseEndedWithoutTerminal) or a typed transport error (GislNetworkError).
      // Everything else — caller-deadline, abort, an API error from /events, an
      // onProgress callback throw (propagates as-is, NOT wrapped), anything
      // unexpected — MUST propagate; re-issuing the same doomed request via poll
      // would mask it. Mirrors the PHP BuilderInternals::awaitTerminal sealed-
      // marker discipline.
      if (!(err instanceof SseEndedWithoutTerminal || err instanceof GislNetworkError)) {
        throw err;
      }
    }
  }
  return await _pollToTerminal(client, {
    workflowId: args.workflowId,
    deadline: args.deadline,
    signal: args.signal,
    pollIntervalMs: args.pollIntervalMs,
  });
}

/**
 * The file-first builder value. `client.file(path)` returns a `Recipe`;
 * single-input operations called on it (`compress`, `convert`, `thumbnail`,
 * `textWatermark`) chain SEQUENTIALLY — each op feeds the next, and the chain
 * lowers to ONE workflow job with an ordered `operations[]` (per ADR-0004:
 * operations execute sequentially, each consuming the previous output). A
 * chain yields the TERMINAL output only; intermediates are consumed (surfaced
 * by FF2b's `run()`/{@link RunResult}).
 *
 * **Immutable / clone-on-write.** Every op returns a NEW `Recipe` carrying the
 * appended step — `this` is never mutated. A Recipe is therefore a reusable
 * value: branching the same base recipe two different ways cannot let one
 * branch observe the other's steps (the aliasing trap mutable builders fall
 * into).
 *
 * FF2a is network-free: there is NO `run()` here (that is FF2b). The lowering
 * seam {@link toWorkflowPayload} takes the resolved upload id as a parameter
 * so it stays pure — FF2b's `run()` calls the SAME method after uploading, and
 * the parity harness calls it with a fixed id to assert the lowered shape.
 *
 * Mirrors the PHP `Recipe`.
 */
export class Recipe {
  constructor(
    private readonly input: FileInput,
    private readonly recipeKey: string | undefined = undefined,
    private readonly steps: readonly RecipeStep[] = [],
    private readonly presetDefaults?: PresetDefaults,
    private readonly scopedPresetDefaults?: PresetDefaults,
    private readonly client?: GislClient,
  ) {}

  /**
   * Reduce file size. `optimize` selects a per-media preset (resolved to
   * concrete wire fields at lower-time, exactly as `client.compress()` does).
   * `options` carries the full per-op options bag (mirrors
   * `client.compress(input, options)`); the explicit `optimize` param wins
   * over any `optimize` key in the bag.
   */
  compress(optimize?: OptimizeFor, options: Record<string, unknown> = {}): Recipe {
    if (optimize !== undefined && !Object.values(OptimizeFor).includes(optimize)) {
      const allowed = Object.values(OptimizeFor).join(', ');
      throw new GislConfigError(
        `compress 'optimize' must be one of ${allowed}; got '${String(optimize)}'.`,
        { reason: 'invalid_optimize', conflictingFields: ['optimize'] },
      );
    }
    return this.withStep({
      opType: 'compress',
      options: { ...options, ...(optimize !== undefined ? { optimize } : {}) },
    });
  }

  /**
   * Change format. The `format` shorthand lowers to the `output_format` wire
   * option (the convert op's wire key per the contract); `options` carries any
   * additional per-op convert options.
   */
  convert(format: string, options: ConvertOptions = {}): Recipe {
    // Eager pre-upload key validation (rejects unknown keys + a user-supplied
    // output_format/format, which this verb owns via the `format` argument).
    validateVerbOptions('convert', options);
    // The convert op's wire key is `output_format` (contract: convert.yaml,
    // required, all media), NOT `format`. Validation above guarantees the bag
    // carries neither `format` nor `output_format`, so no drop is needed.
    return this.withStep({ opType: 'convert', options: { ...options, output_format: format } });
  }

  /**
   * Generate a preview / resize. `width` AND `height` are required (the contract
   * marks both required for image/video/document); any additional per-op
   * thumbnail option passes through. An omitted (`undefined`) optional value is
   * dropped from the wire options (not sent as `undefined`).
   */
  thumbnail(options: ThumbnailOptions): Recipe {
    validateVerbOptions('thumbnail', options);
    assertThumbnailDimensions(options);
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) wire[key] = value;
    }
    return this.withStep({ opType: 'thumbnail', options: wire });
  }

  /**
   * Produce ONE transformed image: keep or change format, plus quality, resize
   * and route-honored controls. The single user-facing image transform — the SDK
   * resolves the route from `(input format, output_format)` against the contract's
   * image-output-routes projection and lowers to that route's wire op:
   * same-format → `compress` (optimiser, `output_format: 'original'`), format-change
   * → `convert` (transcoder, `output_format: <fmt>`). Only options the resolved
   * route honors are sent; a planned or not-honored option throws BEFORE upload.
   * Resize (`width`/`height`/`fit`, via `options` or {@link resize}) stays on the
   * SAME op — one output, never a separate thumbnail.
   *
   * `format` omitted → keep the input format (same-format optimiser route).
   */
  output(format?: string, options: OutputOptions = {}): Recipe {
    // Eager pre-upload key validation (coarse: rejects keys no image route honors,
    // + a bag-supplied output_format/format which the positional `format` owns).
    validateVerbOptions('output', options);
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) wire[key] = value;
    }
    // Store the REQUESTED format token under `output_format`; lowerOutputStep
    // resolves the route and rewrites it to the wire value ('original' for
    // same-format). Omitted format → no output_format key → same-format route.
    if (format !== undefined) wire.output_format = format;
    return this.withStep({ opType: 'output', options: wire });
  }

  /**
   * Resize as part of the Output transform. Merges `width`/`height`/`fit` into the
   * PRECEDING `output()` step (one artifact); if no Output step precedes, appends a
   * same-format Output step carrying the resize. Never emits a `thumbnail` op.
   * `height` is optional — width-only resize preserves aspect ratio. Resize is
   * raster-only (e.g. an SVG input has no resize on its route → throws at lower).
   */
  resize(width: number, height?: number, fit?: OutputFit): Recipe {
    const resizeOptions: Record<string, unknown> = { width };
    if (height !== undefined) resizeOptions.height = height;
    if (fit !== undefined) resizeOptions.fit = fit;
    const steps = [...this.steps];
    const last = steps[steps.length - 1];
    if (last !== undefined && last.opType === 'output') {
      steps[steps.length - 1] = { opType: 'output', options: { ...last.options, ...resizeOptions } };
      return new Recipe(
        this.input,
        this.recipeKey,
        steps,
        this.presetDefaults,
        this.scopedPresetDefaults,
        this.client,
      );
    }
    return this.withStep({ opType: 'output', options: resizeOptions });
  }

  /**
   * Apply a text watermark. Single-input (the text is an option, not a
   * secondary file) — lowers to the `text_watermark` op with a `text` option;
   * `options` carries any additional per-op watermark options.
   */
  textWatermark(text: string, options: TextWatermarkOptions = {}): Recipe {
    // Eager pre-upload validation (rejects unknown keys + a user-supplied `text`,
    // which this verb owns via the first argument).
    validateVerbOptions('textWatermark', options);
    return this.withStep({ opType: 'text_watermark', options: { ...options, text } });
  }

  /**
   * Composite an image OVERLAY onto this file (a multi-input op). `overlay` is a
   * secondary file-NODE (a {@link Recipe} — e.g. `client.file('logo.png')`),
   * itself optionally processed first. Routes by THIS file's effective media:
   * image base → `image_watermark` (stable), video base → `video_watermark`
   * (beta). Audio/document/animated-GIF/unsupported-subtype/undetectable bases
   * throw locally BEFORE any upload (the planned-op gate). `options` carries the
   * wire watermark options (`anchor`, `opacity`, `margin_x`, `margin_y`,
   * `overlay_width`, or `overlays[]` for the multi-overlay stack). Returns a
   * {@link WatermarkedRecipe} (chain post-watermark
   * `compress`/`convert`/`thumbnail`, then `run`/`submit`). Distinct from
   * {@link textWatermark} (single-input text overlay).
   */
  watermark(overlay: Recipe, options: WatermarkOptions = {}): WatermarkedRecipe {
    // Eager pre-upload key validation (against image_watermark ∪ video_watermark,
    // since the base media may be undetectable here; routing is gated separately).
    validateVerbOptions('watermark', options);
    // Eager gate when the base media is KNOWN (unit-testable pre-upload); an
    // undetectable base is DEFERRED — re-checked pre-upload in run()/submit().
    const base = _watermarkEffectiveBase(this.input, this.steps);
    if (base.media !== undefined) _resolveWatermarkWireOp(base);
    _validateWatermarkOverlay(overlay);
    return new WatermarkedRecipe(
      this.input,
      this.steps,
      overlay,
      options,
      [],
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }

  /**
   * Lower this recipe to a workflow-create payload against a resolved upload
   * id. Single-input chain → ONE job, `source: upload(fileId)`, ordered
   * `operations[]`; the job `id` is omitted (a single job referenced by
   * nothing — the server auto-assigns `job_N`).
   *
   * When `callbackUrl` is given (the file-first `submit()` path), it is built
   * INTO the payload at construction (`callback_url`) rather than spread onto an
   * already-built readonly payload. `run()` passes no `callbackUrl`.
   *
   * @internal Consumed by FF2b's `run()` (after a real upload), FF5b's
   *   `submit()` (with a webhook), and the cross-language parity harness (with a
   *   fixed id). Not part of the caller-facing fluent surface.
   */
  toWorkflowPayload(fileId: string, callbackUrl?: string): WorkflowCreatePayload {
    const operations: OperationDef[] = this.steps.map((step, i) => this.lowerStep(step, i));
    // Key order (source, operations) matches the PHP `toWire()` so the
    // JSON-string serialisation is byte-identical across languages.
    const job: JobDefinitionPayload = { source: uploadSource(fileId), operations };
    return callbackUrl === undefined ? { jobs: [job] } : { jobs: [job], callback_url: callbackUrl };
  }

  /** The result-addressing key passed to `file()`, or undefined. */
  key(): string | undefined {
    return this.recipeKey;
  }

  /** The number of operations chained so far (introspection / tests). */
  get stepCount(): number {
    return this.steps.length;
  }

  /**
   * The captured op chain. Read by {@link FilesRecipe} to compose a shared
   * chain across many inputs without duplicating the chain-method validation.
   * @internal
   */
  get recipeSteps(): readonly RecipeStep[] {
    return this.steps;
  }

  /**
   * The primary input this recipe operates on. Read by {@link WatermarkedRecipe}
   * to lift an overlay Recipe's input (for upload + media inference + src-job
   * lowering) without making the ctor field public.
   * @internal
   */
  get recipeInput(): FileInput {
    return this.input;
  }

  /**
   * Execute the recipe end-to-end: upload the input (when required), create
   * the workflow, await a terminal state (SSE with poll fallback), then
   * resolve the produced downloads into a flat {@link RunResult}. Throws
   * {@link GislTimeoutError} if `maxWait` elapses before terminal status.
   *
   * Mirrors the operation-first `OperationBuilder.run` (in `builder.ts`).
   * Requires a client bound at construction time — `gisl().file(...)` wires
   * it; a directly-constructed `Recipe` (e.g. in a lowering-only test) has no
   * client and throws {@link GislConfigError}.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'Recipe.run() requires a client; build the recipe via gisl().file(...) rather than constructing Recipe directly.',
        { reason: 'no_client' },
      );
    }
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    // 1+2. Upload (when required) + create the workflow. Shared with submit()
    // (which passes a webhook → callback_url). run() passes no webhook.
    const created = await this._uploadAndCreate(
      undefined,
      deadline,
      onProgress,
      signal,
      options.probeBeforeCreate,
      options.probeTimeoutMs,
    );

    // 3. Wait to terminal status — SSE first, poll on a genuine SSE error
    // (or poll-direct when `useSSE: false`). Caller-aborted + deadline-elapsed
    // errors MUST propagate (not transient) — see _awaitTerminal.
    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    // 4. Fetch downloads. The maxWait deadline covers upload + create + wait +
    // downloads, so check before issuing the request (mirrors builder.ts).
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    // Download URLs from getWorkflowDownloads are pre-signed and require no SDK
    // auth, so the downloader issues a plain unauthenticated fetch.
    const downloader = new LazyHttpDownloader();
    return projectDownloadsToRunResult(
      created.workflowId,
      finalStatus,
      downloads.downloads,
      this.recipeKey ?? null,
      downloader,
    );
  }

  /**
   * Fire-and-forget the recipe: upload the input (when required), create the
   * workflow (wiring `webhook` into `callback_url` when given), and return a
   * client-bound {@link Handle} carrying the workflow id + webhook secret + the
   * recipe key. Does NOT wait for terminal status — call `handle.wait()` /
   * `handle.result()` later to collect the {@link RunResult}.
   *
   * Requires a client bound at construction time (same `no_client` guard as
   * {@link run}). `webhook` is OPTIONAL: when omitted, no `callback_url` is
   * sent. Mirrors the PHP `Recipe.submit()`.
   *
   * @param webhook Absolute callback URL the server POSTs lifecycle events to.
   * @param options Opt-out (`probeBeforeCreate: false`) / tune (`probeTimeoutMs`)
   *   the best-effort video probe-before-create. Kept as a 2nd optional param so
   *   the existing positional `webhook` arg stays backward compatible.
   */
  async submit(
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'Recipe.submit() requires a client; build the recipe via gisl().file(...) rather than constructing Recipe directly.',
        { reason: 'no_client' },
      );
    }
    // submit() is fire-and-forget — NO whole-run deadline. The upload may be
    // large (a multi-GB master, example 12) and is bounded by the HTTP client's
    // own request timeout, not an arbitrary submit-side cap. Pass `undefined`
    // so the post-upload deadline check is skipped: a 300s cap here would throw
    // on a slow-but-successful big upload before createWorkflow (codex).
    const created = await this._uploadAndCreate(
      webhook,
      undefined,
      undefined,
      undefined,
      options?.probeBeforeCreate,
      options?.probeTimeoutMs,
    );
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      this.recipeKey ?? null,
    );
  }

  /**
   * Resolve the upload id (verbatim for a pre-uploaded id; uploading a path /
   * blob otherwise, emitting `{phase:'upload'}` progress), check the post-upload
   * deadline, lower to the workflow-create payload (wiring `webhook` into
   * `callback_url`), and create the workflow. Shared first half of
   * {@link run} + {@link submit}.
   *
   * The post-upload deadline check carries a prior codex fix (9a117f04eb59): a
   * slow upload must not proceed to createWorkflow past the deadline.
   */
  private async _uploadAndCreate(
    webhook: string | undefined,
    deadline: number | undefined,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    probeBeforeCreate?: boolean,
    probeTimeoutMs?: number,
  ): Promise<WorkflowCreateResponse> {
    // 1. Resolve the upload id. A pre-uploaded id skips the upload entirely;
    // a path / blob is uploaded now, emitting {phase:'upload'} progress.
    let fileId: string;
    // A pre-uploaded id carries no local mime/size, so the video probe-gate is
    // skipped for it (no `up` to read sizeBytes from).
    let uploadSizeBytes: number | undefined;
    if (this.input.kind === 'uploadId') {
      fileId = this.input.fileId;
    } else {
      const source = this.input.kind === 'path' ? this.input.path : this.input.blob;
      const up = await this.client!.uploadFile(source, {
        signal,
        ...(onProgress !== undefined
          ? {
              onProgress: (uploadedBytes: number, totalBytes: number): void => {
                onProgress({ phase: 'upload', uploadedBytes, totalBytes });
              },
            }
          : {}),
      });
      fileId = up.fileId;
      uploadSizeBytes = up.sizeBytes;
    }
    _checkAborted(signal);
    // run() passes a whole-run deadline (the codex 9a117f04eb59 fix: a slow
    // upload must not proceed to createWorkflow past maxWait); submit() passes
    // `undefined` (fire-and-forget, no upload cap), so the check is skipped.
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Upload completed but maxWait elapsed before workflow could be created',
      );
    }

    // Best-effort probe-before-create: for a VIDEO upload that went multipart,
    // let the server see the codec + duration before createWorkflow so it
    // admits the ~3× parallel split. Never-bounce — a give-up just proceeds.
    // The probe wait is CAPPED to the remaining maxWait budget so a slow probe
    // cannot push createWorkflow past the caller's deadline (an unset
    // probeTimeoutMs under a deadline becomes the remaining budget, never the
    // 30s default).
    // Skip a pre-uploaded (`uploadId`) input entirely — no local mime/size to
    // gate on (mirrors the multi-input seams, which omit uploadId inputs from
    // their probe targets).
    if (this.input.kind !== 'uploadId') {
      await this.client!.maybeWaitForVideoProbe(fileId, {
        enabled: probeBeforeCreate ?? true,
        isVideo: this.compressMediaHint() === 'video',
        sizeBytes: uploadSizeBytes,
        timeoutMs: _cappedProbeTimeoutMs(probeTimeoutMs, deadline),
        signal,
      });
    }
    // A cancel arriving during the FINAL successful probe request must not still
    // create the workflow (maybeWaitForVideoProbe returns landed without a final
    // abort re-check), so check here BEFORE createWorkflow.
    _checkAborted(signal);
    // RE-CHECK the deadline AFTER the probe wait: the wait itself consumes time,
    // so a workflow must not be created past maxWait even when the wait was
    // capped (mirrors the post-upload check above).
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Probe wait completed but maxWait elapsed before workflow could be created',
      );
    }

    // 2. Create the workflow from the lowered payload (callback_url built into
    // the payload at construction when a webhook is given).
    const payload = this.toWorkflowPayload(fileId, webhook);
    const created = await this.client!.createWorkflow(payload);
    _checkAborted(signal);
    return created;
  }

  private withStep(step: RecipeStep): Recipe {
    return new Recipe(
      this.input,
      this.recipeKey,
      [...this.steps, step],
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }

  private lowerStep(step: RecipeStep, stepIndex: number): OperationDef {
    // The internal `output` step lowers to a `compress`/`convert` wire op per the
    // route projection (it owns its own type + options resolution + gating).
    if (step.opType === 'output') return this.lowerOutputStep(step, stepIndex);
    // After the early return, `step.opType` narrows to the wire op kinds.
    const options =
      step.opType === 'compress'
        ? this.lowerCompressOptions(step.options, stepIndex)
        : { ...step.options };
    // Empty options omit the `options` wire key entirely, so TS (undefined →
    // absent) and PHP (null → absent) serialise byte-identically.
    return Object.keys(options).length === 0
      ? { type: step.opType }
      : { type: step.opType, options };
  }

  /**
   * Lower an `output` step to its route's wire op. Resolves the route from the
   * (chain-folded) input format token + the requested `output_format`, then emits
   * `compress` (same_format) or `convert` (format_change) carrying only the
   * route-honored options. A planned option (e.g. `lossless`), an option not
   * honored on the resolved route (e.g. `progressive` on a format-change), a
   * planned per-value (e.g. `metadata: 'keep'`), or an unrepresentable route all
   * throw a typed {@link GislConfigError} BEFORE upload. Resize (`width`/`height`/
   * `fit`) is input-keyed (raster only) and rides whichever op the route selects.
   */
  private lowerOutputStep(step: RecipeStep, stepIndex: number): OperationDef {
    const requested =
      typeof step.options.output_format === 'string' ? step.options.output_format : undefined;
    const inputToken = this.outputInputToken(stepIndex);

    if (inputToken === undefined) {
      // Undetectable input (bare upload id / unnamed blob) → the route can't be
      // resolved. Only the legacy compress facade for a facade-managed output
      // (webp) + quality is expressible without knowing the input; anything else
      // (resize, a same-format optimise, a non-facade target) needs a detectable
      // input. Mirrors lowerCompressOptions' media_unknown fail-fast.
      if (requested !== undefined && FACADE_MANAGED_OUTPUTS.includes(requested)) {
        const facade: Record<string, unknown> = { output_format: requested };
        for (const [key, value] of Object.entries(step.options)) {
          if (key === 'output_format' || value === undefined) continue;
          if (key !== 'quality') {
            throw new GislConfigError(
              `output(): '${key}' needs a detectable input format to route; reference the file by ` +
                'a path with an extension (or a named/typed Blob) rather than a bare upload id.',
              { reason: 'media_unknown', conflictingFields: [key] },
            );
          }
          facade[key] = value;
        }
        return { type: 'compress', options: facade };
      }
      throw new GislConfigError(
        'output() needs a detectable input format to resolve the route (same-format optimise vs ' +
          'format-change transcode); reference the file by a path with an extension, or a Blob with ' +
          'a media type / filename, rather than a bare upload id.',
        { reason: 'media_unknown', conflictingFields: ['output_format'] },
      );
    }

    const resolved = resolveOutputRoute(inputToken, requested);
    if (resolved === undefined) {
      throw new GislConfigError(
        `output(): cannot produce ${requested === undefined ? 'this output' : `'${requested}'`} ` +
          `from a '${inputToken}' input — no such image Output route.`,
        { reason: 'unsupported_route', conflictingFields: ['output_format'] },
      );
    }

    const wireOptions: Record<string, unknown> = { output_format: resolved.outputFormatWire };
    for (const [key, value] of Object.entries(step.options)) {
      if (key === 'output_format' || value === undefined) continue;
      if (resolved.planned.has(key)) {
        throw new GislConfigError(
          `output(): '${key}' is advertised but not available yet on the ${resolved.route} route ` +
            `for '${resolved.inputToken}' images (planned). It will work once stable-flipped.`,
          { reason: 'feature_not_available', conflictingFields: [key] },
        );
      }
      if (!resolved.honored.has(key)) {
        throw new GislConfigError(
          `output(): '${key}' is not honored on the ${resolved.route} route ` +
            `(${resolved.inputToken} → ${requested ?? resolved.inputToken}). ` +
            'Check it applies to this format/route combination.',
          { reason: 'option_not_on_route', conflictingFields: [key] },
        );
      }
      if (isPlannedValue(resolved.inputToken, key, value)) {
        throw new GislConfigError(
          `output(): '${key}: ${String(value)}' is advertised but not available yet (planned).`,
          { reason: 'feature_not_available', conflictingFields: [key] },
        );
      }
      wireOptions[key] = value;
    }
    return { type: resolved.sourceOp, options: wireOptions };
  }

  /**
   * The input format token an `output` step at `uptoIndex` operates on — the
   * original input's token, FOLDED through preceding `convert`/`output` steps that
   * change the format (mirrors {@link compressMediaHint}). Undefined when the input
   * media is not inferable (a bare upload id / unnamed, untyped Blob).
   */
  private outputInputToken(uptoIndex?: number): string | undefined {
    let token = this.inputFormatToken();
    if (uptoIndex === undefined) return token;
    for (let i = 0; i < uptoIndex; i++) {
      const prior = this.steps[i];
      if (prior.opType === 'convert' || prior.opType === 'output') {
        const fmt = prior.options.output_format;
        // A same-format `output` step carries no output_format (or 'original') →
        // token unchanged; a format target (e.g. 'webp') advances it.
        if (typeof fmt === 'string') token = tokenForPath(`f.${fmt}`) ?? token;
      }
    }
    return token;
  }

  /** The original input's image format token (path ext / Blob type / Blob name). */
  private inputFormatToken(): string | undefined {
    if (this.input.kind === 'path') return tokenForPath(this.input.path);
    if (this.input.kind === 'blob') {
      const blob = this.input.blob;
      const fromType = blob.type ? tokenForMime(blob.type) : undefined;
      if (fromType !== undefined) return fromType;
      const name = (blob as { name?: string }).name;
      return name !== undefined ? tokenForPath(name) : undefined;
    }
    return undefined; // uploadId — undetectable
  }

  private lowerCompressOptions(
    stepOptions: Readonly<Record<string, unknown>>,
    uptoIndex?: number,
  ): Record<string, unknown> {
    // Mirror the op-first resolver precedence (OperationBuilder._resolve in
    // builder.ts): optimize = preset layer, presetOverrides = callPresetOverride
    // layer, the rest = explicit layer.
    const { optimize, presetOverrides, ...explicitOptions } = stepOptions as {
      optimize?: OptimizeFor;
      presetOverrides?: unknown;
      [k: string]: unknown;
    };
    // Validate the special bag keys at this chokepoint (every compress lowers
    // through here). The chain methods' shorthand-param guard only covers a
    // PARAM-supplied optimize; a bag-supplied optimize / presetOverrides must be
    // validated too, so a bad value raises the typed SDK error rather than
    // surfacing as a raw preset-lookup error or TypeError downstream. Mirrors
    // PHP coerceOptimize + OperationBuilder::normalisePresetOverrides.
    if (optimize !== undefined && !Object.values(OptimizeFor).includes(optimize)) {
      const allowed = Object.values(OptimizeFor).join(', ');
      throw new GislConfigError(
        `compress 'optimize' must be one of ${allowed}; got '${String(optimize)}'.`,
        { reason: 'invalid_optimize', conflictingFields: ['optimize'] },
      );
    }
    if (
      presetOverrides !== undefined &&
      (presetOverrides === null || typeof presetOverrides !== 'object' || Array.isArray(presetOverrides))
    ) {
      const got = Array.isArray(presetOverrides)
        ? 'array'
        : presetOverrides === null
          ? 'null'
          : typeof presetOverrides;
      throw new GislConfigError(
        `compress 'presetOverrides' must be a *CompressPresetOptions object; got ${got}.`,
        { reason: 'invalid_preset_overrides', conflictingFields: ['presetOverrides'] },
      );
    }
    const media = this.compressMediaHint(uptoIndex);
    if (media === undefined) {
      // Cannot infer a media class (a Blob without a recognised name, or a
      // bare upload id) → preset resolution is impossible. Fail FAST rather
      // than silently dropping an explicit `optimize`; bare compress() is fine.
      // When no optimize is set, pass any explicit options through verbatim
      // (exactly as op-first `_resolve` does when media is undefined).
      if (optimize !== undefined) {
        throw new GislConfigError(
          `compress(optimize: ${String(optimize)}) needs a media type to resolve the preset, but the ` +
            'input has no inferable media (a pre-uploaded file id or unnamed Blob carries no extension). ' +
            'Use a path with a file extension, or call compress() without optimize.',
          { reason: 'media_unknown', conflictingFields: ['optimize'] },
        );
      }
      // presetOverrides override a resolved preset; with no media there is no
      // preset to override, so fail fast rather than silently dropping them.
      if (presetOverrides !== undefined) {
        throw new GislConfigError(
          'compress(presetOverrides) needs a media type to resolve the preset to override, but the ' +
            'input has no inferable media (a pre-uploaded file id or unnamed Blob carries no extension). ' +
            'Use a path with a file extension.',
          { reason: 'media_unknown', conflictingFields: ['presetOverrides'] },
        );
      }
      return { ...explicitOptions };
    }
    const input: ResolveCompressOptionsInput = { media, op: 'compress', explicitOptions };
    if (media === 'audio') {
      (input as { audioLossless?: boolean }).audioLossless = this.compressAudioLossless(uptoIndex);
    }
    if (this.presetDefaults !== undefined) {
      (input as { presetDefaults?: PresetDefaults }).presetDefaults = this.presetDefaults;
    }
    if (this.scopedPresetDefaults !== undefined) {
      (input as { scopedPresetDefaults?: PresetDefaults }).scopedPresetDefaults =
        this.scopedPresetDefaults;
    }
    if (presetOverrides !== undefined) {
      // Validated above to be a non-null, non-array object.
      (input as { presetOverrides?: Readonly<Record<string, unknown>> }).presetOverrides =
        presetOverrides as Readonly<Record<string, unknown>>;
    }
    if (optimize !== undefined) {
      (input as { optimize?: OptimizeFor }).optimize = optimize;
    }
    return { ...resolveCompressOptions(input).wireOptions };
  }

  /** Media of the original input (no chain context) — used by the probe gate. */
  private inputMedia(): PresetMedia | undefined {
    if (this.input.kind === 'path') return _detectCompressMedia(this.input.path);
    if (this.input.kind === 'blob') return _detectCompressMedia(this.input.blob);
    return undefined;
  }

  /**
   * The media class a `compress` step at `uptoIndex` actually operates on. With no
   * chain context (`uptoIndex` undefined) this is the original input's media. With
   * context, FOLD the preceding `convert` steps: each `convert(output_format)` changes
   * the media the next step sees (56N4chXY / N8eESzQN — a chain like
   * `mp3 -> convert(flac) -> compress` must resolve against flac, not mp3). Reuses the
   * synthetic-filename detection precedent from {@link MergedRecipe} (`merged.<ext>`).
   */
  private compressMediaHint(uptoIndex?: number): PresetMedia | undefined {
    let media = this.inputMedia();
    if (uptoIndex === undefined) return media;
    for (let i = 0; i < uptoIndex; i++) {
      const step = this.steps[i];
      if (step.opType === 'convert') {
        const fmt = step.options.output_format;
        if (typeof fmt === 'string') media = _resolveConvertOutputMedia(media, fmt);
      }
    }
    return media;
  }

  /**
   * Whether the media a `compress` step at `uptoIndex` operates on is lossless audio.
   * Determined by the most recent preceding `convert` target (`flac`/`wav` -> lossless)
   * when there is one, else by the original input. Lossless is unaffected by the
   * video/ogg guard (ogg is never lossless either way).
   */
  private compressAudioLossless(uptoIndex?: number): boolean {
    if (uptoIndex !== undefined) {
      for (let i = uptoIndex - 1; i >= 0; i--) {
        const step = this.steps[i];
        if (step.opType === 'convert') {
          const fmt = step.options.output_format;
          return typeof fmt === 'string' ? _detectAudioLossless(`f.${fmt}`) : false;
        }
      }
    }
    if (this.input.kind === 'path') return _detectAudioLossless(this.input.path);
    if (this.input.kind === 'blob') return _detectAudioLossless(this.input.blob);
    return false;
  }
}

/**
 * Media of a `convert` step's output, given the media of its source. Reuses the
 * extension classifier on a synthetic `f.<format>`, with ONE guard: a video source
 * converted to `ogg` stays video (an OGG *video* container — `ogg` otherwise lands in
 * the audio extension list, which would mis-resolve a video output to audio). A video
 * source to `gif` is left as the classifier's `image` result (animated-GIF compress is
 * image-class). Per the 56N4chXY plan review (architect + karen).
 */
function _resolveConvertOutputMedia(
  source: PresetMedia | undefined,
  outputFormat: string,
): PresetMedia | undefined {
  if (source === 'video' && outputFormat.toLowerCase() === 'ogg') return 'video';
  return _detectCompressMedia(`f.${outputFormat}`);
}

// ── Watermark routing + planned-op gating (FF4a) ────────────────────────────

/**
 * The single SDK-side source of truth for which `(wire op, base mime)`
 * combinations the file-first `watermark()` verb may emit, and their
 * availability. The generated typed metadata sidecar does NOT carry the
 * supported-mime allowlist (`MimeGroupMetadata` has no `mimes` field and
 * `per_mime_availability` is empty for these ops), so this hand table is the
 * gate's source — PINNED to the generated `availability.json` by a conformance
 * test (mirrors the wire-key-conformance pattern): a contract regen that
 * changes the supported mimes or availability of `image_watermark` /
 * `video_watermark` fails that test. The gate reads ONLY this table.
 * @internal
 */
export const WATERMARK_CAPABILITY = {
  image_watermark: {
    image: { mimes: ['image/jpeg', 'image/png', 'image/webp'], availability: 'stable' },
    image_gif: { mimes: ['image/gif'], availability: 'planned' },
    image_tiff: { mimes: ['image/tiff'], availability: 'stable' },
    image_bmp: { mimes: ['image/bmp'], availability: 'stable' },
  },
  video_watermark: {
    video: { mimes: ['video/mp4', 'video/webm'], availability: 'beta' },
  },
} as const;

/** Wire op types the file-first `watermark()` verb can route to. */
export type WatermarkWireOp = 'image_watermark' | 'video_watermark';

const _WATERMARK_SHIPPABLE: ReadonlySet<string> = new Set(['stable', 'beta']);

// extension → canonical MIME for the watermark gate. Covers the supported
// formats PLUS common known-but-unsupported ones so the gate throws an
// actionable "unsupported subtype" rather than silently routing a format the
// server will reject.
const _WATERMARK_EXT_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', tif: 'image/tiff', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', m4v: 'video/x-m4v',
};

function _watermarkPathMime(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop();
  return ext !== undefined ? _WATERMARK_EXT_MIME[ext] : undefined;
}

/**
 * The watermark MIME of a base/overlay Blob. Mirrors `_detectCompressMedia`'s
 * mime-first-else-filename precedence: a declared `Blob.type` is used ONLY when
 * it is media-bearing (image/ video/ audio/ — params stripped, lowercased); a
 * generic/unknown type (e.g. `application/octet-stream`) falls back to the
 * `File.name` extension, so a filename-hinted in-memory base routes like a path.
 */
function _watermarkBlobMime(blob: Blob): string | undefined {
  const raw = blob.type ? blob.type.split(';')[0]!.trim().toLowerCase() : '';
  if (raw.startsWith('image/') || raw.startsWith('video/') || raw.startsWith('audio/')) {
    return raw;
  }
  return _watermarkPathMime((blob as { name?: string }).name ?? '');
}

/** The effective base of a watermark recipe AFTER folding its preceding steps. */
interface WatermarkBase {
  readonly media?: PresetMedia;
  readonly mime?: string;
}

/**
 * Resolve the effective `(media, mime)` a watermark op operates on, folding the
 * preceding `convert` (output media + format) AND `thumbnail` (always an image
 * output) steps — mirrors {@link Recipe.compressMediaHint}'s convert fold, plus
 * the thumbnail→image rule (codex review). Reused for the base and the overlay.
 */
function _watermarkEffectiveBase(
  input: FileInput,
  steps: readonly RecipeStep[],
): WatermarkBase {
  let media: PresetMedia | undefined =
    input.kind === 'path'
      ? _detectCompressMedia(input.path)
      : input.kind === 'blob'
        ? _detectCompressMedia(input.blob)
        : undefined;
  let mime: string | undefined =
    input.kind === 'path'
      ? _watermarkPathMime(input.path)
      : input.kind === 'blob'
        ? _watermarkBlobMime(input.blob)
        : undefined;
  for (const step of steps) {
    if (step.opType === 'convert') {
      const fmt = step.options.output_format;
      if (typeof fmt === 'string') {
        media = _resolveConvertOutputMedia(media, fmt);
        mime = _WATERMARK_EXT_MIME[fmt.toLowerCase()];
      }
    } else if (step.opType === 'thumbnail') {
      // A thumbnail of a video/PDF/image is always an image output.
      media = 'image';
      mime = 'image/png';
    }
  }
  // Recover the coarse media from a usable (already-normalised) mime when the
  // case-sensitive media classifier could not (e.g. an oddly-cased `Image/PNG`
  // content-type) — keeps the gate self-consistent: a usable mime implies media.
  if (media === undefined && mime !== undefined) {
    if (mime.startsWith('image/')) media = 'image';
    else if (mime.startsWith('video/')) media = 'video';
    else if (mime.startsWith('audio/')) media = 'audio';
  }
  return { media, mime };
}

/**
 * Resolve the wire op (`image_watermark` / `video_watermark`) for a watermark
 * base, or THROW {@link GislConfigError} pre-upload — the planned-op gate. The
 * capability is read from {@link WATERMARK_CAPABILITY} (data-driven, contract-
 * pinned): a base mime in a `{stable,beta}` group routes; a `planned` group
 * (animated GIF base) throws; a known image/video subtype outside the allowlist
 * (AVIF/HEIC/MOV/…) throws "unsupported"; audio/document throw "not supported".
 * An undetectable base media throws an actionable error (the caller defers the
 * eager check at `.watermark()` time and re-runs this pre-upload).
 */
function _resolveWatermarkWireOp(base: WatermarkBase): WatermarkWireOp {
  const { media, mime } = base;
  if (media === undefined) {
    throw new GislConfigError(
      "watermark needs a detectable base media to route to image_watermark / video_watermark, " +
        'but the input has no inferable type (a pre-uploaded file id or unnamed/typeless Blob carries ' +
        'no extension or MIME). Use a path with a file extension, a Blob with a type, or a named resource.',
      { reason: 'media_unknown' },
    );
  }
  if (mime !== undefined) {
    for (const wireOp of Object.keys(WATERMARK_CAPABILITY) as WatermarkWireOp[]) {
      const groups = WATERMARK_CAPABILITY[wireOp] as Record<string, { mimes: readonly string[]; availability: string }>;
      for (const group of Object.values(groups)) {
        if (group.mimes.includes(mime)) {
          if (_WATERMARK_SHIPPABLE.has(group.availability)) return wireOp;
          throw new GislConfigError(
            `watermark for ${mime} bases is not yet available (${wireOp} is '${group.availability}'). ` +
              'The contract schema is defined but the server returns feature_not_available until it ships.',
            { reason: 'feature_not_available' },
          );
        }
      }
    }
  }
  if (media === 'image' || media === 'video') {
    throw new GislConfigError(
      `watermark does not support ${mime ?? media} base files. image_watermark accepts ` +
        'image/jpeg, image/png, image/webp; video_watermark accepts video/mp4, video/webm. ' +
        'Convert the base to a supported format first.',
      { reason: 'unsupported_media' },
    );
  }
  throw new GislConfigError(
    `watermark does not support ${media} base files — overlay watermarking targets image or video bases ` +
      '(audio overlay and luma matte are planned operations). Use textWatermark() for document/text watermarks.',
    { reason: 'unsupported_media' },
  );
}

/**
 * Validate a watermark overlay locally: the overlay role is always an IMAGE.
 * A KNOWN non-image overlay (audio/video/document) throws pre-upload; an
 * undetectable overlay media is ALLOWED (it doesn't affect routing, so the
 * server enforces it). The overlay's effective media folds its own steps.
 */
function _validateWatermarkOverlay(overlay: Recipe): void {
  const { media } = _watermarkEffectiveBase(overlay.recipeInput, overlay.recipeSteps);
  if (media !== undefined && media !== 'image') {
    throw new GislConfigError(
      `watermark overlay must be an image; got a ${media} overlay. The overlay is the watermark image ` +
        'composited onto the base — pass an image file (or a recipe whose output is an image).',
      { reason: 'invalid_overlay_media', conflictingFields: ['overlay'] },
    );
  }
}

function _lowerWatermarkOp(wireOp: WatermarkWireOp, options: WatermarkOptions): OperationDef {
  // Watermark options (anchor/opacity/margin_x/margin_y/overlay_width, or the
  // multi-overlay overlays[] stack) are already wire keys; empty options omit
  // the `options` key (byte-identical to PHP).
  const wire = { ...options };
  return Object.keys(wire).length === 0 ? { type: wireOp } : { type: wireOp, options: wire };
}

/**
 * Shared multi-input upload-then-create tail for the multi-input recipes
 * ({@link FilesRecipe}, {@link MergedRecipe}, {@link ArchivedRecipe},
 * {@link WatermarkedRecipe}). Uploads each fresh input (passing through upload
 * progress), tracks the multipart-video uploads for the best-effort
 * probe-before-create, then builds the payload via `toPayload` and creates the
 * workflow. Abort + deadline are re-checked between every phase, exactly as the
 * per-recipe copies did before this was extracted (xxy5Rlsy).
 *
 * Recipe-specific behaviour stays with the caller: `validatePreUpload()` runs
 * BEFORE this call (Merged/Archived/Watermarked), and the input source
 * (`this.inputs` vs `this.inputsInOrder()`) plus the timeout-message nouns
 * (`uploadsLabel`/`workflowLabel`) are passed in so the thrown messages are
 * byte-identical to the originals.
 */
async function _uploadInputsAndCreate(
  client: GislClient,
  inputs: readonly FileInput[],
  toPayload: (fileIds: readonly string[], callbackUrl?: string) => WorkflowCreatePayload,
  opts: {
    webhook: string | undefined;
    deadline: number | undefined;
    onProgress?: (event: ProgressEvent) => void;
    signal?: AbortSignal;
    probeBeforeCreate?: boolean;
    probeTimeoutMs?: number;
    uploadsLabel: string;
    workflowLabel: string;
  },
): Promise<WorkflowCreateResponse> {
  const { webhook, deadline, onProgress, signal, probeBeforeCreate, probeTimeoutMs, uploadsLabel, workflowLabel } =
    opts;
  const fileIds: string[] = [];
  // Track each freshly-uploaded input's probe-gate inputs (a pre-uploaded id
  // carries no local mime/size, so it is excluded — never probed).
  const probeTargets: { fileId: string; isVideo: boolean; sizeBytes?: number }[] = [];
  for (const input of inputs) {
    // Fail fast between uploads — a deadline that elapses mid-batch should not
    // force every remaining input to upload before throwing.
    _checkAborted(signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        `maxWait elapsed during ${uploadsLabel} uploads before all inputs were uploaded`,
      );
    }
    if (input.kind === 'uploadId') {
      fileIds.push(input.fileId);
    } else {
      const source = input.kind === 'path' ? input.path : input.blob;
      const up = await client.uploadFile(source, {
        signal,
        ...(onProgress !== undefined
          ? {
              onProgress: (uploadedBytes: number, totalBytes: number): void => {
                onProgress({ phase: 'upload', uploadedBytes, totalBytes });
              },
            }
          : {}),
      });
      fileIds.push(up.fileId);
      probeTargets.push({
        fileId: up.fileId,
        isVideo: _detectCompressMedia(source) === 'video',
        sizeBytes: up.sizeBytes,
      });
    }
  }
  _checkAborted(signal);
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new GislTimeoutError(
      `Uploads completed but maxWait elapsed before ${workflowLabel} could be created`,
    );
  }
  // Best-effort probe-before-create for the multipart-video inputs. Run the
  // waits CONCURRENTLY (Promise.all): each is bounded by the SAME capped
  // timeout, so the aggregate wall-clock stays ~timeout rather than N×timeout.
  // The cap is the remaining maxWait budget so the waits cannot push
  // createWorkflow past the caller's deadline. Never-bounce, so a give-up just
  // proceeds.
  const cappedProbeTimeoutMs = _cappedProbeTimeoutMs(probeTimeoutMs, deadline);
  await Promise.all(
    probeTargets.map((t) =>
      client.maybeWaitForVideoProbe(t.fileId, {
        enabled: probeBeforeCreate ?? true,
        isVideo: t.isVideo,
        sizeBytes: t.sizeBytes,
        timeoutMs: cappedProbeTimeoutMs,
        signal,
      }),
    ),
  );
  // A cancel arriving during a FINAL successful probe request must not still
  // create the workflow (the probe waits return landed without a final abort
  // re-check), so check here BEFORE createWorkflow.
  _checkAborted(signal);
  // RE-CHECK the deadline AFTER the probe waits (they consume time).
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new GislTimeoutError(
      `Probe wait completed but maxWait elapsed before ${workflowLabel} could be created`,
    );
  }
  const created = await client.createWorkflow(toPayload(fileIds, webhook));
  _checkAborted(signal);
  return created;
}

/**
 * The homogeneous fan-out builder value (FF3a). `client.files([a, b, c])`
 * returns a `FilesRecipe`; the op-chain methods (`compress`, `convert`,
 * `thumbnail`, `textWatermark`) build ONE shared recipe (chain) that is applied
 * to EVERY input file in ONE workflow. `run()` returns a partitioned
 * {@link RunResult} — one `succeeded`/`failed` entry per input, keyed by its
 * 0-based index ("0", "1", …) so one bad input does not sink the rest.
 *
 * **Immutable / clone-on-write**, exactly like {@link Recipe}: every op returns
 * a NEW `FilesRecipe` carrying the appended step. The inputs are held as an
 * ORDERED list (NOT a map) so the per-file index is the partition key.
 *
 * **Lowering composes {@link Recipe} per file** rather than duplicating
 * `lowerStep`/`lowerCompressOptions`: for each input `i` it builds an internal
 * single-file `Recipe(input_i, …, steps)`, calls its `toWorkflowPayload` to get
 * that file's one-job payload, then merges all jobs into ONE
 * {@link WorkflowCreatePayload} with `jobs[i].id = "file-{i}"`. This preserves
 * each file's media-hint (different extensions per input resolve compress
 * presets independently).
 *
 * Exposes both `run()` (blocking, returns a partitioned {@link RunResult}) and
 * `submit(webhook?)` (fire-and-forget, returns a {@link Handle}). Mirrors the
 * PHP `FilesRecipe`.
 */
export class FilesRecipe {
  constructor(
    private readonly inputs: readonly FileInput[],
    private readonly steps: readonly RecipeStep[] = [],
    private readonly presetDefaults?: PresetDefaults,
    private readonly scopedPresetDefaults?: PresetDefaults,
    private readonly client?: GislClient,
  ) {}

  /**
   * Reduce file size on every input. `optimize` selects a per-media preset
   * (resolved per file at lower-time, so each input's extension picks its own
   * preset). Reuses {@link Recipe}'s validation — a directly-constructed
   * lowering builds an internal Recipe that throws the same `GislConfigError`.
   */
  compress(optimize?: OptimizeFor, options: Record<string, unknown> = {}): FilesRecipe {
    return this.withStep(this.baseRecipe().compress(optimize, options));
  }

  /** Change every input's format. `format` lowers to the contract `output_format` wire key (via {@link Recipe.convert}), NOT `format`. Option keys are validated (via the base {@link Recipe}) before any upload. */
  convert(format: string, options: ConvertOptions = {}): FilesRecipe {
    return this.withStep(this.baseRecipe().convert(format, options));
  }

  /** Generate a preview of every input. `width` AND `height` are required; validated via the base {@link Recipe} before any upload. */
  thumbnail(options: ThumbnailOptions): FilesRecipe {
    return this.withStep(this.baseRecipe().thumbnail(options));
  }

  /** Apply the same text watermark to every input. Option keys validated via the base {@link Recipe}. */
  textWatermark(text: string, options: TextWatermarkOptions = {}): FilesRecipe {
    return this.withStep(this.baseRecipe().textWatermark(text, options));
  }

  /**
   * Combine the inputs into ONE output (N→1), in array order (FF3b). Returns a
   * single-output {@link MergedRecipe} you chain further ops on
   * (`files([...]).merge().compress()`). Reuses the operation-first
   * {@link MergeOptions} for the merge-level options, so the wire shape matches
   * `client.merge([...], options)`.
   *
   * `merge()` must be the FIRST op on `files([...])` — per-file ops before a
   * combine (compress-each-then-merge) are a separate follow-up, rejected here
   * with `GislConfigError` reason `pre_merge_ops_unsupported`.
   */
  merge(options: MergeOptions = {}): MergedRecipe {
    if (this.steps.length !== 0) {
      throw new GislConfigError(
        'merge() must be the first operation on files([...]); applying per-file ops before a combine ' +
          '(compress-each-then-merge) is not yet supported — call merge() directly, then chain ops on the merged output.',
        { reason: 'pre_merge_ops_unsupported' },
      );
    }
    return new MergedRecipe(
      this.inputs,
      options,
      [],
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }

  /**
   * Bundle the inputs into ONE archive (N→1, zip / tar.gz) — media-agnostic,
   * inputs may mix types. Returns a terminal {@link ArchivedRecipe} (a zip is
   * the final artefact — no post-bundle chain). `format` / `folderStructure` are
   * optional; the server defaults to zip + flat.
   *
   * `archive()` must be the FIRST op on `files([...])` → `GislConfigError` reason
   * `pre_archive_ops_unsupported` otherwise.
   */
  archive(options: ArchiveRecipeOptions = {}): ArchivedRecipe {
    if (this.steps.length !== 0) {
      throw new GislConfigError(
        'archive() must be the first operation on files([...]); applying per-file ops before a bundle ' +
          'is not yet supported — call archive() directly on the files you want to bundle.',
        { reason: 'pre_archive_ops_unsupported' },
      );
    }
    return new ArchivedRecipe(this.inputs, options, this.client);
  }

  /** The number of inputs in this fan-out (introspection / tests). */
  get inputCount(): number {
    return this.inputs.length;
  }

  /** The number of operations chained so far (introspection / tests). */
  get stepCount(): number {
    return this.steps.length;
  }

  /**
   * Lower this fan-out to a single multi-job workflow-create payload against a
   * list of resolved upload ids (one per input, in input order). Each input `i`
   * becomes ONE job with `id = "file-{i}"`, its `source: upload(fileIds[i])`,
   * and the SHARED lowered `operations[]`. Composes the single-file
   * {@link Recipe.toWorkflowPayload} per file so per-file media-hints resolve
   * independently and lowering logic is not duplicated.
   *
   * @internal Consumed by {@link run} (after uploading all inputs) and the
   *   cross-language parity harness (with fixed ids). Not caller-facing.
   */
  toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload {
    const jobs: JobDefinitionPayload[] = this.inputs.map((input, i) => {
      const single = new Recipe(input, undefined, this.steps, this.presetDefaults, this.scopedPresetDefaults);
      const oneJob = single.toWorkflowPayload(fileIds[i]).jobs[0];
      // Key order (id, source, operations) matches the PHP `toWire()` so the
      // JSON-string serialisation is byte-identical across languages.
      return { id: `file-${i}`, source: oneJob.source, operations: oneJob.operations };
    });
    // When `callbackUrl` is given (the file-first `submit()` path) it is built
    // INTO the payload (`callback_url`) — mirrors Recipe.toWorkflowPayload.
    // `run()` passes no callbackUrl.
    return callbackUrl === undefined ? { jobs } : { jobs, callback_url: callbackUrl };
  }

  /**
   * Execute the fan-out end-to-end: upload EVERY input, create ONE workflow
   * with one job per input, await a terminal state (SSE with poll fallback),
   * then resolve the per-job downloads into a partitioned {@link RunResult}.
   * `partially_failed` is a NORMAL terminal state here — its successful jobs
   * land in `succeeded`, its failed jobs in `failed`.
   *
   * Requires a client bound at construction time — `gisl().files(...)` wires
   * it; a directly-constructed `FilesRecipe` throws {@link GislConfigError}.
   * Mirrors the single-file {@link Recipe.run}; see {@link submit} for the
   * fire-and-forget arm.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'FilesRecipe.run() requires a client; build the fan-out via gisl().files(...) rather than constructing FilesRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    // 1+2. Upload EVERY input + create ONE multi-job workflow. Shared with
    // submit() (which passes a webhook → callback_url and no deadline).
    const created = await this._uploadAllAndCreate(
      undefined,
      deadline,
      onProgress,
      signal,
      options.probeBeforeCreate,
      options.probeTimeoutMs,
    );

    // 3. Wait to terminal status — SSE first, poll on a genuine SSE error.
    // `partially_failed` is a normal terminal state here (the helper treats it
    // as terminal); only caller-aborted / deadline / API errors propagate.
    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    // 4. Fetch downloads + project per-job into the partitioned RunResult.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    // keyByRef maps each job ref ("file-{i}") to the partition key. Today the
    // key is just the index string; the Map seam leaves room for the FF3b
    // keyed-fan-out card to map refs to caller-supplied keys without changing
    // the producer's signature.
    const keyByRef = new Map<string, string | null>(
      this.inputs.map((_, i) => [`file-${i}`, String(i)]),
    );
    const downloader = new LazyHttpDownloader();
    return projectMultiJobToRunResult(
      created.workflowId,
      finalStatus,
      downloads.downloads,
      keyByRef,
      downloader,
    );
  }

  /**
   * Fire-and-forget the fan-out: upload every input, create ONE multi-job
   * workflow (wiring `webhook` into `callback_url` when given), and return a
   * client-bound {@link Handle}. Does NOT wait for terminal status — call
   * `handle.wait()` / `handle.result()` later to collect the partitioned
   * {@link RunResult}. The Handle detects the fan-out from the wire `file-{i}`
   * job refs, so per-file `byKey()` works even after a `client.workflow(id)`
   * reattach (the keys are the input indices `"0"`, `"1"`, …).
   *
   * Requires a client bound at construction time (same `no_client` guard as
   * {@link run}). `webhook` is OPTIONAL. Fire-and-forget, so NO whole-run
   * deadline (a multi-GB upload is bounded by the HTTP client's own timeout).
   * Mirrors the single-file {@link Recipe.submit}.
   *
   * @param webhook Absolute callback URL the server POSTs lifecycle events to.
   * @param options Opt-out / tune the best-effort video probe-before-create
   *   (2nd optional param so the positional `webhook` arg stays compatible).
   */
  async submit(
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'FilesRecipe.submit() requires a client; build the fan-out via gisl().files(...) rather than constructing FilesRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(
      webhook,
      undefined,
      undefined,
      undefined,
      options?.probeBeforeCreate,
      options?.probeTimeoutMs,
    );
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      null,
    );
  }

  /**
   * Upload every input (verbatim for a pre-uploaded id; uploading a path /
   * blob otherwise, emitting `{phase:'upload'}` progress) then create ONE
   * multi-job workflow (one job per input, `callback_url` built in when
   * `webhook` is given). Shared first half of {@link run} + {@link submit}.
   *
   * Uploads are sequential so progress events stay ordered and the abort
   * signal is honoured promptly; a resource arm is impossible in TS (Blob).
   * `run()` passes a whole-run deadline (a slow upload must not proceed to
   * createWorkflow past maxWait); `submit()` passes `undefined`, so the
   * deadline checks are skipped.
   */
  private async _uploadAllAndCreate(
    webhook: string | undefined,
    deadline: number | undefined,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    probeBeforeCreate?: boolean,
    probeTimeoutMs?: number,
  ): Promise<WorkflowCreateResponse> {
    return _uploadInputsAndCreate(
      this.client!,
      this.inputs,
      (fileIds, callbackUrl) => this.toWorkflowPayload(fileIds, callbackUrl),
      {
        webhook,
        deadline,
        onProgress,
        signal,
        probeBeforeCreate,
        probeTimeoutMs,
        uploadsLabel: 'fan-out',
        workflowLabel: 'workflow',
      },
    );
  }

  /**
   * The shared single-file {@link Recipe} that captures the op chain (input is
   * a placeholder — only the steps are read). Reuses Recipe's op-chain
   * validation + coercion so a `FilesRecipe.compress(bad)` throws the identical
   * `GislConfigError` as `Recipe.compress(bad)`.
   */
  private baseRecipe(): Recipe {
    // The placeholder input never reaches the wire (only `steps` are read off
    // the returned Recipe). A path placeholder gives compress() a media hint so
    // optimize validation matches the single-file path; per-file lowering in
    // toWorkflowPayload() rebuilds a Recipe with the REAL input.
    return new Recipe(
      this.inputs[0] ?? fileInput.path('placeholder'),
      undefined,
      this.steps,
      this.presetDefaults,
      this.scopedPresetDefaults,
    );
  }

  private withStep(recipeWithStep: Recipe): FilesRecipe {
    return new FilesRecipe(
      this.inputs,
      recipeWithStep.recipeSteps,
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }
}

/**
 * The single-output recipe you're in AFTER a fluent `files([...]).merge(...)`
 * (FF3b). Merge collapses the N inputs into ONE output, so the per-file ops
 * ({@link FilesRecipe.compress} etc.) no longer apply — instead this exposes the
 * SAME chain ops as the single-file {@link Recipe}, applied to the merged
 * result. `files([...]).merge().compress()` is the flagship case (example 14).
 *
 * **Lowering (one workflow):** each input is uploaded once and wrapped in its
 * own single-input `passthrough` source job (`src_N`); the `merge` job consumes
 * those via `job_output` inputs (array order = play order) and carries the merge
 * op FIRST in its `operations[]`, followed by any post-combine ops (compress /
 * convert / thumbnail) so they run on the merged output in the same job. The
 * merge-level wire options reuse {@link wireMergeOptions} so a fluent merge
 * lowers identically to the operation-first `client.merge()`.
 *
 * Immutable / clone-on-write like {@link Recipe} / {@link FilesRecipe}. Mirrors
 * the PHP `MergedRecipe` in `packages/php/src/FileFirst/MergedRecipe.php`.
 */
export class MergedRecipe {
  constructor(
    private readonly inputs: readonly FileInput[],
    private readonly mergeOptions: MergeOptions,
    private readonly postSteps: readonly RecipeStep[] = [],
    private readonly presetDefaults?: PresetDefaults,
    private readonly scopedPresetDefaults?: PresetDefaults,
    private readonly client?: GislClient,
  ) {}

  /** Reduce the merged output's size. See {@link Recipe.compress}. */
  compress(optimize?: OptimizeFor, options: Record<string, unknown> = {}): MergedRecipe {
    if (optimize !== undefined && !Object.values(OptimizeFor).includes(optimize)) {
      const allowed = Object.values(OptimizeFor).join(', ');
      throw new GislConfigError(
        `compress 'optimize' must be one of ${allowed}; got '${String(optimize)}'.`,
        { reason: 'invalid_optimize', conflictingFields: ['optimize'] },
      );
    }
    return this.withStep({
      opType: 'compress',
      options: { ...options, ...(optimize !== undefined ? { optimize } : {}) },
    });
  }

  /** Change the merged output's format. See {@link Recipe.convert}. Option keys validated pre-upload. */
  convert(format: string, options: ConvertOptions = {}): MergedRecipe {
    validateVerbOptions('convert', options);
    // Validation guarantees the bag carries neither `format` nor `output_format`.
    return this.withStep({ opType: 'convert', options: { ...options, output_format: format } });
  }

  /** Thumbnail the merged output. `width` AND `height` are required; validated pre-upload. */
  thumbnail(options: ThumbnailOptions): MergedRecipe {
    validateVerbOptions('thumbnail', options);
    assertThumbnailDimensions(options);
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) wire[key] = value;
    }
    return this.withStep({ opType: 'thumbnail', options: wire });
  }

  /**
   * Lower to the merge DAG: one `passthrough` source job per input + one
   * `merge` job whose `operations[]` is `[merge, ...post-combine ops]`. The
   * merge job's `inputs[]` consume the source jobs via `job_output` in input
   * (play) order.
   *
   * @internal Consumed by {@link run} (after uploading all inputs), {@link submit}
   *   (with a webhook), and the cross-language parity harness (with fixed ids).
   */
  toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload {
    const mediaKind = this.inferMediaKind();

    const sourceJobs: JobDefinitionPayload[] = [];
    const inputs: JobInputV2Payload[] = [];
    fileIds.forEach((fileId, i) => {
      const srcId = `src_${i}`;
      // Key order (id, source, operations) matches the PHP `toWire()` so the
      // JSON-string serialisation is byte-identical across languages.
      sourceJobs.push({ id: srcId, source: uploadSource(fileId), operations: [{ type: 'passthrough' }] });
      inputs.push({ source: jobOutputSource(srcId) });
    });

    const operations: OperationDef[] = [
      { type: 'merge', options: wireMergeOptions(this.mergeOptions, mediaKind) },
      ...this.lowerPostSteps(mediaKind),
    ];
    const mergeJob: JobDefinitionPayload = { id: 'merge', inputs, operations };

    const jobs = [...sourceJobs, mergeJob];
    return callbackUrl === undefined ? { jobs } : { jobs, callback_url: callbackUrl };
  }

  /** The number of inputs being combined (introspection / tests). */
  get inputCount(): number {
    return this.inputs.length;
  }

  /** The number of post-combine ops chained so far (introspection / tests). */
  get stepCount(): number {
    return this.postSteps.length;
  }

  /**
   * Execute end-to-end: upload every input, create the merge workflow, await a
   * terminal state (SSE with poll fallback), then resolve ONLY the merged output
   * into a {@link RunResult}. Throws {@link GislTimeoutError} on `maxWait`.
   *
   * Requires a client bound at construction time — `gisl().files(...).merge(...)`
   * wires it; a directly-constructed `MergedRecipe` throws {@link GislConfigError}.
   * Mirrors the single-file {@link Recipe.run}.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'MergedRecipe.run() requires a client; build the merge via gisl().files(...).merge(...) rather than constructing MergedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    const created = await this._uploadAllAndCreate(
      undefined,
      deadline,
      onProgress,
      signal,
      options.probeBeforeCreate,
      options.probeTimeoutMs,
    );

    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    // Project ONLY the merge job's output — the `src_*` passthrough jobs
    // re-expose the raw uploads, which are plumbing, not the deliverable
    // (mirrors the operation-first merge.ts `ref === 'merge'` filter + PHP).
    const mergeDownloads = downloads.downloads.filter((d) => d.ref === 'merge');
    const downloader = new LazyHttpDownloader();
    return projectDownloadsToRunResult(created.workflowId, finalStatus, mergeDownloads, null, downloader);
  }

  /**
   * Fire-and-forget: upload + create the merge workflow (wiring `webhook` into
   * `callback_url` when given), return a client-bound {@link Handle}. Does NOT
   * wait for terminal status. Mirrors {@link Recipe.submit}.
   *
   * @param webhook Absolute callback URL the server POSTs lifecycle events to.
   * @param options Opt-out / tune the best-effort video probe-before-create
   *   (2nd optional param so the positional `webhook` arg stays compatible).
   */
  async submit(
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'MergedRecipe.submit() requires a client; build the merge via gisl().files(...).merge(...) rather than constructing MergedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(
      webhook,
      undefined,
      undefined,
      undefined,
      options?.probeBeforeCreate,
      options?.probeTimeoutMs,
    );
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      null,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Upload every input (verbatim for a pre-uploaded id; uploading a path / blob
   * otherwise, emitting `{phase:'upload'}` progress) then create ONE merge
   * workflow. Rejects fewer than 2 inputs BEFORE any upload fires. Shared first
   * half of {@link run} + {@link submit}.
   */
  private async _uploadAllAndCreate(
    webhook: string | undefined,
    deadline: number | undefined,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    probeBeforeCreate?: boolean,
    probeTimeoutMs?: number,
  ): Promise<WorkflowCreateResponse> {
    this.validatePreUpload();
    return _uploadInputsAndCreate(
      this.client!,
      this.inputs,
      (fileIds, callbackUrl) => this.toWorkflowPayload(fileIds, callbackUrl),
      {
        webhook,
        deadline,
        onProgress,
        signal,
        probeBeforeCreate,
        probeTimeoutMs,
        uploadsLabel: 'merge',
        workflowLabel: 'the merge workflow',
      },
    );
  }

  /**
   * Reject an invalid combine BEFORE any upload fires — mirrors the operation-
   * first `MergeBuilder.planSequence()` bounds so a typo'd merge costs no
   * bandwidth: 2–10 inputs (merge schema `min/max_inputs`), and an image merge
   * must carry an explicit `output_type` (the server rejects image merges
   * without one). Shared by {@link run} + {@link submit} via
   * {@link _uploadAllAndCreate}.
   */
  private validatePreUpload(): void {
    if (this.inputs.length < 2) {
      throw new GislConfigError(
        `merge requires at least 2 inputs to combine (got ${this.inputs.length}).`,
        { reason: 'too_few_inputs' },
      );
    }
    if (this.inputs.length > 10) {
      throw new GislConfigError(
        `merge accepts at most 10 inputs (got ${this.inputs.length}). Split the merge or reduce the input list.`,
        { reason: 'too_many_inputs' },
      );
    }
    if (
      this.inferMediaKind() === 'image' &&
      this.mergeOptions.output === undefined &&
      this.mergeOptions.outputType === undefined
    ) {
      throw new GislConfigError(
        'image merges require an explicit output_type — set MergeOptions output: "video" | "gif" (or outputType). ' +
          'The server rejects image merge requests with no output_type.',
        { reason: 'image_merge_requires_output_type' },
      );
    }
  }

  /**
   * Lower the post-combine chain by composing a single-file {@link Recipe} over a
   * synthetic input whose extension matches the merged OUTPUT media — so
   * `compress(optimize)` resolves the correct preset for the merged result (it
   * needs a media hint, which a merge output carries no filename for). Reuses
   * Recipe's `lowerStep` rather than duplicating it.
   */
  private lowerPostSteps(mediaKind: MergeMediaKind): OperationDef[] {
    if (this.postSteps.length === 0) {
      return [];
    }
    const synthetic = fileInput.path(`merged.${this.outputExtensionFor(mediaKind)}`);
    const recipe = new Recipe(synthetic, undefined, this.postSteps, this.presetDefaults, this.scopedPresetDefaults);
    return recipe.toWorkflowPayload('merged').jobs[0].operations;
  }

  /**
   * The merged-output media. Honours an explicit {@link MergeOptions.mediaKind};
   * otherwise infers from the first PATH input's extension (mirrors
   * {@link MergeBuilder}); defaults to video.
   */
  private inferMediaKind(): MergeMediaKind {
    if (this.mergeOptions.mediaKind !== undefined) {
      return this.mergeOptions.mediaKind;
    }
    // Sniff the first input carrying a media signal — a path extension or a
    // Blob MIME type (mirrors the operation-first MergeBuilder.inferMediaKind,
    // codex c2). Pre-uploaded ids carry no signal, so they are skipped.
    for (const input of this.inputs) {
      if (input.kind === 'path') {
        const lower = input.path.toLowerCase();
        if (/\.(jpe?g|png|webp|avif|gif|heic|tiff?)$/.test(lower)) return 'image';
        if (/\.(mp3|wav|flac|aac|ogg|m4a)$/.test(lower)) return 'audio';
        return 'video';
      }
      if (input.kind === 'blob') {
        if (input.blob.type.startsWith('image/')) return 'image';
        if (input.blob.type.startsWith('audio/')) return 'audio';
        return 'video';
      }
    }
    return 'video';
  }

  private outputExtensionFor(mediaKind: MergeMediaKind): string {
    // An image merge produces a video/gif output (output_type), so the
    // post-combine media follows the output type when set.
    const output = this.mergeOptions.output ?? this.mergeOptions.outputType;
    if (mediaKind === 'image' && typeof output === 'string') {
      return output === 'gif' ? 'gif' : 'mp4';
    }
    switch (mediaKind) {
      case 'audio':
        return 'mp3';
      case 'image':
        return 'png';
      default:
        return 'mp4';
    }
  }

  private withStep(step: RecipeStep): MergedRecipe {
    return new MergedRecipe(
      this.inputs,
      this.mergeOptions,
      [...this.postSteps, step],
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }
}

/**
 * Options for a fluent `files([...]).archive(...)` bundle. Both fields are
 * optional — the server defaults `format` to `zip` and `folderStructure` to
 * `flat` (archive op schema). Mirrors the PHP `ArchivedRecipe` ctor params.
 */
export interface ArchiveRecipeOptions {
  /** Archive container format. */
  readonly format?: 'zip' | 'tar.gz';
  /** `flat` = all files at the top level; `by_job` = a subfolder per source. */
  readonly folderStructure?: 'flat' | 'by_job';
}

/**
 * The single-output recipe you're in AFTER a fluent `files([...]).archive(...)`
 * (FF3b). Archive bundles the N inputs into ONE downloadable archive (zip /
 * tar.gz) — media-agnostic, inputs may mix types. Unlike {@link MergedRecipe},
 * archive is TERMINAL: a zip is the final artefact, so there is no post-bundle
 * chain — this exposes only `run()` / `submit()`.
 *
 * **Lowering (one workflow):** each input is uploaded once and wrapped in its
 * own single-input `passthrough` source job (`src_N`); the `archive` job
 * consumes those via `job_output` inputs (array order = entry order) and carries
 * the single `archive` op. The archive job's id is `archive`, so {@link RunResult}
 * projects ONLY its output. Mirrors the PHP `ArchivedRecipe`.
 */
export class ArchivedRecipe {
  constructor(
    private readonly inputs: readonly FileInput[],
    private readonly options: ArchiveRecipeOptions = {},
    private readonly client?: GislClient,
  ) {}

  /** The number of inputs being bundled (introspection / tests). */
  get inputCount(): number {
    return this.inputs.length;
  }

  /**
   * Lower to the archive DAG: one `passthrough` source job per input + one
   * `archive` job consuming them via `job_output`.
   *
   * @internal Consumed by {@link run} / {@link submit} (after uploading) and the
   *   cross-language parity harness (with fixed ids).
   */
  toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload {
    const sourceJobs: JobDefinitionPayload[] = [];
    const inputs: JobInputV2Payload[] = [];
    fileIds.forEach((fileId, i) => {
      const srcId = `src_${i}`;
      sourceJobs.push({ id: srcId, source: uploadSource(fileId), operations: [{ type: 'passthrough' }] });
      inputs.push({ source: jobOutputSource(srcId) });
    });

    const archiveJob: JobDefinitionPayload = {
      id: 'archive',
      inputs,
      operations: [{ type: 'archive', options: this.wireArchiveOptions() }],
    };

    const jobs = [...sourceJobs, archiveJob];
    return callbackUrl === undefined ? { jobs } : { jobs, callback_url: callbackUrl };
  }

  /**
   * Execute end-to-end: upload every input, create the archive workflow, await a
   * terminal state (SSE with poll fallback), then resolve ONLY the archive output
   * into a {@link RunResult}. Throws {@link GislTimeoutError} on `maxWait`.
   * Requires a client bound via `gisl().files(...).archive(...)`.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'ArchivedRecipe.run() requires a client; build the bundle via gisl().files(...).archive(...) rather than constructing ArchivedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    const created = await this._uploadAllAndCreate(
      undefined,
      deadline,
      onProgress,
      signal,
      options.probeBeforeCreate,
      options.probeTimeoutMs,
    );

    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    // Project ONLY the archive job's output — the `src_*` passthrough jobs
    // re-expose the raw uploads, which are plumbing, not the deliverable.
    const archiveDownloads = downloads.downloads.filter((d) => d.ref === 'archive');
    const downloader = new LazyHttpDownloader();
    return projectDownloadsToRunResult(created.workflowId, finalStatus, archiveDownloads, null, downloader);
  }

  /**
   * Fire-and-forget: upload + create the archive workflow (wiring `webhook` into
   * `callback_url` when given), return a client-bound {@link Handle}. Mirrors
   * {@link MergedRecipe.submit}.
   *
   * @param webhook Absolute callback URL the server POSTs lifecycle events to.
   * @param options Opt-out / tune the best-effort video probe-before-create
   *   (2nd optional param so the positional `webhook` arg stays compatible).
   */
  async submit(
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'ArchivedRecipe.submit() requires a client; build the bundle via gisl().files(...).archive(...) rather than constructing ArchivedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(
      webhook,
      undefined,
      undefined,
      undefined,
      options?.probeBeforeCreate,
      options?.probeTimeoutMs,
    );
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      null,
    );
  }

  // ---------------------------------------------------------------------------

  private async _uploadAllAndCreate(
    webhook: string | undefined,
    deadline: number | undefined,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    probeBeforeCreate?: boolean,
    probeTimeoutMs?: number,
  ): Promise<WorkflowCreateResponse> {
    this.validatePreUpload();
    return _uploadInputsAndCreate(
      this.client!,
      this.inputs,
      (fileIds, callbackUrl) => this.toWorkflowPayload(fileIds, callbackUrl),
      {
        webhook,
        deadline,
        onProgress,
        signal,
        probeBeforeCreate,
        probeTimeoutMs,
        uploadsLabel: 'archive',
        workflowLabel: 'the archive workflow',
      },
    );
  }

  /**
   * Reject an invalid bundle BEFORE any upload fires — the archive schema allows
   * 2–50 inputs (`min/max_inputs`), so a typo'd bundle costs no bandwidth.
   */
  private validatePreUpload(): void {
    if (this.inputs.length < 2) {
      throw new GislConfigError(
        `archive requires at least 2 inputs to bundle (got ${this.inputs.length}).`,
        { reason: 'too_few_inputs' },
      );
    }
    if (this.inputs.length > 50) {
      throw new GislConfigError(
        `archive accepts at most 50 inputs (got ${this.inputs.length}). Split the bundle or reduce the input list.`,
        { reason: 'too_many_inputs' },
      );
    }
  }

  /**
   * Project the archive options into the wire shape. Both fields are optional
   * (the server defaults `format` to zip and `folder_structure` to flat), so an
   * omitted option is dropped rather than sent.
   */
  private wireArchiveOptions(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.options.format !== undefined) out.format = this.options.format;
    if (this.options.folderStructure !== undefined) out.folder_structure = this.options.folderStructure;
    return out;
  }
}

/**
 * The single-output recipe you're in AFTER `file(base).watermark(overlay, …)`
 * (FF4a). Composites an image OVERLAY onto the base (image_watermark for image
 * bases, video_watermark for video bases — routed at lowering by the base's
 * effective media). A multi-input op: base + overlay each enter via their own
 * `passthrough` source job (`src_0` base, `src_1` overlay; their own preceding
 * steps lower into those jobs), and the `watermark` job consumes them via
 * `job_output` inputs tagged `role: base` / `role: overlay`. Post-watermark
 * `compress`/`convert`/`thumbnail` chain onto the watermark output. Mirrors
 * {@link MergedRecipe}. `textWatermark` is intentionally NOT a post-verb here.
 */
export class WatermarkedRecipe {
  constructor(
    private readonly baseInput: FileInput,
    private readonly baseSteps: readonly RecipeStep[],
    private readonly overlay: Recipe,
    private readonly watermarkOptions: WatermarkOptions,
    private readonly postSteps: readonly RecipeStep[] = [],
    private readonly presetDefaults?: PresetDefaults,
    private readonly scopedPresetDefaults?: PresetDefaults,
    private readonly client?: GislClient,
  ) {}

  /** Reduce the watermarked output's size. See {@link Recipe.compress}. */
  compress(optimize?: OptimizeFor, options: Record<string, unknown> = {}): WatermarkedRecipe {
    if (optimize !== undefined && !Object.values(OptimizeFor).includes(optimize)) {
      const allowed = Object.values(OptimizeFor).join(', ');
      throw new GislConfigError(
        `compress 'optimize' must be one of ${allowed}; got '${String(optimize)}'.`,
        { reason: 'invalid_optimize', conflictingFields: ['optimize'] },
      );
    }
    return this.withStep({
      opType: 'compress',
      options: { ...options, ...(optimize !== undefined ? { optimize } : {}) },
    });
  }

  /** Change the watermarked output's format. See {@link Recipe.convert}. Option keys validated pre-upload. */
  convert(format: string, options: ConvertOptions = {}): WatermarkedRecipe {
    validateVerbOptions('convert', options);
    // Validation guarantees the bag carries neither `format` nor `output_format`.
    return this.withStep({ opType: 'convert', options: { ...options, output_format: format } });
  }

  /** Thumbnail the watermarked output. `width` AND `height` are required; validated pre-upload. */
  thumbnail(options: ThumbnailOptions): WatermarkedRecipe {
    validateVerbOptions('thumbnail', options);
    assertThumbnailDimensions(options);
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) wire[key] = value;
    }
    return this.withStep({ opType: 'thumbnail', options: wire });
  }

  /**
   * Lower to the watermark DAG: a `src_0` passthrough/base-steps job + a `src_1`
   * passthrough/overlay-steps job + one `watermark` job whose `inputs[]` consume
   * them via `job_output` (role base/overlay) and whose `operations[]` is
   * `[image_watermark|video_watermark, ...post-watermark ops]`. `fileIds` is
   * `[baseId, overlayId]` (upload order). Throws pre-lowering if the base media
   * is undetectable/unsupported (the planned-op gate).
   *
   * @internal Consumed by {@link run}/{@link submit} (after upload) + the parity harness.
   */
  toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload {
    const wireOp = _resolveWatermarkWireOp(_watermarkEffectiveBase(this.baseInput, this.baseSteps));
    const baseId = fileIds[0];
    const overlayId = fileIds[1];

    // src_0: the base (its preceding steps, else a lossless passthrough).
    const baseOps: OperationDef[] =
      this.baseSteps.length > 0
        ? new Recipe(this.baseInput, undefined, this.baseSteps, this.presetDefaults, this.scopedPresetDefaults)
            .toWorkflowPayload(baseId).jobs[0].operations
        : [{ type: 'passthrough' }];
    // src_1: the overlay recipe (its own steps, else a lossless passthrough).
    const overlayOps: OperationDef[] =
      this.overlay.recipeSteps.length > 0
        ? this.overlay.toWorkflowPayload(overlayId).jobs[0].operations
        : [{ type: 'passthrough' }];

    // Key order (id, source, operations) matches PHP toWire() — byte-identical JSON.
    const srcBase: JobDefinitionPayload = { id: 'src_0', source: uploadSource(baseId), operations: baseOps };
    const srcOverlay: JobDefinitionPayload = { id: 'src_1', source: uploadSource(overlayId), operations: overlayOps };

    const inputs: JobInputV2Payload[] = [
      { source: jobOutputSource('src_0'), role: 'base' },
      { source: jobOutputSource('src_1'), role: 'overlay' },
    ];
    const operations: OperationDef[] = [
      _lowerWatermarkOp(wireOp, this.watermarkOptions),
      ...this.lowerPostSteps(wireOp),
    ];
    const watermarkJob: JobDefinitionPayload = { id: 'watermark', inputs, operations };

    const jobs = [srcBase, srcOverlay, watermarkJob];
    return callbackUrl === undefined ? { jobs } : { jobs, callback_url: callbackUrl };
  }

  /** The number of post-watermark ops chained so far (introspection / tests). */
  get stepCount(): number {
    return this.postSteps.length;
  }

  /**
   * Execute end-to-end: upload base + overlay, create the watermark workflow,
   * await terminal (SSE with poll fallback), then resolve ONLY the watermark
   * output into a {@link RunResult}. Requires a client bound at construction.
   * Mirrors {@link MergedRecipe.run}.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'WatermarkedRecipe.run() requires a client; build the watermark via gisl().file(...).watermark(...) rather than constructing WatermarkedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    const created = await this._uploadAllAndCreate(
      undefined,
      deadline,
      onProgress,
      signal,
      options.probeBeforeCreate,
      options.probeTimeoutMs,
    );

    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    // Project ONLY the watermark job's output — the `src_*` passthrough jobs
    // re-expose the raw base/overlay uploads, which are plumbing.
    const watermarkDownloads = downloads.downloads.filter((d) => d.ref === 'watermark');
    const downloader = new LazyHttpDownloader();
    return projectDownloadsToRunResult(created.workflowId, finalStatus, watermarkDownloads, null, downloader);
  }

  /**
   * Fire-and-forget: upload base + overlay + create the watermark workflow
   * (wiring `webhook` into `callback_url` when given), return a client-bound
   * {@link Handle}. Does NOT wait for terminal status. Mirrors {@link MergedRecipe.submit}.
   */
  async submit(
    webhook?: string,
    options?: { probeBeforeCreate?: boolean; probeTimeoutMs?: number },
  ): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'WatermarkedRecipe.submit() requires a client; build the watermark via gisl().file(...).watermark(...) rather than constructing WatermarkedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(
      webhook,
      undefined,
      undefined,
      undefined,
      options?.probeBeforeCreate,
      options?.probeTimeoutMs,
    );
    return new Handle(
      created.workflowId,
      created.webhookSecret != null ? created.webhookSecret : undefined,
      this.client,
      null,
    );
  }

  // ---------------------------------------------------------------------------

  /** Base + overlay inputs, in upload/lowering order (`[base, overlay]`). */
  private inputsInOrder(): readonly FileInput[] {
    return [this.baseInput, this.overlay.recipeInput];
  }

  /**
   * Validate the watermark BEFORE any upload: the base must route to a shippable
   * wire op (throws for undetectable/unsupported/planned bases), and the overlay
   * must be an image. Shared by {@link run}/{@link submit}. Mirrors
   * {@link MergedRecipe.validatePreUpload}.
   */
  private validatePreUpload(): void {
    _resolveWatermarkWireOp(_watermarkEffectiveBase(this.baseInput, this.baseSteps));
    _validateWatermarkOverlay(this.overlay);
  }

  /**
   * Upload base + overlay (verbatim for a pre-uploaded id; uploading a path /
   * blob otherwise) then create ONE watermark workflow. Validates pre-upload.
   * Shared first half of {@link run} + {@link submit}; mirrors
   * {@link MergedRecipe._uploadAllAndCreate}.
   */
  private async _uploadAllAndCreate(
    webhook: string | undefined,
    deadline: number | undefined,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    probeBeforeCreate?: boolean,
    probeTimeoutMs?: number,
  ): Promise<WorkflowCreateResponse> {
    this.validatePreUpload();
    return _uploadInputsAndCreate(
      this.client!,
      this.inputsInOrder(),
      (fileIds, callbackUrl) => this.toWorkflowPayload(fileIds, callbackUrl),
      {
        webhook,
        deadline,
        onProgress,
        signal,
        probeBeforeCreate,
        probeTimeoutMs,
        uploadsLabel: 'watermark',
        workflowLabel: 'the watermark workflow',
      },
    );
  }

  /**
   * Lower the post-watermark chain over a synthetic input whose extension
   * matches the watermark OUTPUT media (image→png, video→mp4) so
   * `compress(optimize)` resolves the correct preset — mirrors
   * {@link MergedRecipe.lowerPostSteps}.
   */
  private lowerPostSteps(wireOp: WatermarkWireOp): OperationDef[] {
    if (this.postSteps.length === 0) {
      return [];
    }
    const ext = wireOp === 'video_watermark' ? 'mp4' : 'png';
    const synthetic = fileInput.path(`watermarked.${ext}`);
    const recipe = new Recipe(synthetic, undefined, this.postSteps, this.presetDefaults, this.scopedPresetDefaults);
    return recipe.toWorkflowPayload('watermarked').jobs[0].operations;
  }

  private withStep(step: RecipeStep): WatermarkedRecipe {
    return new WatermarkedRecipe(
      this.baseInput,
      this.baseSteps,
      this.overlay,
      this.watermarkOptions,
      [...this.postSteps, step],
      this.presetDefaults,
      this.scopedPresetDefaults,
      this.client,
    );
  }
}

/**
 * Identity key for batch cross-entry upload dedupe — mirrors the merge
 * builder's `assetIdentity` (`merge.ts`). Two batch entries whose inputs share
 * an identity upload ONCE and point both jobs at the shared fileId. `path` uses
 * the EXACT caller-provided string (no trim / normalise / case-fold, so
 * `'./a.jpg'` and `'/abs/a.jpg'` do NOT dedupe — by design); `blob` uses
 * referential identity via a run-local token map (two distinct-but-equal Blobs
 * still upload twice); `uploadId` uses the fileId itself (already upload-free,
 * so deduping it is a pure no-op). `blobTokens` is threaded in so a single
 * planning pass shares one token space.
 */
function inputIdentity(input: FileInput, blobTokens: Map<Blob, number>): string {
  switch (input.kind) {
    case 'path':
      return `path:${input.path}`;
    case 'uploadId':
      return `id:${input.fileId}`;
    case 'blob': {
      let token = blobTokens.get(input.blob);
      if (token === undefined) {
        token = blobTokens.size;
        blobTokens.set(input.blob, token);
      }
      return `blob:${token}`;
    }
  }
}

/**
 * The keyed multi-recipe batch builder (FF7 / MFaCjL8d). `client.batch([r1, r2, …])`
 * runs N DISTINCT single-input keyed {@link Recipe}s as ONE workflow; the
 * partitioned {@link RunResult} addresses each entry's outputs by the caller key
 * given at `client.file(input, key)` time (`res.byKey('hero')`), and one failed
 * entry lands in `failed` without sinking the rest.
 *
 * **v1 scope (locked):** `.run()` only (no `submit()` / reattach — a follow-up);
 * single-input {@link Recipe} entries only — the multi-input builders
 * ({@link FilesRecipe}, {@link MergedRecipe}, {@link WatermarkedRecipe},
 * {@link ArchivedRecipe}) are REJECTED pre-upload. Cross-entry upload dedupe
 * IS applied (1LwSJcz1): two entries sourcing the SAME input (by
 * {@link inputIdentity}) upload ONCE and share the resulting fileId —
 * correctness-neutral (same bytes → same per-job output), it only elides
 * redundant uploads. Observable caveat: `onProgress` upload-phase events drop
 * to one-per-UNIQUE input rather than one-per-entry.
 *
 * **Lowering (one workflow):** for each entry `i`, lower its single job via
 * {@link Recipe.toWorkflowPayload} and re-id it `b{i}` — a POSITIONAL namespace
 * DISTINCT from the fan-out `file-{i}` / merge-archive-watermark `src_{i}` refs so
 * a future reattach can't misdetect the wire as a fan-out / merge. `keyByRef`
 * maps each `b{i}` ref to that entry's caller key, so
 * {@link projectMultiJobToRunResult} partitions per entry (1 job ↔ 1 key:
 * `completed` → `succeeded`, else → `failed` with a {@link GislItemFailedError}).
 *
 * **Immutability:** the ctor is CLIENT-ONLY (the ordered entries + the client) —
 * entries are already-built Recipes that captured their own preset defaults at
 * `client.file(...)` time, so batch never re-plumbs
 * presetDefaults/scopedPresetDefaults. Mirrors the PHP `BatchRecipe`.
 */
export class BatchRecipe {
  private readonly recipes: readonly Recipe[];

  constructor(recipes: ReadonlyArray<Recipe>, private readonly client?: GislClient) {
    // DEFENSIVE COPY (TS-only): snapshot the caller's array so a later mutation
    // of it (splice/push after construction, or during an in-flight run()) can't
    // desync the uploaded fileIds from the lowered jobs/keys — validation,
    // upload, lowering + keyByRef all iterate this frozen order. PHP is
    // value-semantics-safe already (arrays copy on pass).
    this.recipes = [...recipes];
  }

  /**
   * Execute the batch end-to-end: validate + lowering-preflight EVERY entry
   * BEFORE any upload, upload each entry's input, create ONE multi-job workflow
   * (one `b{i}` job per entry), await a terminal state (SSE with poll fallback,
   * honouring `useSSE`), then partition the per-job downloads into a keyed
   * {@link RunResult}. `partially_failed` is a NORMAL terminal state here — the
   * completed entries land in `succeeded`, the rest in `failed`.
   *
   * Requires a client bound at construction time — `gisl().batch([...])` wires
   * it; a directly-constructed {@link BatchRecipe} (e.g. a lowering-only test)
   * throws {@link GislConfigError}. Mirrors the fan-out {@link FilesRecipe.run}.
   */
  async run(
    options: {
      maxWait?: string | number;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
      /** Force the poll fallback instead of attempting SSE. Default true (SSE-first, poll fallback). */
      useSSE?: boolean;
      pollIntervalMs?: number;
      probeBeforeCreate?: boolean;
      probeTimeoutMs?: number;
    } = {},
  ): Promise<RunResult> {
    const signal = options.signal;
    const onProgress = options.onProgress;
    if (this.client === undefined) {
      throw new GislConfigError(
        'BatchRecipe.run() requires a client; build the batch via gisl().batch([...]) rather than constructing BatchRecipe directly.',
        { reason: 'no_client' },
      );
    }

    // Validate + lowering-preflight EVERY entry BEFORE any upload: a structural
    // violation (bad type / missing / duplicate key) or an invalid lowering
    // aborts here so no input uploads. NOTE — like FilesRecipe, TS does NOT
    // pre-check path readability: a nonexistent/unreadable path surfaces INSIDE
    // uploadFile during upload, so an earlier entry's input may already be
    // uploaded when a later entry's path fails. (PHP pre-checks path/resource
    // uploadability; this TS/PHP difference mirrors each language's existing
    // FilesRecipe behavior and is intentionally NOT closed here — a TS
    // path-precheck would diverge batch from FilesRecipe.)
    this.validatePreUpload();

    const deadline = Date.now() + _parseMaxWait(options.maxWait ?? 300_000);

    // 1+2. Upload each entry's input + create ONE multi-job workflow. batch v1
    // sends NO webhook (run()-only), so `callback_url` is omitted from the
    // payload (the closure receives `callbackUrl` undefined).
    // Dedupe cross-entry uploads: collapse to the first-appearance-unique input
    // list, upload each unique input ONCE, then expand the returned unique
    // fileIds back to one-per-entry (in entry order) so the b{i} jobs + keyByRef
    // stay N-length and correctness-neutral. See planUploads / inputIdentity.
    const { uniqueInputs, entryToUnique } = this.planUploads();
    const created = await _uploadInputsAndCreate(
      this.client,
      uniqueInputs,
      (uniqueFileIds, callbackUrl) =>
        this.toWorkflowPayload(
          entryToUnique.map((u) => uniqueFileIds[u]),
          callbackUrl,
        ),
      {
        webhook: undefined,
        deadline,
        onProgress,
        signal,
        probeBeforeCreate: options.probeBeforeCreate,
        probeTimeoutMs: options.probeTimeoutMs,
        uploadsLabel: 'batch',
        workflowLabel: 'the batch workflow',
      },
    );

    // 3. Wait to terminal status — SSE first, poll on a genuine SSE error (or
    // poll-direct when `useSSE: false`). Caller-aborted + deadline errors
    // propagate (not transient) — see _awaitTerminal.
    const finalStatus = await _awaitTerminal(this.client, {
      workflowId: created.workflowId,
      deadline,
      signal,
      onProgress,
      pollIntervalMs: options.pollIntervalMs,
      useSSE: options.useSSE ?? true,
    });

    // 4. Fetch downloads + project per-job into the keyed RunResult.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await this.client.getWorkflowDownloads(created.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait deadline.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }

    const downloader = new LazyHttpDownloader();
    return projectMultiJobToRunResult(
      created.workflowId,
      finalStatus,
      downloads.downloads,
      this.keyByRef(),
      downloader,
    );
  }

  /**
   * Lower the batch to ONE multi-job workflow-create payload against a list of
   * resolved upload ids (one per entry, in entry order). Each entry `i` becomes
   * ONE job re-id'd `b{i}` carrying that entry's lowered `source` + `operations`.
   * Composes the single-file {@link Recipe.toWorkflowPayload} per entry so each
   * keeps its own media-hint + preset resolution and lowering logic is not
   * duplicated. `callback_url` is built in ONLY when a webhook is supplied
   * (batch v1 run() supplies none, so it is omitted).
   *
   * @internal Consumed by {@link run} (after uploading) and the cross-language
   *   golden-payload lowering test (with fixed ids). Not caller-facing.
   */
  toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload {
    const jobs: JobDefinitionPayload[] = this.recipes.map((entry, i) => {
      const oneJob = entry.toWorkflowPayload(fileIds[i]).jobs[0];
      // Positional id `b{i}` — a namespace DISTINCT from the fan-out `file-{i}` /
      // merge `src_{i}` refs. Key order (id, source, operations) matches the PHP
      // `toWire()` so the JSON serialisation is byte-identical across languages.
      return { id: `b${i}`, source: oneJob.source, operations: oneJob.operations };
    });
    return callbackUrl === undefined ? { jobs } : { jobs, callback_url: callbackUrl };
  }

  /** The number of recipe entries in this batch (introspection / tests). */
  get recipeCount(): number {
    return this.recipes.length;
  }

  // ---------------------------------------------------------------------------

  /**
   * Validate the batch AND lowering-preflight every entry BEFORE any upload
   * fires — an invalid entry costs no bandwidth. TWO PASSES (mirrors PHP
   * `BatchRecipe`'s structural-loop-then-preflight-loop), throwing
   * {@link GislConfigError}:
   *  0. empty batch → `no_recipes` (checked first).
   *  PASS 1 (structural, ALL entries in order):
   *    - a KNOWN multi-input builder (checked FIRST — they do NOT extend
   *      {@link Recipe}, so the not-a-Recipe catch-all would otherwise misreport
   *      them as plain type errors) → `multi_input_recipe_unsupported`;
   *    - a non-{@link Recipe} entry → `invalid_recipe`;
   *    - a missing/empty key → `missing_key`;
   *    - a duplicate key → `duplicate_key`.
   *  PASS 2 (lowering preflight, ALL entries): lower each entry (via
   *    {@link Recipe.toWorkflowPayload}) so an invalid lowering throws BEFORE any
   *    upload, mirroring what {@link FilesRecipe} lowers pre-create.
   *
   * Two passes so a batch with MULTIPLE distinct violations throws the SAME
   * reason regardless of entry order (a structural error anywhere wins over a
   * lowering error elsewhere) — converging TS + PHP error reporting. The
   * offending key/index rides the MESSAGE (not `conflictingFields`, which is
   * reserved for wire FIELD names).
   */
  private validatePreUpload(): void {
    if (this.recipes.length === 0) {
      throw new GislConfigError(
        'batch() requires at least one recipe. Pass an ordered array of ' +
          'client.file(input, key).<op>(...) recipes, each with a unique key.',
        { reason: 'no_recipes' },
      );
    }
    // PASS 1 — structural checks across ALL entries in order.
    const seenKeys = new Set<string>();
    this.recipes.forEach((rawEntry, i) => {
      // Treat each entry as unknown for the runtime type guards: the public
      // signature is ReadonlyArray<Recipe>, but a plain-JS caller can pass
      // anything, and the multi-input builders are structurally Recipe-adjacent.
      const entry: unknown = rawEntry;
      // ORDER MATTERS (codex r2 #1): check the KNOWN multi-input builders FIRST.
      // They do NOT extend Recipe, so the not-a-Recipe catch-all below would
      // otherwise misreport them as plain caller type errors.
      if (
        entry instanceof FilesRecipe ||
        entry instanceof MergedRecipe ||
        entry instanceof WatermarkedRecipe ||
        entry instanceof ArchivedRecipe
      ) {
        throw new GislConfigError(
          `batch() entry at index ${i} is a multi-input recipe (${entry.constructor.name}), ` +
            'which is not supported in batch v1 — batch accepts only single-input keyed recipes ' +
            '(client.file(input, key).<op>(...)). Run the multi-input recipe on its own.',
          { reason: 'multi_input_recipe_unsupported' },
        );
      }
      // THEN the catch-all: not a Recipe at all (null / string / plain object).
      if (!(entry instanceof Recipe)) {
        throw new GislConfigError(
          `batch() entry at index ${i} is not a recipe. Build each entry via ` +
            'client.file(input, key).<op>(...) before passing it to batch().',
          { reason: 'invalid_recipe' },
        );
      }
      // Keys are the result address → each entry needs a unique, non-empty key.
      const key = entry.key();
      if (key === undefined || key === '') {
        throw new GislConfigError(
          `batch() entry at index ${i} has no key. Every batch entry needs a unique non-empty key ` +
            "(client.file(input, 'key')) to address its result.",
          { reason: 'missing_key' },
        );
      }
      if (seenKeys.has(key)) {
        throw new GislConfigError(
          `batch() has a duplicate key '${key}' (entry at index ${i}). Every batch entry needs a unique key.`,
          { reason: 'duplicate_key' },
        );
      }
      seenKeys.add(key);
    });
    // PASS 2 — lowering preflight across ALL entries (each is now known to be a
    // Recipe). Lower each entry now so an invalid lowering (e.g. an undetectable
    // input + optimize, an unrepresentable output route) throws BEFORE any
    // upload. The 'preflight' id is a throwaway placeholder — run() re-lowers
    // against the real upload ids post-upload.
    this.recipes.forEach((entry) => {
      entry.toWorkflowPayload('preflight');
    });
  }

  /**
   * Collapse the entry inputs to a first-appearance-unique list for cross-entry
   * upload dedupe: two entries sourcing the SAME input (by {@link inputIdentity})
   * upload ONCE and share the fileId. Returns the ordered `uniqueInputs` plus an
   * `entryToUnique` index map (length N, entry order) so {@link run} can expand
   * the unique fileIds back to one-per-entry before {@link toWorkflowPayload} —
   * keeping the b{i} refs + {@link keyByRef} N-length and correctness-neutral.
   */
  private planUploads(): { uniqueInputs: FileInput[]; entryToUnique: number[] } {
    const blobTokens = new Map<Blob, number>();
    const identityToUnique = new Map<string, number>();
    const uniqueInputs: FileInput[] = [];
    const entryToUnique = this.recipes.map((entry) => {
      const input = entry.recipeInput;
      const id = inputIdentity(input, blobTokens);
      let uniqueIndex = identityToUnique.get(id);
      if (uniqueIndex === undefined) {
        uniqueIndex = uniqueInputs.length;
        uniqueInputs.push(input);
        identityToUnique.set(id, uniqueIndex);
      }
      return uniqueIndex;
    });
    return { uniqueInputs, entryToUnique };
  }

  /** Map each `b{i}` job ref to that entry's caller key (validated non-empty). */
  private keyByRef(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    this.recipes.forEach((entry, i) => {
      map.set(`b${i}`, entry.key() ?? null);
    });
    return map;
  }
}
