// SDK classes and functions
export { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from './client.js';
export { verifyWebhook } from './webhook.js';
export { parseSseStream } from './sse.js';

// SDK types and factories
export type {
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
  UploadResponse,
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
  // spike doc (§3, I12 BREAKING). Consumer migration guidance lives in
  // T8a (AJlSc6DI / mCRKA1m5).
  ArchiveOptions,
} from '@giveitsmaller/contracts/operations';
