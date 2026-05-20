/**
 * Drift sentinel for ticket `2hMemNSN`.
 *
 * Scans every `*.test.ts` file in `tests/unit/` for `recommended_chunk_size:`
 * literals and asserts each one is in the contract-valid range
 * `[MULTIPART_CHUNK_SIZE, RECOMMENDED_CHUNK_SIZE_MAX_BYTES]`. Catches the
 * exact regression mode that produced this ticket: SDK-2 (#84) bumped
 * `MULTIPART_CHUNK_SIZE` from 5 MiB to 16 MiB but the test fixtures stayed
 * at 5 MiB literals; CI never ran (admin-merge under billing block) so the
 * staleness silently shipped to `main` and only surfaced when SDK-3 work
 * touched the same files.
 *
 * If a future contracts regen raises the floor again (e.g. 16 MiB -> 32 MiB
 * for some yet-unidentified Enterprise capacity bump), this test fails
 * loudly on the first `npm test` against the regenerated `dist` — no quiet
 * dist-vs-test staleness window.
 *
 * Scope: `tests/unit/*.test.ts` AND `tests/parity/fixtures/*.yaml`. The
 * parity YAMLs ship literals that the PHP-side parity runner skips when
 * they're below the 16 MiB floor (CON-1/ADR-0011 silent-skip pattern); the
 * sentinel catches the same drift class there too. Each intentionally-
 * stale parity fixture must carry a `drift-allow: <reason>` line within
 * 3 lines of the literal — without that, the fixture is reported as
 * drift. The repo has no `tests/integration/` today; the integration tier
 * is one `readdirSync` away if it grows.
 *
 * Implementation note: this is a STRING scan, not an AST scan. Tests that
 * compute their fixture chunk size from a variable (e.g.
 * `recommended_chunk_size: CHUNK,` where `CHUNK = 16 * 1024 * 1024`) are
 * skipped — the literal hunt only catches inline numbers. That's deliberate:
 * variable-based fixtures are already drift-resistant; the trap is the
 * hand-rolled inline literal. Same family as `contract-drift.test.ts` /
 * `contract-drift-fields.test.ts` / `asyncapi-named-enums.test.ts` —
 * regex-over-source string scans, not AST. AST would pull in
 * `@typescript-eslint/parser` or `ts-morph` just for one test.
 *
 * Allow-list directive: tests / fixtures that DELIBERATELY set an out-of-
 * range value to verify the SDK rejects it (or to pin a documented-skip
 * fixture) can annotate the line (or any line within 5 lines above it)
 * with `// drift-allow: <reason>` (or `# drift-allow: <reason>` in YAML).
 * The non-empty reason is required by the regex `drift-allow:\s*\S` — a
 * bare `drift-allow:` does NOT silence the check. Pattern mirrors
 * ESLint's `// eslint-disable-next-line <rule> -- <reason>` directive
 * style. The 5-line window accommodates multi-line YAML / JSDoc comments
 * above the literal.
 *
 * Negative-side: this test fires only on out-of-range literals. A test that
 * sets `recommended_chunk_size: 16 * 1024 * 1024 - 1` (below the floor) is
 * caught; a test that sets it to a contract-valid but semantically-wrong
 * value (e.g. fixture intent is the 32 MiB plan but literal says 16 MiB)
 * is NOT caught here — that's behavioural drift, out of scope.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  UploadThresholdsMultipartChunkSizeEnum,
} from '@giveitsmaller/contracts/openapi';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/unit -> packages/typescript/tests -> packages/typescript -> packages -> sdks repo root.
const SDKS_REPO_ROOT = resolve(TEST_DIR, '..', '..', '..', '..');
const PARITY_FIXTURES_DIR = resolve(SDKS_REPO_ROOT, 'tests', 'parity', 'fixtures');
const RECOMMENDED_CHUNK_SIZE_MAX_BYTES = 104_857_600; // 100 MiB
const MULTIPART_CHUNK_SIZE_MIN =
  UploadThresholdsMultipartChunkSizeEnum.NUMBER_16777216;

/**
 * Best-effort literal evaluator. Handles the three patterns seen in this
 * repo's test fixtures:
 *   - bare decimal:  `5242880`
 *   - underscore separator: `5_242_880`
 *   - multiplication chain: `5 * 1024 * 1024` (also accepts trailing `+ N`)
 *
 * Returns `null` if the expression is anything else (variable reference,
 * function call, etc.) — caller skips those.
 */
export function tryEvalLiteral(expr: string): number | null {
  const trimmed = expr.trim();
  // Plain integer (with optional underscores).
  if (/^[0-9_]+$/.test(trimmed)) {
    const n = Number(trimmed.replace(/_/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  // Multiplication / addition / subtraction chain of integer literals
  // only. Input is gated by the `[\s0-9_+\-*]+` regex below, so
  // `new Function` cannot execute identifiers, calls, or any
  // non-arithmetic construct — the class of strings reaching the
  // constructor is closed under integer arithmetic. Subtraction is
  // included so the documented `16 * 1024 * 1024 - 1` "deliberately one
  // byte below minimum" pattern is caught instead of silently skipped
  // (codex review).
  if (/^[\s0-9_+\-*]+$/.test(trimmed)) {
    // `new Function` construction is itself inside the try so a malformed
    // arithmetic like `16 * 1024 *` (gate-passing but parse-failing) raises
    // SyntaxError at constructor time and we still return null per contract
    // (codex review R2: outside-try construction would propagate the
    // SyntaxError to the caller, breaking the documented null fallback).
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(`return (${trimmed.replace(/_/g, '')});`);
      const result = fn() as unknown;
      return typeof result === 'number' && Number.isFinite(result)
        ? result
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface DriftHit {
  file: string;
  lineNumber: number;
  expr: string;
  value: number;
  reason: 'below_min' | 'above_max';
}

function scanFixture(filePath: string): DriftHit[] {
  const hits: DriftHit[] = [];
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  // Patterns matched: `recommended_chunk_size: <expr>` (snake_case wire
  // shape used inside JSON-fixture builders) AND
  // `recommendedChunkSize: <expr>` (camelCase TS surface).
  const pattern = /\brecommended(?:_chunk_size|ChunkSize):\s*([^,}\n;]+)/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    // Trim trailing comments. JS-source uses `//`; YAML uses `#` —
    // strip both so a YAML literal annotated as
    // `recommended_chunk_size: 5242880 # reason` doesn't get treated as
    // unparseable by the literal evaluator and silently skipped (codex
    // review R2). Order matters: `//` first so it doesn't shadow a `#`
    // inside a JS string literal (unlikely in fixtures but defensive).
    const commentSplit = filePath.endsWith('.yaml') || filePath.endsWith('.yml')
      ? match[1].split('#')[0]
      : match[1].split('//')[0];
    const exprText = commentSplit.trim().replace(/,$/, '');
    const value = tryEvalLiteral(exprText);
    if (value === null) continue; // variable reference or unparseable

    // Allow tests that DELIBERATELY set an out-of-range value to verify
    // the SDK rejects it. The test author annotates the line (or any
    // line within 5 lines above) with `drift-allow: <reason>` so the
    // scanner skips it. The annotation MUST cite a non-empty reason
    // (regex `\bdrift-allow:\s*\S`) to avoid becoming a silent universal
    // allowlist. 5-line window accommodates multi-line YAML/JSDoc
    // comments above the literal.
    const allowWindow = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    if (/\bdrift-allow:\s*\S/i.test(allowWindow)) continue;

    if (value < MULTIPART_CHUNK_SIZE_MIN) {
      hits.push({
        file: filePath,
        lineNumber: i + 1,
        expr: exprText,
        value,
        reason: 'below_min',
      });
    } else if (value > RECOMMENDED_CHUNK_SIZE_MAX_BYTES) {
      hits.push({
        file: filePath,
        lineNumber: i + 1,
        expr: exprText,
        value,
        reason: 'above_max',
      });
    }
  }
  return hits;
}

describe('test-fixture chunk-size drift sentinel (2hMemNSN)', () => {
  it('every recommended_chunk_size literal in tests/unit/ + tests/parity/fixtures/ is in the contract range', () => {
    const unitFiles = readdirSync(TEST_DIR)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => resolve(TEST_DIR, name));

    // Parity-fixture YAMLs at repo-root `tests/parity/fixtures/` carry
    // `recommended_chunk_size:` literals too. Walk them as well so a
    // future regen-shift doesn't re-ship the same staleness class through
    // the parity harness (which silently skips on PHP-side validation
    // today — discovered during 2hMemNSN review). Each genuinely-stale
    // fixture must annotate with `drift-allow: <reason>`.
    const parityFiles = existsSync(PARITY_FIXTURES_DIR)
      ? readdirSync(PARITY_FIXTURES_DIR)
          .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
          .map((name) => resolve(PARITY_FIXTURES_DIR, name))
      : [];

    const allHits = [...unitFiles, ...parityFiles].flatMap(scanFixture);
    if (allHits.length > 0) {
      const lines = allHits.map(
        (h) =>
          `  ${h.file}:${h.lineNumber}  ${h.reason} (got ${h.value} = ${h.expr}; ` +
          `valid range [${MULTIPART_CHUNK_SIZE_MIN}, ${RECOMMENDED_CHUNK_SIZE_MAX_BYTES}])`,
      );
      throw new Error(
        `Fixture drift detected — ${allHits.length} recommended_chunk_size literal(s) outside ` +
          `the UploadThresholds contract range. Bump them when the contract changes (this is ` +
          `exactly the SDK-2 #84 regression that produced ticket 2hMemNSN).\n\n` +
          lines.join('\n'),
      );
    }
    expect(allHits).toEqual([]);
  });

  // Sub-tests that pin the guard's OWN behaviour. Without these a future
  // regex tweak could silently start mis-evaluating identifiers or
  // silently universal-allow `drift-allow:` (no reason), exactly the
  // failure modes the test-reviewer flagged at 2hMemNSN review.
  it('tryEvalLiteral skips variable-bound and string-quoted forms (closed under integer arithmetic)', () => {
    // Variable identifiers / non-numeric forms must return null so the
    // scanner skips them. If a future change loosens the gate, this
    // assertion is the trip-wire.
    expect(tryEvalLiteral('CHUNK')).toBeNull();
    expect(tryEvalLiteral('5 * 1024 * KB')).toBeNull();
    expect(tryEvalLiteral('"5242880"')).toBeNull();
    expect(tryEvalLiteral('Math.pow(2, 24)')).toBeNull();
    // Malformed arithmetic that passes the regex gate but parses to a
    // SyntaxError must return null per contract, NOT propagate (codex R2).
    expect(tryEvalLiteral('16 * 1024 *')).toBeNull();
    expect(tryEvalLiteral('* 16')).toBeNull();
    // Valid arithmetic still parses.
    expect(tryEvalLiteral('16 * 1024 * 1024')).toBe(16 * 1024 * 1024);
    expect(tryEvalLiteral('16_777_216')).toBe(16 * 1024 * 1024);
    expect(tryEvalLiteral('16 * 1024 * 1024 - 1')).toBe(16 * 1024 * 1024 - 1);
  });

  it('drift-allow directive requires a non-empty reason', () => {
    // Construct synthetic source and feed it through the scanner-shape
    // contract by writing to a tmp file is overkill — instead inline the
    // regex predicate the scanner uses and verify it directly. If the
    // regex is ever loosened, this fails.
    const directiveRegex = /\bdrift-allow:\s*\S/i;
    // Rejected: bare colon, colon + whitespace only, missing colon.
    expect(directiveRegex.test('// drift-allow:')).toBe(false);
    expect(directiveRegex.test('// drift-allow: ')).toBe(false);
    expect(directiveRegex.test('// drift-allow ')).toBe(false);
    // Accepted: any non-whitespace reason after `:`.
    expect(directiveRegex.test('// drift-allow: legacy contract')).toBe(true);
    expect(directiveRegex.test('// drift-allow:x')).toBe(true);
  });

  it('UploadThresholds chunk-size minimum is exactly 16 MiB (drift guard)', () => {
    // Cross-pin against the SDK-2 client.ts drift guard. If this fails,
    // the contract's UploadThresholds minimum changed — update (a) THIS
    // literal, (b) `src/client.ts` MULTIPART_CHUNK_SIZE drift guard, AND
    // (c) every fixture literal flagged by the sibling test above. The
    // SDK-2 admin-merge regression (ticket 2hMemNSN) was exactly the
    // case of (a)+(b) bumping but (c) being missed.
    expect(MULTIPART_CHUNK_SIZE_MIN).toBe(16 * 1024 * 1024);
  });
});
