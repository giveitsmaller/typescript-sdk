/**
 * Node-only filesystem/path access used by path-string uploads in `client.ts`.
 *
 * @internal — isolated in its own module so the browser build can swap it for
 * `node-fs.browser.ts` via the package.json `browser` field, keeping `node:fs`
 * out of browser bundles. `client.ts` imports these STATICALLY (not via dynamic
 * `import()`), which is deliberate: a static re-export chain stays interceptable
 * by `vi.mock('node:fs/promises')` in the test suite, whereas a dynamic import
 * of a `node:` builtin is not mocked by vitest. Browser callers upload a
 * `Blob`/`File` (which never reaches this module); a browser bundle resolves the
 * `.browser` stub instead, so these symbols are never loaded there.
 */
export { open, stat } from 'node:fs/promises';
export { basename } from 'node:path';
