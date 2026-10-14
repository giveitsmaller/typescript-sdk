/**
 * SDK-3 (Wb6ebOMM) — `presignParts()` client-side validation tests.
 *
 * The endpoint contract rejects bad inputs server-side (8 KiB raw-body cap,
 * total_parts ceiling, part 1 sealed, ≤100 per batch, unique). The SDK
 * mirrors every rule client-side BEFORE the HTTP round-trip so callers get
 * a clear typed error without round-tripping. This file pins those rules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import {
  GislError,
  GislMultipartPartCountError,
  GislUploadCapExceededError,
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

describe('SDK-3 presignParts client-side validation', () => {
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
    const err = await client.presignParts('', [2], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty partNumbers array', async () => {
    const err = await client.presignParts('u1', [], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/non-empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects >100 part_numbers in one batch', async () => {
    const big = Array.from({ length: 101 }, (_, i) => i + 2);
    const err = await client.presignParts('u1', big, 200).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/100/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects part_number == 1 (sealed at initiate)', async () => {
    const err = await client.presignParts('u1', [1, 2, 3], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/Part 1 is sealed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects part_number > totalParts', async () => {
    const err = await client.presignParts('u1', [11], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/\[2, 10\]/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-integer part_number', async () => {
    const err = await client.presignParts('u1', [2.5], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects duplicate part_numbers', async () => {
    const err = await client.presignParts('u1', [2, 3, 2], 10).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/duplicate/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects totalParts > 10000 with typed GislMultipartPartCountError (S3 ceiling guard)', async () => {
    // Per dispatch line 41 (verify ceiling): presign must NOT bypass the
    // <=10000-part guard shipped in SDK-1.
    const err = await client.presignParts('u1', [2], 10_001).catch((e) => e);
    expect(err).toBeInstanceOf(GislMultipartPartCountError);
    expect((err as GislMultipartPartCountError).requiredParts).toBe(10_001);
    expect((err as GislMultipartPartCountError).maxParts).toBe(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects totalParts < 1', async () => {
    const err = await client.presignParts('u1', [2], 0).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-integer totalParts', async () => {
    const err = await client.presignParts('u1', [2], 3.5).catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path: valid batch -> POSTs to /presign with snake_case body', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          upload_id: 'u1',
          presigned_urls: [
            {
              part_number: 2,
              url: 'https://s3.example.com/p2',
              expires_at: '2026-05-21T12:00:00.000Z',
            },
            {
              part_number: 5,
              url: 'https://s3.example.com/p5',
              expires_at: '2026-05-21T12:00:00.000Z',
            },
          ],
        },
      }),
    );

    const result = await client.presignParts('u1', [2, 5], 100);
    expect(result.uploadId).toBe('u1');
    expect(result.presignedUrls).toHaveLength(2);
    expect(result.presignedUrls[0]).toEqual({
      partNumber: 2,
      url: 'https://s3.example.com/p2',
      expiresAt: new Date('2026-05-21T12:00:00.000Z'),
    });
    for (const part of result.presignedUrls) {
      expect(part.expiresAt).toBeInstanceOf(Date);
      expect(part.expiresAt.toISOString()).toBe('2026-05-21T12:00:00.000Z');
      expect(part.expiresAt.getTime()).toBe(Date.UTC(2026, 4, 21, 12, 0, 0));
    }
    expect(result.presignedUrls[1].partNumber).toBe(5);
    expect(result.presignedUrls[1].url).toBe('https://s3.example.com/p5');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/uploads/multipart/u1/presign');
    const body = JSON.parse((opts as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ part_numbers: [2, 5] });
  });

  it('accepts exactly 100 part_numbers (boundary)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          upload_id: 'u1',
          presigned_urls: [],
        },
      }),
    );
    const exactly100 = Array.from({ length: 100 }, (_, i) => i + 2);
    await client.presignParts('u1', exactly100, 200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces server 422 FILE_TOO_LARGE_FOR_MULTIPART as GislUploadCapExceededError kind=cap_v2_multipart', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'multipart capacity exceeded',
          error_type: 'FILE_TOO_LARGE_FOR_MULTIPART',
        },
        422,
      ),
    );
    const err = await client.presignParts('u-big', [2], 100).catch((e) => e);
    expect(err).toBeInstanceOf(GislUploadCapExceededError);
    expect((err as GislUploadCapExceededError).kind).toBe('cap_v2_multipart');
    expect((err as GislUploadCapExceededError).payload).toBeUndefined();
  });

  it('accepts totalParts == 10000 (boundary)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { upload_id: 'u1', presigned_urls: [] },
      }),
    );
    await client.presignParts('u1', [9999], 10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // aHgScsLJ — a malformed /presign response is a GislError naming the method,
  // never a raw TypeError / RangeError from the generated FromJSON helper.
  async function expectPresignRejects(data: unknown): Promise<Error> {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data }));
    const err = (await client.presignParts('u1', [2], 10).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GislError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/^presignParts: /);
    return err;
  }

  it.each(OUT_OF_RANGE_TIMESTAMPS)(
    'rejects an out-of-range expires_at (%s) on the raw envelope',
    async (_label, value) => {
      const err = await expectPresignRejects({
        upload_id: 'u1',
        presigned_urls: [{ part_number: 2, url: 'https://s3.example.com/p2', expires_at: value }],
      });
      expect(err.message).toBe(
        'presignParts: malformed response envelope (presigned_urls entry missing an ISO-8601 expires_at).',
      );
    },
  );

  it('accepts a leap-day expires_at', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          upload_id: 'u1',
          presigned_urls: [{ part_number: 2, url: 'https://s3.example.com/p2', expires_at: LEAP_DAY }],
        },
      }),
    );
    const result = await client.presignParts('u1', [2], 10);
    expect(result.presignedUrls[0].expiresAt.toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });

  it('rejects a non-string expires_at (a number)', async () => {
    const err = await expectPresignRejects({
      upload_id: 'u1',
      presigned_urls: [
        { part_number: 2, url: 'https://s3.example.com/p2', expires_at: 1_779_364_800_000 },
      ],
    });
    expect(err.message).toMatch(/^presignParts: malformed response envelope/);
    expect(err.message).toMatch(/expires_at/);
  });

  it('rejects a presigned_urls entry with no expires_at key', async () => {
    const err = await expectPresignRejects({
      upload_id: 'u1',
      presigned_urls: [{ part_number: 2, url: 'https://s3.example.com/p2' }],
    });
    expect(err.message).toMatch(/^presignParts: malformed response envelope/);
  });

  it('rejects a missing presigned_urls array', async () => {
    const err = await expectPresignRejects({ upload_id: 'u1' });
    expect(err.message).toBe('presignParts: malformed response envelope.');
  });

  it('rejects a non-array presigned_urls', async () => {
    const err = await expectPresignRejects({ upload_id: 'u1', presigned_urls: {} });
    expect(err.message).toBe('presignParts: malformed response envelope.');
  });

  it('rejects a non-object presigned_urls entry', async () => {
    const err = await expectPresignRejects({ upload_id: 'u1', presigned_urls: [null] });
    expect(err.message).toMatch(/^presignParts: malformed response envelope/);
  });

  it('rejects a missing upload_id', async () => {
    const err = await expectPresignRejects({ presigned_urls: [] });
    expect(err.message).toBe('presignParts: malformed response envelope.');
  });

  it.each(NON_ISO_TIMESTAMPS)(
    'rejects a non-ISO-8601 expires_at (%s) on the raw envelope',
    async (_label, value) => {
      const err = await expectPresignRejects({
        upload_id: 'u1',
        presigned_urls: [{ part_number: 2, url: 'https://s3.example.com/p2', expires_at: value }],
      });
      expect(err.message).toBe(
        'presignParts: malformed response envelope (presigned_urls entry missing an ISO-8601 expires_at).',
      );
    },
  );

  it.each(ATOM_OFFSET_TIMESTAMPS)(
    'accepts an offset expires_at (%s)',
    async (_label, value) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'u1',
            presigned_urls: [
              { part_number: 2, url: 'https://s3.example.com/p2', expires_at: value },
            ],
          },
        }),
      );
      const result = await client.presignParts('u1', [2], 10);
      expect(result.presignedUrls).toHaveLength(1);
      expect(result.presignedUrls[0].expiresAt.toISOString()).toBe('2026-05-21T12:00:00.000Z');
    },
  );
});
