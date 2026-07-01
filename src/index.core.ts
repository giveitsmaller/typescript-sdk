// Browser-safe shared surface. The Node-only entry (`index.ts`) re-exports
// everything here PLUS the Node-only symbols (`verifyWebhook`, `HttpDownloader`)
// that statically import node:crypto / node:fs; the browser entry
// (`index.browser.ts`) re-exports ONLY this core, so it is a strict subset by
// construction (no hand-maintained subset to drift). Keep this file free of any
// static `node:` import — see the bundle-gate test.

// SDK classes and functions
export { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from './client.js';
export { parseSseStream } from './sse.js';

// Note: the public-API completeness audit gate lives at
// `./_audit.ts`. It is NOT re-exported — `tsconfig.json`'s
// `include: ["src/**/*.ts"]` already pulls it into `tsc --noEmit`,
// so the gate fires without polluting the public surface. Shipping
// the audit module to consumers would inflate bundle size and
// expose an internal symbol as breaking-change-bound API.

// SDK types and factories
export type {
  CreditsUsageOptions,
  ListWorkflowsOptions,
  GetSchemaOptions,
  GetSchemaResult,
  CapabilitiesSnapshot,
  PreflightClipError,
  PreflightClipsResult,
  ProbeWaitOptions,
  ProbeWaitResult,
  GislClientConfig,
  GislSseEvent,
  GislSseParseFailure,
  UploadOptions,
  WaitOptions,
  WorkflowCreatePayload,
  OperationDef,
  WorkflowSourcePayload,
  MultiInputSourcePayload,
  UploadSourcePayload,
  JobOutputSourcePayload,
  ExternalImportSourcePayload,
  ConnectionSourcePayload,
  JobInputV2Payload,
  JobDefinitionPayload,
  ExternalDestinationPayload,
  DeliveryPayload,
  DeliveryModePayload,
  DeliveryBundleFormatPayload,
  DeliverySelectionPayload,
  DeliverySelectionTypePayload,
  DeliveryOutputRefPayload,
  WorkflowProcessingPayload,
  ProcessingClassHintPayload,
  // SDK-3 (Wb6ebOMM) resume-support surface. Hand-coded until contracts
  // ticket HxUmVr3Y publishes the OpenAPI schemas; every type is prefixed
  // `_Sdk3HandCoded` so the regen sweep finds every consumer via grep.
  MultipartCheckpointState,
  _Sdk3HandCodedUploadedPart,
  _Sdk3HandCodedMultipartStatusResult,
  _Sdk3HandCodedPresignedPart,
  _Sdk3HandCodedPresignPartsResult,
  _Sdk3HandCodedKeepaliveResult,
} from './types.js';
export {
  uploadSource,
  jobOutputSource,
  externalImportSource,
  connectionSource,
} from './types.js';

// T4b — typed error metadata interface for GislConfigError.
export type { GislConfigErrorMetadata } from './errors.js';

// Errors
export {
  GislError,
  GislApiError,
  GislValidationError,
  GislBalanceExhaustedError,
  GislTierRestrictedError,
  GislFeatureTierRestrictedError,
  GislFeatureNotAvailableError,
  GislWorkflowExpiredError,
  GislProbePendingError,
  GislAuthError,
  GislUploadCapExceededError,
  GislMultipartPartError,
  GislMultipartPartCountError,
  // SDK-3 (Wb6ebOMM) — typed errors for the 3 resume-support endpoints.
  GislMultipartSessionNotFoundError,
  GislMultipartSessionOwnershipError,
  GislMultipartSessionAuthRequiredError,
  GislTimeoutError,
  GislAbortError,
  // FF2b / tywwynmN — transport-level failure (mirrors PHP GislNetworkError);
  // raised by the file-first HttpDownloader when an output URL cannot be read.
  GislNetworkError,
  // T1 / wVU4xHx3 — local config-error tree (pre-I/O; sibling of GislApiError).
  GislConfigError,
  GislMissingCredentialsError,
  GislFeatureRequiresAuthError,
  // T3 / cuecCmb5 — merge-compose local validation errors.
  GislUndeclaredAssetError,
  GislUnusedAssetError,
  GislPerInputOptionsNotSupportedError,
  // T6 / aDR1jnyZ — chain-cardinality validation (dormant until chain
  // methods on OperationBuilder ship; type + audit registration land
  // here so the future chain-method PR is a pure addition).
  GislChainCardinalityMismatchError,
  // P4d / hv3FpLjm — double-bundle prevention; raised by `.bundle()` (wpHoJhuo).
  // Dormant until `.bundle()` ships, so the type lands here as a pure addition.
  GislBundleAlreadyArchivedError,
  // FF1 / 3BIxEnfR — file-first result sink errors.
  GislNoSuchKeyError,
  GislSinkError,
  // AjhOUuqQ — typed terminal item failure stored in RunResult.failed[].error.
  GislItemFailedError,
  // FF5a / Ao8RPVxD — thrown by the file-first Handle.result() when the
  // workflow is not yet terminal (the non-blocking accessor).
  GislResultNotReadyError,
} from './errors.js';
export type { GislApiErrorOptions, GislUploadCapKind } from './errors.js';

// File-first result surface (FF1 / 3BIxEnfR) — coexists with the
// operation-first `Result`/`Artifact` until FF6 removes the old layer.
export { RunResult } from './file-first.js';
export type {
  OutputFile,
  ItemResult,
  ItemFailure,
  Manifest,
  Downloader,
} from './file-first.js';
// File-first builder (FF2a / MfV0PDok) — `client.file(path).op()...` lowering.
export { Recipe, fileInput } from './file-first.js';
export type { FileInput } from './file-first.js';
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
export type { ArchiveRecipeOptions } from './file-first.js';
// File-first multi-input watermark (FF4a / Z7zTr789) — `client.file(base)
// .watermark(overlay, opts)` returns a single-output WatermarkedRecipe you chain
// post-watermark ops on, then run()/submit(). Routes image_watermark / video_watermark
// by base media; gates planned/unsupported bases locally pre-upload.
export { WatermarkedRecipe } from './file-first.js';
export type { WatermarkWireOp } from './file-first.js';
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
export type {
  GislCreateOptions,
  Environment,
  ErgonomicClient,
  // qUhxfDA5 — op-type unions for the generic `operation()` escape hatch.
  SingleInputOperationType,
  MultiInputOperationType,
} from './gisl.js';

// Ergonomic preset defaults (T4a / VhIj4S7T) — typed leaf DTOs + immutable
// `PresetDefaults` builder + `presetDefaults()` factory + ergonomic enum
// re-exports. Resolver wiring (T4b) consumes `PresetDefaults.cellFor()`.
export {
  presetDefaults,
  PresetDefaults,
  type PresetMedia,
  type PresetOp,
  type AnyPresetOptions,
  ImageCompressPresetOptions,
  type ImageCompressPresetOptionsInput,
  AudioCompressPresetOptions,
  type AudioCompressPresetOptionsInput,
  VideoCompressPresetOptions,
  type VideoCompressPresetOptionsInput,
  DocumentPdfCompressPresetOptions,
  type DocumentPdfCompressPresetOptionsInput,
  DocumentOfficeCompressPresetOptions,
  type DocumentOfficeCompressPresetOptionsInput,
  DocumentOdfCompressPresetOptions,
  type DocumentOdfCompressPresetOptionsInput,
  DocumentEpubCompressPresetOptions,
  type DocumentEpubCompressPresetOptionsInput,
  OptimizeFor,
  ImageMetadataPolicy,
  ImageFormat,
  VideoCodec,
  VideoPreset,
  VideoFit,
  AudioBitrate,
  AudioCodec,
  AudioSampleRate,
  PdfProfile,
  PdfColorspace,
} from './ergonomic/presets/index.js';

// Operation-builder surface (T2 / xVDTIm8C) — `client.compress/convert/thumbnail`
// returns an `OperationBuilder`; `.run()` projects to a flat `Result` /
// `.submit({webhook})` returns a `Handle`. Progress events are the
// SDK-synthesised `{phase:'upload'|'processing', ...}` discriminated union.
export { OperationBuilder, MapEachBuilder } from './builder.js';
export { MergeBuilder, asset, handle, clip } from './merge.js';
export type {
  Asset,
  ClipEntry,
  ClipOptions,
  MergeMediaKind,
  MergeOptions,
  SequenceEntry,
} from './merge.js';
export type {
  Artifact,
  ArtifactRef,
  JobBreakdown,
  OperationBreakdown,
  ProcessingProgressEvent,
  ProgressEvent,
  ResolvedOptions,
  ResolvedOptionsSources,
  Result,
  RunOptions,
  SubmitOptions,
  UploadProgressEvent,
} from './builder.js';
// T4b — preset resolver public surface (PRESET_VERSION constant + types).
export { PRESET_VERSION, resolveCompressOptions } from './ergonomic/preset_resolver.js';
export type {
  ResolveCompressOptionsInput,
  ResolveCompressOptionsOutput,
} from './ergonomic/preset_resolver.js';

// Re-export key contract types so users only need @giveitsmaller/sdk
export type {
  // 8yqUXLCS — return shapes of the credits/limits ergonomic accessors.
  AccountLimits,
  AccountLimitsLimits,
  AccountLimitEntry,
  AudioWatermarkDecodeRequest,
  AudioWatermarkDecodeResponse,
  ContactRequest,
  CreditsBalanceResponse,
  CreditsUsageResponse,
  CreditTransaction,
  ExternalImportCreatedResponse,
  ExternalImportRequest,
  LoginUserRequest,
  LoginUser200ResponseData,
  LoginUser200ResponseDataUser,
  WorkflowCancelResponse,
  WorkflowResumeResponse,
  WorkflowPausedDetail,
  WorkflowPausedDetailLinks,
  UploadResponse,
  UploadConstraintsApplied,
  UploadProbeResponse,
  UploadProbeMediaMetadata,
  // Multipart-upload option type — surfaced via UploadOptions.metadataHint
  // on the public uploadFile() method.
  MultipartInitiateRequestMetadataHint,
  WorkflowCreateResponse,
  WorkflowStatusResponse,
  WorkflowListResponse,
  WorkflowSummary,
  WorkflowDownloadResponse,
  MetadataResponse,
  // Nested metadata shapes reachable from getMetadata() return value —
  // consumers reading exif / dimensions / GPS need these to type their
  // helpers without deep imports.
  MetadataResponseDimensions,
  MetadataResponseExif,
  MetadataResponseExifGps,
  OperationsSchemaResponse,
  // Operation-capability projection types (qUhxfDA5) — reachable from the
  // ergonomic `capabilities()` helper's `CapabilitiesSnapshot` return so
  // consumers can type against the tier-scoped capability matrix, the
  // output-property table, and the image-encode capability matrix.
  OperationCapability,
  OutputProperties,
  ImageEncodeCapabilities,
  // Nested schema types reachable from OperationsSchemaResponse.operations
  // — consumers building dynamic UIs that discover available operations
  // type their form-renderer helpers as `(opt: OptionSchema) => …` etc.
  OperationSchemaDefinition,
  MimeGroupSchema,
  OptionSchema,
  PerValueAvailabilityEntry,
  // Per-role cardinality entry — contracts v2.15 (AJCLLGaG, ADR-0015).
  // Surfaced on OperationSchemaDefinition.perRoleCardinality so form-
  // renderers can decide whether a multi-input role accepts 0 or 1 OR
  // 1+ inputs (audio_to_video's optional `overlay` role is the
  // first such case).
  PerRoleCardinalityEntry,
  RetryResponse,
  JobDownload,
  OperationDownload,
  // The zip-all "download all" response shape (contracts v2.94.0) — reachable
  // from WorkflowDownloadResponse.bundle; re-exported so consumers can name it.
  DownloadBundle,
  WebhookPayload,
  WebhookOperationContext,
  JobResponse,
  OperationResponse,
  OperationResult,
  // Per-operation metrics surfaced on OperationResult.metrics.
  OperationResultMetrics,
  ExternalDestination,
  Delivery,
  DeliveryPlan,
  DeliveryPlanOutput,
  WorkflowProcessing,
  ProcessingPlan,
  ProcessingPlanJob,
  WorkflowEdge,
  WorkflowWarning,
  JobInputV2,
  WorkflowSource,
  // Response-side WorkflowSource union members — needed when consumers
  // narrow on `source.type` and want to type a helper as
  // `(source: UploadSource) => …`. Distinct from the SDK's hand-written
  // *Payload variants (request-side, snake_case wire shape).
  UploadSource,
  JobOutputSource,
  ConnectionSource,
  ExternalImportToken,
  // Typed error payload types — paired with the GislApiError subclasses
  // exported above. Consumers narrow on `error instanceof Gisl<X>Error`
  // and read `error.payload` typed as the corresponding response shape.
  BalanceExhaustedResponse,
  BalanceExhaustedResponseAllOfLinks,
  TierRestrictionResponse,
  FeatureTierRestrictedResponse,
  FeatureNotAvailableResponse,
  FeatureViolation,
  WorkflowExpiredResponse,
  ProbePendingResponse,
  AuthErrorResponse,
} from '@giveitsmaller/contracts/openapi';

export {
  AudioWatermarkDecodeRequestMethodHintEnum,
  AudioWatermarkDecodeResponseMethodEnum,
  // OperationInputModel — value-bearing enum (`single` | `multi`).
  // Surfaced on OperationSchemaDefinition.inputModel so form-renderers
  // can decide whether to render a single-file picker or a multi-file
  // input list.
  OperationInputModel,
  ExternalImportRequestProviderHintEnum,
  ContactSubject,
  CreditTransactionSourceBucket,
  UploadProbeStatus,
  UploadProbeProcessingClass,
  WorkflowCancelBillingEffect,
  WorkflowPauseRequiredAction,
  WorkflowStatus,
  WarningType,
  WorkflowWarningSeverity,
  OperationType,
  SseEventType,
  CallbackEventType,
  OperationStatus,
  JobStatus,
  JobInputV2RoleEnum,
  // Error-payload discriminator enums — pair with the typed payload
  // types above for narrowing inside `error instanceof Gisl<X>Error`
  // branches.
  AuthErrorType,
  TierRestrictionKind,
  BalanceExhaustedResponseRequiredActionEnum,
  ProcessingClassReason,
  DeliveryPlanReason,
  // UserTier + ProcessingClass — value-bearing forms (typeof const +
  // type alias). Sourced from openapi so consumers can do
  // `Object.values(UserTier)` for tier dropdowns or
  // `if (tier === UserTier.enterprise)` for narrowing typed error
  // payloads. The operations metadata-types versions are pure type
  // aliases (no runtime value); the openapi versions carry both the
  // string-union type and a const map. Per audit follow-up.
  UserTier,
  ProcessingClass,
} from '@giveitsmaller/contracts/openapi';

export type {
  SseOperationProgressData,
  SseOperationCompletedData,
  SseOperationFailedData,
  SseJobCompletedData,
  SseJobFailedData,
  SseWorkflowTerminalData,
} from '@giveitsmaller/contracts/openapi';

// AsyncAPI multi-output completion envelopes (ADR-0009 §D2). Surfaced
// here so consumers of SSE/webhook payloads can type-narrow `outputs[]`
// access on convert PDF -> image and other multi-output workflows.
//
// Note: the AsyncAPI `OperationResult` (an untagged discriminated union
// over Single/Multi/Failure per the v2.7.0 reshape) is NOT re-exported
// here — its name collides with the OpenAPI HTTP-side `OperationResult`
// (a flat response shape, re-exported above from `/openapi`). Consumers
// narrow event payloads via the three subtype shapes directly.
export type {
  MultiOutputCompletion,
  PageIndexed,
  PositionIndexed,
  Unindexed,
} from '@giveitsmaller/contracts/asyncapi';

// SDK-side ergonomic alias for `MultiOutputCompletion.outputs[]` entries.
// The AsyncAPI spec inlines this union inside `MultiOutputCompletion`,
// so it isn't a named TS type today; the Rust crate already names it
// (`OperationResultOutputEntry` in `generated/rust/asyncapi/`). A
// contracts follow-up will name the union in `asyncapi/events.yaml`
// (matching the JobInputRole / ReEncodeDecision precedent); the
// drift-assertion below makes the alias auto-fail at `tsc --noEmit`
// when the generator catches up, so the alias can be deleted cleanly.
import type {
  MultiOutputCompletion as _MultiOutputCompletion,
  PageIndexed as _PageIndexed,
  PositionIndexed as _PositionIndexed,
  Unindexed as _Unindexed,
} from '@giveitsmaller/contracts/asyncapi';
export type OperationResultOutputEntry = _MultiOutputCompletion['outputs'][number];

// Drift assertion — must live in `src/` (not `tests/`) so `tsc --noEmit`
// actually checks it: the package's `tsconfig.json` excludes `tests/`
// and `vitest.config.ts` doesn't enable `test.typecheck`, so a
// type-equality assertion in a vitest case is a runtime no-op (memory:
// T20/PR #49). This pattern mirrors `_WorkflowCreatePayloadDriftAssertion`
// in `./types.ts`.
type _OperationResultOutputEntryExpected = _PageIndexed | _PositionIndexed | _Unindexed;
type _OperationResultOutputEntryExtraAlias = Exclude<
  OperationResultOutputEntry,
  _OperationResultOutputEntryExpected
>;
type _OperationResultOutputEntryMissingAlias = Exclude<
  _OperationResultOutputEntryExpected,
  OperationResultOutputEntry
>;
type _OperationResultOutputEntryDrift = [_OperationResultOutputEntryExtraAlias] extends [never]
  ? [_OperationResultOutputEntryMissingAlias] extends [never]
    ? true
    : ['DRIFT: OperationResultOutputEntry is missing arms vs PageIndexed|PositionIndexed|Unindexed', _OperationResultOutputEntryMissingAlias]
  : ['DRIFT: OperationResultOutputEntry has arms not in PageIndexed|PositionIndexed|Unindexed', _OperationResultOutputEntryExtraAlias];
type _AssertTrue<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _OperationResultOutputEntryDriftAssertion = _AssertTrue<_OperationResultOutputEntryDrift>;

// T2 / xVDTIm8C — drift assertion: `Artifact` is a projection of
// `OperationDownload` with `url` aliasing `downloadUrl` and the rest
// verbatim (`jobId` + `ref` come from the parent `JobDownload`, not from
// the file entry itself). Any contracts regen that renames or drops a
// projected field breaks here at `tsc --noEmit` rather than silently
// shifting the projection (codex-reviewer P1 — claimed in T2 PR but
// initially missing).
import type { OperationDownload as _OperationDownload } from '@giveitsmaller/contracts/openapi';
import type { Artifact as _Artifact } from './builder.js';
// The Artifact fields that MUST be backed by OperationDownload:
type _ArtifactFromDownload = 'filename' | 'sizeBytes' | 'operation' | 'operationId' | 'pageIndex' | 'position';
// Confirm each of these exists on OperationDownload. If a field is
// renamed/dropped upstream, the Extract becomes `never` and the assert
// below fires.
type _OperationDownloadHasFields = Extract<_ArtifactFromDownload, keyof _OperationDownload> extends _ArtifactFromDownload
  ? true
  : ['DRIFT: OperationDownload missing one of', _ArtifactFromDownload];
// Confirm OperationDownload.downloadUrl exists (the `url` alias source):
type _OperationDownloadHasDownloadUrl = 'downloadUrl' extends keyof _OperationDownload
  ? true
  : ['DRIFT: OperationDownload.downloadUrl (aliased by Artifact.url) missing'];
// Confirm Artifact still has `url` + `jobId` + `ref` (the alias + parent
// fields — easy to accidentally drop on a refactor):
type _ArtifactSurfaceComplete = ('url' | 'jobId' | 'ref') extends keyof _Artifact
  ? true
  : ['DRIFT: Artifact missing url/jobId/ref'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ArtifactDriftAssertion = [
  _AssertTrue<_OperationDownloadHasFields>,
  _AssertTrue<_OperationDownloadHasDownloadUrl>,
  _AssertTrue<_ArtifactSurfaceComplete>,
];

// FF1 / 3BIxEnfR — drift assertion: the file-first `OutputFile` is a lean
// projection of `OperationDownload` (`url` aliases `downloadUrl`;
// `filename`/`sizeBytes`/`operation` verbatim; the target-size outcome
// `chosenQuality`/`targetSizeMet` projected verbatim per 9u4YGZ4V). A contracts
// regen that renames or drops one of these breaks here at `tsc --noEmit` (same
// gating pattern as `_ArtifactDriftAssertion` above).
import type { OutputFile as _OutputFile } from './file-first.js';
type _OutputFileFromDownload =
  | 'filename'
  | 'sizeBytes'
  | 'operation'
  | 'chosenQuality'
  | 'targetSizeMet';
type _OperationDownloadHasOutputFileFields =
  Extract<_OutputFileFromDownload, keyof _OperationDownload> extends _OutputFileFromDownload
    ? true
    : ['DRIFT: OperationDownload missing one of', _OutputFileFromDownload];
type _OutputFileHasUrl = 'url' extends keyof _OutputFile
  ? true
  : ['DRIFT: OutputFile.url missing'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _OutputFileDriftAssertion = [
  _AssertTrue<_OperationDownloadHasOutputFileFields>,
  _AssertTrue<_OutputFileHasUrl>,
];

// Re-export all operation option types
export type {
  CompressImageOptions,
  // Per-input-format image-compress option types (contracts v2.80.0): the
  // aggregate CompressImageOptions carries the common {quality, metadata,
  // output_format}; these add the format-specific knobs — JPEG `progressive`,
  // PNG `optimization_level`, AVIF `avif_speed`.
  CompressImageJpegOptions,
  CompressImagePngOptions,
  CompressImageAvifOptions,
  CompressVideoOptions,
  CompressAudioOptions,
  CompressDocumentPdfOptions,
  CompressDocumentOfficeOptions,
  CompressDocumentOdfOptions,
  CompressDocumentEpubOptions,
  ThumbnailImageOptions,
  ThumbnailVideoOptions,
  ThumbnailDocumentOptions,
  ConvertImageOptions,
  ConvertVideoOptions,
  ConvertAudioOptions,
  ConvertDocumentPdfOptions,
  MergeImageOptions,
  MergeVideoOptions,
  MergeVideoPerInputOptions,
  MergeAudioOptions,
  MergeAudioPerInputOptions,
  // MergeDocumentOptions / MergeDocumentPerInputOptions removed in v2:
  // MergeOutputType was narrowed to drop `image` and `document` per the
  // spike doc (§3, I12 BREAKING). Consumer migration guidance: T17
  // (mCRKA1m5).
  ArchiveOptions,
  // V1 `watermark` was split into `image_watermark` (multi-input,
  // base + overlay) and `text_watermark` (single-input, image base) at
  // the v2 cutover (I4-CONS, ADR-0004 §Greenfield V2.0). Consumer
  // migration guidance lives in T17 (mCRKA1m5).
  ImageWatermarkImageOptions,
  ImageWatermarkImageGifOptions,
  TextWatermarkImageOptions,
  // Planned operation option types. The contract carries full schemas
  // for these (so consumers can type their code today), but the API
  // returns `feature_not_available` (422) until Lambda support ships.
  // Detect planned status via the metadata sidecars below before
  // sending requests.
  CustomLumaVideoOptions,
  AudioOverlayAudioOptions,
  AudioOverlayVideoOptions,
  AudioWatermarkAudioOptions,
  AudioWatermarkVideoOptions,
  // New planned operation option types — contracts v2.15 (AJCLLGaG).
  AudioToVideoAudioOptions,
  VideoWatermarkVideoOptions,
  VideoTextWatermarkVideoOptions,
  SplitImageGifOptions,
  SplitDocumentPdfOptions,
  SplitAudioOptions,
  SplitVideoOptions,
} from '@giveitsmaller/contracts/operations';

export {
  ImageWatermarkImageAnchor,
  ImageWatermarkImageGifAnchor,
  TextWatermarkImageAnchor,
  TextWatermarkImageFontFamily,
  TextWatermarkImageWatermarkMode,
  AudioOverlayAudioMode,
  AudioOverlayVideoMode,
  AudioOverlayVideoNoAudioTrackBehaviour,
  AudioWatermarkAudioMethod,
  AudioWatermarkAudioRobustness,
  AudioWatermarkAudioDensity,
  AudioWatermarkVideoMethod,
  AudioWatermarkVideoRobustness,
  AudioWatermarkVideoDensity,
  // New planned operation enums — contracts v2.15 (AJCLLGaG).
  AudioToVideoAudioOutputResolution,
  AudioToVideoAudioImageFit,
  AudioToVideoAudioOutputFormat,
  VideoWatermarkVideoAnchor,
  VideoTextWatermarkVideoFontFamily,
  VideoTextWatermarkVideoWatermarkMode,
  VideoTextWatermarkVideoAnchor,
  SplitImageGifOutputFormat,
  SplitDocumentPdfMode,
  SplitAudioMode,
  SplitAudioPrecision,
  SplitVideoMode,
  SplitVideoPrecision,
} from '@giveitsmaller/contracts/operations';

// Per-operation metadata sidecars. Inspect `availability`,
// `required_tier`, per-value gating, mime-group availability and
// per-feature flags before submitting a workflow — the API will
// otherwise reject planned ops with `feature_not_available` (422,
// surfaces as `GislFeatureNotAvailableError`).
export {
  archiveMetadata,
  audioOverlayMetadata,
  audioWatermarkMetadata,
  compressMetadata,
  convertMetadata,
  customLumaMetadata,
  imageWatermarkMetadata,
  mergeMetadata,
  textWatermarkMetadata,
  thumbnailMetadata,
  // New planned operation metadata sidecars — contracts v2.15 (AJCLLGaG).
  audioToVideoMetadata,
  videoWatermarkMetadata,
  videoTextWatermarkMetadata,
  splitMetadata,
} from '@giveitsmaller/contracts/operations';
// Typed per-op option interfaces for the ergonomic verbs (card Dhje3Faq).
export type {
  ConvertOptions,
  ThumbnailOptions,
  TextWatermarkOptions,
  WatermarkOptions,
  WatermarkAnchor,
} from './ergonomic/option_types.js';
export type {
  OperationMetadata,
  AvailabilityValue,
  AvailabilityEntry,
  FeatureEntry,
  MimeGroupMetadata,
  OptionMetadata,
  ProcessingClassConstraints,
  // UserTier + ProcessingClass moved to the openapi value-bearing
  // re-export above (per audit follow-up). The operations versions are
  // pure type aliases — switching to the openapi source gives consumers
  // both the type AND the runtime const map without changing the wire
  // shape (verified identical by the audit).
} from '@giveitsmaller/contracts/operations';
