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
import type { OperationDownload, WorkflowStatusResponse, SseOperationProgressDataStatusEnum } from '@giveitsmaller/contracts/openapi';
import { Handle } from './handle.js';
import type { PresetDefaults, DetectedMedia } from './ergonomic/presets/index.js';
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
export declare function _detectCompressMedia(input: string | Blob): DetectedMedia | undefined;
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
export declare function _detectAudioLossless(input: string | Blob): boolean;
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
/**
 * Captures the (op-type, input, options) tuple for one ergonomic-layer
 * operation call. Holds a reference to the underlying `GislClient`;
 * does NOT extend or subclass it. Calling `.run()` or `.submit()`
 * triggers the orchestration; the builder itself is inert until then.
 */
export declare class OperationBuilder {
    private readonly client;
    private readonly opType;
    private readonly input;
    private readonly opOptions;
    /**
     * Client-scope preset defaults wired through `wrapErgonomic` from
     * `gisl.create({ presetDefaults })` (T4b). When provided AND the
     * op type is `compress`, `run()`/`submit()` walk the preset
     * resolver before constructing the workflow payload. `undefined`
     * preserves the pre-T4b behaviour: pass `opOptions` through
     * verbatim.
     */
    private readonly presetDefaults?;
    /**
     * Scoped preset defaults from `client.withPresetDefaults(...)`
     * (T4c — `ULAlOP6j`). Layered between `presetDefaults` and per-call
     * `presetOverrides` in the resolver chain. `undefined` on clients
     * that haven't been through a `withPresetDefaults` call. The
     * derived ergonomic client's Proxy closes over the merged stack
     * (parent's scoped ⊕ new defaults via `PresetDefaults.merge`).
     */
    private readonly scopedPresetDefaults?;
    constructor(client: GislClient, opType: string, input: string | Blob, opOptions: Record<string, unknown>, 
    /**
     * Client-scope preset defaults wired through `wrapErgonomic` from
     * `gisl.create({ presetDefaults })` (T4b). When provided AND the
     * op type is `compress`, `run()`/`submit()` walk the preset
     * resolver before constructing the workflow payload. `undefined`
     * preserves the pre-T4b behaviour: pass `opOptions` through
     * verbatim.
     */
    presetDefaults?: PresetDefaults | undefined, 
    /**
     * Scoped preset defaults from `client.withPresetDefaults(...)`
     * (T4c — `ULAlOP6j`). Layered between `presetDefaults` and per-call
     * `presetOverrides` in the resolver chain. `undefined` on clients
     * that haven't been through a `withPresetDefaults` call. The
     * derived ergonomic client's Proxy closes over the merged stack
     * (parent's scoped ⊕ new defaults via `PresetDefaults.merge`).
     */
    scopedPresetDefaults?: PresetDefaults | undefined);
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
    private _resolve;
    /**
     * Execute the operation end-to-end. Uploads the input, creates the
     * workflow, waits to a terminal status (via SSE with poll fallback),
     * fetches downloads, and projects to a flat `Result`. Throws
     * `GislTimeoutError` if `maxWait` elapses before terminal status.
     */
    /**
     * 99Da2uyx: refuse, BEFORE the upload, an option value the contract marks
     * `planned` everywhere it can apply (see ergonomic/planned_values.ts). The API
     * would refuse it at create with `feature_not_available`, after the bytes had
     * gone up; this is the same refusal, earlier, with the same reason.
     */
    private _refusePlannedValues;
    run(options?: RunOptions): Promise<Result>;
    /**
     * Fire-and-forget: upload the input + create the workflow with a
     * `callback_url` wired to the supplied `webhook`, then return a
     * `Handle` (workflowId + webhookSecret) without waiting. The webhook
     * receives completion + the `webhookSecret` is the verifier seed.
     */
    submit(options?: SubmitOptions): Promise<Handle>;
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
    mapEach(fn: (artifact: ArtifactRef) => OperationBuilder): MapEachBuilder;
    private awaitTerminal;
}
export declare class MapEachBuilder {
    private readonly parent;
    private readonly fn;
    constructor(parent: OperationBuilder, fn: (artifact: ArtifactRef) => OperationBuilder);
    /**
     * Run the parent builder to completion, then fan out the fn over each
     * resulting artifact. The deadline (maxWait) covers the parent's full
     * run + every child's full run — each child sees the REMAINING budget
     * after the parent and prior children completed. Signal aborts cascade.
     */
    run(options?: RunOptions): Promise<Result>;
}
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
export declare function _clampPollIntervalMs(requested: number | undefined): number;
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export declare function _consumeSseToTerminal(client: GislClient, args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    onProgress: ((event: ProgressEvent) => void) | undefined;
}): Promise<WorkflowStatusResponse>;
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export declare function _pollToTerminal(client: GislClient, args: {
    workflowId: string;
    deadline: number;
    signal: AbortSignal | undefined;
    pollIntervalMs?: number;
}): Promise<WorkflowStatusResponse>;
/** @internal — exported for reuse by `merge.ts` (T3) and future builders.
 *
 * T4b adds the optional `resolvedOptionsOverride` argument. When provided,
 * it supplants the placeholder ResolvedOptions the projector would
 * otherwise emit. `MergeBuilder` and other non-resolver builders omit
 * this argument and receive the legacy placeholder shape unchanged
 * (back-compat — merge does NOT go through the preset resolver in T4b).
 */
export declare function _projectResult(status: WorkflowStatusResponse, jobDownloads: readonly {
    ref: string;
    jobId: string;
    files: readonly OperationDownload[];
}[], appliedOptions: Record<string, unknown>, resolvedOptionsOverride?: ResolvedOptions): Result;
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export declare function _checkAborted(signal: AbortSignal | undefined): void;
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
export declare function _cappedProbeTimeoutMs(probeTimeoutMs: number | undefined, deadline: number | undefined): number | undefined;
/**
 * Parse a `maxWait` argument: number = milliseconds; string with suffix
 * `ms` / `s` / `m` / `h`. Throws if the string is malformed.
 */
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export declare function _parseMaxWait(value: string | number): number;
