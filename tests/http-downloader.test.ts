import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpDownloader } from '../src/http-downloader.js';
import {
  GislDownloadHttpError,
  GislNetworkError,
  GislRequestNotSentError,
  GislSinkError,
  GislTransportError,
} from '../src/errors.js';

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

  // -------------------------------------------------------------------------
  // t2qCrjdr — the split. The assertions above still pass BY INHERITANCE, which
  // is the point: nothing a consumer wrote against GislNetworkError breaks.
  // These pin the half that is new — which subclass, and what it says about
  // retrying.
  // -------------------------------------------------------------------------

  it('raises GislDownloadHttpError carrying the status on a non-ok response', async () => {
    fetchSpy = vi.fn(async () => new Response('nope', { status: 404 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const err = await new HttpDownloader()
      .downloadTo('https://cdn.example.com/missing', join(dir, 'z404.bin'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislDownloadHttpError);
    // The status is a FIELD, so telling a permanent 404 from a transient 503
    // no longer means parsing the message.
    expect((err as GislDownloadHttpError).status).toBe(404);
    // The honest answer, and the one the unsplit class could not give.
    expect((err as GislDownloadHttpError).retryable).toBe(false);
  });

  it('reports a 503 download as retryable and a 404 as not', async () => {
    // Same class, opposite advice — retryability is derived from the status
    // rather than fixed for the class. A single class-wide `retryable` is
    // exactly what made this undeclarable in the contracts taxonomy.
    fetchSpy = vi.fn(async () => new Response('later', { status: 503 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const err = await new HttpDownloader()
      .downloadTo('https://cdn.example.com/busy', join(dir, 'z503.bin'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislDownloadHttpError);
    expect((err as GislDownloadHttpError).status).toBe(503);
    expect((err as GislDownloadHttpError).retryable).toBe(true);
  });

  it('raises GislTransportError when the fetch itself rejects', async () => {
    fetchSpy = vi.fn(async () => {
      throw new TypeError('getaddrinfo ENOTFOUND cdn.example.com');
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const err = await new HttpDownloader()
      .downloadTo('https://cdn.example.com/gone', join(dir, 'zt.bin'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislTransportError);
    // NOT the HTTP half — nothing answered at all.
    expect(err).not.toBeInstanceOf(GislDownloadHttpError);
  });

  it('classifies an empty 2xx body as transport, not as an HTTP refusal', async () => {
    // The server said 2xx and delivered nothing. It did not refuse, it
    // under-delivered — so the advice is "retry", not "give up".
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const err = await new HttpDownloader()
      .downloadTo('https://cdn.example.com/empty', join(dir, 'ze.bin'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislTransportError);
    expect(err).not.toBeInstanceOf(GislDownloadHttpError);
  });

  it('keeps both halves catchable as GislNetworkError (no consumer breakage)', async () => {
    // The load-bearing compatibility claim, asserted rather than assumed.
    for (const [status, expected] of [
      [404, GislDownloadHttpError],
      [204, GislTransportError],
    ] as const) {
      fetchSpy = vi.fn(async () => new Response(status === 204 ? null : 'x', { status }));
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

      const err = await new HttpDownloader()
        .downloadTo('https://cdn.example.com/c', join(dir, `c${status}.bin`))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(expected);
      expect(err).toBeInstanceOf(GislNetworkError);
    }
  });

  it('reports transport failures as retryable and unsendable requests as not', () => {
    // codex 2968bf4e54f6 / 42669e3fe7be: both classes DOCUMENTED a retryability
    // and neither exposed one, so a consumer reading the documented API got
    // `undefined`. An unbacked claim in a docblock is the exact defect this
    // ticket exists to remove — shipping the split without the accessors would
    // have reproduced it one level down.
    expect(new GislTransportError('dns').retryable).toBe(true);
    expect(new GislRequestNotSentError('bad uri').retryable).toBe(false);
    // Both still narrow as the base, so the poll-fallback is unaffected.
    expect(new GislTransportError('dns')).toBeInstanceOf(GislNetworkError);
    expect(new GislRequestNotSentError('bad uri')).toBeInstanceOf(GislNetworkError);
  });

  it('rejects an unparseable URL before any I/O, as non-retryable', async () => {
    // codex f46340e1d58a: a malformed URL fails DETERMINISTICALLY, so it must
    // not land in the always-retryable bucket with DNS and TLS. `fetch` reports
    // both as the same TypeError, so the check has to happen BEFORE the call.
    fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const err = await new HttpDownloader()
      .downloadTo('not a url', join(dir, 'bad.bin'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislRequestNotSentError);
    expect((err as GislRequestNotSentError).retryable).toBe(false);
    // No request was ever attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
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
