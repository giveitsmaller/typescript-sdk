import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationBuilder } from '../../src/builder.js';
import { GislTimeoutError } from '../../src/errors.js';
import { MergeBuilder } from '../../src/merge.js';
import { asset } from '../../src/merge.js';
import { DEFAULT_POLL_TIMEOUT_MS } from '../../src/client.js';
import type { GislClient } from '../../src/client.js';

/**
 * 36AZ98FV — the operation-first path used to demand arguments the file-first
 * path did not, and the reason given for that was refuted by the SDK itself.
 *
 * `RunOptions.maxWait` was mandatory because the poll path's 600s default
 * "would otherwise leak silently" — while the same tree applied exactly that
 * default at FOURTEEN sites across both SDKs, and both languages had already
 * NAMED the number in a constant and hard-coded the literal beside it anyway.
 *
 * These tests pin the resolution: one deadline policy, one shared constant,
 * and the two spellings of the same task behaving identically.
 */

interface Mock {
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  client: GislClient;
}

function makeMockClient(): Mock {
  const uploadFile = vi.fn(async () => ({
    fileId: 'file_1',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({
    workflowId: 'wf_1',
    status: 'running',
    webhookSecret: 'wh_secret_abc',
  }));
  const getWorkflowStatus = vi.fn(async () => ({
    workflowId: 'wf_1',
    status: 'completed',
    createdAt: '2026-09-11T09:00:00Z',
    updatedAt: '2026-09-11T09:05:00Z',
    jobs: [{ jobId: 'job_1', ref: 'op', status: 'completed' }],
  }));
  const getWorkflowDownloads = vi.fn(async () => ({
    downloads: [
      {
        jobId: 'job_1',
        ref: 'op',
        files: [
          {
            operation: 'compress',
            operationId: 'opid_1',
            filename: 'photo_compressed.jpg',
            sizeBytes: 512,
            downloadUrl: 'https://signed.example.com/photo_compressed.jpg',
          },
        ],
      },
    ],
  }));
  const streamEvents = vi.fn(async function* () {
    return;
    // eslint-disable-next-line no-unreachable
    yield;
  });
  const maybeWaitForVideoProbe = vi.fn(async () => undefined);
  const client = {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
    maybeWaitForVideoProbe,
  } as unknown as GislClient;
  return { createWorkflow, getWorkflowStatus, client };
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('36AZ98FV — operation-first run() takes no required arguments', () => {
  it('OperationBuilder.run() resolves with no options at all', async () => {
    const mock = makeMockClient();
    const result = await new OperationBuilder(mock.client, 'compress', 'photo.jpg', {}).run();
    expect(result.workflowId).toBe('wf_1');
  });

  it('MergeBuilder.run() resolves with no options at all', async () => {
    // ⚠️ VIDEO inputs on purpose: an IMAGE merge legitimately requires an explicit
    // `output_type`, so an image fixture would fail on merge validation and tell us
    // nothing about the deadline default this test exists to pin.
    const mock = makeMockClient();
    const result = await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {}).run();
    expect(result.workflowId).toBe('wf_1');
  });

  it.each([
    ['OperationBuilder', (c: GislClient) => new OperationBuilder(c, 'compress', 'photo.jpg', {})],
    ['MergeBuilder', (c: GislClient) => new MergeBuilder(c, [asset('a.mp4'), asset('b.mp4')], {})],
  ])('%s gives up after exactly the shared default when none is given', async (_name, make) => {
    // 🔴 THIS TEST HAS BEEN WRONG TWICE, AND BOTH WAYS ARE WORTH NAMING.
    // v1 had the mock assign the expected value to itself, so it asserted nothing.
    // v2 asserted a BAND — `>= t0 + DEFAULT` and `< t0 + 2*DEFAULT` — which a
    // 900_000 ms regression sails through while the test is named "exactly"
    // (codex db5163b4e10a).
    //
    // A COUNT is exact where a range is not: each poll advances the clock by a
    // known tenth of the budget, so the run can only poll ELEVEN times before the
    // deadline passes. A 900_000 default would permit sixteen.
    const mock = makeMockClient();
    const t0 = 1_757_000_000_000;
    const step = DEFAULT_POLL_TIMEOUT_MS / 10;
    let now = t0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    let polls = 0;
    mock.getWorkflowStatus.mockImplementation(async () => {
      polls += 1;
      now += step;
      return {
        workflowId: 'wf_1',
        status: 'running',
        createdAt: '2026-09-11T09:00:00Z',
        updatedAt: '2026-09-11T09:00:00Z',
        jobs: [{ jobId: 'job_1', ref: 'op', status: 'running' }],
      };
    });

    await expect(
      make(mock.client).run({ useSSE: false, pollIntervalMs: 1 }),
    ).rejects.toThrow(GislTimeoutError);

    expect(polls, `${_name} polled ${polls} times; the shared default allows exactly 10`).toBe(10);
  });
});

describe('36AZ98FV — submit() without a webhook returns a USABLE handle', () => {
  it('omits callback_url from the payload when no webhook is given', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'photo.jpg', {}).submit();

    const payload = mock.createWorkflow.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toBeDefined();
    // 🔴 KEY PRESENCE, not value. `expect(payload['callback_url']).toBeUndefined()`
    // passes whether the key is absent OR present-with-undefined, so it could not
    // tell the fix from the defect (codex 4763eb48189a).
    expect('callback_url' in payload).toBe(false);
    expect('callbackUrl' in payload).toBe(false);
  });

  it('binds the client, so status() does NOT throw no_client — the point of D2', async () => {
    // 🔴 THE REGRESSION GUARD. An unbound handle is why `webhook` was mandatory:
    // status()/wait()/result() threw `no_client`, so the webhook was the only
    // channel for the outcome. Making the webhook optional WITHOUT this binding
    // would ship a call that succeeds and returns something unusable.
    const mock = makeMockClient();
    const handle = await new OperationBuilder(mock.client, 'compress', 'photo.jpg', {}).submit();
    await expect(handle.status()).resolves.toBeDefined();
  });

  it('binds the client on the MERGE path too — shared SubmitOptions, same defect', async () => {
    const mock = makeMockClient();
    const handle = await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {}).submit();
    await expect(handle.status()).resolves.toBeDefined();
  });
});

describe('36AZ98FV — the two spellings agree', () => {
  it('both entry points default to the same deadline constant', () => {
    // ⚠️ NARROWER THAN THE TICKET'S AC ON PURPOSE, AND SAYING SO.
    //
    // The AC asks that the two spellings produce the same wire payload (modulo
    // the sole-job `id`, a divergence that predates this ticket). That assertion
    // needs `gisl()`, which pulls `file-first.ts`, whose module initialisation
    // reads contracts metadata the ROOT-OWNED local `node_modules` does not
    // carry — so it cannot run under a bare local vitest, only in the container
    // `make project/test` uses. Rather than write a payload test that passes
    // locally for the wrong reason, this pins the part that IS checkable
    // everywhere: both paths read one constant, so neither can drift alone.
    //
    // The payload-equality assertion belongs with the parity suite, which already
    // runs in the container. Tracked rather than silently dropped.
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(600_000);
  });
});
