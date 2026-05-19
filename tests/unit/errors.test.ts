import { describe, expect, it } from 'vitest';

import {
  GislApiError,
  GislAuthError,
  GislBalanceExhaustedError,
  GislError,
  GislFeatureNotAvailableError,
  GislFeatureTierRestrictedError,
  GislMultipartPartCountError,
  GislMultipartPartError,
  GislTierRestrictedError,
  GislUploadCapExceededError,
  GislValidationError,
  GislWorkflowExpiredError,
} from '../../src/errors.js';

// All payload fixtures match the camelCase shape the FromJSON helper produces
// at runtime (see node_modules/@giveitsmaller/contracts/openapi/models/*).
// Constructing payloads in this shape mirrors what handleResponse() builds
// before threading them into the typed subclass constructors.

describe('error classes', () => {
  describe('instanceof chain', () => {
    it('GislBalanceExhaustedError extends GislApiError', () => {
      const err = new GislBalanceExhaustedError(
        402,
        'Balance exhausted',
        {
          success: false,
          error: 'Balance exhausted',
          errorType: 'balance_exhausted',
          requiredAction: 'add_credits',
        },
      );
      expect(err).toBeInstanceOf(GislBalanceExhaustedError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GislBalanceExhaustedError');
    });

    it('GislTierRestrictedError extends GislApiError', () => {
      const err = new GislTierRestrictedError(
        403,
        'Tier restricted',
        {
          success: false,
          error: 'Tier restricted',
          errorType: 'tier_restriction',
          restrictionKind: 'file_size',
          currentTier: 'free',
        },
      );
      expect(err).toBeInstanceOf(GislTierRestrictedError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislTierRestrictedError');
    });

    it('GislFeatureTierRestrictedError extends GislApiError', () => {
      const err = new GislFeatureTierRestrictedError(
        403,
        'Feature tier restricted',
        {
          success: false,
          error: 'Feature tier restricted',
          errorType: 'feature_tier_restricted',
          violations: [],
        },
      );
      expect(err).toBeInstanceOf(GislFeatureTierRestrictedError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislFeatureTierRestrictedError');
    });

    it('GislFeatureNotAvailableError extends GislApiError', () => {
      const err = new GislFeatureNotAvailableError(
        422,
        'Feature not available',
        {
          success: false,
          error: 'Feature not available',
          errorType: 'feature_not_available',
          violations: [],
        },
      );
      expect(err).toBeInstanceOf(GislFeatureNotAvailableError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislFeatureNotAvailableError');
    });

    it('GislWorkflowExpiredError extends GislApiError', () => {
      const err = new GislWorkflowExpiredError(
        422,
        'Workflow expired',
        {
          success: false,
          error: 'Workflow expired',
          errorType: 'workflow_expired',
          expiredAt: new Date('2026-04-20T12:00:00Z'),
        },
      );
      expect(err).toBeInstanceOf(GislWorkflowExpiredError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislWorkflowExpiredError');
    });

    it('GislAuthError extends GislApiError', () => {
      const err = new GislAuthError(
        401,
        'Authentication required',
        {
          success: false,
          error: 'Authentication required',
          errorType: 'authentication_required',
        },
      );
      expect(err).toBeInstanceOf(GislAuthError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislAuthError');
    });

    it('GislUploadCapExceededError extends GislApiError (size_tier kind)', () => {
      const err = new GislUploadCapExceededError(
        422,
        'Too big for your tier',
        'size_tier',
        {
          success: false,
          error: 'Too big for your tier',
          errorType: 'upload_size_exceeds_tier',
          currentTier: 'free',
          maxSizeBytes: 10485760,
          requiredTier: 'pro',
        },
      );
      expect(err).toBeInstanceOf(GislUploadCapExceededError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err).toBeInstanceOf(GislError);
      expect(err.name).toBe('GislUploadCapExceededError');
      expect(err.kind).toBe('size_tier');
      expect(err.statusCode).toBe(422);
    });

    it('GislUploadCapExceededError carries no payload for absolute_413', () => {
      const err = new GislUploadCapExceededError(
        413,
        'File size exceeds maximum allowed',
        'absolute_413',
        undefined,
      );
      expect(err).toBeInstanceOf(GislUploadCapExceededError);
      expect(err.kind).toBe('absolute_413');
      expect(err.payload).toBeUndefined();
    });

    it('GislMultipartPartError extends GislError (not GislApiError)', () => {
      const err = new GislMultipartPartError(
        'part 4 failed after 3 attempts',
        4,
        'upload-xyz',
      );
      expect(err).toBeInstanceOf(GislMultipartPartError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislMultipartPartError');
      expect(err.partNumber).toBe(4);
      expect(err.uploadId).toBe('upload-xyz');
    });

    it('GislMultipartPartCountError extends GislError (not GislApiError)', () => {
      const err = new GislMultipartPartCountError(
        'requires 12345 parts, exceeds 10000',
        12345,
        10000,
      );
      expect(err).toBeInstanceOf(GislMultipartPartCountError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislMultipartPartCountError');
      expect(err.requiredParts).toBe(12345);
      expect(err.maxParts).toBe(10000);
    });
  });

  describe('payload typing round-trip', () => {
    it('Balance: errorType discriminator and required_action accessible', () => {
      const err = new GislBalanceExhaustedError(
        402,
        'Balance exhausted',
        {
          success: false,
          error: 'Balance exhausted',
          errorType: 'balance_exhausted',
          requiredAction: 'wait_for_renewal',
          links: { upgrade: 'https://gisl.example/upgrade' },
        },
      );
      expect(err.payload.errorType).toBe('balance_exhausted');
      expect(err.payload.requiredAction).toBe('wait_for_renewal');
      expect(err.payload.links?.upgrade).toBe('https://gisl.example/upgrade');
    });

    it('TierRestricted: discriminator and tier fields accessible', () => {
      const err = new GislTierRestrictedError(
        403,
        'Upload too large',
        {
          success: false,
          error: 'Upload too large',
          errorType: 'tier_restriction',
          restrictionKind: 'file_size',
          currentTier: 'free',
          requiredTier: 'pro',
        },
      );
      expect(err.payload.errorType).toBe('tier_restriction');
      expect(err.payload.restrictionKind).toBe('file_size');
      expect(err.payload.currentTier).toBe('free');
      expect(err.payload.requiredTier).toBe('pro');
    });

    it('FeatureTierRestricted: discriminator and violations[] accessible', () => {
      const err = new GislFeatureTierRestrictedError(
        403,
        'Feature requires upgrade',
        {
          success: false,
          error: 'Feature requires upgrade',
          errorType: 'feature_tier_restricted',
          violations: [
            { feature: 'operation.compress.option.codec.av1', availability: 'stable', requiredTier: 'pro' },
          ],
        },
      );
      expect(err.payload.errorType).toBe('feature_tier_restricted');
      expect(err.payload.violations).toHaveLength(1);
      expect(err.payload.violations[0].feature).toBe('operation.compress.option.codec.av1');
      expect(err.payload.violations[0].requiredTier).toBe('pro');
    });

    it('FeatureNotAvailable: discriminator and violations[] accessible', () => {
      const err = new GislFeatureNotAvailableError(
        422,
        'Feature not available',
        {
          success: false,
          error: 'Feature not available',
          errorType: 'feature_not_available',
          violations: [
            { feature: 'operation.image_watermark', availability: 'planned', eta: '2026-Q3' },
          ],
        },
      );
      expect(err.payload.errorType).toBe('feature_not_available');
      expect(err.payload.violations).toHaveLength(1);
      expect(err.payload.violations[0].feature).toBe('operation.image_watermark');
      expect(err.payload.violations[0].availability).toBe('planned');
    });

    it.each([
      ['operation.audio_overlay', '2026-Q4'],
      ['operation.audio_watermark', '2027-Q1'],
      ['operation.custom_luma', '2026-Q4'],
    ] as const)('FeatureNotAvailable: planned op %s parses violation metadata', (feature, eta) => {
      const err = new GislFeatureNotAvailableError(
        422,
        'Feature not available',
        {
          success: false,
          error: 'Feature not available',
          errorType: 'feature_not_available',
          violations: [{ feature, availability: 'planned', eta }],
        },
      );
      expect(err.payload.violations[0].feature).toBe(feature);
      expect(err.payload.violations[0].availability).toBe('planned');
      expect(err.payload.violations[0].eta).toBe(eta);
    });

    it('WorkflowExpired: discriminator + expiredAt is a Date instance', () => {
      const expiredAt = new Date('2026-04-20T12:00:00Z');
      const err = new GislWorkflowExpiredError(
        422,
        'Workflow expired',
        {
          success: false,
          error: 'Workflow expired',
          errorType: 'workflow_expired',
          expiredAt,
        },
      );
      expect(err.payload.errorType).toBe('workflow_expired');
      expect(err.payload.expiredAt).toBeInstanceOf(Date);
      expect(err.payload.expiredAt.toISOString()).toBe('2026-04-20T12:00:00.000Z');
    });

    it('Auth: errorType discriminator accessible (invalid_credentials)', () => {
      const err = new GislAuthError(
        401,
        'Invalid credentials',
        {
          success: false,
          error: 'Invalid credentials',
          errorType: 'invalid_credentials',
        },
      );
      expect(err.payload.errorType).toBe('invalid_credentials');
    });
  });

  describe('i18n triple', () => {
    it('GislApiError carries messageKey/locale/messageParams from options', () => {
      const err = new GislApiError(
        500,
        'Server error',
        '/some/path',
        undefined,
        {
          messageKey: 'error.server.unexpected',
          locale: 'fr-FR',
          messageParams: { trace_id: 'abc-123' },
        },
      );
      expect(err.messageKey).toBe('error.server.unexpected');
      expect(err.locale).toBe('fr-FR');
      expect(err.messageParams).toEqual({ trace_id: 'abc-123' });
    });

    it('GislApiError defaults i18n triple to undefined when options omitted', () => {
      const err = new GislApiError(500, 'Server error');
      expect(err.messageKey).toBeUndefined();
      expect(err.locale).toBeUndefined();
      expect(err.messageParams).toBeUndefined();
      expect(err.payload).toBeUndefined();
    });

    it('GislBalanceExhaustedError surfaces i18n triple from extra arg', () => {
      const err = new GislBalanceExhaustedError(
        402,
        'Balance exhausted',
        {
          success: false,
          error: 'Balance exhausted',
          errorType: 'balance_exhausted',
          requiredAction: 'add_credits',
        },
        '/api/workflows',
        {
          messageKey: 'error.balance_exhausted.add_credits',
          locale: 'en-GB',
          messageParams: { feature: 'compress' },
        },
      );
      expect(err.messageKey).toBe('error.balance_exhausted.add_credits');
      expect(err.locale).toBe('en-GB');
      expect(err.messageParams).toEqual({ feature: 'compress' });
    });

    it('GislTierRestrictedError defaults i18n triple to undefined when extra omitted', () => {
      const err = new GislTierRestrictedError(
        403,
        'Tier restricted',
        {
          success: false,
          error: 'Tier restricted',
          errorType: 'tier_restriction',
          restrictionKind: 'mime_type',
          currentTier: 'free',
        },
      );
      expect(err.messageKey).toBeUndefined();
      expect(err.locale).toBeUndefined();
      expect(err.messageParams).toBeUndefined();
    });

    it('GislFeatureTierRestrictedError surfaces i18n triple from extra arg', () => {
      const err = new GislFeatureTierRestrictedError(
        403,
        'Feature tier restricted',
        {
          success: false,
          error: 'Feature tier restricted',
          errorType: 'feature_tier_restricted',
          violations: [],
        },
        '/api/workflows',
        { messageKey: 'error.feature_tier_restricted', locale: 'pt-BR' },
      );
      expect(err.messageKey).toBe('error.feature_tier_restricted');
      expect(err.locale).toBe('pt-BR');
    });

    it('GislFeatureNotAvailableError surfaces i18n triple from extra arg', () => {
      const err = new GislFeatureNotAvailableError(
        422,
        'Feature not available',
        {
          success: false,
          error: 'Feature not available',
          errorType: 'feature_not_available',
          violations: [],
        },
        '/api/workflows',
        { messageKey: 'error.feature_not_available', locale: 'ja-JP' },
      );
      expect(err.messageKey).toBe('error.feature_not_available');
      expect(err.locale).toBe('ja-JP');
    });

    it('GislWorkflowExpiredError surfaces i18n triple from extra arg', () => {
      const err = new GislWorkflowExpiredError(
        422,
        'Workflow expired',
        {
          success: false,
          error: 'Workflow expired',
          errorType: 'workflow_expired',
          expiredAt: new Date('2026-04-20T12:00:00Z'),
        },
        '/api/workflows/wf-1/status',
        { messageKey: 'error.workflow_expired', locale: 'en-GB' },
      );
      expect(err.messageKey).toBe('error.workflow_expired');
      expect(err.locale).toBe('en-GB');
    });

    it('GislAuthError surfaces i18n triple from extra arg', () => {
      const err = new GislAuthError(
        401,
        'Invalid API key',
        {
          success: false,
          error: 'Invalid API key',
          errorType: 'api_key_invalid',
        },
        '/api/uploads',
        { messageKey: 'error.api_key_invalid', locale: 'en-GB' },
      );
      expect(err.messageKey).toBe('error.api_key_invalid');
      expect(err.locale).toBe('en-GB');
    });
  });

  describe('GislValidationError backward compatibility', () => {
    it('preserves the existing positional signature (status, errorMessage, details, path)', () => {
      const err = new GislValidationError(
        400,
        'Validation failed',
        [{ field: 'file', message: 'File is required' }],
        '/api/uploads',
      );
      expect(err).toBeInstanceOf(GislValidationError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.statusCode).toBe(400);
      expect(err.details).toHaveLength(1);
      expect(err.details[0].field).toBe('file');
      expect(err.path).toBe('/api/uploads');
      expect(err.messageKey).toBeUndefined();
    });

    it('accepts an optional 5th options arg without breaking', () => {
      const err = new GislValidationError(
        400,
        'Validation failed',
        [{ field: 'jobs[0].file_id', message: 'must be a UUID' }],
        '/api/workflows',
        {
          messageKey: 'error.validation.jobs.file_id',
          locale: 'en-GB',
          messageParams: { index: 0 },
        },
      );
      expect(err.messageKey).toBe('error.validation.jobs.file_id');
      expect(err.locale).toBe('en-GB');
      expect(err.messageParams).toEqual({ index: 0 });
      // Existing details still surface as the typed validation array.
      expect(err.details).toHaveLength(1);
      expect(err.details[0].field).toBe('jobs[0].file_id');
    });
  });

  describe('Balance requiredAction enum', () => {
    it.each(['add_credits', 'upgrade_plan', 'wait_for_renewal'] as const)(
      'accepts requiredAction=%s',
      (action) => {
        const err = new GislBalanceExhaustedError(
          402,
          'Balance exhausted',
          {
            success: false,
            error: 'Balance exhausted',
            errorType: 'balance_exhausted',
            requiredAction: action,
          },
        );
        expect(err.payload.requiredAction).toBe(action);
      },
    );
  });

  describe('Auth error_type vocabulary', () => {
    // The contract enum (AuthErrorType) carries 8 values per the API spec.
    // Parametrise across ALL 8 so a future contract addition or a typo in
    // the dispatch allow-list lands on a failing test, not a silent fall-
    // through to base GislApiError.
    it.each([
      'invalid_credentials',
      'account_locked',
      'account_disabled',
      'account_deleted',
      'account_deletion_expired',
      'authentication_required',
      'api_key_invalid',
      'api_key_revoked',
    ] as const)('accepts errorType=%s', (errorType) => {
      const err = new GislAuthError(
        401,
        'Auth failed',
        {
          success: false,
          error: 'Auth failed',
          errorType,
        },
      );
      expect(err.payload.errorType).toBe(errorType);
    });
  });
});
