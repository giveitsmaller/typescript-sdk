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

import { GislNoSuchKeyError, GislSinkError } from './errors.js';

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
