/**
 * A rate-limit snapshot derived from the `x-ratelimit-*` response headers.
 * `resetSeconds` is the server's seconds-to-reset value (`X-RateLimit-Reset`),
 * NOT an absolute epoch — read {@link GislApiError.rateLimit} to obtain one.
 */
export interface RateLimitSnapshot {
    readonly limit: number;
    readonly remaining: number;
    readonly resetSeconds: number;
}
/**
 * Whether an HTTP status is retryable per the API-error taxonomy: request
 * timeout (408), rate-limit (429), or any 5xx (500–599). BOUNDED at 599 — a
 * non-standard 6xx-and-up status is NOT classified retryable.
 *
 * Now value-identical to the S3-PUT retry predicate (`isRetryableStatus`) in
 * `client.ts` (both are `408 || 429 || 500-599` after qz7MjNTy), but kept
 * DELIBERATELY SEPARATE: they guard different retry paths (S3-PUT chunk uploads
 * vs the API-error taxonomy) and may diverge again, so they must NOT be merged.
 */
export declare function isApiRetryableStatus(status: number): boolean;
export declare function parseRetryAfterMs(headerValue: string | undefined): number | undefined;
/**
 * The server-suggested back-off delay in WHOLE seconds, parsed from the
 * `Retry-After` response header. Derived from {@link parseRetryAfterMs}
 * (`Math.floor(ms / 1000)`) so the semantics mirror the retry-loop parser:
 * absent / malformed / zero / past all collapse to `undefined`, as does a
 * sub-second future HTTP-date (floors to zero → treated as absent).
 */
export declare function retryAfterSecondsFromHeaders(headers: Record<string, string> | undefined): number | undefined;
/**
 * A rate-limit snapshot parsed from the `x-ratelimit-*` response headers.
 * Present ONLY when `x-ratelimit-limit`, `x-ratelimit-remaining`, and
 * `x-ratelimit-reset` all parse as non-negative integers; otherwise
 * `undefined` (a partial set is not a usable snapshot).
 */
export declare function rateLimitFromHeaders(headers: Record<string, string> | undefined): RateLimitSnapshot | undefined;
