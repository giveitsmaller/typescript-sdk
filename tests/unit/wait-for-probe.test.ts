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
    fetchSpy
      .mockResolvedValueOnce(notLanded())
      .mockResolvedValueOnce(notLanded())
      .mockResolvedValueOnce(probeOk(FID));

    const polls: Array<{ attempt: number; elapsedMs: number }> = [];
    const result = await client.waitForProbe(FID, { timeoutMs: 5000, onPoll: (i) => polls.push(i) });

    expect(result.landed).toBe(true);
    expect(result.probe?.probeStatus).toBe('ok');
    expect(result.reason).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // onPoll fires once per attempt, 1-based, with monotonic elapsedMs.
    expect(polls.map((p) => p.attempt)).toEqual([1, 2, 3]);
    expect(polls[0].elapsedMs).toBeGreaterThanOrEqual(0);
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
    fetchSpy
      .mockResolvedValueOnce(proberCrash())
      .mockResolvedValueOnce(proberCrash())
      .mockResolvedValueOnce(proberCrash());
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(false);
    expect(result.reason).toBe('prober_error');
    // 2 retries allowed → the 3rd 5xx trips give-up.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('a 5xx followed by a 200 still lands (transient prober blip)', async () => {
    fetchSpy.mockResolvedValueOnce(proberCrash()).mockResolvedValueOnce(probeOk(FID));
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up with "prober_error" on repeated transport/network failures (never throws → caller creates anyway)', async () => {
    // A fetch network failure surfaces as a TypeError out of request().
    fetchSpy.mockRejectedValue(new TypeError('network down'));
    const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
    expect(result.landed).toBe(false);
    expect(result.reason).toBe('prober_error');
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 2 retries then give up
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
      fetchSpy
        .mockResolvedValueOnce(probe422('probe_not_ready'))
        .mockResolvedValueOnce(probe422('probe_not_ready'))
        .mockResolvedValueOnce(probeOk(FID));
      const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
      expect(result).toMatchObject({ landed: true });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('(i) probe_not_ready: honours Retry-After before the next poll', async () => {
      // Retry-After: 1 → the second poll waits ~1 s. The jitter backoff on
      // attempt 1 is at most 250 ms, so >= 950 ms can only be the header.
      fetchSpy.mockResolvedValueOnce(probe422('probe_not_ready', '1')).mockResolvedValueOnce(probeOk(FID));
      const start = Date.now();
      const result = await client.waitForProbe(FID, { timeoutMs: 5000 });
      expect(result.landed).toBe(true);
      expect(Date.now() - start).toBeGreaterThanOrEqual(950);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
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

    it('(iii) feature_not_available (transitional) keeps retrying until timeoutMs, its ceiling', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(notLanded()));
      const start = Date.now();
      // 1.5 s: the attempt-1 jitter backoff is at most 250 ms, so a second poll
      // always fits (a 120 ms budget let one long jitter sleep consume it all).
      const result = await client.waitForProbe(FID, { timeoutMs: 1500 });
      expect(result).toEqual({ landed: false, reason: 'timeout' });
      // More than one poll: it RETRIED, it did not treat the arm as terminal.
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
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
