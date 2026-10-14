/**
 * SDK-3 (Wb6ebOMM) — `getUploadStatus()` walk-pagination tests.
 *
 * Pins the public surface of the aggregated `getUploadStatus()` and the
 * private walk-pagination loop:
 * - Single-page response surfaces as one aggregated result.
 * - Multi-page (`is_truncated=true`) is walked transparently to the caller.
 * - >1000 parts (acceptance criterion for the card) — 1500-part upload across
 *   2 pages.
 * - AbortSignal aborts mid-walk.
 * - Server-side anti-loop: `next_part_number_marker` MUST advance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { GislAbortError, GislError } from '../../src/errors.js';

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

interface StatusPageOpts {
  uploadId: string;
  cursor: number;
  totalParts: number;
  isTruncated: boolean;
  nextMarker: number;
  parts: number[];
  /** Replaces the page's manifest_expires_at (default '2026-05-21T12:00:00.000Z'). */
  manifestExpiresAt?: unknown;
}
function statusPageData(opts: StatusPageOpts): Record<string, unknown> {
  return {
    upload_id: opts.uploadId,
    multipart_upload_id: 'mp-srv-' + opts.uploadId,
    cloud_key: 'uploads/' + opts.uploadId,
    total_parts: opts.totalParts,
    uploaded_parts: opts.parts.map((n) => ({
      part_number: n,
      etag: `"etag-${n}"`,
      size_bytes: 16_777_216,
      last_modified: '2026-05-19T12:00:00.000Z',
    })),
    next_part_number_marker: opts.nextMarker,
    is_truncated: opts.isTruncated,
    manifest_expires_at:
      'manifestExpiresAt' in opts ? opts.manifestExpiresAt : '2026-05-21T12:00:00.000Z',
    recommended_chunk_size: 16_777_216,
  };
}
function statusPage(opts: StatusPageOpts): Response {
  return jsonResponse({ success: true, data: statusPageData(opts) });
}

describe('SDK-3 getUploadStatus walk-pagination', () => {
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

  it('single-page response surfaces as one aggregated result', async () => {
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-1',
        cursor: 0,
        totalParts: 3,
        isTruncated: false,
        nextMarker: 3,
        parts: [1, 2, 3],
      }),
    );
    const result = await client.getUploadStatus('mp-1');
    expect(result.uploadId).toBe('mp-1');
    expect(result.totalParts).toBe(3);
    expect(result.uploadedParts).toHaveLength(3);
    expect(result.uploadedParts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    for (const part of result.uploadedParts) {
      expect(part.lastModified).toBeInstanceOf(Date);
      expect(part.lastModified.toISOString()).toBe('2026-05-19T12:00:00.000Z');
      expect(part.lastModified.getTime()).toBe(Date.UTC(2026, 4, 19, 12, 0, 0));
    }
    expect(result.uploadedParts[0]).toEqual({
      partNumber: 1,
      etag: '"etag-1"',
      sizeBytes: 16_777_216,
      lastModified: new Date('2026-05-19T12:00:00.000Z'),
    });
    expect(result.manifestExpiresAt).toBeInstanceOf(Date);
    expect(result.manifestExpiresAt?.toISOString()).toBe('2026-05-21T12:00:00.000Z');
    expect(result.manifestExpiresAt?.getTime()).toBe(Date.UTC(2026, 4, 21, 12, 0, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('walks 2 pages on is_truncated=true and aggregates the parts', async () => {
    // Page 1: parts 1..1000, truncated
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-2',
        cursor: 0,
        totalParts: 1500,
        isTruncated: true,
        nextMarker: 1000,
        parts: Array.from({ length: 1000 }, (_, i) => i + 1),
      }),
    );
    // Page 2: parts 1001..1500
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-2',
        cursor: 1000,
        totalParts: 1500,
        isTruncated: false,
        nextMarker: 1500,
        parts: Array.from({ length: 500 }, (_, i) => 1001 + i),
      }),
    );

    const result = await client.getUploadStatus('mp-2');
    expect(result.totalParts).toBe(1500);
    expect(result.uploadedParts).toHaveLength(1500);
    expect(result.uploadedParts[0].partNumber).toBe(1);
    expect(result.uploadedParts[1499].partNumber).toBe(1500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Verify the page-2 URL carries the advanced cursor (?cursor=1000).
    // Assert the full path+`?` boundary so a regression that drops the `?`
    // separator (e.g. `/status` + `cursor=...`) is caught — `toContain('cursor=1000')`
    // alone would still pass a malformed `/statuscursor=1000` (S9WHtXre).
    const page2Url = fetchSpy.mock.calls[1]?.[0] as string;
    expect(page2Url).toContain('/api/uploads/multipart/mp-2/status?cursor=1000');
    expect(page2Url).toContain('limit=1000');
  });

  it('handles a >10000-part-capable session: parts up to total_parts=10000 across 10 pages', async () => {
    // Per acceptance criterion + dispatch line 41 (verify ceiling): the walk
    // must work for a maximum-S3-capacity (10000-part) session. Server pages
    // 1000 parts each; we get 10 pages.
    for (let page = 0; page < 10; page += 1) {
      const startPart = page * 1000 + 1;
      const endPart = (page + 1) * 1000;
      fetchSpy.mockResolvedValueOnce(
        statusPage({
          uploadId: 'mp-max',
          cursor: page * 1000,
          totalParts: 10_000,
          isTruncated: page < 9,
          nextMarker: endPart,
          parts: Array.from({ length: 1000 }, (_, i) => startPart + i),
        }),
      );
    }
    const result = await client.getUploadStatus('mp-max');
    expect(result.totalParts).toBe(10_000);
    expect(result.uploadedParts).toHaveLength(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('throws if server claims is_truncated=true but does not advance the marker', async () => {
    // Anti-loop defense: the server contract pins next_part_number_marker
    // to advance monotonically. A stuck marker would otherwise infinite-loop.
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-stuck',
        cursor: 0,
        totalParts: 1500,
        isTruncated: true,
        nextMarker: 0, // SAME as cursor — illegal
        parts: [1],
      }),
    );
    const err = await client.getUploadStatus('mp-stuck').catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/did not advance/);
  });

  it('rejects an empty uploadId before issuing any request', async () => {
    const err = await client.getUploadStatus('').catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours AbortSignal — aborts before page 1', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const err = await client
      .getUploadStatus('mp-abort', { signal: ctl.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislAbortError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid total_parts response shape', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          upload_id: 'mp-bad',
          multipart_upload_id: 'srv',
          cloud_key: 'k',
          // total_parts deliberately missing
          uploaded_parts: [],
          next_part_number_marker: 0,
          is_truncated: false,
          manifest_expires_at: '2026-05-21T12:00:00.000Z',
          recommended_chunk_size: 16_777_216,
        },
      }),
    );
    const err = await client.getUploadStatus('mp-bad').catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/total_parts/);
  });

  // aHgScsLJ — timestamps become Date; malformed pages are GislErrors naming
  // the method, never a raw TypeError / RangeError from the generated reader.

  it('takes manifestExpiresAt from the LAST page', async () => {
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-last',
        cursor: 0,
        totalParts: 3,
        isTruncated: true,
        nextMarker: 2,
        parts: [1, 2],
        manifestExpiresAt: '2026-05-21T12:00:00.000Z',
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-last',
        cursor: 2,
        totalParts: 3,
        isTruncated: false,
        nextMarker: 3,
        parts: [3],
        manifestExpiresAt: '2026-05-22T08:30:15.250Z',
      }),
    );
    const result = await client.getUploadStatus('mp-last');
    expect(result.manifestExpiresAt?.toISOString()).toBe('2026-05-22T08:30:15.250Z');
  });

  it('accepts an explicit null manifest_expires_at (TTL lapsed) as manifestExpiresAt === null', async () => {
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-null',
        cursor: 0,
        totalParts: 2,
        isTruncated: false,
        nextMarker: 1,
        parts: [1],
        manifestExpiresAt: null,
      }),
    );
    const result = await client.getUploadStatus('mp-null');
    expect(result.manifestExpiresAt).toBeNull();
    expect(result.uploadedParts).toHaveLength(1);
    expect(result.uploadedParts[0].lastModified.toISOString()).toBe('2026-05-19T12:00:00.000Z');
  });

  it('a null manifest on the LAST page wins over a Date on an earlier page', async () => {
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-null-last',
        cursor: 0,
        totalParts: 3,
        isTruncated: true,
        nextMarker: 2,
        parts: [1, 2],
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-null-last',
        cursor: 2,
        totalParts: 3,
        isTruncated: false,
        nextMarker: 3,
        parts: [3],
        manifestExpiresAt: null,
      }),
    );
    const result = await client.getUploadStatus('mp-null-last');
    expect(result.manifestExpiresAt).toBeNull();
  });

  async function expectStatusRejects(data: Record<string, unknown>): Promise<Error> {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data }));
    const err = (await client.getUploadStatus('mp-bad').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GislError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/^getUploadStatus: /);
    return err;
  }
  const goodPage = (): Record<string, unknown> =>
    statusPageData({
      uploadId: 'mp-bad',
      cursor: 0,
      totalParts: 2,
      isTruncated: false,
      nextMarker: 1,
      parts: [1],
    });

  it('rejects an absent manifest_expires_at key (not the same as an explicit null)', async () => {
    const data = goodPage();
    delete data['manifest_expires_at'];
    const err = await expectStatusRejects(data);
    expect(err.message).toMatch(/missing required fields/);
  });

  it("rejects an empty-string manifest_expires_at", async () => {
    const err = await expectStatusRejects({ ...goodPage(), manifest_expires_at: '' });
    expect(err.message).toMatch(/missing required fields/);
  });

  it('rejects a non-string manifest_expires_at (a number)', async () => {
    const err = await expectStatusRejects({
      ...goodPage(),
      manifest_expires_at: 1_779_364_800_000,
    });
    expect(err.message).toMatch(/missing required fields/);
  });

  it.each(OUT_OF_RANGE_TIMESTAMPS)(
    'rejects an out-of-range manifest_expires_at (%s) on the raw page',
    async (_label, value) => {
      const err = await expectStatusRejects({ ...goodPage(), manifest_expires_at: value });
      expect(err.message).toMatch(/^getUploadStatus: server page missing required fields/);
    },
  );

  it.each(OUT_OF_RANGE_TIMESTAMPS)(
    'rejects an out-of-range uploaded_parts[].last_modified (%s) on the raw page',
    async (_label, value) => {
      const err = await expectStatusRejects({
        ...goodPage(),
        uploaded_parts: [
          { part_number: 1, etag: '"e1"', size_bytes: 16_777_216, last_modified: value },
        ],
      });
      expect(err.message).toBe(
        'getUploadStatus: uploaded_parts entry missing an ISO-8601 last_modified.',
      );
    },
  );

  it('accepts a leap-day manifest_expires_at and uploaded_parts[].last_modified', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          ...goodPage(),
          manifest_expires_at: LEAP_DAY,
          uploaded_parts: [
            { part_number: 1, etag: '"e1"', size_bytes: 16_777_216, last_modified: LEAP_DAY },
          ],
        },
      }),
    );
    const result = await client.getUploadStatus('mp-bad');
    expect(result.manifestExpiresAt?.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    expect(result.uploadedParts[0].lastModified.toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });

  it('rejects a non-string uploaded_parts[].last_modified (a number)', async () => {
    const err = await expectStatusRejects({
      ...goodPage(),
      uploaded_parts: [
        { part_number: 1, etag: '"e1"', size_bytes: 16_777_216, last_modified: 1_779_192_000_000 },
      ],
    });
    expect(err.message).toBe(
      'getUploadStatus: uploaded_parts entry missing an ISO-8601 last_modified.',
    );
  });

  it('rejects a page missing the uploaded_parts array (required by the contract)', async () => {
    const data = goodPage();
    delete data['uploaded_parts'];
    const err = await expectStatusRejects(data);
    expect(err.message).toBe('getUploadStatus: server page missing the uploaded_parts array.');
  });

  it('rejects a malformed SECOND page after a valid first one', async () => {
    fetchSpy.mockResolvedValueOnce(
      statusPage({
        uploadId: 'mp-bad',
        cursor: 0,
        totalParts: 3,
        isTruncated: true,
        nextMarker: 2,
        parts: [1, 2],
      }),
    );
    const err = await expectStatusRejects({
      ...goodPage(),
      total_parts: 3,
      manifest_expires_at: '2026-13-45T25:61:61Z',
    });
    expect(err.message).toMatch(/^getUploadStatus: server page missing required fields/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(NON_ISO_TIMESTAMPS)(
    'rejects a non-ISO-8601 manifest_expires_at (%s) on the raw page',
    async (_label, value) => {
      const err = await expectStatusRejects({ ...goodPage(), manifest_expires_at: value });
      expect(err.message).toMatch(/^getUploadStatus: server page missing required fields/);
    },
  );

  it.each(NON_ISO_TIMESTAMPS)(
    'rejects a non-ISO-8601 uploaded_parts[].last_modified (%s) on the raw page',
    async (_label, value) => {
      const err = await expectStatusRejects({
        ...goodPage(),
        uploaded_parts: [
          { part_number: 1, etag: '"e1"', size_bytes: 16_777_216, last_modified: value },
        ],
      });
      expect(err.message).toBe(
        'getUploadStatus: uploaded_parts entry missing an ISO-8601 last_modified.',
      );
    },
  );

  it('rejects a null uploaded_parts entry as a GislError, not a TypeError', async () => {
    const err = await expectStatusRejects({ ...goodPage(), uploaded_parts: [null] });
    expect(err.message).toBe(
      'getUploadStatus: uploaded_parts entry missing an ISO-8601 last_modified.',
    );
  });

  it.each(ATOM_OFFSET_TIMESTAMPS)(
    'accepts an offset manifest_expires_at (%s)',
    async (_label, value) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ...goodPage(), manifest_expires_at: value } }),
      );
      const result = await client.getUploadStatus('mp-bad');
      expect(result.manifestExpiresAt?.toISOString()).toBe('2026-05-21T12:00:00.000Z');
    },
  );

  it.each(ATOM_OFFSET_TIMESTAMPS)(
    'accepts an offset uploaded_parts[].last_modified (%s)',
    async (_label, value) => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            ...goodPage(),
            uploaded_parts: [
              { part_number: 1, etag: '"e1"', size_bytes: 16_777_216, last_modified: value },
            ],
          },
        }),
      );
      const result = await client.getUploadStatus('mp-bad');
      expect(result.uploadedParts).toHaveLength(1);
      expect(result.uploadedParts[0].lastModified.toISOString()).toBe('2026-05-21T12:00:00.000Z');
    },
  );
});
