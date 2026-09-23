// Shared by the conformance suites (PMvwhNI1, XsjiXtqZ). Not a test file: importing
// a *.test.ts from another would re-register its tests there.

/**
 * The contract's availability ladder, MOST-CAUTIOUS FIRST
 * (compression_contracts schemas/availability-ladder.yaml, v2.206.0+). Pinned to
 * that file by scripts/tests/test_availability_ladder_parity.py.
 */
export const AVAILABILITY_LADDER = [
  'planned',
  'experimental',
  'beta',
  'deprecated',
  'stable_pending_audit',
  'stable',
] as const;

/**
 * PMvwhNI1: resolve a chain MOST-CAUTIOUSLY - the strictest present link wins, and
 * an absent key means `stable` at that link. This was "group key, else op key"
 * (precedence), which agreed with the contract on every real cell only by
 * coincidence: a group saying `stable` under a `planned` root resolved to
 * `stable`, and this tripwire would then have demanded the SDK un-withdraw it.
 */
export function mostCautious(...links: (string | undefined)[]): string {
  let strictest = AVAILABILITY_LADDER.length - 1;
  for (const link of links) {
    const value = link ?? 'stable';
    const rank = (AVAILABILITY_LADDER as readonly string[]).indexOf(value);
    if (rank === -1) throw new Error(`unknown availability value '${value}' - not on the contract ladder`);
    strictest = Math.min(strictest, rank);
  }
  return AVAILABILITY_LADDER[strictest]!;
}
