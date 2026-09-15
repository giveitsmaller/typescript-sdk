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
import { DEFAULT_POLL_TIMEOUT_MS } from './client.js';
import { SseEventType, SseOperationProgressDataFromJSON, } from '@giveitsmaller/contracts/openapi';
import { uploadSource } from './types.js';
import { GislTimeoutError, GislFanOutTimeoutError, GislNetworkError, GislStreamHostNotDeclaredError, GislTransportError, SseEndedWithoutTerminal } from './errors.js';
// Deferred-usage-only import: `Handle` is constructed inside submit() at call
// time, not at module load, so the builder.ts <-> handle.ts cycle is safe
// under ESM (handle.ts imports the await-primitives from this module).
import { Handle } from './handle.js';
import { resolveCompressOptions, } from './ergonomic/preset_resolver.js';
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
export function _detectCompressMedia(input) {
    let filename;
    let mime;
    if (typeof input === 'string') {
        filename = input;
    }
    else {
        mime = input.type !== '' ? input.type : undefined;
        const named = input.name;
        if (typeof named === 'string')
            filename = named;
    }
    // MIME-first if present — Blob.type is canonical.
    if (mime !== undefined) {
        if (mime.startsWith('image/'))
            return 'image';
        if (mime.startsWith('audio/'))
            return 'audio';
        if (mime.startsWith('video/'))
            return 'video';
        if (mime === 'application/epub+zip')
            return 'document_epub';
        if (mime === 'application/pdf')
            return 'document_pdf';
        if (mime === 'application/vnd.oasis.opendocument.text' ||
            mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
            mime === 'application/vnd.oasis.opendocument.presentation') {
            return 'document_odf';
        }
        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
            mime === 'application/msword' ||
            mime === 'application/vnd.ms-excel' ||
            mime === 'application/vnd.ms-powerpoint') {
            return 'document_office';
        }
    }
    if (filename === undefined)
        return undefined;
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === undefined)
        return undefined;
    if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'tif', 'bmp', 'heic', 'heif'].includes(ext))
        return 'image';
    if (['mp3', 'aac', 'm4a', 'ogg', 'oga', 'flac', 'wav', 'opus'].includes(ext))
        return 'audio';
    if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'm4v'].includes(ext))
        return 'video';
    if (ext === 'epub')
        return 'document_epub';
    if (ext === 'pdf')
        return 'document_pdf';
    if (['odt', 'ods', 'odp'].includes(ext))
        return 'document_odf';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext))
        return 'document_office';
    return undefined;
}
// LOSSLESS audio per the compress.yaml contract (contracts iakhSy3E) —
// flac/wav ONLY. Everything else audio (mp3/mpeg, aac, ogg, m4a/mp4, opus)
// and any unknown input is treated as lossy so the shipped-preset bitrate is
// kept. `aiff` is deliberately absent — not a contract audio format.
const LOSSLESS_AUDIO_MIMES = new Set([
    'audio/flac',
    'audio/x-flac',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
]);
const LOSSLESS_AUDIO_EXTENSIONS = new Set(['flac', 'wav']);
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
export function _detectAudioLossless(input) {
    let filename;
    let mime;
    if (typeof input === 'string') {
        filename = input;
    }
    else {
        mime = input.type !== '' ? input.type : undefined;
        const named = input.name;
        if (typeof named === 'string')
            filename = named;
    }
    // MIME-first if a recognised audio MIME is present — Blob.type is canonical.
    // Strip any MIME parameters (`audio/flac; codecs=flac`) before the exact-set
    // lookup so a parameterised type still classifies as lossless — `media` is
    // already `audio` via the prefix check, so a miss would wrongly keep the
    // bitrate (codex 18b6b684).
    if (mime !== undefined && mime.startsWith('audio/')) {
        const bareMime = mime.split(';')[0].trim().toLowerCase();
        return LOSSLESS_AUDIO_MIMES.has(bareMime);
    }
    if (filename === undefined)
        return false;
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === undefined)
        return false;
    return LOSSLESS_AUDIO_EXTENSIONS.has(ext);
}
// ---------------------------------------------------------------------------
// OperationBuilder
// ---------------------------------------------------------------------------
/**
 * Captures the (op-type, input, options) tuple for one ergonomic-layer
 * operation call. Holds a reference to the underlying `GislClient`;
 * does NOT extend or subclass it. Calling `.run()` or `.submit()`
 * triggers the orchestration; the builder itself is inert until then.
 */
export class OperationBuilder {
    client;
    opType;
    input;
    opOptions;
    presetDefaults;
    scopedPresetDefaults;
    constructor(client, opType, 
    // Widened to match `GislClient.uploadFile`'s `string | Blob` parameter
    // (codex r1 low 89cae59f4f04 — Blob/File uploads supported by the low-
    // level SDK must type-check through the ergonomic surface too).
    input, opOptions, 
    /**
     * Client-scope preset defaults wired through `wrapErgonomic` from
     * `gisl.create({ presetDefaults })` (T4b). When provided AND the
     * op type is `compress`, `run()`/`submit()` walk the preset
     * resolver before constructing the workflow payload. `undefined`
     * preserves the pre-T4b behaviour: pass `opOptions` through
     * verbatim.
     */
    presetDefaults, 
    /**
     * Scoped preset defaults from `client.withPresetDefaults(...)`
     * (T4c — `ULAlOP6j`). Layered between `presetDefaults` and per-call
     * `presetOverrides` in the resolver chain. `undefined` on clients
     * that haven't been through a `withPresetDefaults` call. The
     * derived ergonomic client's Proxy closes over the merged stack
     * (parent's scoped ⊕ new defaults via `PresetDefaults.merge`).
     */
    scopedPresetDefaults) {
        this.client = client;
        this.opType = opType;
        this.input = input;
        this.opOptions = opOptions;
        this.presetDefaults = presetDefaults;
        this.scopedPresetDefaults = scopedPresetDefaults;
    }
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
    _resolve() {
        if (this.opType !== 'compress') {
            return { wireOptions: { ...this.opOptions } };
        }
        const media = _detectCompressMedia(this.input);
        if (media === undefined) {
            // Unknown media (e.g. Blob without a recognised filename
            // extension) — fall back to passthrough. The wire will still
            // accept the call, just no preset resolution.
            return { wireOptions: { ...this.opOptions } };
        }
        const { optimize, presetOverrides, ...explicitOptions } = this.opOptions;
        const input = {
            media,
            op: 'compress',
            explicitOptions,
        };
        if (media === 'audio') {
            input.audioLossless = _detectAudioLossless(this.input);
        }
        if (this.presetDefaults !== undefined) {
            input.presetDefaults = this.presetDefaults;
        }
        if (this.scopedPresetDefaults !== undefined) {
            input.scopedPresetDefaults = this.scopedPresetDefaults;
        }
        if (presetOverrides !== undefined) {
            input.presetOverrides = presetOverrides;
        }
        if (optimize !== undefined) {
            input.optimize = optimize;
        }
        return resolveCompressOptions(input);
    }
    /**
     * Execute the operation end-to-end. Uploads the input, creates the
     * workflow, waits to a terminal status (via SSE with poll fallback),
     * fetches downloads, and projects to a flat `Result`. Throws
     * `GislTimeoutError` if `maxWait` elapses before terminal status.
     */
    async run(options = {}) {
        const deadline = Date.now() + _parseMaxWait(options.maxWait ?? DEFAULT_POLL_TIMEOUT_MS);
        const signal = options.signal;
        const onProgress = options.onProgress;
        const useSSE = options.useSSE ?? true;
        // 0. Resolve presets FIRST so a GislConfigError fails the call
        // before any I/O — the SDK promised fail-early for invalid combos.
        const resolved = this._resolve();
        // 1. Upload — emits {phase:'upload'} progress events from byte-counter.
        const uploadOpts = { signal };
        if (onProgress !== undefined) {
            uploadOpts.onProgress = (uploadedBytes, totalBytes) => {
                onProgress({ phase: 'upload', uploadedBytes, totalBytes });
            };
        }
        const uploadResp = await this.client.uploadFile(this.input, uploadOpts);
        _checkAborted(signal);
        // Codex r2 medium 9a117f04eb59 — check deadline AFTER upload so a slow
        // upload doesn't proceed to createWorkflow past the caller's deadline.
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Upload completed but maxWait elapsed before workflow could be created`);
        }
        // Best-effort probe-before-create for a multipart video upload (never-bounce).
        // Capped to the remaining maxWait budget so a slow probe cannot push
        // createWorkflow past the caller's deadline.
        await this.client.maybeWaitForVideoProbe(uploadResp.fileId, {
            enabled: options.probeBeforeCreate ?? true,
            isVideo: _detectCompressMedia(this.input) === 'video',
            sizeBytes: uploadResp.sizeBytes,
            timeoutMs: _cappedProbeTimeoutMs(options.probeTimeoutMs, deadline),
            signal,
        });
        // A cancel arriving during the FINAL successful probe request must not still
        // create the workflow (maybeWaitForVideoProbe returns landed without a final
        // abort re-check), so check here BEFORE createWorkflow.
        _checkAborted(signal);
        // RE-CHECK the deadline AFTER the probe wait (it consumes time).
        if (Date.now() >= deadline) {
            throw new GislTimeoutError('Probe wait completed but maxWait elapsed before workflow could be created');
        }
        // 2. Build + create the workflow.
        const job = {
            id: 'op',
            source: uploadSource(uploadResp.fileId),
            operations: [{ type: this.opType, options: resolved.wireOptions }],
        };
        const payload = { jobs: [job] };
        const created = await this.client.createWorkflow(payload);
        _checkAborted(signal);
        // 3. Wait to terminal status.
        const finalStatus = await this.awaitTerminal({
            workflowId: created.workflowId,
            deadline,
            signal,
            onProgress,
            useSSE,
            pollIntervalMs: options.pollIntervalMs,
        });
        // 4. Fetch downloads + project. Codex r1 medium 42a6ea3b6102 — the
        // `maxWait` deadline covers upload + create + wait + downloads, so check
        // the deadline before issuing the downloads request rather than letting
        // a slow getWorkflowDownloads silently exceed it.
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`, created.workflowId);
        }
        const downloads = await this.client.getWorkflowDownloads(created.workflowId);
        // TDqmkWpX: the maxWait deadline also covers the downloads fetch itself — a
        // slow getWorkflowDownloads must not return a success after the advertised
        // whole-run deadline. Re-check AFTER the call (the check above is BEFORE).
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`, created.workflowId);
        }
        return _projectResult(finalStatus, downloads.downloads, resolved.wireOptions, resolved.resolvedOptions);
    }
    /**
     * Fire-and-forget: upload the input + create the workflow with a
     * `callback_url` wired to the supplied `webhook`, then return a
     * `Handle` (workflowId + webhookSecret) without waiting. The webhook
     * receives completion + the `webhookSecret` is the verifier seed.
     */
    async submit(options = {}) {
        // Resolve presets before any I/O so a GislConfigError fails the
        // call before the upload — same fail-early contract as run().
        const resolved = this._resolve();
        const uploadResp = await this.client.uploadFile(this.input);
        // Best-effort probe-before-create for a multipart video upload (never-bounce).
        await this.client.maybeWaitForVideoProbe(uploadResp.fileId, {
            enabled: options.probeBeforeCreate ?? true,
            isVideo: _detectCompressMedia(this.input) === 'video',
            sizeBytes: uploadResp.sizeBytes,
            timeoutMs: options.probeTimeoutMs,
        });
        const job = {
            id: 'op',
            source: uploadSource(uploadResp.fileId),
            operations: [{ type: this.opType, options: resolved.wireOptions }],
        };
        // ⚠️ OMIT THE KEY, do not set it to `undefined`. `JSON.stringify` drops an
        // undefined value so the wire is the same either way — but an own property
        // that exists with no value makes `'callback_url' in payload` TRUE, so any
        // test asserting omission by key passes vacuously (codex 4763eb48189a).
        const payload = {
            jobs: [job],
            ...(options.webhook !== undefined ? { callback_url: options.webhook } : {}),
        };
        const created = await this.client.createWorkflow(payload);
        // ⚠️ THE CLIENT IS THE POINT (36AZ98FV). Without it the returned Handle's
        // status()/wait()/result() throw `no_client`, which made `webhook` the only
        // channel for this call's outcome and is why it used to be mandatory. The
        // file-first path has always passed it (`file-first.ts`); the operation-first
        // path did not, which is the same "demands what file-first does not" defect
        // this ticket is about, one layer down.
        return new Handle(created.workflowId, created.webhookSecret != null ? created.webhookSecret : undefined, this.client, null);
    }
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
    mapEach(fn) {
        return new MapEachBuilder(this, fn);
    }
    // -------------------------------------------------------------------------
    async awaitTerminal(args) {
        if (args.useSSE) {
            try {
                return await _consumeSseToTerminal(this.client, args);
            }
            catch (err) {
                // TDqmkWpX: poll-fallback ONLY on a clean SSE stream-end
                // (SseEndedWithoutTerminal) or a typed transport error (GislNetworkError).
                // Everything else — timeout, abort, API error, an onProgress callback
                // throw, anything unexpected — MUST propagate; re-issuing the same doomed
                // request via poll would mask the real failure.
                if (!(err instanceof SseEndedWithoutTerminal ||
                    err instanceof GislNetworkError ||
                    // VUozk5Bc: no stream host is DECLARED for this configuration (a
                    // configuration nothing declares; both named environments resolve as of
                    // contracts v2.195.0). That is not a failure to recover from,
                    // it is SSE being unavailable here, and polling is a working
                    // transport. Failing hard instead would strand every caller on a host
                    // nobody has declared yet. A DIRECT `streamEvents` caller still gets
                    // the hard error — they asked for the stream specifically; a `run()`
                    // caller asked for a result.
                    err instanceof GislStreamHostNotDeclaredError)) {
                    throw err;
                }
                // Genuine SSE stream-end / transport error — fall through to poll fallback.
            }
        }
        return await _pollToTerminal(this.client, args);
    }
}
// ---------------------------------------------------------------------------
// MapEachBuilder — fan-out chain over a parent's artifacts.
// ---------------------------------------------------------------------------
export class MapEachBuilder {
    parent;
    fn;
    constructor(parent, fn) {
        this.parent = parent;
        this.fn = fn;
    }
    /**
     * Run the parent builder to completion, then fan out the fn over each
     * resulting artifact. The deadline (maxWait) covers the parent's full
     * run + every child's full run — each child sees the REMAINING budget
     * after the parent and prior children completed. Signal aborts cascade.
     */
    async run(options = {}) {
        const deadline = Date.now() + _parseMaxWait(options.maxWait ?? DEFAULT_POLL_TIMEOUT_MS);
        // 1. Run the parent.
        const remainingForParent = Math.max(1, deadline - Date.now());
        const parentResult = await this.parent.run({
            ...options,
            maxWait: remainingForParent,
        });
        // 2. Fan out the fn over each artifact, sequentially. The downstream
        //    server may parallelise workflows on its end; we serialise here for
        //    deterministic semantics + easier abort/error propagation.
        const collectedArtifacts = [];
        const collectedJobs = [];
        const collectedChildResults = [];
        for (const art of parentResult.artifacts) {
            _checkAborted(options.signal);
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                // Clean timeout BETWEEN children (no child in flight): the parent + the
                // children completed so far are recoverable — carry their ids so the
                // caller polls them and re-runs ONLY the never-created children (4G4FaA9X).
                throw new GislFanOutTimeoutError(`maxWait elapsed during fan-out (after ${collectedChildResults.length} child runs)`, {
                    completedWorkflowIds: collectedChildResults.map((r) => r.workflowId),
                    parentWorkflowId: parentResult.workflowId,
                });
            }
            const childBuilder = this.fn(art);
            let childResult;
            try {
                childResult = await childBuilder.run({
                    ...options,
                    maxWait: remaining,
                });
            }
            catch (err) {
                // A CHILD's own deadline elapsed mid-run — the COMMON fan-out timeout
                // path. Re-throw as a fan-out timeout so the parent + already-completed
                // children + this in-flight child are ALL recoverable, instead of losing
                // them behind the child's bare GislTimeoutError (4G4FaA9X). Other errors
                // (config / API / item failure) propagate unchanged.
                if (err instanceof GislTimeoutError) {
                    throw new GislFanOutTimeoutError(`maxWait elapsed during fan-out while a child was running (${collectedChildResults.length} completed)`, {
                        completedWorkflowIds: collectedChildResults.map((r) => r.workflowId),
                        parentWorkflowId: parentResult.workflowId,
                        workflowId: err.workflowId,
                        cause: err,
                    });
                }
                throw err;
            }
            collectedChildResults.push(childResult);
            for (const childArt of childResult.artifacts)
                collectedArtifacts.push(childArt);
            for (const childJob of childResult.jobs)
                collectedJobs.push(childJob);
        }
        // 3. Build a combined Result. workflowId is the parent's (codex r1
        //    medium ba14b2cebf47 — child workflowIds preserved on
        //    childWorkflowIds for inspection). Status aggregates worst-of
        //    parent + children (codex r1 HIGH 88e7186edc9a — previously
        //    always reported parent.status, masking failed children).
        const childWorkflowIds = collectedChildResults.map((r) => r.workflowId);
        const allStatuses = [parentResult.status, ...collectedChildResults.map((r) => r.status)];
        const aggregateStatus = aggregateWorkflowStatus(allStatuses);
        const combined = {
            workflowId: parentResult.workflowId,
            status: aggregateStatus,
            ...(parentResult.createdAt !== undefined ? { createdAt: parentResult.createdAt } : {}),
            ...(parentResult.updatedAt !== undefined ? { updatedAt: parentResult.updatedAt } : {}),
            artifacts: collectedArtifacts,
            jobs: [...parentResult.jobs, ...collectedJobs],
            ...(collectedArtifacts.length === 1 ? { url: collectedArtifacts[0].url } : {}),
            resolvedOptions: parentResult.resolvedOptions,
            childWorkflowIds,
        };
        return combined;
    }
}
/**
 * Aggregate the worst-of N workflow statuses for a fan-out combined Result.
 * Precedence: failed > expired > paused_insufficient_credits > cancelled >
 * partially_failed > completed (anything not in this order falls through
 * as the original parent status — defensive default).
 */
function aggregateWorkflowStatus(statuses) {
    const order = [
        'failed',
        'expired',
        'paused_insufficient_credits',
        'cancelled',
        'partially_failed',
        'completed',
    ];
    for (const candidate of order) {
        if (statuses.includes(candidate))
            return candidate === 'completed' && statuses.every((s) => s === 'completed') ? 'completed' : candidate === 'completed' ? 'completed' : candidate;
    }
    return statuses[0] ?? 'completed';
}
// ---------------------------------------------------------------------------
// Internals — SSE + poll
// ---------------------------------------------------------------------------
const TERMINAL_STATUS = new Set([
    'completed',
    'failed',
    'partially_failed',
    'cancelled',
    'expired',
    'paused_insufficient_credits',
]);
/**
 * Internal marker (TDqmkWpX): tags an error thrown by the caller's `onProgress`
 * callback so the mid-stream transport-error wrap in {@link _consumeSseToTerminal}
 * cannot mistake it for a transport failure (a callback that throws a `TypeError`
 * would otherwise be wrapped as `GislNetworkError` → masked by poll-fallback).
 * The inner catch unwraps it and rethrows the ORIGINAL `cause`, so the caller
 * sees their own error and the run never silently succeeds.
 */
class _OnProgressThrew {
    cause;
    constructor(cause) {
        this.cause = cause;
    }
}
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export async function _consumeSseToTerminal(client, args) {
    const remainingMs = args.deadline - Date.now();
    if (remainingMs <= 0) {
        throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
    }
    const sseAbort = new AbortController();
    // Compose caller's signal + a SDK-internal one so we can tear down on terminal.
    const onCallerAbort = () => sseAbort.abort();
    if (args.signal !== undefined) {
        if (args.signal.aborted)
            sseAbort.abort();
        else
            args.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    // Codex r1 high 06f8dceefd76 — a quiet but still-open SSE stream would
    // block forever in `for await` since the deadline check inside the loop
    // only fires when an event arrives. Arm a remaining-time timer that
    // aborts the SSE; raise GislTimeoutError when it fires.
    let deadlineExpired = false;
    const deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        sseAbort.abort();
    }, remainingMs);
    try {
        let events;
        try {
            events = await client.streamEvents(args.workflowId, { signal: sseAbort.signal });
        }
        catch (err) {
            // If streamEvents rejected because the deadline-armed sseAbort fired
            // before/during connect, surface as timeout (not raw AbortError).
            if (deadlineExpired && err instanceof DOMException && err.name === 'AbortError') {
                throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
            }
            // TDqmkWpX: a genuine connect-phase TRANSPORT failure surfaces as a raw
            // `TypeError` from `fetch` (DNS/TCP/TLS) — wrap it as a typed
            // GislNetworkError so the await-terminal callers poll-fallback on it
            // (and ONLY on it / a clean stream-end), never on an onProgress throw.
            if (err instanceof TypeError) {
                throw new GislTransportError(`SSE connect to workflow ${args.workflowId} events failed: ${err.message}`);
            }
            throw err;
        }
        // for-await also throws if the iterator's .next() rejects (e.g. the
        // SSE generator awaiting on sseAbort.signal rejects with AbortError).
        // Same deadline-conversion guard applies to mid-stream rejections.
        try {
            for await (const event of events) {
                if (deadlineExpired) {
                    throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
                }
                if (args.onProgress !== undefined && event.event === SseEventType.operation_progress) {
                    // Codex r1 high d6485d3e35f9 — `streamEvents` yields raw snake_case
                    // wire data. Deserialise via the generator-provided FromJSON helper
                    // to map snake_case -> camelCase BEFORE projecting; otherwise
                    // `data.jobRef` / `data.operationId` are undefined at runtime.
                    const data = SseOperationProgressDataFromJSON(event.data);
                    const proj = {
                        phase: 'processing',
                        progress: data.progress,
                        jobRef: data.jobRef,
                        operationId: data.operationId,
                        ...(data.status !== undefined ? { status: data.status } : {}),
                        ...(data.stage !== undefined ? { stage: data.stage } : {}),
                        ...(data.phaseInputIndex !== undefined
                            ? { phaseInputIndex: data.phaseInputIndex }
                            : {}),
                        ...(data.phaseTotalInputs !== undefined
                            ? { phaseTotalInputs: data.phaseTotalInputs }
                            : {}),
                    };
                    // TDqmkWpX: an onProgress callback throw (ANY type, incl. TypeError)
                    // must propagate, never be mistaken for a transport failure. Tag it so
                    // the mid-stream TypeError wrap in the catch below skips it.
                    try {
                        args.onProgress(proj);
                    }
                    catch (cbErr) {
                        throw new _OnProgressThrew(cbErr);
                    }
                }
                if (event.event === SseEventType.workflow_completed ||
                    event.event === SseEventType.workflow_failed ||
                    event.event === SseEventType.workflow_partially_failed) {
                    sseAbort.abort();
                    // After terminal SSE, we still call getWorkflowStatus once for the
                    // final shape — the SSE event carries partial data, but the status
                    // endpoint is the canonical structured response.
                    return await client.getWorkflowStatus(args.workflowId);
                }
                if (Date.now() >= args.deadline) {
                    sseAbort.abort();
                    throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
                }
            }
            // Stream ended cleanly without terminal. If the deadline timer fired
            // mid-stream and triggered the abort, surface that as the timeout.
            if (deadlineExpired) {
                throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
            }
            // Otherwise it was a clean server-side close — fall back to poll. TDqmkWpX:
            // a sealed marker (not a bare Error) so callers poll ONLY on this + a typed
            // transport error, never on an onProgress callback throw.
            throw new SseEndedWithoutTerminal();
        }
        catch (innerErr) {
            // TDqmkWpX: an onProgress callback throw was tagged so it is NEVER treated
            // as a transport failure — unwrap and rethrow the ORIGINAL cause so it
            // propagates to the caller (never masked by a poll retry), even when the
            // callback threw a TypeError.
            if (innerErr instanceof _OnProgressThrew) {
                throw innerErr.cause;
            }
            // If deadline expired and the iterator rejected with AbortError, surface
            // as GislTimeoutError.
            if (deadlineExpired &&
                innerErr instanceof DOMException &&
                innerErr.name === 'AbortError') {
                throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
            }
            // A genuine mid-stream TRANSPORT failure (reader disconnect) surfaces as a
            // raw `TypeError` from the iterator — wrap as GislTransportError so callers
            // poll-fallback. (An onProgress throw was already handled above, so a
            // TypeError here is unambiguously transport.) It stays a GislNetworkError
            // by inheritance, so the poll-fallback gates below are unchanged.
            if (innerErr instanceof TypeError) {
                throw new GislTransportError(`SSE stream for workflow ${args.workflowId} failed mid-stream: ${innerErr.message}`);
            }
            throw innerErr;
        }
    }
    finally {
        clearTimeout(deadlineTimer);
        if (args.signal !== undefined) {
            args.signal.removeEventListener('abort', onCallerAbort);
        }
    }
}
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export async function _pollToTerminal(client, args) {
    // Codex r1 medium 89130e3ea75d — guard against 0/negative/NaN/Infinity
    // pollIntervalMs values that would hammer getWorkflowStatus until maxWait.
    const requested = args.pollIntervalMs;
    let intervalMs;
    if (requested === undefined) {
        intervalMs = 2_000;
    }
    else if (!Number.isFinite(requested) || requested < 100) {
        // Clamp to a safe minimum (100ms) rather than throw — small/zero/NaN
        // were almost certainly a caller mistake, but ergonomic-layer
        // shouldn't crash an otherwise valid run on this.
        intervalMs = 100;
    }
    else {
        intervalMs = requested;
    }
    while (true) {
        _checkAborted(args.signal);
        if (Date.now() >= args.deadline) {
            throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
        }
        const status = await client.getWorkflowStatus(args.workflowId);
        if (TERMINAL_STATUS.has(status.status)) {
            return status;
        }
        // Codex-reviewer P0: also check the deadline AFTER the status fetch — a
        // slow getWorkflowStatus call could put us past the deadline without the
        // pre-fetch check firing. Without this, a small `pollIntervalMs` against
        // a slow API can busy-spin past the deadline arbitrarily.
        if (Date.now() >= args.deadline) {
            throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
        }
        if (Date.now() + intervalMs >= args.deadline) {
            throw new GislTimeoutError(`Workflow ${args.workflowId} did not complete before maxWait deadline`, args.workflowId);
        }
        await sleep(intervalMs, args.signal);
    }
}
// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------
/** @internal — exported for reuse by `merge.ts` (T3) and future builders.
 *
 * T4b adds the optional `resolvedOptionsOverride` argument. When provided,
 * it supplants the placeholder ResolvedOptions the projector would
 * otherwise emit. `MergeBuilder` and other non-resolver builders omit
 * this argument and receive the legacy placeholder shape unchanged
 * (back-compat — merge does NOT go through the preset resolver in T4b).
 */
export function _projectResult(status, jobDownloads, appliedOptions, resolvedOptionsOverride) {
    const artifacts = [];
    for (const job of jobDownloads) {
        for (const file of job.files) {
            const a = {
                url: file.downloadUrl,
                filename: file.filename,
                sizeBytes: file.sizeBytes,
                operation: file.operation,
                operationId: file.operationId,
                jobId: job.jobId,
                ref: job.ref,
                ...(file.pageIndex !== undefined ? { pageIndex: file.pageIndex } : {}),
                ...(file.position !== undefined ? { position: file.position } : {}),
            };
            artifacts.push(a);
        }
    }
    const jobs = (status.jobs ?? []).map((j) => ({
        jobId: j.jobId,
        ref: j.ref,
        status: j.status,
        operations: (j.operations ?? []).map((op) => ({
            id: op.id,
            type: op.type,
            status: op.status,
            ...(op.progress !== undefined ? { progress: op.progress } : {}),
            ...(op.errorCode !== undefined ? { errorCode: op.errorCode } : {}),
            ...(op.errorMessage !== undefined ? { errorMessage: op.errorMessage } : {}),
        })),
    }));
    // Codex r2 medium 3d229f9bc1fb — generated FromJSON deserializes timestamps
    // as Date objects. String(date) gives a locale/timezone-dependent toString();
    // we want canonical ISO-8601 round-trip with the wire shape.
    const isoIfDate = (v) => (v instanceof Date ? v.toISOString() : String(v));
    const result = {
        workflowId: status.workflowId,
        status: status.status,
        ...(status.createdAt !== undefined ? { createdAt: isoIfDate(status.createdAt) } : {}),
        ...(status.updatedAt !== undefined ? { updatedAt: isoIfDate(status.updatedAt) } : {}),
        artifacts,
        jobs,
        ...(artifacts.length === 1 ? { url: artifacts[0].url } : {}),
        resolvedOptions: resolvedOptionsOverride ?? {
            preset: null,
            applied: { ...appliedOptions },
            overrides: [],
            presetVersion: '1.0',
            sources: {
                sdkDefault: [],
                clientDefault: [],
                scopedDefault: [],
                callPresetOverride: [],
                explicit: [],
            },
        },
    };
    return result;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export function _checkAborted(signal) {
    if (signal !== undefined && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
}
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
export function _cappedProbeTimeoutMs(probeTimeoutMs, deadline) {
    if (deadline === undefined) {
        return probeTimeoutMs;
    }
    const remaining = Math.max(0, deadline - Date.now());
    return probeTimeoutMs !== undefined ? Math.min(probeTimeoutMs, remaining) : remaining;
}
async function sleep(ms, signal) {
    return await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => {
            clearTimeout(t);
            if (signal !== undefined)
                signal.removeEventListener('abort', onAbort);
        };
        if (signal !== undefined) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
/**
 * Parse a `maxWait` argument: number = milliseconds; string with suffix
 * `ms` / `s` / `m` / `h`. Throws if the string is malformed.
 */
/** @internal — exported for reuse by `merge.ts` (T3) and future builders. */
export function _parseMaxWait(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) {
            throw new TypeError(`maxWait must be a positive finite number; got ${value}`);
        }
        return value;
    }
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
    if (match === null) {
        throw new TypeError(`maxWait string must look like '500ms', '120s', '30m', '2h'; got '${value}'`);
    }
    const n = Number(match[1]);
    const unit = (match[2] ?? 'ms').toLowerCase();
    switch (unit) {
        case 'ms':
            return n;
        case 's':
            return n * 1_000;
        case 'm':
            return n * 60_000;
        case 'h':
            return n * 3_600_000;
        /* istanbul ignore next */
        default:
            throw new TypeError(`Unknown maxWait unit '${unit}'`);
    }
}
