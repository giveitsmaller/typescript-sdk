import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GislClient } from '../../src/client.js';
import {
  GislApiError,
  GislError,
  GislNetworkError,
  GislResponseContractError,
} from '../../src/index.js';

/**
 * u6Q9oxuI — a 2xx whose body violates the contract must reach the caller as a
 * typed GislResponseContractError, never as the generated deserialiser's raw
 * TypeError. The documented `catch (e) { if (e instanceof GislError) … }`
 * pattern has to catch it, and it must NOT look like an API error (the exchange
 * succeeded) or a network error (the body arrived).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (e: unknown) => e,
  );
}

function expectContractError(err: unknown, operation: string): GislResponseContractError {
  expect(err).toBeInstanceOf(GislResponseContractError);
  expect(err).toBeInstanceOf(GislError);
  expect(err).not.toBeInstanceOf(GislApiError);
  expect(err).not.toBeInstanceOf(GislNetworkError);
  const e = err as GislResponseContractError;
  expect(e.name).toBe('GislResponseContractError');
  expect(e.operation).toBe(operation);
  expect(e.retryable).toBe(false);
  return e;
}

describe('GislResponseContractError (u6Q9oxuI)', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('carries operation, path and cause, and is never retryable', () => {
    const cause = new TypeError('boom');
    const e = new GislResponseContractError('m', { operation: '/api/x', path: 'jobs', cause });
    expect(e.operation).toBe('/api/x');
    expect(e.path).toBe('jobs');
    expect((e as { cause?: unknown }).cause).toBe(cause);
    expect(e.retryable).toBe(false);
    expect(new GislResponseContractError('m', { operation: '/api/x' }).path).toBeNull();
  });

  describe('getSchema — the direct (rawResponse / ETag) call site', () => {
    it('a 200 missing required `operations` rejects typed, not as a raw TypeError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          schema_version: '2.0.0',
          capabilities_version: '1',
          generated_at: '2026-09-25T00:00:00Z',
        }),
      );

      const err = await rejectionOf(client.getSchema({ mimeType: 'image/jpeg' }));

      const e = expectContractError(err, '/api/operations/schema');
      // The generated throw does not name the field (documented TS narrowing).
      expect(e.path).toBeNull();
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
      expect(e.message).toContain('/api/operations/schema');
    });

    it('a 200 whose body is not JSON rejects typed, not as a raw SyntaxError', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const err = await rejectionOf(client.getSchema());

      const e = expectContractError(err, '/api/operations/schema');
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    });

    // Positive control: the wrapper must not turn a valid body into a failure.
    it('a well-formed 200 still resolves', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ schema_version: '2.0.0', operations: {} }),
      );
      const result = await client.getSchema();
      expect(result.notModified).toBe(false);
    });
  });

  describe('getWorkflowStatus — the shared request()/handleResponse path', () => {
    it('a 200 missing required `jobs` rejects typed, not as a raw TypeError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { workflow_id: 'wf-1', status: 'completed' },
        }),
      );

      const err = await rejectionOf(client.getWorkflowStatus('wf-1'));

      const e = expectContractError(err, '/api/workflows/wf-1/status');
      expect(e.path).toBeNull();
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    });

    it('a 200 whose body is JSON null rejects typed', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(null));

      const err = await rejectionOf(client.getWorkflowStatus('wf-1'));

      expectContractError(err, '/api/workflows/wf-1/status');
    });

    it('a 200 claiming JSON whose body does not parse rejects typed, not as an API error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{ not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      const err = await rejectionOf(client.getWorkflowStatus('wf-1'));

      const e = expectContractError(err, '/api/workflows/wf-1/status');
      expect((e as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    });

    it('a 200 with a non-JSON content type rejects typed, not as undefined', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<html>maintenance</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      );

      const err = await rejectionOf(client.getWorkflowStatus('wf-1'));

      expectContractError(err, '/api/workflows/wf-1/status');
    });

    it('the operation drops the query string', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { workflows: 'not-an-array', is_truncated: false } }),
      );

      const err = await rejectionOf(client.listWorkflows({ limit: 5 }));

      expectContractError(err, '/api/workflows');
    });

    it('a non-2xx is still a GislApiError, not a contract error', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'not_found', message: 'nope' }, 404),
      );

      const err = await rejectionOf(client.getWorkflowStatus('wf-1'));

      expect(err).toBeInstanceOf(GislApiError);
      expect(err).not.toBeInstanceOf(GislResponseContractError);
    });

    // Positive control: a well-formed body still resolves through the wrapper.
    it('a well-formed 200 still resolves', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { workflow_id: 'wf-1', status: 'completed', jobs: [] },
        }),
      );
      const status = await client.getWorkflowStatus('wf-1');
      expect(status.workflowId).toBe('wf-1');
    });
  });

  describe('getProfile (6zgxH2JI) — the unwrapped data.user', () => {
    // The generated FromJSON does not enforce `required`, so these would
    // otherwise RESOLVE with an undefined identity.
    it.each([
      ['missing `user`', { success: true, data: {} }],
      ['`user` is null', { success: true, data: { user: null } }],
      ['`user` without an `id`', { success: true, data: { user: { email: 'a@example.com' } } }],
      ['`id` not a string', { success: true, data: { user: { id: 42, email: 'a@example.com' } } }],
    ])('a 200 with %s rejects typed', async (_label, body) => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(body));

      const err = await rejectionOf(client.getProfile());

      const e = expectContractError(err, '/api/auth/profile');
      expect(e.message).toContain('/api/auth/profile');
    });

    it('a 200 whose body does not parse rejects typed', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{ not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      expectContractError(await rejectionOf(client.getProfile()), '/api/auth/profile');
    });

    // Positive control.
    it('a well-formed 200 still resolves', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            user: {
              id: 'usr-1',
              email: 'a@example.com',
              tier: 'free',
              email_verified: false,
              created_at: '2026-08-22T10:00:00Z',
            },
          },
        }),
      );
      expect((await client.getProfile()).id).toBe('usr-1');
    });
  });
});
