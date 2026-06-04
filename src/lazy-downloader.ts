/**
 * Browser-safe {@link Downloader} that defers loading the Node-only
 * {@link HttpDownloader} until a sink (`downloadTo` / `toFile`) actually runs.
 *
 * `HttpDownloader` statically imports `node:fs` / `node:stream`
 * (`http-downloader.ts`). Binding it eagerly in `run()` would drag those
 * built-ins into the ergonomic static import graph, breaking browser bundles
 * even though the browser run path never writes to disk. This wrapper is what
 * `run()` / `Handle` bind instead: it is constructed synchronously (no
 * async ripple through the parity-pinned `RunResult` / `Handle`), and the
 * `await import('./http-downloader.js')` only fires when a caller invokes a
 * sink. A browser caller that reads `RunResult.artifacts[].url` never triggers
 * the dynamic import, so `node:fs` stays out of the main browser chunk
 * (bundlers code-split dynamic imports).
 */
import type { Downloader } from './file-first.js';
import { GislSinkError } from './errors.js';

export class LazyHttpDownloader implements Downloader {
  async downloadTo(url: string, destPath: string): Promise<void> {
    // In a browser there is no filesystem — fail with the same clean
    // `downloader_unavailable` GislSinkError a downloader-less RunResult throws,
    // rather than a confusing module-load error from importing node:fs. Output
    // is reachable via RunResult.artifacts[].url; fetch it in the browser.
    if (typeof process === 'undefined' || process.versions?.node === undefined) {
      throw new GislSinkError(
        'Output sinks (downloadTo/toFile) require Node.js. In a browser, read ' +
          'RunResult.url / RunResult.artifacts[].url and fetch it instead.',
        { reason: 'downloader_unavailable' },
      );
    }
    // Magic comments keep bundlers (webpack/Vite) from pulling the Node-only
    // http-downloader (node:fs/node:stream) into a browser build — they leave
    // this as a literal runtime import that only Node ever reaches.
    const { HttpDownloader } = await import(
      /* webpackIgnore: true */ /* @vite-ignore */ './http-downloader.js'
    );
    return new HttpDownloader().downloadTo(url, destPath);
  }
}
