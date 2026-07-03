import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs/promises BEFORE importing the client (vi.mock is hoisted).
// The TS SDK's string-path upload branch now reads the file via
// `fs/promises` open()+positioned read() instead of readFileSync. Mocking
// the fs surface lets us simulate an arbitrarily huge file WITHOUT ever
// allocating it: the only thing that could blow memory (a whole-file read)
// is exactly what we assert never happens.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  open: vi.fn(),
}));

import { stat, open } from 'node:fs/promises';
import {
  GislClient,
  DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
} from '../../src/client.js';
import {
  GislAbortError,
  GislApiError,
  GislError,
  GislMultipartPartCountError,
  GislMultipartPartError,
  GislUploadCapExceededError,
} from '../../src/errors.js';

const statMock = stat as unknown as ReturnType<typeof vi.fn>;
const openMock = open as unknown as ReturnType<typeof vi.fn>;

interface ReadCall {
  position: number;
  length: number;
}

// A fake FileHandle whose read() NEVER allocates anything sized by the
// (huge) file — it only ever zero-fills the small caller-provided buffer for
// the requested range. It records every (position, length) so the test can
// assert the production code's read ARGUMENTS, not just the outcome (an
// outcome-only assertion would be a tautology: a fake that returns small
// buffers regardless of requested length proves nothing). It also THROWS if
// asked for a range above `maxSingleRead`, so a regression to a whole-file
// read fails the test loudly instead of silently passing.
function installFakeFile(
  fileSize: number,
  maxSingleRead: number,
  // Inject a SHORT read on the Nth read() call (1-indexed) to exercise the
  // truncation guard + the fd-close-on-throw finally path.
  shortReadOnCall?: number,
): {
  reads: ReadCall[];
  openCount: () => number;
  closeCount: () => number;
} {
  const reads: ReadCall[] = [];
  let opened = 0;
  let closed = 0;
  let readCallNo = 0;

  statMock.mockResolvedValue({ size: fileSize });
  openMock.mockImplementation(async () => {
    opened += 1;
    return {
      read: vi.fn(
        async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          readCallNo += 1;
          reads.push({ position, length });
          if (length > maxSingleRead) {
            throw new Error(
              `Fake fs: refusing a ${length}-byte single read — a chunked ` +
                `streaming reader must never request more than ${maxSingleRead}. ` +
                'This indicates a regression to whole-file buffering.',
            );
          }
          // Intentionally do NOT zero-fill: the mock S3 never inspects the
          // bytes, and a multi-GB zero-fill would itself dominate runtime.
          // We assert the READ ARGUMENTS, not the content.
          void buffer;
          void offset;
          if (shortReadOnCall !== undefined && readCallNo === shortReadOnCall) {
            return { bytesRead: length - 1 }; // simulate truncation mid-upload
          }
          return { bytesRead: length };
        },
      ),
      close: vi.fn(async () => {
        closed += 1;
      }),
    };
  });

  return {
    reads,
    openCount: () => opened,
    closeCount: () => closed,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('streaming upload (string-path branch)', () => {
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
    statMock.mockReset();
    openMock.mockReset();
  });

  // A smart multipart fetch mock: serves a computed chunk plan on initiate,
  // a 200+etag on every S3 PUT, and a completed envelope on complete —
  // independent of how many parts the file needs.
  function mockMultipart(
    uploadId: string,
    chunkSize: number,
    totalParts: number,
  ): void {
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/api/uploads/multipart/initiate')) {
        const presigned: Array<{
          part_number: number;
          url: string;
          expires_at: string;
        }> = [];
        for (let part = 2; part <= totalParts; part += 1) {
          presigned.push({
            part_number: part,
            url: `https://s3.example.com/up?part=${part}`,
            expires_at: '2026-04-18T09:00:00.000Z',
          });
        }
        return jsonResponse({
          success: true,
          data: {
            upload_id: uploadId,
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"etag-1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: totalParts,
            recommended_chunk_size: chunkSize,
            presigned_urls: presigned,
            constraints_applied: { processing_class_pre_assignment: 'short_form' },
          },
        });
      }
      if (url.startsWith('https://s3.example.com/up')) {
        return new Response('', {
          status: 200,
          headers: { etag: `"etag-${url}"` },
        });
      }
      if (url.endsWith('/api/uploads/multipart/complete')) {
        return jsonResponse(
          { success: true, data: { upload_id: uploadId, status: 'completed' } },
          201,
        );
      }
      throw new Error(`unexpected fetch: ${String(opts?.method)} ${url}`);
    });
  }

  // >5 GB logical file. Runtime is intrinsically O(fileSize) (the upload
  // path produces fileSize-worth of chunk Blobs), but PEAK memory is bounded
  // by concurrency*chunkSize — a small chunk keeps the test green AND is
  // exactly the property under test. Timeout raised because ~5 GiB of Blob
  // construction is real work even with no zero-fill.
  it('uploads a >5 GB file without ever reading more than one chunk at a time', async () => {
    const FILE_SIZE = 5 * 1024 * 1024 * 1024 + 1; // > 5 GiB
    const CHUNK = 16 * 1024 * 1024; // 16 MiB -> small peak mem, ~320 parts
    const FIRST = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE; // 8 MiB
    const totalParts = 1 + Math.ceil((FILE_SIZE - FIRST) / CHUNK);
    const fs = installFakeFile(FILE_SIZE, CHUNK);
    mockMultipart('mp-6g', CHUNK, totalParts);

    const result = await client.uploadFile('/tmp/huge.bin');

    // Outcome (necessary but NOT sufficient on its own).
    expect(result.sizeBytes).toBe(FILE_SIZE);
    expect(result.fileId).toBe('mp-6g');

    // ---- The real proof: assert the READ ARGUMENTS, per call ----
    expect(fs.reads.length).toBeGreaterThan(90); // many parts, not one read

    // (1) No single read is anywhere near the file size — every read is
    //     bounded by the chunk plan. This is the structural invariant that
    //     guarantees bounded memory (no allocation is sized by fileSize).
    const maxAllowed = Math.max(FIRST, CHUNK);
    for (const r of fs.reads) {
      expect(r.length).toBeGreaterThan(0);
      expect(r.length).toBeLessThanOrEqual(maxAllowed);
      expect(r.length).toBeLessThan(FILE_SIZE);
    }

    // (2) The (position,length) reads tile [0, FILE_SIZE) exactly once —
    //     no gap, no overlap. Proves byte-range correctness, which the
    //     mock server (accepts anything) cannot.
    const sorted = [...fs.reads].sort((a, b) => a.position - b.position);
    expect(sorted[0].position).toBe(0);
    let cursor = 0;
    for (const r of sorted) {
      expect(r.position).toBe(cursor); // contiguous, no gap/overlap
      cursor += r.length;
    }
    expect(cursor).toBe(FILE_SIZE); // exactly covers the whole file

    // (3) Every opened fd was closed (no descriptor leak across parts).
    expect(fs.openCount()).toBeGreaterThan(0);
    expect(fs.closeCount()).toBe(fs.openCount());
  }, 120_000);

  it('the fake throws on an oversized read — proving the assertion is not vacuous', async () => {
    // Sanity check on the harness itself: if the production code EVER
    // requested the whole file in one read, installFakeFile would throw.
    // Set maxSingleRead absurdly small so the very first (8 MiB) read trips
    // it, and confirm the upload rejects rather than silently "passing".
    const fs = installFakeFile(20 * 1024 * 1024, 1024);
    fetchSpy.mockResolvedValue(jsonResponse({ success: true, data: {} }));

    await expect(client.uploadFile('/tmp/x.bin')).rejects.toThrow(
      /regression to whole-file buffering/,
    );
    expect(fs.reads.some((r) => r.length > 1024)).toBe(true);
  });

  it('routes a small file through single-shot with one bounded read', async () => {
    const SMALL = 1 * 1024 * 1024; // 1 MB — below the 10 MB single-shot cap
    const fs = installFakeFile(SMALL, 16 * 1024 * 1024);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          file_id: 'f-small',
          original_name: 'x.bin',
          mime_type: 'application/octet-stream',
          size_bytes: SMALL,
          constraints_applied: { processing_class_pre_assignment: 'short_form' },
        },
      }),
    );

    const result = await client.uploadFile('/tmp/x.bin');

    expect(result.fileId).toBe('f-small');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/uploads');
    // Single bounded read of the whole <=10MB payload — never larger.
    expect(fs.reads).toEqual([{ position: 0, length: SMALL }]);
    expect(fs.closeCount()).toBe(fs.openCount());
  });

  describe('<=10k part guard (Model A — fires post-initiate)', () => {
    it('throws GislMultipartPartCountError when the server reports > 10000 parts', async () => {
      const FILE_SIZE = 50 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      // Mock the INITIATE response (NOT the filesystem) with an
      // out-of-contract part count. Per Model A the guard can only fire
      // after the initiate round-trip — totalParts/chunkSize live there.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'mp-overflow',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"e1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 10001,
            recommended_chunk_size: 16 * 1024 * 1024,
            presigned_urls: [],
            constraints_applied: { processing_class_pre_assignment: 'short_form' },
          },
        }),
      );

      const err = await client
        .uploadFile('/tmp/huge.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislMultipartPartCountError);
      expect(err).toBeInstanceOf(GislError);
      expect((err as GislMultipartPartCountError).maxParts).toBe(10000);
      expect(
        (err as GislMultipartPartCountError).requiredParts,
      ).toBeGreaterThanOrEqual(10001);
    });

    it('throws when the client-side recompute exceeds 10000 even if the server under-reports', async () => {
      // 165 GiB / 16 MiB chunk = 10560 parts — client-side recompute
      // exceeds the S3 10000-part ceiling, even though the server under-
      // reports total_parts: 5. SDK-2 (#84) raised the min chunk to 16
      // MiB; this file size keeps the test's intent (client recompute
      // catches the server lie) intact under the new contract.
      const FILE_SIZE = 165 * 1024 * 1024 * 1024; // 165 GiB
      installFakeFile(FILE_SIZE, 100 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'mp-uc',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"e1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 5, // server lies / under-reports
            recommended_chunk_size: 16 * 1024 * 1024, // 16 MiB -> ~10560 parts client-recompute
            presigned_urls: [],
            constraints_applied: { processing_class_pre_assignment: 'short_form' },
          },
        }),
      );

      await expect(client.uploadFile('/tmp/huge.bin')).rejects.toBeInstanceOf(
        GislMultipartPartCountError,
      );
    });
  });

  describe('typed multipart part failure', () => {
    it('throws GislMultipartPartError (with partNumber + uploadId) after retries exhaust', async () => {
      const client2 = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        multipartMaxAttempts: 2,
        multipartRetryBaseMs: 0,
      });
      const FILE_SIZE = 20 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: 'mp-fail',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 2,
              recommended_chunk_size: 16 * 1024 * 1024,
              presigned_urls: [
                {
                  part_number: 2,
                  url: 'https://s3.example.com/up?part=2',
                  expires_at: '2026-04-18T09:00:00.000Z',
                },
              ],
              constraints_applied: {
                processing_class_pre_assignment: 'short_form',
              },
            },
          });
        }
        // Every S3 PUT 503s -> retryable, exhausts attempts.
        return new Response('slow down', { status: 503 });
      });

      const err = await client2
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislMultipartPartError);
      expect(err).toBeInstanceOf(GislError);
      expect((err as GislMultipartPartError).partNumber).toBe(2);
      expect((err as GislMultipartPartError).uploadId).toBe('mp-fail');
    });

    it('retries an S3 PUT 408 (request timeout) and succeeds on the next attempt (TS<->PHP parity, qz7MjNTy)', async () => {
      const client2 = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        multipartMaxAttempts: 2,
        multipartRetryBaseMs: 0,
      });
      const FILE_SIZE = 20 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      let s3Puts = 0;
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: 'mp-408',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 2,
              recommended_chunk_size: 16 * 1024 * 1024,
              presigned_urls: [
                {
                  part_number: 2,
                  url: 'https://s3.example.com/up?part=2',
                  expires_at: '2026-04-18T09:00:00.000Z',
                },
              ],
              constraints_applied: {
                processing_class_pre_assignment: 'short_form',
              },
            },
          });
        }
        if (url.startsWith('https://s3.example.com/up')) {
          s3Puts += 1;
          // First S3 PUT 408 (request timeout) -> retryable; the retry succeeds.
          return s3Puts === 1
            ? new Response('request timeout', { status: 408 })
            : new Response('', { status: 200, headers: { etag: '"e2"' } });
        }
        if (url.endsWith('/multipart/complete')) {
          return jsonResponse(
            { success: true, data: { upload_id: 'mp-408', status: 'completed' } },
            201,
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await client2.uploadFile('/tmp/x.bin');
      expect(result.fileId).toBe('mp-408');
      // The 408 forced a second PUT for part 2 — proves 408 is retryable (a
      // non-retryable status would have thrown on the first attempt).
      expect(s3Puts).toBe(2);
    });
  });

  describe('upload cap typed errors', () => {
    it('413 -> GislUploadCapExceededError kind=absolute_413, no payload', async () => {
      installFakeFile(2 * 1024 * 1024, 16 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'File size exceeds maximum allowed (500MB)' },
          413,
        ),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislUploadCapExceededError);
      const cap = err as GislUploadCapExceededError;
      expect(cap.kind).toBe('absolute_413');
      expect(cap.statusCode).toBe(413);
      expect(cap.payload).toBeUndefined();
    });

    it('422 upload_size_exceeds_tier -> kind=size_tier with typed payload', async () => {
      installFakeFile(2 * 1024 * 1024, 16 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Too big for your tier',
            error_type: 'upload_size_exceeds_tier',
            current_tier: 'free',
            max_size_bytes: 10485760,
            required_tier: 'pro',
          },
          422,
        ),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislUploadCapExceededError);
      const cap = err as GislUploadCapExceededError;
      expect(cap.kind).toBe('size_tier');
      expect(cap.statusCode).toBe(422);
      expect((cap.payload as { maxSizeBytes: number }).maxSizeBytes).toBe(
        10485760,
      );
    });

    it('422 upload_duration_exceeds_tier -> kind=duration_tier with typed payload', async () => {
      installFakeFile(2 * 1024 * 1024, 16 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Too long for your tier',
            error_type: 'upload_duration_exceeds_tier',
            current_tier: 'free',
            max_duration_seconds: 300,
            required_tier: 'pro',
          },
          422,
        ),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislUploadCapExceededError);
      expect((err as GislUploadCapExceededError).kind).toBe('duration_tier');
    });

    // Defense-in-depth fall-through (the "no-op gate" risk class): a
    // malformed cap envelope must NOT masquerade as a typed
    // GislUploadCapExceededError — it must fall through to base
    // GislApiError. Mirrors the PHP testMalformed*FallsThroughToBase suite.
    it('422 upload_size_exceeds_tier missing max_size_bytes -> base GislApiError', async () => {
      installFakeFile(2 * 1024 * 1024, 16 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Too big',
            error_type: 'upload_size_exceeds_tier',
            current_tier: 'free',
            // max_size_bytes deliberately OMITTED -> validate() must reject
            required_tier: 'pro',
          },
          422,
        ),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err).not.toBeInstanceOf(GislUploadCapExceededError);
      expect((err as GislApiError).statusCode).toBe(422);
    });

    it('422 upload_duration_exceeds_tier with non-enum current_tier -> base GislApiError', async () => {
      installFakeFile(2 * 1024 * 1024, 16 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Too long',
            error_type: 'upload_duration_exceeds_tier',
            current_tier: 'not_a_real_tier', // fails the UserTier enum check
            max_duration_seconds: 300,
          },
          422,
        ),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err).not.toBeInstanceOf(GislUploadCapExceededError);
    });
  });

  describe('streaming safety paths (reviewer-flagged)', () => {
    // Emits a plan-CONSISTENT initiate (total_parts === client recompute,
    // presigned_urls.length === total_parts - 1) so the plan-consistency
    // guard does not pre-empt the behaviour under test.
    function mockInitiateThenS3(
      uploadId: string,
      chunkSize: number,
      fileSize: number,
    ): void {
      const remaining = Math.max(0, fileSize - DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
      const totalParts = 1 + Math.ceil(remaining / chunkSize);
      const presigned: Array<{
        part_number: number;
        url: string;
        expires_at: string;
      }> = [];
      for (let p = 2; p <= totalParts; p += 1) {
        presigned.push({
          part_number: p,
          url: `https://s3.example.com/up?part=${p}`,
          expires_at: '2026-04-18T09:00:00.000Z',
        });
      }
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: uploadId,
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: totalParts,
              recommended_chunk_size: chunkSize,
              presigned_urls: presigned,
              constraints_applied: {
                processing_class_pre_assignment: 'short_form',
              },
            },
          });
        }
        return new Response('', { status: 200, headers: { etag: '"e2"' } });
      });
    }

    it('short read (file truncated mid-upload) -> typed GislMultipartPartError, fd still closed', async () => {
      const CHUNK = 16 * 1024 * 1024;
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 4 * 1024 * 1024;
      // 1st read = 8 MiB first chunk (ok); 2nd read = the tail part -> short.
      const fs = installFakeFile(FILE_SIZE, CHUNK, 2);
      mockInitiateThenS3('mp-short', CHUNK, FILE_SIZE);

      const err = await client
        .uploadFile('/tmp/trunc.bin')
        .catch((e: unknown) => e);
      // codex review: a chunk READ failure now surfaces as the typed
      // GislMultipartPartError (partNumber + uploadId), wrapping the
      // underlying short-read message — consistent with PUT failures.
      expect(err).toBeInstanceOf(GislMultipartPartError);
      expect(err).toBeInstanceOf(GislError);
      expect((err as GislMultipartPartError).partNumber).toBe(2);
      expect((err as GislMultipartPartError).uploadId).toBe('mp-short');
      expect((err as Error).message).toMatch(
        /Short read .* File changed during upload/,
      );
      // The finally must still close every fd it opened despite the throw.
      expect(fs.openCount()).toBeGreaterThan(0);
      expect(fs.closeCount()).toBe(fs.openCount());
    });

    it('missing recommendedChunkSize -> precise GislError (TS<->PHP parity)', async () => {
      installFakeFile(50 * 1024 * 1024, 64 * 1024 * 1024);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            upload_id: 'mp-nochunk',
            mime_type: 'application/octet-stream',
            first_chunk_etag: '"e1"',
            first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
            total_parts: 2,
            // recommended_chunk_size deliberately OMITTED
            presigned_urls: [],
            constraints_applied: {
              processing_class_pre_assignment: 'short_form',
            },
          },
        }),
      );

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislError);
      expect((err as Error).message).toMatch(/recommendedChunkSize/);
    });

    // codex review (high): a malformed/hostile huge recommendedChunkSize is
    // now rejected by the contract-range guard BEFORE any read — so the
    // unbounded-Buffer.allocUnsafe / libuv-ceiling class is unreachable via
    // the normal multipart path (the fileByteSource per-read libuv guard
    // remains as unreachable-by-construction defense-in-depth). This
    // supersedes the old "drive a >INT32_MAX chunk to the read" test.
    it('huge recommendedChunkSize rejected by the contract-range guard, before any read', async () => {
      const HUGE_CHUNK = 0x7fffffff + 4 * 1024 * 1024; // > INT32_MAX, > 100 MiB
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + HUGE_CHUNK + 1;
      const fs = installFakeFile(FILE_SIZE, HUGE_CHUNK + 1024);
      mockInitiateThenS3('mp-hugechunk', HUGE_CHUNK, FILE_SIZE);

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislMultipartPartError);
      expect((err as Error).message).toMatch(/outside the contract range/);
      expect((err as Error).message).not.toMatch(/MAX_LENGTH/);
      // Fired BEFORE any tail-chunk read (only the 8 MiB first-chunk read).
      expect(fs.reads.every((r) => r.length <= DEFAULT_MULTIPART_FIRST_CHUNK_SIZE)).toBe(true);
    });

    it('below-minimum recommendedChunkSize rejected by the contract-range guard', async () => {
      const TINY = 1024 * 1024; // 1 MiB — below the 16 MiB contract minimum
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 4 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      mockInitiateThenS3('mp-tiny', TINY, FILE_SIZE);

      const err = await client.uploadFile('/tmp/x.bin').catch((e) => e);
      expect(err).toBeInstanceOf(GislError);
      expect((err as Error).message).toMatch(/outside the contract range/);
    });

    // codex round-3 (medium): a fractional recommended_chunk_size inside the
    // numeric range must be rejected (Number.isInteger) — it would otherwise
    // reach Buffer.allocUnsafe(fractional) and fail as a misleading read.
    it('fractional recommendedChunkSize rejected by the integer guard', async () => {
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 4 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      mockInitiateThenS3('mp-frac', 16_777_216.5, FILE_SIZE);

      const err = await client.uploadFile('/tmp/x.bin').catch((e) => e);
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislMultipartPartError);
      expect((err as Error).message).toMatch(/outside the contract range/);
    });

    // codex round-3 (low): missing total_parts must not surface as `NaN` in
    // GislMultipartPartCountError via Math.max(serverParts, computedParts).
    // The precise total_parts guard fires BEFORE the count-ceiling guard,
    // so the count guard's NaN math is short-circuited — file size below
    // is incidental (16 MiB chunk + 60 GiB = ~3840 computed parts, far
    // below 10000). The test pins that the missing-total_parts path
    // surfaces as a precise GislError, not as a `NaN`-bearing
    // GislMultipartPartCountError.
    it('missing total_parts -> precise GislError, never NaN in the error', async () => {
      const FILE_SIZE = 60 * 1024 * 1024 * 1024;
      installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: 'mp-noparts',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              // total_parts deliberately omitted (FromJSON passes through)
              recommended_chunk_size: 16 * 1024 * 1024,
              presigned_urls: [],
              constraints_applied: { processing_class_pre_assignment: 'short_form' },
            },
          });
        }
        return new Response('', { status: 200, headers: { etag: '"e2"' } });
      });

      const err = await client.uploadFile('/tmp/x.bin').catch((e) => e);
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislMultipartPartCountError);
      expect((err as Error).message).toMatch(/missing or invalid total_parts/);
      expect((err as Error).message).not.toMatch(/NaN/);
    });

    it('missing/empty upload_id rejected before any chunk work (TS<->PHP parity)', async () => {
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 4 * 1024 * 1024;
      const fs = installFakeFile(FILE_SIZE, 64 * 1024 * 1024);
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: '', // empty — FromJSON would pass it through
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 2,
              recommended_chunk_size: 16 * 1024 * 1024,
              presigned_urls: [
                { part_number: 2, url: 'https://s3.example.com/up?part=2', expires_at: '2026-04-18T09:00:00.000Z' },
              ],
              constraints_applied: { processing_class_pre_assignment: 'short_form' },
            },
          });
        }
        return new Response('', { status: 200, headers: { etag: '"e2"' } });
      });

      const err = await client.uploadFile('/tmp/x.bin').catch((e) => e);
      expect(err).toBeInstanceOf(GislError);
      expect((err as Error).message).toMatch(/missing or empty upload_id/);
      // Rejected before any tail-chunk read (only the first-chunk read at most).
      expect(fs.reads.every((r) => r.length <= DEFAULT_MULTIPART_FIRST_CHUNK_SIZE)).toBe(true);
    });

    // codex review (medium): an initiate plan that is internally
    // inconsistent BELOW the 10k cap must fail fast, not upload a mismatched
    // set of ranges and fail opaquely at /multipart/complete.
    it('inconsistent initiate plan (server total_parts != client recompute) -> fast GislError, no S3 PUT', async () => {
      const FILE_SIZE = DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 32 * 1024 * 1024;
      const CHUNK = 16 * 1024 * 1024; // client recompute = 1 + ceil(32/16) = 3
      installFakeFile(FILE_SIZE, CHUNK);
      let s3Puts = 0;
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          return jsonResponse({
            success: true,
            data: {
              upload_id: 'mp-inconsistent',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 7, // disagrees with the client recompute (3)
              recommended_chunk_size: CHUNK,
              presigned_urls: [
                { part_number: 2, url: 'https://s3.example.com/up?part=2', expires_at: '2026-04-18T09:00:00.000Z' },
                { part_number: 3, url: 'https://s3.example.com/up?part=3', expires_at: '2026-04-18T09:00:00.000Z' },
              ],
              constraints_applied: { processing_class_pre_assignment: 'short_form' },
            },
          });
        }
        s3Puts += 1;
        return new Response('', { status: 200, headers: { etag: '"e2"' } });
      });

      const err = await client
        .uploadFile('/tmp/x.bin')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislMultipartPartCountError); // not the ≤10k path
      expect((err as Error).message).toMatch(/internally inconsistent/);
      expect(s3Puts).toBe(0); // failed BEFORE any S3 PUT
    });

    it('pre-aborted signal never touches the filesystem', async () => {
      const fs = installFakeFile(3 * 1024 * 1024, 16 * 1024 * 1024);
      const ac = new AbortController();
      ac.abort();

      const err = await client
        .uploadFile('/tmp/x.bin', { signal: ac.signal })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislAbortError);
      expect(statMock).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
      expect(fs.openCount()).toBe(0);
    });

    it('abort mid multipart streaming upload -> GislAbortError, no leaked fd', async () => {
      const CHUNK = 16 * 1024 * 1024;
      const fs = installFakeFile(
        DEFAULT_MULTIPART_FIRST_CHUNK_SIZE + 3 * CHUNK,
        CHUNK,
      );
      const ac = new AbortController();
      let s3Puts = 0;
      fetchSpy.mockImplementation(async (url: string) => {
        if (url.endsWith('/multipart/initiate')) {
          const presigned = [2, 3, 4].map((p) => ({
            part_number: p,
            url: `https://s3.example.com/up?part=${p}`,
            expires_at: '2026-04-18T09:00:00.000Z',
          }));
          return jsonResponse({
            success: true,
            data: {
              upload_id: 'mp-abort',
              mime_type: 'application/octet-stream',
              first_chunk_etag: '"e1"',
              first_chunk_size_bytes: DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
              total_parts: 4,
              recommended_chunk_size: CHUNK,
              presigned_urls: presigned,
              constraints_applied: {
                processing_class_pre_assignment: 'short_form',
              },
            },
          });
        }
        s3Puts += 1;
        if (s3Puts === 1) ac.abort(); // abort after the first S3 part PUT
        return new Response('', { status: 200, headers: { etag: '"ex"' } });
      });

      const err = await client
        .uploadFile('/tmp/x.bin', { signal: ac.signal })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislAbortError);
      // Every fd opened for a chunk read must have been closed (the
      // per-call finally), even though the upload aborted mid-flight.
      expect(fs.closeCount()).toBe(fs.openCount());
    });
  });
});
