import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MergeBuilder, asset, clip, handle } from '../../src/merge.js';
import {
  GislConfigError,
  GislError,
  GislPerInputOptionsNotSupportedError,
  GislUndeclaredAssetError,
  GislUnusedAssetError,
} from '../../src/errors.js';
import type { GislClient } from '../../src/client.js';

let fetchSpy: ReturnType<typeof vi.fn>;

function makeMockClient(): {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  client: GislClient;
} {
  // Each uploadFile call returns a unique file_id derived from a counter so
  // the merge payload can be inspected to confirm dedupe-on-upload.
  let counter = 0;
  const uploadFile = vi.fn(async (_input: unknown) => {
    counter += 1;
    return { fileId: `file_${counter}`, contentType: 'video/mp4', sizeBytes: 1000 };
  });
  const createWorkflow = vi.fn(async (_payload: unknown) => ({
    workflowId: 'wf_merge',
    status: 'running',
    webhookSecret: null,
  }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_merge',
    status: 'completed',
    createdAt: new Date('2026-05-23T09:00:00.000Z'),
    jobs: [{ jobId: 'job_merge', ref: 'merge', status: 'completed', operations: [] }],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      {
        jobId: 'job_merge',
        ref: 'merge',
        files: [
          {
            operation: 'merge',
            operationId: 'opid_merge_1',
            filename: 'merged.mp4',
            sizeBytes: 5000,
            downloadUrl: 'https://signed.example.com/merged.mp4',
          },
        ],
      },
    ],
  }));
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
    return;
    // eslint-disable-next-line no-unreachable
    yield;
  });
  const client = {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
  } as unknown as GislClient;
  return { uploadFile, createWorkflow, getWorkflowStatus, getWorkflowDownloads, streamEvents, client };
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('MergeBuilder — simple concat (no .sequence)', () => {
  it('uploads each declared asset once + builds a single merge job with inputs[]', async () => {
    const mock = makeMockClient();
    const m = new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4'), asset('c.mp4')], {});
    await m.run({ maxWait: '30s' });
    expect(mock.uploadFile).toHaveBeenCalledTimes(3);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].id).toBe('merge');
    expect(payload.jobs[0].operations[0].type).toBe('merge');
    expect(payload.jobs[0].inputs).toHaveLength(3);
    // Inputs go in declared order when no .sequence is set.
    expect(payload.jobs[0].inputs[0].source.type).toBe('upload');
  });

  it('honours merge-level transition + crossfadeDuration on a video merge', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      transition: 'crossfade',
      crossfadeDuration: 1.0,
      normalizeAudio: true,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].operations[0].options).toMatchObject({
      transition: 'crossfade',
      crossfade_duration: 1.0,
      normalize_audio: true,
    });
  });

  it('targetSize accepts a number AND a "100MB" string suffix', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      targetSize: '100MB',
      codec: 'h264',
    }).run({ maxWait: '30s' });
    const opts = mock.createWorkflow.mock.calls[0][0].jobs[0].operations[0].options;
    expect(opts.target_size_bytes).toBe(100_000_000);
    expect(opts.encoding_mode).toBe('target_size');
    expect(opts.codec).toBe('h264');
  });
});

describe('MergeBuilder — .sequence with reuse', () => {
  it('uploads X exactly ONCE even when referenced 3× in .sequence (dedupe by path)', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const c = asset('c.mp4');
    const x = asset('bumper.mp4');
    await new MergeBuilder(mock.client, [a, b, c, x], {})
      .sequence(a, x, b, x, c, x)
      .run({ maxWait: '30s' });
    // 4 unique declared assets → 4 uploads (NOT 6 even though X appears 3× in sequence).
    expect(mock.uploadFile).toHaveBeenCalledTimes(4);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].inputs).toHaveLength(6);
  });

  it('uploads each handle ZERO times — handle assets bypass upload entirely', async () => {
    const mock = makeMockClient();
    const a = handle('pre_uploaded_file_xyz');
    const b = asset('b.mp4');
    await new MergeBuilder(mock.client, [a, b], {}).run({ maxWait: '30s' });
    // Only `b` gets uploaded; `a` was already uploaded out of band.
    expect(mock.uploadFile).toHaveBeenCalledTimes(1);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs[0].inputs).toHaveLength(2);
  });

  it('emits per_input_options on EACH JobInputV2Payload with per-position transitions (wire-truth)', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const x = asset('bumper.mp4');
    await new MergeBuilder(mock.client, [a, b, x], {})
      .sequence(
        a,
        clip(x, { transition: 'fade' }),
        b,
        clip(x),
      )
      .run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    // Codex r1 HIGH 502c6bf232c2 — per_input_options goes on each input
    // entry, NOT job-level operations.options.
    expect(payload.jobs[0].operations[0].options.per_input_options).toBeUndefined();
    expect(payload.jobs[0].inputs[0].per_input_options).toBeUndefined();
    expect(payload.jobs[0].inputs[1].per_input_options).toEqual({ transition: 'fade' });
    expect(payload.jobs[0].inputs[2].per_input_options).toBeUndefined();
    expect(payload.jobs[0].inputs[3].per_input_options).toBeUndefined();
  });

  it('emits gap_duration on audio merge per-input options ONLY (video merges DO NOT carry it)', async () => {
    const mock = makeMockClient();
    // Audio merge — gap_duration projects through.
    const t1 = asset('t1.mp3');
    const sting = asset('sting.wav');
    const t2 = asset('t2.mp3');
    await new MergeBuilder(mock.client, [t1, sting, t2], { transition: 'crossfade' })
      .sequence(t1, clip(sting, { transition: 'crossfade', gapDuration: 0.5 }), t2, clip(sting))
      .run({ maxWait: '30s' });
    const audioPayload = mock.createWorkflow.mock.calls[0][0];
    expect(audioPayload.jobs[0].inputs[1].per_input_options).toEqual({
      transition: 'crossfade',
      gap_duration: 0.5,
    });
    // Video merge — codex r1 medium 128404fa16a9 — gapDuration MUST NOT
    // leak into the video per-input options (wire-truth: MergeVideoPerInputOptions
    // has transition + crossfade_duration only).
    const mock2 = makeMockClient();
    const v1 = asset('v1.mp4');
    const v2 = asset('v2.mp4');
    await new MergeBuilder(mock2.client, [v1, v2], {})
      .sequence(v1, clip(v2, { transition: 'crossfade', gapDuration: 0.5 }))
      .run({ maxWait: '30s' });
    const videoPayload = mock2.createWorkflow.mock.calls[0][0];
    expect(videoPayload.jobs[0].inputs[1].per_input_options).toEqual({
      transition: 'crossfade',
    });
    expect(videoPayload.jobs[0].inputs[1].per_input_options?.gap_duration).toBeUndefined();
  });

  it('image merge with bare-clip reuse (no per-input opts) does NOT emit per_input_options', async () => {
    const mock = makeMockClient();
    const p1 = asset('1.jpg');
    const div = asset('divider.png');
    const p2 = asset('2.jpg');
    await new MergeBuilder(mock.client, [p1, div, p2], {
      output: 'video',
      videoFormat: 'mp4',
      transition: 'fade',
      transitionDuration: 0.4,
    })
      .sequence(p1, div, p2, div)
      .run({ maxWait: '30s' });
    const opts = mock.createWorkflow.mock.calls[0][0].jobs[0].operations[0].options;
    // Merge-level transition propagates; per_input_options is NOT set on image merges.
    expect(opts.transition).toBe('fade');
    expect(opts.per_input_options).toBeUndefined();
  });
});

describe('MergeBuilder — local validation (BEFORE any upload)', () => {
  it('throws GislUndeclaredAssetError when .sequence references an undeclared asset', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const c = asset('c.mp4'); // not declared
    const pending = new MergeBuilder(mock.client, [a, b], {})
      .sequence(a, c)
      .run({ maxWait: '30s' });
    await expect(pending).rejects.toBeInstanceOf(GislUndeclaredAssetError);
    let thrown: unknown;
    try {
      await new MergeBuilder(mock.client, [a, b], {}).sequence(a, c).run({ maxWait: '30s' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GislConfigError);
    expect(thrown).toBeInstanceOf(GislError);
    // Fail-early: NO uploads happened.
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('throws GislUnusedAssetError when a declared asset is never sequenced', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const pending = new MergeBuilder(mock.client, [a, b], {})
      .sequence(a)
      .run({ maxWait: '30s' });
    await expect(pending).rejects.toBeInstanceOf(GislUnusedAssetError);
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('allowUnusedAssets: true bypasses the unused-check AND skips uploading unsequenced assets', async () => {
    // Codex r1 medium edb1bb641d81 — when allowUnusedAssets: true, only the
    // SEQUENCED assets are uploaded; unsequenced declared assets are NOT
    // uploaded (otherwise we waste bandwidth on files the workflow never
    // references). But we still need at least 2 inputs in the sequence
    // to satisfy merge's min_inputs requirement, so this test uses 3+1.
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const unused = asset('unused.mp4'); // declared but never sequenced
    await new MergeBuilder(mock.client, [a, b, unused], { allowUnusedAssets: true })
      .sequence(a, b)
      .run({ maxWait: '30s' });
    // Only `a` and `b` get uploaded — `unused.mp4` was filtered out by
    // the upload-set restriction.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('throws GislConfigError when sequence has <2 inputs (merge min_inputs: 2)', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    // 1-input sequence — violates min_inputs.
    const pending = new MergeBuilder(mock.client, [a, b], { allowUnusedAssets: true })
      .sequence(a)
      .run({ maxWait: '30s' });
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/at least 2/) });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('throws GislConfigError when sequence has >10 inputs (merge max_inputs: 10)', async () => {
    const mock = makeMockClient();
    const assets = Array.from({ length: 11 }, (_, i) => asset(`v${i}.mp4`));
    const pending = new MergeBuilder(mock.client, assets, {}).run({ maxWait: '30s' });
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/at most 10/) });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('throws GislPerInputOptionsNotSupportedError on image-merge clip-with-opts', async () => {
    const mock = makeMockClient();
    const p1 = asset('1.jpg');
    const p2 = asset('2.jpg');
    const pending = new MergeBuilder(mock.client, [p1, p2], { output: 'video', videoFormat: 'mp4' })
      .sequence(p1, clip(p2, { transition: 'fade' }))
      .run({ maxWait: '30s' });
    await expect(pending).rejects.toBeInstanceOf(GislPerInputOptionsNotSupportedError);
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });
});

describe('MergeBuilder — submit', () => {
  it('wires the webhook to callback_url + returns Handle without polling', async () => {
    const mock = makeMockClient();
    const a = asset('a.mp4');
    const b = asset('b.mp4');
    const h = await new MergeBuilder(mock.client, [a, b], {}).submit({
      webhook: 'https://my.app/cb',
    });
    expect(h.workflowId).toBe('wf_merge');
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.callback_url).toBe('https://my.app/cb');
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).not.toHaveBeenCalled();
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
  });
});

describe('MergeBuilder — dedupe identity', () => {
  it('two path-assets with the EXACT same string (after trim+trailing-slash strip) = single upload', async () => {
    const mock = makeMockClient();
    const a1 = asset('a.mp4');
    const a2 = asset('a.mp4'); // identical string — dedupes
    const b = asset('b.mp4');
    const c = asset('c.mp4');
    await new MergeBuilder(mock.client, [a1, a2, b, c], { allowUnusedAssets: true })
      .sequence(a1, b)
      .run({ maxWait: '30s' });
    // Only `a.mp4` + `b.mp4` get uploaded — `a1`/`a2` dedupe to one,
    // `c.mp4` is filtered out by the upload-set restriction.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('two path-assets with DIFFERENT case do NOT collide (case-sensitive filesystems)', async () => {
    // Codex r1 LOW 74dccf7f93e9 — A.mp4 and a.mp4 are DISTINCT files on
    // case-sensitive filesystems. The previous lowercase dedupe would
    // silently merge them into one upload and produce a wrong-file merge.
    const mock = makeMockClient();
    const a_upper = asset('A.MP4');
    const a_lower = asset('a.mp4');
    await new MergeBuilder(mock.client, [a_upper, a_lower], {}).run({ maxWait: '30s' });
    // Each is a distinct file → two uploads.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('two Blob assets with SAME size+type but DIFFERENT references do NOT collide (referential dedupe)', async () => {
    // Codex r1 HIGH bab88c094d07 — previous Blob dedupe used size+type
    // hash, silently merging distinct payloads.
    const mock = makeMockClient();
    const b1 = new Blob(['payload-one'], { type: 'video/mp4' });
    const b2 = new Blob(['payload-two'], { type: 'video/mp4' });
    expect(b1.size).toBe(b2.size); // sanity — same size + same type
    expect(b1.type).toBe(b2.type);
    await new MergeBuilder(mock.client, [asset(b1), asset(b2)], {}).run({ maxWait: '30s' });
    // Distinct Blob references → two uploads.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('SAME Blob reference declared twice = single upload (referential dedupe positive case)', async () => {
    const mock = makeMockClient();
    const shared = new Blob(['shared-payload'], { type: 'video/mp4' });
    const extra = new Blob(['extra-payload'], { type: 'video/mp4' });
    await new MergeBuilder(mock.client, [asset(shared), asset(shared), asset(extra)], {
      allowUnusedAssets: true,
    })
      .sequence(asset(shared), asset(extra))
      .run({ maxWait: '30s' });
    // shared appears twice but dedupes to ONE; extra adds a second upload.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('two handle-assets with the SAME fileId = single (zero) upload', async () => {
    const mock = makeMockClient();
    const h1 = handle('pre_existing_file');
    const h2 = handle('pre_existing_file'); // same fileId — same identity
    const h3 = handle('other_file');
    await new MergeBuilder(mock.client, [h1, h2, h3], { allowUnusedAssets: true })
      .sequence(h1, h3)
      .run({ maxWait: '30s' });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });
});
