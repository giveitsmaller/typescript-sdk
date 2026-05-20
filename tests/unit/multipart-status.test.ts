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
}
function statusPage(opts: StatusPageOpts): Response {
  return jsonResponse({
    success: true,
    data: {
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
      manifest_expires_at: '2026-05-21T12:00:00.000Z',
      recommended_chunk_size: 16_777_216,
    },
  });
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
    const page2Url = fetchSpy.mock.calls[1]?.[0] as string;
    expect(page2Url).toContain('cursor=1000');
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
});
