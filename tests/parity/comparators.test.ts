/**
 * Unit tests for the parity comparator. Fixtures exercise the happy path but
 * cannot prove the comparator fails when it should — a regression that makes
 * `compareValue` silently accept diverging payloads would leave every fixture
 * still green. These tests pin negative cases so a runner bug surfaces on the
 * TS side before it ships to PHP / Python / Rust runners via the shared spec.
 */
import { describe, it, expect } from 'vitest';
import { compareRequests, compareValue, matchString } from './comparators.js';
import type { FixtureRequest, FixtureValue } from './fixtures.js';
import type { CapturedRequest } from './fetch-stub.js';

function req(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return { method: 'GET', path: '/x', ...overrides } as FixtureRequest;
}

function captured(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    method: 'GET',
    url: 'https://api.test.example.com/x',
    path: '/x',
    query: {},
    headers: {},
    body: { type: 'empty' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchString — token grammar
// ---------------------------------------------------------------------------

describe('matchString — non-token equality', () => {
  it('requires exact match for non-token strings', () => {
    expect(matchString('abc', 'abc')).toBe(true);
    expect(matchString('abc', 'ab')).toBe(false);
    expect(matchString('abc', 'abcd')).toBe(false);
    expect(matchString('', '')).toBe(true);
  });
});

describe('matchString — <any> / <string>', () => {
  it('matches any non-empty string and rejects empty', () => {
    expect(matchString('<any>', 'x')).toBe(true);
    expect(matchString('<any>', '')).toBe(false);
    expect(matchString('<string>', 'x')).toBe(true);
    expect(matchString('<string>', '')).toBe(false);
  });
});

describe('matchString — <uuid>', () => {
  it('accepts UUID form, rejects non-UUID', () => {
    expect(matchString('<uuid>', '01936fb1-7bb3-7000-8000-000000000001')).toBe(true);
    expect(matchString('<uuid>', '01936FB1-7BB3-7000-8000-000000000001')).toBe(true);
    expect(matchString('<uuid>', 'not-a-uuid')).toBe(false);
    expect(matchString('<uuid>', '01936fb1-7bb3-7000-8000-00000000000')).toBe(false);
    expect(matchString('<uuid>', '')).toBe(false);
  });
});

describe('matchString — <iso8601>', () => {
  it('accepts Z and numeric-offset suffixes', () => {
    expect(matchString('<iso8601>', '2026-04-23T12:00:00Z')).toBe(true);
    expect(matchString('<iso8601>', '2026-04-23T12:00:00.123Z')).toBe(true);
    expect(matchString('<iso8601>', '2026-04-23T12:00:00+00:00')).toBe(true);
    expect(matchString('<iso8601>', '2026-04-23T12:00:00+0000')).toBe(true);
    expect(matchString('<iso8601>', '2026-04-23')).toBe(false);
    expect(matchString('<iso8601>', 'not-a-date')).toBe(false);
  });
});

describe('matchString — <int>', () => {
  it('accepts signed integer as string', () => {
    expect(matchString('<int>', '123')).toBe(true);
    expect(matchString('<int>', '-123')).toBe(true);
    expect(matchString('<int>', '0')).toBe(true);
    expect(matchString('<int>', '1.5')).toBe(false);
    expect(matchString('<int>', '1e10')).toBe(false);
    expect(matchString('<int>', '')).toBe(false);
  });
});

describe('matchString — <timestamp_unix>', () => {
  it('requires 10 or 13 digit range', () => {
    expect(matchString('<timestamp_unix>', '1740000000')).toBe(true); // 10
    expect(matchString('<timestamp_unix>', '1740000000000')).toBe(true); // 13
    expect(matchString('<timestamp_unix>', '123456789')).toBe(false); // 9
    expect(matchString('<timestamp_unix>', '17400000000000')).toBe(false); // 14
  });
});

describe('matchString — <hex:N>', () => {
  it('requires exactly N hex chars (case-insensitive)', () => {
    expect(matchString('<hex:4>', 'dead')).toBe(true);
    expect(matchString('<hex:4>', 'DEAD')).toBe(true);
    expect(matchString('<hex:4>', 'xyzz')).toBe(false);
    expect(matchString('<hex:4>', 'dea')).toBe(false);
    expect(matchString('<hex:64>', 'a'.repeat(64))).toBe(true);
    expect(matchString('<hex:64>', 'a'.repeat(63))).toBe(false);
  });
});

describe('matchString — <base64:N>', () => {
  it('requires exactly N base64 chars plus optional padding', () => {
    expect(matchString('<base64:4>', 'aGVs')).toBe(true);
    expect(matchString('<base64:4>', 'aGVs=')).toBe(true);
    expect(matchString('<base64:4>', 'aGVs==')).toBe(true);
    expect(matchString('<base64:4>', 'aGV')).toBe(false); // 3 chars
    expect(matchString('<base64:4>', 'aGVs===')).toBe(false); // 3 pads
    expect(matchString('<base64:4>', 'a_Vs')).toBe(false); // url-safe alphabet rejected
  });
});

describe('matchString — <etag> (quoted only, per RFC 7232)', () => {
  it('accepts any quoted opaque string', () => {
    // RFC 7232 allows arbitrary opaque contents — S3 emits hex + optional
    // "-N", other stores emit anything. Only the quote-wrap matters.
    expect(matchString('<etag>', '"abc123"')).toBe(true);
    expect(matchString('<etag>', '"ABC123"')).toBe(true);
    expect(matchString('<etag>', '"abc123-4"')).toBe(true);
    expect(matchString('<etag>', '"etag-part-2"')).toBe(true);
    expect(matchString('<etag>', '""')).toBe(true); // empty ETag is valid
  });
  it('rejects bare (unquoted) ETags — strict by design', () => {
    // A SDK that strips quotes before forwarding in /multipart/complete is a
    // real divergence; accepting bare would mask that regression.
    expect(matchString('<etag>', 'abc123')).toBe(false);
    expect(matchString('<etag>', '"abc123')).toBe(false);
    expect(matchString('<etag>', 'abc123"')).toBe(false);
  });
  it('rejects control chars inside the quoted value', () => {
    expect(matchString('<etag>', '"with\x00null"')).toBe(false);
    expect(matchString('<etag>', '"with\nnewline"')).toBe(false);
  });
});

describe('matchString — malformed tokens', () => {
  it('returns false for strings that look like tokens but are not', () => {
    expect(matchString('<unknown>', 'anything')).toBe(false);
    expect(matchString('<uuid', 'anything')).toBe(false); // missing close
  });
});

// ---------------------------------------------------------------------------
// compareValue — deep equal, token-aware, undefined-tolerant
// ---------------------------------------------------------------------------

describe('compareValue — scalars', () => {
  it('passes on equal scalars', () => {
    expect(compareValue(1 as FixtureValue, 1 as FixtureValue, '$').ok).toBe(true);
    expect(compareValue('a' as FixtureValue, 'a' as FixtureValue, '$').ok).toBe(true);
    expect(compareValue(true as FixtureValue, true as FixtureValue, '$').ok).toBe(true);
    expect(compareValue(null as unknown as FixtureValue, null as unknown as FixtureValue, '$').ok).toBe(true);
  });

  it('fails on diverging scalars', () => {
    expect(compareValue(1 as FixtureValue, 2 as FixtureValue, '$').ok).toBe(false);
    expect(compareValue('a' as FixtureValue, 'b' as FixtureValue, '$').ok).toBe(false);
    expect(compareValue(1 as FixtureValue, '1' as FixtureValue, '$').ok).toBe(false); // type mismatch
    expect(compareValue(null as unknown as FixtureValue, 0 as FixtureValue, '$').ok).toBe(false);
  });

  it('strict equality for 1 vs 1.0 at runtime — YAML ints and JSON numbers are already identical', () => {
    // Both parse to JS number 1; compareValue uses ===. If ever broken, YAML
    // or JSON.stringify drift would surface as integer-vs-float divergence.
    expect(compareValue(1 as FixtureValue, 1.0 as FixtureValue, '$').ok).toBe(true);
  });
});

describe('compareValue — objects', () => {
  it('ignores key order', () => {
    const exp = { a: 1, b: 2 } as unknown as FixtureValue;
    const act = { b: 2, a: 1 } as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(true);
  });

  it('reports key-set mismatch', () => {
    const exp = { a: 1, b: 2 } as unknown as FixtureValue;
    const act = { a: 1 } as unknown as FixtureValue;
    const diff = compareValue(exp, act, '$');
    expect(diff.ok).toBe(false);
    expect(diff.issues[0]).toMatch(/key sets differ/);
  });

  it('treats undefined values as absent on both sides (symmetric)', () => {
    // YAML cannot express undefined, but openapi-generator's FromJSON populates
    // optional fields with `undefined`. Both directions must agree.
    const withKey = { a: 1, b: undefined } as unknown as FixtureValue;
    const withoutKey = { a: 1 } as unknown as FixtureValue;
    expect(compareValue(withKey, withoutKey, '$').ok).toBe(true);
    expect(compareValue(withoutKey, withKey, '$').ok).toBe(true);
  });

  it('reports nested mismatches with deep path', () => {
    const exp = { a: { b: { c: 1 } } } as unknown as FixtureValue;
    const act = { a: { b: { c: 2 } } } as unknown as FixtureValue;
    const diff = compareValue(exp, act, '$');
    expect(diff.ok).toBe(false);
    expect(diff.issues[0]).toMatch(/\$\.a\.b\.c/);
  });
});

describe('compareValue — arrays', () => {
  it('compares by index', () => {
    expect(compareValue([1, 2] as FixtureValue, [1, 2] as FixtureValue, '$').ok).toBe(true);
    expect(compareValue([1, 2] as FixtureValue, [2, 1] as FixtureValue, '$').ok).toBe(false);
  });

  it('reports length mismatch', () => {
    const diff = compareValue([1, 2] as FixtureValue, [1] as FixtureValue, '$');
    expect(diff.ok).toBe(false);
    expect(diff.issues[0]).toMatch(/length/);
  });

  it('rejects object-vs-array', () => {
    expect(compareValue({} as unknown as FixtureValue, [] as FixtureValue, '$').ok).toBe(false);
    expect(compareValue([] as FixtureValue, {} as unknown as FixtureValue, '$').ok).toBe(false);
  });
});

describe('compareValue — token-aware string positions', () => {
  it('honours tokens on string leaves', () => {
    const exp = { id: '<uuid>', name: 'fixed' } as unknown as FixtureValue;
    const act = {
      id: '01936fb1-7bb3-7000-8000-000000000001',
      name: 'fixed',
    } as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(true);
  });

  it('rejects a non-matching actual against a token', () => {
    const exp = { id: '<uuid>' } as unknown as FixtureValue;
    const act = { id: 'not-a-uuid' } as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(false);
  });
});

describe('compareValue — Date coercion (T16)', () => {
  // openapi-generator FromJSON helpers emit `Date` objects for ISO-8601
  // wire fields. YAML cannot express Date — fixtures author them as
  // quoted ISO strings. The comparator coerces `instanceof Date` to its
  // ISO string before comparison so the typeof check matches.
  it('treats a Date actual as equal to its ISO string expected', () => {
    const exp = '2026-04-26T13:00:00.000Z' as unknown as FixtureValue;
    const act = new Date('2026-04-26T13:00:00.000Z') as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(true);
  });

  it('treats nested Date actuals consistently', () => {
    const exp = {
      createdAt: '2026-04-26T13:00:00.000Z',
      updatedAt: '2026-04-26T13:05:00.000Z',
    } as unknown as FixtureValue;
    const act = {
      createdAt: new Date('2026-04-26T13:00:00.000Z'),
      updatedAt: new Date('2026-04-26T13:05:00.000Z'),
    } as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(true);
  });

  it('fails when the Date actual does not match the expected ISO string', () => {
    const exp = '2026-04-26T13:00:00.000Z' as unknown as FixtureValue;
    const act = new Date('2026-05-01T00:00:00.000Z') as unknown as FixtureValue;
    expect(compareValue(exp, act, '$').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareRequests — request-level diffs
// ---------------------------------------------------------------------------

describe('compareRequests — method, path, query, headers', () => {
  it('passes when captured matches expected', () => {
    expect(compareRequests([req({ method: 'GET', path: '/a' })], [captured({ method: 'GET', path: '/a' })]).ok).toBe(true);
  });

  it('fails when method differs', () => {
    const diff = compareRequests([req({ method: 'GET', path: '/a' })], [captured({ method: 'POST', path: '/a' })]);
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('.method'))).toBe(true);
  });

  it('fails when path segment differs', () => {
    const diff = compareRequests([req({ path: '/a' })], [captured({ path: '/b' })]);
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('.path'))).toBe(true);
  });

  it('fails when declared header is missing', () => {
    const diff = compareRequests(
      [req({ path: '/a', headers: { authorization: 'Bearer x' } })],
      [captured({ path: '/a' })],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('.headers.authorization'))).toBe(true);
  });

  it('fails when declared header value differs', () => {
    const diff = compareRequests(
      [req({ path: '/a', headers: { authorization: 'Bearer x' } })],
      [captured({ path: '/a', headers: { authorization: 'Bearer y' } })],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('.headers.authorization'))).toBe(true);
  });

  it('ignores extra captured headers not declared in fixture', () => {
    const diff = compareRequests(
      [req({ path: '/a', headers: { authorization: 'Bearer x' } })],
      [captured({ path: '/a', headers: { authorization: 'Bearer x', 'x-extra': 'ignored' } })],
    );
    expect(diff.ok).toBe(true);
  });

  it('fails when request counts differ', () => {
    const diff = compareRequests([req(), req()], [captured()]);
    expect(diff.ok).toBe(false);
    expect(diff.issues[0]).toMatch(/expected 2 request\(s\), captured 1/);
  });

  it('treats omitted expected.body as "expect empty" — an added body must fail', () => {
    // Regression guard: if a SDK that previously sent no body starts sending
    // one (e.g. a refactor adds a "keepalive" JSON), parity must catch it.
    const diff = compareRequests(
      [req({ method: 'GET', path: '/x' })], // no body
      [
        captured({
          method: 'GET',
          path: '/x',
          body: { type: 'json', value: { sneaky: 'payload' } },
        }),
      ],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('.body'))).toBe(true);
  });
});

describe('compareRequests — absolute URLs (presigned S3)', () => {
  it('compares absolute expected path against captured url (host-sensitive)', () => {
    const diff = compareRequests(
      [req({ method: 'PUT', path: 'https://s3.example.test/upload?part=2' })],
      [
        captured({
          method: 'PUT',
          url: 'https://s3.example.test/upload?part=2',
          path: '/upload',
          query: { part: ['2'] },
        }),
      ],
    );
    expect(diff.ok).toBe(true);
  });

  it('rejects a different host even if path matches', () => {
    const diff = compareRequests(
      [req({ method: 'PUT', path: 'https://s3.example.test/upload' })],
      [captured({ method: 'PUT', url: 'https://evil.example.test/upload', path: '/upload' })],
    );
    expect(diff.ok).toBe(false);
  });
});

describe('compareRequests — multipart bodies', () => {
  it('matches unordered parts by name', () => {
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'file', content: { kind: 'text', value: 'abc' } },
              { name: 'filename', content: { kind: 'text', value: 'x.txt' } },
            ],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              // captured in reverse order — unordered match must still pass
              { name: 'filename', text: 'x.txt' },
              { name: 'file', text: 'abc' },
            ],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(true);
  });

  it('fails when a declared part is missing from the captured body', () => {
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'file', content: { kind: 'text', value: 'abc' } },
              { name: 'filename', content: { kind: 'text', value: 'x.txt' } },
            ],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [{ name: 'file', text: 'abc' }],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('multipart parts'))).toBe(true);
  });

  it('passes duplicate part names paired by position', () => {
    // Repeated names (legal in multipart form). Captured order matches
    // expected order; each name index is compared to its counterpart.
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'files[]', content: { kind: 'text', value: 'a' } },
              { name: 'files[]', content: { kind: 'text', value: 'b' } },
              { name: 'meta', content: { kind: 'text', value: 'm' } },
            ],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'files[]', text: 'a' },
              { name: 'files[]', text: 'b' },
              { name: 'meta', text: 'm' },
            ],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(true);
  });

  it('fails when captured count for a duplicate name is wrong (multiset arity)', () => {
    // Fixture declares files[] x2, captured has files[] x1 — must fail even
    // though the unique name-set is the same.
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'files[]', content: { kind: 'text', value: 'a' } },
              { name: 'files[]', content: { kind: 'text', value: 'b' } },
            ],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [{ name: 'files[]', text: 'a' }],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('multipart parts'))).toBe(true);
  });

  it('reports duplicate-name mismatches with [idx] in the diff path', () => {
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'files[]', content: { kind: 'text', value: 'a' } },
              { name: 'files[]', content: { kind: 'text', value: 'DIFFERS' } },
            ],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [
              { name: 'files[]', text: 'a' },
              { name: 'files[]', text: 'b' },
            ],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(false);
    expect(diff.issues.some((s) => s.includes('files[][1]'))).toBe(true);
  });

  it('fails when a part value differs', () => {
    const diff = compareRequests(
      [
        req({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [{ name: 'size', content: { kind: 'text', value: '100' } }],
          },
        }),
      ],
      [
        captured({
          method: 'POST',
          path: '/u',
          body: {
            type: 'multipart',
            parts: [{ name: 'size', text: '200' }],
          },
        }),
      ],
    );
    expect(diff.ok).toBe(false);
  });
});
