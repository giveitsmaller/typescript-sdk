import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { GislAbortError, GislTimeoutError } from '../../src/errors.js';

/**
 * NRXIXye9 — the request timeout and the caller's abort must cover the BODY
 * read, not stop at the response headers. e2e measured `getHealth()` still
 * waiting 1.5 s into a stalled body with a 300 ms timeout.
 *
 * The stalled body below sends headers, then no bytes, and errors only when
 * the request's signal aborts — which is what undici and browsers do to a
 * body whose fetch is aborted mid-read. Against the old code (timer cleared
 * once `fetch` resolved) nothing ever aborts it, so these tests hang until
 * the vitest timeout instead of passing.
 */

const TEST_TIMEOUT_MS = 2000;

function stalledBody(init: RequestInit, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      init.signal?.addEventListener(
        'abort',
        () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          controller.error(abortErr);
        },
        { once: true },
      );
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  );
}

describe('request timeout covers the body read (NRXIXye9)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const client = (timeout = 30): GislClient =>
    new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'sk_live_secret', timeout });

  beforeEach(() => {
    fetchSpy = vi.fn(async (_url: string, init: RequestInit) => stalledBody(init));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('an ordinary JSON method (getAccountLimits) times out on a stalled body', async () => {
    const err = await rejection(client().getAccountLimits());
    expect(err).toBeInstanceOf(GislTimeoutError);
    expect((err as Error).message).toContain('GET /api/v2/account/limits timed out after 30ms');
  }, TEST_TIMEOUT_MS);

  it('a stalled error body (non-2xx JSON) also times out, not maps to an API error', async () => {
    fetchSpy.mockImplementationOnce(async (_url: string, init: RequestInit) => stalledBody(init, 500));
    const err = await rejection(client().getAccountLimits());
    expect(err).toBeInstanceOf(GislTimeoutError);
  }, TEST_TIMEOUT_MS);

  it('getHealth (raw response path) times out on a stalled body', async () => {
    const err = await rejection(client().getHealth());
    expect(err).toBeInstanceOf(GislTimeoutError);
    expect((err as Error).message).toContain('GET /healthz timed out after 30ms');
  }, TEST_TIMEOUT_MS);

  it('getSchema (raw response path) times out on a stalled body', async () => {
    const err = await rejection(client().getSchema());
    expect(err).toBeInstanceOf(GislTimeoutError);
  }, TEST_TIMEOUT_MS);

  it('getSchema times out on a stalled non-2xx body instead of reporting an API error', async () => {
    fetchSpy.mockImplementationOnce(async (_url: string, init: RequestInit) => stalledBody(init, 503));
    const err = await rejection(client().getSchema());
    expect(err).toBeInstanceOf(GislTimeoutError);
  }, TEST_TIMEOUT_MS);

  it("the caller's signal aborting mid-body ends in GislAbortError", async () => {
    const caller = new AbortController();
    fetchSpy.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      setTimeout(() => caller.abort(), 10);
      return stalledBody(init);
    });
    const err = await rejection(client(60_000).getSchema({ signal: caller.signal }));
    expect(err).toBeInstanceOf(GislAbortError);
  }, TEST_TIMEOUT_MS);

  it('a body that arrives in time still succeeds, and nothing aborts afterwards', async () => {
    let seenSignal: AbortSignal | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined;
      return new Response(JSON.stringify({ app: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await expect(client(30).getHealth()).resolves.toEqual({ app: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seenSignal?.aborted).toBe(false);
  }, TEST_TIMEOUT_MS);
});
