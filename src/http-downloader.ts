/**
 * Node-only streaming {@link Downloader} implementation.
 *
 * Lives in its own module so the framework-free `file-first.ts` stays
 * Node-import-free; the Node `fs`/`stream` imports are isolated here.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { Downloader } from './file-first.js';
import { GislNetworkError, GislSinkError } from './errors.js';

/**
 * Streams a (typically pre-signed) URL to a local path without buffering the
 * whole body in memory. Pre-signed download URLs require no SDK auth, so this
 * issues a plain unauthenticated `fetch`.
 */
export class HttpDownloader implements Downloader {
  async downloadTo(url: string, destPath: string): Promise<void> {
    // Source-read failures surface as GislNetworkError to match the PHP
    // StreamingDownloader (both raise GislNetworkError when the output URL
    // cannot be fetched); a dest-write failure is GislSinkError(write_failed)
    // on the RunResult sink side. Parity-critical: the FF1 sink contract tells
    // callers to narrow with instanceof, so the source-read error type must
    // match across languages.
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      // A rejected fetch (DNS, TCP, TLS, mid-flight disconnect) must surface as
      // GislNetworkError too — not the raw TypeError — so callers can narrow
      // every download-source failure with `instanceof GislNetworkError`
      // (codex review medium).
      throw new GislNetworkError(
        `Failed to fetch download source: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!res.ok) {
      throw new GislNetworkError(`Download failed with status ${res.status}`);
    }
    if (res.body === null) {
      throw new GislNetworkError('Download response had no body');
    }
    // `fetch`'s WHATWG ReadableStream and Node's `stream/web` ReadableStream
    // are structurally the same at runtime but typed in two different lib
    // declarations; the cast bridges them for `Readable.fromWeb`.
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
        createWriteStream(destPath),
      );
    } catch {
      // Destination-write failures (unwritable dir, disk full, …) surface as
      // GislSinkError(write_failed) to match the PHP StreamingDownloader — a
      // raw Node ENOENT would otherwise leak through the parity-critical sink
      // contract. Source-read failures are handled above as GislNetworkError.
      throw new GislSinkError(
        `Failed to stream download to destination: ${destPath}`,
        { reason: 'write_failed' },
      );
    }
  }
}
