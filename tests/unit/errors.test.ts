import { describe, expect, it } from 'vitest';

import {
  GislApiError,
  GislAuthError,
  GislBalanceExhaustedError,
  GislBundleAlreadyArchivedError,
  GislConfigError,
  GislError,
  GislFanOutTimeoutError,
  GislFeatureNotAvailableError,
  GislFeatureTierRestrictedError,
  GislLongFormConcurrencyError,
  GislMultipartPartCountError,
  GislMultipartPartError,
  GislProbePendingError,
  GislTierRestrictedError,
  GislTimeoutError,
  GislUploadCapExceededError,
  GislValidationError,
  GislWorkflowExpiredError,
} from '../../src/errors.js';

// ⚠️ THIS FILE IMPORTS THE INTERNAL MODULE, AND SO DOES EVERY OTHER ERROR TEST
// HERE. That is fine for behaviour — but it means NONE of them can fail when a
// class is missing from the public barrel, which is exactly how
// `GislAuthRejectionError` stayed thrown-but-unexported (wOzXYDhg). A suite that
// never goes through the barrel cannot detect anything about the barrel.
//
// ⇒ ADDING A NEW ERROR CLASS? Its export is covered by the committed API-surface
// snapshot (`tests/api-surface/`) and by
// `tests/unit/auth-rejection-error-is-public.test.ts`, which imports through
// `src/index.core.js` on purpose. Assert behaviour here; assert reachability there.

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

    it('GislFanOutTimeoutError extends GislTimeoutError and carries the recovery ids (4G4FaA9X)', () => {
      const err = new GislFanOutTimeoutError('maxWait elapsed during fan-out (after 2 child runs)', {
        completedWorkflowIds: ['wf_child_0', 'wf_child_1'],
        parentWorkflowId: 'wf_parent',
      });
      // Subclasses GislTimeoutError so an existing `catch (e instanceof GislTimeoutError)`
      // still catches the fan-out variant (consistency with oYumKo6y).
      expect(err).toBeInstanceOf(GislFanOutTimeoutError);
      expect(err).toBeInstanceOf(GislTimeoutError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GislFanOutTimeoutError');
      expect(err.completedWorkflowIds).toEqual(['wf_child_0', 'wf_child_1']);
      expect(err.parentWorkflowId).toBe('wf_parent');
      // No single faithful recovery handle for a fan-out — the inherited workflowId
      // stays undefined (polling the parent id recovers the parent, not the children).
      expect(err.workflowId).toBeUndefined();
    });

    it('GislFanOutTimeoutError normalises an empty parentWorkflowId + defensively copies the ids', () => {
      const ids = ['a'];
      const err = new GislFanOutTimeoutError('msg', { completedWorkflowIds: ids, parentWorkflowId: '' });
      expect(err.parentWorkflowId).toBeUndefined();
      // Defensive copy — mutating the caller's array must not change the error.
      ids.push('b');
      expect(err.completedWorkflowIds).toEqual(['a']);
    });

    it('GislFanOutTimeoutError carries the in-flight child workflowId + cause on a mid-child timeout', () => {
      const cause = new GislTimeoutError('child did not complete', 'wf_child_2');
      const err = new GislFanOutTimeoutError(
        'maxWait elapsed during fan-out while a child was running (2 completed)',
        {
          completedWorkflowIds: ['wf_child_0', 'wf_child_1'],
          parentWorkflowId: 'wf_parent',
          workflowId: 'wf_child_2',
          cause,
        },
      );
      // The inherited workflowId is the in-flight child that timed out.
      expect(err.workflowId).toBe('wf_child_2');
      expect(err.completedWorkflowIds).toEqual(['wf_child_0', 'wf_child_1']);
      expect(err.parentWorkflowId).toBe('wf_parent');
      expect((err as Error & { cause?: unknown }).cause).toBe(cause);
    });

    it('GislLongFormConcurrencyError extends GislApiError with upgradeUrl getter', () => {
      // ST5CIN87 — 429 long-form concurrency limit. Mirrors the
      // GislBalanceExhaustedError instanceof test above; the wire envelope is
      // camelCase here (what handleResponse builds via FromJSON before it
      // threads the payload into the subclass constructor).
      const err = new GislLongFormConcurrencyError(
        429,
        'msg',
        {
          success: false,
          error: 'LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED',
          links: { upgrade: 'https://x/upgrade' },
        },
      );
      expect(err).toBeInstanceOf(GislLongFormConcurrencyError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GislLongFormConcurrencyError');
      expect(err.statusCode).toBe(429);
      // upgradeUrl reads links.upgrade off the typed payload.
      expect(err.upgradeUrl).toBe('https://x/upgrade');
      // Payload narrows to LongFormConcurrencyLimitResponse.
      expect(err.payload.links?.upgrade).toBe('https://x/upgrade');
      expect(err.payload.error).toBe('LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED');
    });

    // UO1xYecu — the base accessor is `isApiRetryableStatus(status) || taxonomy`,
    // and 429 is in the status arm, so this reported `true` and told callers to
    // back off from the ONE error where backing off can never help: it carries
    // no Retry-After and clears only when an in-flight long-form workflow
    // finishes. The class docblock said "do NOT back off" while the API said
    // retry — code contradicting code, with the docstring the correct one.
    it('GislLongFormConcurrencyError.retryable is false despite the 429', () => {
      const err = new GislLongFormConcurrencyError(429, 'msg', {
        success: false,
        error: 'LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED',
        links: { upgrade: 'https://x/upgrade' },
      });
      expect(err.retryable).toBe(false);
      // Still a GislApiError, so the override must survive the widened static
      // type a caller most often holds.
      const asBase: GislApiError = err;
      expect(asBase.retryable).toBe(false);
    });

    it('a generic 429 stays retryable (the carve-out is per-code, not a 429 blanket)', () => {
      const err = new GislApiError(429, 'slow down');
      expect(err.retryable).toBe(true);
    });

    it('GislLongFormConcurrencyError.upgradeUrl is undefined when links absent', () => {
      const err = new GislLongFormConcurrencyError(
        429,
        'Too many long-form jobs',
        {
          success: false,
          error: 'LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED',
        },
      );
      expect(err).toBeInstanceOf(GislLongFormConcurrencyError);
      expect(err.upgradeUrl).toBeUndefined();
      expect(err.payload.links?.upgrade).toBeUndefined();
    });

    it('GislBundleAlreadyArchivedError extends GislConfigError', () => {
      // P4d / hv3FpLjm — double-bundle prevention; dormant until `.bundle()`
      // (wpHoJhuo) raises it. Shape-only test (no firing site yet).
      const err = new GislBundleAlreadyArchivedError();
      expect(err).toBeInstanceOf(GislBundleAlreadyArchivedError);
      expect(err).toBeInstanceOf(GislConfigError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GislBundleAlreadyArchivedError');
      expect(err.message).toContain('already produces an archive');
      expect(err.message).toContain('.bundle()');
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

    it('GislProbePendingError extends GislApiError with typed jobRef', () => {
      const err = new GislProbePendingError(
        422,
        'Upload probe pending',
        {
          success: false,
          error: 'Upload probe pending',
          errorType: 'probe_pending',
          jobRef: 'job_compress',
        },
      );
      expect(err).toBeInstanceOf(GislProbePendingError);
      expect(err).toBeInstanceOf(GislApiError);
      expect(err.name).toBe('GislProbePendingError');
      // Payload narrows to ProbePendingResponse so consumers read jobRef typed.
      expect(err.payload.jobRef).toBe('job_compress');
      expect(err.payload.errorType).toBe('probe_pending');
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
    // (`api_key_revoked` was removed in Mc6wiUzc — collapses into
    // `api_key_invalid`; `reauthentication_required` added in apxXxptO for a
    // stale-session 401 that fails closed on POST /api/workflows.)
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
      'reauthentication_required',
      'api_key_invalid',
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
