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

// CODE-1 (aHgScsLJ): strings `new Date()` parses but that are not RFC 3339
// date-times. Each must be rejected on the RAW wire value, before FromJSON.
// codex (aHgScsLJ): pattern-valid strings whose calendar fields are out of
// range. The RAW check range-checks them, so they fail on the envelope check
// (requireValidDate after FromJSON is unreachable defence in depth).
const OUT_OF_RANGE_TIMESTAMPS = [
  ['month 13, day 45, 25:61:61', '2026-13-45T25:61:61Z'],
  ['Feb 29 in a non-leap year', '2026-02-29T12:00:00Z'],
  ['April 31', '2026-04-31T12:00:00Z'],
] as const;
const LEAP_DAY = '2028-02-29T12:00:00Z';

// TEST-1 (aHgScsLJ): compression_api writes every multipart timestamp with
// DateTimeInterface::ATOM ('+00:00', no Z, no millis). Both forms name the
// same instant, 2026-05-21T12:00:00.000Z.
const ATOM_OFFSET_TIMESTAMPS = [
  ['a +00:00 offset (the API\'s ATOM format)', '2026-05-21T12:00:00+00:00'],
  ['a +02:00 offset', '2026-05-21T14:00:00+02:00'],
] as const;
const NON_ISO_TIMESTAMPS = [
  ['a date-only string', '2026-10-13'],
  ['a bare numeric string', '1'],
  ['an RFC 2822 string', 'Tue, 13 Oct 2026 12:00:00 GMT'],
] as const;

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
    expect(result.uploadId).toBe('u1');
    expect(result.manifestExpiresAt).toBeInstanceOf(Date);
    expect(result.manifestExpiresAt.toISOString()).toBe('2026-05-23T12:00:00.000Z');
    expect(result.manifestExpiresAt.getTime()).toBe(Date.UTC(2026, 4, 23, 12, 0, 0));
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

  // aHgScsLJ — every malformed shape is a GislError naming the method, never a
  // raw TypeError / RangeError leaking out of the generated FromJSON helper.
  async function expectKeepaliveRejects(data: unknown): Promise<Error> {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data }));
    const err = (await client.keepaliveUpload('u1').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GislError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/^keepaliveUpload: /);
    return err;
  }

  it.each(OUT_OF_RANGE_TIMESTAMPS)(
    'rejects an out-of-range manifest_expires_at (%s) on the raw envelope',
    async (_label, value) => {
      const err = await expectKeepaliveRejects({ upload_id: 'u1', manifest_expires_at: value });
      expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
    },
  );

  it('accepts a leap-day manifest_expires_at', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { upload_id: 'u1', manifest_expires_at: LEAP_DAY } }),
    );
    const result = await client.keepaliveUpload('u1');
    expect(result.manifestExpiresAt.toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });

  it('rejects a non-string manifest_expires_at (a number)', async () => {
    const err = await expectKeepaliveRejects({
      upload_id: 'u1',
      manifest_expires_at: 1_779_537_600_000,
    });
    expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
  });

  it('rejects an empty-string manifest_expires_at', async () => {
    const err = await expectKeepaliveRejects({ upload_id: 'u1', manifest_expires_at: '' });
    expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
  });

  it('rejects an explicit null manifest_expires_at (always required on keepalive)', async () => {
    const err = await expectKeepaliveRejects({ upload_id: 'u1', manifest_expires_at: null });
    expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
  });

  it('rejects a missing upload_id', async () => {
    const err = await expectKeepaliveRejects({ manifest_expires_at: '2026-05-23T12:00:00.000Z' });
    expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
  });

  it('rejects a non-object data envelope', async () => {
    const err = await expectKeepaliveRejects(['u1', '2026-05-23T12:00:00.000Z']);
    expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
  });

  it.each(NON_ISO_TIMESTAMPS)(
    'rejects a non-ISO-8601 manifest_expires_at (%s) on the raw envelope',
    async (_label, value) => {
      const err = await expectKeepaliveRejects({ upload_id: 'u1', manifest_expires_at: value });
      expect(err.message).toBe('keepaliveUpload: malformed response envelope.');
    },
  );

  it.each(ATOM_OFFSET_TIMESTAMPS)(
    'accepts an offset manifest_expires_at (%s)',
    async (_label, value) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { upload_id: 'u1', manifest_expires_at: value } }),
      );
      const result = await client.keepaliveUpload('u1');
      expect(result.manifestExpiresAt.toISOString()).toBe('2026-05-21T12:00:00.000Z');
    },
  );
});
