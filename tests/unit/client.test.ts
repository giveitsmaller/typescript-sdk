import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE } from '../../src/client.js';
import { GislAbortError, GislApiError, GislValidationError, GislTimeoutError } from '../../src/errors.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GislClient', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Envelope handling
  // -----------------------------------------------------------------------

  describe('envelope handling', () => {
    it('unwraps success envelope and returns data', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'abc', original_name: 'test.jpg', mime_type: 'image/jpeg', size_bytes: 1024 },
        }),
      );

      const result = await client.getMetadata('abc');
      expect(result.fileId).toBe('abc');
      expect(result.originalName).toBe('test.jpg');
    });

    it('throws GislApiError on error envelope with endpoint path in message', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'Not found' }, 404),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(404);
        expect(apiErr.errorMessage).toBe('Not found');
        expect(apiErr.path).toBe('/api/uploads/xyz/metadata');
        expect(apiErr.message).toBe(
          'API error 404 at /api/uploads/xyz/metadata: Not found',
        );
      }
    });

    it('throws GislValidationError on validation error envelope (array-shape details)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Validation failed',
            details: [{ field: 'file', message: 'File is required' }],
          },
          400,
        ),
      );

      try {
        await client.getMetadata('bad');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislValidationError);
        const validationErr = err as GislValidationError;
        expect(validationErr.details).toHaveLength(1);
        expect(validationErr.details[0].field).toBe('file');
        expect(validationErr.path).toBe('/api/uploads/bad/metadata');
      }
    });

    it('forwards non-array details through GislApiError (does NOT escalate to GislValidationError)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Conflict',
            details: { reason: 'already_exists', conflicting_id: 'abc' },
          },
          409,
        ),
      );

      try {
        await client.getMetadata('conflict');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        expect(err).not.toBeInstanceOf(GislValidationError);
        const apiErr = err as GislApiError;
        expect(apiErr.details).toEqual({ reason: 'already_exists', conflicting_id: 'abc' });
        expect(apiErr.path).toBe('/api/uploads/conflict/metadata');
      }
    });

    it('includes endpoint path when server returns a non-JSON body', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      try {
        await client.getMetadata('nopjson');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(502);
        expect(apiErr.path).toBe('/api/uploads/nopjson/metadata');
        expect(apiErr.message).toBe(
          'API error 502 at /api/uploads/nopjson/metadata: Non-JSON response',
        );
      }
    });

    it('throws GislApiError with path when JSON body is malformed', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('not-json{', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      try {
        await client.getMetadata('broken');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.path).toBe('/api/uploads/broken/metadata');
        expect(apiErr.message).toBe(
          'API error 500 at /api/uploads/broken/metadata: Invalid JSON response',
        );
      }
    });

    it('falls back to GislApiError when details is an array but not validation-shape', async () => {
      // E.g. an array of bare strings or arbitrary objects — should NOT be
      // treated as validation errors (the old Array.isArray check would
      // have miscast it and consumers reading details[0].field would crash).
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'Bulk error', details: ['err-a', 'err-b'] },
          500,
        ),
      );

      try {
        await client.getMetadata('bulk');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        expect(err).not.toBeInstanceOf(GislValidationError);
        const apiErr = err as GislApiError;
        expect(apiErr.details).toEqual(['err-a', 'err-b']);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Auth headers
  // -----------------------------------------------------------------------

  describe('authentication', () => {
    it('sends Authorization header with API key', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await client.getMetadata('a');

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer test-key',
      );
    });

    it('sends custom headers', async () => {
      const customClient = new GislClient({
        baseUrl: 'https://api.example.com',
        headers: { 'X-Custom': 'value' },
      });

      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await customClient.getMetadata('a');

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['X-Custom']).toBe('value');
    });
  });

  // -----------------------------------------------------------------------
  // Workflow creation
  // -----------------------------------------------------------------------

  describe('createWorkflow', () => {
    it('sends wire-format JSON payload', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'pending',
            jobs: [],
          },
        }),
      );

      const result = await client.createWorkflow({
        jobs: [
          {
            ref: 'job-1',
            file_id: 'file-abc',
            operations: [{ type: 'compress', options: { quality: 80 } }],
          },
        ],
      });

      expect(result.workflowId).toBe('wf-1');
      expect(result.status).toBe('pending');

      // Verify the body was sent as JSON
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/workflows');
      expect((options.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
      const sentBody = JSON.parse(options.body as string);
      expect(sentBody.jobs[0].file_id).toBe('file-abc');
    });
  });

  // -----------------------------------------------------------------------
  // waitForWorkflow
  // -----------------------------------------------------------------------

  describe('waitForWorkflow', () => {
    it('polls until terminal status', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status: 'in_progress', jobs: [] },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status: 'completed', jobs: [] },
          }),
        );

      const result = await client.waitForWorkflow('wf-1', {
        intervalMs: 10,
        timeoutMs: 5000,
      });

      expect(result.status).toBe('completed');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws GislTimeoutError when deadline is exceeded', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status: 'in_progress', jobs: [] },
          }),
        ),
      );

      await expect(
        client.waitForWorkflow('wf-1', {
          intervalMs: 10,
          timeoutMs: 25,
        }),
      ).rejects.toThrow(GislTimeoutError);
    });

    it('calls onPoll callback with each status', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status: 'pending', jobs: [] },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status: 'completed', jobs: [] },
          }),
        );

      const statuses: string[] = [];
      await client.waitForWorkflow('wf-1', {
        intervalMs: 10,
        onPoll: (s) => statuses.push(s),
      });

      expect(statuses).toEqual(['pending', 'completed']);
    });
  });

  // -----------------------------------------------------------------------
  // Schema endpoint (raw response, no envelope)
  // -----------------------------------------------------------------------

  describe('getSchema', () => {
    it('handles raw JSON response (no envelope)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          schema_version: '2.0.0',
          operations: {
            compress: {
              description: 'Compress files',
              input_model: 'single',
              mime_groups: {},
              options: {},
            },
          },
        }),
      );

      const schema = await client.getSchema();
      expect(schema.schemaVersion).toBe('2.0.0');
      expect(schema.operations).toHaveProperty('compress');
    });
  });

  // -----------------------------------------------------------------------
  // retryOperation
  // -----------------------------------------------------------------------

  describe('retryOperation', () => {
    it('sends POST and returns retry response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            operation_id: 'op-new',
            original_operation_id: 'op-old',
            status: 'pending',
          },
        }),
      );

      const result = await client.retryOperation('op-old');
      expect(result.operationId).toBe('op-new');
      expect(result.originalOperationId).toBe('op-old');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/operations/op-old/retry');
    });
  });

  // -----------------------------------------------------------------------
  // Single upload
  // -----------------------------------------------------------------------

  describe('uploadFile with Blob', () => {
    it('sends FormData for small files', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            file_id: 'file-1',
            original_name: 'small.txt',
            mime_type: 'text/plain',
            size_bytes: 5,
          },
        }),
      );

      const blob = new Blob(['hello'], { type: 'text/plain' });
      const result = await client.uploadFile(blob);
      expect(result.fileId).toBe('file-1');

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(options.body).toBeInstanceOf(FormData);
    });
  });

  // -----------------------------------------------------------------------
  // Multipart upload
  // -----------------------------------------------------------------------

  describe('uploadFile multipart', () => {
    // Blob size chosen so total_parts === 2: 8MB first chunk (sent in initiate)
    // + one tail chunk (uploaded via the single presigned URL). Keeps the mock
    // deterministic (queue.length === 1 -> exactly one worker). BLOB_SIZE must
    // be strictly > multipartThreshold (default 10MB) to route through
    // multipartUpload().
    const TAIL_CHUNK_SIZE = 2 * 1024 * 1024 + 1; // 2 MB + 1 byte
    const BLOB_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + TAIL_CHUNK_SIZE;

    function mockMultipartFlow(): void {
      // 1) POST /api/uploads/multipart/initiate
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-1',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
            ],
          },
        }),
      );
      // 2) PUT https://s3.example.com/... (single S3 part upload)
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { etag: '"etag-part-2"' },
        }),
      );
      // 3) POST /api/uploads/multipart/complete (contracts@dc0244d: 201 + {upload_id, status})
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: {
              upload_id: 'upload-mp-1',
              status: 'completed',
            },
          },
          201,
        ),
      );
    }

    it('sends exactly 8MB in the initiate request (not the full file body)', async () => {
      mockMultipartFlow();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);

      await client.uploadFile(blob);

      const [initUrl, initOpts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(initUrl).toBe('https://api.example.com/api/uploads/multipart/initiate');

      const initiateForm = initOpts.body as FormData;
      const firstChunk = initiateForm.get('file') as Blob;
      expect(firstChunk).toBeInstanceOf(Blob);
      expect(firstChunk.size).toBe(DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
      // Guard: must not be the full blob (that was the 413 bug).
      expect(firstChunk.size).not.toBe(BLOB_SIZE);
    });

    it('uses contract-compliant FormData field names on initiate', async () => {
      mockMultipartFlow();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);

      await client.uploadFile(blob);

      const initiateForm = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;

      // New names (per api.yaml:1245-1262)
      expect(initiateForm.has('file')).toBe(true);
      expect(initiateForm.has('filename')).toBe(true);
      expect(initiateForm.has('total_size')).toBe(true);
      expect(initiateForm.get('total_size')).toBe(BLOB_SIZE.toString());

      // Old names (the 400-validation bug) must be gone
      expect(initiateForm.has('chunk')).toBe(false);
      expect(initiateForm.has('original_name')).toBe(false);
      expect(initiateForm.has('total_size_bytes')).toBe(false);
    });

    it('floors multipartThreshold at the first-chunk size (sub-8MB config cannot bypass contract)', async () => {
      // A misconfigured consumer sets threshold below 8MB. The client MUST
      // raise it to 8MB so the multipart path never routes a file that would
      // produce a sub-8MB first chunk.
      const lowThresholdClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartThreshold: 1 * 1024 * 1024, // 1 MB — below the contract floor
      });

      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            file_id: 'file-small',
            original_name: 'upload',
            mime_type: 'application/octet-stream',
            size_bytes: 5 * 1024 * 1024,
          },
        }),
      );

      // 5MB file: above the user-set 1MB threshold, but below the enforced
      // 8MB floor — must route to singleUpload, not multipartUpload.
      const blob = new Blob([new Uint8Array(5 * 1024 * 1024)]);
      await lowThresholdClient.uploadFile(blob);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/uploads');
      expect(url).not.toContain('multipart');
    });

    it('calls complete with upload_id from initiate and the S3 part etag (parts[0].part_number === 2)', async () => {
      mockMultipartFlow();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);

      const result = await client.uploadFile(blob);
      // fileId is synthesised from the server's upload_id — per contracts they
      // are the same UUID, just different labels across /multipart/complete
      // and /workflows (see MultipartCompleteResponse docs).
      expect(result.fileId).toBe('upload-mp-1');

      // fetchSpy.mock.calls: [0]=initiate, [1]=S3 PUT, [2]=complete
      const [completeUrl, completeOpts] = fetchSpy.mock.calls[2] as [string, RequestInit];
      expect(completeUrl).toBe('https://api.example.com/api/uploads/multipart/complete');

      const completeBody = JSON.parse(completeOpts.body as string);
      expect(completeBody.upload_id).toBe('upload-mp-1');
      expect(completeBody.file_id).toBeUndefined();
      expect(completeBody.parts).toHaveLength(1);
      expect(completeBody.parts[0].part_number).toBe(2);
      expect(completeBody.parts[0].etag).toBe('"etag-part-2"');
    });

    it('synthesises UploadResponse from already-captured state (no metadata round trip)', async () => {
      mockMultipartFlow();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);

      const result = await client.uploadFile(blob);

      // fileId == the server's upload_id (contract identity)
      expect(result.fileId).toBe('upload-mp-1');
      // originalName comes from uploadFile()'s fileName resolution. A Blob
      // has no .name, so the fallback 'upload' applies (see client.ts:227).
      expect(result.originalName).toBe('upload');
      // mimeType comes from the initiate response's detection.
      expect(result.mimeType).toBe('application/octet-stream');
      // sizeBytes comes from the caller's blob size.
      expect(result.sizeBytes).toBe(BLOB_SIZE);
      // Only three HTTP calls: initiate, S3 PUT, complete. No metadata fetch.
      expect(fetchSpy.mock.calls).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // getWorkflowDownloads
  // -----------------------------------------------------------------------

  describe('getWorkflowDownloads', () => {
    it('issues GET against the plural /downloads path', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { downloads: [] },
        }),
      );

      await client.getWorkflowDownloads('wf-1');

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/workflows/wf-1/downloads');
      expect(options.method).toBe('GET');
    });

    it('percent-encodes the workflow id', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { downloads: [] },
        }),
      );

      await client.getWorkflowDownloads('wf/with spaces');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.example.com/api/workflows/wf%2Fwith%20spaces/downloads',
      );
    });
  });

  // -----------------------------------------------------------------------
  // AbortSignal on uploadFile
  // -----------------------------------------------------------------------

  describe('uploadFile cancellation', () => {
    // Reuse the multipart block's flow helper shape.
    const TAIL_CHUNK_SIZE = 2 * 1024 * 1024 + 1;
    const BLOB_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + TAIL_CHUNK_SIZE;

    it('fails fast with GislAbortError when signal is already aborted on entry', async () => {
      const controller = new AbortController();
      controller.abort();
      const blob = new Blob([new Uint8Array(1024)]);

      await expect(
        client.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);
      // No HTTP traffic: the guard fires before any fetch / file-read.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('propagates a mid-flight abort during single-part as GislAbortError', async () => {
      const controller = new AbortController();
      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        // The client wraps its own controller around opts.signal — fetch
        // receives the composed signal. Simulate the runtime behaviour: wait
        // for abort, then throw an AbortError the way fetch does.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          // Deterministic sync: abort on the next microtask so the listener
          // is registered and fetch is genuinely in-flight. No wall-clock
          // delay — robust against slow CI runners.
          queueMicrotask(() => controller.abort());
        });
      });

      const blob = new Blob([new Uint8Array(1024)]);
      await expect(
        client.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);
    });

    it('classifies abort-after-timeout as GislTimeoutError (temporal order: timer-first wins)', async () => {
      // The timer fires, aborts the composed controller, and the user signal
      // flips `aborted=true` microseconds later (still inside the same catch
      // window). The OLD "check opts.signal.aborted at catch time" logic
      // would misclassify this as a user cancellation. The temporal-order
      // tiebreak must stick with the first cause.
      const fastClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        timeout: 10,
      });
      const controller = new AbortController();

      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              // Compose fired -> user aborts in response (post-timer). First
              // cause was the internal timer, so classification must be
              // GislTimeoutError.
              controller.abort();
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      });

      const blob = new Blob([new Uint8Array(1024)]);
      await expect(
        fastClient.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislTimeoutError);
    });

    it('still classifies pure timeouts (no user signal) as GislTimeoutError', async () => {
      const fastClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        timeout: 5,
      });

      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      });

      const blob = new Blob([new Uint8Array(1024)]);
      await expect(fastClient.uploadFile(blob)).rejects.toBeInstanceOf(
        GislTimeoutError,
      );
    });

    it('propagates abort during an S3 part PUT as GislAbortError', async () => {
      const controller = new AbortController();

      // 1) initiate — succeeds synchronously
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-cancel',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
            ],
          },
        }),
      );

      // 2) S3 PUT — hangs until abort fires, then rejects like fetch does.
      //    Abort is triggered deterministically from inside the mock on the
      //    next microtask (after the listener registers).
      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        });
      });

      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);
      await expect(
        client.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);
      // Complete was never called — abort drained the queue before the
      // finish leg ran.
      const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/multipart/complete'))).toBe(false);
    });

    it('propagates abort during /multipart/complete as GislAbortError', async () => {
      const controller = new AbortController();

      // 1) initiate succeeds
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-complete-abort',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
            ],
          },
        }),
      );
      // 2) S3 PUT succeeds
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { etag: '"etag-part-2"' },
        }),
      );
      // 3) /multipart/complete hangs on the signal, then rejects on abort.
      //    Deterministic: only this leg's mock schedules the abort, so we
      //    know the previous fetches have already completed when it fires.
      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        });
      });

      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);
      await expect(
        client.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);
      // Exactly 3 fetches: initiate, S3 PUT, complete (aborted). No 4th.
      expect(fetchSpy.mock.calls).toHaveLength(3);
      const completeUrl = fetchSpy.mock.calls[2][0] as string;
      expect(completeUrl).toContain('/multipart/complete');
    });

    it('surfaces abort fired BEFORE the first S3 PUT dispatches', async () => {
      const controller = new AbortController();

      // 1) initiate resolves — but on resolve we trip the user signal in a
      //    microtask, BEFORE the multipart worker loop pulls from the queue.
      fetchSpy.mockImplementationOnce(async () => {
        const response = jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-gap',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
            ],
          },
        });
        queueMicrotask(() => controller.abort());
        return response;
      });

      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);
      await expect(
        client.uploadFile(blob, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);

      // Only the initiate fetch ran. No S3 PUT or complete call escaped.
      expect(fetchSpy.mock.calls).toHaveLength(1);
      const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('s3.example.com'))).toBe(false);
      expect(urls.some((u) => u.includes('/multipart/complete'))).toBe(false);
    });

    it('does not leak listeners when the same AbortController is reused across uploads', async () => {
      const controller = new AbortController();

      // 20 successful single-part uploads, same controller passed to each.
      // If bindAbortSignal fails to remove its listener after each request
      // settles, the listener count grows unbounded.
      for (let i = 0; i < 20; i++) {
        fetchSpy.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              file_id: `file-${i}`,
              original_name: 'upload',
              mime_type: 'application/octet-stream',
              size_bytes: 1024,
            },
          }),
        );
      }

      const blob = new Blob([new Uint8Array(1024)]);
      for (let i = 0; i < 20; i++) {
        await client.uploadFile(blob, { signal: controller.signal });
      }

      // @ts-expect-error — Node-only util, typed via @types/node but on the
      // events module. Re-importing adds noise; the cast is local to this test.
      const { getEventListeners } = await import('node:events');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('tiebreak: user aborts BEFORE the timer could fire → GislAbortError with user-intent message', async () => {
      const fastClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        timeout: 500, // timer won't realistically fire during this test
      });
      const controller = new AbortController();

      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          // User aborts deterministically on the next microtask —
          // well before the 500ms internal timer could ever trip.
          queueMicrotask(() => controller.abort());
        });
      });

      const blob = new Blob([new Uint8Array(1024)]);
      try {
        await fastClient.uploadFile(blob, { signal: controller.signal });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislAbortError);
        expect((err as Error).name).toBe('GislAbortError');
        // Classification must surface the user cancellation, not a timeout.
        expect((err as Error).message).not.toMatch(/timed out/i);
        expect((err as Error).message).toMatch(/aborted/i);
      }
    });

    it('backcompat: uploadFile without signal behaves exactly as before', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            file_id: 'file-no-signal',
            original_name: 'upload',
            mime_type: 'application/octet-stream',
            size_bytes: 1024,
          },
        }),
      );

      const blob = new Blob([new Uint8Array(1024)]);
      const result = await client.uploadFile(blob);

      expect(result.fileId).toBe('file-no-signal');
      // The fetch got a signal, but it was the internal per-request timeout
      // signal — not the one we never passed.
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // SSE streaming
  // -----------------------------------------------------------------------

  describe('streamEvents', () => {
    it('returns an async iterable of SSE events', async () => {
      const encoder = new TextEncoder();
      const sseBody = 'event: operation.progress\ndata: {"progress":50}\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const eventStream = await client.streamEvents('wf-1');
      const events = [];
      for await (const event of eventStream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('operation.progress');
    });
  });
});
