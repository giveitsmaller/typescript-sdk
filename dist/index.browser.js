// Browser entry point — selected by the `browser` exports condition in
// package.json (Vite / webpack / Rollup / esbuild / Parcel; Node ignores it).
//
// Re-exports ONLY the browser-safe shared surface (`index.core.ts`). It
// deliberately OMITS the Node-only `verifyWebhook` (node:crypto) and
// `HttpDownloader` (node:fs) that the Node entry (`index.ts`) adds — keeping
// `node:` built-ins out of the browser static import graph. A strict subset of
// the Node entry by construction, so it cannot silently drift.
//
// Output sinks (`RunResult.downloadTo()` / `toFile()`) are Node-only and throw
// `GislSinkError` in a browser by design — read `RunResult.artifacts[].url`
// (or `RunResult.url` for a single output) and fetch it in the browser. See
// docs/typescript/browser.md.
export * from './index.core.js';
