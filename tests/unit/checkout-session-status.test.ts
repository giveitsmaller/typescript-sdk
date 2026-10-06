import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { gisl } from '../../src/gisl.js';
import {
  GislApiError,
  GislError,
  GislFeatureRequiresAuthError,
  GislResponseContractError,
} from '../../src/errors.js';

/**
 * NzdriXAK — `getCheckoutSessionStatus(sessionId)`:
 * `GET /api/billing/checkout/{sessionId}/status` (beta, auth required). The
 * three statuses are a CLOSED enum, and `unknown` is an ordinary answer.
 */

function rawJson(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function json(data: unknown, status = 200): Response {
  return rawJson(JSON.stringify(data), status);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  );
}

describe('getCheckoutSessionStatus (NzdriXAK)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const client = (): GislClient =>
    new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'sk_live_secret' });

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['paid', 'pending', 'unknown'] as const)('resolves status %s as { sessionId, status }', async (status) => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data: { session_id: 'cs_test_a1b2c3', status } }));

    const result = await client().getCheckoutSessionStatus('cs_test_a1b2c3');

    expect(result).toEqual({ sessionId: 'cs_test_a1b2c3', status });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/billing/checkout/cs_test_a1b2c3/status');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_live_secret');
  });

  it('keeps an additive `data` field out of the result (payload is open, result is fixed)', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ success: true, data: { session_id: 'cs_1', status: 'paid', granted_at: '2026-10-01T00:00:00Z' } }),
    );

    expect(await client().getCheckoutSessionStatus('cs_1')).toEqual({ sessionId: 'cs_1', status: 'paid' });
  });

  it('encodes the session id as one path segment', async () => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data: { session_id: 'cs/../x y?z#', status: 'unknown' } }));

    await client().getCheckoutSessionStatus('cs/../x y?z#');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/billing/checkout/cs%2F..%2Fx%20y%3Fz%23/status');
  });

  it('refuses an empty session id before any request', async () => {
    const err = await rejection(client().getCheckoutSessionStatus(''));

    expect(err).toBeInstanceOf(GislError);
    expect((err as Error).message).toContain('sessionId must be a non-empty string');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a status outside the closed enum is a GislResponseContractError, not passed through', async () => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data: { session_id: 'cs_1', status: 'refunded' } }));

    const err = await rejection(client().getCheckoutSessionStatus('cs_1'));

    expect(err).toBeInstanceOf(GislResponseContractError);
    expect((err as Error).message).toContain('/api/billing/checkout/cs_1/status');
    expect((err as Error).message).toContain('"refunded"');
  });

  it.each([
    ['a missing status', { session_id: 'cs_1' }],
    ['a non-string session_id', { session_id: 7, status: 'paid' }],
    ['a missing session_id', { status: 'paid' }],
  ])('%s is a GislResponseContractError', async (_label, data) => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data }));

    expect(await rejection(client().getCheckoutSessionStatus('cs_1'))).toBeInstanceOf(GislResponseContractError);
  });

  it('a `data` that is not an object is a GislResponseContractError', async () => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data: ['cs_1', 'paid'] }));

    expect(await rejection(client().getCheckoutSessionStatus('cs_1'))).toBeInstanceOf(GislResponseContractError);
  });

  it('a 2xx that is not JSON is a GislResponseContractError', async () => {
    fetchSpy.mockResolvedValueOnce(rawJson('{not json'));

    expect(await rejection(client().getCheckoutSessionStatus('cs_1'))).toBeInstanceOf(GislResponseContractError);
  });

  // codex fdb108fc77ac: the shared request path returns `undefined` for a 204
  // before any deserialiser runs; the contract allows only a JSON 200 here.
  it('a 204 is a GislResponseContractError, not an undefined result', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(await rejection(client().getCheckoutSessionStatus('cs_1'))).toBeInstanceOf(GislResponseContractError);
  });

  // codex b7a99b89c985: the contract declares only 200 as success here.
  it.each([201, 202, 206])('a %i with a valid JSON body is a GislResponseContractError', async (status) => {
    fetchSpy.mockResolvedValueOnce(json({ success: true, data: { session_id: 'cs_1', status: 'paid' } }, status));

    const err = await rejection(client().getCheckoutSessionStatus('cs_1'));

    expect(err).toBeInstanceOf(GislResponseContractError);
    expect((err as Error).message).toContain(String(status));
  });

  it('a 200 with an empty JSON-typed body is a GislResponseContractError', async () => {
    fetchSpy.mockResolvedValueOnce(rawJson(''));

    expect(await rejection(client().getCheckoutSessionStatus('cs_1'))).toBeInstanceOf(GislResponseContractError);
  });

  it('a 401 goes through the shared mapping', async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ success: false, error: 'AUTHENTICATION_REQUIRED', message: 'Authentication required.' }, 401),
    );

    const err = await rejection(client().getCheckoutSessionStatus('cs_1'));

    expect(err).toBeInstanceOf(GislApiError);
    expect(err).not.toBeInstanceOf(GislResponseContractError);
    expect((err as GislApiError).statusCode).toBe(401);
    expect((err as GislApiError).errorCode).toBe('AUTHENTICATION_REQUIRED');
  });

  it('a router 404 goes through the shared mapping', async () => {
    fetchSpy.mockResolvedValueOnce(json({ success: false, error: 'NOT_FOUND', message: 'Not found.' }, 404));

    const err = await rejection(client().getCheckoutSessionStatus('cs_%FF'));

    expect(err).toBeInstanceOf(GislApiError);
    expect((err as GislApiError).statusCode).toBe(404);
  });

  it('an anonymous client refuses it before any request', async () => {
    const guest = await gisl.anonymous({ baseUrl: 'https://api.example.com' });

    // The gate throws synchronously, so the call is wrapped to observe it.
    const err = await rejection((async () => guest.getCheckoutSessionStatus('cs_1'))());

    expect(err).toBeInstanceOf(GislFeatureRequiresAuthError);
    expect((err as GislFeatureRequiresAuthError).operation).toBe('getCheckoutSessionStatus');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
