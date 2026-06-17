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

  it('422-then-200 → polls then completes (delegates to never-bounce waitForProbe)', async () => {
    fetchSpy.mockResolvedValueOnce(notLanded()).mockResolvedValueOnce(probeOk());
    await client.maybeWaitForVideoProbe(FID, { enabled: true, isVideo: true, sizeBytes: LARGE, timeoutMs: 5000 });
    expect(probeWasHit(fetchSpy)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
});
