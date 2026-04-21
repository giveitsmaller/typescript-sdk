import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/unit/_contract-paths.ts -> ../../../.. = sdks repo root
// (up out of unit/, tests/, typescript/, packages/)
export const SDKS_REPO_ROOT = resolve(TEST_DIR, '../../../..');
export const CLIENT_SRC_PATH = resolve(SDKS_REPO_ROOT, 'packages/typescript/src/client.ts');
export const TYPES_SRC_PATH = resolve(SDKS_REPO_ROOT, 'packages/typescript/src/types.ts');

const CONTRACTS_REPO_CANDIDATES = [
  resolve(SDKS_REPO_ROOT, 'compression_contracts/openapi/api.yaml'),    // CI (actions/checkout with path:)
  resolve(SDKS_REPO_ROOT, '../compression_contracts/openapi/api.yaml'), // local sibling checkout
];

export function resolveContractsRepoSpec(): string {
  for (const candidate of CONTRACTS_REPO_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate compression_contracts/openapi/api.yaml. Tried:\n` +
      CONTRACTS_REPO_CANDIDATES.map(p => `  - ${p}`).join('\n') +
      `\n\nEnsure the compression_contracts repo is checked out as a sibling of ` +
      `giveitsmaller-sdks (local) or nested at the repo root (CI).`,
  );
}

export const GENERATED_SPEC_PATH = resolve(
  SDKS_REPO_ROOT,
  'generated/typescript/openapi/api.yaml',
);
