import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { gisl } from '../../src/gisl.js';
import {
  GislApiError,
  GislError,
  GislResponseContractError,
  GislTimeoutError,
} from '../../src/errors.js';

/**
 * QB5Lrcjo — `getHealth()`: unauthenticated `GET /healthz` returning the
 * contract's flat `LivenessResponse { app: boolean; build?: string }`.
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

describe('getHealth (QB5Lrcjo)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const keyedClient = (extra: Partial<ConstructorParameters<typeof GislClient>[0]> = {}): GislClient =>
    new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'sk_live_secret', ...extra });

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request', () => {
    it('GETs /healthz with no Authorization header from a keyed client', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true, build: '1.17.0-rc.1' }));

      await keyedClient().getHealth();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/healthz');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      expect(JSON.stringify(headers)).not.toContain('sk_live_secret');
    });

    it('positive control: the same keyed client DOES send Authorization on an authenticated call', async () => {
      // Without this, the test above would pass on a client that never sends a key.
      fetchSpy.mockResolvedValueOnce(json({ success: true, data: { balance: 1 } }));

      await keyedClient().getCreditsBalance();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_live_secret');
    });

    it('strips credential headers passed through `headers`, in any case, and keeps the rest', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true }));

      await keyedClient({
        headers: {
          authorization: 'Bearer from-headers',
          COOKIE: 'gisl_session=abc',
          'x-workflow-capability': 'cap_123',
          'X-Trace': 'kept',
        },
      }).getHealth();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers).map((k) => k.toLowerCase()).sort()).toEqual(['x-trace']);
    });

    it("sends credentials: 'omit' even from a session-cookie client", async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true }));

      await keyedClient({ useSessionCookie: true }).getHealth();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.credentials).toBe('omit');
    });

    it("asks fetch not to follow redirects (redirect: 'manual')", async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true }));

      await keyedClient().getHealth();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.redirect).toBe('manual');
    });

    it('is reachable from an anonymous client', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true }));

      const client = await gisl.anonymous({ baseUrl: 'https://api.example.com' });
      const health = await client.getHealth();

      expect(health).toEqual({ app: true });
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/healthz');
    });
  });

  describe('body', () => {
    it('build present -> returned as sent', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true, build: '1.17.0-rc.1' }));

      expect(await keyedClient().getHealth()).toEqual({ app: true, build: '1.17.0-rc.1' });
    });

    it('build absent -> undefined, and no `build` key at all', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true }));

      const health = await keyedClient().getHealth();
      expect(health.build).toBeUndefined();
      expect(Object.keys(health)).toEqual(['app']);
    });

    it('app: false is a valid answer, not an error', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: false, build: 'dev' }));

      expect(await keyedClient().getHealth()).toEqual({ app: false, build: 'dev' });
    });

    it('fields the contract does not declare are not passed through', async () => {
      fetchSpy.mockResolvedValueOnce(json({ app: true, build: 'unknown', extra: 1 }));

      expect(await keyedClient().getHealth()).toEqual({ app: true, build: 'unknown' });
    });

    it.each([
      ['app missing', '{"build":"1.0.0"}', '`app` must be a boolean'],
      ['app a string', '{"app":"true"}', '`app` must be a boolean'],
      ['app a number', '{"app":1}', '`app` must be a boolean'],
      ['build a number', '{"app":true,"build":117}', '`build`, when present, must be a string'],
      ['build null', '{"app":true,"build":null}', '`build`, when present, must be a string'],
      ['a JSON list', '[{"app":true}]', 'expected a JSON object'],
      ['JSON null', 'null', 'expected a JSON object'],
      ['an envelope', '{"success":true,"data":{"app":true}}', '`app` must be a boolean'],
      ['not JSON', '<html>ok</html>', 'body is not valid JSON'],
    ])('malformed 2xx (%s) -> GislResponseContractError', async (_label, body, detail) => {
      fetchSpy.mockResolvedValueOnce(rawJson(body));

      const err = await rejection(keyedClient().getHealth());
      expect(err).toBeInstanceOf(GislResponseContractError);
      expect((err as GislResponseContractError).operation).toBe('/healthz');
      expect((err as Error).message).toContain(detail);
    });
  });

  describe('redirects', () => {
    it.each([301, 302, 307, 308])('a %i is not followed and throws GislError naming it', async (status) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { status, headers: { Location: 'https://elsewhere.example.net/healthz' } }),
      );

      const err = await rejection(keyedClient().getHealth());
      expect(err).toBeInstanceOf(GislError);
      expect(err).not.toBeInstanceOf(GislApiError);
      expect((err as Error).message).toContain(`answered ${status} (a redirect to host elsewhere.example.net)`);
      expect((err as Error).message).toContain('does not follow redirects');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("a browser's opaqueredirect (status 0) also throws GislError", async () => {
      // What a browser's fetch returns for `redirect: 'manual'`: status and
      // Location are hidden. `new Response()` cannot construct one.
      const opaque = {
        type: 'opaqueredirect',
        status: 0,
        ok: false,
        headers: new Headers(),
      } as unknown as Response;
      fetchSpy.mockResolvedValueOnce(opaque);

      const err = await rejection(keyedClient().getHealth());
      expect(err).toBeInstanceOf(GislError);
      expect((err as Error).message).toContain('with a redirect');
    });
  });

  describe('errors', () => {
    it('non-2xx with an error envelope -> GislApiError through the shared mapping', async () => {
      fetchSpy.mockResolvedValueOnce(
        json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Down for maintenance.' }, 503),
      );

      const err = await rejection(keyedClient().getHealth());
      expect(err).toBeInstanceOf(GislApiError);
      expect((err as GislApiError).statusCode).toBe(503);
      expect((err as GislApiError).errorCode).toBe('SERVICE_UNAVAILABLE');
      expect((err as Error).message).toBe('API error 503 at /healthz: Down for maintenance.');
    });

    it('non-2xx with a non-JSON body -> GislApiError', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/html' } }),
      );

      const err = await rejection(keyedClient().getHealth());
      expect(err).toBeInstanceOf(GislApiError);
      expect((err as GislApiError).statusCode).toBe(502);
    });

    it("the client's timeout applies -> GislTimeoutError", async () => {
      fetchSpy.mockImplementationOnce(async (_url, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true },
          );
        });
      });

      const err = await rejection(keyedClient({ timeout: 10 }).getHealth());
      expect(err).toBeInstanceOf(GislTimeoutError);
      expect((err as Error).message).toContain('GET /healthz timed out after 10ms');
    });
  });
});
