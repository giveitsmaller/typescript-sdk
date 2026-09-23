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
import { DEFAULT_POLL_TIMEOUT_MS } from './client.js';
import { uploadSource, jobOutputSource } from './types.js';
import { GislConfigError, GislNetworkError, GislPerInputOptionsNotSupportedError, GislTimeoutError, GislUndeclaredAssetError, GislUnusedAssetError, GislStreamHostNotDeclaredError, SseConnectRefused, SseEndedWithoutTerminal, } from './errors.js';
import { _cappedProbeTimeoutMs, _checkAborted, _consumeSseToTerminal, _detectCompressMedia, _parseMaxWait, _pollToTerminal, _projectResult, _retryOn429, } from './builder.js';
import { Handle } from './handle.js';
/**
 * Construct a path-asset. Bare-string arguments to `merge(...)` are
 * implicitly wrapped via this helper.
 */
export function asset(path) {
    return { type: 'path', path };
}
/**
 * Wrap an already-uploaded file_id as a merge asset. Use this when the
 * SAME logical file should be referenced from multiple merge runs with
 * guaranteed-single-upload semantics.
 */
export function handle(fileId) {
    return { type: 'handle', fileId };
}
/**
 * Construct a clip entry for `.sequence(...)`. The asset MUST already
 * be in the merge's declared asset set.
 */
export function clip(ref, options = {}) {
    return { type: 'clip', asset: ref, options };
}
// ---------------------------------------------------------------------------
// MergeBuilder
// ---------------------------------------------------------------------------
/**
 * Captures the (declared assets, options) for a merge. `.sequence(...)`
 * pins the play order; without it, the declared order is used as-is
 * with no per-input options.
 *
 * Local validation runs at `.run()`/`.submit()` time (BEFORE any upload)
 * and throws one of `GislUndeclaredAssetError`, `GislUnusedAssetError`,
 * or `GislPerInputOptionsNotSupportedError` if the compose is invalid.
 */
export class MergeBuilder {
    client;
    assets;
    opOptions;
    sequenceEntries = null;
    constructor(client, assets, opOptions) {
        this.client = client;
        this.assets = assets;
        this.opOptions = opOptions;
    }
    /**
     * Pin the merge play order. Each entry must reference an asset that
     * was declared in the parent `merge(...)` call. Repeats are allowed
     * and deduped on upload (one upload per unique declared asset).
     */
    sequence(...entries) {
        this.sequenceEntries = entries;
        return this;
    }
    async run(options = {}) {
        const deadline = Date.now() + _parseMaxWait(options.maxWait ?? DEFAULT_POLL_TIMEOUT_MS);
        const signal = options.signal;
        const onProgress = options.onProgress;
        const useSSE = options.useSSE ?? true;
        // 1. Validate locally BEFORE any upload.
        const plan = this.planSequence();
        // 2. Upload each unique asset exactly ONCE. Pass the deadline so the
        // upload loop can abort mid-batch on a slow connection.
        const probeTargets = [];
        const uploadedByAssetId = await this.uploadUniqueAssets(plan.uniqueAssets, {
            signal,
            onProgress,
            deadline,
            probeTargets,
        });
        _checkAborted(signal);
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Upload(s) completed but maxWait elapsed before merge workflow could be created`);
        }
        // Best-effort probe-before-create for the multipart-video inputs (capped to
        // the remaining maxWait budget).
        await this.waitForVideoProbes(probeTargets, options.probeBeforeCreate, options.probeTimeoutMs, signal, deadline);
        // A cancel arriving during a FINAL successful probe request must not still
        // create the workflow (the probe waits return landed without a final abort
        // re-check), so check here BEFORE createWorkflow.
        _checkAborted(signal);
        // RE-CHECK the deadline AFTER the probe waits (they consume time).
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Probe wait completed but maxWait elapsed before merge workflow could be created`);
        }
        // 3. Build the merge JobDefinitionPayload (multi-input).
        const payload = this.buildPayload(plan, uploadedByAssetId);
        const created = await this.client.createWorkflow(payload);
        _checkAborted(signal);
        // 4. Wait to terminal status.
        const finalStatus = await this.awaitTerminal({
            workflowId: created.workflowId,
            deadline,
            signal,
            onProgress,
            useSSE,
            pollIntervalMs: options.pollIntervalMs,
        });
        // 5. Fetch downloads + project.
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Merge workflow ${created.workflowId} reached terminal status but maxWait elapsed before downloads could be fetched`, created.workflowId);
        }
        const downloads = await _retryOn429(() => this.client.getWorkflowDownloads(created.workflowId), {
            deadline, signal, workflowId: created.workflowId, patient: true,
        });
        // TDqmkWpX: the maxWait deadline also covers the downloads fetch itself —
        // re-check AFTER the call so a slow getWorkflowDownloads cannot return a
        // success past the advertised whole-run deadline.
        if (Date.now() >= deadline) {
            throw new GislTimeoutError(`Merge workflow ${created.workflowId} downloads fetch completed after maxWait elapsed`, created.workflowId);
        }
        // p0SuJEeK — project ONLY the merge job's output. getWorkflowDownloads
        // returns a download group per terminal job, which now INCLUDES the
        // `passthrough` source jobs (their output is the unchanged upload). Those
        // are plumbing, not the merge deliverable — surfacing them as artifacts
        // would pollute the Result with the raw inputs. The merge job's ref is
        // 'merge' (see buildPayload); the source jobs are 'src_N'.
        const mergeDownloads = downloads.downloads.filter((d) => d.ref === 'merge');
        return _projectResult(finalStatus, mergeDownloads, this.opOptionsForResolved(plan.mediaKind));
    }
    async submit(options = {}) {
        const plan = this.planSequence();
        const probeTargets = [];
        const uploadedByAssetId = await this.uploadUniqueAssets(plan.uniqueAssets, { probeTargets });
        // Best-effort probe-before-create for the multipart-video inputs.
        // Fire-and-forget — no deadline, so no cap (mirrors Recipe::submit()).
        await this.waitForVideoProbes(probeTargets, options.probeBeforeCreate, options.probeTimeoutMs, undefined, undefined);
        const payload = this.buildPayload(plan, uploadedByAssetId);
        // Set only when present — an own `callback_url: undefined` would make a
        // key-presence assertion pass vacuously. See builder.ts.
        if (options.webhook !== undefined)
            payload.callback_url = options.webhook;
        const created = await this.client.createWorkflow(payload);
        // ⚠️ The client is passed so the returned Handle is usable (36AZ98FV). This
        // comment previously read "No client passed → the returned Handle's
        // status()/wait()/result() throw `no_client`; the merge submit reconciles via
        // webhook" — an accurate description of a defect. `webhook` is optional now,
        // so an unbound handle here would leave a submit with no outcome channel at all.
        return new Handle(created.workflowId, created.webhookSecret != null ? created.webhookSecret : undefined, this.client, null);
    }
    // ---------------------------------------------------------------------------
    /**
     * Resolve the declared assets + sequence (or fall back to declared order),
     * dedupe by identity, and run the local validators. The returned plan
     * carries the SEQUENCE (positional entries) + the UNIQUE assets to upload.
     */
    planSequence() {
        const declaredIds = this.assets.map(assetIdentity);
        const declaredSet = new Map();
        for (let i = 0; i < this.assets.length; i += 1) {
            const id = declaredIds[i];
            if (!declaredSet.has(id))
                declaredSet.set(id, this.assets[i]);
        }
        // Use the explicit sequence if set; otherwise the declared order as-is.
        const rawEntries = this.sequenceEntries ?? this.assets.map((a) => a);
        // Validate per-entry: undeclared ref + image-merge-clip-with-opts.
        const mediaKind = this.inferMediaKind();
        const positions = [];
        const refIds = new Set();
        for (const entry of rawEntries) {
            const isClip = entry !== null && typeof entry === 'object' && 'type' in entry && entry.type === 'clip';
            const assetRef = isClip ? entry.asset : entry;
            const id = assetIdentity(assetRef);
            if (!declaredSet.has(id)) {
                throw new GislUndeclaredAssetError(id, Array.from(declaredSet.keys()));
            }
            refIds.add(id);
            if (isClip) {
                const opts = entry.options;
                const hasOpts = opts.transition !== undefined ||
                    opts.crossfadeDuration !== undefined ||
                    opts.gapDuration !== undefined;
                if (hasOpts && mediaKind === 'image') {
                    throw new GislPerInputOptionsNotSupportedError('image');
                }
                positions.push({ assetId: id, options: opts });
            }
            else {
                positions.push({ assetId: id, options: {} });
            }
        }
        // Unused-asset check.
        if (this.sequenceEntries !== null && this.opOptions.allowUnusedAssets !== true) {
            const unused = Array.from(declaredSet.keys()).filter((id) => !refIds.has(id));
            if (unused.length > 0)
                throw new GislUnusedAssetError(unused);
        }
        // Codex r1 medium edb1bb641d81 — when an explicit sequence is set,
        // restrict the upload set to only the referenced assets. This prevents
        // wasted uploads of declared-but-unsequenced assets (e.g. when the
        // user passes allowUnusedAssets: true).
        const uploadSet = this.sequenceEntries === null
            ? declaredSet
            : new Map(Array.from(declaredSet.entries()).filter(([id]) => refIds.has(id)));
        // Codex r1 medium 5c86b67c979b — enforce merge schema input bounds
        // (min_inputs: 2, max_inputs: 10 per generated/typescript/operations/merge.ts).
        // Validate sequence position count, NOT unique-asset count: the merge job
        // sends N inputs where N = position count (repeats included).
        if (positions.length < 2) {
            throw new GislConfigError(`merge requires at least 2 inputs (got ${positions.length}). Declare more assets or check the sequence.`);
        }
        if (positions.length > 10) {
            throw new GislConfigError(`merge accepts at most 10 inputs (got ${positions.length}). Reduce the sequence or split the merge.`);
        }
        // Validate merge-level options BEFORE upload (parity with PHP MergeBuilder).
        // A `targetSize: 'garbage'` typo must fail locally rather than burning N
        // uploads before parseSizeString fires from wireMergeOptions().
        //
        // Gated to video (codex #176 r3 DCJUvvfA) — `target_size_bytes` only
        // crosses the wire for video merges (see wireMergeOptions); for image/audio
        // the field is silently dropped, so validating its string form would reject
        // a merge over a value that never leaves the SDK.
        if (mediaKind === 'video' && typeof this.opOptions.targetSize === 'string') {
            try {
                parseSizeString(this.opOptions.targetSize);
            }
            catch {
                throw new GislConfigError(`Invalid targetSize string '${this.opOptions.targetSize}' — expected '<num>[B|KB|MB|GB]'.`);
            }
        }
        // Image merges require an `output_type` (the generated merge schema marks
        // `output_type` required for image kind). Without this check the SDK would
        // upload all assets then receive a server-side validation failure instead
        // of a free local one. Parity with PHP MergeBuilder.
        if (mediaKind === 'image' &&
            this.opOptions.output == null &&
            this.opOptions.outputType == null) {
            throw new GislConfigError('image merges require an explicit output_type — set MergeOptions(output: "video"|"gif") or ' +
                'MergeOptions(outputType: ...). The server rejects image merge requests with no output_type.');
        }
        return { mediaKind, positions, uniqueAssets: uploadSet };
    }
    inferMediaKind() {
        if (this.opOptions.mediaKind !== undefined)
            return this.opOptions.mediaKind;
        const first = this.assets[0];
        if (first === undefined)
            return 'video';
        if (first.type === 'path' && typeof first.path === 'string') {
            const lower = first.path.toLowerCase();
            if (/\.(jpe?g|png|webp|avif|gif|heic|tiff?)$/.test(lower))
                return 'image';
            if (/\.(mp3|wav|flac|aac|ogg|m4a)$/.test(lower))
                return 'audio';
            return 'video';
        }
        if (first.type === 'path' && first.path instanceof Blob) {
            if (first.path.type.startsWith('image/'))
                return 'image';
            if (first.path.type.startsWith('audio/'))
                return 'audio';
            return 'video';
        }
        return 'video';
    }
    async uploadUniqueAssets(uniqueAssets, opts) {
        const uploaded = new Map();
        for (const [id, a] of uniqueAssets) {
            // Codex r1 medium 797b4113431f — check the deadline between uploads
            // so a multi-file merge doesn't keep uploading past `maxWait`.
            if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
                throw new GislTimeoutError(`maxWait elapsed mid-upload (after ${uploaded.size} of ${uniqueAssets.size} merge assets)`);
            }
            if (a.type === 'handle') {
                uploaded.set(id, a.fileId);
                continue;
            }
            const uploadOpts = {};
            if (opts.signal !== undefined)
                uploadOpts.signal = opts.signal;
            if (opts.onProgress !== undefined) {
                uploadOpts.onProgress = (uploadedBytes, totalBytes) => {
                    opts.onProgress?.({ phase: 'upload', uploadedBytes, totalBytes });
                };
            }
            const resp = await this.client.uploadFile(a.path, uploadOpts);
            uploaded.set(id, resp.fileId);
            opts.probeTargets?.push({
                fileId: resp.fileId,
                isVideo: _detectCompressMedia(a.path) === 'video',
                sizeBytes: resp.sizeBytes,
            });
        }
        return uploaded;
    }
    /**
     * Best-effort, concurrent probe-before-create for the multipart-video
     * inputs (never-bounce; each bounded by the SAME capped timeout, so the
     * aggregate wall-clock stays ~timeout rather than N×timeout). When `deadline`
     * is set (the `run()` path) the timeout is capped to the remaining maxWait
     * budget so the waits cannot push createWorkflow past the caller's deadline;
     * `submit()` passes `undefined` (fire-and-forget, no cap).
     */
    async waitForVideoProbes(probeTargets, probeBeforeCreate, probeTimeoutMs, signal, deadline) {
        const cappedProbeTimeoutMs = _cappedProbeTimeoutMs(probeTimeoutMs, deadline);
        await Promise.all(probeTargets.map((t) => this.client.maybeWaitForVideoProbe(t.fileId, {
            enabled: probeBeforeCreate ?? true,
            isVideo: t.isVideo,
            sizeBytes: t.sizeBytes,
            timeoutMs: cappedProbeTimeoutMs,
            signal,
        })));
    }
    buildPayload(plan, uploadedByAssetId) {
        // p0SuJEeK — the API rejects upload-direct multi-input
        // (`MultiInputSource` excludes the `upload` leaf: "use type=job_output").
        // So each uploaded asset is wrapped in its OWN single-input `passthrough`
        // source job, and the merge job references those via `job_output` — the
        // shape the v2.35.0 `v2_merge_two_uploads` example prescribes. One source
        // job per UNIQUE asset (in first-seen position order); a repeated asset
        // re-uses its src job. `passthrough` is a lossless inert op (it does NOT
        // get the implicit compress an empty `operations: []` job would).
        const srcIdByAsset = new Map();
        const sourceJobs = [];
        for (const pos of plan.positions) {
            if (srcIdByAsset.has(pos.assetId))
                continue;
            const fileId = uploadedByAssetId.get(pos.assetId);
            if (fileId === undefined) {
                // Defensive — planSequence should have rejected this.
                throw new Error(`Asset '${pos.assetId}' was never uploaded — internal builder bug`);
            }
            const srcId = `src_${sourceJobs.length}`;
            srcIdByAsset.set(pos.assetId, srcId);
            sourceJobs.push({
                id: srcId,
                source: uploadSource(fileId),
                operations: [{ type: 'passthrough' }],
            });
        }
        const inputs = plan.positions.map((pos) => {
            // Defensive — srcIdByAsset was populated for every position's asset above.
            const srcId = srcIdByAsset.get(pos.assetId);
            if (srcId === undefined) {
                throw new Error(`Asset '${pos.assetId}' has no source job — internal builder bug`);
            }
            // Codex r1 HIGH 502c6bf232c2 — per_input_options goes on EACH
            // JobInputV2Payload (per-input entry), NOT on operations[0].options.
            // Skip emission for image merges (planSequence already rejects opts
            // on image-merge clips). Project per ClipOptions per media kind
            // (codex r1 medium 128404fa16a9 — gapDuration is audio-only).
            const wireOpts = plan.mediaKind === 'image'
                ? {}
                : wirePerInputOptions(pos.options, plan.mediaKind);
            const input = { source: jobOutputSource(srcId) };
            if (Object.keys(wireOpts).length > 0) {
                input.per_input_options = wireOpts;
            }
            return input;
        });
        // Merge-level options (excluding the SDK-side mediaKind/allowUnusedAssets).
        const mergeOpts = wireMergeOptions(this.opOptions, plan.mediaKind);
        const mergeJob = {
            id: 'merge',
            inputs,
            operations: [{ type: 'merge', options: mergeOpts }],
        };
        return { jobs: [...sourceJobs, mergeJob] };
    }
    opOptionsForResolved(mediaKind) {
        // Mirror wireMergeOptions's per-media allowlist (and PHP
        // opOptionsForResolved) so resolvedOptions.applied reports ONLY the
        // options that actually crossed the wire for this media kind — not the
        // raw option bag (which would falsely claim dropped fields were applied).
        const o = this.opOptions;
        const out = {};
        // All media kinds.
        if (o.output !== undefined)
            out.output = o.output;
        if (o.outputType !== undefined)
            out.outputType = o.outputType;
        if (o.transition !== undefined)
            out.transition = o.transition;
        // Video + audio.
        if (mediaKind === 'video' || mediaKind === 'audio') {
            if (o.crossfadeDuration !== undefined)
                out.crossfadeDuration = o.crossfadeDuration;
            if (o.normalizeAudio !== undefined)
                out.normalizeAudio = o.normalizeAudio;
        }
        // Audio only.
        if (mediaKind === 'audio' && o.gapDuration !== undefined)
            out.gapDuration = o.gapDuration;
        // Video only.
        if (mediaKind === 'video') {
            if (o.reEncodeMode !== undefined)
                out.reEncodeMode = o.reEncodeMode;
            if (o.codec !== undefined)
                out.codec = o.codec;
            if (o.crf !== undefined)
                out.crf = o.crf;
            if (o.preset !== undefined)
                out.preset = o.preset;
            if (o.targetResolution !== undefined)
                out.targetResolution = o.targetResolution;
            if (o.targetSize !== undefined)
                out.targetSize = o.targetSize;
        }
        // Image only.
        if (mediaKind === 'image') {
            if (o.transitionDuration !== undefined)
                out.transitionDuration = o.transitionDuration;
            if (o.fps !== undefined)
                out.fps = o.fps;
            if (o.durationPerImage !== undefined)
                out.durationPerImage = o.durationPerImage;
            if (o.delay !== undefined)
                out.delay = o.delay;
            if (o.loopCount !== undefined)
                out.loopCount = o.loopCount;
            if (o.videoFormat !== undefined)
                out.videoFormat = o.videoFormat;
        }
        return out;
    }
    async awaitTerminal(args) {
        if (args.useSSE) {
            try {
                return await _consumeSseToTerminal(this.client, args);
            }
            catch (err) {
                // TDqmkWpX: poll-fallback ONLY on a clean SSE stream-end or a typed
                // transport error; rethrow everything else (timeout, abort, API, an
                // onProgress callback throw, anything unexpected) so it isn't masked.
                if (!(err instanceof SseEndedWithoutTerminal ||
                    // 3OVNoRxh: the SSE CONNECT was refused with a retryable status
                    // (a 429 on the `events_stream` bucket, or a 503). The contract
                    // declares that retryable and it clears when another caller closes
                    // a stream — so it is SSE being momentarily unavailable, not a
                    // failure of the thing this caller asked for. The wrap happens at
                    // the connect site ONLY, and only for `GislApiError.retryable`, so
                    // a 401/402/404 still propagates.
                    err instanceof SseConnectRefused ||
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
            }
        }
        return await _pollToTerminal(this.client, args);
    }
}
/**
 * Per-Blob identity tokens — referential dedupe via WeakMap. Two distinct
 * Blob objects with the same size + MIME would otherwise hash to the
 * SAME identity (silent data loss; code-reviewer P1 conf 8). Reference
 * identity guarantees same-Blob = same-upload and different-Blob = two
 * uploads, irrespective of content sniffing.
 */
const _blobTokens = new WeakMap();
let _blobCounter = 0;
/**
 * Asset identity for dedupe. Handles use their fileId; paths use a
 * trim+trailing-separator-strip normalised string (NOT case-folded —
 * case-insensitive dedupe would silently merge `A.mp4` and `a.mp4` on a
 * case-sensitive filesystem; code-reviewer P1 conf 7). Blobs use
 * referential identity via a WeakMap-backed token. Bare-string path
 * dedupe is best-effort — use `handle()` for guaranteed reuse.
 */
function assetIdentity(a) {
    if (a.type === 'handle')
        return `handle:${a.fileId}`;
    if (a.path instanceof Blob) {
        let token = _blobTokens.get(a.path);
        if (token === undefined) {
            _blobCounter += 1;
            token = `${_blobCounter}`;
            _blobTokens.set(a.path, token);
        }
        return `blob:${token}`;
    }
    // Codex r2 medium bb500566a683 — dedupe by the EXACT caller-provided
    // string. Previous trim+trailing-slash-strip would collapse
    // `'clip.mp4'` and `'clip.mp4 '` into one upload while uploadFile later
    // received the original string. Exact-string dedupe = upload identity
    // matches dedupe identity. Best-effort = "two identical strings dedupe;
    // anything else is a separate upload" — predictable.
    return `path:${a.path}`;
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
export function wireMergeOptions(opts, mediaKind) {
    const out = {};
    // Per-media wire allowlist — mirror of PHP MergeBuilder::wireMergeOptions
    // (codex 30d…/parity): a field set on the wrong media kind is DROPPED
    // locally rather than shipped as an invalid payload the server 422s.
    // All media kinds.
    if (opts.output !== undefined)
        out.output_type = opts.output;
    if (opts.outputType !== undefined)
        out.output_type = opts.outputType;
    if (opts.transition !== undefined)
        out.transition = opts.transition;
    // Video + audio.
    if (mediaKind === 'video' || mediaKind === 'audio') {
        if (opts.crossfadeDuration !== undefined)
            out.crossfade_duration = opts.crossfadeDuration;
        if (opts.normalizeAudio !== undefined)
            out.normalize_audio = opts.normalizeAudio;
    }
    // Audio only — merge-level `gap_duration` is on MergeAudioOptions only
    // (codex r2 medium ab2422e56ea0).
    if (mediaKind === 'audio' && opts.gapDuration !== undefined)
        out.gap_duration = opts.gapDuration;
    // Video only.
    if (mediaKind === 'video') {
        if (opts.reEncodeMode !== undefined)
            out.re_encode_mode = opts.reEncodeMode;
        if (opts.codec !== undefined)
            out.codec = opts.codec;
        if (opts.crf !== undefined)
            out.crf = opts.crf;
        if (opts.preset !== undefined)
            out.preset = opts.preset;
        if (opts.targetResolution !== undefined)
            out.target_resolution = opts.targetResolution;
        if (opts.targetSize !== undefined) {
            out.target_size_bytes = typeof opts.targetSize === 'number'
                ? opts.targetSize
                : parseSizeString(opts.targetSize);
            out.encoding_mode = 'target_size';
        }
    }
    // Image only.
    if (mediaKind === 'image') {
        if (opts.transitionDuration !== undefined)
            out.transition_duration = opts.transitionDuration;
        if (opts.fps !== undefined)
            out.fps = opts.fps;
        if (opts.durationPerImage !== undefined)
            out.duration_per_image = opts.durationPerImage;
        if (opts.delay !== undefined)
            out.delay = opts.delay;
        if (opts.loopCount !== undefined)
            out.loop_count = opts.loopCount;
        if (opts.videoFormat !== undefined)
            out.video_format = opts.videoFormat;
    }
    return out;
}
/**
 * Project a ClipOptions into the wire-shape per_input_options object.
 * Codex r1 medium 128404fa16a9 — `gap_duration` is on AUDIO per-input
 * only (`MergeAudioPerInputOptions`), NOT video. Splitting by mediaKind
 * here keeps the wire payload honest and prevents the server from
 * silently rejecting/ignoring an out-of-spec field.
 */
function wirePerInputOptions(opts, mediaKind) {
    const out = {};
    if (opts.transition !== undefined)
        out.transition = opts.transition;
    if (opts.crossfadeDuration !== undefined)
        out.crossfade_duration = opts.crossfadeDuration;
    if (opts.gapDuration !== undefined && mediaKind === 'audio') {
        out.gap_duration = opts.gapDuration;
    }
    return out;
}
function parseSizeString(s) {
    const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)?$/i.exec(s.trim());
    if (m === null)
        throw new TypeError(`Invalid targetSize string '${s}'`);
    const n = Number(m[1]);
    const unit = (m[2] ?? 'B').toUpperCase();
    switch (unit) {
        case 'B': return Math.round(n);
        case 'KB': return Math.round(n * 1_000);
        case 'MB': return Math.round(n * 1_000_000);
        case 'GB': return Math.round(n * 1_000_000_000);
        /* istanbul ignore next */
        default: throw new TypeError(`Unknown size unit '${unit}'`);
    }
}
