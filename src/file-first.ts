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

import { GislApiError, GislConfigError, GislNoSuchKeyError, GislSinkError, GislTimeoutError } from './errors.js';
import {
  _detectCompressMedia,
  _consumeSseToTerminal,
  _pollToTerminal,
  _parseMaxWait,
  _checkAborted,
  type ProgressEvent,
} from './builder.js';
import type { GislClient } from './client.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { HttpDownloader } from './http-downloader.js';
import {
  resolveCompressOptions,
  type ResolveCompressOptionsInput,
} from './ergonomic/preset_resolver.js';
import { OptimizeFor } from './generated/sdk_spec/enums.js';
import type { PresetDefaults, PresetMedia } from './ergonomic/presets/index.js';
import type {
  JobDefinitionPayload,
  OperationDef,
  WorkflowCreatePayload,
} from './types.js';
import { uploadSource } from './types.js';

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
   */
  compress(optimize?: OptimizeFor): Recipe {
    if (optimize !== undefined && !Object.values(OptimizeFor).includes(optimize)) {
      const allowed = Object.values(OptimizeFor).join(', ');
      throw new GislConfigError(
        `compress 'optimize' must be one of ${allowed}; got '${String(optimize)}'.`,
        { reason: 'invalid_optimize', conflictingFields: ['optimize'] },
      );
    }
    return this.withStep({ opType: 'compress', options: optimize === undefined ? {} : { optimize } });
  }

  /** Change format. `format` is lowered verbatim to the `format` wire option. */
  convert(format: string): Recipe {
    return this.withStep({ opType: 'convert', options: { format } });
  }

  /**
   * Generate a preview. Width and/or height in pixels; an omitted dimension is
   * dropped from the wire options (not sent as `undefined`).
   */
  thumbnail(options: { width?: number; height?: number } = {}): Recipe {
    const wire: Record<string, unknown> = {};
    if (options.width !== undefined) wire.width = options.width;
    if (options.height !== undefined) wire.height = options.height;
    return this.withStep({ opType: 'thumbnail', options: wire });
  }

  /**
   * Apply a text watermark. Single-input (the text is an option, not a
   * secondary file) — lowers to the `text_watermark` op with a `text` option.
   */
  textWatermark(text: string): Recipe {
    return this.withStep({ opType: 'text_watermark', options: { text } });
  }

  /**
   * Lower this recipe to a workflow-create payload against a resolved upload
   * id. Single-input chain → ONE job, `source: upload(fileId)`, ordered
   * `operations[]`; the job `id` is omitted (a single job referenced by
   * nothing — the server auto-assigns `job_N`).
   *
   * @internal Consumed by FF2b's `run()` (after a real upload) and by the
   *   cross-language parity harness (with a fixed id). Not part of the
   *   caller-facing fluent surface.
   */
  toWorkflowPayload(fileId: string): WorkflowCreatePayload {
    const operations: OperationDef[] = this.steps.map((step) => this.lowerStep(step));
    // Key order (source, operations) matches the PHP `toWire()` so the
    // JSON-string serialisation is byte-identical across languages.
    const job: JobDefinitionPayload = { source: uploadSource(fileId), operations };
    return { jobs: [job] };
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

    // 1. Resolve the upload id. A pre-uploaded id skips the upload entirely;
    // a path / blob is uploaded now, emitting {phase:'upload'} progress.
    let fileId: string;
    if (this.input.kind === 'uploadId') {
      fileId = this.input.fileId;
    } else {
      const source = this.input.kind === 'path' ? this.input.path : this.input.blob;
      const up = await this.client.uploadFile(source, {
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
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        'Upload completed but maxWait elapsed before workflow could be created',
      );
    }

    // 2. Create the workflow from the lowered payload.
    const payload = this.toWorkflowPayload(fileId);
    const created = await this.client.createWorkflow(payload);
    _checkAborted(signal);

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
      // Only genuine SSE transport / clean-stream-end failures fall through to
      // poll. Caller-deadline, abort, and API errors (a 401/402/etc. from
      // /events, or an onProgress callback throw surfacing as GislApiError)
      // MUST propagate — re-issuing the same doomed request via poll would mask
      // them. Mirrors the PHP BuilderInternals::awaitTerminal sealed-marker
      // discipline (codex review medium).
      if (err instanceof GislTimeoutError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (err instanceof GislApiError) throw err;
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

    // Download URLs from getWorkflowDownloads are pre-signed and require no SDK
    // auth, so the downloader issues a plain unauthenticated fetch.
    const downloader = new HttpDownloader();
    return projectDownloadsToRunResult(
      created.workflowId,
      finalStatus,
      downloads.downloads,
      this.recipeKey ?? null,
      downloader,
    );
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

  private lowerCompressOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const optimize = options.optimize as OptimizeFor | undefined;
    const media = this.compressMediaHint();
    if (media === undefined) {
      // Cannot infer a media class (a Blob without a recognised name, or a
      // bare upload id) → preset resolution is impossible. Fail FAST rather
      // than silently dropping an explicit `optimize`; bare compress() is fine.
      if (optimize !== undefined) {
        throw new GislConfigError(
          `compress(optimize: ${String(optimize)}) needs a media type to resolve the preset, but the ` +
            'input has no inferable media (a pre-uploaded file id or unnamed Blob carries no extension). ' +
            'Use a path with a file extension, or call compress() without optimize.',
          { reason: 'media_unknown', conflictingFields: ['optimize'] },
        );
      }
      return {};
    }
    const input: ResolveCompressOptionsInput = { media, op: 'compress', explicitOptions: {} };
    if (this.presetDefaults !== undefined) {
      (input as { presetDefaults?: PresetDefaults }).presetDefaults = this.presetDefaults;
    }
    if (this.scopedPresetDefaults !== undefined) {
      (input as { scopedPresetDefaults?: PresetDefaults }).scopedPresetDefaults =
        this.scopedPresetDefaults;
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
}
