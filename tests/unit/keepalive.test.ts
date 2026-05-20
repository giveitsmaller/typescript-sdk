/**
 * SDK-3 (Wb6ebOMM) — `keepaliveUpload()` tests.
 *
 * Endpoint contract: empty body POST. Returns `{ upload_id, manifest_expires_at }`.
 * Idempotent on the server side (atomic Redis EXPIRE).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import {
  GislError,
  GislMultipartSessionAuthRequiredError,
  GislMultipartSessionNotFoundError,
} from '../../src/errors.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SDK-3 keepaliveUpload', () => {
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

  it('rejects empty uploadId before any HTTP', async () => {
    const err = await client.keepaliveUpload('').catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the keepalive endpoint and returns the new expiry', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          upload_id: 'u1',
          manifest_expires_at: '2026-05-23T12:00:00.000Z',
        },
      }),
    );
    const result = await client.keepaliveUpload('u1');
    expect(result).toEqual({
      uploadId: 'u1',
      manifestExpiresAt: '2026-05-23T12:00:00.000Z',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/uploads/multipart/u1/keepalive');
    expect((opts as RequestInit).method).toBe('POST');
  });

  it('surfaces 404 NOT_FOUND as the typed error class', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'multipart session not found',
          error_type: 'MULTIPART_SESSION_NOT_FOUND',
        },
        404,
      ),
    );
    const err = await client.keepaliveUpload('gone').catch((e) => e);
    expect(err).toBeInstanceOf(GislMultipartSessionNotFoundError);
  });

  it('surfaces 403 OWNERSHIP (authed-but-non-owner) as the typed error class', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'session belongs to another user',
          error_type: 'MULTIPART_SESSION_OWNERSHIP',
        },
        403,
      ),
    );
    const { GislMultipartSessionOwnershipError } = await import(
      '../../src/errors.js'
    );
    const err = await client.keepaliveUpload('mp-someone-else').catch((e) => e);
    expect(err).toBeInstanceOf(GislMultipartSessionOwnershipError);
  });

  it('surfaces 403 AUTH_REQUIRED (anonymous-initiated session)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'session requires authentication',
          error_type: 'MULTIPART_SESSION_AUTH_REQUIRED',
        },
        403,
      ),
    );
    const err = await client.keepaliveUpload('anon').catch((e) => e);
    expect(err).toBeInstanceOf(GislMultipartSessionAuthRequiredError);
  });

  it('rejects a malformed response (missing manifest_expires_at)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { upload_id: 'u1' },
      }),
    );
    const err = await client.keepaliveUpload('u1').catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/malformed response/);
  });
});
