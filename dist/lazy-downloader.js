import { GislSinkError } from './errors.js';
export class LazyHttpDownloader {
    async downloadTo(url, destPath) {
        // In a browser there is no filesystem — fail with the same clean
        // `downloader_unavailable` GislSinkError a downloader-less RunResult throws,
        // rather than a confusing module-load error from importing node:fs. Output
        // is reachable via RunResult.artifacts[].url; fetch it in the browser.
        if (typeof process === 'undefined' || process.versions?.node === undefined) {
            throw new GislSinkError('Output sinks (downloadTo/toFile) require Node.js. In a browser, read ' +
                'RunResult.url / RunResult.artifacts[].url and fetch it instead.', { reason: 'downloader_unavailable' });
        }
        // Magic comments keep bundlers (webpack/Vite) from pulling the Node-only
        // http-downloader (node:fs/node:stream) into a browser build — they leave
        // this as a literal runtime import that only Node ever reaches.
        const { HttpDownloader } = await import(
        /* webpackIgnore: true */ /* @vite-ignore */ './http-downloader.js');
        return new HttpDownloader().downloadTo(url, destPath);
    }
}
