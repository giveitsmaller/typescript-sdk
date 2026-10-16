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

  describe('Exozpn36 error-subclass fields fail at load, never silently no-op', () => {
    const stem = 'error_422_upload_size_exceeds_tier';

    it('loads the unmutated fixture with all three fields', () => {
      const fixture = validateFixture(load(stem), pathOf(stem));
      expect(fixture.expected_error_class).toBe('GislUploadCapExceededError');
      expect(fixture.expected_error_kind).toBe('size_tier');
      expect(fixture.expected_payload_fields).toMatchObject({ current_tier: 'free' });
    });

    it.each(['expected_error_class', 'expected_error_kind', 'expected_payload_fields'])(
      'rejects %s without expects_error: true',
      (key) => {
        const {
          expected_error_message: _message,
          expected_error_class: _class,
          expected_error_kind: _kind,
          expected_payload_fields: _fields,
          ...raw
        } = load(stem);
        const onlyThisKey = { ...raw, expects_error: false, [key]: load(stem)[key] };
        expect(() => validateFixture(onlyThisKey, pathOf(stem))).toThrow(
          new RegExp(`${key} requires expects_error: true`),
        );
      },
    );

    it('rejects a class name that is not an SDK error class', () => {
      expect(() =>
        validateFixture({ ...load(stem), expected_error_class: 'TierRestrictedError' }, pathOf(stem)),
      ).toThrow(/expected_error_class must be an SDK error class name/);
    });

    it('rejects an empty or non-scalar payload-field map', () => {
      expect(() => validateFixture({ ...load(stem), expected_payload_fields: {} }, pathOf(stem))).toThrow(
        /expected_payload_fields must be a non-empty map/,
      );
      expect(() =>
        validateFixture({ ...load(stem), expected_payload_fields: { current_tier: ['free'] } }, pathOf(stem)),
      ).toThrow(/expected_payload_fields\.current_tier must be a scalar/);
    });
  });

  describe('DflFw0j1 split: last op only, never in files mode or a watermark block, options required', () => {
    const SPLIT = { op: 'split', options: { mode: 'page_range', page_range: '1' } };
    type Ops = Array<Record<string, unknown>>;
    // Rebuild `raw[block]` with its `operations` replaced, leaving every other key intact.
    const withOps = (stem: string, block: string, edit: (ops: Ops) => Ops): Record<string, unknown> => {
      const raw = load(stem);
      const spec = raw[block] as { operations: Ops };
      return { ...raw, [block]: { ...spec, operations: edit(spec.operations) } };
    };

    it('loads the unmutated split fixtures', () => {
      for (const stem of [
        'ff_lowering_split_pdf_page_groups',
        'ff_run_split_pdf_page_index',
        'ff_submit_split_pdf_page_groups',
      ]) {
        expect(() => validateFixture(load(stem), pathOf(stem))).not.toThrow();
      }
    });

    it('rejects split in files mode', () => {
      const stem = 'ff_files_lowering_multi_compress';
      expect(() => validateFixture(withOps(stem, 'files', (ops) => [...ops, SPLIT]), pathOf(stem))).toThrow(
        /operations\[1\]\.op 'split' is not valid in files mode/,
      );
    });

    it('rejects split in watermark overlay ops', () => {
      const stem = 'ff_lowering_image_watermark_overlay';
      const raw = load(stem);
      const lowering = raw.lowering as { watermark: { overlay: Record<string, unknown> } };
      const watermark = { ...lowering.watermark, overlay: { ...lowering.watermark.overlay, operations: [SPLIT] } };
      expect(() => validateFixture({ ...raw, lowering: { ...lowering, watermark } }, pathOf(stem))).toThrow(
        /\[0\]\.op 'split' is not valid in a watermark block/,
      );
    });

    it('rejects split together with a watermark block', () => {
      const stem = 'ff_lowering_image_watermark_overlay';
      expect(() => validateFixture(withOps(stem, 'lowering', () => [SPLIT]), pathOf(stem))).toThrow(
        /operations\[0\]\.op 'split' cannot be combined with a watermark block/,
      );
    });

    it.each([
      ['lowering', 'ff_lowering_split_pdf_page_groups'],
      ['run', 'ff_run_split_pdf_page_index'],
      ['submit', 'ff_submit_split_pdf_page_groups'],
    ])('rejects split that is not the last op (%s)', (block, stem) => {
      const raw = withOps(stem, block, (ops) => [...ops, { op: 'compress' }]);
      const splitAt = (raw[block] as { operations: Ops }).operations.findIndex((op) => op.op === 'split');
      expect(() => validateFixture(raw, pathOf(stem))).toThrow(
        new RegExp(`operations\\[${splitAt}\\]\\.op 'split' must be the LAST op`),
      );
    });

    it.each([
      ['no options key', (op: Record<string, unknown>) => { const { options: _options, ...rest } = op; return rest; }],
      ['an empty options mapping', (op: Record<string, unknown>) => ({ ...op, options: {} })],
    ])('rejects a split op with %s', (_label, edit) => {
      const stem = 'ff_lowering_split_pdf_page_groups';
      const raw = withOps(stem, 'lowering', (ops) => ops.map((op) => (op.op === 'split' ? edit(op) : op)));
      expect(() => validateFixture(raw, pathOf(stem))).toThrow(/split requires a non-empty 'options' mapping/);
    });
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
