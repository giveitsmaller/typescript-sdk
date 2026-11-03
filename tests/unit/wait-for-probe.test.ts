import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { GislAbortError, GislApiError } from '../../src/errors.js';

/**
 * GislClient.waitForProbe (YOA6FpFr) — the bounded, never-bounce upload-probe
 * poll the Workbench calls between upload-complete and createBatchWorkflow so
 * the server sees a video's codec+duration and admits the ~3x parallel split.
 *
 * Wire contract (API-verified): 422 feature_not_available = not landed → poll;
 * any 200 = stop (any probeStatus); 5xx = retry-then-give-up; timeout =
 * give-up. Never throws on those paths (caller creates anyway). Genuine errors
 * (404, auth) and caller-abort DO throw.
 */

function probeOk(fileId: string, probeStatus = 'ok'): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        file_id: fileId,
        probe_status: probeStatus,
        media_metadata: { duration_seconds: 600, codec: 'h264', container: 'mp4', probed_at: '2026-06-16T10:00:00Z' },
        processing_class_pre_assignment: 'long_form',
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function notLanded(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(
    JSON.stringify({
      success: false,
      error: 'no probe result cached for this upload',
      error_type: 'feature_not_available',
      violations: [{ feature: 'upload.probe', availability: 'planned' }],
    }),
    { status: 422, headers },
  );
}

/** The probe 422's other two arms (contracts tRVvMOvy): a bare ErrorEnvelope + `error_type`. */
function probe422(errorType: 'probe_not_ready' | 'probe_not_applicable', retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(
    JSON.stringify({ success: false, error: 'UNPROCESSABLE_ENTITY', message: 'no probe result', error_type: errorType }),
    { status: 422, headers },
  );
}

function proberCrash(): Response {
  return new Response(JSON.stringify({ success: false, error: 'please retry', error_type: 'internal_error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

function uploadNotFound(): Response {
  return new Response(
    JSON.stringify({ success: false, error: 'upload not found', error_type: 'upload_not_found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

const FID = '019539ab-1111-7000-8000-000000000001';

describe('GislClient.waitForProbe', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls past 422 not-landed and stops on the first 200 (landed: true)', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy
        .mockResolvedValueOnce(notLanded())
        .mockResolvedValueOnce(notLanded())
        .mockResolvedValueOnce(probeOk(FID));

      const polls: Array<{ attempt: number; elapsedMs: number }> = [];
      const waited = client.waitForProbe(FID, { timeoutMs: 5000, onPoll: (i) => polls.push(i) });
      // Two jitter sleeps, at most 249 + 499 ms.
      await vi.advanceTimersByTimeAsync(750);
      const result = await waited;

      expect(result.landed).toBe(true);
      expect(result.probe?.probeStatus).toBe('ok');
      expect(result.reason).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      // onPoll fires once per attempt, 1-based, with monotonic elapsedMs.
      expect(polls.map((p) => p.attempt)).toEqual([1, 2, 3]);
      expect(polls[0].elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on ANY 200 without interpreting probeStatus (e.g. corrupt → still landed)', async () => {
    fetchSpy.mockResolvedValueOnce(probeOk(FID, 'corrupt'));
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(true);
    expect(result.probe?.probeStatus).toBe('corrupt');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up with reason "timeout" when the probe never lands (never throws)', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(notLanded()));
    const result = await client.waitForProbe(FID, { timeoutMs: 30 });
    expect(result.landed).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.probe).toBeUndefined();
  });

  it('retries a couple of 5xx then gives up with reason "prober_error" (never throws)', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy
        .mockResolvedValueOnce(proberCrash())
        .mockResolvedValueOnce(proberCrash())
        .mockResolvedValueOnce(proberCrash());
      const waited = client.waitForProbe(FID, { timeoutMs: 5000 });
      // Two jitter sleeps, at most 249 + 499 ms.
      await vi.advanceTimersByTimeAsync(750);
      const result = await waited;
      expect(result.landed).toBe(false);
      expect(result.reason).toBe('prober_error');
      // 2 retries allowed → the 3rd 5xx trips give-up.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 5xx followed by a 200 still lands (transient prober blip)', async () => {
    fetchSpy.mockResolvedValueOnce(proberCrash()).mockResolvedValueOnce(probeOk(FID));
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up with "prober_error" on repeated transport/network failures (never throws → caller creates anyway)', async () => {
    vi.useFakeTimers();
    try {
      // A fetch network failure surfaces as a TypeError out of request().
      fetchSpy.mockRejectedValue(new TypeError('network down'));
      const waited = client.waitForProbe(FID, { timeoutMs: 5000 });
      // Two jitter sleeps, at most 249 + 499 ms.
      await vi.advanceTimersByTimeAsync(750);
      const result = await waited;
      expect(result.landed).toBe(false);
      expect(result.reason).toBe('prober_error');
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 2 retries then give up
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transient transport failure followed by a 200 still lands', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('blip')).mockResolvedValueOnce(probeOk(FID));
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('PROPAGATES a genuine failure (404 upload_not_found) — does NOT swallow it', async () => {
    fetchSpy.mockResolvedValueOnce(uploadNotFound());
    await expect(client.waitForProbe(FID, { timeoutMs: 5000 })).rejects.toBeInstanceOf(GislApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After but CLAMPS it to the remaining budget (no hour-long wait)', async () => {
    // Retry-After: 3600s, but timeoutMs is 40ms → must clamp + give up fast, not wait an hour.
    fetchSpy.mockImplementation(() => Promise.resolve(notLanded('3600')));
    const start = Date.now();
    const result = await client.waitForProbe(FID, { timeoutMs: 40 });
    expect(result.landed).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(2000); // nowhere near 3600s
  });

  it('throws GislAbortError immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(client.waitForProbe(FID, { signal: ac.signal })).rejects.toBeInstanceOf(GislAbortError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws GislAbortError when aborted mid-wait (during the backoff sleep)', async () => {
    const ac = new AbortController();
    fetchSpy.mockImplementation(() => Promise.resolve(notLanded()));
    // Abort during the first poll's onPoll → the post-422 backoff sleep rejects.
    await expect(
      client.waitForProbe(FID, {
        timeoutMs: 5000,
        onPoll: (i) => {
          if (i.attempt === 1) ac.abort();
        },
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(GislAbortError);
  });

  // --- the probe 422 oneOf (8L4JJMx6, contracts tRVvMOvy) -------------------

  describe('the three 422 arms', () => {
    it('(i) probe_not_ready: keeps polling and lands on the next 200', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy
          .mockResolvedValueOnce(probe422('probe_not_ready'))
          .mockResolvedValueOnce(probe422('probe_not_ready'))
          .mockResolvedValueOnce(probeOk(FID));
        const waited = client.waitForProbe(FID, { timeoutMs: 5000 });
        // Two jitter sleeps, at most 249 + 499 ms.
        await vi.advanceTimersByTimeAsync(750);
        const result = await waited;
        expect(result).toMatchObject({ landed: true });
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('(i) probe_not_ready: honours Retry-After before the next poll', async () => {
      // Retry-After: 1 → the second poll waits exactly 1 s on the fake clock. The
      // jitter backoff on attempt 1 is at most 249 ms, so a second poll still
      // missing at 999 ms can only be the header.
      vi.useFakeTimers();
      try {
        fetchSpy.mockResolvedValueOnce(probe422('probe_not_ready', '1')).mockResolvedValueOnce(probeOk(FID));
        const waited = client.waitForProbe(FID, { timeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(999);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const result = await waited;
        expect(result.landed).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('(i) probe_not_ready never answering: gives up with "timeout", never throws', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(probe422('probe_not_ready')));
      const result = await client.waitForProbe(FID, { timeoutMs: 30 });
      expect(result).toEqual({ landed: false, reason: 'timeout' });
    });

    it('(ii) probe_not_applicable: terminal after ONE request, reason "not_applicable", no throw', async () => {
      // A 200 queued behind it proves no second poll is made.
      fetchSpy.mockResolvedValueOnce(probe422('probe_not_applicable')).mockResolvedValueOnce(probeOk(FID));
      const polls: number[] = [];
      const result = await client.waitForProbe(FID, { timeoutMs: 5000, onPoll: (i) => polls.push(i.attempt) });
      expect(result).toEqual({ landed: false, reason: 'not_applicable' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(polls).toEqual([1]);
    });

    it('(ii) probe_not_applicable is terminal even after not-ready polls, and ignores a stray Retry-After', async () => {
      fetchSpy
        .mockResolvedValueOnce(probe422('probe_not_ready'))
        .mockResolvedValueOnce(probe422('probe_not_applicable', '3600'));
      const start = Date.now();
      const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
      expect(result).toEqual({ landed: false, reason: 'not_applicable' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it('(iii) feature_not_available (older server builds) keeps retrying until timeoutMs, its ceiling', async () => {
      vi.useFakeTimers();
      try {
        fetchSpy.mockImplementation(() => Promise.resolve(notLanded()));
        // 1.5 s: the attempt-1 jitter backoff is at most 249 ms, so a second poll
        // always fits (a 120 ms budget let one long jitter sleep consume it all).
        // The last sleep is clamped to what remains, so whatever the jitter draws
        // the wait ends at exactly 1500 ms on the fake clock.
        let settled = false;
        const waited = client.waitForProbe(FID, { timeoutMs: 1500 }).finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(1_499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        const result = await waited;
        expect(result).toEqual({ landed: false, reason: 'timeout' });
        // More than one poll: it RETRIED, it did not treat the arm as terminal.
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('any OTHER 422 error_type still propagates', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'UNPROCESSABLE_ENTITY', error_type: 'something_else' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(client.waitForProbe(FID, { timeoutMs: 5000 })).rejects.toBeInstanceOf(GislApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a non-422 carrying error_type probe_not_applicable is NOT read as the terminal arm', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: 'BAD_REQUEST', error_type: 'probe_not_applicable' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await expect(client.waitForProbe(FID, { timeoutMs: 5000 })).rejects.toBeInstanceOf(GislApiError);
    });

    it('probeUpload surfaces both new arms as a base GislApiError carrying error_type', async () => {
      fetchSpy.mockResolvedValueOnce(probe422('probe_not_applicable'));
      const err = await client.probeUpload(FID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GislApiError);
      expect((err as GislApiError).statusCode).toBe(422);
      expect((err as GislApiError).payload).toMatchObject({ error_type: 'probe_not_applicable' });
      expect((err as GislApiError).retryable).toBe(false);
    });
  });
});

// --- patient polling (Hal5c41E) ---------------------------------------------
// A signed-in probe_pending recovery may wait up to 900 s; at the default
// 250 ms jitter cadence a Free account's 10/min probe bucket is spent in the
// first seconds. `patient` spaces polls and waits a probe 429 out.

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response(
    JSON.stringify({ success: false, error: 'TOO_MANY_REQUESTS', message: 'Too many requests' }),
    { status: 429, headers },
  );
}

describe('a probe 429 off the wire', () => {
  let client: GislClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a base GislApiError (429, TOO_MANY_REQUESTS) and, without patient, still propagates', async () => {
    fetchSpy.mockResolvedValueOnce(rateLimited('5'));
    const err = await client.waitForProbe(FID, { timeoutMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GislApiError);
    expect(Object.getPrototypeOf(err)).toBe(GislApiError.prototype);
    expect((err as GislApiError).statusCode).toBe(429);
    expect((err as GislApiError).errorCode).toBe('TOO_MANY_REQUESTS');
    expect((err as GislApiError).responseHeaders?.['retry-after']).toBe('5');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/** A not-landed probe answer (`422 probe_not_ready`), as probeUpload throws it. */
function notReadyError(retryAfter?: string): GislApiError {
  return new GislApiError(422, 'no probe result', undefined, undefined, {
    payload: { error_type: 'probe_not_ready' },
    errorCode: 'UNPROCESSABLE_ENTITY',
    responseHeaders: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
}

/** A probe-bucket rate limit, as probeUpload throws it. */
function rateLimitedError(retryAfter?: string): GislApiError {
  return new GislApiError(429, 'Too many requests', undefined, undefined, {
    errorCode: 'TOO_MANY_REQUESTS',
    responseHeaders: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
}

const LANDED_PROBE = { fileId: FID, probeStatus: 'ok' } as unknown as Awaited<ReturnType<GislClient['probeUpload']>>;

describe('GislClient.waitForProbe({ patient: true })', () => {
  let client: GislClient;

  // probeUpload is stubbed (no fetch, no body parsing) so fake timers drive
  // only the wait loop's own sleeps.
  beforeEach(() => {
    vi.useFakeTimers();
    client = new GislClient({ baseUrl: 'https://api.example.com', apiKey: 'test-key' });
  });

  const spyProbe = () => vi.spyOn(client, 'probeUpload');

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Runs one wait to completion under fake timers, recording each poll's elapsed ms. */
  async function run(options: { timeoutMs: number; patient?: boolean }, advanceMs: number) {
    const elapsed: number[] = [];
    const done = client.waitForProbe(FID, { ...options, onPoll: (i) => elapsed.push(i.elapsedMs) });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return { result: await done, elapsed };
  }

  it('spaces polls 3 s doubling to a 30 s cap, from each poll start', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValue(notReadyError());
    const { result, elapsed } = await run({ timeoutMs: 120_000, patient: true }, 120_000);
    expect(result).toEqual({ landed: false, reason: 'timeout' });
    // Gaps 3, 6, 12, 24, then 30, 30 s.
    expect(elapsed).toEqual([0, 3_000, 9_000, 21_000, 45_000, 75_000, 105_000]);
  });

  it('stays inside the 10/min probe bucket in every 60 s window of a 900 s wait', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValue(notReadyError());
    const { result, elapsed } = await run({ timeoutMs: 900_000, patient: true }, 900_000);
    expect(result).toEqual({ landed: false, reason: 'timeout' });
    for (const from of elapsed) {
      expect(elapsed.filter((t) => t >= from && t < from + 60_000).length).toBeLessThanOrEqual(10);
    }
    // ...and inside the 100/h bucket in total.
    expect(elapsed.length).toBeLessThanOrEqual(100);
  });

  it('a Retry-After longer than the backoff sets the gap', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValueOnce(notReadyError('10')).mockResolvedValueOnce(LANDED_PROBE);
    const { result, elapsed } = await run({ timeoutMs: 60_000, patient: true }, 10_000);
    expect(result.landed).toBe(true);
    expect(elapsed).toEqual([0, 10_000]);
  });

  it('a Retry-After shorter than the backoff does not shorten the gap', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValueOnce(notReadyError('1')).mockResolvedValueOnce(LANDED_PROBE);
    const { result, elapsed } = await run({ timeoutMs: 60_000, patient: true }, 3_000);
    expect(result.landed).toBe(true);
    expect(elapsed).toEqual([0, 3_000]);
  });

  it('waits a probe 429 out for its Retry-After, then lands', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValueOnce(rateLimitedError('20')).mockResolvedValueOnce(LANDED_PROBE);
    const { result, elapsed } = await run({ timeoutMs: 60_000, patient: true }, 20_000);
    expect(result).toEqual({ landed: true, probe: LANDED_PROBE });
    expect(elapsed).toEqual([0, 20_000]);
  });

  it('waits a probe 429 with NO Retry-After out with the patient backoff', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValueOnce(rateLimitedError()).mockResolvedValueOnce(LANDED_PROBE);
    const { result, elapsed } = await run({ timeoutMs: 60_000, patient: true }, 3_000);
    expect(result.landed).toBe(true);
    expect(elapsed).toEqual([0, 3_000]);
  });

  it('clamps a probe 429 wait to the budget: gives up with "timeout" at timeoutMs, no second poll', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValue(rateLimitedError('3600'));
    const done = client.waitForProbe(FID, { timeoutMs: 10_000, patient: true });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ landed: false, reason: 'timeout' });
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  it('without patient a probe 429 still propagates (unchanged)', async () => {
    const probeSpy = spyProbe();
    const limited = rateLimitedError('5');
    probeSpy.mockRejectedValueOnce(limited);
    await expect(client.waitForProbe(FID, { timeoutMs: 60_000 })).rejects.toBe(limited);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  it('without patient the cadence is the sub-second jitter backoff (unchanged)', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValueOnce(notReadyError()).mockResolvedValueOnce(LANDED_PROBE);
    // The attempt-1 full-jitter backoff is under 250 ms; a patient wait would need 3 s.
    const { result, elapsed } = await run({ timeoutMs: 60_000 }, 250);
    expect(result.landed).toBe(true);
    expect(elapsed).toHaveLength(2);
    expect(elapsed[1]).toBeLessThan(250);
  });

  it('patient still gives up on repeated 5xx and still propagates a 404', async () => {
    const probeSpy = spyProbe();
    probeSpy.mockRejectedValue(new GislApiError(500, 'boom'));
    const { result } = await run({ timeoutMs: 900_000, patient: true }, 60_000);
    expect(result).toEqual({ landed: false, reason: 'prober_error' });
    probeSpy.mockReset();
    const notFound = new GislApiError(404, 'upload not found');
    probeSpy.mockRejectedValueOnce(notFound);
    await expect(client.waitForProbe(FID, { timeoutMs: 60_000, patient: true })).rejects.toBe(notFound);
  });
});
