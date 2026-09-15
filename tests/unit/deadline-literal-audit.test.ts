import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 36AZ98FV — the default deadline must exist in exactly ONE place per language.
 *
 * The ticket's premise was that `RunOptions.maxWait` was mandatory to stop a 600s
 * default "leaking silently", while the SDK applied that exact default at fourteen
 * sites anyway — in both languages, each of which had ALREADY NAMED the number in
 * a constant and hard-coded the literal beside it regardless. Consolidating the
 * fourteen is the fix; this test is what stops the fifteenth.
 *
 * ⚠️ EXACT TOKEN, NOT SUBSTRING. `600_000` is a substring of `3_600_000`, a
 * legitimate hour conversion at `builder.ts:1271` and `MaxWait.php:62`. A naive
 * grep is red forever, and an assertion that can never pass gets "fixed" by
 * deleting it — so the matcher uses a boundary and the two permitted definitions
 * are named explicitly rather than counted.
 *
 * ⚠️ AUTHORING SOURCES ONLY. `packages/typescript/dist/` is COMMITTED (not
 * gitignored, so `file:` consumers get a dist matching src) and contains the
 * compiled literal. A repository-wide check could not allow "only two" and would
 * fail on generated output nobody hand-writes.
 */

const TS_SRC = resolve(__dirname, '../../src');
const PHP_SRC = resolve(__dirname, '../../../php/src');

/** The literal in either language's spelling, as a standalone token. */
const TOKEN = /(?<![\w_])600_?000(?![\w_])/;

/**
 * The two LINES that ARE the shared constant. Everything else is a copy.
 *
 * ⚠️ THIS USED TO BE A SET OF FILENAMES, WHICH EXEMPTED WHOLE FILES. A second
 * `600_000` anywhere in `client.ts` — or in any nested file that happened to share
 * the name — passed the gate, so it did not enforce the very invariant it is named
 * after (codex 0a77804ddf55 on PR #394). Matching the definition LINE is the
 * difference between "this file may define it" and "this file may contain it".
 */
const PERMITTED_DEFINITIONS: readonly string[] = [
  'export const DEFAULT_POLL_TIMEOUT_MS = 600_000;',
  'public const DEFAULT_POLL_TIMEOUT_MS = 600_000;',
];

/** The code on a line, with any trailing line-comment removed. */
function codeOf(line: string): string {
  const i = line.indexOf('//');
  return (i === -1 ? line : line.slice(0, i)).trim();
}

/** How many standalone copies of the literal a line carries. */
function countTokens(line: string): number {
  return (line.match(/(?<![\w_])600_?000(?![\w_])/g) ?? []).length;
}

function sourceFiles(root: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue;
        walk(full);
        continue;
      }
      if (extensions.some((e) => entry.endsWith(e))) out.push(full);
    }
  };
  walk(root);
  return out;
}

function offendingLines(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!TOKEN.test(line)) return;
        const trimmed = line.trim();

        // ⚠️ EXACT LINE, AND EXACTLY ONE TOKEN ON IT. `startsWith` let a second
        // copy ride along on the declaration itself — `export const X = 600_000;
        // // see also 600_000` passed (codex aef7f06f9085).
        // The declaration may carry a trailing `// 10 min`; a SECOND literal
        // anywhere on the line — comment included — still fails the token count.
        if (PERMITTED_DEFINITIONS.includes(codeOf(trimmed)) && countTokens(trimmed) === 1) return;

        // ⚠️ PROSE ONLY, AND ONLY IN A COMMENT. Allowing any line that MENTIONS the
        // constant let a CODE line launder a copy past the gate —
        // `const fallback = 600_000; // DEFAULT_POLL_TIMEOUT_MS` was permitted.
        const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
        if (isComment && trimmed.includes('DEFAULT_POLL_TIMEOUT_MS')) return;

        hits.push(`${file}:${i + 1}: ${trimmed}`);
      });
  }
  return hits;
}

describe('36AZ98FV — the default deadline lives in exactly one place per language', () => {
  it('no hand-written TypeScript source repeats the literal', () => {
    const hits = offendingLines(sourceFiles(TS_SRC, ['.ts']));
    expect(
      hits,
      `the default deadline must come from DEFAULT_POLL_TIMEOUT_MS, not a copy:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('no hand-written PHP source repeats the literal', () => {
    const hits = offendingLines(sourceFiles(PHP_SRC, ['.php']));
    expect(
      hits,
      `the default deadline must come from WorkflowConstants::DEFAULT_POLL_TIMEOUT_MS:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('the matcher does not fire on 3_600_000 — the positive control', () => {
    // 🔴 Without this, a matcher that had been quietly broadened to match nothing
    // would pass both tests above and look like a clean bill of health.
    expect(TOKEN.test('return n * 3_600_000;')).toBe(false);
    expect(TOKEN.test('$n * 3_600_000')).toBe(false);
    expect(TOKEN.test('maxWait ?? 600_000')).toBe(true);
    expect(TOKEN.test('(default: 600000 = 10 min)')).toBe(true);
  });

  it('a SECOND copy inside a permitted file is still caught — the exemption is per LINE', () => {
    // 🔴 The regression guard for the filename-exemption bug. Under the old
    // set-of-filenames rule every one of these passed, because the file was
    // skipped wholesale rather than the definition line being permitted.
    const permitted = (line: string): boolean =>
      PERMITTED_DEFINITIONS.includes(codeOf(line)) && countTokens(line) === 1;

    expect(permitted('export const DEFAULT_POLL_TIMEOUT_MS = 600_000;')).toBe(true);
    expect(permitted('    public const DEFAULT_POLL_TIMEOUT_MS = 600_000;')).toBe(true);
    // The real declarations carry a trailing comment; that alone must not fail them.
    expect(permitted('export const DEFAULT_POLL_TIMEOUT_MS = 600_000; // 10 min')).toBe(true);
    // A second copy in the same file, under any other name, is NOT permitted.
    expect(permitted('const SOME_OTHER_TIMEOUT = 600_000;')).toBe(false);
    expect(permitted('  return 600_000;')).toBe(false);
    // 🔴 Nor a copy riding along on the permitted declaration itself.
    expect(permitted('export const DEFAULT_POLL_TIMEOUT_MS = 600_000; // also 600_000')).toBe(false);
  });

  it('a CODE line mentioning the constant cannot launder a copy past the gate', () => {
    // 🔴 The prose exemption used to accept ANY line containing the constant's
    // name, so a comment appended to a hard-coded literal bought it a pass.
    const audit = (line: string): boolean => {
      const t = line.trim();
      if (PERMITTED_DEFINITIONS.includes(codeOf(t)) && countTokens(t) === 1) return false;
      const isComment = t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
      return !(isComment && t.includes('DEFAULT_POLL_TIMEOUT_MS'));
    };
    expect(audit('const fallback = 600_000; // DEFAULT_POLL_TIMEOUT_MS')).toBe(true);
    expect(audit(' * defaults to DEFAULT_POLL_TIMEOUT_MS (600_000 ms)')).toBe(false);
  });
});
