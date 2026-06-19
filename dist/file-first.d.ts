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
import { type ProgressEvent } from './builder.js';
import type { GislClient } from './client.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { OptimizeFor } from './generated/sdk_spec/enums.js';
import type { PresetDefaults } from './ergonomic/presets/index.js';
import type { WorkflowCreatePayload } from './types.js';
import type { MergeOptions } from './merge.js';
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
export declare class RunResult {
    readonly workflowId: string;
    readonly state: string;
    readonly artifacts: readonly OutputFile[];
    readonly succeeded: readonly ItemResult[];
    readonly failed: readonly ItemFailure[];
    private readonly downloader?;
    /** Single-output sugar: the lone artifact's URL, or undefined for 0 / >1. */
    readonly url?: string;
    /** True iff {@link failed} is empty. */
    readonly ok: boolean;
    constructor(workflowId: string, state: string, artifacts: readonly OutputFile[], succeeded: readonly ItemResult[], failed: readonly ItemFailure[], downloader?: Downloader | undefined);
    /**
     * Address a succeeded input by the `key:` given to `file()`. Duplicate keys
     * are not valid input — the producer enforces key uniqueness (a later
     * ticket); the first match is returned.
     * @throws {GislNoSuchKeyError} when no succeeded entry has that key (a
     *   keyless run always throws — it is positionally addressable only).
     */
    byKey(key: string): ItemResult;
    /**
     * Write the single output to `path`. Requires EXACTLY ONE artifact.
     * @throws {GislSinkError} reason `not_single_output` for 0/>1 outputs;
     *   reason `downloader_unavailable` when no downloader is bound.
     */
    toFile(path: string): Promise<void>;
    /**
     * Download every output into `dir` (filename per output), in output order.
     * Returns the {@link Manifest} of local paths written.
     * @throws {GislSinkError} reason `partial_failure` when `failOnPartial` and
     *   the run had failed inputs; reason `downloader_unavailable` when no
     *   downloader is bound.
     */
    downloadTo(dir: string, options?: {
        failOnPartial?: boolean;
    }): Promise<Manifest>;
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
        succeeded: readonly {
            key: string | null;
            outputs: readonly OutputFile[];
        }[];
        failed: readonly {
            key: string | null;
            error: string;
        }[];
    };
    private requireDownloader;
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
export declare function projectDownloadsToRunResult(workflowId: string, finalStatus: WorkflowStatusResponse, jobDownloads: readonly {
    files: readonly OperationDownload[];
}[], key: string | null, downloader?: Downloader): RunResult;
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
export declare function projectMultiJobToRunResult(workflowId: string, finalStatus: WorkflowStatusResponse, jobDownloads: readonly {
    ref: string;
    files: readonly OperationDownload[];
}[], keyByRef: ReadonlyMap<string, string | null>, downloader?: Downloader): RunResult;
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
export declare function isFanoutStatus(finalStatus: WorkflowStatusResponse): boolean;
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
export declare function isMergeStatus(finalStatus: WorkflowStatusResponse): boolean;
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
export declare function isArchiveStatus(finalStatus: WorkflowStatusResponse): boolean;
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
export declare function isWatermarkStatus(finalStatus: WorkflowStatusResponse): boolean;
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
export type FileInput = {
    readonly kind: 'path';
    readonly path: string;
} | {
    readonly kind: 'blob';
    readonly blob: Blob;
} | {
    readonly kind: 'uploadId';
    readonly fileId: string;
};
/** Named constructors for {@link FileInput} — mirror the PHP static factories. */
export declare const fileInput: {
    readonly path: (path: string) => FileInput;
    readonly blob: (blob: Blob) => FileInput;
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
    readonly uploadId: (fileId: string) => FileInput;
};
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
export declare class Recipe {
    private readonly input;
    private readonly recipeKey;
    private readonly steps;
    private readonly presetDefaults?;
    private readonly scopedPresetDefaults?;
    private readonly client?;
    constructor(input: FileInput, recipeKey?: string | undefined, steps?: readonly RecipeStep[], presetDefaults?: PresetDefaults | undefined, scopedPresetDefaults?: PresetDefaults | undefined, client?: GislClient | undefined);
    /**
     * Reduce file size. `optimize` selects a per-media preset (resolved to
     * concrete wire fields at lower-time, exactly as `client.compress()` does).
     * `options` carries the full per-op options bag (mirrors
     * `client.compress(input, options)`); the explicit `optimize` param wins
     * over any `optimize` key in the bag.
     */
    compress(optimize?: OptimizeFor, options?: Record<string, unknown>): Recipe;
    /**
     * Change format. The `format` shorthand lowers to the `output_format` wire
     * option (the convert op's wire key per the contract); `options` carries any
     * additional per-op convert options.
     */
    convert(format: string, options?: Record<string, unknown>): Recipe;
    /**
     * Generate a preview. Width and/or height in pixels; any additional per-op
     * thumbnail options pass through. An omitted (`undefined`) value is dropped
     * from the wire options (not sent as `undefined`).
     */
    thumbnail(options?: {
        width?: number;
        height?: number;
    } & Record<string, unknown>): Recipe;
    /**
     * Apply a text watermark. Single-input (the text is an option, not a
     * secondary file) — lowers to the `text_watermark` op with a `text` option;
     * `options` carries any additional per-op watermark options.
     */
    textWatermark(text: string, options?: Record<string, unknown>): Recipe;
    /**
     * Composite an image OVERLAY onto this file (a multi-input op). `overlay` is a
     * secondary file-NODE (a {@link Recipe} — e.g. `client.file('logo.png')`),
     * itself optionally processed first. Routes by THIS file's effective media:
     * image base → `image_watermark` (stable), video base → `video_watermark`
     * (beta). Audio/document/animated-GIF/unsupported-subtype/undetectable bases
     * throw locally BEFORE any upload (the planned-op gate). `options` carries the
     * wire watermark options (`anchor`, `opacity`, `margin_x`, `margin_y`,
     * `overlay_width`). Returns a {@link WatermarkedRecipe} (chain post-watermark
     * `compress`/`convert`/`thumbnail`, then `run`/`submit`). Distinct from
     * {@link textWatermark} (single-input text overlay).
     */
    watermark(overlay: Recipe, options?: Record<string, unknown>): WatermarkedRecipe;
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
    toWorkflowPayload(fileId: string, callbackUrl?: string): WorkflowCreatePayload;
    /** The result-addressing key passed to `file()`, or undefined. */
    key(): string | undefined;
    /** The number of operations chained so far (introspection / tests). */
    get stepCount(): number;
    /**
     * The captured op chain. Read by {@link FilesRecipe} to compose a shared
     * chain across many inputs without duplicating the chain-method validation.
     * @internal
     */
    get recipeSteps(): readonly RecipeStep[];
    /**
     * The primary input this recipe operates on. Read by {@link WatermarkedRecipe}
     * to lift an overlay Recipe's input (for upload + media inference + src-job
     * lowering) without making the ctor field public.
     * @internal
     */
    get recipeInput(): FileInput;
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
    run(options?: {
        maxWait?: string | number;
        onProgress?: (event: ProgressEvent) => void;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<RunResult>;
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
    submit(webhook?: string, options?: {
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<Handle>;
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
    private _uploadAndCreate;
    private withStep;
    private lowerStep;
    private lowerCompressOptions;
    /** Media of the original input (no chain context) — used by the probe gate. */
    private inputMedia;
    /**
     * The media class a `compress` step at `uptoIndex` actually operates on. With no
     * chain context (`uptoIndex` undefined) this is the original input's media. With
     * context, FOLD the preceding `convert` steps: each `convert(output_format)` changes
     * the media the next step sees (56N4chXY / N8eESzQN — a chain like
     * `mp3 -> convert(flac) -> compress` must resolve against flac, not mp3). Reuses the
     * synthetic-filename detection precedent from {@link MergedRecipe} (`merged.<ext>`).
     */
    private compressMediaHint;
    /**
     * Whether the media a `compress` step at `uptoIndex` operates on is lossless audio.
     * Determined by the most recent preceding `convert` target (`flac`/`wav` -> lossless)
     * when there is one, else by the original input. Lossless is unaffected by the
     * video/ogg guard (ogg is never lossless either way).
     */
    private compressAudioLossless;
}
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
export declare const WATERMARK_CAPABILITY: {
    readonly image_watermark: {
        readonly image: {
            readonly mimes: readonly ["image/jpeg", "image/png", "image/webp"];
            readonly availability: "stable";
        };
        readonly image_gif: {
            readonly mimes: readonly ["image/gif"];
            readonly availability: "planned";
        };
    };
    readonly video_watermark: {
        readonly video: {
            readonly mimes: readonly ["video/mp4", "video/webm"];
            readonly availability: "beta";
        };
    };
};
/** Wire op types the file-first `watermark()` verb can route to. */
export type WatermarkWireOp = 'image_watermark' | 'video_watermark';
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
export declare class FilesRecipe {
    private readonly inputs;
    private readonly steps;
    private readonly presetDefaults?;
    private readonly scopedPresetDefaults?;
    private readonly client?;
    constructor(inputs: readonly FileInput[], steps?: readonly RecipeStep[], presetDefaults?: PresetDefaults | undefined, scopedPresetDefaults?: PresetDefaults | undefined, client?: GislClient | undefined);
    /**
     * Reduce file size on every input. `optimize` selects a per-media preset
     * (resolved per file at lower-time, so each input's extension picks its own
     * preset). Reuses {@link Recipe}'s validation — a directly-constructed
     * lowering builds an internal Recipe that throws the same `GislConfigError`.
     */
    compress(optimize?: OptimizeFor, options?: Record<string, unknown>): FilesRecipe;
    /** Change every input's format. `format` lowers to the contract `output_format` wire key (via {@link Recipe.convert}), NOT `format`. */
    convert(format: string, options?: Record<string, unknown>): FilesRecipe;
    /** Generate a preview of every input. Omitted dimensions are dropped from the wire options. */
    thumbnail(options?: {
        width?: number;
        height?: number;
    } & Record<string, unknown>): FilesRecipe;
    /** Apply the same text watermark to every input. */
    textWatermark(text: string, options?: Record<string, unknown>): FilesRecipe;
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
    merge(options?: MergeOptions): MergedRecipe;
    /**
     * Bundle the inputs into ONE archive (N→1, zip / tar.gz) — media-agnostic,
     * inputs may mix types. Returns a terminal {@link ArchivedRecipe} (a zip is
     * the final artefact — no post-bundle chain). `format` / `folderStructure` are
     * optional; the server defaults to zip + flat.
     *
     * `archive()` must be the FIRST op on `files([...])` → `GislConfigError` reason
     * `pre_archive_ops_unsupported` otherwise.
     */
    archive(options?: ArchiveRecipeOptions): ArchivedRecipe;
    /** The number of inputs in this fan-out (introspection / tests). */
    get inputCount(): number;
    /** The number of operations chained so far (introspection / tests). */
    get stepCount(): number;
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
    toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload;
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
    run(options?: {
        maxWait?: string | number;
        onProgress?: (event: ProgressEvent) => void;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<RunResult>;
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
    submit(webhook?: string, options?: {
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<Handle>;
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
    private _uploadAllAndCreate;
    /**
     * The shared single-file {@link Recipe} that captures the op chain (input is
     * a placeholder — only the steps are read). Reuses Recipe's op-chain
     * validation + coercion so a `FilesRecipe.compress(bad)` throws the identical
     * `GislConfigError` as `Recipe.compress(bad)`.
     */
    private baseRecipe;
    private withStep;
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
export declare class MergedRecipe {
    private readonly inputs;
    private readonly mergeOptions;
    private readonly postSteps;
    private readonly presetDefaults?;
    private readonly scopedPresetDefaults?;
    private readonly client?;
    constructor(inputs: readonly FileInput[], mergeOptions: MergeOptions, postSteps?: readonly RecipeStep[], presetDefaults?: PresetDefaults | undefined, scopedPresetDefaults?: PresetDefaults | undefined, client?: GislClient | undefined);
    /** Reduce the merged output's size. See {@link Recipe.compress}. */
    compress(optimize?: OptimizeFor, options?: Record<string, unknown>): MergedRecipe;
    /** Change the merged output's format. See {@link Recipe.convert}. */
    convert(format: string, options?: Record<string, unknown>): MergedRecipe;
    /** Thumbnail the merged output. Omitted dimensions are dropped from the wire options. */
    thumbnail(options?: {
        width?: number;
        height?: number;
    } & Record<string, unknown>): MergedRecipe;
    /**
     * Lower to the merge DAG: one `passthrough` source job per input + one
     * `merge` job whose `operations[]` is `[merge, ...post-combine ops]`. The
     * merge job's `inputs[]` consume the source jobs via `job_output` in input
     * (play) order.
     *
     * @internal Consumed by {@link run} (after uploading all inputs), {@link submit}
     *   (with a webhook), and the cross-language parity harness (with fixed ids).
     */
    toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload;
    /** The number of inputs being combined (introspection / tests). */
    get inputCount(): number;
    /** The number of post-combine ops chained so far (introspection / tests). */
    get stepCount(): number;
    /**
     * Execute end-to-end: upload every input, create the merge workflow, await a
     * terminal state (SSE with poll fallback), then resolve ONLY the merged output
     * into a {@link RunResult}. Throws {@link GislTimeoutError} on `maxWait`.
     *
     * Requires a client bound at construction time — `gisl().files(...).merge(...)`
     * wires it; a directly-constructed `MergedRecipe` throws {@link GislConfigError}.
     * Mirrors the single-file {@link Recipe.run}.
     */
    run(options?: {
        maxWait?: string | number;
        onProgress?: (event: ProgressEvent) => void;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<RunResult>;
    /**
     * Fire-and-forget: upload + create the merge workflow (wiring `webhook` into
     * `callback_url` when given), return a client-bound {@link Handle}. Does NOT
     * wait for terminal status. Mirrors {@link Recipe.submit}.
     *
     * @param webhook Absolute callback URL the server POSTs lifecycle events to.
     * @param options Opt-out / tune the best-effort video probe-before-create
     *   (2nd optional param so the positional `webhook` arg stays compatible).
     */
    submit(webhook?: string, options?: {
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<Handle>;
    /**
     * Upload every input (verbatim for a pre-uploaded id; uploading a path / blob
     * otherwise, emitting `{phase:'upload'}` progress) then create ONE merge
     * workflow. Rejects fewer than 2 inputs BEFORE any upload fires. Shared first
     * half of {@link run} + {@link submit}.
     */
    private _uploadAllAndCreate;
    /**
     * Reject an invalid combine BEFORE any upload fires — mirrors the operation-
     * first `MergeBuilder.planSequence()` bounds so a typo'd merge costs no
     * bandwidth: 2–10 inputs (merge schema `min/max_inputs`), and an image merge
     * must carry an explicit `output_type` (the server rejects image merges
     * without one). Shared by {@link run} + {@link submit} via
     * {@link _uploadAllAndCreate}.
     */
    private validatePreUpload;
    /**
     * Lower the post-combine chain by composing a single-file {@link Recipe} over a
     * synthetic input whose extension matches the merged OUTPUT media — so
     * `compress(optimize)` resolves the correct preset for the merged result (it
     * needs a media hint, which a merge output carries no filename for). Reuses
     * Recipe's `lowerStep` rather than duplicating it.
     */
    private lowerPostSteps;
    /**
     * The merged-output media. Honours an explicit {@link MergeOptions.mediaKind};
     * otherwise infers from the first PATH input's extension (mirrors
     * {@link MergeBuilder}); defaults to video.
     */
    private inferMediaKind;
    private outputExtensionFor;
    private withStep;
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
export declare class ArchivedRecipe {
    private readonly inputs;
    private readonly options;
    private readonly client?;
    constructor(inputs: readonly FileInput[], options?: ArchiveRecipeOptions, client?: GislClient | undefined);
    /** The number of inputs being bundled (introspection / tests). */
    get inputCount(): number;
    /**
     * Lower to the archive DAG: one `passthrough` source job per input + one
     * `archive` job consuming them via `job_output`.
     *
     * @internal Consumed by {@link run} / {@link submit} (after uploading) and the
     *   cross-language parity harness (with fixed ids).
     */
    toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload;
    /**
     * Execute end-to-end: upload every input, create the archive workflow, await a
     * terminal state (SSE with poll fallback), then resolve ONLY the archive output
     * into a {@link RunResult}. Throws {@link GislTimeoutError} on `maxWait`.
     * Requires a client bound via `gisl().files(...).archive(...)`.
     */
    run(options?: {
        maxWait?: string | number;
        onProgress?: (event: ProgressEvent) => void;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<RunResult>;
    /**
     * Fire-and-forget: upload + create the archive workflow (wiring `webhook` into
     * `callback_url` when given), return a client-bound {@link Handle}. Mirrors
     * {@link MergedRecipe.submit}.
     *
     * @param webhook Absolute callback URL the server POSTs lifecycle events to.
     * @param options Opt-out / tune the best-effort video probe-before-create
     *   (2nd optional param so the positional `webhook` arg stays compatible).
     */
    submit(webhook?: string, options?: {
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<Handle>;
    private _uploadAllAndCreate;
    /**
     * Reject an invalid bundle BEFORE any upload fires — the archive schema allows
     * 2–50 inputs (`min/max_inputs`), so a typo'd bundle costs no bandwidth.
     */
    private validatePreUpload;
    /**
     * Project the archive options into the wire shape. Both fields are optional
     * (the server defaults `format` to zip and `folder_structure` to flat), so an
     * omitted option is dropped rather than sent.
     */
    private wireArchiveOptions;
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
export declare class WatermarkedRecipe {
    private readonly baseInput;
    private readonly baseSteps;
    private readonly overlay;
    private readonly watermarkOptions;
    private readonly postSteps;
    private readonly presetDefaults?;
    private readonly scopedPresetDefaults?;
    private readonly client?;
    constructor(baseInput: FileInput, baseSteps: readonly RecipeStep[], overlay: Recipe, watermarkOptions: Readonly<Record<string, unknown>>, postSteps?: readonly RecipeStep[], presetDefaults?: PresetDefaults | undefined, scopedPresetDefaults?: PresetDefaults | undefined, client?: GislClient | undefined);
    /** Reduce the watermarked output's size. See {@link Recipe.compress}. */
    compress(optimize?: OptimizeFor, options?: Record<string, unknown>): WatermarkedRecipe;
    /** Change the watermarked output's format. See {@link Recipe.convert}. */
    convert(format: string, options?: Record<string, unknown>): WatermarkedRecipe;
    /** Thumbnail the watermarked output. Omitted dimensions are dropped from the wire options. */
    thumbnail(options?: {
        width?: number;
        height?: number;
    } & Record<string, unknown>): WatermarkedRecipe;
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
    toWorkflowPayload(fileIds: readonly string[], callbackUrl?: string): WorkflowCreatePayload;
    /** The number of post-watermark ops chained so far (introspection / tests). */
    get stepCount(): number;
    /**
     * Execute end-to-end: upload base + overlay, create the watermark workflow,
     * await terminal (SSE with poll fallback), then resolve ONLY the watermark
     * output into a {@link RunResult}. Requires a client bound at construction.
     * Mirrors {@link MergedRecipe.run}.
     */
    run(options?: {
        maxWait?: string | number;
        onProgress?: (event: ProgressEvent) => void;
        signal?: AbortSignal;
        pollIntervalMs?: number;
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<RunResult>;
    /**
     * Fire-and-forget: upload base + overlay + create the watermark workflow
     * (wiring `webhook` into `callback_url` when given), return a client-bound
     * {@link Handle}. Does NOT wait for terminal status. Mirrors {@link MergedRecipe.submit}.
     */
    submit(webhook?: string, options?: {
        probeBeforeCreate?: boolean;
        probeTimeoutMs?: number;
    }): Promise<Handle>;
    /** Base + overlay inputs, in upload/lowering order (`[base, overlay]`). */
    private inputsInOrder;
    /**
     * Validate the watermark BEFORE any upload: the base must route to a shippable
     * wire op (throws for undetectable/unsupported/planned bases), and the overlay
     * must be an image. Shared by {@link run}/{@link submit}. Mirrors
     * {@link MergedRecipe.validatePreUpload}.
     */
    private validatePreUpload;
    /**
     * Upload base + overlay (verbatim for a pre-uploaded id; uploading a path /
     * blob otherwise) then create ONE watermark workflow. Validates pre-upload.
     * Shared first half of {@link run} + {@link submit}; mirrors
     * {@link MergedRecipe._uploadAllAndCreate}.
     */
    private _uploadAllAndCreate;
    /**
     * Lower the post-watermark chain over a synthetic input whose extension
     * matches the watermark OUTPUT media (image→png, video→mp4) so
     * `compress(optimize)` resolves the correct preset — mirrors
     * {@link MergedRecipe.lowerPostSteps}.
     */
    private lowerPostSteps;
    private withStep;
}
export {};
