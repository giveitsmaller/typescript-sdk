import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  UploadResponseFromJSON,
  MultipartInitiateResponseFromJSON,
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
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 min

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  WorkflowStatus.completed,
  WorkflowStatus.failed,
  WorkflowStatus.partially_failed,
]);

export class GislClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly multipartThreshold: number;
  private readonly multipartConcurrency: number;

  constructor(config: GislClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.multipartThreshold = config.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
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
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      if (!response.ok) {
        throw new GislApiError(response.status, `Non-JSON error from ${path}`);
      }
      return undefined as unknown as T;
    }

    const json = await response.json();

    // Schema endpoint returns raw JSON (no envelope)
    if (path === '/api/operations/schema') {
      if (!response.ok) {
        throw new GislApiError(response.status, json.error ?? 'Unknown error');
      }
      return deserialize ? deserialize(json) : (json as T);
    }

    // Standard envelope: { success, data } or { success, error, details }
    if (!response.ok || json.success === false) {
      if (json.details && Array.isArray(json.details)) {
        throw new GislValidationError(response.status, json.error ?? 'Validation error', json.details);
      }
      throw new GislApiError(response.status, json.error ?? 'Unknown error');
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

  private async multipartUpload(
    blob: Blob,
    fileName: string,
    totalSize: number,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    // Step 1: Initiate with first chunk
    const firstChunkSize = Math.min(totalSize, this.multipartThreshold);
    const firstChunk = blob.slice(0, firstChunkSize);

    const initiateForm = new FormData();
    initiateForm.append('chunk', firstChunk, fileName);
    initiateForm.append('original_name', fileName);
    initiateForm.append('total_size_bytes', totalSize.toString());

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
    const etags: Array<{ part_number: number; etag: string }> = [];
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

      etags.push({ part_number: part.partNumber, etag });
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

    // Step 3: Complete multipart upload
    etags.sort((a, b) => a.part_number - b.part_number);

    return this.request<UploadResponse>('POST', '/api/uploads/multipart/complete', {
      body: {
        file_id: initResponse.fileId,
        parts: etags,
      },
      deserialize: UploadResponseFromJSON,
    });
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
    return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/download`, {
      deserialize: WorkflowDownloadResponseFromJSON,
    });
  }

  /**
   * Stream SSE events for a workflow. Returns an async iterable.
   */
  async streamEvents(workflowId: string): Promise<AsyncGenerator<GislSseEvent>> {
    const response = await this.request<Response>(
      'GET',
      `/api/workflows/${encodeURIComponent(workflowId)}/events`,
      { rawResponse: true },
    );

    if (!response.ok) {
      await this.handleResponse(response, `/api/workflows/${workflowId}/events`);
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
