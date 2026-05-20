/**
 * SDK-3 (Wb6ebOMM) — `uploadFile({ resumeUploadId, onCheckpoint })` tests.
 *
 * Pins the resume-path semantics:
 * - Skips /multipart/initiate entirely.
 * - Walks /status (transparently aggregating pages).
 * - Computes missing parts; re-presigns in batches of <=100.
 * - PUTs only missing parts.
 * - onProgress seeded from existing parts; fires on each new PUT.
 * - onCheckpoint fires on entry AND after every successful PUT (OUTSIDE
 *   retry-scope — a throw does NOT trigger a duplicate PUT).
 * - Refuses sub-threshold files.
 * - Refuses wrong-file size mismatch.
 * - Refuses if part 1 is missing (session unrecoverable).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  open: vi.fn(),
}));

import { stat, open } from 'node:fs/promises';
import { GislClient } from '../../src/client.js';
import { GislError, GislMultipartPartCountError } from '../../src/errors.js';
import type { MultipartCheckpointState } from '../../src/types.js';

const statMock = stat as unknown as ReturnType<typeof vi.fn>;
const openMock = open as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFakeFile(fileSize: number): void {
  statMock.mockResolvedValue({ size: fileSize });
  openMock.mockImplementation(async () => ({
    read: vi.fn(async (_buf: Buffer, _off: number, length: number) => ({
      bytesRead: length,
    })),
    close: vi.fn(async () => {}),
  }));
}

const CHUNK = 16 * 1024 * 1024; // 16 MiB

interface StatusPageInput {
  uploadId: string;
  cursor: number;
  totalParts: number;
  isTruncated: boolean;
  nextMarker: number;
  parts: number[];
}
function buildStatusPage(opts: StatusPageInput): unknown {
  return {
    success: true,
    data: {
      upload_id: opts.uploadId,
      multipart_upload_id: 'srv-' + opts.uploadId,
      cloud_key: 'uploads/' + opts.uploadId,
      total_parts: opts.totalParts,
      uploaded_parts: opts.parts.map((n) => ({
        part_number: n,
        etag: `"etag-${n}"`,
        size_bytes: CHUNK,
        last_modified: '2026-05-19T12:00:00.000Z',
      })),
      next_part_number_marker: opts.nextMarker,
      is_truncated: opts.isTruncated,
      manifest_expires_at: '2026-05-21T12:00:00.000Z',
      recommended_chunk_size: CHUNK,
    },
  };
}

describe('SDK-3 uploadFile resume path', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      // Deterministic test runs: drop retry backoff.
      multipartRetryBaseMs: 0,
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    statMock.mockReset();
    openMock.mockReset();
  });

  it('rejects sub-threshold file with resumeUploadId set', async () => {
    installFakeFile(5 * 1024 * 1024); // 5 MB — below 10 MB default threshold
    const err = await client
      .uploadFile('/tmp/small.bin', { resumeUploadId: 'u1' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/at-or-below the multipart threshold/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('happy path: all-but-last-part previously uploaded, resume PUTs the missing one', async () => {
    // 3-part upload: part 1 (initiate first chunk) + parts 2,3 (presigned).
    // /status reports parts 1 + 2 uploaded; resume must PUT part 3 only.
    const totalParts = 3;
    const fileSize = (totalParts - 1) * CHUNK + 4 * 1024 * 1024; // last part is short
    installFakeFile(fileSize);

    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes('/multipart/u1/status')) {
        return jsonResponse(
          buildStatusPage({
            uploadId: 'u1',
            cursor: 0,
            totalParts,
            isTruncated: false,
            nextMarker: 2,
            parts: [1, 2],
          }),
        );
      }
      if (url.includes('/multipart/u1/presign')) {
        const body = JSON.parse((opts!.body as string) ?? '{}') as {
          part_numbers: number[];
        };
        return jsonResponse({
          success: true,
          data: {
            upload_id: 'u1',
            presigned_urls: body.part_numbers.map((n) => ({
              part_number: n,
              url: `https://s3.example.com/p${n}`,
              expires_at: '2026-05-21T12:00:00.000Z',
            })),
          },
        });
      }
      if (url.startsWith('https://s3.example.com/p')) {
        return new Response('', {
          status: 200,
          headers: { etag: `"newpart-${url}"` },
        });
      }
      if (url.endsWith('/multipart/complete')) {
        return jsonResponse({
          success: true,
          data: { upload_id: 'u1', status: 'completed' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const checkpoints: MultipartCheckpointState[] = [];
    const progress: Array<{ uploaded: number; total: number }> = [];

    const result = await client.uploadFile('/tmp/r.bin', {
      resumeUploadId: 'u1',
      onProgress: (uploaded, total) =>
        progress.push({ uploaded, total }),
      onCheckpoint: (state) => checkpoints.push(state),
    });

    expect(result.fileId).toBe('u1');
    expect(result.sizeBytes).toBe(fileSize);

    // /initiate must NEVER be called on resume.
    const initiateCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).endsWith('/multipart/initiate'),
    );
    expect(initiateCalls).toHaveLength(0);

    // /complete carries ALL parts (server-recorded 1,2 + newly-PUT 3).
    const completeCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).endsWith('/multipart/complete'),
    )!;
    const completeBody = JSON.parse(
      (completeCall[1] as RequestInit).body as string,
    ) as { upload_id: string; parts: Array<{ part_number: number; etag: string }> };
    expect(completeBody.upload_id).toBe('u1');
    expect(completeBody.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);

    // onProgress fired (entry seed + final part PUT).
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0].uploaded).toBe(2 * CHUNK); // seeded from /status
    expect(progress[progress.length - 1].uploaded).toBe(fileSize);

    // onCheckpoint fired on entry + after the 1 new PUT.
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints[0].uploadedPartNumbers).toEqual([1, 2]);
    expect(checkpoints[checkpoints.length - 1].uploadedPartNumbers).toEqual([
      1, 2, 3,
    ]);

    // Checkpoint state is JSON-serialisable.
    const round = JSON.parse(
      JSON.stringify(checkpoints[checkpoints.length - 1]),
    );
    expect(round.uploadId).toBe('u1');
    expect(round.totalParts).toBe(3);
    expect(round.uploadedPartNumbers).toEqual([1, 2, 3]);
  });

  it('interrupt-mid-upload: resume picks up missing parts and emits checkpoint after each', async () => {
    // 5-part upload: /status reports parts 1, 2, 4 uploaded (interrupted
    // mid-batch). Resume must PUT parts 3 and 5.
    const totalParts = 5;
    const fileSize = (totalParts - 1) * CHUNK + 4 * 1024 * 1024;
    installFakeFile(fileSize);

    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes('/multipart/u2/status')) {
        return jsonResponse(
          buildStatusPage({
            uploadId: 'u2',
            cursor: 0,
            totalParts,
            isTruncated: false,
            nextMarker: 4,
            parts: [1, 2, 4],
          }),
        );
      }
      if (url.includes('/multipart/u2/presign')) {
        const body = JSON.parse((opts!.body as string) ?? '{}') as {
          part_numbers: number[];
        };
        return jsonResponse({
          success: true,
          data: {
            upload_id: 'u2',
            presigned_urls: body.part_numbers.map((n) => ({
              part_number: n,
              url: `https://s3.example.com/u2-p${n}`,
              expires_at: '2026-05-21T12:00:00.000Z',
            })),
          },
        });
      }
      if (url.startsWith('https://s3.example.com/u2-p')) {
        return new Response('', {
          status: 200,
          headers: { etag: `"newpart-${url}"` },
        });
      }
      if (url.endsWith('/multipart/complete')) {
        return jsonResponse({
          success: true,
          data: { upload_id: 'u2', status: 'completed' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const checkpoints: MultipartCheckpointState[] = [];
    await client.uploadFile('/tmp/r.bin', {
      resumeUploadId: 'u2',
      onCheckpoint: (state) => checkpoints.push(state),
    });

    // 1 (entry) + 2 (PUTs for parts 3 and 5).
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0].uploadedPartNumbers).toEqual([1, 2, 4]);
    // After the first new PUT, EITHER part 3 OR part 5 is in the set (PUTs
    // run concurrently; order isn't deterministic). The terminal checkpoint
    // pins the full set [1,2,3,4,5].
    expect(checkpoints[checkpoints.length - 1].uploadedPartNumbers).toEqual([
      1, 2, 3, 4, 5,
    ]);

    // Presign batch carried EXACTLY the missing part numbers [3, 5].
    const presignCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/presign'),
    )!;
    const presignBody = JSON.parse(
      (presignCall[1] as RequestInit).body as string,
    ) as { part_numbers: number[] };
    expect(presignBody.part_numbers.sort()).toEqual([3, 5]);
  });

  it('short-circuits when every part is already uploaded — skips presign+PUT, goes straight to /complete', async () => {
    const totalParts = 3;
    const fileSize = (totalParts - 1) * CHUNK + 4 * 1024 * 1024;
    installFakeFile(fileSize);

    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/multipart/u3/status')) {
        return jsonResponse(
          buildStatusPage({
            uploadId: 'u3',
            cursor: 0,
            totalParts,
            isTruncated: false,
            nextMarker: 3,
            parts: [1, 2, 3],
          }),
        );
      }
      if (url.endsWith('/multipart/complete')) {
        return jsonResponse({
          success: true,
          data: { upload_id: 'u3', status: 'completed' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await client.uploadFile('/tmp/r.bin', {
      resumeUploadId: 'u3',
    });
    expect(result.fileId).toBe('u3');

    // No /presign and no S3 PUT.
    const presignCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/presign'),
    );
    expect(presignCalls).toHaveLength(0);
    const s3PutCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://s3.example.com'),
    );
    expect(s3PutCalls).toHaveLength(0);
  });

  it('rejects /status returning recommendedChunkSize below the contract minimum', async () => {
    // Resume-path defense-in-depth: same chunkSize range guard as the
    // fresh-upload path. Without it a malformed /status could drive
    // Buffer.allocUnsafe(length) into the memory-blowup class SDK-1 guards.
    installFakeFile(50 * 1024 * 1024);
    const totalParts = 3;
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            upload_id: 'u-undersized-chunk',
            multipart_upload_id: 'srv',
            cloud_key: 'k',
            total_parts: totalParts,
            uploaded_parts: [
              {
                part_number: 1,
                etag: '"e1"',
                size_bytes: CHUNK,
                last_modified: '2026-05-19T12:00:00Z',
              },
            ],
            next_part_number_marker: 1,
            is_truncated: false,
            manifest_expires_at: '2026-05-21T12:00:00Z',
            // drift-allow: test asserts the SDK rejects sub-minimum chunk
            // sizes (the value here is INTENTIONALLY below the 16 MiB
            // contract minimum to verify the guard fires).
            recommended_chunk_size: 1024 * 1024,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const err = await client
      .uploadFile('/tmp/r.bin', { resumeUploadId: 'u-undersized-chunk' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/outside the contract range/);
  });

  it('rejects /status returning totalParts > 10000 with typed GislMultipartPartCountError', async () => {
    installFakeFile(50 * 1024 * 1024);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            upload_id: 'u-over-cap',
            multipart_upload_id: 'srv',
            cloud_key: 'k',
            total_parts: 10_001,
            uploaded_parts: [
              {
                part_number: 1,
                etag: '"e1"',
                size_bytes: CHUNK,
                last_modified: '2026-05-19T12:00:00Z',
              },
            ],
            next_part_number_marker: 1,
            is_truncated: false,
            manifest_expires_at: '2026-05-21T12:00:00Z',
            recommended_chunk_size: CHUNK,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const err = await client
      .uploadFile('/tmp/r.bin', { resumeUploadId: 'u-over-cap' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislMultipartPartCountError);
    expect((err as GislMultipartPartCountError).requiredParts).toBe(10_001);
    expect((err as GislMultipartPartCountError).maxParts).toBe(10_000);
  });

  it('rejects /status uploadId mismatching the resumeUploadId arg', async () => {
    // File size inside the (totalParts-1)*CHUNK to totalParts*CHUNK bracket
    // so the size-mismatch guard doesn't fire first.
    installFakeFile(2 * CHUNK + 4 * 1024 * 1024);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            upload_id: 'mp-OTHER',
            multipart_upload_id: 'srv',
            cloud_key: 'k',
            total_parts: 3,
            uploaded_parts: [
              {
                part_number: 1,
                etag: '"e1"',
                size_bytes: CHUNK,
                last_modified: '2026-05-19T12:00:00Z',
              },
            ],
            next_part_number_marker: 1,
            is_truncated: false,
            manifest_expires_at: '2026-05-21T12:00:00Z',
            recommended_chunk_size: CHUNK,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const err = await client
      .uploadFile('/tmp/r.bin', { resumeUploadId: 'mp-EXPECTED' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/mismatching upload_id/);
  });

  it('refuses session when part 1 is missing (unrecoverable)', async () => {
    const totalParts = 3;
    const fileSize = (totalParts - 1) * CHUNK + 4 * 1024 * 1024;
    installFakeFile(fileSize);

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildStatusPage({
          uploadId: 'u4',
          cursor: 0,
          totalParts,
          isTruncated: false,
          nextMarker: 2,
          parts: [2], // part 1 missing
        }),
      ),
    );

    const err = await client
      .uploadFile('/tmp/r.bin', { resumeUploadId: 'u4' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/part 1 .* is missing/);
  });

  it('refuses wrong-file size mismatch', async () => {
    const totalParts = 3;
    // File size far exceeds the recorded plan's expected range.
    installFakeFile(totalParts * CHUNK + 1024 * 1024 * 1024);

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildStatusPage({
          uploadId: 'u5',
          cursor: 0,
          totalParts,
          isTruncated: false,
          nextMarker: 3,
          parts: [1, 2, 3],
        }),
      ),
    );

    const err = await client
      .uploadFile('/tmp/big.bin', { resumeUploadId: 'u5' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toMatch(/Wrong file for this uploadId/);
  });

  it('checkpoint-callback throw fails the upload but does NOT trigger a duplicate PUT', async () => {
    // Pins the architect-flagged invariant: a user-callback throw must not
    // dispatch a second PUT for the same part (would double-record etags
    // and corrupt /complete).
    const totalParts = 2;
    const fileSize = (totalParts - 1) * CHUNK + 4 * 1024 * 1024;
    installFakeFile(fileSize);

    const s3Puts: string[] = [];
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes('/multipart/u6/status')) {
        return jsonResponse(
          buildStatusPage({
            uploadId: 'u6',
            cursor: 0,
            totalParts,
            isTruncated: false,
            nextMarker: 1,
            parts: [1],
          }),
        );
      }
      if (url.includes('/multipart/u6/presign')) {
        const body = JSON.parse((opts!.body as string) ?? '{}') as {
          part_numbers: number[];
        };
        return jsonResponse({
          success: true,
          data: {
            upload_id: 'u6',
            presigned_urls: body.part_numbers.map((n) => ({
              part_number: n,
              url: `https://s3.example.com/u6-p${n}`,
              expires_at: '2026-05-21T12:00:00.000Z',
            })),
          },
        });
      }
      if (url.startsWith('https://s3.example.com/u6-p')) {
        s3Puts.push(url);
        return new Response('', {
          status: 200,
          headers: { etag: `"newpart-${url}"` },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // Onycheckpoint throws on the second call (the post-PUT checkpoint).
    let cb = 0;
    const err = await client
      .uploadFile('/tmp/r.bin', {
        resumeUploadId: 'u6',
        onCheckpoint: () => {
          cb += 1;
          if (cb === 2) throw new Error('callback boom');
        },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/callback boom/);
    // Critically: only ONE S3 PUT for the missing part. The callback throw
    // must NOT have triggered a retry-loop that re-PUTs the same part.
    expect(s3Puts).toHaveLength(1);
  });
});
