/**
 * Contract-drift guard: every URL template used by the TypeScript SDK client
 * (`packages/typescript/src/client.ts`) must appear in the OpenAPI contract at
 * `compression_contracts/openapi/api.yaml`. The `/download` -> `/downloads`
 * regression (ticket 1EuHmFhc) reached staging because nothing mechanically
 * cross-checked SDK URL strings against the contract.
 *
 * Assumptions documented here so a future contributor isn't surprised:
 *
 * 1. Path parameter normalisation is symmetric. The SDK side collapses every
 *    `${...}` interpolation (both `${encodeURIComponent(x)}` and a bare `${x}`)
 *    to `{id}`; the contract side collapses every `{param}` placeholder
 *    (`{id}`, `{uploadId}`, ...) to `{id}` as well. This means the test
 *    compares path STRUCTURE, not placeholder NAMES — a contract that renames
 *    `{id}` to `{uploadId}` or `{workflowId}` will NOT false-drift.
 *    Caveat: folding all param names to `{id}` means a multi-param path like
 *    `/api/x/{a}/y/{b}` becomes `/api/x/{id}/y/{id}`, so two such paths that
 *    differ only by param name would alias. There are zero multi-param paths
 *    in the contract today (every parameterised path has exactly one param),
 *    so the fold is currently lossless for drift detection. Param-NAME drift
 *    was never catchable by this test (the SDK side already erases names).
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
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { CLIENT_SRC_PATH, resolveContractsRepoSpec } from './_contract-paths.js';

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
  // Fold every `{param}` placeholder to canonical `{id}` so the contract side
  // is symmetric with the SDK normaliser (which collapses all `${...}` to
  // `{id}`). Without this, the contract's `{uploadId}` multipart paths would
  // false-drift against the SDK-normalised `{id}`. See docblock assumption #1.
  return Object.keys(doc.paths)
    .map(p => p.replace(/\{[^}]+\}/g, '{id}'))
    .sort();
}

describe('contract drift', () => {
  it('every SDK URL template matches an OpenAPI contract path', () => {
    const clientSource = readFileSync(CLIENT_SRC_PATH, 'utf8');
    const contractYaml = readFileSync(resolveContractsRepoSpec(), 'utf8');

    const sdkPaths = extractSdkPaths(clientSource);
    const contractPaths = new Set(extractContractPaths(contractYaml));

    expect(sdkPaths.length).toBeGreaterThan(0);

    const drift = sdkPaths.filter(p => !contractPaths.has(p));
    expect(drift).toEqual([]);
  });

  it('folds contract `{uploadId}` placeholders to `{id}` (regression lock)', () => {
    // The 3 SDK-3 multipart paths use `{uploadId}` in the contract. This
    // asserts the placeholder fold in extractContractPaths is load-bearing —
    // if a future edit drops the fold, these become `{uploadId}` and the
    // primary drift test above false-fails (ticket S9WHtXre).
    const contractPaths = new Set(
      extractContractPaths(readFileSync(resolveContractsRepoSpec(), 'utf8')),
    );
    expect(contractPaths.has('/api/uploads/multipart/{id}/status')).toBe(true);
    expect(contractPaths.has('/api/uploads/multipart/{id}/presign')).toBe(true);
    expect(contractPaths.has('/api/uploads/multipart/{id}/keepalive')).toBe(true);
  });
});
