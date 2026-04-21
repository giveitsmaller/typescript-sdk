import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  UploadResponseFromJSON,
  MultipartInitiateResponseFromJSON,
  MultipartCompleteResponseFromJSON,
  MultipartCompleteRequestToJSON,
  WorkflowCreateResponseFromJSON,
  WorkflowStatusResponseFromJSON,
  WorkflowDownloadResponseFromJSON,
  MetadataResponseFromJSON,
  OperationsSchemaResponseFromJSON,
  RetryResponseFromJSON,
  WorkflowStatus,
} from '@giveitsmaller/contracts/openapi';

import type {
  UploadResponse,
  MultipartInitiateResponse,
  MultipartCompleteResponse,
  MultipartCompleteRequest,
  WorkflowCreateResponse,
  WorkflowStatusResponse,
  WorkflowDownloadResponse,
  MetadataResponse,
  OperationsSchemaResponse,
  RetryResponse,
} from '@giveitsmaller/contracts/openapi';

import { GislApiError, GislError, GislTimeoutError, GislValidationError } from './errors.js';
import { parseSseStream } from './sse.js';
import type {
  GislClientConfig,
  GislSseEvent,
  UploadOptions,
  WaitOptions,
  WorkflowCreatePayload,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MULTIPART_CONCURRENCY = 4;
// Fixed per contract (compression_contracts/openapi/api.yaml:134). The server
// uses the first chunk for MIME detection + throughput measurement and stores
// it as S3 multipart part 1. Must NOT be derived from multipartThreshold —
// that is the "use multipart above this size" routing threshold, a separate
// concept. Conflating them caused the /api/uploads/multipart/initiate 413.
export const DEFAULT_MULTIPART_FIRST_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 min

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  WorkflowStatus.completed,
  WorkflowStatus.failed,
  WorkflowStatus.partially_failed,
]);

function isValidationDetails(
  value: unknown,
): value is Array<{ field: string; message: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (el) =>
        typeof el === 'object' &&
        el !== null &&
        typeof (el as { field?: unknown }).field === 'string' &&
        typeof (el as { message?: unknown }).message === 'string',
    )
  );
}

export class GislClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly multipartThreshold: number;
  private readonly multipartConcurrency: number;

  constructor(config: GislClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    // Floor the threshold at the first-chunk size: the multipart initiate
    // must always carry an 8MB chunk, so routing a sub-8MB file into the
    // multipart path would violate the contract.
    this.multipartThreshold = Math.max(
      config.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD,
      DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
    );
    this.multipartConcurrency = config.multipartConcurrency ?? DEFAULT_MULTIPART_CONCURRENCY;

    this.headers = { ...config.headers };
    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  // -----------------------------------------------------------------------
  // Internal HTTP
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: BodyInit | Record<string, unknown>;
      json?: boolean;
      deserialize?: (raw: unknown) => T;
      rawResponse?: boolean;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { ...this.headers };
    let body: BodyInit | undefined;

    if (opts.json !== false && opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else {
      body = opts.body as BodyInit | undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new GislTimeoutError(`Request to ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (opts.rawResponse) {
      return response as unknown as T;
    }

    return this.handleResponse(response, path, opts.deserialize);
  }

  private async handleResponse<T>(
    response: Response,
    path: string,
    deserialize?: (raw: unknown) => T,
  ): Promise<T> {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const isJsonContent = contentType.includes('application/json') || contentType.includes('+json');
    if (!isJsonContent) {
      if (!response.ok) {
        throw new GislApiError(response.status, 'Non-JSON response', path);
      }
      return undefined as unknown as T;
    }

    let json: { success?: boolean; data?: unknown; error?: string; details?: unknown };
    try {
      json = await response.json();
    } catch {
      throw new GislApiError(response.status, 'Invalid JSON response', path);
    }

    // Schema endpoint returns raw JSON (no envelope)
    if (path === '/api/operations/schema') {
      if (!response.ok) {
        throw new GislApiError(response.status, json.error ?? 'Unknown error', path);
      }
      return deserialize ? deserialize(json) : (json as T);
    }

    // Standard envelope: { success, data } or { success, error, details }
    if (!response.ok || json.success === false) {
      if (isValidationDetails(json.details)) {
        throw new GislValidationError(
          response.status,
          json.error ?? 'Validation error',
          json.details,
          path,
        );
      }
      throw new GislApiError(
        response.status,
        json.error ?? 'Unknown error',
        path,
        json.details,
      );
    }

    const data = json.data ?? json;
    return deserialize ? deserialize(data) : (data as T);
  }

  // -----------------------------------------------------------------------
  // Upload
  // -----------------------------------------------------------------------

  /**
   * Upload a file. Automatically uses multipart upload for files exceeding
   * the configured threshold (default 10 MB).
   *
   * @param file  File path (string) or a Blob/File instance.
   * @param options  Upload options including progress callback.
   */
  async uploadFile(
    file: string | Blob,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    let blob: Blob;
    let fileName: string;
    let fileSize: number;

    if (typeof file === 'string') {
      const stat = statSync(file);
      fileSize = stat.size;
      fileName = basename(file);
      const content = readFileSync(file);
      blob = new Blob([content]);
    } else {
      blob = file;
      fileName = (file as File).name ?? 'upload';
      fileSize = file.size;
    }

    if (fileSize > this.multipartThreshold) {
      return this.multipartUpload(blob, fileName, fileSize, options);
    }

    return this.singleUpload(blob, fileName);
  }

  private async singleUpload(blob: Blob, fileName: string): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', blob, fileName);

    return this.request('POST', '/api/uploads', {
      body: form,
      json: false,
      deserialize: UploadResponseFromJSON,
    });
  }

  /**
   * Direct-to-S3 multipart upload for files above the threshold.
   *
   * The /multipart/complete response (MultipartCompleteResponse) only carries
   * { upload_id, status }. The server's upload_id is the same UUID callers
   * pass as file_id to POST /api/workflows — so fileId is synthesised from
   * upload_id and a full UploadResponse is returned to keep the public
   * uploadFile() API uniform across single and multipart paths. The mimeType
   * comes from the initiate response's first-chunk detection; for authoritative
   * post-upload metadata callers should use getMetadata(fileId).
   */
  private async multipartUpload(
    blob: Blob,
    fileName: string,
    totalSize: number,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    // Step 1: Initiate with first chunk
    const firstChunkSize = Math.min(totalSize, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
    const firstChunk = blob.slice(0, firstChunkSize);

    const initiateForm = new FormData();
    initiateForm.append('file', firstChunk, fileName);
    initiateForm.append('filename', fileName);
    initiateForm.append('total_size', totalSize.toString());

    const initResponse = await this.request<MultipartInitiateResponse>(
      'POST',
      '/api/uploads/multipart/initiate',
      {
        body: initiateForm,
        json: false,
        deserialize: MultipartInitiateResponseFromJSON,
      },
    );

    let uploadedBytes = firstChunkSize;
    options?.onProgress?.(uploadedBytes, totalSize);

    // Step 2: Upload remaining chunks to S3 presigned URLs
    const etags: Array<{ partNumber: number; etag: string }> = [];
    const presignedUrls = initResponse.presignedUrls;
    const chunkSize = initResponse.recommendedChunkSize;

    const uploadChunk = async (index: number): Promise<void> => {
      const part = presignedUrls[index];
      const start = firstChunkSize + index * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const chunk = blob.slice(start, end);

      const s3Response = await fetch(part.url, {
        method: 'PUT',
        body: chunk,
        headers: { 'Content-Length': (end - start).toString() },
      });

      if (!s3Response.ok) {
        throw new GislError(`S3 chunk upload failed for part ${part.partNumber}: ${s3Response.status}`);
      }

      const etag = s3Response.headers.get('etag');
      if (!etag) {
        throw new GislError(`S3 response missing ETag for part ${part.partNumber}`);
      }

      etags.push({ partNumber: part.partNumber, etag });
      uploadedBytes += end - start;
      options?.onProgress?.(uploadedBytes, totalSize);
    };

    // Upload with concurrency limit
    const queue = [...presignedUrls.keys()];
    const workers = Array.from(
      { length: Math.min(this.multipartConcurrency, queue.length) },
      async () => {
        while (queue.length > 0) {
          const index = queue.shift()!;
          await uploadChunk(index);
        }
      },
    );
    await Promise.all(workers);

    // Step 3: Complete multipart upload.
    // Build a typed MultipartCompleteRequest and serialise via the generated
    // ToJSON helper — tsc now catches any field-name drift between the SDK
    // and the OpenAPI spec (see contract-drift-fields.test.ts describe 'c').
    etags.sort((a, b) => a.partNumber - b.partNumber);

    const completeRequest: MultipartCompleteRequest = {
      uploadId: initResponse.uploadId,
      parts: etags,
    };

    // MultipartCompleteRequestToJSON's declared return type is the camelCase
    // `MultipartCompleteRequest` interface, but at runtime it returns the
    // snake_case wire object — an openapi-generator v7 quirk. The drift gate
    // for field names lives at `completeRequest: MultipartCompleteRequest`
    // above; the local wire type + runtime sanity check below guard against
    // the remaining hypothetical: a future generator version emitting a
    // different shape without the declared type catching it.
    const wireCompleteBody = MultipartCompleteRequestToJSON(completeRequest) as unknown as {
      upload_id: string;
      parts: Array<{ part_number: number; etag: string }>;
    };
    if (
      typeof wireCompleteBody?.upload_id !== 'string' ||
      !Array.isArray(wireCompleteBody?.parts)
    ) {
      throw new GislError(
        'MultipartCompleteRequestToJSON returned an unexpected shape — generator output may have changed.',
      );
    }

    const completeResp = await this.request<MultipartCompleteResponse>(
      'POST',
      '/api/uploads/multipart/complete',
      {
        body: wireCompleteBody as unknown as Record<string, unknown>,
        deserialize: MultipartCompleteResponseFromJSON,
      },
    );

    // Defensive: the status enum currently has only 'completed', but guard
    // against future expansion so an unexpected terminal state doesn't pass
    // as a successful upload.
    if (completeResp.status !== 'completed') {
      throw new GislError(
        `Multipart upload completed with unexpected status: ${completeResp.status}`,
      );
    }

    return {
      fileId: completeResp.uploadId,
      originalName: fileName,
      mimeType: initResponse.mimeType,
      sizeBytes: blob.size,
    };
  }

  // -----------------------------------------------------------------------
  // Workflows
  // -----------------------------------------------------------------------

  /**
   * Create a new workflow.
   */
  async createWorkflow(payload: WorkflowCreatePayload): Promise<WorkflowCreateResponse> {
    return this.request('POST', '/api/workflows', {
      body: payload as unknown as Record<string, unknown>,
      deserialize: WorkflowCreateResponseFromJSON,
    });
  }

  /**
   * Get current workflow status.
   */
  async getWorkflowStatus(workflowId: string): Promise<WorkflowStatusResponse> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/status`, {
      deserialize: WorkflowStatusResponseFromJSON,
    });
  }

  /**
   * Poll until the workflow reaches a terminal status.
   */
  async waitForWorkflow(
    workflowId: string,
    options?: WaitOptions,
  ): Promise<WorkflowStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.getWorkflowStatus(workflowId);
      options?.onPoll?.(status.status);

      if (TERMINAL_STATUSES.has(status.status)) {
        return status;
      }

      if (Date.now() + intervalMs > deadline) {
        throw new GislTimeoutError(
          `Workflow ${workflowId} did not complete within ${timeoutMs}ms`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Get download URLs for a completed workflow.
   */
  async getWorkflowDownloads(workflowId: string): Promise<WorkflowDownloadResponse> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/downloads`, {
      deserialize: WorkflowDownloadResponseFromJSON,
    });
  }

  /**
   * Stream SSE events for a workflow. Returns an async iterable.
   */
  async streamEvents(workflowId: string): Promise<AsyncGenerator<GislSseEvent>> {
    const eventsPath = `/api/workflows/${encodeURIComponent(workflowId)}/events`;
    const response = await this.request<Response>(
      'GET',
      eventsPath,
      { rawResponse: true },
    );

    if (!response.ok) {
      await this.handleResponse(response, eventsPath);
    }

    return parseSseStream(response);
  }

  // -----------------------------------------------------------------------
  // File metadata
  // -----------------------------------------------------------------------

  /**
   * Get metadata for an uploaded file.
   */
  async getMetadata(fileId: string): Promise<MetadataResponse> {
    return this.request('GET', `/api/uploads/${encodeURIComponent(fileId)}/metadata`, {
      deserialize: MetadataResponseFromJSON,
    });
  }

  // -----------------------------------------------------------------------
  // Operations
  // -----------------------------------------------------------------------

  /**
   * Get the operations schema (available types, options, constraints).
   * This endpoint returns raw JSON (no envelope) and is CDN-cacheable.
   */
  async getSchema(): Promise<OperationsSchemaResponse> {
    return this.request('GET', '/api/operations/schema', {
      deserialize: OperationsSchemaResponseFromJSON,
    });
  }

  /**
   * Retry a failed operation.
   */
  async retryOperation(operationId: string): Promise<RetryResponse> {
    return this.request('POST', `/api/operations/${encodeURIComponent(operationId)}/retry`, {
      deserialize: RetryResponseFromJSON,
    });
  }
}
