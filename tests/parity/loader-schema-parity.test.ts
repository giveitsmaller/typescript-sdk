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
