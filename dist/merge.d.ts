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
import { type Result, type RunOptions, type SubmitOptions } from './builder.js';
import { Handle } from './handle.js';
/**
 * A declared merge asset. `path` carries a string or Blob (deduped by
 * normalised source key); `handle` wraps an already-uploaded file (deduped
 * by handle identity — same handle reference = same upload regardless of
 * path). Use a handle for guaranteed reuse.
 */
export type Asset = {
    readonly type: 'path';
    readonly path: string | Blob;
} | {
    readonly type: 'handle';
    readonly fileId: string;
};
/**
 * Construct a path-asset. Bare-string arguments to `merge(...)` are
 * implicitly wrapped via this helper.
 */
export declare function asset(path: string | Blob): Asset;
/**
 * Wrap an already-uploaded file_id as a merge asset. Use this when the
 * SAME logical file should be referenced from multiple merge runs with
 * guaranteed-single-upload semantics.
 */
export declare function handle(fileId: string): Asset;
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
export declare function clip(ref: Asset, options?: ClipOptions): ClipEntry;
export type SequenceEntry = Asset | ClipEntry;
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
    /**
     * Video re-encode policy (`auto` | `always` | `never`). Passed through
     * verbatim — `codec`/`crf`/`preset`/`targetResolution`/`targetSize` are only
     * honoured by the worker when re-encoding (`auto`/`always`); the server owns
     * that dependency validation (the SDK is a passthrough allowlist, same as the
     * pre-existing codec/crf/preset fields). Video merge only.
     */
    readonly reEncodeMode?: string;
    readonly codec?: string;
    readonly crf?: number;
    readonly preset?: string;
    /** Video output dimensions `WxH` (e.g. `"1920x1080"`); omit to inherit from inputs. Video merge only. */
    readonly targetResolution?: string;
    /**
     * Target output size (bytes, or a `'50MB'`-style string). Lowered to wire
     * `target_size_bytes`, and the SDK also sets `encoding_mode: 'target_size'` alongside
     * it. Video merge only.
     *
     * **UNITS ARE DECIMAL HERE (1 KB = 1000), UNLIKE `compress`.** `compress`'s
     * `targetSize` parses the same strings as BINARY (1 KB = 1024), so `'50MB'` means
     * 50,000,000 bytes on a merge and 52,428,800 bytes on a compress. That divergence is
     * NOT deliberate — it contradicts the pinned convention that every human-readable
     * size string in this SDK is binary — and it has a sharp edge: the contract floor for
     * `target_size_bytes` is 1 MiB (1,048,576), so `'1MB'` here resolves to 1,000,000 and
     * is rejected as below the minimum. Prefer an explicit byte count until this is
     * reconciled. Tracked by `YOCz0i74`; changing it moves bytes for existing callers, so
     * it is a deliberate decision rather than a silent correction.
     *
     * **NOT AVAILABLE FOR LONG INPUTS.** Merges whose summed input duration routes to
     * the long-form Fargate path reject both keys — that path is single-pass-CRF by
     * construction and two-pass target-size is unbuilt. The request fails during
     * execution, and the SDK cannot warn earlier: the routing decision is made
     * server-side at create-plan time, so there is nothing here to check it against.
     * Short-form merges honour it normally.
     *
     * The contract CAN now express this — `per_class_availability` scopes an option to
     * a processing class, vendored at v2.195.0 and pinned by
     * `tests/unit/per-class-availability-conformance.test.ts`. That buys an honest 422
     * from the API at CREATE rather than a job dying mid-execution; it does NOT become
     * a client-side gate, because routing is still decided server-side and a duration
     * heuristic here would be wrong at the boundary. Tracked by `zJN6XIi5`.
     */
    readonly targetSize?: string | number;
    readonly transitionDuration?: number;
    readonly fps?: number;
    readonly durationPerImage?: number;
    /** Milliseconds between frames for an animated-GIF image merge (`output_type: gif`). Image merge only. */
    readonly delay?: number;
    readonly loopCount?: number;
    readonly output?: string;
    readonly videoFormat?: string;
    readonly outputType?: string;
    /** Force the inferred media kind (skip the first-asset sniff). */
    readonly mediaKind?: MergeMediaKind;
    /** Bypass the unused-asset validation (rarely needed; usually a bug indicator). */
    readonly allowUnusedAssets?: boolean;
}
/**
 * Captures the (declared assets, options) for a merge. `.sequence(...)`
 * pins the play order; without it, the declared order is used as-is
 * with no per-input options.
 *
 * Local validation runs at `.run()`/`.submit()` time (BEFORE any upload)
 * and throws one of `GislUndeclaredAssetError`, `GislUnusedAssetError`,
 * or `GislPerInputOptionsNotSupportedError` if the compose is invalid.
 */
export declare class MergeBuilder {
    private readonly client;
    private readonly assets;
    private readonly opOptions;
    private sequenceEntries;
    constructor(client: GislClient, assets: readonly Asset[], opOptions: MergeOptions);
    /**
     * Pin the merge play order. Each entry must reference an asset that
     * was declared in the parent `merge(...)` call. Repeats are allowed
     * and deduped on upload (one upload per unique declared asset).
     */
    sequence(...entries: SequenceEntry[]): this;
    run(options: RunOptions): Promise<Result>;
    submit(options: SubmitOptions): Promise<Handle>;
    /**
     * Resolve the declared assets + sequence (or fall back to declared order),
     * dedupe by identity, and run the local validators. The returned plan
     * carries the SEQUENCE (positional entries) + the UNIQUE assets to upload.
     */
    private planSequence;
    private inferMediaKind;
    private uploadUniqueAssets;
    /**
     * Best-effort, concurrent probe-before-create for the multipart-video
     * inputs (never-bounce; each bounded by the SAME capped timeout, so the
     * aggregate wall-clock stays ~timeout rather than N×timeout). When `deadline`
     * is set (the `run()` path) the timeout is capped to the remaining maxWait
     * budget so the waits cannot push createWorkflow past the caller's deadline;
     * `submit()` passes `undefined` (fire-and-forget, no cap).
     */
    private waitForVideoProbes;
    private buildPayload;
    private opOptionsForResolved;
    private awaitTerminal;
}
/**
 * Project the merge-level {@link MergeOptions} into the per-media wire
 * allowlist. Exported so the file-first `MergedRecipe`
 * (`files([...]).merge(...)`) lowers identically to this operation-first
 * `client.merge(...)` builder — one allowlist, no drift. Mirrors the PHP
 * `MergeBuilder::wireMergeOptions()` public-static seam.
 *
 * @internal Not re-exported from `index.ts`; shared between the two merge
 *   surfaces only.
 */
export declare function wireMergeOptions(opts: MergeOptions, mediaKind: MergeMediaKind): Record<string, unknown>;
