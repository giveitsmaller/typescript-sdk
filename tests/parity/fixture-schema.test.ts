import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { PARITY_SCHEMA_PATH, resolveParityFixturesDir } from './_fixture-paths.js';

/**
 * cEUWPgKW: every parity fixture validates against tests/parity/fixture.schema.json.
 *
 * The loaders in both SDKs hand-validate the shapes they read, but nothing held
 * the fixtures to the published JSON Schema itself, so the schema and the
 * fixtures could drift apart silently. This is that gate, in the TS suite CI
 * already runs.
 */
const schema = JSON.parse(readFileSync(PARITY_SCHEMA_PATH, 'utf-8')) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const dir = resolveParityFixturesDir();
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  .sort();

describe('parity fixtures conform to fixture.schema.json', () => {
  it('finds the fixtures (a zero count would pass every case below vacuously)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files)('%s', (file) => {
    const fixture: unknown = parseYaml(readFileSync(resolve(dir, file), 'utf-8'));
    const ok = validate(fixture);
    expect(ok, ajv.errorsText(validate.errors, { separator: '\n' })).toBe(true);
  });

  const load = (name: string): Record<string, unknown> =>
    parseYaml(readFileSync(resolve(dir, name), 'utf-8')) as Record<string, unknown>;

  it('rejects a files SUBMIT fixture that asserts no request', () => {
    const submit = load('ff_files_submit_multi_compress.yaml');
    expect(validate({ ...submit, requests: [], responses: [] })).toBe(false);
  });

  it('rejects a files SUBMIT fixture without expected_return, or carrying a merge block', () => {
    const submit = load('ff_files_submit_multi_compress.yaml');
    const { expected_return: _dropped, ...noReturn } = submit;
    expect(validate(noReturn)).toBe(false);
    const files = submit.files as Record<string, unknown>;
    expect(validate({ ...submit, files: { ...files, merge: {} } })).toBe(false);
  });

  it('rejects a files RUN fixture carrying a merge block, and an empty run/submit chain (codex 701e4d05332f, ef4feb1fb8b4)', () => {
    const run = load('ff_files_run_multi_compress_poll.yaml');
    const runFiles = run.files as Record<string, unknown>;
    expect(validate(run)).toBe(true);
    expect(validate({ ...run, files: { ...runFiles, merge: {} } })).toBe(false);
    expect(validate({ ...run, files: { ...runFiles, operations: [] } })).toBe(false);
    const submit = load('ff_files_submit_multi_compress.yaml');
    const submitFiles = submit.files as Record<string, unknown>;
    expect(validate({ ...submit, files: { ...submitFiles, operations: [] } })).toBe(false);
    expect(validate({ ...submit, responses: [] })).toBe(false);
  });

  it('holds a submit block to request_response + sdk.method=file + v2 (codex 2bfc2a391c4d)', () => {
    const submit = load('ff_submit_single_compress.yaml');
    expect(validate(submit)).toBe(true);
    expect(validate({ ...submit, sdk: { method: 'files' } })).toBe(false);
    expect(validate({ ...submit, mode: 'run' })).toBe(false);
    expect(validate({ ...submit, fixtureSchemaVersion: '1.0.0' })).toBe(false);
    const { submit: _dropped, ...noSubmit } = submit;
    expect(validate(noSubmit)).toBe(false);
  });

  it('rejects an op the loaders do not know', () => {
    const lowering = load('ff_lowering_output_same_format.yaml');
    const block = lowering.lowering as Record<string, unknown>;
    expect(validate({ ...lowering, lowering: { ...block, operations: [{ op: 'sharpen' }] } })).toBe(false);
  });

  it.each(['cf_lowering_payload_mismatch', 'cf_run_result_mismatch'])(
    'conformance fixture %s is well-formed (only its expected VALUE is wrong)',
    (stem) => {
      const file = resolve(dir, '../../parity-conformance/fixtures', `${stem}.yaml`);
      const ok = validate(parseYaml(readFileSync(file, 'utf-8')));
      expect(ok, ajv.errorsText(validate.errors, { separator: '\n' })).toBe(true);
    },
  );

  it('rejects a fixture with an unknown top-level key (the gate can fail)', () => {
    const first: unknown = parseYaml(readFileSync(resolve(dir, files[0]), 'utf-8'));
    expect(validate({ ...(first as Record<string, unknown>), notAFixtureField: true })).toBe(false);
  });
});
