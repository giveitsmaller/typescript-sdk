import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * Exozpn36 — tripwires on the VENDORED contract for the `basic`/`free` tier
 * transition. Conditions, not dates.
 *
 * ⚠️ INVERSE LIFECYCLE. These PASS while the transition is open and go red
 * only when the contract changes. A red here is the signal, not a bug: read
 * the failure message, make the decision it names, then update the test in
 * the same change. Do not delete it to get green.
 */

const require = createRequire(import.meta.url);

interface Schema {
  enum?: string[];
  required?: string[];
  properties?: Record<string, Schema>;
}

const spec = parseYaml(
  readFileSync(require.resolve('@giveitsmaller/contracts/openapi/api.yaml'), 'utf8'),
) as { components: { schemas: Record<string, Schema> } };
const schemas = spec.components.schemas;

describe('UserTier basic/free transition tripwires (contract-declared)', () => {
  it('the contract still declares the deprecated `free` alias', () => {
    expect(
      schemas.UserTier?.enum,
      'The vendored contract no longer declares UserTier `free`. That is the ALIAS-REMOVAL gate ' +
        '(nD8fCPDy) reaching this repo. DECIDE before re-vendoring past it: every SDK reader of ' +
        '`free` (typed-error dispatch, tier ranking, the parity fixtures pinning `current_tier: free`) ' +
        'must be removed or made tolerant, and the change is BREAKING for consumers that compare ' +
        'against UserTier.free. Then invert this assertion.',
    ).toContain('free');
  });

  it('the contract declares `basic` as the base tier', () => {
    expect(
      schemas.UserTier?.enum,
      'The vendored contract does not declare UserTier `basic`. The rename has been reverted or ' +
        'the vendored spec is older than v2.196.0 — decide which before changing the tier fixtures.',
    ).toContain('basic');
  });

  // A wide `anonymous` -> `guest` rename must not slip through unnoticed: the
  // two `anonymous` spellings below are deliberately UNCHANGED by the tier work.
  it('WorkflowCreateResponse still carries a required `anonymous` field', () => {
    const response = schemas.WorkflowCreateResponse;
    expect(
      response?.properties ?? {},
      'WorkflowCreateResponse.anonymous is gone from the contract. Decide whether it was renamed ' +
        '(SDK surface + CHANGELOG, BREAKING) before re-vendoring.',
    ).toHaveProperty('anonymous');
    expect(response?.required).toContain('anonymous');
  });

  it('EndpointProjection.auth still offers the value `anonymous`', () => {
    expect(
      schemas.EndpointProjection?.properties?.auth?.enum,
      'EndpointProjection.auth no longer offers `anonymous`. The anonymous allowlist conformance ' +
        '(anonymous-allowlist-conformance.test.ts) keys off it; decide the rename there first.',
    ).toContain('anonymous');
  });
});
