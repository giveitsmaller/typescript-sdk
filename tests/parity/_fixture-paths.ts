import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/parity/_fixture-paths.ts -> ../../../.. = sdks repo root
// (up out of parity/, tests/, typescript/, packages/)
export const SDKS_REPO_ROOT = resolve(TEST_DIR, '../../../..');

const FIXTURE_DIR_CANDIDATES = [
  resolve(SDKS_REPO_ROOT, 'tests/parity/fixtures'),
];

export function resolveParityFixturesDir(): string {
  for (const candidate of FIXTURE_DIR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate tests/parity/fixtures/. Tried:\n` +
      FIXTURE_DIR_CANDIDATES.map((p) => `  - ${p}`).join('\n') +
      `\n\nEnsure you are running from the giveitsmaller-sdks repo root or a worktree of it.`,
  );
}

export const PARITY_SCHEMA_PATH = resolve(
  SDKS_REPO_ROOT,
  'tests/parity/fixture.schema.json',
);
