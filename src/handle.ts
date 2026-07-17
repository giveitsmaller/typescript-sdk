/**
 * File-first {@link Handle} + {@link StatusSnapshot} value objects (FF5a).
 *
 * A `Handle` is the lightweight return of a fire-and-forget submit
 * (`OperationBuilder.submit()` / `MergeBuilder.submit()`) AND the value
 * `client.workflow(id)` hands back to reattach to a previously-created
 * workflow. When a `Handle` carries a bound client it exposes three
 * accessors:
 *
 *  - `status()` — one non-blocking status fetch, projected to a
 *    {@link StatusSnapshot}.
 *  - `wait(maxWait, onProgress?)` — the ONLY blocking path: await terminal
 *    (SSE with poll fallback), then fetch downloads + project to a
 *    {@link RunResult}.
 *  - `result()` — non-blocking: fetch status once; if terminal, fetch
 *    downloads + project to a {@link RunResult}; if NOT terminal, throw
 *    {@link GislResultNotReadyError}. Never waits/polls.
 *
 * A `Handle` built WITHOUT a client (the operation-first/merge `submit()`
 * path) keeps its data fields + `toJSON()` byte-identical to the prior
 * `{ workflowId, webhookSecret }` interface; its accessors throw
 * {@link GislConfigError} (reason `no_client`).
 *
 * Module placement: this lives in its OWN module (not `builder.ts` or
 * `file-first.ts`) to keep the ESM import graph acyclic at module-load time.
 * It imports the await-primitives from `builder.ts` and the
 * {@link RunResult} + {@link projectDownloadsToRunResult} projection from
 * `file-first.ts`; `builder.ts`/`merge.ts` import `Handle` back for
 * construction inside their `submit()` methods. That back-edge is
 * DEFERRED-USAGE-ONLY (construction happens at call time, not module-load),
 * which ESM resolves cleanly.
 *
 * Mirrors the PHP `Gisl\Sdk\Ergonomic\Handle` + `Gisl\Sdk\Ergonomic\StatusSnapshot`.
 */

import type { GislClient } from './client.js';
import {
  GislConfigError,
  GislNetworkError,
  GislResultNotReadyError,
  GislTimeoutError,
  SseEndedWithoutTerminal,
} from './errors.js';
import {
  _consumeSseToTerminal,
  _pollToTerminal,
  _parseMaxWait,
  type ProgressEvent,
} from './builder.js';
import {
  RunResult,
  projectDownloadsToRunResult,
  projectMultiJobToRunResult,
  isFanoutStatus,
  isMergeStatus,
  isArchiveStatus,
  isWatermarkStatus,
  type Downloader,
} from './file-first.js';
import { LazyHttpDownloader } from './lazy-downloader.js';

/**
 * The terminal workflow states. A status response in any of these states
 * will not change without caller action. Mirrors the `TERMINAL_STATUSES`
 * sets in `client.ts` / `WorkflowConstants` (PHP) — `paused_insufficient_credits`
 * is treated as terminal because the workflow only resumes on caller action.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'partially_failed',
  'cancelled',
  'expired',
  'paused_insufficient_credits',
]);

/**
 * A non-blocking snapshot of a workflow's lifecycle state, returned by
 * {@link Handle.status}. `state` is the RAW wire `WorkflowStatus` value,
 * verbatim (`pending` | `in_progress` | `completed` | `failed` |
 * `partially_failed` | `paused_insufficient_credits` | `cancelled` |
 * `expired`). There is NO `phase` field — phase is an SSE-only concept; the
 * status response carries no phase.
 *
 * Mirrors the PHP `Gisl\Sdk\Ergonomic\StatusSnapshot`.
 */
export class StatusSnapshot {
  constructor(readonly workflowId: string, readonly state: string) {}

  /**
   * True when {@link state} is one of the terminal states (`completed`,
   * `failed`, `partially_failed`, `cancelled`, `expired`,
   * `paused_insufficient_credits`); false for `pending` / `in_progress`.
   */
  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  /** Plain-object projection. Mirrors the PHP `toArray()`. */
  toJSON(): { workflowId: string; state: string } {
    return { workflowId: this.workflowId, state: this.state };
  }
}

/**
 * Handle to a created workflow. Carries `workflowId` + an optional
 * `webhookSecret` (the data the operation-first/merge `submit()` returns)
 * and, when reattached or built by the file-first run path, an optional
 * bound {@link GislClient}.
 *
 * The bound client is OPTIONAL (mirrors how {@link RunResult} binds its
 * {@link Downloader}): the data fields + {@link toJSON} stay byte-identical
 * whether or not a client is present, so the operation-first/merge `submit()`
 * back-compat fixture (`{ workflowId, webhookSecret }` via `toJSON()`) holds.
 * When the client is absent, {@link status}/{@link wait}/{@link result} throw
 * {@link GislConfigError} (reason `no_client`).
 *
 * A handle built via `client.workflow(id)` has NO recipe key, so its
 * {@link RunResult} is keyless (`succeeded[].key === null`) — address its
 * outputs positionally / via the sinks rather than `byKey()`.
 *
 * Mirrors the PHP `Gisl\Sdk\Ergonomic\Handle`.
 */
export class Handle {
  // True ES private (`#`), NOT a TS `private` modifier: a `private` constructor
  // parameter property is an enumerable own field, so spreading/logging/Object
  // .assign-ing a bound handle would leak the GislClient (incl. auth headers).
  // `#client` is non-enumerable and inaccessible outside the class (codex high).
  readonly #client?: GislClient;

  // The recipe's result-addressing key, threaded from a file-first `submit()`
  // (`Recipe.submit()`) so the `RunResult` from `wait()`/`result()` is keyed
  // (`succeeded[].key === recipeKey`). A reattached handle
  // (`client.workflow(id)`) passes no key → null → keyless RunResult. It is
  // ES-private (`#`) — like `#client` — NOT just kept out of `toJSON()`: the
  // parity ReturnSerialiser enumerates a Handle's OWN ENUMERABLE properties
  // (it does not call `toJSON()`), so a plain `readonly key` leaked into the
  // operation-first/merge `submit()` back-compat shape ({workflowId,
  // webhookSecret}). `#key` is non-enumerable, so that shape stays byte-identical.
  readonly #key: string | null;

  constructor(
    readonly workflowId: string,
    readonly webhookSecret?: string,
    client?: GislClient,
    key: string | null = null,
  ) {
    this.#client = client;
    this.#key = key;
  }

  /**
   * Fetch the workflow's current status once (non-blocking) and project it to
   * a {@link StatusSnapshot}.
   * @throws {GislConfigError} reason `no_client` when no client is bound.
   */
  async status(): Promise<StatusSnapshot> {
    const client = this.requireClient();
    const status = await client.getWorkflowStatus(this.workflowId);
    return new StatusSnapshot(this.workflowId, status.status);
  }

  /**
   * Block until the workflow reaches a terminal state (SSE with poll
   * fallback), then fetch its downloads and project to a {@link RunResult}.
   * This is the ONLY blocking accessor on a `Handle`.
   *
   * @param maxWait Wall-clock deadline for the wait + downloads (string suffix
   *   `'2h'`/`'30m'`/`'120s'` or a number of milliseconds). Defaults to 600s,
   *   matching `Recipe.run()` / the PHP `Handle::wait()` default.
   * @throws {GislConfigError} reason `no_client` when no client is bound.
   * @throws {GislTimeoutError} when `maxWait` elapses before terminal.
   */
  async wait(
    maxWait: string | number = 600_000,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<RunResult> {
    const client = this.requireClient();
    const deadline = Date.now() + _parseMaxWait(maxWait);

    let finalStatus;
    try {
      finalStatus = await _consumeSseToTerminal(client, {
        workflowId: this.workflowId,
        deadline,
        signal: undefined,
        onProgress,
      });
    } catch (err) {
      // TDqmkWpX: mirror Recipe.run() — poll-fallback ONLY on a clean SSE
      // stream-end (SseEndedWithoutTerminal) or a typed transport error
      // (GislNetworkError). Everything else (timeout, abort, API, an onProgress
      // callback throw, anything unexpected) MUST propagate — re-issuing the same
      // doomed request via poll would mask the real failure.
      if (!(err instanceof SseEndedWithoutTerminal || err instanceof GislNetworkError)) {
        throw err;
      }
      finalStatus = await _pollToTerminal(client, {
        workflowId: this.workflowId,
        deadline,
        signal: undefined,
      });
    }

    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${this.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`,
      );
    }
    const downloads = await client.getWorkflowDownloads(this.workflowId);
    // TDqmkWpX: re-check AFTER the downloads fetch so a slow getWorkflowDownloads
    // cannot return a success past the advertised maxWait.
    if (Date.now() >= deadline) {
      throw new GislTimeoutError(
        `Workflow ${this.workflowId} downloads fetch completed after maxWait elapsed`,
      );
    }
    return this.project(finalStatus, downloads.downloads);
  }

  /**
   * Non-blocking result accessor. Fetches the workflow status once: if the
   * workflow is terminal, fetches its downloads and projects to a
   * {@link RunResult}; if it is NOT terminal, throws
   * {@link GislResultNotReadyError}. Never waits or polls — use {@link wait}
   * to block.
   *
   * @throws {GislConfigError} reason `no_client` when no client is bound.
   * @throws {GislResultNotReadyError} when the workflow is not yet terminal.
   */
  async result(): Promise<RunResult> {
    const client = this.requireClient();
    const status = await client.getWorkflowStatus(this.workflowId);
    if (!TERMINAL_STATES.has(status.status)) {
      throw new GislResultNotReadyError(this.workflowId, status.status);
    }
    const downloads = await client.getWorkflowDownloads(this.workflowId);
    return this.project(status, downloads.downloads);
  }

  /**
   * Project a terminal status + its per-job downloads into a {@link RunResult},
   * choosing the producer DATA-DRIVEN off the wire (not a construction-time
   * marker, so a fan-out reattached via `client.workflow(id)` — which carries
   * no marker — still partitions per job):
   *
   *  - A `files([...])` fan-out (every job ref is `file-{i}`, see
   *    {@link isFanoutStatus}) → {@link projectMultiJobToRunResult} with an
   *    empty `keyByRef`, so each input's key is recovered from its `file-{i}`
   *    ref (`"0"`, `"1"`, …). A submitted/reattached fan-out carries no
   *    caller-supplied keys — keyed fan-out is a separate concern.
   *  - Anything else (the single-file {@link Recipe} path) →
   *    {@link projectDownloadsToRunResult} keyed by this handle's `#key`
   *    (the recipe key from a file-first `submit()`, or `null` on reattach).
   */
  private project(
    finalStatus: Parameters<typeof projectDownloadsToRunResult>[1],
    jobDownloads: Parameters<typeof projectMultiJobToRunResult>[2],
  ): RunResult {
    const downloader = this.makeDownloader();
    if (isFanoutStatus(finalStatus)) {
      return projectMultiJobToRunResult(
        this.workflowId,
        finalStatus,
        jobDownloads,
        new Map<string, string | null>(),
        downloader,
      );
    }
    // A fluent `files([...]).merge(...)` combine — project ONLY the merged
    // output, filtering the `src_*` passthrough plumbing (which re-exposes the
    // raw inputs). Matches MergedRecipe.run()'s `ref === 'merge'` filter so a
    // submitted/reattached merge handle never surfaces the input artifacts
    // alongside the combined output (codex c1).
    if (isMergeStatus(finalStatus)) {
      const mergeDownloads = jobDownloads.filter((d) => d.ref === 'merge');
      return projectDownloadsToRunResult(
        this.workflowId,
        finalStatus,
        mergeDownloads,
        null,
        downloader,
      );
    }
    // A fluent `files([...]).archive(...)` bundle — project ONLY the archive
    // output, filtering the `src_*` passthrough plumbing (mirror of the merge
    // branch for archive).
    if (isArchiveStatus(finalStatus)) {
      const archiveDownloads = jobDownloads.filter((d) => d.ref === 'archive');
      return projectDownloadsToRunResult(
        this.workflowId,
        finalStatus,
        archiveDownloads,
        null,
        downloader,
      );
    }
    // A fluent `file(...).watermark(overlay)` — project ONLY the watermark
    // output, filtering the `src_*` (base/overlay) passthrough plumbing. Matches
    // WatermarkedRecipe.run()'s `ref === 'watermark'` filter so a
    // submitted/reattached watermark handle never surfaces the raw inputs.
    if (isWatermarkStatus(finalStatus)) {
      const watermarkDownloads = jobDownloads.filter((d) => d.ref === 'watermark');
      return projectDownloadsToRunResult(
        this.workflowId,
        finalStatus,
        watermarkDownloads,
        null,
        downloader,
      );
    }
    return projectDownloadsToRunResult(
      this.workflowId,
      finalStatus,
      jobDownloads,
      this.#key,
      downloader,
    );
  }

  /**
   * Plain-object projection. Field order (`workflowId`, then `webhookSecret`
   * when present) and the omit-when-undefined behaviour match the PHP
   * `toArray()` so JSON-string parity holds with the prior `Handle` shape.
   * The bound client is NEVER serialised.
   */
  toJSON(): { workflowId: string; webhookSecret?: string } {
    return this.webhookSecret === undefined
      ? { workflowId: this.workflowId }
      : { workflowId: this.workflowId, webhookSecret: this.webhookSecret };
  }

  /**
   * Back-compat alias for {@link toJSON} — the prior operation-first/merge
   * `submit()` fixture asserts a plain `{ workflowId, webhookSecret }` shape.
   */
  toArray(): { workflowId: string; webhookSecret?: string } {
    return this.toJSON();
  }

  private makeDownloader(): Downloader {
    // Download URLs from getWorkflowDownloads are pre-signed and require no SDK
    // auth, so the downloader issues a plain unauthenticated fetch. Lazy so the
    // node:fs-importing HttpDownloader stays out of the browser static graph.
    return new LazyHttpDownloader();
  }

  private requireClient(): GislClient {
    if (this.#client === undefined) {
      throw new GislConfigError(
        'This handle has no client bound, so it cannot query the workflow. ' +
          'Use recipe.run() to execute and get a RunResult directly, or reattach via client.workflow(id).',
        { reason: 'no_client' },
      );
    }
    return this.#client;
  }
}
