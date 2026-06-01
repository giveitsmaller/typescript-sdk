import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpDownloader } from '../src/http-downloader.js';
import { GislNetworkError, GislSinkError } from '../src/errors.js';

/**
 * FF2b — the Node-only streaming {@link HttpDownloader}: fetch → stream the
 * body to a local path (unauthenticated, pre-signed URLs). Error paths
 * (`!res.ok`, null body, unwritable dest) reject. Mirrors the PHP
 * `StreamingDownloaderTest`.
 */

let fetchSpy: ReturnType<typeof vi.fn>;
let dir: string;

function bodyResponse(text: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, init);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gisl-httpdl-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('HttpDownloader.downloadTo', () => {
  it('streams the response body to the destination path', async () => {
    fetchSpy = vi.fn(async () => bodyResponse('hello-bytes', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const dest = join(dir, 'out.bin');
    await new HttpDownloader().downloadTo('https://cdn.example.com/x', dest);

    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example.com/x');
    expect(readFileSync(dest, 'utf8')).toBe('hello-bytes');
  });

  it('issues an unauthenticated fetch (no headers/init second arg)', async () => {
    fetchSpy = vi.fn(async () => bodyResponse('x', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    await new HttpDownloader().downloadTo('https://cdn.example.com/y', join(dir, 'y.bin'));
    // Pre-signed URLs require no SDK auth — fetch is called with the URL only.
    expect(fetchSpy.mock.calls[0]).toEqual(['https://cdn.example.com/y']);
  });

  it('throws GislNetworkError on a non-ok response status', async () => {
    // A source-read failure (non-ok status) surfaces as GislNetworkError, to
    // match the PHP StreamingDownloader's source-open failure.
    fetchSpy = vi.fn(async () => new Response('nope', { status: 404 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      new HttpDownloader().downloadTo('https://cdn.example.com/missing', join(dir, 'z.bin')),
    ).rejects.toBeInstanceOf(GislNetworkError);
  });

  it('throws GislNetworkError when the response has no body', async () => {
    // A 204 No Content response has a null body — also a source-read failure.
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      new HttpDownloader().downloadTo('https://cdn.example.com/empty', join(dir, 'e.bin')),
    ).rejects.toBeInstanceOf(GislNetworkError);
  });

  it('throws GislSinkError(write_failed) when the destination is not writable', async () => {
    fetchSpy = vi.fn(async () => bodyResponse('data', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    // A path inside a non-existent directory cannot be opened for writing — the
    // destination-write failure surfaces as GislSinkError reason 'write_failed'
    // (parity with the PHP StreamingDownloader's dest-open failure).
    const bad = join(dir, 'no-such-subdir', 'out.bin');
    await expect(
      new HttpDownloader().downloadTo('https://cdn.example.com/x', bad),
    ).rejects.toBeInstanceOf(GislSinkError);
    await expect(
      new HttpDownloader().downloadTo('https://cdn.example.com/x', bad),
    ).rejects.toMatchObject({ reason: 'write_failed' });
  });
});
