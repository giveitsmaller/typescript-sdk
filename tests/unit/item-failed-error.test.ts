import { describe, expect, it } from 'vitest';

import { GislError, GislItemFailedError } from '../../src/errors.js';

/**
 * AjhOUuqQ — `GislItemFailedError`, the typed terminal-failure carried in
 * `RunResult.failed[].error`. Pins the message composition + field population +
 * the instanceof chain at the class level (the projection-driven behaviour is
 * covered in file-first-run / file-first-files / handle). Mirrors the PHP
 * `ItemFailedErrorTest`.
 */

describe('GislItemFailedError', () => {
  describe('message composition', () => {
    it('is the bare state when errorMessage is absent (no trailing colon)', () => {
      // cancel / expire / credit-pause terminal states carry only the state.
      expect(new GislItemFailedError(null, 'cancelled').message).toBe('cancelled');
      expect(new GislItemFailedError('k', 'expired').message).toBe('expired');
    });

    it('is `{state}: {errorMessage}` when errorMessage is present', () => {
      expect(new GislItemFailedError(null, 'failed', 'codec exploded').message).toBe(
        'failed: codec exploded',
      );
    });

    it('an EMPTY-string errorMessage still adds the colon (preserves the old string)', () => {
      // The composition guard is `errorMessage !== undefined`, NOT a truthiness
      // check — an empty string is a present (if blank) server message, so the
      // ': ' separator is still emitted.
      const err = new GislItemFailedError(null, 'failed', '');
      expect(err.message).toBe('failed: ');
      // And the empty string is retained as the field (present, not dropped).
      expect(err.errorMessage).toBe('');
    });

    it('errorCode does NOT affect the message (only state + errorMessage do)', () => {
      expect(new GislItemFailedError(null, 'failed', 'boom', 'a_code').message).toBe('failed: boom');
      // A code with NO message still yields the bare-state message (no colon).
      expect(new GislItemFailedError(null, 'failed', undefined, 'a_code').message).toBe('failed');
    });
  });

  describe('fields', () => {
    it('sets key / state / errorMessage / errorCode when all are supplied', () => {
      const err = new GislItemFailedError('hero', 'failed', 'boom', 'output_too_large');
      expect(err.key).toBe('hero');
      expect(err.state).toBe('failed');
      expect(err.errorMessage).toBe('boom');
      expect(err.errorCode).toBe('output_too_large');
    });

    it('carries a null key (a keyless / positional input)', () => {
      expect(new GislItemFailedError(null, 'failed', 'boom').key).toBeNull();
    });

    it('leaves errorMessage / errorCode undefined when omitted (bare-state)', () => {
      const err = new GislItemFailedError(null, 'cancelled');
      expect(err.errorMessage).toBeUndefined();
      expect(err.errorCode).toBeUndefined();
    });

    it('sets errorCode independently of errorMessage', () => {
      const err = new GislItemFailedError(null, 'failed', undefined, 'lonely_code');
      expect(err.errorCode).toBe('lonely_code');
      expect(err.errorMessage).toBeUndefined();
    });
  });

  describe('instanceof chain', () => {
    it('is a GislError, a (native) Error, and names itself GislItemFailedError', () => {
      const err = new GislItemFailedError(null, 'failed', 'boom');
      expect(err).toBeInstanceOf(GislItemFailedError);
      expect(err).toBeInstanceOf(GislError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GislItemFailedError');
    });
  });
});
