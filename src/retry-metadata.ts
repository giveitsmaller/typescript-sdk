// Shared HTTP retry-metadata helpers. Extracted here so `errors.ts` can consume
// them WITHOUT importing `client.ts`: `client.ts` already imports `errors.ts`, so
// pulling the module-private `parseRetryAfterMs` back out of `client.ts` would
// form a `client → errors → client` circular import. The millisecond parser is
// MOVED here verbatim; `client.ts` re-imports it so the retry-loop timing stays
// byte-identical.

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
export function isApiRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// Parse an HTTP `Retry-After` header into milliseconds. Accepts the two RFC
// 9110 forms: delta-seconds (e.g. "5") or an HTTP-date. Returns `undefined`
// for an absent / unparseable / negative value (caller falls back to its own
// backoff). A past HTTP-date clamps to 0.
export function parseRetryAfterMs(headerValue: string | undefined): number | undefined {
  if (headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  // A non-positive Retry-After (e.g. "0" or a past HTTP-date) must NOT short-
  // circuit the backoff to zero — treat it as absent so the caller falls back
  // to jitter and the loop can't busy-poll until timeout.
  // hnkwDULJ: an absurd delta (`Number('9'.repeat(400))` is Infinity) is not an
  // instruction anyone can honour; treat it as absent rather than as "forever".
  if (!Number.isSafeInteger(Math.round(ms))) return undefined;
  return ms > 0 ? ms : undefined;
}

/**
 * The server-suggested back-off delay in WHOLE seconds, parsed from the
 * `Retry-After` response header. Derived from {@link parseRetryAfterMs}
 * (`Math.floor(ms / 1000)`) so the semantics mirror the retry-loop parser:
 * absent / malformed / zero / past all collapse to `undefined`, as does a
 * sub-second future HTTP-date (floors to zero → treated as absent).
 */
export function retryAfterSecondsFromHeaders(
  headers: Record<string, string> | undefined,
): number | undefined {
  const ms = parseRetryAfterMs(headers?.['retry-after']);
  if (ms === undefined) return undefined;
  const seconds = Math.floor(ms / 1000);
  return seconds > 0 ? seconds : undefined;
}

// Parse a non-negative integer response header. Returns `undefined` for an
// absent value or anything that isn't a bare run of decimal digits (so a
// float, sign, or units suffix is rejected rather than silently truncated).
function parseIntHeader(headerValue: string | undefined): number | undefined {
  if (headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * A rate-limit snapshot parsed from the `x-ratelimit-*` response headers.
 * Present ONLY when `x-ratelimit-limit`, `x-ratelimit-remaining`, and
 * `x-ratelimit-reset` all parse as non-negative integers; otherwise
 * `undefined` (a partial set is not a usable snapshot).
 */
export function rateLimitFromHeaders(
  headers: Record<string, string> | undefined,
): RateLimitSnapshot | undefined {
  if (headers === undefined) return undefined;
  const limit = parseIntHeader(headers['x-ratelimit-limit']);
  const remaining = parseIntHeader(headers['x-ratelimit-remaining']);
  const resetSeconds = parseIntHeader(headers['x-ratelimit-reset']);
  if (limit === undefined || remaining === undefined || resetSeconds === undefined) {
    return undefined;
  }
  return { limit, remaining, resetSeconds };
}
