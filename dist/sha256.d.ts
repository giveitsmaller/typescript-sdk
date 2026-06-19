/**
 * Dependency-free, **synchronous** SHA-256 — browser- and Node-safe.
 *
 * @internal — NOT re-exported from `index.ts`. Exists so the ergonomic
 * preset-resolver fingerprint (`preset_resolver.ts`) can hash without importing
 * `node:crypto`, which would drag a Node-only built-in into the browser entry
 * graph. Output is byte-identical to Node's
 * `createHash('sha256').update(input, 'utf8').digest('hex')` and to PHP's
 * `hash('sha256', $input)` — the resolver fingerprint is parity-pinned
 * (`tests/unit/preset-resolver.test.ts` asserts exact digests; "do NOT relax to
 * a regex"). Web Crypto's `subtle.digest` is async and would force the resolver
 * sync→async, so a small sync implementation is used instead.
 *
 * Standard FIPS 180-4 SHA-256. Input is hashed as UTF-8 bytes.
 */
/**
 * Compute the SHA-256 of `input` (hashed as its UTF-8 byte encoding) and return
 * the lowercase 64-character hex digest.
 */
export declare function sha256Hex(input: string): string;
