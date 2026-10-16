import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';

/**
 * GislClient.maybeWaitForVideoProbe (YOA6FpFr PR2) — the best-effort
 * probe-before-create gate the ergonomic upload→create seams call right before
 * createWorkflow. It is a NO-OP unless:
 *   enabled && isVideo && sizeBytes !== undefined && sizeBytes > multipartThreshold
 * Otherwise it delegates to the never-bounce `waitForProbe` (which hits
 * POST /api/uploads/{id}/probe). Same fetch-spy harness as wait-for-probe.test.ts.
 *
 * The default multipart threshold == SINGLE_SHOT_MAX_BYTES = 10_000_000, so a
 * sub-10MB upload never probes; a >10MB video upload does.
 */

const FID = '019539ab-1111-7000-8000-000000000001';
const SMALL = 5_000_000; // <= 10MB threshold → no probe
const LARGE = 20_000_000; // > 10MB threshold → probe (it went multipart)

function probeOk(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        file_id: FID,
        probe_status: 'ok',
        media_metadata: { duration_seconds: 600, codec: 'h264', container: 'mp4', probed_at: '2026-06-16T10:00:00Z' },
        processing_class_pre_assignment: 'long_form',
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function notLanded(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'no probe result cached for this upload',
      error_type: 'feature_not_available',
      violations: [{ feature: 'upload.probe', availability: 'planned' }],
    }),
    { status: 422, headers: { 'Content-Type': 'application/json' } },
  );
}

/** The probe endpoint the gate hits when it does NOT short-circuit. */
function probeWasHit(fetchSpy: ReturnType<typeof vi.fn>): boolean {
  return fetchSpy.mock.calls.some(
    (call) => typeof call[0] === 'string' && call[0].includes(`/api/uploads/${FID}/probe`),
  );
}

describe('GislClient.maybeWaitForVideoProbe', () => {
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

  // --- no-op short-circuits (never touch the probe endpoint) ---------------

  it('enabled:false → NO probe HTTP call, returns immediately', async () => {
    await client.maybeWaitForVideoProbe(FID, { enabled: false, isVideo: true, sizeBytes: LARGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('isVideo:false → NO probe HTTP call', async () => {
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: false, sizeBytes: LARGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sizeBytes <= multipart threshold → NO probe HTTP call (single-shot video)', async () => {
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: SMALL });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sizeBytes exactly AT the threshold (10_000_000) → NO probe (boundary is <=)', async () => {
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: 10_000_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sizeBytes undefined (e.g. pre-uploaded id) → NO probe HTTP call', async () => {
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- the gate fires: enabled + video + over-threshold --------------------

  it('enabled + video + sizeBytes > threshold → DOES probe; a 200 completes', async () => {
    fetchSpy.mockResolvedValueOnce(probeOk());
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE });
    expect(probeWasHit(fetchSpy)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('hits the probe endpoint with a POST (delegates to waitForProbe → probeUpload)', async () => {
    fetchSpy.mockResolvedValueOnce(probeOk());
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE });
    const probeCall = fetchSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/probe'),
    );
    expect(probeCall).toBeDefined();
    expect(probeCall?.[0]).toBe(`https://api.example.com/api/uploads/${FID}/probe`);
    expect((probeCall?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('422-then-200 → polls then completes, the second poll a patient 3 s later (delegates to never-bounce waitForProbe)', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockResolvedValueOnce(notLanded()).mockResolvedValueOnce(probeOk());
      const done = client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(probeWasHit(fetchSpy)).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never-bounce: video+multipart but probe always 422 + tiny timeout → returns void without throwing', async () => {
    // mockImplementation (NOT mockResolvedValue): waitForProbe POLLS, so each poll
    // needs a FRESH Response — a single reused Response has its body consumed after
    // the first read, so the 2nd poll would see "Invalid JSON" and lose the 422
    // feature_not_available signal (a latent flake surfaced by poll timing).
    fetchSpy.mockImplementation(() => Promise.resolve(notLanded()));
    // A give-up resolves silently (returns void) — the caller creates anyway.
    await expect(
      client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 30 }),
    ).resolves.toBeUndefined();
    expect(probeWasHit(fetchSpy)).toBe(true);
  });

  it('a probe_not_applicable 422 returns after ONE probe request, no throw (never-bounce, 8L4JJMx6)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'UNPROCESSABLE_ENTITY', error_type: 'probe_not_applicable' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // --- patient polling (QDhKs5xv) -------------------------------------------
  // The probe endpoint allows a Free account 10 polls/min. Without `patient`
  // this wait polled ~20/min and a probe 429 failed the run before create.

  describe('polls patiently', () => {
    function rateLimited(): Response {
      return new Response(
        JSON.stringify({ success: false, error: 'TOO_MANY_REQUESTS', message: 'Too many requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '20' } },
      );
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a probe that never lands stays within 10 polls in any 60 s window', async () => {
      const pollTimes: number[] = [];
      const start = Date.now();
      fetchSpy.mockImplementation(() => {
        pollTimes.push(Date.now() - start);
        return Promise.resolve(notLanded());
      });
      const done = client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 120_000 });
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(done).resolves.toBeUndefined();
      // Gaps 3, 6, 12, 24, then 30, 30 s.
      expect(pollTimes).toEqual([0, 3_000, 9_000, 21_000, 45_000, 75_000, 105_000]);
      for (const from of pollTimes) {
        expect(pollTimes.filter((t) => t >= from && t < from + 60_000).length).toBeLessThanOrEqual(10);
      }
    });

    it('the live not-ready answer (probe_not_ready, Retry-After: 3) no longer sets a 3 s cadence', async () => {
      // The api answers a not-yet-probed upload with probe_not_ready and Retry-After: 3.
      // Honoured as the whole gap, that was 20 polls a minute.
      const pollTimes: number[] = [];
      const start = Date.now();
      fetchSpy.mockImplementation(() => {
        pollTimes.push(Date.now() - start);
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, error: 'UNPROCESSABLE_ENTITY', error_type: 'probe_not_ready' }), {
            status: 422,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
          }),
        );
      });
      const done = client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 120_000 });
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(done).resolves.toBeUndefined();
      expect(pollTimes).toEqual([0, 3_000, 9_000, 21_000, 45_000, 75_000, 105_000]);
    });

    it('a probe 429 is waited out for its Retry-After and does not fail the call', async () => {
      fetchSpy.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(probeOk());
      const done = client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(done).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
