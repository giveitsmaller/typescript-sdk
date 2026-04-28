// SDK classes and functions
export { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from './client.js';
export { verifyWebhook } from './webhook.js';
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
  GetSchemaOptions,
  GetSchemaResult,
  PreflightClipError,
  PreflightClipsResult,
  GislClientConfig,
  GislSseEvent,
  UploadOptions,
  WaitOptions,
  WorkflowCreatePayload,
  OperationDef,
  WorkflowSourcePayload,
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
} from './types.js';
export {
  uploadSource,
  jobOutputSource,
  externalImportSource,
  connectionSource,
} from './types.js';

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
  GislAuthError,
  GislTimeoutError,
  GislAbortError,
} from './errors.js';
export type { GislApiErrorOptions } from './errors.js';

// Re-export key contract types so users only need @giveitsmaller/sdk
export type {
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
  WorkflowDownloadResponse,
  MetadataResponse,
  // Nested metadata shapes reachable from getMetadata() return value —
  // consumers reading exif / dimensions / GPS need these to type their
  // helpers without deep imports.
  MetadataResponseDimensions,
  MetadataResponseExif,
  MetadataResponseExifGps,
  OperationsSchemaResponse,
  // Nested schema types reachable from OperationsSchemaResponse.operations
  // — consumers building dynamic UIs that discover available operations
  // type their form-renderer helpers as `(opt: OptionSchema) => …` etc.
  OperationSchemaDefinition,
  MimeGroupSchema,
  OptionSchema,
  PerValueAvailabilityEntry,
  RetryResponse,
  JobDownload,
  OperationDownload,
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

// Re-export all operation option types
export type {
  CompressImageOptions,
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
  ImageWatermarkVideoOptions,
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
} from '@giveitsmaller/contracts/operations';

export {
  ImageWatermarkImageAnchor,
  ImageWatermarkImageGifAnchor,
  ImageWatermarkVideoAnchor,
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
} from '@giveitsmaller/contracts/operations';
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
