import type { Downloader } from './file-first.js';
/**
 * Streams a (typically pre-signed) URL to a local path without buffering the
 * whole body in memory. Pre-signed download URLs require no SDK auth, so this
 * issues a plain unauthenticated `fetch`.
 */
export declare class HttpDownloader implements Downloader {
    downloadTo(url: string, destPath: string): Promise<void>;
}
