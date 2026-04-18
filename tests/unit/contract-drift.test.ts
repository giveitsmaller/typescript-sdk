/**
 * Contract-drift guard: every URL template used by the TypeScript SDK client
 * (`packages/typescript/src/client.ts`) must appear in the OpenAPI contract at
 * `compression_contracts/openapi/api.yaml`. The `/download` -> `/downloads`
 * regression (ticket 1EuHmFhc) reached staging because nothing mechanically
 * cross-checked SDK URL strings against the contract.
 *
 * Assumptions documented here so a future contributor isn't surprised:
 *
 * 1. Path parameter normalisation: both `${encodeURIComponent(x)}` and a bare
 *    `${x}` inside a backtick template collapse to `{id}`. The contract uses
 *    `{id}` uniformly for every single-param path. If a future contract path
 *    adopts a different placeholder (e.g. `{workflowId}`), this test will fail
 *    spuriously until the normaliser is updated.
 *
 * 2. String concatenation (`'/api/' + 'workflows'`) would bypass the regex
 *    scanner and silently pass this test. Every URL in `client.ts` today is
 *    either a plain single-quoted literal or a backtick template — add new
 *    paths the same way.
 *
 * 3. Path-only comparison. HTTP method mismatches (GET where the contract says
 *    POST, etc.) are out of scope for this test (ticket B6jFI4Ml).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// tests/unit/contract-drift.test.ts -> ../../.. = sdks repo root
const SDKS_REPO_ROOT = resolve(TEST_DIR, '../../../..');
const CLIENT_SRC_PATH = resolve(SDKS_REPO_ROOT, 'packages/typescript/src/client.ts');

const CONTRACT_PATH_CANDIDATES = [
  resolve(SDKS_REPO_ROOT, 'compression_contracts/openapi/api.yaml'),     // CI (actions/checkout with path:)
  resolve(SDKS_REPO_ROOT, '../compression_contracts/openapi/api.yaml'),  // local sibling checkout
];

function resolveContractPath(): string {
  for (const candidate of CONTRACT_PATH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate compression_contracts/openapi/api.yaml. Tried:\n` +
      CONTRACT_PATH_CANDIDATES.map(p => `  - ${p}`).join('\n') +
      `\n\nEnsure the compression_contracts repo is checked out as a sibling of ` +
      `giveitsmaller-sdks (local) or nested at the repo root (CI).`,
  );
}

function extractSdkPaths(clientSource: string): string[] {
  const paths = new Set<string>();

  // Plain single-quoted literals starting with /api/
  for (const match of clientSource.matchAll(/'(\/api\/[^']+)'/g)) {
    paths.add(match[1]);
  }

  // Backtick templates containing /api/. Normalise every ${...} to {id}.
  for (const match of clientSource.matchAll(/`(\/api\/[^`]+)`/g)) {
    paths.add(match[1].replace(/\$\{[^}]+\}/g, '{id}'));
  }

  return [...paths].sort();
}

function extractContractPaths(apiYaml: string): string[] {
  const doc = parseYaml(apiYaml) as { paths?: Record<string, unknown> };
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error('api.yaml has no paths section');
  }
  return Object.keys(doc.paths).sort();
}

describe('contract drift', () => {
  it('every SDK URL template matches an OpenAPI contract path', () => {
    const clientSource = readFileSync(CLIENT_SRC_PATH, 'utf8');
    const contractYaml = readFileSync(resolveContractPath(), 'utf8');

    const sdkPaths = extractSdkPaths(clientSource);
    const contractPaths = new Set(extractContractPaths(contractYaml));

    expect(sdkPaths.length).toBeGreaterThan(0);

    const drift = sdkPaths.filter(p => !contractPaths.has(p));
    expect(drift).toEqual([]);
  });
});
