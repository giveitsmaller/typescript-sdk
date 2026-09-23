import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { SDKS_REPO_ROOT } from './_fixture-paths.js';
import { compareValue } from './comparators.js';
import { createFetchStub, type FetchStub } from './fetch-stub.js';
import { validateFixture } from './fixtures.js';
import { lowerFixture, runRecipeFixture } from './invoke.js';

/**
 * cEUWPgKW reference conformance: fixtures under tests/parity-conformance are
 * DELIBERATELY wrong, one expected value each. The parity comparison must FAIL
 * on them and name the broken path. Without this, a comparator that silently
 * passed everything would leave the whole parity suite green.
 */
const load = (stem: string) => {
  const file = resolve(SDKS_REPO_ROOT, 'tests/parity-conformance/fixtures', `${stem}.yaml`);
  return validateFixture(parseYaml(readFileSync(file, 'utf-8')), file);
};

let stub: FetchStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('parity conformance: a wrong expectation fails, naming the path', () => {
  it('lowering: a broken expected_payload value', () => {
    const fixture = load('cf_lowering_payload_mismatch');
    const diff = compareValue(fixture.expected_payload, lowerFixture(fixture) as unknown as never, 'expected_payload');
    expect(diff.ok).toBe(false);
    expect(diff.issues.join('\n')).toMatch(/expected_payload\.jobs\[0\]\.operations\[0\]\.options\.quality/);
  });

  it('run: a broken expected_run_result value', async () => {
    const fixture = load('cf_run_result_mismatch');
    stub = createFetchStub();
    stub.install(fixture.responses, fixture.__file);
    const diff = compareValue(fixture.expected_run_result, (await runRecipeFixture(fixture)) as unknown as never, 'expected_run_result');
    expect(diff.ok).toBe(false);
    expect(diff.issues.join('\n')).toMatch(/expected_run_result\.workflowId/);
  });
});
