import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticatedIdentityFromJSON,
  UserTier,
  instanceOfUserTier,
} from '@giveitsmaller/contracts/openapi';

import { GislClient } from '../../src/client.js';
import { GislTierRestrictedError } from '../../src/errors.js';

/**
 * kcA1ZRwW — contracts v2.236.0 makes `pay_as_you_go` the base tier; `basic`
 * and `free` are DEPRECATED spellings of it (removal `IloAPrH4` / `nD8fCPDy`).
 * Expand → migrate → contract: the api writes `pay_as_you_go` only once every
 * consumer reads it. In TypeScript the generated reader does NOT validate
 * (`UserTierFromJSONTyped` is a cast), so the gate is the generated value set /
 * `instanceOfUserTier`, which a caller narrowing on the tier relies on; those
 * assertions are the regression pins here. The FromJSON and typed-error cases
 * prove the new spelling is carried through unchanged, not that anything is
 * rejected. The tripwire in `user-tier-transition-tripwire.test.ts` checks only
 * the vendored YAML.
 */

const SPELLINGS = ['pay_as_you_go', 'basic', 'free'] as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('UserTier pay_as_you_go / basic / free read through the generated readers', () => {
  it('the generated UserTier value set carries all three spellings', () => {
    const values: string[] = Object.values(UserTier);
    for (const tier of SPELLINGS) {
      expect(values).toContain(tier);
      expect(instanceOfUserTier(tier)).toBe(true);
    }
    // Negative control: the guard is not "anything goes".
    expect(instanceOfUserTier('guest')).toBe(false);
  });

  it.each(SPELLINGS)('AuthenticatedIdentityFromJSON carries tier %s through as a known UserTier', (tier) => {
    const identity = AuthenticatedIdentityFromJSON({
      id: 'u-1',
      email: 'a@example.com',
      tier,
      email_verified: true,
      created_at: '2026-10-16T00:00:00Z',
    });
    expect(identity.tier).toBe(tier);
    expect(instanceOfUserTier(identity.tier)).toBe(true);
  });
});

describe('typed tier error carries current_tier "pay_as_you_go"', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      streamBaseUrl: 'https://stream.example.com',
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('403 tier_restriction with current_tier "pay_as_you_go" yields the TYPED error', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'File too large for tier',
          error_type: 'tier_restriction',
          restriction_kind: 'file_size',
          current_tier: 'pay_as_you_go',
          required_tier: 'pro',
        },
        403,
      ),
    );

    const err = await client.getWorkflowStatus('wf-1').then(
      () => expect.unreachable('should have thrown'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GislTierRestrictedError);
    const tierErr = err as GislTierRestrictedError;
    expect(tierErr.payload.currentTier).toBe('pay_as_you_go');
    expect(tierErr.payload.requiredTier).toBe('pro');
  });
});
