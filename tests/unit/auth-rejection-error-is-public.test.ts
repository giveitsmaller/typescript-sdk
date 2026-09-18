import { describe, expect, it } from 'vitest';

/**
 * wOzXYDhg — `GislAuthRejectionError` was thrown by both SDKs and exported by
 * neither. A caller who wanted to tell "this email is already registered" from
 * "your payload is malformed" could not write `instanceof GislAuthRejectionError`
 * at all; the workaround was to catch `GislApiError`, test `statusCode === 422`
 * and read the `error_type` discriminator by hand — the exact unwrapping the
 * typed class exists to remove.
 *
 * ⚠️ EVERYTHING HERE GOES THROUGH THE BARREL, NEVER `../../src/errors.js`.
 * The class was always importable from its own module — that is what made the
 * bug invisible to the rest of `tests/unit`, every file of which imports from
 * `src/errors.js` directly. A test that reaches past the public entry point
 * cannot fail for the defect this file is about.
 *
 * ⚠️ AND THE SNAPSHOT ALONE IS NOT ENOUGH EITHER. `tests/api-surface` proves the
 * NAME appears on the surface; it says nothing about whether the value behind it
 * is the class the client actually throws. Both halves are asserted below.
 */

describe('GislAuthRejectionError is on the public surface', () => {
  it('is importable from the package barrel, not only from src/errors.js', async () => {
    const barrel = await import('../../src/index.core.js');

    expect(barrel).toHaveProperty('GislAuthRejectionError');
    expect(typeof barrel.GislAuthRejectionError).toBe('function');
  });

  it('is the SAME class the client throws, not a same-named re-declaration', async () => {
    const barrel = await import('../../src/index.core.js');
    const internal = await import('../../src/errors.js');

    expect(barrel.GislAuthRejectionError).toBe(internal.GislAuthRejectionError);
  });

  it('narrows a thrown 422 with instanceof, through the barrel export', async () => {
    const { GislAuthRejectionError, GislApiError, GislValidationError } = await import(
      '../../src/index.core.js'
    );

    // Argument order is (statusCode, errorMessage, payload, path) — payload
    // THIRD, unlike GislApiError's. Spelled out because getting it wrong
    // type-checks under a looser payload type and silently stores the path as
    // the payload.
    const thrown = new GislAuthRejectionError(
      422,
      'Email already registered',
      { errorType: 'unprocessable_entity', message: 'Email already registered' },
      '/auth/register',
    );

    expect(thrown).toBeInstanceOf(GislAuthRejectionError);
    // It stays inside the GislApiError tree — a caller with a broad catch is
    // unaffected by this becoming narrowable.
    expect(thrown).toBeInstanceOf(GislApiError);
    // 🔴 THE POINT OF THE TICKET. Both are branches of the SAME 422 `oneOf`;
    // if this assertion ever passes, `instanceof` has stopped telling a domain
    // rejection from a malformed payload and the export bought nothing.
    expect(thrown).not.toBeInstanceOf(GislValidationError);
  });

  it('keeps its own name after the round trip through the barrel', async () => {
    // A subclass that forgets `this.name` reports as its parent in logs and in
    // `err.name` checks, which is the other way a "typed" error stops being one.
    const { GislAuthRejectionError } = await import('../../src/index.core.js');

    const thrown = new GislAuthRejectionError(
      422,
      'x',
      { errorType: 'email_same', message: 'x' },
      '/users/me',
    );

    expect(thrown.name).toBe('GislAuthRejectionError');
    expect(thrown.errorType).toBe('email_same');
  });

  it('is exported from the BROWSER entry too — it is a pure class with no node: import', async () => {
    // The browser bundle is a subset, and a class that exists only in the Node
    // entry is a different bug wearing this one's clothes.
    const browser = await import('../../src/index.browser.js');

    expect(browser).toHaveProperty('GislAuthRejectionError');
  });
});
