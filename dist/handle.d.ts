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
import { type ProgressEvent } from './builder.js';
import { RunResult } from './file-first.js';
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
export declare class StatusSnapshot {
    readonly workflowId: string;
    readonly state: string;
    constructor(workflowId: string, state: string);
    /**
     * True when {@link state} is one of the terminal states (`completed`,
     * `failed`, `partially_failed`, `cancelled`, `expired`,
     * `paused_insufficient_credits`); false for `pending` / `in_progress`.
     */
    isTerminal(): boolean;
    /** Plain-object projection. Mirrors the PHP `toArray()`. */
    toJSON(): {
        workflowId: string;
        state: string;
    };
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
export declare class Handle {
    #private;
    readonly workflowId: string;
    readonly webhookSecret?: string | undefined;
    constructor(workflowId: string, webhookSecret?: string | undefined, client?: GislClient, key?: string | null);
    /**
     * Fetch the workflow's current status once (non-blocking) and project it to
     * a {@link StatusSnapshot}.
     * @throws {GislConfigError} reason `no_client` when no client is bound.
     */
    status(): Promise<StatusSnapshot>;
    /**
     * Block until the workflow reaches a terminal state (SSE with poll
     * fallback), then fetch its downloads and project to a {@link RunResult}.
     * This is the ONLY blocking accessor on a `Handle`.
     *
     * @param maxWait Wall-clock deadline for the wait + downloads (string suffix
     *   `'2h'`/`'30m'`/`'120s'` or a number of milliseconds). Defaults to 300s,
     *   matching `Recipe.run()` / the PHP `Handle::wait()` default.
     * @throws {GislConfigError} reason `no_client` when no client is bound.
     * @throws {GislTimeoutError} when `maxWait` elapses before terminal.
     */
    wait(maxWait?: string | number, onProgress?: (event: ProgressEvent) => void): Promise<RunResult>;
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
    result(): Promise<RunResult>;
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
    private project;
    /**
     * Plain-object projection. Field order (`workflowId`, then `webhookSecret`
     * when present) and the omit-when-undefined behaviour match the PHP
     * `toArray()` so JSON-string parity holds with the prior `Handle` shape.
     * The bound client is NEVER serialised.
     */
    toJSON(): {
        workflowId: string;
        webhookSecret?: string;
    };
    /**
     * Back-compat alias for {@link toJSON} — the prior operation-first/merge
     * `submit()` fixture asserts a plain `{ workflowId, webhookSecret }` shape.
     */
    toArray(): {
        workflowId: string;
        webhookSecret?: string;
    };
    private makeDownloader;
    private requireClient;
}
