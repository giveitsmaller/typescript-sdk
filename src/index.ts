// Node entry point — the package's `default` exports condition (and the
// historical single entry). Re-exports the browser-safe shared surface
// (`index.core.ts`) PLUS the Node-only symbols that statically import Node
// built-ins: `verifyWebhook` (node:crypto) and `HttpDownloader` (node:fs).
//
// The browser entry (`index.browser.ts`, selected by the `browser` exports
// condition) re-exports ONLY the core, omitting these two — so the browser
// surface is a strict subset of this one by construction and cannot drift.
export * from './index.core.js';
export { verifyWebhook } from './webhook.js';
export { HttpDownloader } from './http-downloader.js';
