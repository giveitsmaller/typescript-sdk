import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { resolveParityFixturesDir } from './_fixture-paths.js';
import { validateFixture } from './fixtures.js';

/**
 * cEUWPgKW: the loader enforces the two rules fixture.schema.json pins that it
 * used to skip. Each case mutates a REAL fixture that first validates cleanly.
 */
const dir = resolveParityFixturesDir();
const load = (stem: string): Record<string, unknown> =>
  parseYaml(readFileSync(resolve(dir, `${stem}.yaml`), 'utf-8')) as Record<string, unknown>;
const pathOf = (stem: string): string => resolve(dir, `${stem}.yaml`);

describe('parity loader matches fixture.schema.json', () => {
  it('loads the unmutated fixtures', () => {
    for (const stem of ['ff_files_submit_multi_compress', 'ff_lowering_output_resize_format_change']) {
      expect(() => validateFixture(load(stem), pathOf(stem))).not.toThrow();
    }
  });

  it('rejects a files-submit fixture without a response', () => {
    const stem = 'ff_files_submit_multi_compress';
    expect(() => validateFixture({ ...load(stem), responses: [] }, pathOf(stem))).toThrow(
      /submit variant requires at least one response/,
    );
  });

  it('rejects a bad fit on any op, not only resize/output (codex 8596b2f8b286)', () => {
    const stem = 'ff_lowering_output_resize_format_change';
    const raw = load(stem);
    const lowering = raw.lowering as { operations: Array<Record<string, unknown>> };
    const operations = [...lowering.operations, { op: 'convert', format: 'png', fit: 'bogus' }];
    expect(() => validateFixture({ ...raw, lowering: { ...lowering, operations } }, pathOf(stem))).toThrow(
      /convert 'fit' must be one of max\|crop\|scale/,
    );
  });

  it('rejects an unknown fit', () => {
    const stem = 'ff_lowering_output_resize_format_change';
    const raw = load(stem);
    const lowering = raw.lowering as { operations: Array<Record<string, unknown>> };
    const operations = lowering.operations.map((op) => (op.op === 'resize' ? { ...op, fit: 'stretch' } : op));
    expect(() => validateFixture({ ...raw, lowering: { ...lowering, operations } }, pathOf(stem))).toThrow(
      /resize 'fit' must be one of max\|crop\|scale/,
    );
  });
});
