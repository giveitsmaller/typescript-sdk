/**
 * F9UUicuO, codex round 1. typescript-fetch tests `oneOf` branches in
 * declaration order, and `ErrorEnvelope` (required: success + error) is listed
 * first in two error unions, so it matched every specialised body and dropped
 * `error_type` / `violations` / `restriction_kind` / `current_tier`.
 * scripts/generate.py now tests a branch before any branch whose required wire
 * keys are a strict subset of its own.
 *
 * The round trips re-encode with the SPECIALISED branch's ToJSON: the union's
 * ToJSON still tests ErrorEnvelope first (the fix is decode-only by scope), so
 * it would re-encode these as a plain envelope.
 */
import { describe, it, expect } from 'vitest';
import {
  CreateBillingCheckoutSession422ResponseFromJSON,
  CreateExternalImport403ResponseFromJSON,
  CreateExternalImport403ResponseToJSON,
  FeatureNotAvailableResponseToJSON,
  FeatureTierRestrictedResponseToJSON,
  TierRestrictionResponseToJSON,
  type FeatureNotAvailableResponse,
  type FeatureTierRestrictedResponse,
  type TierRestrictionResponse,
} from '@giveitsmaller/contracts/openapi';

const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const featureTierRestricted = {
  success: false,
  error: 'feature_tier_restricted',
  message: 'Upgrade to use this.',
  error_type: 'feature_tier_restricted',
  violations: [{ feature: 'operation.image_watermark', availability: 'stable', required_tier: 'pro' }],
};

const tierRestriction = {
  success: false,
  error: 'tier_restriction',
  message: 'File too large for your tier.',
  error_type: 'tier_restriction',
  restriction_kind: 'file_size',
  current_tier: 'free',
  required_tier: 'pro',
};

const featureNotAvailable = {
  success: false,
  error: 'feature_not_available',
  error_type: 'feature_not_available',
  violations: [{ feature: 'billing.checkout', availability: 'planned' }],
};

describe('error unions decode to their most specific branch (F9UUicuO)', () => {
  it('403 feature_tier_restricted keeps errorType and violations, and round-trips', () => {
    const decoded = CreateExternalImport403ResponseFromJSON(featureTierRestricted);
    expect(decoded).toMatchObject({
      errorType: 'feature_tier_restricted',
      violations: [{ feature: 'operation.image_watermark', availability: 'stable', requiredTier: 'pro' }],
    });
    expect(strip(FeatureTierRestrictedResponseToJSON(decoded as FeatureTierRestrictedResponse))).toEqual(featureTierRestricted);
  });

  it('403 tier_restriction keeps restrictionKind and currentTier, and round-trips', () => {
    const decoded = CreateExternalImport403ResponseFromJSON(tierRestriction);
    expect(decoded).toMatchObject({
      errorType: 'tier_restriction',
      restrictionKind: 'file_size',
      currentTier: 'free',
      requiredTier: 'pro',
    });
    expect(strip(TierRestrictionResponseToJSON(decoded as TierRestrictionResponse))).toEqual(tierRestriction);
  });

  it('422 feature_not_available keeps errorType and violations, and round-trips', () => {
    const decoded = CreateBillingCheckoutSession422ResponseFromJSON(featureNotAvailable);
    expect(decoded).toMatchObject({ errorType: 'feature_not_available', violations: [{ feature: 'billing.checkout' }] });
    expect(strip(FeatureNotAvailableResponseToJSON(decoded as FeatureNotAvailableResponse))).toEqual(featureNotAvailable);
  });

  it('a plain envelope still decodes as ErrorEnvelope (generic branch still reachable)', () => {
    const plain = { success: false, error: 'pack_not_provisioned', message: 'No such pack.' };
    const decoded = CreateBillingCheckoutSession422ResponseFromJSON(plain);
    expect(decoded).toMatchObject({ success: false, error: 'pack_not_provisioned', message: 'No such pack.' });
    expect(decoded).not.toHaveProperty('errorType');
    expect(strip(CreateExternalImport403ResponseToJSON(CreateExternalImport403ResponseFromJSON(plain)))).toEqual(plain);
  });
});
