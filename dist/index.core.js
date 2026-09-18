// Browser-safe shared surface. The Node-only entry (`index.ts`) re-exports
// everything here PLUS the Node-only symbols (`verifyWebhook`, `HttpDownloader`)
// that statically import node:crypto / node:fs; the browser entry
// (`index.browser.ts`) re-exports ONLY this core, so it is a strict subset by
// construction (no hand-maintained subset to drift). Keep this file free of any
// static `node:` import — see the bundle-gate test.
// SDK classes and functions
export { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from './client.js';
export { parseSseStream } from './sse.js';
export { uploadSource, jobOutputSource, externalImportSource, connectionSource, } from './types.js';
// Errors
export { GislError, GislApiError, GislValidationError, 
// wOzXYDhg — the OTHER branch of the same 422 `oneOf` as GislValidationError.
// It was thrown by both SDKs and exported by neither, so a caller who wanted
// to tell "this email is already registered" from "your payload is malformed"
// had to catch GislApiError, test `statusCode === 422` and read the
// `error_type` discriminator by hand — which is precisely the unwrapping this
// class exists to spare them. Its sibling being public is what made the
// omission read as an oversight rather than a decision.
GislAuthRejectionError, GislBalanceExhaustedError, GislLongFormConcurrencyError, GislTierRestrictedError, GislFeatureTierRestrictedError, GislFeatureNotAvailableError, GislWorkflowExpiredError, GislProbePendingError, GislAuthError, GislUploadCapExceededError, GislMultipartPartError, GislMultipartPartCountError, 
// SDK-3 (Wb6ebOMM) — typed errors for the 3 resume-support endpoints.
GislMultipartSessionNotFoundError, GislMultipartSessionOwnershipError, GislMultipartSessionAuthRequiredError, GislTimeoutError, 
// 4G4FaA9X — mapEach fan-out timed out mid-batch; carries the completed
// child ids + parent id so the caller can recover without a whole-batch re-run.
GislFanOutTimeoutError, GislAbortError, 
// FF2b / tywwynmN — off-envelope failure base (mirrors PHP GislNetworkError);
// raised by the file-first HttpDownloader when an output URL cannot be read.
// t2qCrjdr: NEVER THROWN DIRECTLY any more — it is the hierarchy node the two
// subclasses below share, kept so existing `instanceof GislNetworkError`
// narrowing (including the SSE poll-fallback) is unchanged.
GislNetworkError, 
// t2qCrjdr — the split. One `retryable` could not be honest for both a DNS
// failure and a 404, so each case is now its own class with its own answer.
GislTransportError, GislDownloadHttpError, 
// The request never left the client — never retryable. TS detects only what
// it can see BEFORE the call (an unparseable URL); PHP also classifies
// PSR-18's RequestExceptionInterface, which `fetch` gives no equivalent of.
GislRequestNotSentError, 
// T1 / wVU4xHx3 — local config-error tree (pre-I/O; sibling of GislApiError).
GislConfigError, GislMissingCredentialsError, 
// VUozk5Bc — `streamEvents` on a client with no DECLARED stream host. The
// SDK refuses to derive `stream.*` from `api.*`; `run()` polls instead.
GislStreamHostNotDeclaredError, GislFeatureRequiresAuthError, 
// T3 / cuecCmb5 — merge-compose local validation errors.
GislUndeclaredAssetError, GislUnusedAssetError, GislPerInputOptionsNotSupportedError, 
// T6 / aDR1jnyZ — chain-cardinality validation (dormant until chain
// methods on OperationBuilder ship; type + audit registration land
// here so the future chain-method PR is a pure addition).
GislChainCardinalityMismatchError, 
// P4d / hv3FpLjm — double-bundle prevention; raised by `.bundle()` (wpHoJhuo).
// Dormant until `.bundle()` ships, so the type lands here as a pure addition.
GislBundleAlreadyArchivedError, 
// FF1 / 3BIxEnfR — file-first result sink errors.
GislNoSuchKeyError, GislSinkError, 
// AjhOUuqQ — typed terminal item failure stored in RunResult.failed[].error.
GislItemFailedError, 
// FF5a / Ao8RPVxD — thrown by the file-first Handle.result() when the
// workflow is not yet terminal (the non-blocking accessor).
GislResultNotReadyError, } from './errors.js';
// File-first result surface (FF1 / 3BIxEnfR) — coexists with the
// operation-first `Result`/`Artifact` until FF6 removes the old layer.
export { RunResult } from './file-first.js';
// File-first builder (FF2a / MfV0PDok) — `client.file(path).op()...` lowering.
export { Recipe, fileInput } from './file-first.js';
// File-first homogeneous fan-out (FF3a / u0hBt6fl) — `client.files([...]).op()...`
// applies one recipe to many inputs in one workflow; run() partitions per input.
// `projectMultiJobToRunResult` is intentionally NOT re-exported — it is the
// @internal per-job producer consumed only by FilesRecipe.run (codex).
export { FilesRecipe } from './file-first.js';
// File-first N→1 combine (FF3b / IE29x9QL) — `client.files([...]).merge(opts?)`
// returns a single-output MergedRecipe you chain post-combine ops on, then
// run()/submit(). Mirrors the operation-first `client.merge()` wire shape.
export { MergedRecipe } from './file-first.js';
// File-first N→1 bundle (FF3b) — `client.files([...]).archive(opts?)` returns a
// terminal ArchivedRecipe (zip / tar.gz; no post-bundle chain), then run()/submit().
export { ArchivedRecipe } from './file-first.js';
// File-first multi-input watermark (FF4a / Z7zTr789) — `client.file(base)
// .watermark(overlay, opts)` returns a single-output WatermarkedRecipe you chain
// post-watermark ops on, then run()/submit(). Routes image_watermark / video_watermark
// by base media; gates planned/unsupported bases locally pre-upload.
export { WatermarkedRecipe } from './file-first.js';
// File-first keyed multi-recipe batch (FF7 / MFaCjL8d) — `client.batch([r1, r2, …])`
// runs N DISTINCT single-input keyed recipes as ONE workflow; run() partitions the
// RunResult by each entry's caller key. v1 = single-input keyed, run()-only; the
// multi-input builders are rejected pre-upload.
export { BatchRecipe } from './file-first.js';
// `HttpDownloader` (Node streaming downloader) is re-exported from the Node-only
// entry `index.ts`, NOT here — it statically imports node:fs/node:stream.
// `projectDownloadsToRunResult` is intentionally NOT re-exported here — it is an
// @internal helper shared between `file-first.ts` (Recipe.run) and `handle.ts`
// (Handle.wait/result) via direct intra-package import, not public API (codex).
// File-first Handle + StatusSnapshot (FF5a / Ao8RPVxD) — method-bearing,
// client-bound value objects. `Handle` is the return of `submit()` (no client)
// AND `client.workflow(id)` (client-bound, reattach). Exported as VALUES (the
// prior `export type { Handle }` is replaced) because `Handle` is now a class.
export { Handle, StatusSnapshot } from './handle.js';
// Ergonomic-layer entrypoint (T1 / wVU4xHx3) — `gisl.create()` factory +
// credential-chain types. `gisl.anonymous()` (public export) lands once
// the anonymous-capable operation allowlist is non-empty (plan §12).
export { gisl, create } from './gisl.js';
// 🔑 THE TWO ENDPOINT TABLES, EXPORTED BECAUSE THE SDK DEMANDS A VALUE IT DID
// NOT PUBLISH (e2e, 2026-09-15).
//
// `streamEvents()` fails CLOSED: `resolveStreamEndpoint` returns `null` rather
// than deriving a stream host from `baseUrl`, because deriving one is what put
// production on the gateway path. That design is right and is not changing.
//
// But its consequence is that a low-level `new GislClient({…})` caller MUST
// supply `streamBaseUrl` — and until now the table of declared hosts was
// reachable by no import a consumer could write: the `exports` map admits only
// `.` and `./browser`, and neither barrel re-exported these. ⇒ Every such
// consumer hard-codes the hosts. A library that fails closed on a value and
// does not export the value converts good design into N private copies that
// drift, and the copies are invisible until one is wrong.
//
// ⚠️ A SET OF HOSTS IS NOT ENOUGH, WHICH IS WHY THIS EXPORTS THE OBJECTS
// RATHER THAN A LIST. e2e's interim guard read our shipped `dist` as text and
// compared host sets in both directions — it could not have caught staging and
// prod being SWAPPED, which is the exact mistake that sends a credentialed
// stream request to the wrong environment. The PAIRING is the thing worth
// exporting.
//
// Frozen at their definition: these are the same objects the resolver reads, so
// a consumer mutating one would have repointed the SDK's own resolution.
export { ENVIRONMENT_ENDPOINTS, ENVIRONMENT_STREAM_ENDPOINTS } from './credentials.js';
// Ergonomic preset defaults (T4a / VhIj4S7T) — typed leaf DTOs + immutable
// `PresetDefaults` builder + `presetDefaults()` factory + ergonomic enum
// re-exports. Resolver wiring (T4b) consumes `PresetDefaults.cellFor()`.
export { presetDefaults, PresetDefaults, ImageCompressPresetOptions, AudioCompressPresetOptions, VideoCompressPresetOptions, DocumentOfficeCompressPresetOptions, DocumentOdfCompressPresetOptions, DocumentEpubCompressPresetOptions, OptimizeFor, ImageMetadataPolicy, ImageFormat, VideoCodec, VideoPreset, VideoFit, AudioBitrate, AudioCodec, AudioSampleRate, } from './ergonomic/presets/index.js';
// Operation-builder surface (T2 / xVDTIm8C) — `client.compress/convert/thumbnail`
// returns an `OperationBuilder`; `.run()` projects to a flat `Result` /
// `.submit({webhook})` returns a `Handle`. Progress events are the
// SDK-synthesised `{phase:'upload'|'processing', ...}` discriminated union.
export { OperationBuilder, MapEachBuilder } from './builder.js';
export { MergeBuilder, asset, handle, clip } from './merge.js';
// T4b — preset resolver public surface (PRESET_VERSION constant + types).
export { PRESET_VERSION, resolveCompressOptions } from './ergonomic/preset_resolver.js';
export { AudioWatermarkDecodeRequestMethodHintEnum, AudioWatermarkDecodeResponseMethodEnum, 
// OperationInputModel — value-bearing enum (`single` | `multi`).
// Surfaced on OperationSchemaDefinition.inputModel so form-renderers
// can decide whether to render a single-file picker or a multi-file
// input list.
OperationInputModel, ExternalImportRequestProviderHintEnum, ContactSubject, CreditTransactionSourceBucket, UploadProbeStatus, UploadProbeProcessingClass, WorkflowCancelBillingEffect, WorkflowPauseRequiredAction, WorkflowStatus, WarningType, WorkflowWarningSeverity, OperationType, SseEventType, CallbackEventType, OperationStatus, JobStatus, JobInputV2RoleEnum, 
// Error-payload discriminator enums — pair with the typed payload
// types above for narrowing inside `error instanceof Gisl<X>Error`
// branches.
AuthErrorType, TierRestrictionKind, BalanceExhaustedResponseRequiredActionEnum, ProcessingClassReason, DeliveryPlanReason, 
// UserTier + ProcessingClass — value-bearing forms (typeof const +
// type alias). Sourced from openapi so consumers can do
// `Object.values(UserTier)` for tier dropdowns or
// `if (tier === UserTier.enterprise)` for narrowing typed error
// payloads. The operations metadata-types versions are pure type
// aliases (no runtime value); the openapi versions carry both the
// string-union type and a const map. Per audit follow-up.
UserTier, ProcessingClass, } from '@giveitsmaller/contracts/openapi';
export { ImageWatermarkImageAnchor, ImageWatermarkImageGifAnchor, TextWatermarkImageAnchor, TextWatermarkImageFontFamily, TextWatermarkImageWatermarkMode, AudioOverlayAudioMode, AudioOverlayVideoMode, AudioOverlayVideoNoAudioTrackBehaviour, AudioWatermarkAudioMethod, AudioWatermarkAudioRobustness, AudioWatermarkAudioDensity, AudioWatermarkVideoMethod, AudioWatermarkVideoRobustness, AudioWatermarkVideoDensity, 
// New planned operation enums — contracts v2.15 (AJCLLGaG).
AudioToVideoAudioOutputResolution, AudioToVideoAudioImageFit, AudioToVideoAudioOutputFormat, VideoWatermarkVideoAnchor, VideoTextWatermarkVideoFontFamily, VideoTextWatermarkVideoWatermarkMode, VideoTextWatermarkVideoAnchor, SplitImageGifOutputFormat, SplitDocumentPdfMode, SplitAudioMode, SplitAudioPrecision, SplitVideoMode, SplitVideoPrecision, } from '@giveitsmaller/contracts/operations';
// Per-operation metadata sidecars. Inspect `availability`,
// `required_tier`, per-value gating, mime-group availability and
// per-feature flags before submitting a workflow — the API will
// otherwise reject planned ops with `feature_not_available` (422,
// surfaces as `GislFeatureNotAvailableError`).
export { archiveMetadata, audioOverlayMetadata, audioWatermarkMetadata, compressMetadata, convertMetadata, customLumaMetadata, imageWatermarkMetadata, mergeMetadata, textWatermarkMetadata, thumbnailMetadata, 
// New planned operation metadata sidecars — contracts v2.15 (AJCLLGaG).
audioToVideoMetadata, videoWatermarkMetadata, videoTextWatermarkMetadata, splitMetadata, 
// transform is `availability: planned` — consumers can inspect this sidecar to
// gate UI before submitting (the API otherwise returns feature_not_available/422). T4.
transformMetadata, } from '@giveitsmaller/contracts/operations';
