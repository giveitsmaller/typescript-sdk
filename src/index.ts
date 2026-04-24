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
  FileJobPayload,
  SourceJobPayload,
  InputsJobPayload,
  JobDefinitionPayload,
} from './types.js';
export { fileJob, sourceJob, inputsJob } from './types.js';

// Errors
export {
  GislError,
  GislApiError,
  GislValidationError,
  GislTimeoutError,
  GislAbortError,
} from './errors.js';

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
  ExportConfig,
} from '@giveitsmaller/contracts/openapi';

export {
  WorkflowStatus,
  OperationType,
  SseEventType,
  CallbackEventType,
  OperationStatus,
  JobStatus,
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
  MergeDocumentOptions,
  MergeDocumentPerInputOptions,
  ArchiveOptions,
} from '@giveitsmaller/contracts/operations';
