/**
 * Browser stub for `node-fs.ts` — selected via the package.json `browser` field
 * file-remap so browser bundlers (vite/webpack/esbuild) never pull `node:fs` /
 * `node:path`. These are only reached by path-string uploads, which are
 * Node-only; a browser caller passes a `Blob`/`File` (handled by
 * `blobByteSource`, no filesystem) and never invokes these. If somehow called
 * in a browser, they throw a clear error rather than a missing-module crash.
 *
 * The signatures intentionally mirror the `node-fs.ts` re-exports
 * (`node:fs/promises` `open`/`stat`, `node:path` `basename`) so `client.ts`
 * type-checks identically against either module.
 */
import type { open as NodeOpen, stat as NodeStat } from 'node:fs/promises';
import type { basename as NodeBasename } from 'node:path';
export declare const open: typeof NodeOpen;
export declare const stat: typeof NodeStat;
export declare const basename: typeof NodeBasename;
