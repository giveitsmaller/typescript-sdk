import { describe, expect, it } from 'vitest';

import { GislApiError, GislProbePendingError } from '../../src/errors.js';
import {
  isApiRetryableStatus,
  parseRetryAfterMs,
  rateLimitFromHeaders,
  retryAfterSecondsFromHeaders,
} from '../../src/retry-metadata.js';

// W8v4jWzx — the four additive read accessors on GislApiError (retryable,
// category, rateLimit, retryAfterSeconds) + the shared retry-metadata helpers.
// Per-lang unit coverage; the TS↔PHP registry-parity check lives in the
// generator pytest (scripts/tests/test_sdk_spec_generator.py).

describe('retry-metadata helpers', () => {
  describe('isApiRetryableStatus — bounded predicate', () => {
    it.each([408, 429, 500, 503, 599])('status %i is retryable', (status) => {
      expect(isApiRetryableStatus(status)).toBe(true);
    });

    it.each([200, 301, 400, 404, 409, 418, 600, 700])(
      'status %i is NOT retryable',
      (status) => {
        expect(isApiRetryableStatus(status)).toBe(false);
      },
    );

    it('bounds the 5xx window at 599 (600 is NOT retryable)', () => {
      expect(isApiRetryableStatus(599)).toBe(true);
      expect(isApiRetryableStatus(600)).toBe(false);
    });
  });

  describe('parseRetryAfterMs', () => {
    it('parses delta-seconds into milliseconds', () => {
      expect(parseRetryAfterMs('5')).toBe(5000);
      expect(parseRetryAfterMs('  30  ')).toBe(30000);
    });

    it('returns undefined for absent / empty / malformed', () => {
      expect(parseRetryAfterMs(undefined)).toBeUndefined();
      expect(parseRetryAfterMs('')).toBeUndefined();
      expect(parseRetryAfterMs('   ')).toBeUndefined();
      expect(parseRetryAfterMs('soon')).toBeUndefined();
      expect(parseRetryAfterMs('12.5')).toBeUndefined();
    });

    it('rejects relative-phrase dates (Date.parse → NaN)', () => {
      // Relative phrases must NOT be coerced into a bogus time — only true
      // HTTP-dates parse. Mirrors the PHP guard (leading-letter + colon).
      expect(parseRetryAfterMs('tomorrow')).toBeUndefined();
      expect(parseRetryAfterMs('monday')).toBeUndefined();
      expect(parseRetryAfterMs('now')).toBeUndefined();
    });

    it('treats zero / past as absent', () => {
      expect(parseRetryAfterMs('0')).toBeUndefined();
      const past = new Date(Date.now() - 60_000).toUTCString();
      expect(parseRetryAfterMs(past)).toBeUndefined();
    });

    it('parses a future HTTP-date to a positive ms delta (range, not exact)', () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const ms = parseRetryAfterMs(future);
      expect(ms).toBeDefined();
      // Tolerance window around ~60s to avoid clock-boundary flakiness.
      expect(ms!).toBeGreaterThan(50_000);
      expect(ms!).toBeLessThanOrEqual(61_000);
    });
  });

  describe('retryAfterSecondsFromHeaders', () => {
    it('reads the lowercased retry-after key as whole seconds', () => {
      expect(retryAfterSecondsFromHeaders({ 'retry-after': '45' })).toBe(45);
    });

    it('parses a future HTTP-date to whole seconds within tolerance', () => {
      const future = new Date(Date.now() + 90_000).toUTCString();
      const seconds = retryAfterSecondsFromHeaders({ 'retry-after': future });
      expect(seconds).toBeDefined();
      expect(seconds!).toBeGreaterThanOrEqual(80);
      expect(seconds!).toBeLessThanOrEqual(91);
    });

    it('collapses zero / past / missing / malformed to undefined', () => {
      expect(retryAfterSecondsFromHeaders({ 'retry-after': '0' })).toBeUndefined();
      const past = new Date(Date.now() - 60_000).toUTCString();
      expect(retryAfterSecondsFromHeaders({ 'retry-after': past })).toBeUndefined();
      expect(retryAfterSecondsFromHeaders({})).toBeUndefined();
      expect(retryAfterSecondsFromHeaders(undefined)).toBeUndefined();
      expect(retryAfterSecondsFromHeaders({ 'retry-after': 'abc' })).toBeUndefined();
      // Relative-phrase dates are rejected (regression pin for the parser).
      expect(retryAfterSecondsFromHeaders({ 'retry-after': 'tomorrow' })).toBeUndefined();
      expect(retryAfterSecondsFromHeaders({ 'retry-after': 'monday' })).toBeUndefined();
    });
  });

  describe('rateLimitFromHeaders', () => {
    it('returns the snapshot when all three x-ratelimit-* headers are integers', () => {
      const snap = rateLimitFromHeaders({
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '7',
        'x-ratelimit-reset': '42',
      });
      expect(snap).toEqual({ limit: 100, remaining: 7, resetSeconds: 42 });
    });

    it('accepts "0" as a valid non-negative integer for every field', () => {
      expect(
        rateLimitFromHeaders({
          'x-ratelimit-limit': '0',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '0',
        }),
      ).toEqual({ limit: 0, remaining: 0, resetSeconds: 0 });
    });

    it('returns undefined for a partial set (missing reset)', () => {
      expect(
        rateLimitFromHeaders({
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '7',
        }),
      ).toBeUndefined();
    });

    it('returns undefined for a single header only', () => {
      expect(rateLimitFromHeaders({ 'x-ratelimit-limit': '100' })).toBeUndefined();
    });

    it('returns undefined when any value is non-integer', () => {
      expect(
        rateLimitFromHeaders({
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': 'x',
          'x-ratelimit-reset': '42',
        }),
      ).toBeUndefined();
    });

    it('returns undefined when headers are absent entirely', () => {
      expect(rateLimitFromHeaders(undefined)).toBeUndefined();
    });
  });
});

describe('GislApiError back-off accessors', () => {
  describe('category + retryable — registry resolution', () => {
    it('resolves probe_pending via the errorType discriminator (subclass payload)', () => {
      const err = new GislProbePendingError(422, 'Upload probe pending', {
        success: false,
        error: 'Upload probe pending',
        errorType: 'probe_pending',
        jobRef: 'job_compress',
      });
      // 422 is NOT a status-retryable code — retryable here comes purely from
      // the registry entry (probe_pending retryable: true).
      expect(isApiRetryableStatus(422)).toBe(false);
      expect(err.category).toBe('api');
      expect(err.retryable).toBe(true);
    });

    it('resolves probe_pending via a raw error_type discriminator on a base error', () => {
      const err = new GislApiError(422, 'Probe pending', undefined, undefined, {
        payload: { error_type: 'probe_pending' },
      });
      expect(err.category).toBe('api');
      expect(err.retryable).toBe(true);
    });

    it('resolves a validation code via the error_type discriminator', () => {
      const err = new GislApiError(422, 'Validation error', undefined, undefined, {
        payload: { errorType: 'validation_error' },
      });
      expect(err.category).toBe('validation');
      expect(err.retryable).toBe(false);
    });

    it('resolves a realistic envelope-error code via errorCode (auth_failed)', () => {
      // SCREAMING_SNAKE wire code normalises (trim + lowercase) to the registry key.
      const err = new GislApiError(401, 'Invalid API key', undefined, undefined, {
        errorCode: 'AUTH_FAILED',
      });
      expect(err.category).toBe('auth');
      // 401 is not status-retryable and the registry entry is not retryable.
      expect(err.retryable).toBe(false);
    });

    it('resolves an api-category envelope-error code via errorCode (multipart_session_not_found)', () => {
      const err = new GislApiError(404, 'Not found', undefined, undefined, {
        errorCode: 'multipart_session_not_found',
      });
      expect(err.category).toBe('api');
      expect(err.retryable).toBe(false);
    });

    it('lets the discriminator win over errorCode (D1 resolution order)', () => {
      const err = new GislApiError(422, 'Probe pending', undefined, undefined, {
        errorCode: 'AUTH_FAILED',
        payload: { errorType: 'probe_pending' },
      });
      // Discriminator (probe_pending → api, retryable) beats errorCode (auth_failed).
      expect(err.category).toBe('api');
      expect(err.retryable).toBe(true);
    });

    it('a retryable status wins over a non-retryable registry code (D2 OR, not ??)', () => {
      // auth_failed is category:auth, retryable:false. On a 5xx the accessor
      // must STILL be retryable: retryable = isApiRetryableStatus(status) ||
      // entry.retryable. A regression to registry-first (`??`) would wrongly
      // report false — this is the case that pins the OR semantics.
      const err = new GislApiError(500, 'Auth failed', undefined, undefined, {
        errorCode: 'AUTH_FAILED',
      });
      expect(isApiRetryableStatus(500)).toBe(true);
      expect(err.retryable).toBe(true);
      // The category still resolves to the registry entry's category.
      expect(err.category).toBe('auth');
    });

    it('a non-string error_type discriminator does not throw and falls back to errorCode', () => {
      // Guard: the discriminator is present but not a string (int 123). It must
      // be skipped by the typeof-string check (no throw) and resolution must
      // fall through to errorCode.
      const resolved = new GislApiError(401, 'Auth failed', undefined, undefined, {
        errorCode: 'AUTH_FAILED',
        payload: { error_type: 123 },
      });
      expect(() => resolved.category).not.toThrow();
      expect(resolved.category).toBe('auth');

      // When errorCode also isn't a registry key, category is undefined (still
      // no throw), and retryable derives purely from status.
      const unknown = new GislApiError(400, 'x', undefined, undefined, {
        errorCode: 'not_a_registry_code',
        payload: { error_type: 123 },
      });
      expect(() => unknown.category).not.toThrow();
      expect(unknown.category).toBeUndefined();
      expect(unknown.retryable).toBe(false);
    });
  });

  describe('unknown / absent code — category undefined, retryable from status only', () => {
    it('undefined category + retryable=true for a retryable status (500)', () => {
      const err = new GislApiError(500, 'Server error');
      expect(err.category).toBeUndefined();
      expect(err.retryable).toBe(true);
    });

    it('undefined category + retryable=false for a non-retryable status (400)', () => {
      const err = new GislApiError(400, 'Bad request');
      expect(err.category).toBeUndefined();
      expect(err.retryable).toBe(false);
    });

    it('an unknown errorCode resolves to undefined category (retryable from status)', () => {
      const err = new GislApiError(400, 'Nope', undefined, undefined, {
        errorCode: 'totally_unknown_code',
      });
      expect(err.category).toBeUndefined();
      expect(err.retryable).toBe(false);
    });
  });

  describe('retryable — status predicate boundaries via the accessor', () => {
    // errorCode is deliberately absent so retryable is driven purely by status.
    it.each<[number, boolean]>([
      [408, true],
      [429, true],
      [500, true],
      [599, true],
      [400, false],
      [404, false],
      [600, false],
    ])('status %i → retryable %s', (status, expected) => {
      const err = new GislApiError(status, 'x');
      expect(err.retryable).toBe(expected);
    });
  });

  describe('429 rate-limited response — snapshot + back-off hint', () => {
    it('exposes retryable, rateLimit and retryAfterSeconds together', () => {
      const err = new GislApiError(429, 'Too many requests', undefined, undefined, {
        errorCode: 'RATE_LIMITED',
        responseHeaders: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '42',
          'retry-after': '30',
        },
      });
      expect(err.retryable).toBe(true);
      expect(err.rateLimit).toEqual({ limit: 100, remaining: 0, resetSeconds: 42 });
      expect(err.retryAfterSeconds).toBe(30);
    });
  });

  describe('rateLimit / retryAfterSeconds shapes', () => {
    it('flat-auth shape: only Retry-After → retryAfterSeconds present, rateLimit undefined', () => {
      const err = new GislApiError(429, 'Slow down', undefined, undefined, {
        responseHeaders: { 'retry-after': '60' },
      });
      expect(err.retryAfterSeconds).toBe(60);
      expect(err.rateLimit).toBeUndefined();
    });

    it('partial x-ratelimit set → rateLimit undefined', () => {
      const err = new GislApiError(429, 'Slow down', undefined, undefined, {
        responseHeaders: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '5',
          // reset intentionally omitted
        },
      });
      expect(err.rateLimit).toBeUndefined();
    });

    it('no response headers at all → both accessors undefined', () => {
      const err = new GislApiError(500, 'Server error');
      expect(err.rateLimit).toBeUndefined();
      expect(err.retryAfterSeconds).toBeUndefined();
    });

    it('zero / malformed retry-after on the error → retryAfterSeconds undefined', () => {
      const zero = new GislApiError(429, 'x', undefined, undefined, {
        responseHeaders: { 'retry-after': '0' },
      });
      expect(zero.retryAfterSeconds).toBeUndefined();

      const bad = new GislApiError(429, 'x', undefined, undefined, {
        responseHeaders: { 'retry-after': 'later' },
      });
      expect(bad.retryAfterSeconds).toBeUndefined();
    });
  });
});
