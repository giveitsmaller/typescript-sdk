import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GislClient,
  DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
  MULTIPART_CONCURRENCY_DEFAULT,
} from '../../src/client.js';
import { externalImportSource, uploadSource } from '../../src/types.js';
import type { GislSseEvent } from '../../src/types.js';
import {
  GislAbortError,
  GislApiError,
  GislAuthError,
  GislBalanceExhaustedError,
  GislFeatureNotAvailableError,
  GislFeatureTierRestrictedError,
  GislTierRestrictedError,
  GislTimeoutError,
  GislValidationError,
  GislWorkflowExpiredError,
} from '../../src/errors.js';

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
      // Envelope must satisfy WorkflowCreateResponseFromJSON's required v2
      // fields (workflow_id, status, created_at, jobs, delivery_plan,
      // processing_plan, warnings) — server emits empty arrays rather than
      // omitting these per the V2 cutover invariant. Pre-T4 mock omitted
      // `created_at` / `delivery_plan` / `processing_plan` / `warnings` and
      // tripped `(json['warnings']).map is not a function` inside FromJSON.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'pending',
            created_at: '2026-04-27T10:00:00Z',
            jobs: [],
            delivery_plan: {
              mode: 'individual',
              selection_type: 'terminal',
              outputs: [],
              hidden_outputs: [],
            },
            processing_plan: { jobs: [] },
            warnings: [],
          },
        }),
      );

      const result = await client.createWorkflow({
        jobs: [
          {
            id: 'job_compressed',
            source: uploadSource('file-abc'),
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
      expect(sentBody.jobs[0].source.type).toBe('upload');
      expect(sentBody.jobs[0].source.file_id).toBe('file-abc');
      // V1 `ref` field must NOT appear on v2 jobs (regression guard).
      expect('ref' in sentBody.jobs[0]).toBe(false);
    });

    it('forwards top-level v2 envelope fields (delivery / processing / export) on the wire', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              workflow_id: 'wf-1',
              jobs: [],
              created_at: '2026-04-27T00:00:00Z',
              warnings: [],
              delivery_plan: {
                mode: 'individual',
                selection_type: 'all_outputs',
                outputs: [],
                hidden_outputs: [],
                reasons: [],
              },
              processing_plan: { jobs: [] },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await client.createWorkflow({
        jobs: [
          {
            id: 'compressed',
            source: uploadSource('file-abc'),
            operations: [{ type: 'compress', options: { quality: 80 } }],
          },
        ],
        delivery: { mode: 'bundle', bundle_format: 'zip' },
        processing: { class_hint: 'long_form_preferred' },
        export: {
          type: 'connection',
          connection_id: 'conn_1',
          path: '/exports/run-1',
        },
      });

      const [, options] = fetchSpy.mock.calls[0] as [URL | string, RequestInit];
      const sentBody = JSON.parse(options.body as string);
      expect(sentBody.delivery).toEqual({ mode: 'bundle', bundle_format: 'zip' });
      expect(sentBody.processing).toEqual({ class_hint: 'long_form_preferred' });
      expect(sentBody.export).toEqual({
        type: 'connection',
        connection_id: 'conn_1',
        path: '/exports/run-1',
      });
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

    it.each(['cancelled', 'expired'] as const)(
      'returns immediately on terminal lifecycle status %s',
      async (status) => {
        fetchSpy.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: { workflow_id: 'wf-1', status, jobs: [] },
          }),
        );

        const result = await client.waitForWorkflow('wf-1', {
          intervalMs: 10,
          timeoutMs: 5000,
        });

        expect(result.status).toBe(status);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('returns immediately on paused_insufficient_credits with pausedDetail accessible', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'paused_insufficient_credits',
            jobs: [],
            paused_detail: {
              paused_at: '2026-04-26T13:55:00Z',
              expires_at: '2026-05-03T13:55:00Z',
              required_action: 'add_credits',
              message_key: 'workflow.paused.insufficient_credits',
              locale: 'en-GB',
              links: {
                top_up: 'https://example.com/billing/top-up',
                resume: '/api/workflows/wf-1/resume',
                check_balance: '/api/v2/credits/balance',
              },
            },
          },
        }),
      );

      const result = await client.waitForWorkflow('wf-1', {
        intervalMs: 10,
        timeoutMs: 5000,
      });

      expect(result.status).toBe('paused_insufficient_credits');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.pausedDetail).toBeDefined();
      expect(result.pausedDetail?.requiredAction).toBe('add_credits');
      expect(result.pausedDetail?.pausedAt).toBeInstanceOf(Date);
      expect(result.pausedDetail?.expiresAt).toBeInstanceOf(Date);
      expect(result.pausedDetail?.links.topUp).toBe('https://example.com/billing/top-up');
    });
  });

  // -----------------------------------------------------------------------
  // Workflow lifecycle (cancel / resume)
  // -----------------------------------------------------------------------

  describe('cancelWorkflow', () => {
    it('POSTs /api/workflows/{id}/cancel and decodes the response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'cancelled',
            cancelled_at: '2026-04-26T14:00:00Z',
            billing_effect: 'unspent_reservation_released',
          },
        }),
      );

      const result = await client.cancelWorkflow('wf-1');
      expect(result.workflowId).toBe('wf-1');
      expect(result.status).toBe('cancelled');
      expect(result.billingEffect).toBe('unspent_reservation_released');
      expect(result.cancelledAt).toBeInstanceOf(Date);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/workflows/wf-1/cancel');
      expect(init.method).toBe('POST');
    });

    it('idempotent re-cancel returns billing_effect: none', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'cancelled',
            cancelled_at: '2026-04-26T13:55:00Z',
            billing_effect: 'none',
          },
        }),
      );

      const result = await client.cancelWorkflow('wf-1');
      expect(result.billingEffect).toBe('none');
    });
  });

  describe('resumeWorkflow', () => {
    it('POSTs /api/workflows/{id}/resume and returns the in_progress envelope', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workflow_id: 'wf-1',
            status: 'in_progress',
            resumed_at: '2026-04-26T14:00:00Z',
          },
        }),
      );

      const result = await client.resumeWorkflow('wf-1');
      expect(result.workflowId).toBe('wf-1');
      expect(result.status).toBe('in_progress');
      expect(result.resumedAt).toBeInstanceOf(Date);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/workflows/wf-1/resume');
      expect(init.method).toBe('POST');
    });

    it('throws GislBalanceExhaustedError on 402 (top-up still insufficient)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'BALANCE_EXHAUSTED',
            error_type: 'balance_exhausted',
            required_action: 'add_credits',
            links: {
              top_up: 'https://example.com/billing/top-up',
              upgrade: 'https://example.com/billing/plans',
              check_balance: '/api/v2/credits/balance',
            },
          },
          402,
        ),
      );

      try {
        await client.resumeWorkflow('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislBalanceExhaustedError);
      }
    });

    it('throws GislWorkflowExpiredError on 422 workflow_expired', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Workflow expired and cannot be resumed.',
            error_type: 'workflow_expired',
            expired_at: '2026-04-26T14:00:00Z',
          },
          422,
        ),
      );

      try {
        await client.resumeWorkflow('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislWorkflowExpiredError);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Schema endpoint (raw response, no envelope)
  // -----------------------------------------------------------------------

  describe('getSchema', () => {
    function schemaJson(): Record<string, unknown> {
      return {
        schema_version: '2.0.0',
        operations: {
          compress: {
            description: 'Compress files',
            input_model: 'single',
            mime_groups: {},
            options: {},
          },
        },
      };
    }

    function schemaResponse(
      status: number,
      headers: Record<string, string>,
      body: unknown = null,
    ): Response {
      const merged: HeadersInit = {
        'Content-Type': 'application/json',
        ...headers,
      };
      return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: merged,
      });
    }

    it('returns parsed schema with ETag/Last-Modified surfaced (200 path)', async () => {
      fetchSpy.mockResolvedValueOnce(
        schemaResponse(
          200,
          { ETag: '"v2-pro-47"', 'Last-Modified': 'Sun, 26 Apr 2026 09:00:00 GMT' },
          schemaJson(),
        ),
      );

      const result = await client.getSchema();
      if (result.notModified) throw new Error('expected notModified=false');
      expect(result.data.schemaVersion).toBe('2.0.0');
      expect(result.data.operations).toHaveProperty('compress');
      expect(result.etag).toBe('"v2-pro-47"');
      expect(result.lastModified).toBe('Sun, 26 Apr 2026 09:00:00 GMT');
    });

    it('forwards mimeType + operation filters as querystring', async () => {
      fetchSpy.mockResolvedValueOnce(schemaResponse(200, { ETag: '"v2-pro-47"' }, schemaJson()));

      await client.getSchema({ mimeType: 'image/jpeg', operation: 'compress' as never });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/operations/schema?');
      expect(url).toContain('mime_type=image%2Fjpeg');
      expect(url).toContain('operation=compress');
    });

    it('omits the querystring when no filters are passed', async () => {
      fetchSpy.mockResolvedValueOnce(schemaResponse(200, {}, schemaJson()));

      await client.getSchema();

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/operations/schema');
    });

    it('forwards ifNoneMatch + ifModifiedSince as request headers', async () => {
      fetchSpy.mockResolvedValueOnce(schemaResponse(200, {}, schemaJson()));

      await client.getSchema({
        ifNoneMatch: '"v2-pro-47"',
        ifModifiedSince: 'Sun, 26 Apr 2026 09:00:00 GMT',
      });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['If-None-Match']).toBe('"v2-pro-47"');
      expect(headers['If-Modified-Since']).toBe('Sun, 26 Apr 2026 09:00:00 GMT');
    });

    it('returns the notModified sentinel on 304 with no body', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            ETag: '"v2-pro-47"',
            'Last-Modified': 'Sun, 26 Apr 2026 09:00:00 GMT',
          },
        }),
      );

      const result = await client.getSchema({ ifNoneMatch: '"v2-pro-47"' });
      expect(result.notModified).toBe(true);
      if (!result.notModified) throw new Error('unreachable');
      expect(result.etag).toBe('"v2-pro-47"');
      expect(result.lastModified).toBe('Sun, 26 Apr 2026 09:00:00 GMT');
    });

    it('throws GislApiError on 5xx without unwrapping the 304 sentinel path', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Schema unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(client.getSchema()).rejects.toThrow(GislApiError);
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
  // Contact
  // -----------------------------------------------------------------------

  describe('submitContact', () => {
    it('POSTs the JSON payload to /api/contact and resolves to undefined on 204', async () => {
      // 204 No Content — empty body, no content-type header. The request
      // helper must short-circuit before the JSON parser would otherwise
      // throw on an empty body.
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await client.submitContact({
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        subject: 'general_enquiry',
        message: 'Hello, world.',
      });

      expect(result).toBeUndefined();

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/contact');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        subject: 'general_enquiry',
        message: 'Hello, world.',
      });
    });

    it('throws GislValidationError on validation envelope (e.g. honeypot tripped)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Validation failed',
            details: [
              { field: 'website', message: 'must be empty' },
            ],
          },
          422,
        ),
      );

      try {
        await client.submitContact({
          email: 'spam@example.test',
          subject: 'general_enquiry',
          message: 'spam',
          website: 'http://spam.example',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislValidationError);
        const valErr = err as GislValidationError;
        expect(valErr.statusCode).toBe(422);
        expect(valErr.path).toBe('/api/contact');
      }
    });
  });

  // -----------------------------------------------------------------------
  // External imports
  // -----------------------------------------------------------------------

  describe('createExternalImport', () => {
    it('POSTs the JSON payload to /api/external-imports and decodes the handle', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            external_source_id: '019539ab-2222-7000-8000-000000000001',
            expires_at: '2026-04-26T15:00:00Z',
            provider: 's3_presigned',
          },
        }),
      );

      const handle = await client.createExternalImport({
        url: 'https://bucket.s3.example.com/file?X-Amz-Signature=...',
        providerHint: 's3_presigned',
      });

      expect(handle.externalSourceId).toBe('019539ab-2222-7000-8000-000000000001');
      expect(handle.expiresAt).toBeInstanceOf(Date);
      expect(handle.provider).toBe('s3_presigned');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/external-imports');
      expect(init.method).toBe('POST');
      // Wire body is snake_case (camelCase request type is converted via
      // ExternalImportRequestToJSON before sending).
      expect(JSON.parse(init.body as string)).toEqual({
        url: 'https://bucket.s3.example.com/file?X-Amz-Signature=...',
        provider_hint: 's3_presigned',
      });
    });

    it('throws GislFeatureNotAvailableError on 422 planned response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'External-imports endpoint is not yet available',
            error_type: 'feature_not_available',
            violations: [
              { feature: 'external_imports', availability: 'planned' },
            ],
          },
          422,
        ),
      );

      try {
        await client.createExternalImport({ url: 'https://example.com/asset.mp4' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureNotAvailableError);
      }
    });

    it('returns a handle composable into externalImportSource() factory', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            external_source_id: 'eit_handle_123',
            expires_at: '2026-04-26T15:00:00Z',
            provider: 'public_https',
          },
        }),
      );

      const handle = await client.createExternalImport({
        url: 'https://cdn.example.com/clip.mp4',
      });

      // The handle's externalSourceId round-trips into the WorkflowSource
      // factory used by createWorkflow — pinning the integration shape so
      // a regen that renames externalSourceId fails this test.
      const source = externalImportSource(handle.externalSourceId);
      expect(source).toEqual({
        type: 'external_import',
        external_source_id: 'eit_handle_123',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe('login', () => {
    it('POSTs credentials to /api/auth/login and returns the user envelope', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            user: {
              id: '019539ab-1111-7000-8000-000000000001',
              email: 'jane@example.com',
              name: 'Jane Doe',
              tier: 'free',
            },
          },
        }),
      );

      const result = await client.login({
        email: 'jane@example.com',
        password: 'hunter2',
      });

      expect(result.user.email).toBe('jane@example.com');
      expect(result.user.tier).toBe('free');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/auth/login');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        email: 'jane@example.com',
        password: 'hunter2',
      });
    });

    it('surfaces 401 invalid_credentials as GislAuthError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Invalid credentials.',
            error_type: 'invalid_credentials',
          },
          401,
        ),
      );

      try {
        await client.login({ email: 'jane@example.com', password: 'wrong' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislAuthError);
      }
    });

    it('surfaces 403 account_locked as GislAuthError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Account is temporarily locked.',
            error_type: 'account_locked',
          },
          403,
        ),
      );

      try {
        await client.login({ email: 'locked@example.com', password: 'x' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislAuthError);
      }
    });
  });

  describe('logout', () => {
    it('POSTs /api/auth/logout and resolves on 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: true, data: {} }),
      );

      const result = await client.logout();
      expect(result).toBeUndefined();

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/auth/logout');
      expect(init.method).toBe('POST');
    });

    it('treats 401 (no active session) as success — does not throw', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'No active session' },
          401,
        ),
      );

      // Must not throw — idempotent per contract.
      await expect(client.logout()).resolves.toBeUndefined();
    });

    it('still throws on 500', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'Internal' }, 500),
      );

      await expect(client.logout()).rejects.toBeInstanceOf(GislApiError);
    });
  });

  describe('useSessionCookie config', () => {
    it('sends fetch with credentials: include when enabled', async () => {
      const cookieClient = new GislClient({
        baseUrl: 'https://api.example.com',
        useSessionCookie: true,
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { user: { id: '01', email: 'x@example.com' } },
        }),
      );

      await cookieClient.login({ email: 'x@example.com', password: 'p' });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBe('include');
    });

    it('omits credentials field when disabled (default API-key mode)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { user: { id: '01', email: 'x@example.com' } },
        }),
      );

      await client.login({ email: 'x@example.com', password: 'p' });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Audio watermark decode
  // -----------------------------------------------------------------------

  describe('decodeAudioWatermark', () => {
    it('POSTs the JSON payload to /api/audio-watermark/decode and decodes the response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            watermark_id: '019539ab-2222-7000-8000-bbbbbbbbbbbb',
            payload: 'license-key-abc-123',
            confidence: 0.94,
            method: 'psychoacoustic',
            detected_at: '2026-04-26T13:50:00Z',
          },
        }),
      );

      const result = await client.decodeAudioWatermark({
        fileId: '019539ab-1111-7000-8000-000000000aa1',
        methodHint: 'auto',
      });

      expect(result.watermarkId).toBe('019539ab-2222-7000-8000-bbbbbbbbbbbb');
      expect(result.payload).toBe('license-key-abc-123');
      expect(result.confidence).toBeCloseTo(0.94);
      expect(result.method).toBe('psychoacoustic');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/audio-watermark/decode');
      expect(init.method).toBe('POST');
      // Wire body is snake_case (camelCase request type is converted via
      // AudioWatermarkDecodeRequestToJSON before sending).
      expect(JSON.parse(init.body as string)).toEqual({
        file_id: '019539ab-1111-7000-8000-000000000aa1',
        method_hint: 'auto',
      });
    });

    it('throws GislFeatureTierRestrictedError on 403 (free / pro caller)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Audio-watermark decode requires the enterprise tier',
            error_type: 'feature_tier_restricted',
            violations: [
              {
                feature: 'audio_watermark.decode',
                required_tier: 'enterprise',
                current_tier: 'pro',
              },
            ],
          },
          403,
        ),
      );

      try {
        await client.decodeAudioWatermark({
          fileId: '019539ab-1111-7000-8000-000000000aa1',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureTierRestrictedError);
      }
    });

    it('throws GislFeatureNotAvailableError on 422 planned response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Audio-watermark decode is not yet available',
            error_type: 'feature_not_available',
            violations: [
              { feature: 'audio_watermark.decode', availability: 'planned' },
            ],
          },
          422,
        ),
      );

      try {
        await client.decodeAudioWatermark({
          fileId: '019539ab-1111-7000-8000-000000000aa1',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureNotAvailableError);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Upload probe
  // -----------------------------------------------------------------------

  describe('probeUpload', () => {
    it('POSTs /api/uploads/{id}/probe and decodes the snake_case response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            file_id: '019539ab-1111-7000-8000-000000000001',
            probe_status: 'ok',
            media_metadata: {
              duration_seconds: 187,
              width: 1920,
              height: 1080,
              codec: 'h264',
              container: 'mp4',
              audio_layout: 'stereo',
              probed_at: '2026-04-26T13:50:00Z',
            },
            processing_class_pre_assignment: 'short_form',
          },
        }),
      );

      const result = await client.probeUpload('019539ab-1111-7000-8000-000000000001');
      expect(result.fileId).toBe('019539ab-1111-7000-8000-000000000001');
      expect(result.probeStatus).toBe('ok');
      expect(result.processingClassPreAssignment).toBe('short_form');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/uploads/019539ab-1111-7000-8000-000000000001/probe');
      expect(init.method).toBe('POST');
    });

    it('throws GislFeatureNotAvailableError on 422 planned response', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Probe endpoint is not yet available',
            error_type: 'feature_not_available',
            violations: [
              { feature: 'upload.probe', availability: 'planned' },
            ],
          },
          422,
        ),
      );

      try {
        await client.probeUpload('019539ab-1111-7000-8000-000000000001');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureNotAvailableError);
      }
    });
  });

  describe('preflightClips', () => {
    it('partitions ok / rejected / errors across N parallel probes', async () => {
      // Three probes: one ok, one corrupt, one 422 planned.
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              file_id: 'aaa',
              probe_status: 'ok',
              media_metadata: { duration_seconds: 30, probed_at: '2026-04-26T13:50:00Z' },
              processing_class_pre_assignment: 'short_form',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              file_id: 'bbb',
              probe_status: 'corrupt',
              media_metadata: { probed_at: '2026-04-26T13:50:00Z' },
              processing_class_pre_assignment: 'blocked',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              success: false,
              error: 'planned',
              error_type: 'feature_not_available',
              violations: [{ feature: 'upload.probe', availability: 'planned' }],
            },
            422,
          ),
        );

      const result = await client.preflightClips(['aaa', 'bbb', 'ccc']);
      expect(result.ok).toHaveLength(1);
      expect(result.ok[0].fileId).toBe('aaa');
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].probeStatus).toBe('corrupt');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].fileId).toBe('ccc');
      expect(result.errors[0].error).toBeInstanceOf(GislFeatureNotAvailableError);
    });

    it('returns empty partitions for an empty input', async () => {
      const result = await client.preflightClips([]);
      expect(result).toEqual({ ok: [], rejected: [], errors: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Credits
  // -----------------------------------------------------------------------

  describe('getCreditsBalance', () => {
    it('GETs /api/v2/credits/balance and decodes snake_case fields', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            monthly_balance: 1200,
            purchased_balance: 5000,
            overdraft_limit: 500,
            overdraft_debt: 0,
            available_credits: 6700,
            monthly_allowance: 2000,
            tier: 'pro',
          },
        }),
      );

      const balance = await client.getCreditsBalance();
      expect(balance.monthlyBalance).toBe(1200);
      expect(balance.purchasedBalance).toBe(5000);
      expect(balance.overdraftLimit).toBe(500);
      expect(balance.overdraftDebt).toBe(0);
      expect(balance.availableCredits).toBe(6700);
      expect(balance.monthlyAllowance).toBe(2000);
      expect(balance.tier).toBe('pro');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/v2/credits/balance');
      expect(init.method).toBe('GET');
    });
  });

  describe('getCreditsUsage', () => {
    it('GETs /api/v2/credits/usage with no query when options omitted', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { transactions: [], total: 0, limit: 20, offset: 0 },
        }),
      );

      const page = await client.getCreditsUsage();
      expect(page.transactions).toEqual([]);
      expect(page.total).toBe(0);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/v2/credits/usage');
    });

    it('forwards limit + offset as querystring params', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            transactions: [
              {
                id: '019539ad-3333-7000-8000-aaaaaaaaaa01',
                type: 'reservation',
                amount: -45,
                monthly_balance_before: 1000,
                monthly_balance_after: 955,
                purchased_balance_before: 4975,
                purchased_balance_after: 4975,
                source_bucket: 'monthly',
                monthly_amount: -45,
                purchased_amount: 0,
                pricing_version: 'v3.2.0',
                description: 'Workflow reservation',
                reference_type: 'workflow',
                reference_id: '019539ac-2222-7000-8000-000000000001',
                created_at: '2026-04-26T13:55:00Z',
              },
            ],
            total: 7,
            limit: 5,
            offset: 5,
          },
        }),
      );

      const page = await client.getCreditsUsage({ limit: 5, offset: 5 });
      expect(page.limit).toBe(5);
      expect(page.offset).toBe(5);
      expect(page.transactions).toHaveLength(1);
      expect(page.transactions[0].monthlyBalanceAfter).toBe(955);
      expect(page.transactions[0].sourceBucket).toBe('monthly');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/v2/credits/usage?');
      expect(url).toContain('limit=5');
      expect(url).toContain('offset=5');
    });

    it('omits absent params (does not coerce to defaults client-side)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { transactions: [], total: 0, limit: 20, offset: 12 },
        }),
      );

      await client.getCreditsUsage({ offset: 12 });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/v2/credits/usage?offset=12');
      expect(url).not.toContain('limit=');
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
  // Multipart S3 PUT retry
  // -----------------------------------------------------------------------

  describe('multipart upload retry', () => {
    const TAIL_CHUNK_SIZE = 2 * 1024 * 1024 + 1; // matches mockMultipartFlow shape
    const BLOB_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + TAIL_CHUNK_SIZE;

    function makeRetryClient(overrides?: {
      multipartMaxAttempts?: number;
      multipartRetryBaseMs?: number;
    }): GislClient {
      return new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        // Tiny base keeps tests fast; full-jitter ceiling stays in single-digit ms.
        multipartRetryBaseMs: 1,
        multipartMaxAttempts: 3,
        ...overrides,
      });
    }

    function mockInitiate(): void {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-retry',
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
    }

    function mockS3Status(status: number, etag = '"etag-part-2"'): void {
      const headers: Record<string, string> = {};
      if (status >= 200 && status < 300) headers.etag = etag;
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status, headers }),
      );
    }

    function mockComplete(): void {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: { upload_id: 'upload-mp-retry', status: 'completed' },
          },
          201,
        ),
      );
    }

    it('retries a transient 500 and succeeds on the second attempt', async () => {
      mockInitiate();
      mockS3Status(500);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);
      const result = await client.uploadFile(blob);

      expect(result.fileId).toBe('upload-mp-retry');
      // initiate + 2x PUT + complete
      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('retries on 429 (Too Many Requests)', async () => {
      mockInitiate();
      mockS3Status(429);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('retries on 503 (Slow Down)', async () => {
      mockInitiate();
      mockS3Status(503);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('retries on 502 (Bad Gateway)', async () => {
      mockInitiate();
      mockS3Status(502);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('retries on 504 (Gateway Timeout)', async () => {
      mockInitiate();
      mockS3Status(504);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('fails fast on 403 (signed-URL expiry) without retrying', async () => {
      mockInitiate();
      mockS3Status(403);

      const client = makeRetryClient();
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/S3 chunk upload failed for part 2: 403/);
      // initiate + 1x PUT only
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('fails fast on 401 without retrying', async () => {
      mockInitiate();
      mockS3Status(401);

      const client = makeRetryClient();
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/S3 chunk upload failed for part 2: 401/);
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('fails fast when a 200 response is missing its ETag header (no retry)', async () => {
      mockInitiate();
      // 200 with empty headers — etag absent
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }));

      const client = makeRetryClient();
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/missing ETag for part 2/);
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('retries on a network TypeError (DNS/TLS/TCP failure)', async () => {
      mockInitiate();
      fetchSpy.mockRejectedValueOnce(new TypeError('network failure'));
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('throws after max attempts with the attempt count in the message', async () => {
      mockInitiate();
      mockS3Status(500);
      mockS3Status(500);
      mockS3Status(500);

      const client = makeRetryClient({ multipartMaxAttempts: 3 });
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/after 3 attempts/);
      // initiate + 3 PUTs
      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('happy path with retry enabled still issues exactly 3 fetches (initiate, PUT, complete)', async () => {
      mockInitiate();
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient({ multipartMaxAttempts: 5 });
      const result = await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(result.fileId).toBe('upload-mp-retry');
      expect(fetchSpy.mock.calls).toHaveLength(3);
    });

    it('respects multipartMaxAttempts=1 (effectively disables retry)', async () => {
      mockInitiate();
      mockS3Status(500);

      const client = makeRetryClient({ multipartMaxAttempts: 1 });
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/after 1 attempts/);
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('floors multipartMaxAttempts=0 to 1 attempt', async () => {
      mockInitiate();
      mockS3Status(500);

      const client = makeRetryClient({ multipartMaxAttempts: 0 });
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/after 1 attempts/);
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('aborts during retry backoff with GislAbortError before the next PUT dispatches', async () => {
      const controller = new AbortController();
      mockInitiate();
      // First PUT: resolve with 500, then trigger the abort. The next
      // microtask after this resolution is the retry loop scheduling its
      // backoff sleep — abort lands during that sleep, before any second
      // PUT dispatches.
      fetchSpy.mockImplementationOnce(async () => {
        queueMicrotask(() => controller.abort());
        return new Response('', { status: 500 });
      });
      // No further mocks: if the retry dispatches another PUT, fetchSpy will
      // return undefined and the test will fail with a different error.

      const client = makeRetryClient({
        multipartMaxAttempts: 3,
        // Long enough that abort wins the race with the sleep timer.
        multipartRetryBaseMs: 200,
      });

      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]), {
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(GislAbortError);

      // Exactly: initiate + first PUT (500). No second PUT, no complete.
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('with concurrency=2, one chunk retrying does not stall its sibling', async () => {
      // Two presigned parts. Part A (#2) returns 500 once then 200. Part B
      // (#3) succeeds on first try. Both must complete; complete-call sees
      // both ETags. Workers run independently.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-conc',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 3,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              { part_number: 2, url: 'https://s3.example.com/upload?part=2', expires_at: '2026-04-18T09:00:00.000Z' },
              { part_number: 3, url: 'https://s3.example.com/upload?part=3', expires_at: '2026-04-18T09:00:00.000Z' },
            ],
          },
        }),
      );

      // Order is deterministic because workers pull from the queue in order
      // and use the same fetchSpy queue. Worker 0 takes part 2 (gets 500
      // first), worker 1 takes part 3 (gets 200). When worker 0 retries,
      // the next mock in the queue is the part-2 success.
      mockS3Status(500); // worker 0, part 2, attempt 1
      mockS3Status(200); // worker 1, part 3, attempt 1
      mockS3Status(200); // worker 0, part 2, attempt 2 (retry)
      // complete
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: { upload_id: 'upload-mp-conc', status: 'completed' },
          },
          201,
        ),
      );

      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartConcurrency: 2,
        multipartRetryBaseMs: 1,
        multipartMaxAttempts: 3,
      });

      // Big enough for 3 total parts (1 first-chunk + 2 tail parts).
      const blob = new Blob([new Uint8Array(DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 2 * TAIL_CHUNK_SIZE)]);
      const result = await client.uploadFile(blob);

      expect(result.fileId).toBe('upload-mp-conc');
      // initiate + 3 S3 PUTs (one retry) + complete
      expect(fetchSpy.mock.calls).toHaveLength(5);
    });

    it('does not double-count progress when a chunk retries', async () => {
      mockInitiate();
      mockS3Status(500);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      const progress: Array<[number, number]> = [];
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]), {
        onProgress: (uploaded, total) => progress.push([uploaded, total]),
      });

      // Two onProgress events expected: one after the first-chunk initiate,
      // one after the (eventually-successful) tail chunk PUT. The failed
      // attempt must NOT have fired onProgress.
      expect(progress).toHaveLength(2);
      expect(progress[0]).toEqual([DEFAULT_MULTIPART_FIRST_CHUNK_SIZE, BLOB_SIZE]);
      expect(progress[1]).toEqual([BLOB_SIZE, BLOB_SIZE]);
    });

    it('does not retry a non-TypeError, non-Abort exception (e.g. plain Error)', async () => {
      // Custom polyfills or unusual runtimes may surface fetch failures as a
      // plain `Error` (or RangeError, SyntaxError, etc.). These are NOT
      // retryable — only TypeError network failures qualify.
      mockInitiate();
      fetchSpy.mockRejectedValueOnce(new Error('boom'));

      const client = makeRetryClient();
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/boom/);
      // initiate + 1 PUT only (no retry)
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('mixes retry types: TypeError → 503 → 200 succeeds in 3 attempts', async () => {
      // The most realistic flake: a TCP reset is followed by transient
      // throttling, then success. The retry loop must accept either error
      // category in lastErr without confusion.
      mockInitiate();
      fetchSpy.mockRejectedValueOnce(new TypeError('connection reset'));
      mockS3Status(503);
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient({ multipartMaxAttempts: 3 });
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      // initiate + 3 PUTs + complete
      expect(fetchSpy.mock.calls).toHaveLength(5);
    });

    it('preserves the TypeError message in the after-N-attempts terminal error', async () => {
      mockInitiate();
      fetchSpy.mockRejectedValueOnce(new TypeError('TLS handshake failed'));
      fetchSpy.mockRejectedValueOnce(new TypeError('TLS handshake failed'));
      fetchSpy.mockRejectedValueOnce(new TypeError('TLS handshake failed'));

      const client = makeRetryClient({ multipartMaxAttempts: 3 });
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/TLS handshake failed/);
    });

    it('coerces a non-finite multipartMaxAttempts (NaN) back to the default 3', async () => {
      mockInitiate();
      mockS3Status(500);
      mockS3Status(500);
      mockS3Status(200);
      mockComplete();

      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartRetryBaseMs: 1,
        multipartMaxAttempts: NaN,
      });
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      // Default of 3 attempts kicks in; succeeds on attempt 3.
      // initiate + 3 PUTs + complete = 5
      expect(fetchSpy.mock.calls).toHaveLength(5);
    });

    it('coerces Infinity multipartMaxAttempts back to the default (no infinite loop)', async () => {
      mockInitiate();
      mockS3Status(500);
      mockS3Status(500);
      mockS3Status(500);

      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartRetryBaseMs: 1,
        multipartMaxAttempts: Infinity,
      });
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/after 3 attempts/);
      // Default 3, not infinity: initiate + 3 PUTs = 4 fetches.
      expect(fetchSpy.mock.calls).toHaveLength(4);
    });

    it('cancels the response body of a retryable non-OK response before retrying', async () => {
      mockInitiate();
      // Build a 500 response with a real ReadableStream body so we can
      // observe whether it gets cancelled. The cancellation tracker fires
      // when the retry loop calls drainResponseBody.
      let cancelled = false;
      const stream = new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      });
      fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 500 }));
      mockS3Status(200);
      mockComplete();

      const client = makeRetryClient();
      await client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)]));

      expect(cancelled).toBe(true);
    });

    it('cancels the response body on a non-retryable 4xx before throwing', async () => {
      mockInitiate();
      let cancelled = false;
      const stream = new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      });
      fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 403 }));

      const client = makeRetryClient();
      await expect(
        client.uploadFile(new Blob([new Uint8Array(BLOB_SIZE)])),
      ).rejects.toThrow(/403/);
      expect(cancelled).toBe(true);
    });

    it('does NOT retry when onProgress throws after a successful PUT', async () => {
      // Regression: a user callback throwing TypeError must not be classified
      // as a retryable network error. Otherwise the SDK would re-PUT an
      // already-accepted part and double-record the ETag.
      mockInitiate();
      mockS3Status(200);
      // No second PUT mock — if the SDK retries, fetchSpy returns undefined
      // and the test fails with a different error than the one we expect.

      const client = makeRetryClient();
      const blob = new Blob([new Uint8Array(BLOB_SIZE)]);

      // onProgress is called after initiate AND after each S3 part. Throw
      // only on the post-PUT call (the second invocation) so the regression
      // path under test (retry-after-success) is the one exercised.
      let progressCallCount = 0;
      await expect(
        client.uploadFile(blob, {
          onProgress: () => {
            progressCallCount += 1;
            if (progressCallCount >= 2) {
              throw new TypeError('user callback bug');
            }
          },
        }),
      ).rejects.toThrow(/user callback bug/);

      // initiate + 1 PUT only — no retry, no complete.
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('wakes a sibling worker out of its backoff sleep when another worker fails', async () => {
      // Two parts. Worker A picks part 2, gets a non-retryable 403 → fails
      // fast. Worker B picks part 3, gets a 500 → enters backoff sleep.
      // Math.random is pinned to 0.999 so the full-jitter delay is
      // deterministically near the upper bound (~5s); without the wake
      // signal the test would block for that full delay and the elapsed-
      // time assertion would fail. With the wake signal, B exits the sleep
      // immediately when A aborts the failure controller.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
      try {
        fetchSpy.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              upload_id: 'upload-mp-wake',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"etag-part-1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 3,
              recommended_chunk_size: TAIL_CHUNK_SIZE,
              presigned_urls: [
                { part_number: 2, url: 'https://s3.example.com/upload?part=2', expires_at: '2026-04-18T09:00:00.000Z' },
                { part_number: 3, url: 'https://s3.example.com/upload?part=3', expires_at: '2026-04-18T09:00:00.000Z' },
              ],
            },
          }),
        );
        // Worker A part 2: non-retryable 403 (fails immediately).
        mockS3Status(403);
        // Worker B part 3: retryable 500 (enters backoff sleep).
        mockS3Status(500);

        const client = new GislClient({
          baseUrl: 'https://api.example.com',
          apiKey: 'test-key',
          multipartConcurrency: 2,
          multipartMaxAttempts: 3,
          // 5000ms base + Math.random=0.999 produces ~4.995s delay on the
          // first retry. The wake signal must short-circuit this.
          multipartRetryBaseMs: 5000,
        });

        const blob = new Blob([new Uint8Array(DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 2 * TAIL_CHUNK_SIZE)]);
        const start = Date.now();
        await expect(client.uploadFile(blob)).rejects.toThrow(/403/);
        const elapsed = Date.now() - start;
        // 1000ms is generous headroom on slow CI; a broken wake signal
        // would force a ~5000ms wait.
        expect(elapsed).toBeLessThan(1000);
      } finally {
        randomSpy.mockRestore();
      }
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
      const events: GislSseEvent[] = [];
      for await (const event of eventStream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('operation.progress');
    });

    it('narrows v2 phased ProgressStatus values via the GislSseEvent discriminator', async () => {
      // T9 acceptance: GislSseEvent discrimination still works after the
      // ProgressStatus widening (probing / decoding / encoding + phase_input_index
      // + phase_total_inputs). Active narrowing test — a regression that drops
      // the phased shape from SseOperationProgressData would surface here.
      fetchSpy.mockResolvedValueOnce(
        new Response(
          'event: operation.progress\n' +
          'data: {"operation_id":"01936fb3-0000-7000-8000-0000000000c1",' +
          '"progress":40,"status":"decoding","phase_input_index":1,"phase_total_inputs":3}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

      const eventStream = await client.streamEvents('wf-1');
      const events: GislSseEvent[] = [];
      for await (const event of eventStream) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const ev = events[0];
      // Discriminator narrowing: TS knows ev.data is SseOperationProgressData
      // when ev.event === 'operation.progress'.
      if (ev.event === 'operation.progress') {
        // GislSseEvent's union includes a `{event: string; data: unknown}`
        // catch-all so discriminator narrowing alone leaves `data: unknown`.
        // The SDK's SSE parser doesn't run wire JSON through `FromJSON`
        // helpers, so consumers see raw snake_case wire fields — distinct
        // from the camelCase `SseOperationProgressData` interface emitted
        // by openapi-generator. Pin the wire shape with a local interface:
        // a regression that drops the phased fields from the wire shape
        // surfaces here as a `Property X does not exist` tsc error, not
        // as a runtime undefined.
        interface ProgressWireShape {
          operation_id: string;
          progress: number;
          status: 'started' | 'downloading' | 'probing' | 'decoding'
            | 'processing' | 'encoding' | 'uploading';
          phase_input_index?: number;
          phase_total_inputs?: number;
        }
        const data = ev.data as ProgressWireShape;
        expect(data.status).toBe('decoding');
        expect(data.phase_input_index).toBe(1);
        expect(data.phase_total_inputs).toBe(3);
      } else {
        throw new Error(`expected operation.progress, got ${ev.event}`);
      }
    });

    // MqhQwiCi: early-termination must promptly cancel the connection.
    // Helper: a never-closing body with an observable cancel() as the
    // deterministic sync point (no wall-clock — that would reintroduce the
    // very 300s hang the ticket describes).
    function neverEndingSseResponse(firstChunk: string): {
      response: Response;
      cancelled: Promise<unknown>;
      wasCancelled: () => boolean;
    } {
      const encoder = new TextEncoder();
      let resolveCancel!: (reason: unknown) => void;
      const cancelled = new Promise<unknown>((res) => {
        resolveCancel = res;
      });
      let flag = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(firstChunk));
        },
        cancel(reason) {
          flag = true;
          resolveCancel(reason);
        },
      });
      return {
        response: new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
        cancelled,
        wasCancelled: () => flag,
      };
    }

    it('gen.return() on a quiet socket promptly cancels the connection (MqhQwiCi)', async () => {
      const { response, cancelled, wasCancelled } = neverEndingSseResponse(
        'event: operation.progress\ndata: {"progress":10}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);

      const gen = await client.streamEvents('wf-1');
      const first = await gen.next();
      expect(first.done).toBe(false);

      await gen.return(undefined); // must NOT hang
      await cancelled; // resolves only if the underlying stream was cancelled
      expect(wasCancelled()).toBe(true);
    }, 2000);

    it('for await … break promptly cancels (the e2e canary pattern)', async () => {
      const { response, cancelled, wasCancelled } = neverEndingSseResponse(
        'event: operation.progress\ndata: {"progress":20}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);

      const gen = await client.streamEvents('wf-1');
      for await (const _ev of gen) {
        break; // triggers wrapper.return() → controller.abort() → reader.cancel()
      }
      await cancelled;
      expect(wasCancelled()).toBe(true);
    }, 2000);

    it('a consumer-supplied AbortSignal cancels a quiet stream', async () => {
      const { response, cancelled, wasCancelled } = neverEndingSseResponse(
        'event: operation.progress\ndata: {"progress":30}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);

      const ac = new AbortController();
      const gen = await client.streamEvents('wf-1', { signal: ac.signal });
      const first = await gen.next();
      expect(first.done).toBe(false);

      ac.abort();
      await cancelled;
      expect(wasCancelled()).toBe(true);
      expect((await gen.next()).done).toBe(true);
    }, 2000);

    it('normal completion consumes all events without spurious failure', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: operation.progress\ndata: {"progress":1}\n\n'),
          );
          controller.enqueue(
            encoder.encode('event: workflow.completed\ndata: {"workflow_id":"w"}\n\n'),
          );
          controller.close();
        },
      });
      fetchSpy.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const gen = await client.streamEvents('wf-1');
      const events: GislSseEvent[] = [];
      for await (const ev of gen) events.push(ev);

      expect(events.map((e) => e.event)).toEqual([
        'operation.progress',
        'workflow.completed',
      ]);
      // Idempotent terminal state after normal completion.
      expect((await gen.next()).done).toBe(true);
    });

    // --- Coverage hardening (test-reviewer: exit-path + listener-leak gaps) ---

    it('cancels the body when disposed before the first next() (!started backstop)', async () => {
      const { response, cancelled, wasCancelled } = neverEndingSseResponse(
        'event: operation.progress\ndata: {"progress":1}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);

      const gen = await client.streamEvents('wf-1');
      // Never pull an event: the inner generator never runs, so only the
      // streamEvents `!started` backstop (response.body.cancel()) can free
      // the still-unlocked body.
      await gen.return(undefined);
      await cancelled;
      expect(wasCancelled()).toBe(true);
    }, 2000);

    it('removes the consumer-signal listener on normal completion (no listener leak)', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('event: x\ndata: {}\n\n'));
          c.close();
        },
      });
      fetchSpy.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      const ac = new AbortController();
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      const gen = await client.streamEvents('wf-1', { signal: ac.signal });
      for await (const _ev of gen) {
        /* consume to completion */
      }
      // bindAbortSignal's teardown (releaseConsumerSignal) must run on the
      // normal-completion path too, or a long-lived consumer AbortController
      // accumulates listeners across many streams.
      expect(removeSpy).toHaveBeenCalled();
    });

    it('removes the consumer-signal listener on early return (no listener leak)', async () => {
      const { response, cancelled } = neverEndingSseResponse(
        'event: x\ndata: {}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);
      const ac = new AbortController();
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      const gen = await client.streamEvents('wf-1', { signal: ac.signal });
      await gen.next();
      await gen.return(undefined);
      await cancelled;
      expect(removeSpy).toHaveBeenCalled();
    }, 2000);

    it('releases the consumer-signal listener when the response is not OK', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'gone', error_type: 'not_found' },
          404,
        ),
      );
      const ac = new AbortController();
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      await expect(
        client.streamEvents('wf-1', { signal: ac.signal }),
      ).rejects.toThrow();
      // The !response.ok try/finally must still tear the listener down.
      expect(removeSpy).toHaveBeenCalled();
    });

    it('fast-fails with GislAbortError on a pre-aborted signal without leaking a listener', async () => {
      const ac = new AbortController();
      ac.abort();
      const addSpy = vi.spyOn(ac.signal, 'addEventListener');

      await expect(
        client.streamEvents('wf-1', { signal: ac.signal }),
      ).rejects.toBeInstanceOf(GislAbortError);
      // bindAbortSignal's pre-aborted branch aborts synchronously and adds
      // NO listener (its teardown is a no-op), so nothing can leak — and
      // request() fast-fails before fetch (fetchSpy untouched).
      expect(addSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('propagates a mid-stream error and releases the consumer-signal listener', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('event: x\ndata: {}\n\n'));
          c.error(new Error('boom'));
        },
      });
      fetchSpy.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      const ac = new AbortController();
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      const gen = await client.streamEvents('wf-1', { signal: ac.signal });
      await expect(
        (async () => {
          for await (const _ev of gen) {
            /* drains until the stream errors */
          }
        })(),
      ).rejects.toThrow();
      // next()'s catch → cleanup(false): no spurious abort, but the
      // consumer-signal listener must still be released.
      expect(removeSpy).toHaveBeenCalled();
    }, 2000);

    it('cancels the body when the consumer aborts and drops the iterator before pulling (codex 476a574c)', async () => {
      const { response, cancelled, wasCancelled } = neverEndingSseResponse(
        'event: x\ndata: {}\n\n',
      );
      fetchSpy.mockResolvedValueOnce(response);
      const ac = new AbortController();

      const gen = await client.streamEvents('wf-1', { signal: ac.signal });
      // Pure abort-and-drop: never call next()/return()/throw(). Only the
      // controller.signal abort backstop can free the already-fetched body
      // (request() unbound its controller at headers; parseSseStream never
      // started, so it has no reader/listener).
      ac.abort();
      await cancelled;
      expect(wasCancelled()).toBe(true);
      void gen;
    }, 2000);
  });

  // -----------------------------------------------------------------------
  // Structured error dispatch (T6 — GDOmZO16)
  //
  // Each test asserts handleResponse() routes the wire envelope to the
  // correct typed subclass based on (status, error_type) and threads the
  // payload through the generated FromJSON helper (snake_case → camelCase).
  // The transport here is getWorkflowStatus — a GET that exercises the
  // shared handleResponse() error path without requiring a body.
  // -----------------------------------------------------------------------

  describe('error dispatch', () => {
    it('401 invalid_api_key → GislAuthError with typed payload', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Invalid API key',
            error_type: 'api_key_invalid',
            message_key: 'error.api_key_invalid',
            locale: 'en-GB',
          },
          401,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislAuthError);
        expect(err).toBeInstanceOf(GislApiError);
        const authErr = err as GislAuthError;
        expect(authErr.statusCode).toBe(401);
        expect(authErr.payload.errorType).toBe('api_key_invalid');
        expect(authErr.messageKey).toBe('error.api_key_invalid');
        expect(authErr.locale).toBe('en-GB');
      }
    });

    it('403 account_locked → GislAuthError (401 OR 403 status path)', async () => {
      // Auth dispatch covers both 401 and 403 — account_locked / account_disabled
      // realistically arrive at 403, not 401. Regression guard against the
      // dispatch dropping the `|| 403` branch.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Account locked',
            error_type: 'account_locked',
          },
          403,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislAuthError);
        const authErr = err as GislAuthError;
        expect(authErr.statusCode).toBe(403);
        expect(authErr.payload.errorType).toBe('account_locked');
      }
    });

    it('402 balance_exhausted → GislBalanceExhaustedError with required_action + links', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Balance exhausted',
            error_type: 'balance_exhausted',
            required_action: 'add_credits',
            links: {
              upgrade: 'https://gisl.example/upgrade',
              top_up: 'https://gisl.example/top-up',
            },
            message_key: 'error.balance_exhausted.add_credits',
            locale: 'en-GB',
            message_params: { feature: 'compress' },
          },
          402,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislBalanceExhaustedError);
        const balanceErr = err as GislBalanceExhaustedError;
        expect(balanceErr.statusCode).toBe(402);
        expect(balanceErr.payload.errorType).toBe('balance_exhausted');
        expect(balanceErr.payload.requiredAction).toBe('add_credits');
        // FromJSON converts snake_case top_up to camelCase topUp.
        expect(balanceErr.payload.links?.upgrade).toBe('https://gisl.example/upgrade');
        expect(balanceErr.payload.links?.topUp).toBe('https://gisl.example/top-up');
        // i18n triple comes straight from wire snake_case keys.
        expect(balanceErr.messageKey).toBe('error.balance_exhausted.add_credits');
        expect(balanceErr.locale).toBe('en-GB');
        expect(balanceErr.messageParams).toEqual({ feature: 'compress' });
      }
    });

    it('403 tier_restriction → GislTierRestrictedError with restriction_kind + tiers', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'File too large for tier',
            error_type: 'tier_restriction',
            restriction_kind: 'file_size',
            current_tier: 'free',
            required_tier: 'pro',
          },
          403,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislTierRestrictedError);
        const tierErr = err as GislTierRestrictedError;
        expect(tierErr.statusCode).toBe(403);
        expect(tierErr.payload.errorType).toBe('tier_restriction');
        expect(tierErr.payload.restrictionKind).toBe('file_size');
        expect(tierErr.payload.currentTier).toBe('free');
        expect(tierErr.payload.requiredTier).toBe('pro');
      }
    });

    it('403 feature_tier_restricted → GislFeatureTierRestrictedError with violations[]', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Feature requires upgrade',
            error_type: 'feature_tier_restricted',
            violations: [
              {
                feature: 'operation.compress.option.codec.av1',
                availability: 'stable',
                required_tier: 'pro',
              },
              {
                feature: 'operation.merge.mime_group.video',
                availability: 'stable',
                required_tier: 'enterprise',
              },
            ],
          },
          403,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureTierRestrictedError);
        const featErr = err as GislFeatureTierRestrictedError;
        expect(featErr.statusCode).toBe(403);
        expect(featErr.payload.errorType).toBe('feature_tier_restricted');
        expect(featErr.payload.violations).toHaveLength(2);
        // FromJSON for FeatureViolation converts required_tier → requiredTier.
        expect(featErr.payload.violations[0].feature).toBe(
          'operation.compress.option.codec.av1',
        );
        expect(featErr.payload.violations[0].requiredTier).toBe('pro');
        expect(featErr.payload.violations[1].requiredTier).toBe('enterprise');
      }
    });

    it('422 feature_not_available → GislFeatureNotAvailableError with violations[]', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Feature not available',
            error_type: 'feature_not_available',
            violations: [
              {
                feature: 'operation.image_watermark',
                availability: 'planned',
                eta: '2026-Q3',
              },
            ],
          },
          422,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislFeatureNotAvailableError);
        const featErr = err as GislFeatureNotAvailableError;
        expect(featErr.statusCode).toBe(422);
        expect(featErr.payload.errorType).toBe('feature_not_available');
        expect(featErr.payload.violations).toHaveLength(1);
        expect(featErr.payload.violations[0].feature).toBe('operation.image_watermark');
        expect(featErr.payload.violations[0].availability).toBe('planned');
        expect(featErr.payload.violations[0].eta).toBe('2026-Q3');
      }
    });

    it('422 workflow_expired → GislWorkflowExpiredError with expired_at as Date', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Workflow expired',
            error_type: 'workflow_expired',
            expired_at: '2026-04-20T12:00:00.000Z',
          },
          422,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislWorkflowExpiredError);
        const expErr = err as GislWorkflowExpiredError;
        expect(expErr.statusCode).toBe(422);
        expect(expErr.payload.errorType).toBe('workflow_expired');
        // FromJSON converts the ISO-8601 string to a Date instance.
        expect(expErr.payload.expiredAt).toBeInstanceOf(Date);
        expect(expErr.payload.expiredAt.toISOString()).toBe(
          '2026-04-20T12:00:00.000Z',
        );
      }
    });

    it('422 array-shape details (no error_type) still throws GislValidationError (backcompat)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Validation failed',
            details: [
              { field: 'jobs[0].file_id', message: 'must be a UUID' },
            ],
          },
          422,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislValidationError);
        // The new typed subclasses are NOT a superset — validation must NOT
        // be misclassified as feature_not_available / workflow_expired.
        expect(err).not.toBeInstanceOf(GislFeatureNotAvailableError);
        expect(err).not.toBeInstanceOf(GislWorkflowExpiredError);
        const valErr = err as GislValidationError;
        expect(valErr.details).toHaveLength(1);
        expect(valErr.details[0].field).toBe('jobs[0].file_id');
      }
    });

    it('500 with no error_type falls through to base GislApiError; payload + messageKey populated', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Internal server error',
            message_key: 'error.server.unexpected',
            locale: 'en-GB',
          },
          500,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        // Must NOT be one of the typed subclasses.
        expect(err).not.toBeInstanceOf(GislAuthError);
        expect(err).not.toBeInstanceOf(GislBalanceExhaustedError);
        expect(err).not.toBeInstanceOf(GislWorkflowExpiredError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.messageKey).toBe('error.server.unexpected');
        expect(apiErr.locale).toBe('en-GB');
        // Raw envelope is preserved on payload for unknown shapes.
        expect(apiErr.payload).toMatchObject({
          success: false,
          error: 'Internal server error',
          message_key: 'error.server.unexpected',
        });
      }
    });

    it('422 workflow_expired with missing expired_at falls through to base GislApiError (FromJSON validation)', async () => {
      // Defense-in-depth: FromJSON does not throw on missing required fields —
      // it produces sentinel values like `new Date(undefined)` => Invalid Date.
      // The dispatch must validate the constructed payload and fall through
      // when required typed fields are not well-formed, rather than handing
      // the caller a silently-corrupted GislWorkflowExpiredError.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Workflow expired',
            error_type: 'workflow_expired',
            // expired_at: <missing>
          },
          422,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        expect(err).not.toBeInstanceOf(GislWorkflowExpiredError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(422);
      }
    });

    it('402 balance_exhausted with missing required_action falls through to base GislApiError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Balance exhausted',
            error_type: 'balance_exhausted',
            // required_action: <missing>
            links: { upgrade: 'https://example.com' },
          },
          402,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        expect(err).not.toBeInstanceOf(GislBalanceExhaustedError);
      }
    });

    it('500 with unknown error_type falls through to base GislApiError (no crash)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Some new error',
            error_type: 'never_heard_of_this',
          },
          500,
        ),
      );

      try {
        await client.getWorkflowStatus('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        // Specifically NOT a subclass — unknown discriminators must not crash
        // the FromJSON helper or be misrouted.
        expect(err).not.toBeInstanceOf(GislAuthError);
        expect(err).not.toBeInstanceOf(GislBalanceExhaustedError);
        expect(err).not.toBeInstanceOf(GislTierRestrictedError);
        expect(err).not.toBeInstanceOf(GislFeatureTierRestrictedError);
        expect(err).not.toBeInstanceOf(GislFeatureNotAvailableError);
        expect(err).not.toBeInstanceOf(GislWorkflowExpiredError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.errorMessage).toBe('Some new error');
      }
    });
  });

  // -----------------------------------------------------------------------
  // T5 (A0AV950u): upload thresholds + metadata_hint forwarding
  //
  // The v2 contract pins UploadThresholds.single_shot_max_bytes at 10_000_000
  // (was 10_485_760 / 10MiB pre-T5). Routing predicate is strictly
  // `size > threshold`, so equal-to stays single-shot. The multipart-only
  // `metadata_hint` form field is JSON-stringified and dropped on single-shot.
  // -----------------------------------------------------------------------

  describe('upload thresholds + metadata_hint', () => {
    const SINGLE_SHOT_MAX_BYTES = 10_000_000; // mirror of client.ts module const
    // Tail size when boundary+1 routes through multipart: total - 8MB first chunk.
    // Stays positive because SINGLE_SHOT_MAX_BYTES (10_000_000) > first chunk (8_388_608).
    const TAIL_BOUNDARY = SINGLE_SHOT_MAX_BYTES + 1 - DEFAULT_MULTIPART_FIRST_CHUNK_SIZE;

    function singleUploadResponse(fileId = 'file-bound', sizeBytes = SINGLE_SHOT_MAX_BYTES): Response {
      return jsonResponse({
        success: true,
        data: {
          file_id: fileId,
          original_name: 'upload',
          mime_type: 'application/octet-stream',
          size_bytes: sizeBytes,
          constraints_applied: {
            max_size_bytes: 10_000_000,
            max_duration_seconds: null,
            processing_class_pre_assignment: 'short_form',
          },
        },
      });
    }

    interface MultipartMockOptions {
      uploadId?: string;
      tailSize?: number;
      mimeType?: string;
      constraintsApplied?: {
        max_size_bytes: number;
        max_duration_seconds: number | null;
        processing_class_pre_assignment: 'short_form' | 'long_form' | 'unknown';
      };
    }

    function mockMultipartFlow(opts: MultipartMockOptions = {}): {
      uploadId: string;
      tailSize: number;
    } {
      const uploadId = opts.uploadId ?? 'upload-thr-1';
      const tailSize = opts.tailSize ?? TAIL_BOUNDARY;
      const constraintsApplied = opts.constraintsApplied ?? {
        max_size_bytes: 10_000_000,
        max_duration_seconds: null,
        processing_class_pre_assignment: 'short_form' as const,
      };

      // Leg 1: initiate.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: uploadId,
            mime_type: opts.mimeType ?? 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            recommended_chunk_size: tailSize,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2099-01-01T00:00:00.000Z',
              },
            ],
            constraints_applied: constraintsApplied,
          },
        }),
      );
      // Leg 2: S3 PUT.
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { etag: '"etag-part-2"' },
        }),
      );
      // Leg 3: complete.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: {
              upload_id: uploadId,
              status: 'completed',
            },
          },
          201,
        ),
      );
      return { uploadId, tailSize };
    }

    // Helper: extract a multipart FormData body from a fetchSpy invocation. We
    // can't introspect the FormData via the captured RequestInit alone (it's
    // an opaque BodyInit at the type level), but the tests pass FormData
    // directly so a runtime cast is sound.
    function formDataAt(callIndex: number): FormData {
      const init = fetchSpy.mock.calls[callIndex][1] as RequestInit;
      const body = init.body;
      if (!(body instanceof FormData)) {
        throw new Error(
          `formDataAt(${callIndex}): body is not FormData (got ${Object.prototype.toString.call(body)})`,
        );
      }
      return body;
    }

    it('routes single-shot at the threshold boundary (size === 10_000_000)', async () => {
      fetchSpy.mockResolvedValueOnce(singleUploadResponse());

      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES)]);
      await client.uploadFile(blob);

      // Exactly one outbound call to /api/uploads. No multipart legs.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/api/uploads');
      expect(url).not.toContain('multipart');
    });

    it('routes multipart above the boundary (size === 10_000_001)', async () => {
      mockMultipartFlow();

      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]);
      await client.uploadFile(blob);

      // Three legs: initiate, S3 PUT, complete. The first call MUST be
      // /multipart/initiate — single-shot would have been just /api/uploads.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const [initUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(initUrl).toBe('https://api.example.com/api/uploads/multipart/initiate');
    });

    it('default multipartThreshold matches the v2 single_shot_max_bytes const (10_000_000)', async () => {
      // No explicit multipartThreshold — exercise the default. Two clients
      // (one per blob size) so the fetch mock stack stays simple.
      const defaultClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      });

      // Below boundary: still single-shot.
      fetchSpy.mockResolvedValueOnce(singleUploadResponse('file-eq', SINGLE_SHOT_MAX_BYTES));
      await defaultClient.uploadFile(
        new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES)]),
      );
      expect(fetchSpy.mock.calls).toHaveLength(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/uploads');

      // Above boundary: multipart. We need a SECOND independent client
      // because the abovesize blob queues 3 mocks; otherwise the prior
      // single-shot test could pollute call ordering.
      mockMultipartFlow({ uploadId: 'upload-default' });
      await defaultClient.uploadFile(
        new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]),
      );
      // Total now 4 calls: 1 single-shot (above) + 3 multipart (init/PUT/complete).
      expect(fetchSpy.mock.calls).toHaveLength(4);
      expect(fetchSpy.mock.calls[1][0]).toBe(
        'https://api.example.com/api/uploads/multipart/initiate',
      );
    });

    it('forwards metadataHint as a snake_case-serialised single FormData field on multipart initiate', async () => {
      mockMultipartFlow();

      const hint = { durationSeconds: 30, width: 1920, height: 1080 };
      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]);
      await client.uploadFile(blob, { metadataHint: hint });

      // The hint is routed through the generated `ToJSON` helper before
      // stringification so the wire form uses the contract-pinned
      // snake_case keys (`duration_seconds`, NOT `durationSeconds`).
      const initiateForm = formDataAt(0);
      const all = initiateForm.getAll('metadata_hint');
      expect(all).toHaveLength(1);
      const parsed = JSON.parse(all[0] as string);
      expect(parsed).toEqual({
        duration_seconds: 30,
        width: 1920,
        height: 1080,
      });
      // Regression guard: camelCase keys must NOT appear on the wire.
      expect(parsed).not.toHaveProperty('durationSeconds');
    });

    it('omits metadata_hint when metadataHint is undefined on multipart upload', async () => {
      mockMultipartFlow();
      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]);
      await client.uploadFile(blob);

      const initiateForm = formDataAt(0);
      // No `metadata_hint` field at all — not even an empty string.
      expect(initiateForm.has('metadata_hint')).toBe(false);
      expect(initiateForm.getAll('metadata_hint')).toHaveLength(0);
    });

    it('silently ignores metadataHint on a single-shot upload (sub-threshold)', async () => {
      fetchSpy.mockResolvedValueOnce(singleUploadResponse('file-small', 100));

      const blob = new Blob([new Uint8Array(100)]);
      await client.uploadFile(blob, {
        metadataHint: { durationSeconds: 30, width: 1920, height: 1080 },
      });

      // Single-shot path. The /api/uploads body must NOT carry metadata_hint —
      // the contract only accepts it on /multipart/initiate.
      const form = formDataAt(0);
      expect(form.has('metadata_hint')).toBe(false);
    });

    it('synthesised UploadResponse forwards constraintsApplied from the initiate response', async () => {
      const constraints = {
        max_size_bytes: 524_288_000,
        max_duration_seconds: 600,
        processing_class_pre_assignment: 'short_form' as const,
      };
      mockMultipartFlow({ constraintsApplied: constraints });

      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]);
      const result = await client.uploadFile(blob);

      // Structural equality — the implementer notes the synthesis returns the
      // SAME object reference, but pinning shape is more refactor-robust.
      expect(result.constraintsApplied).toEqual({
        maxSizeBytes: 524_288_000,
        maxDurationSeconds: 600,
        processingClassPreAssignment: 'short_form',
      });
    });

    it('round-trips processing_class_pre_assignment="long_form" through the synthesised UploadResponse', async () => {
      mockMultipartFlow({
        constraintsApplied: {
          max_size_bytes: 1_073_741_824,
          max_duration_seconds: 7200,
          processing_class_pre_assignment: 'long_form',
        },
      });

      const blob = new Blob([new Uint8Array(SINGLE_SHOT_MAX_BYTES + 1)]);
      const result = await client.uploadFile(blob);

      expect(result.constraintsApplied.processingClassPreAssignment).toBe('long_form');
      expect(result.constraintsApplied.maxSizeBytes).toBe(1_073_741_824);
      expect(result.constraintsApplied.maxDurationSeconds).toBe(7200);
    });

    it('honours caller-supplied multipartThreshold override at its boundary', async () => {
      // Custom threshold above the v2 default (10_000_000) and above the
      // 8 MiB floor — exercises the configurable path independently of the
      // default-const tests above. Concrete regression guard: a future
      // change of `>` to `>=` in the routing predicate would fail here.
      const overrideClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-api-key',
        multipartThreshold: 12_000_000,
      });

      // Boundary-exact: 12_000_000 → single-shot.
      fetchSpy.mockResolvedValueOnce(
        singleUploadResponse('file-override-exact', 12_000_000),
      );
      const exact = new Blob([new Uint8Array(12_000_000)]);
      await overrideClient.uploadFile(exact);
      expect(fetchSpy.mock.calls).toHaveLength(1);
      const exactUrl = String(fetchSpy.mock.calls[0]?.[0]);
      expect(exactUrl).toContain('/api/uploads');
      expect(exactUrl).not.toContain('multipart');

      fetchSpy.mockClear();

      // One byte over → multipart. Stretch tailSize to match the over-blob.
      mockMultipartFlow({
        uploadId: 'upload-override-over',
        tailSize: 12_000_001 - DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
      });
      const over = new Blob([new Uint8Array(12_000_001)]);
      await overrideClient.uploadFile(over);
      const initiateUrl = String(fetchSpy.mock.calls[0]?.[0]);
      expect(initiateUrl).toContain('/api/uploads/multipart/initiate');
    });

    it('single-shot UploadResponse round-trips constraintsApplied via FromJSON', async () => {
      // Synthesis path is covered above; this pins the FromJSON path so a
      // regression replacing UploadResponseFromJSON with a hand-rolled
      // mapper that drops constraintsApplied still fails the unit suite
      // (parity catches it too but unit feedback is faster).
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: true,
            data: {
              file_id: '01936fb2-0000-7000-8000-000000000099',
              original_name: 'small.bin',
              mime_type: 'image/jpeg',
              size_bytes: 1024,
              constraints_applied: {
                max_size_bytes: 10_000_000,
                max_duration_seconds: null,
                processing_class_pre_assignment: 'short_form',
              },
            },
          },
          200,
        ),
      );

      const blob = new Blob([new Uint8Array(1024)]);
      const result = await client.uploadFile(blob);

      expect(result.constraintsApplied).toEqual({
        maxSizeBytes: 10_000_000,
        processingClassPreAssignment: 'short_form',
      });
      // `null` wire value normalises to undefined post-FromJSON.
      expect(result.constraintsApplied.maxDurationSeconds).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // multipartConcurrency sanitisation
  // -----------------------------------------------------------------------

  describe('multipartConcurrency sanitisation', () => {
    const TAIL_CHUNK_SIZE = 2 * 1024 * 1024 + 1;

    function effectiveConcurrency(c: GislClient): number {
      // The field is `private readonly` (client.ts:320). The cast here is
      // the documented escape hatch for sanitiser-contract assertions —
      // direct access would not typecheck.
      return (c as unknown as { multipartConcurrency: number }).multipartConcurrency;
    }

    function makeClient(value: number | undefined): GislClient {
      return new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartConcurrency: value,
      });
    }

    it('snaps undefined to default', () => {
      expect(effectiveConcurrency(makeClient(undefined))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('snaps 0 to default (zero workers would ship an incomplete parts array)', () => {
      expect(effectiveConcurrency(makeClient(0))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('snaps -1 to default', () => {
      expect(effectiveConcurrency(makeClient(-1))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('floors 1.5 to 1', () => {
      expect(effectiveConcurrency(makeClient(1.5))).toBe(1);
    });

    it('floors 4.7 to 4', () => {
      expect(effectiveConcurrency(makeClient(4.7))).toBe(4);
    });

    it('snaps Number.MIN_VALUE to default (positive but Math.floor=0; pins the floored<1 branch)', () => {
      expect(effectiveConcurrency(makeClient(Number.MIN_VALUE))).toBe(
        MULTIPART_CONCURRENCY_DEFAULT,
      );
    });

    it('snaps -0.5 to default (negative fractional must not pass through Math.floor=-1)', () => {
      expect(effectiveConcurrency(makeClient(-0.5))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('snaps -0 to default', () => {
      expect(effectiveConcurrency(makeClient(-0))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('snaps NaN to default', () => {
      expect(effectiveConcurrency(makeClient(Number.NaN))).toBe(MULTIPART_CONCURRENCY_DEFAULT);
    });

    it('snaps Infinity to default (previously this was bounded only by queue length — silent behaviour change)', () => {
      expect(effectiveConcurrency(makeClient(Number.POSITIVE_INFINITY))).toBe(
        MULTIPART_CONCURRENCY_DEFAULT,
      );
    });

    it('snaps -Infinity to default', () => {
      expect(effectiveConcurrency(makeClient(Number.NEGATIVE_INFINITY))).toBe(
        MULTIPART_CONCURRENCY_DEFAULT,
      );
    });

    it('passes through a normal positive integer (3)', () => {
      expect(effectiveConcurrency(makeClient(3))).toBe(3);
    });

    it('multipartConcurrency: 0 still uploads all parts (silent-corruption regression test)', async () => {
      // Two tail chunks (parts 2 and 3). Pre-fix: 0 workers, queue is never
      // drained, /multipart/complete would be called with parts: []. Post-fix:
      // the sanitiser snaps 0 to default (4), so Math.min(4, 2) = 2 workers,
      // both tail PUTs land, /complete sees parts: [{2, etag}, {3, etag}].
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'upload-mp-zero-conc',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-part-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 3,
            recommended_chunk_size: TAIL_CHUNK_SIZE,
            presigned_urls: [
              {
                part_number: 2,
                url: 'https://s3.example.com/upload?part=2',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
              {
                part_number: 3,
                url: 'https://s3.example.com/upload?part=3',
                expires_at: '2026-04-18T09:00:00.000Z',
              },
            ],
          },
        }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 200, headers: { etag: '"etag-part-2"' } }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 200, headers: { etag: '"etag-part-3"' } }),
      );
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: true, data: { upload_id: 'upload-mp-zero-conc', status: 'completed' } },
          201,
        ),
      );

      const zeroConcClient = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        multipartConcurrency: 0,
      });

      const blob = new Blob([
        new Uint8Array(DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 2 * TAIL_CHUNK_SIZE),
      ]);
      const result = await zeroConcClient.uploadFile(blob);

      expect(result.fileId).toBe('upload-mp-zero-conc');
      // initiate + 2 S3 PUTs + complete = 4 calls.
      expect(fetchSpy.mock.calls).toHaveLength(4);

      const [completeUrl, completeOpts] = fetchSpy.mock.calls[3] as [string, RequestInit];
      expect(completeUrl).toContain('/multipart/complete');
      const completeBody = JSON.parse(completeOpts.body as string);
      expect(completeBody.parts).toHaveLength(2);
      const partNumbers = completeBody.parts.map(
        (p: { part_number: number }) => p.part_number,
      );
      expect(partNumbers).toEqual([2, 3]);
    });
  });
});
