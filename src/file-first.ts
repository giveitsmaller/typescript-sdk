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

import { GislConfigError, GislNetworkError, GislNoSuchKeyError, GislSinkError, GislTimeoutError, SseEndedWithoutTerminal } from './errors.js';
import {
  _detectCompressMedia,
  _detectAudioLossless,
  _consumeSseToTerminal,
  _pollToTerminal,
  _parseMaxWait,
  _checkAborted,
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
 * One failed entry in {@link RunResult.failed}: an input that did not
 * produce a deliverable, paired with the cause. One bad input does not sink
 * the rest of a multi-input run. `error` is `unknown` (mirroring the PHP
 * `\Throwable`) so the caller narrows with `instanceof`. Mirrors the PHP
 * `ItemFailure`.
 */
export interface ItemFailure {
  readonly key: string | null;
  readonly error: unknown;
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
   * Plain-object projection. Field ORDER (workflowId, state, ok, url?,
   * artifacts, succeeded, failed) is fixed to match the PHP `toArray()`
   * reference so JSON-string parity holds (FF1 shape assertion + FF2b harness
   * fixture). `url` is omitted entirely when undefined — `JSON.stringify`
   * then produces the identical shape to PHP's omit-when-null `toArray()`.
   */
  toJSON(): {
    workflowId: string;
    state: string;
    ok: boolean;
    url?: string;
    artifacts: readonly OutputFile[];
    succeeded: readonly { key: string | null; outputs: readonly OutputFile[] }[];
    failed: readonly { key: string | null; error: string }[];
  } {
    // Re-project each OutputFile to exactly its four fields so structurally
    // compatible inputs carrying extra properties can't leak into the JSON.
    const file = (o: OutputFile): OutputFile => ({
      url: o.url,
      filename: o.filename,
      sizeBytes: o.sizeBytes,
      operation: o.operation,
    });
    const rest = {
      artifacts: this.artifacts.map(file),
      succeeded: this.succeeded.map((i) => ({ key: i.key, outputs: i.outputs.map(file) })),
      failed: this.failed.map((f) => ({
        key: f.key,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      })),
    };
    const head = { workflowId: this.workflowId, state: this.state, ok: this.ok };
    // Insert `url` BETWEEN ok and artifacts when present, matching the PHP
    // toArray() field order (workflowId, state, ok, url?, artifacts, ...) so
    // JSON-string parity holds. Omitted entirely when undefined (PHP omits
    // null), so `JSON.stringify` produces the identical shape.
    return this.url === undefined
      ? { ...head, ...rest }
      : { ...head, url: this.url, ...rest };
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
    const firstError = ((finalStatus as unknown as { jobs?: readonly { operations?: readonly { errorMessage?: string }[] }[] }).jobs ?? [])
      .flatMap((j) => j.operations ?? [])
      .map((op) => op.errorMessage)
      .find((m): m is string => m !== undefined);
    succeeded = [];
    failed = [
      { key, error: new Error(firstError !== undefined ? `${state}: ${firstError}` : state) },
    ];
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
    }));
    // The flat artifacts[] keeps every job's outputs in job order.
    artifacts.push(...outputs);

    if (job.status === 'completed') {
      succeeded.push({ key, outputs });
    } else {
      const firstError = (job.operations ?? [])
        .map((op) => op.errorMessage)
        .find((m): m is string => m !== undefined);
      failed.push({
        key,
        error: new Error(
          firstError !== undefined ? `${job.status}: ${firstError}` : String(job.status),
        ),
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
  readonly opType: 'compress' | 'convert' | 'thumbnail' | 'text_watermark';
  readonly options: Readonly<Record<string, unknown>>;
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
  convert(format: string, options: Record<string, unknown> = {}): Recipe {
    // The convert op's wire key is `output_format` (contract: convert.yaml,
    // required, all media), NOT `format`. Spread options FIRST so the explicit
    // shorthand wins over an `output_format` key in the bag.
    // The shorthand owns the format → a stray legacy `format` key in the bag is
    // not a valid convert option; drop it so the wire never carries both keys.
    const rest = { ...options };
    delete rest.format;
    return this.withStep({ opType: 'convert', options: { ...rest, output_format: format } });
  }

  /**
   * Generate a preview. Width and/or height in pixels; any additional per-op
   * thumbnail options pass through. An omitted (`undefined`) value is dropped
   * from the wire options (not sent as `undefined`).
   */
  thumbnail(options: { width?: number; height?: number } & Record<string, unknown> = {}): Recipe {
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) wire[key] = value;
    }
    return this.withStep({ opType: 'thumbnail', options: wire });
  }

  /**
   * Apply a text watermark. Single-input (the text is an option, not a
   * secondary file) — lowers to the `text_watermark` op with a `text` option;
   * `options` carries any additional per-op watermark options.
   */
  textWatermark(text: string, options: Record<string, unknown> = {}): Recipe {
    // Spread options FIRST so the explicit `text` argument is authoritative.
    return this.withStep({ opType: 'text_watermark', options: { ...options, text } });
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
    const operations: OperationDef[] = this.steps.map((step) => this.lowerStep(step));
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
      pollIntervalMs?: number;
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
    const created = await this._uploadAndCreate(undefined, deadline, onProgress, signal);

    // 3. Wait to terminal status — SSE first, poll on a genuine SSE error.
    // Caller-aborted + deadline-elapsed errors MUST propagate (not transient).
    let finalStatus;
    try {
      finalStatus = await _consumeSseToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        onProgress,
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
      finalStatus = await _pollToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        pollIntervalMs: options.pollIntervalMs,
      });
    }

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
   */
  async submit(webhook?: string): Promise<Handle> {
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
    const created = await this._uploadAndCreate(webhook, undefined);
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
  ): Promise<WorkflowCreateResponse> {
    // 1. Resolve the upload id. A pre-uploaded id skips the upload entirely;
    // a path / blob is uploaded now, emitting {phase:'upload'} progress.
    let fileId: string;
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

  private lowerStep(step: RecipeStep): OperationDef {
    const options =
      step.opType === 'compress' ? this.lowerCompressOptions(step.options) : { ...step.options };
    // Empty options omit the `options` wire key entirely, so TS (undefined →
    // absent) and PHP (null → absent) serialise byte-identically.
    return Object.keys(options).length === 0
      ? { type: step.opType }
      : { type: step.opType, options };
  }

  private lowerCompressOptions(stepOptions: Readonly<Record<string, unknown>>): Record<string, unknown> {
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
    const media = this.compressMediaHint();
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
      (input as { audioLossless?: boolean }).audioLossless = this.compressAudioLossless();
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

  private compressMediaHint(): PresetMedia | undefined {
    if (this.input.kind === 'path') {
      return _detectCompressMedia(this.input.path);
    }
    if (this.input.kind === 'blob') {
      return _detectCompressMedia(this.input.blob);
    }
    return undefined;
  }

  private compressAudioLossless(): boolean {
    if (this.input.kind === 'path') return _detectAudioLossless(this.input.path);
    if (this.input.kind === 'blob') return _detectAudioLossless(this.input.blob);
    return false;
  }
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

  /** Change every input's format. `format` lowers to the contract `output_format` wire key (via {@link Recipe.convert}), NOT `format`. */
  convert(format: string, options: Record<string, unknown> = {}): FilesRecipe {
    return this.withStep(this.baseRecipe().convert(format, options));
  }

  /** Generate a preview of every input. Omitted dimensions are dropped from the wire options. */
  thumbnail(options: { width?: number; height?: number } & Record<string, unknown> = {}): FilesRecipe {
    return this.withStep(this.baseRecipe().thumbnail(options));
  }

  /** Apply the same text watermark to every input. */
  textWatermark(text: string, options: Record<string, unknown> = {}): FilesRecipe {
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
      pollIntervalMs?: number;
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
    const created = await this._uploadAllAndCreate(undefined, deadline, onProgress, signal);

    // 3. Wait to terminal status — SSE first, poll on a genuine SSE error.
    // `partially_failed` is a normal terminal state here (the helper treats it
    // as terminal); only caller-aborted / deadline / API errors propagate.
    let finalStatus;
    try {
      finalStatus = await _consumeSseToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        onProgress,
      });
    } catch (err) {
      if (!(err instanceof SseEndedWithoutTerminal || err instanceof GislNetworkError)) {
        throw err;
      }
      finalStatus = await _pollToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        pollIntervalMs: options.pollIntervalMs,
      });
    }

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
   */
  async submit(webhook?: string): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'FilesRecipe.submit() requires a client; build the fan-out via gisl().files(...) rather than constructing FilesRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(webhook, undefined);
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
  ): Promise<WorkflowCreateResponse> {
    const fileIds: string[] = [];
    for (const input of this.inputs) {
      // Fail fast between uploads — a deadline that elapses mid-batch should
      // not force every remaining input to upload before throwing.
      _checkAborted(signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new GislTimeoutError(
          'maxWait elapsed during fan-out uploads before all inputs were uploaded',
        );
      }
      if (input.kind === 'uploadId') {
        fileIds.push(input.fileId);
      } else {
        const source = input.kind === 'path' ? input.path : input.blob;
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
        fileIds.push(up.fileId);
      }
    }
    _checkAborted(signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Uploads completed but maxWait elapsed before workflow could be created',
      );
    }
    const created = await this.client!.createWorkflow(this.toWorkflowPayload(fileIds, webhook));
    _checkAborted(signal);
    return created;
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

  /** Change the merged output's format. See {@link Recipe.convert}. */
  convert(format: string, options: Record<string, unknown> = {}): MergedRecipe {
    // The convert op's wire key is `output_format` (contract: convert.yaml,
    // required, all media), NOT `format`. Spread options FIRST so the explicit
    // shorthand wins over an `output_format` key in the bag.
    // The shorthand owns the format → a stray legacy `format` key in the bag is
    // not a valid convert option; drop it so the wire never carries both keys.
    const rest = { ...options };
    delete rest.format;
    return this.withStep({ opType: 'convert', options: { ...rest, output_format: format } });
  }

  /** Thumbnail the merged output. Omitted dimensions are dropped from the wire options. */
  thumbnail(options: { width?: number; height?: number } & Record<string, unknown> = {}): MergedRecipe {
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
      pollIntervalMs?: number;
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

    const created = await this._uploadAllAndCreate(undefined, deadline, onProgress, signal);

    let finalStatus;
    try {
      finalStatus = await _consumeSseToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        onProgress,
      });
    } catch (err) {
      if (!(err instanceof SseEndedWithoutTerminal || err instanceof GislNetworkError)) {
        throw err;
      }
      finalStatus = await _pollToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        pollIntervalMs: options.pollIntervalMs,
      });
    }

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
   */
  async submit(webhook?: string): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'MergedRecipe.submit() requires a client; build the merge via gisl().files(...).merge(...) rather than constructing MergedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(webhook, undefined);
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
  ): Promise<WorkflowCreateResponse> {
    this.validatePreUpload();
    const fileIds: string[] = [];
    for (const input of this.inputs) {
      _checkAborted(signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new GislTimeoutError(
          'maxWait elapsed during merge uploads before all inputs were uploaded',
        );
      }
      if (input.kind === 'uploadId') {
        fileIds.push(input.fileId);
      } else {
        const source = input.kind === 'path' ? input.path : input.blob;
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
        fileIds.push(up.fileId);
      }
    }
    _checkAborted(signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Uploads completed but maxWait elapsed before the merge workflow could be created',
      );
    }
    const created = await this.client!.createWorkflow(this.toWorkflowPayload(fileIds, webhook));
    _checkAborted(signal);
    return created;
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
      pollIntervalMs?: number;
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

    const created = await this._uploadAllAndCreate(undefined, deadline, onProgress, signal);

    let finalStatus;
    try {
      finalStatus = await _consumeSseToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        onProgress,
      });
    } catch (err) {
      if (!(err instanceof SseEndedWithoutTerminal || err instanceof GislNetworkError)) {
        throw err;
      }
      finalStatus = await _pollToTerminal(this.client, {
        workflowId: created.workflowId,
        deadline,
        signal,
        pollIntervalMs: options.pollIntervalMs,
      });
    }

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
   */
  async submit(webhook?: string): Promise<Handle> {
    if (this.client === undefined) {
      throw new GislConfigError(
        'ArchivedRecipe.submit() requires a client; build the bundle via gisl().files(...).archive(...) rather than constructing ArchivedRecipe directly.',
        { reason: 'no_client' },
      );
    }
    const created = await this._uploadAllAndCreate(webhook, undefined);
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
  ): Promise<WorkflowCreateResponse> {
    this.validatePreUpload();
    const fileIds: string[] = [];
    for (const input of this.inputs) {
      _checkAborted(signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new GislTimeoutError(
          'maxWait elapsed during archive uploads before all inputs were uploaded',
        );
      }
      if (input.kind === 'uploadId') {
        fileIds.push(input.fileId);
      } else {
        const source = input.kind === 'path' ? input.path : input.blob;
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
        fileIds.push(up.fileId);
      }
    }
    _checkAborted(signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Uploads completed but maxWait elapsed before the archive workflow could be created',
      );
    }
    const created = await this.client!.createWorkflow(this.toWorkflowPayload(fileIds, webhook));
    _checkAborted(signal);
    return created;
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
