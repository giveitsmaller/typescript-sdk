// SDK classes and functions
export { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from './client.js';
export { verifyWebhook } from './webhook.js';
export { parseSseStream } from './sse.js';

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
  ContactRequest,
  CreditsBalanceResponse,
  CreditsUsageResponse,
  CreditTransaction,
  UploadResponse,
  UploadProbeResponse,
  UploadProbeMediaMetadata,
  WorkflowCreateResponse,
  WorkflowStatusResponse,
  WorkflowDownloadResponse,
  MetadataResponse,
  OperationsSchemaResponse,
  RetryResponse,
  JobDownload,
  OperationDownload,
  WebhookPayload,
  JobResponse,
  OperationResponse,
  OperationResult,
  ExternalDestination,
  Delivery,
  WorkflowProcessing,
  JobInputV2,
  WorkflowSource,
} from '@giveitsmaller/contracts/openapi';

export {
  ContactSubject,
  CreditTransactionSourceBucket,
  UploadProbeStatus,
  UploadProbeProcessingClass,
  WorkflowStatus,
  OperationType,
  SseEventType,
  CallbackEventType,
  OperationStatus,
  JobStatus,
  JobInputV2RoleEnum,
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
  ProcessingClass,
  ProcessingClassConstraints,
  UserTier,
} from '@giveitsmaller/contracts/operations';
