import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * u6Q9oxuI — the gate that stops a NEW unwrapped deserialiser call site.
 *
 * The error-taxonomy gate enumerates the `GislError` classes we define, not the
 * errors that can escape, so it could never see a raw `TypeError` thrown by a
 * generated `FromJSON` on a malformed 2xx. This test enumerates the other
 * population: every place in the hand-written source that CALLS a
 * deserialiser. Each must be one of the reviewed sites below; a new one fails
 * here until it is routed through `readContractBody` (client.ts) or added to the
 * list with a reason.
 *
 * Passing a deserialiser by REFERENCE (`deserialize: FooFromJSON,`,
 * `readContractBody(FooFromJSON, …)`, `tryThrowStructured(FooFromJSON, …)`) is
 * not a call and is not matched — the shared path is what calls it.
 *
 * ⚠️ AUTHORING SOURCES ONLY: `src/generated/` is vendored contract code and
 * `dist/` is compiled output of the same source.
 */

const TS_SRC = resolve(__dirname, '../../src');

/** A call of a generated deserialiser, or of the shared `deserialize` hook. */
const CALL = /\b(?:\w+FromJSON(?:Typed)?|deserialize)\s*\(/;

/**
 * Reviewed call sites, as `file :: exact code line`. Exact lines, not files:
 * a file-level exemption would let a second call in the same file through.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  // The one wrapper every success-body deserialiser runs through.
  ['client.ts :: return deserialize(raw);', 'readContractBody — the wrapper itself'],
  // SSE progress is advisory; a malformed frame must degrade to polling, not
  // fail the wait. See the comment at the call site.
  [
    'builder.ts :: const data = SseOperationProgressDataFromJSON(event.data) as SseOperationProgressData;',
    'SSE progress frame — deliberately not a contract error',
  ],
]);

function codeOf(line: string): string {
  const i = line.indexOf('//');
  return (i === -1 ? line : line.slice(0, i)).trim();
}

function isComment(trimmed: string): boolean {
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'generated' && dir === root) continue;
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Every deserialiser call line in `text`, keyed `file :: code`. */
function deserialiserCalls(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (isComment(trimmed)) continue;
    const code = codeOf(trimmed);
    if (CALL.test(code)) hits.push(`${file} :: ${code}`);
  }
  return hits;
}

function allCalls(): string[] {
  return sourceFiles(TS_SRC).flatMap((f) =>
    deserialiserCalls(relative(TS_SRC, f), readFileSync(f, 'utf8')),
  );
}

describe('response-contract gate (u6Q9oxuI)', () => {
  it('every deserialiser call in src/ is a reviewed, wrapped site', () => {
    const unreviewed = allCalls().filter((c) => !ALLOWED.has(c));
    expect(unreviewed, 'route new calls through readContractBody (client.ts)').toEqual([]);
  });

  it('every allow-listed site still exists (no stale exemptions)', () => {
    const calls = allCalls();
    for (const site of ALLOWED.keys()) {
      expect(calls.filter((c) => c === site), site).toHaveLength(1);
    }
  });

  // Positive control: the matcher must be able to FIRE, or a green run proves
  // nothing. The first line is exactly the bug this card fixed.
  it('the matcher flags a direct call and ignores a by-reference pass', () => {
    const flagged = deserialiserCalls(
      'x.ts',
      [
        '    const data = OperationsSchemaResponseFromJSON(raw);',
        '    const t = FooFromJSONTyped(raw, false);',
        '    return deserialize (raw);',
        '      deserialize: WorkflowStatusResponseFromJSON,',
        '    const data = readContractBody(OperationsSchemaResponseFromJSON, raw, path);',
        '    // OperationsSchemaResponseFromJSON(raw) in a comment',
        '     * FooFromJSON(raw) in a docblock',
      ].join('\n'),
    );
    expect(flagged).toEqual([
      'x.ts :: const data = OperationsSchemaResponseFromJSON(raw);',
      'x.ts :: const t = FooFromJSONTyped(raw, false);',
      'x.ts :: return deserialize (raw);',
    ]);
  });
});
