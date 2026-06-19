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
export declare class LazyHttpDownloader implements Downloader {
    downloadTo(url: string, destPath: string): Promise<void>;
}
