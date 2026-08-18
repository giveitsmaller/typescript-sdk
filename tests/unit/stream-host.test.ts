import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GislClient } from '../../src/client.js';
import { create } from '../../src/gisl.js';
import { GislConfigError, GislStreamHostNotDeclaredError } from '../../src/errors.js';

/**
 * Second-host routing, proved FROM THE PUBLIC ENTRY POINT (card `VUozk5Bc`).
 *
 * The SSE stream lives on its own host. Everything here drives `gisl.create()`
 * / `new GislClient()` and asserts on the URL that actually reached `fetch` —
 * not on the resolver in isolation, which could be perfectly correct while the
 * client still sends the stream to the API host.
 *
 * The load-bearing assertions are the NEGATIVE ones: that a non-stream call
 * does NOT move, and that an undeclared stream host does NOT quietly become
 * `baseUrl`. A test that only checked "the stream goes to the stream host"
 * would pass just as happily on an implementation that sent EVERYTHING there.
 */

const STAGING_API = 'https://api.staging.giveitsmaller.com';
const STAGING_STREAM = 'https://stream.staging.giveitsmaller.com';

function sseResponse(body = ''): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A COMPLETE workflow-status payload. The generated deserialiser treats
 * `jobs`, `created_at` and `updated_at` as required and dereferences them
 * unguarded, so a partial fixture throws inside the model rather than
 * failing the assertion — which reads as a bug in the code under test.
 * Wire keys are snake_case: `streamEvents` yields raw wire data.
 */
function statusResponse(): Response {
  return jsonResponse({
    workflow_id: 'wf_1',
    status: 'completed',
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:01Z',
    jobs: [],
  });
}

const ENDPOINT_ENV_VARS = ['GISL_STREAM_BASE_URL', 'GISL_ENVIRONMENT', 'GISL_BASE_URL'] as const;

describe('SSE stream host (VUozk5Bc)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // SNAPSHOT then clear. The env-var arm of the resolver must not read the
    // developer's shell — but deleting without restoring leaks into whatever
    // runs next in this worker, and the last test here deliberately sets
    // GISL_ENVIRONMENT=prod. A test that contaminates its neighbours is a
    // worse instrument than the ambient value it was avoiding.
    savedEnv = {};
    for (const name of ENDPOINT_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENDPOINT_ENV_VARS) {
      const original = savedEnv[name];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    vi.restoreAllMocks();
  });

  function requestedUrls(): string[] {
    return fetchSpy.mock.calls.map((call) => call[0] as string);
  }

  // -----------------------------------------------------------------------
  // The stream moves, and ONLY the stream moves
  // -----------------------------------------------------------------------

  it('sends streamEvents to the declared stream host', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse());
    const client = await create({ apiKey: 'k', environment: 'staging' });

    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual([`${STAGING_STREAM}/api/workflows/wf_1/events`]);
  });

  it('leaves every NON-stream call on the API host', async () => {
    fetchSpy.mockResolvedValue(statusResponse());
    const client = await create({ apiKey: 'k', environment: 'staging' });

    await client.getWorkflowStatus('wf_1');

    // The whole point of a second SLOT rather than a second baseUrl: this call
    // must be untouched. If it moved, a caller overriding the stream would have
    // silently redirected their uploads too.
    expect(requestedUrls()).toEqual([`${STAGING_API}/api/workflows/wf_1/status`]);
    expect(requestedUrls()[0]).not.toContain('stream.');
  });

  it('routes the stream and a status call to DIFFERENT hosts in one session', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse()).mockResolvedValueOnce(statusResponse());
    const client = await create({ apiKey: 'k', environment: 'staging' });

    await client.streamEvents('wf_1');
    await client.getWorkflowStatus('wf_1');

    const [streamUrl, statusUrl] = requestedUrls();
    expect(streamUrl.startsWith(STAGING_STREAM)).toBe(true);
    expect(statusUrl.startsWith(STAGING_API)).toBe(true);
    expect(new URL(streamUrl).host).not.toBe(new URL(statusUrl).host);
  });

  // -----------------------------------------------------------------------
  // Fail closed — the control this card exists for
  // -----------------------------------------------------------------------

  it('throws rather than falling back to baseUrl when no stream host is declared', async () => {
    // `prod` has no declared stream host: the contract's stream `servers` block
    // carries localhost + staging only. This is THE case that must not silently
    // reuse the API host.
    const client = await create({ apiKey: 'k', environment: 'prod' });

    await expect(client.streamEvents('wf_1')).rejects.toThrow(GislStreamHostNotDeclaredError);
    // No I/O at all — the guard runs before the request is built.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names what the caller can actually do about it', async () => {
    const client = await create({ apiKey: 'k', environment: 'prod' });

    await expect(client.streamEvents('wf_1')).rejects.toThrow(/streamBaseUrl/);
    await expect(client.streamEvents('wf_1')).rejects.toThrow(/GISL_STREAM_BASE_URL/);
    // Says which environments DO work, not merely that this one does not.
    await expect(client.streamEvents('wf_1')).rejects.toThrow(/staging/);
  });

  it('is catchable as GislConfigError', async () => {
    const client = await create({ apiKey: 'k', environment: 'prod' });

    // Subclassing matters: a consumer with an existing `catch (GislConfigError)`
    // should not need to learn a new type to keep working.
    await expect(client.streamEvents('wf_1')).rejects.toBeInstanceOf(GislConfigError);
  });

  it('does not derive a stream host from an api.* baseUrl', async () => {
    // The banned behaviour, stated as a test. Passing `baseUrl` alone gives the
    // SDK everything it would need to guess `stream.staging…` by string
    // surgery — and it must still refuse.
    const client = new GislClient({ baseUrl: STAGING_API, apiKey: 'k' });

    await expect(client.streamEvents('wf_1')).rejects.toThrow(GislStreamHostNotDeclaredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Explicit override
  // -----------------------------------------------------------------------

  it('honours an explicit streamBaseUrl over the environment table', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse());
    const client = await create({
      apiKey: 'k',
      environment: 'staging',
      streamBaseUrl: 'https://stream.example.test',
    });

    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual(['https://stream.example.test/api/workflows/wf_1/events']);
  });

  it('lets an explicit streamBaseUrl rescue a configuration with no declared host', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse());
    const client = await create({
      apiKey: 'k',
      environment: 'prod',
      streamBaseUrl: 'https://stream.example.test',
    });

    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual(['https://stream.example.test/api/workflows/wf_1/events']);
  });

  it('strips a trailing slash so the path is not double-separated', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse());
    const client = new GislClient({
      baseUrl: STAGING_API,
      apiKey: 'k',
      streamBaseUrl: 'https://stream.example.test/',
    });

    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual(['https://stream.example.test/api/workflows/wf_1/events']);
  });

  it('rejects a present-but-malformed streamBaseUrl instead of degrading to absent', () => {
    // codex 5114556a46a2: `'/'` passed the old non-empty check and then
    // normalised to `''`, so the stream URL became RELATIVE — neither the host
    // the caller asked for nor a fail-closed refusal. A value the caller
    // supplied and got wrong must not be quietly reclassified as "nobody
    // declared one", which would hand them a poll they never asked for.
    for (const bad of ['/', '//', 'stream.example.com', '/api', 'ftp://stream.example.com']) {
      expect(
        () => new GislClient({ baseUrl: STAGING_API, apiKey: 'k', streamBaseUrl: bad }),
        `expected ${JSON.stringify(bad)} to be rejected`,
      ).toThrow(GislConfigError);
    }
  });

  it('treats a whitespace-only streamBaseUrl as unset, not as malformed', async () => {
    // '' and '   ' are indistinguishable in intent, so they take the SAME path:
    // unset. That path is still fail-closed — streamEvents refuses — it just
    // refuses at the stream call rather than at construction.
    const client = new GislClient({ baseUrl: STAGING_API, apiKey: 'k', streamBaseUrl: '   ' });

    await expect(client.streamEvents('wf_1')).rejects.toThrow(GislStreamHostNotDeclaredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a stream host carrying a query or fragment', () => {
    // codex 5793a3be0f7b: the events path is appended as a STRING, so
    // `https://host?token=x` would request `/` with the whole events path
    // buried inside the query value — a misroute that looks like a valid URL.
    for (const bad of ['https://stream.example.test?token=x', 'https://stream.example.test#frag']) {
      expect(
        () => new GislClient({ baseUrl: STAGING_API, apiKey: 'k', streamBaseUrl: bad }),
        `expected ${JSON.stringify(bad)} to be rejected`,
      ).toThrow(GislConfigError);
    }
  });

  it('does not let a whitespace-only override suppress the environment host', async () => {
    // codex a7f5ec9f0d32: the resolver used to count '   ' as "supplied",
    // which SHADOWED staging's declared host and then normalised to nothing —
    // silently disabling a stream that was perfectly well declared.
    fetchSpy.mockResolvedValueOnce(sseResponse());
    const client = await create({ apiKey: 'k', environment: 'staging', streamBaseUrl: '   ' });

    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual([`${STAGING_STREAM}/api/workflows/wf_1/events`]);
  });

  it('accepts an absolute http(s) stream host', () => {
    for (const good of ['https://stream.example.test', 'http://localhost:8080']) {
      expect(
        () => new GislClient({ baseUrl: STAGING_API, apiKey: 'k', streamBaseUrl: good }),
      ).not.toThrow();
    }
  });

  it('treats an empty streamBaseUrl as absent, not as a declared empty host', async () => {
    const client = new GislClient({ baseUrl: STAGING_API, apiKey: 'k', streamBaseUrl: '' });

    // An empty string must not resolve to a relative URL against the API host —
    // that is a silent fallback wearing different clothes.
    await expect(client.streamEvents('wf_1')).rejects.toThrow(GislStreamHostNotDeclaredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Environment variable
  // -----------------------------------------------------------------------

  it('resolves the stream host from GISL_STREAM_BASE_URL', async () => {
    process.env.GISL_STREAM_BASE_URL = 'https://stream.env.test';
    fetchSpy.mockResolvedValueOnce(sseResponse());

    const client = await create({ apiKey: 'k', baseUrl: STAGING_API });
    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual(['https://stream.env.test/api/workflows/wf_1/events']);
  });

  it('lets an explicit environment win over GISL_STREAM_BASE_URL', async () => {
    process.env.GISL_STREAM_BASE_URL = 'https://stream.env.test';
    fetchSpy.mockResolvedValueOnce(sseResponse());

    const client = await create({ apiKey: 'k', environment: 'staging' });
    await client.streamEvents('wf_1');

    // Same precedence shape as resolveEndpoint: a code-level argument outranks
    // ambient environment configuration.
    expect(requestedUrls()).toEqual([`${STAGING_STREAM}/api/workflows/wf_1/events`]);
  });

  it('resolves the stream host from a GISL_ENVIRONMENT name', async () => {
    process.env.GISL_ENVIRONMENT = 'staging';
    fetchSpy.mockResolvedValueOnce(sseResponse());

    const client = await create({ apiKey: 'k' });
    await client.streamEvents('wf_1');

    expect(requestedUrls()).toEqual([`${STAGING_STREAM}/api/workflows/wf_1/events`]);
  });

  it('fails closed when GISL_ENVIRONMENT names an environment with no stream host', async () => {
    process.env.GISL_ENVIRONMENT = 'prod';

    const client = await create({ apiKey: 'k' });

    await expect(client.streamEvents('wf_1')).rejects.toThrow(GislStreamHostNotDeclaredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
