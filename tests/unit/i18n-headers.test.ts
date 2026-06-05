import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import {
  GislApiError,
  GislBalanceExhaustedError,
  GislValidationError,
} from '../../src/errors.js';

// TS-only unit coverage for the combined 0kJi8Q0b + QsUQ681l surface:
//   - request side: GislClientConfig.locale -> Accept-Language on every
//     GISL-API request (with case-insensitive dedup of a caller-supplied
//     Accept-Language header).
//   - response side: GislApiError.responseHeaders (lowercased Record) +
//     GislApiError.contentLanguage on every error thrown from a real HTTP
//     response (handleResponse typed/non-JSON/invalid-JSON throws AND the
//     getSchema rawResponse:true non-ok throw).
//
// Deliberately NOT a parity fixture — the PHP runner shares
// tests/parity/fixtures/ and has none of this (TS-only feature); a shared
// fixture would turn PHP parity RED. Everything is asserted here in TS.

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('i18n headers (0kJi8Q0b + QsUQ681l)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sentHeaders(): Record<string, string> {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return init.headers as Record<string, string>;
  }

  // -----------------------------------------------------------------------
  // Request side — Accept-Language
  // -----------------------------------------------------------------------

  describe('request side (Accept-Language)', () => {
    it('sends Accept-Language: <locale> on a GISL-API request when locale is set', async () => {
      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        locale: 'fr-FR',
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await client.getMetadata('a');

      expect(sentHeaders()['Accept-Language']).toBe('fr-FR');
    });

    it('sends NO Accept-Language header when locale is unset', async () => {
      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await client.getMetadata('a');

      const headers = sentHeaders();
      // No variant in any casing.
      const acceptLanguageKeys = Object.keys(headers).filter(
        (k) => k.toLowerCase() === 'accept-language',
      );
      expect(acceptLanguageKeys).toHaveLength(0);
    });

    it('dedups case-insensitively: dedicated locale wins, no stale lowercase variant', async () => {
      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        locale: 'fr-FR',
        headers: { 'accept-language': 'de' },
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await client.getMetadata('a');

      const headers = sentHeaders();
      // Exactly one Accept-Language key, carrying the locale value, never `de`.
      const acceptLanguageKeys = Object.keys(headers).filter(
        (k) => k.toLowerCase() === 'accept-language',
      );
      expect(acceptLanguageKeys).toHaveLength(1);
      const value = headers[acceptLanguageKeys[0]];
      expect(value).toBe('fr-FR');
      // The caller's lowercase `de` variant must not survive in any casing.
      expect(Object.values(headers)).not.toContain('de');
    });

    it('passes a caller Accept-Language through untouched when locale is unset (no dedup)', async () => {
      const client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        headers: { 'Accept-Language': 'de' },
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { file_id: 'a', original_name: 'x', mime_type: 'image/png', size_bytes: 1 },
        }),
      );

      await client.getMetadata('a');

      expect(sentHeaders()['Accept-Language']).toBe('de');
    });
  });

  // -----------------------------------------------------------------------
  // Response side — responseHeaders + contentLanguage
  // -----------------------------------------------------------------------

  describe('response side (responseHeaders + contentLanguage)', () => {
    let client: GislClient;

    beforeEach(() => {
      client = new GislClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      });
    });

    it('populates responseHeaders (lowercased keys) + contentLanguage on a thrown GislApiError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'Not found' },
          404,
          { 'Content-Language': 'fr-FR', 'X-Request-Id': 'req-123' },
        ),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.contentLanguage).toBe('fr-FR');
        expect(apiErr.responseHeaders).toBeDefined();
        // Keys are LOWERCASED regardless of the casing the server sent.
        expect(apiErr.responseHeaders!['content-language']).toBe('fr-FR');
        expect(apiErr.responseHeaders!['x-request-id']).toBe('req-123');
        // No upper/mixed-case variant leaked through.
        expect(apiErr.responseHeaders!['Content-Language']).toBeUndefined();
      }
    });

    it('populates responseHeaders on a 5xx (500) error too', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'Boom' },
          500,
          { 'Content-Language': 'de-DE', Vary: 'Accept-Language' },
        ),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.contentLanguage).toBe('de-DE');
        expect(apiErr.responseHeaders!['vary']).toBe('Accept-Language');
      }
    });

    it('collapses repeated response headers into one comma-joined value (Headers.forEach contract)', async () => {
      // `headersToRecord` uses `Headers.forEach`, which collapses multiple
      // values for the same header name into a single comma-joined string.
      // Locks that documented behaviour so a regression to array/first-only
      // handling is caught (the single-value Vary test above would still pass).
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Vary', 'Accept-Language');
      headers.append('Vary', 'Origin');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'Boom' }), {
          status: 500,
          headers,
        }),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiErr = err as GislApiError;
        expect(apiErr.responseHeaders!['vary']).toBe('Accept-Language, Origin');
      }
    });

    it('leaves contentLanguage undefined but still populates responseHeaders when no Content-Language header', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'Not found' },
          404,
          { 'X-Request-Id': 'req-999' },
        ),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiErr = err as GislApiError;
        expect(apiErr.contentLanguage).toBeUndefined();
        // responseHeaders is still a populated Record.
        expect(apiErr.responseHeaders).toBeDefined();
        expect(apiErr.responseHeaders!['x-request-id']).toBe('req-999');
        expect(Object.keys(apiErr.responseHeaders!).length).toBeGreaterThan(0);
      }
    });

    it('propagates responseHeaders + contentLanguage onto a typed subclass (GislBalanceExhaustedError)', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'BALANCE_EXHAUSTED',
            error_type: 'balance_exhausted',
            required_action: 'add_credits',
            links: {
              top_up: 'https://example.com/billing/top-up',
              upgrade: 'https://example.com/billing/plans',
              check_balance: '/api/v2/credits/balance',
            },
          },
          402,
          { 'Content-Language': 'fr-FR', 'X-Request-Id': 'req-402' },
        ),
      );

      try {
        await client.resumeWorkflow('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislBalanceExhaustedError);
        const apiErr = err as GislBalanceExhaustedError;
        // Inherited via super(...) — proves the inherit-through-options path.
        expect(apiErr.contentLanguage).toBe('fr-FR');
        expect(apiErr.responseHeaders!['content-language']).toBe('fr-FR');
        expect(apiErr.responseHeaders!['x-request-id']).toBe('req-402');
      }
    });

    it('propagates responseHeaders + contentLanguage onto GislValidationError', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'Validation failed',
            details: [{ field: 'file', message: 'File is required' }],
          },
          400,
          { 'Content-Language': 'es-ES' },
        ),
      );

      try {
        await client.getMetadata('bad');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislValidationError);
        const apiErr = err as GislValidationError;
        expect(apiErr.contentLanguage).toBe('es-ES');
        expect(apiErr.responseHeaders!['content-language']).toBe('es-ES');
      }
    });

    it('populates the headers on the non-JSON error throw path', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<html>oops</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html', 'Content-Language': 'fr-FR' },
        }),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.errorMessage).toBe('Non-JSON response');
        expect(apiErr.contentLanguage).toBe('fr-FR');
        expect(apiErr.responseHeaders!['content-language']).toBe('fr-FR');
      }
    });

    it('populates the headers on the invalid-JSON error throw path', async () => {
      // application/json Content-Type but a truncated/garbage body so
      // response.json() rejects -> the invalid-JSON throw branch fires.
      fetchSpy.mockResolvedValueOnce(
        new Response('{ not json', {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Content-Language': 'de-DE' },
        }),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.errorMessage).toBe('Invalid JSON response');
        expect(apiErr.contentLanguage).toBe('de-DE');
        expect(apiErr.responseHeaders!['content-language']).toBe('de-DE');
      }
    });

    it('populates the headers on the getSchema non-ok (rawResponse) throw path', async () => {
      // getSchema uses rawResponse:true (304 revalidation) so it bypasses
      // handleResponse — its inline throw must independently carry the headers.
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Schema unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Content-Language': 'fr-FR', 'X-Request-Id': 'req-503' },
        }),
      );

      try {
        await client.getSchema();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GislApiError);
        const apiErr = err as GislApiError;
        expect(apiErr.statusCode).toBe(503);
        expect(apiErr.contentLanguage).toBe('fr-FR');
        expect(apiErr.responseHeaders!['content-language']).toBe('fr-FR');
        expect(apiErr.responseHeaders!['x-request-id']).toBe('req-503');
      }
    });

    it('keeps body-envelope `locale` and header `contentLanguage` independent', async () => {
      // Body carries an I26 `locale` tag but the server sent NO Content-Language
      // header — the two fields are distinct sources and must not bleed.
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            error: 'probe_pending',
            message: 'still probing',
            message_key: 'errors.workflow.probe_pending',
            locale: 'en-GB',
            error_type: 'probe_pending',
            job_ref: 'job_compress',
          },
          422,
          // No Content-Language header on purpose.
          {},
        ),
      );

      try {
        await client.resumeWorkflow('wf-1');
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiErr = err as GislApiError;
        // Body-envelope tag set...
        expect(apiErr.locale).toBe('en-GB');
        // ...header field absent (independent source).
        expect(apiErr.contentLanguage).toBeUndefined();
      }
    });

    it('keeps header `contentLanguage` set when the body has no `locale` tag', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          { success: false, error: 'Not found' },
          404,
          { 'Content-Language': 'fr-FR' },
        ),
      );

      try {
        await client.getMetadata('xyz');
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiErr = err as GislApiError;
        // Header field set...
        expect(apiErr.contentLanguage).toBe('fr-FR');
        // ...body-envelope tag absent (independent source).
        expect(apiErr.locale).toBeUndefined();
      }
    });
  });
});
