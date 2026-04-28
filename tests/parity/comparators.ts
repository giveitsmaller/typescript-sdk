import type {
  FixtureRequest,
  FixtureValue,
  MultipartPart,
  RequestBody,
} from './fixtures.js';
import { isToken } from './fixtures.js';
import type {
  CapturedBody,
  CapturedMultipartPart,
  CapturedRequest,
} from './fetch-stub.js';
import { decodeBytesValue } from './fetch-stub.js';

export type { CapturedBody, CapturedRequest };

// ---------------------------------------------------------------------------
// Diff accumulator. A ParityDiff is the single source of truth for failure
// messages — vitest assertion error names the fixture + diff.paths so authors
// can jump straight to the offending field.
// ---------------------------------------------------------------------------

export interface ParityDiff {
  ok: boolean;
  issues: string[];
}

function passing(): ParityDiff {
  return { ok: true, issues: [] };
}

function merge(into: ParityDiff, other: ParityDiff): void {
  if (!other.ok) {
    into.ok = false;
    into.issues.push(...other.issues);
  }
}

function fail(path: string, message: string): ParityDiff {
  return { ok: false, issues: [`${path}: ${message}`] };
}

// ---------------------------------------------------------------------------
// Top-level: compare the full list of expected-vs-captured requests.
// ---------------------------------------------------------------------------

export function compareRequests(
  expected: FixtureRequest[],
  captured: CapturedRequest[],
  fixtureFile?: string,
): ParityDiff {
  const result = passing();
  if (expected.length !== captured.length) {
    return fail(
      'requests',
      `expected ${expected.length} request(s), captured ${captured.length}`,
    );
  }
  expected.forEach((exp, i) => {
    merge(result, compareRequest(exp, captured[i], `requests[${i}]`, fixtureFile));
  });
  return result;
}

function compareRequest(
  expected: FixtureRequest,
  captured: CapturedRequest,
  path: string,
  fixtureFile: string | undefined,
): ParityDiff {
  const result = passing();

  if (expected.method !== captured.method) {
    merge(result, fail(`${path}.method`, `expected ${expected.method}, got ${captured.method}`));
  }

  // Absolute URLs (presigned S3, etc.) compare against the full captured URL
  // sans query; relative paths compare against captured.path only. Lets a
  // fixture distinguish "/api/uploads" (baseUrl) from a presigned URL whose
  // host is part of the spec.
  const expPath = stripQuery(expected.path);
  const capPath = isAbsoluteUrl(expected.path) ? stripQuery(captured.url) : captured.path;
  if (!matchPath(expPath, capPath)) {
    merge(result, fail(`${path}.path`, `expected "${expPath}", got "${capPath}"`));
  }

  // Query params from the expected can come from fixture.query OR be embedded
  // in fixture.path. Normalise both.
  const expQuery = mergeQuery(parseQuery(expected.path), expected.query ?? {});
  merge(result, compareQuery(expQuery, captured.query, `${path}.query`));

  merge(result, compareHeaders(expected.headers ?? {}, captured.headers, `${path}.headers`));

  // Omitted `expected.body` means "expect no body" — assert the captured body
  // is empty. A lenient "don't care" would let a SDK regression that starts
  // sending a body on a GET/DELETE go undetected.
  const expBody: RequestBody = expected.body ?? { type: 'empty' };
  merge(result, compareBody(expBody, captured.body, `${path}.body`, fixtureFile));

  return result;
}

function stripQuery(p: string): string {
  const i = p.indexOf('?');
  return i === -1 ? p : p.slice(0, i);
}

function isAbsoluteUrl(p: string): boolean {
  return /^https?:\/\//i.test(p);
}

function parseQuery(p: string): Record<string, string[]> {
  const i = p.indexOf('?');
  if (i === -1) return {};
  // Use URLSearchParams for application/x-www-form-urlencoded semantics:
  // `+` decodes to space to match captured.query produced by URL.searchParams
  // in fetch-stub. Plain decodeURIComponent left `+` literal and caused
  // spurious parity failures for fixtures with `+` in query values.
  const out: Record<string, string[]> = {};
  const params = new URLSearchParams(p.slice(i + 1));
  for (const [k, v] of params.entries()) {
    (out[k] ??= []).push(v);
  }
  return out;
}

function mergeQuery(
  a: Record<string, string[]>,
  b: Record<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    (out[k] ??= []).push(v);
  }
  return out;
}

// Path matching allows token placeholders like /api/workflows/<uuid>/status.
function matchPath(expected: string, actual: string): boolean {
  const expSegs = expected.split('/');
  const actSegs = actual.split('/');
  if (expSegs.length !== actSegs.length) return false;
  for (let i = 0; i < expSegs.length; i++) {
    if (!matchString(expSegs[i], actSegs[i])) return false;
  }
  return true;
}

function compareQuery(
  expected: Record<string, string[]>,
  captured: Record<string, string[]>,
  path: string,
): ParityDiff {
  const result = passing();
  const expKeys = Object.keys(expected).sort();
  const capKeys = Object.keys(captured).sort();
  if (expKeys.join(',') !== capKeys.join(',')) {
    return fail(path, `expected keys [${expKeys.join(',')}], got [${capKeys.join(',')}]`);
  }
  for (const k of expKeys) {
    const expVals = [...expected[k]].sort();
    const capVals = [...captured[k]].sort();
    if (expVals.length !== capVals.length) {
      merge(result, fail(`${path}.${k}`, `expected ${expVals.length} value(s), got ${capVals.length}`));
      continue;
    }
    for (let i = 0; i < expVals.length; i++) {
      if (!matchString(expVals[i], capVals[i])) {
        merge(result, fail(`${path}.${k}[${i}]`, `expected "${expVals[i]}", got "${capVals[i]}"`));
      }
    }
  }
  return result;
}

function compareHeaders(
  expected: Record<string, string>,
  captured: Record<string, string>,
  path: string,
): ParityDiff {
  // Only assert headers that the fixture declares. Extra headers from the SDK
  // are ignored — parity cares about what the fixture says must be there.
  const result = passing();
  for (const [rawKey, expVal] of Object.entries(expected)) {
    const key = rawKey.toLowerCase();
    const capVal = captured[key];
    if (capVal === undefined) {
      merge(result, fail(`${path}.${key}`, `header missing; expected "${expVal}"`));
      continue;
    }
    if (!matchString(expVal, capVal)) {
      merge(result, fail(`${path}.${key}`, `expected "${expVal}", got "${capVal}"`));
    }
  }
  return result;
}

function compareBody(
  expected: RequestBody,
  captured: CapturedBody,
  path: string,
  fixtureFile: string | undefined,
): ParityDiff {
  if (expected.type !== captured.type) {
    return fail(path, `expected body type "${expected.type}", got "${captured.type}"`);
  }
  switch (expected.type) {
    case 'empty':
      return passing();
    case 'json':
      if (captured.type !== 'json') return fail(path, 'type mismatch');
      return compareValue(expected.value, captured.value as FixtureValue, `${path}.value`);
    case 'multipart':
      if (captured.type !== 'multipart') return fail(path, 'type mismatch');
      return compareMultipart(expected.parts, captured.parts, path, fixtureFile);
    case 'raw': {
      if (captured.type !== 'raw') return fail(path, 'type mismatch');
      const expBytes = decodeBytesValue(expected.content, fixtureFile);
      return compareBytes(expBytes, captured.bytes, `${path}.content`);
    }
    default:
      return fail(path, `unsupported body type "${(expected as { type: string }).type}"`);
  }
}

function compareMultipart(
  expected: MultipartPart[],
  captured: CapturedMultipartPart[],
  path: string,
  fixtureFile: string | undefined,
): ParityDiff {
  const result = passing();
  // Match as an unordered *multiset* keyed by name: if the same name appears
  // multiple times (legal in multipart/form-data for repeated form fields),
  // pair by position within that name. Comparing unique-name sets would hide
  // arity drift like fixture="a a b" vs captured="a b".
  const byName = new Map<string, typeof captured>();
  for (const part of captured) {
    const list = byName.get(part.name) ?? [];
    list.push(part);
    byName.set(part.name, list);
  }

  // Expected counts per name — a multiset encoded as sorted "name:count" pairs.
  const expCounts = new Map<string, number>();
  for (const p of expected) expCounts.set(p.name, (expCounts.get(p.name) ?? 0) + 1);

  const expSig = [...expCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([n, c]) => `${n}x${c}`)
    .join('|');
  const capSig = [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([n, list]) => `${n}x${list.length}`)
    .join('|');
  if (expSig !== capSig) {
    return fail(path, `expected multipart parts [${expSig}], got [${capSig}]`);
  }

  const seen = new Map<string, number>();
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const idx = seen.get(exp.name) ?? 0;
    seen.set(exp.name, idx + 1);
    const capList = byName.get(exp.name)!;
    if (!capList[idx]) {
      merge(result, fail(`${path}.${exp.name}[${idx}]`, 'captured part missing'));
      continue;
    }
    // Include [idx] in the diff path so a repeated name produces unambiguous
    // error messages ("parts.files[1].content" not "parts.files.content").
    merge(result, comparePart(exp, capList[idx], `${path}.${exp.name}[${idx}]`, fixtureFile));
  }
  return result;
}

function comparePart(
  exp: MultipartPart,
  cap: { name: string; filename?: string; contentType?: string; bytes?: Uint8Array; text?: string },
  path: string,
  fixtureFile: string | undefined,
): ParityDiff {
  const result = passing();
  if (exp.filename !== undefined) {
    if (!matchString(exp.filename, cap.filename ?? '')) {
      merge(result, fail(`${path}.filename`, `expected "${exp.filename}", got "${cap.filename ?? ''}"`));
    }
  }
  if (exp['content-type'] !== undefined) {
    const expCt = exp['content-type'];
    const capCt = cap.contentType ?? '';
    if (!matchString(expCt, capCt)) {
      merge(result, fail(`${path}.content-type`, `expected "${expCt}", got "${capCt}"`));
    }
  }
  const content = exp.content;
  switch (content.kind) {
    case 'bytes': {
      const expBytes = decodeBytesValue(content, fixtureFile);
      if (!cap.bytes) {
        merge(result, fail(`${path}.content`, 'expected bytes but captured part has none'));
        break;
      }
      merge(result, compareBytes(expBytes, cap.bytes, `${path}.content`));
      break;
    }
    case 'text':
      if (cap.text === undefined) {
        merge(result, fail(`${path}.content`, 'expected text but captured part is binary'));
      } else if (!matchString(content.value, cap.text)) {
        merge(result, fail(`${path}.content`, `expected "${content.value}", got "${cap.text}"`));
      }
      break;
    case 'json': {
      const raw = cap.text ?? (cap.bytes ? new TextDecoder().decode(cap.bytes) : undefined);
      if (raw === undefined) {
        merge(result, fail(`${path}.content`, 'expected json but captured part has no body'));
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        merge(result, fail(`${path}.content`, `expected json, failed to parse: ${raw.slice(0, 80)}`));
        break;
      }
      merge(result, compareValue(content.value, parsed as FixtureValue, `${path}.content`));
      break;
    }
    default:
      merge(
        result,
        fail(`${path}.content`, `unsupported content.kind "${(content as { kind: string }).kind}"`),
      );
  }
  return result;
}

function compareBytes(expected: Uint8Array, actual: Uint8Array, path: string): ParityDiff {
  if (expected.length !== actual.length) {
    return fail(path, `expected ${expected.length} bytes, got ${actual.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return fail(path, `byte ${i} differs (expected 0x${expected[i].toString(16)}, got 0x${actual[i].toString(16)})`);
    }
  }
  return passing();
}

// ---------------------------------------------------------------------------
// compareValue: canonical deep-equal with token awareness on STRING positions.
// Numbers, booleans, null match by strict equality. Object keys are compared
// as sets (canonical JSON has sorted keys; we just ignore key order).
// ---------------------------------------------------------------------------

export function compareValue(
  expected: FixtureValue | undefined,
  actual: FixtureValue | undefined,
  path: string,
): ParityDiff {
  if (expected === undefined && actual === undefined) return passing();
  // Date coercion: openapi-generator's FromJSON helpers emit `Date` objects
  // for ISO-8601 wire fields (e.g. `createdAt`, `expiresAt`). YAML cannot
  // express Date — fixtures author these as quoted ISO strings. Coerce
  // before the typeof check so a Date on the actual side compares cleanly
  // against a string on the expected side. Both sides treated symmetrically
  // so a fixture written with a Date literal (rare; legacy update-mode
  // output) still works.
  if (expected instanceof Date) expected = expected.toISOString() as FixtureValue;
  if (actual instanceof Date) actual = actual.toISOString() as FixtureValue;
  if (expected === null && actual === null) return passing();
  if (expected === null || actual === null) {
    return fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const expType = typeof expected;
  const actType = typeof actual;
  if (expType !== actType) {
    return fail(path, `expected ${expType}, got ${actType}`);
  }
  if (expType === 'string') {
    return matchString(expected as string, actual as string)
      ? passing()
      : fail(path, `expected "${expected}", got "${actual}"`);
  }
  if (expType === 'number' || expType === 'boolean') {
    return expected === actual
      ? passing()
      : fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return fail(path, 'expected array');
    if (expected.length !== actual.length) {
      return fail(path, `expected length ${expected.length}, got ${actual.length}`);
    }
    const result = passing();
    expected.forEach((v, i) => merge(result, compareValue(v as FixtureValue, actual[i] as FixtureValue, `${path}[${i}]`)));
    return result;
  }
  // Object
  if (Array.isArray(actual)) return fail(path, 'expected object, got array');
  const expObj = expected as { [k: string]: FixtureValue };
  const actObj = actual as { [k: string]: FixtureValue };
  // undefined values are treated as absent on both sides — YAML cannot express
  // `undefined`, but generated openapi deserializers populate optional fields
  // with `undefined` (see OperationResponseFromJSON's `progress`/`result`).
  // Comparing raw Object.keys would flag those as spurious drift.
  const expKeys = Object.keys(expObj).filter((k) => expObj[k] !== undefined).sort();
  const actKeys = Object.keys(actObj).filter((k) => actObj[k] !== undefined).sort();
  if (expKeys.join('|') !== actKeys.join('|')) {
    return fail(
      path,
      `key sets differ; expected [${expKeys.join(',')}], got [${actKeys.join(',')}]`,
    );
  }
  const result = passing();
  for (const k of expKeys) {
    merge(result, compareValue(expObj[k], actObj[k], `${path}.${k}`));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Token-aware string matcher.
// ---------------------------------------------------------------------------

export function matchString(expected: string, actual: string): boolean {
  if (!isToken(expected)) return expected === actual;
  // Token grammar must stay in sync with fixtures.ts:TOKEN_PATTERN.
  // Parametric tokens (hex, base64) use named groups; others use group 1.
  const tokenMatch =
    /^<(?:(any|string|uuid|iso8601|int|timestamp_unix|etag)|hex:(\d+)|base64:(\d+))>$/.exec(expected);
  if (!tokenMatch) return false;
  const [, kind, hexLen, base64Len] = tokenMatch;
  if (hexLen !== undefined) {
    return new RegExp(`^[0-9a-f]{${hexLen}}$`, 'i').test(actual);
  }
  if (base64Len !== undefined) {
    // Standard base64 alphabet, unpadded character count = base64Len; '=' padding
    // optional. Matches the non-URL-safe variant used by Node's Buffer.
    return new RegExp(`^[A-Za-z0-9+/]{${base64Len}}={0,2}$`).test(actual);
  }
  switch (kind) {
    case 'any':
    case 'string':
      return actual.length > 0;
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actual);
    case 'iso8601':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(actual);
    case 'int':
      return /^-?\d+$/.test(actual);
    case 'timestamp_unix':
      return /^\d{10,13}$/.test(actual);
    case 'etag':
      // RFC 7232 ETag: a quoted opaque string. Contents are arbitrary (S3
      // emits hex-MD5 + optional "-N" suffix; other stores emit arbitrary
      // opaque tokens). The token only pins the quote-wrapping invariant —
      // an SDK that strips the surrounding quotes before forwarding is a
      // real divergence, not harmless normalisation. Bare form is rejected
      // so a future runner that drops the quotes can't silently pass.
      return /^"[^"\x00-\x1f]*"$/.test(actual);
    default:
      return false;
  }
}
