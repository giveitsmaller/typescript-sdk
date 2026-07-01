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

// p0SuJEeK — the merge payload now emits one single-input `passthrough`
// source job per UNIQUE asset (first-seen position order) FOLLOWED BY the
// merge job LAST. So `jobs[0]` is no longer the merge job. These helpers
// locate the merge job + assert the source-job invariants.

interface MergeInput {
  source: { type: string; from?: string; file_id?: string };
  per_input_options?: Record<string, unknown>;
}

interface WireJob {
  id: string;
  source?: { type: string; file_id?: string; from?: string };
  inputs?: MergeInput[];
  operations: Array<{ type: string; options?: Record<string, unknown> }>;
}

interface MergeWirePayload {
  jobs: WireJob[];
}

/** The merge job always carries an `inputs[]` array (multi-input). */
type MergeJob = WireJob & { inputs: MergeInput[] };

/** Locate the merge job — it is the LAST element + the only one with id 'merge'. */
function mergeJob(payload: MergeWirePayload): MergeJob {
  const job = payload.jobs[payload.jobs.length - 1];
  expect(job.id).toBe('merge');
  expect(job.operations[0].type).toBe('merge');
  expect(Array.isArray(job.inputs)).toBe(true);
  return job as MergeJob;
}

/** The merge operation's `options` bag (always present on the merge job). */
function mergeOptions(payload: MergeWirePayload): Record<string, unknown> {
  const opts = mergeJob(payload).operations[0].options;
  expect(opts).toBeDefined();
  return opts as Record<string, unknown>;
}

/**
 * Assert the leading source jobs: each is an `upload`-sourced single-input
 * job carrying exactly `operations: [{type: 'passthrough'}]`, with ids
 * `src_0`, `src_1`, … in order. `expectedCount` source jobs precede the
 * merge job. Returns the set of source-job ids for `job_output` checks.
 */
function assertSourceJobs(payload: MergeWirePayload, expectedCount: number): Set<string> {
  expect(payload.jobs).toHaveLength(expectedCount + 1);
  const srcIds = new Set<string>();
  for (let i = 0; i < expectedCount; i += 1) {
    const job = payload.jobs[i];
    expect(job.id).toBe(`src_${i}`);
    expect(job.source?.type).toBe('upload');
    expect(typeof job.source?.file_id).toBe('string');
    expect(job.inputs).toBeUndefined();
    expect(job.operations).toEqual([{ type: 'passthrough' }]);
    srcIds.add(job.id);
  }
  // Every merge input references a source job via job_output.
  for (const input of mergeJob(payload).inputs) {
    expect(input.source.type).toBe('job_output');
    expect(srcIds.has(input.source.from ?? '')).toBe(true);
  }
  return srcIds;
}

function makeMockClient(): {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  maybeWaitForVideoProbe: ReturnType<typeof vi.fn>;
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
  // YOA6FpFr PR2 — no-op gate stub (MergeBuilder.run/submit call it per video input).
  const maybeWaitForVideoProbe = vi.fn(async () => undefined);
  const client = {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
    maybeWaitForVideoProbe,
  } as unknown as GislClient;
  return {
    uploadFile,
    createWorkflow,
    getWorkflowStatus,
    getWorkflowDownloads,
    streamEvents,
    maybeWaitForVideoProbe,
    client,
  };
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
  it('uploads each declared asset once + builds one passthrough src job per asset + a merge job last', async () => {
    const mock = makeMockClient();
    const m = new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4'), asset('c.mp4')], {});
    await m.run({ maxWait: '30s' });
    expect(mock.uploadFile).toHaveBeenCalledTimes(3);
    const payload = mock.createWorkflow.mock.calls[0][0];
    // p0SuJEeK — 3 unique assets → 3 src_* passthrough jobs + 1 merge job last.
    assertSourceJobs(payload, 3);
    const merge = mergeJob(payload);
    expect(merge.inputs).toHaveLength(3);
    // Inputs go in declared order; each references its src job via job_output.
    expect(merge.inputs[0].source.type).toBe('job_output');
    expect(merge.inputs[0].source.from).toBe('src_0');
    expect(merge.inputs[1].source.from).toBe('src_1');
    expect(merge.inputs[2].source.from).toBe('src_2');
  });

  it('honours merge-level transition + crossfadeDuration on a video merge', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      transition: 'crossfade',
      crossfadeDuration: 1.0,
      normalizeAudio: true,
    }).run({ maxWait: '30s' });
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(mergeJob(payload).operations[0].options).toMatchObject({
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
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.target_size_bytes).toBe(100_000_000);
    expect(opts.encoding_mode).toBe('target_size');
    expect(opts.codec).toBe('h264');
  });

  it('honours reEncodeMode + targetResolution on a video merge (9u5aS8tU)', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      mediaKind: 'video',
      reEncodeMode: 'always',
      targetResolution: '1920x1080',
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.re_encode_mode).toBe('always');
    expect(opts.target_resolution).toBe('1920x1080');
  });

  it('reEncodeMode:"never" still emits (passthrough — server owns dependency validation) (9u5aS8tU)', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      mediaKind: 'video',
      reEncodeMode: 'never',
      // codec/target_resolution depend_on re_encode_mode auto|always in the
      // contract, but the SDK is a passthrough allowlist (like codec/crf/preset
      // already are) — it emits them as-is and lets the server reconcile.
      codec: 'h264',
      targetResolution: '1280x720',
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.re_encode_mode).toBe('never');
    expect(opts.codec).toBe('h264');
    expect(opts.target_resolution).toBe('1280x720');
  });

  it('honours delay on an image merge (9u5aS8tU)', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.png'), asset('b.png')], {
      mediaKind: 'image',
      output: 'gif',
      delay: 500,
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.output_type).toBe('gif');
    expect(opts.delay).toBe(500);
  });

  it('drops video-only merge fields on an image merge (parity with PHP)', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.png'), asset('b.png')], {
      mediaKind: 'image',
      output: 'video',
      // video-only — must be dropped on an image merge
      reEncodeMode: 'always',
      codec: 'h264',
      crf: 23,
      preset: 'fast',
      targetResolution: '1920x1080',
      targetSize: '5MB',
      crossfadeDuration: 1.0,
      normalizeAudio: true,
      // image-allowed
      transitionDuration: 0.5,
      fps: 24,
      delay: 500,
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.output_type).toBe('video');
    expect(opts.transition_duration).toBe(0.5);
    expect(opts.fps).toBe(24);
    expect(opts.delay).toBe(500);
    expect(opts.re_encode_mode).toBeUndefined();
    expect(opts.codec).toBeUndefined();
    expect(opts.crf).toBeUndefined();
    expect(opts.preset).toBeUndefined();
    expect(opts.target_resolution).toBeUndefined();
    expect(opts.target_size_bytes).toBeUndefined();
    expect(opts.encoding_mode).toBeUndefined();
    expect(opts.crossfade_duration).toBeUndefined();
    expect(opts.normalize_audio).toBeUndefined();
  });

  it('drops image-only merge fields on a video merge (parity with PHP)', async () => {
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      mediaKind: 'video',
      codec: 'h264',
      // image-only — must be dropped on a video merge
      transitionDuration: 0.5,
      fps: 24,
      durationPerImage: 2.0,
      delay: 500,
      loopCount: 1,
      videoFormat: 'webm',
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.codec).toBe('h264');
    expect(opts.transition_duration).toBeUndefined();
    expect(opts.fps).toBeUndefined();
    expect(opts.duration_per_image).toBeUndefined();
    expect(opts.delay).toBeUndefined();
    expect(opts.loop_count).toBeUndefined();
    expect(opts.video_format).toBeUndefined();
  });

  it('resolvedOptions.applied reports only wire-allowed fields per media (parity with PHP)', async () => {
    const mock = makeMockClient();
    const result = await new MergeBuilder(mock.client, [asset('a.png'), asset('b.png')], {
      mediaKind: 'image',
      output: 'video',
      codec: 'h264', // video-only — dropped from the wire, must not show as applied
      targetSize: '5MB', // video-only — dropped
      fps: 24, // image-allowed — applied
    }).run({ maxWait: '30s' });
    const applied = result.resolvedOptions.applied;
    expect(applied.output).toBe('video');
    expect(applied.fps).toBe(24);
    expect(applied.codec).toBeUndefined();
    expect(applied.targetSize).toBeUndefined();
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
    // p0SuJEeK — 4 unique assets (first-seen order a, x, b, c) → 4 src jobs.
    // A repeated asset (x) re-uses its SAME src job, not a second one.
    const srcIds = assertSourceJobs(payload, 4);
    const merge = mergeJob(payload);
    expect(merge.inputs).toHaveLength(6);
    // sequence is a, x, b, x, c, x — positions 1, 3, 5 all reference x's src job.
    expect(merge.inputs[1].source.from).toBe(merge.inputs[3].source.from);
    expect(merge.inputs[3].source.from).toBe(merge.inputs[5].source.from);
    // The four distinct src jobs cover exactly the four positions a, x, b, c.
    expect(srcIds.size).toBe(4);
  });

  it('uploads each handle ZERO times — handle assets bypass upload entirely', async () => {
    const mock = makeMockClient();
    const a = handle('pre_uploaded_file_xyz');
    const b = asset('b.mp4');
    await new MergeBuilder(mock.client, [a, b], {}).run({ maxWait: '30s' });
    // Only `b` gets uploaded; `a` was already uploaded out of band.
    expect(mock.uploadFile).toHaveBeenCalledTimes(1);
    const payload = mock.createWorkflow.mock.calls[0][0];
    // p0SuJEeK — a handle asset still gets its own passthrough src job
    // (the upload-direct exclusion applies to every multi-input source).
    assertSourceJobs(payload, 2);
    expect(mergeJob(payload).inputs).toHaveLength(2);
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
    // p0SuJEeK — 3 unique assets (a, x, b) → 3 src jobs; per_input_options
    // stays on the merge inputs[] entries exactly as before.
    assertSourceJobs(payload, 3);
    const merge = mergeJob(payload);
    // Codex r1 HIGH 502c6bf232c2 — per_input_options goes on each input
    // entry, NOT job-level operations.options.
    expect(merge.operations[0].options?.per_input_options).toBeUndefined();
    expect(merge.inputs[0].per_input_options).toBeUndefined();
    expect(merge.inputs[1].per_input_options).toEqual({ transition: 'fade' });
    expect(merge.inputs[2].per_input_options).toBeUndefined();
    expect(merge.inputs[3].per_input_options).toBeUndefined();
    // The reused asset x (positions 1 + 3) shares ONE src job.
    expect(merge.inputs[1].source.from).toBe(merge.inputs[3].source.from);
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
    assertSourceJobs(audioPayload, 3);
    expect(mergeJob(audioPayload).inputs[1].per_input_options).toEqual({
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
    assertSourceJobs(videoPayload, 2);
    const videoMerge = mergeJob(videoPayload);
    expect(videoMerge.inputs[1].per_input_options).toEqual({
      transition: 'crossfade',
    });
    expect(videoMerge.inputs[1].per_input_options?.gap_duration).toBeUndefined();
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
    const payload = mock.createWorkflow.mock.calls[0][0];
    // p0SuJEeK — 3 unique assets (p1, div, p2) → 3 src jobs; the reused
    // divider shares its src job across positions 1 + 3.
    assertSourceJobs(payload, 3);
    const merge = mergeJob(payload);
    expect(merge.inputs).toHaveLength(4);
    expect(merge.inputs[1].source.from).toBe(merge.inputs[3].source.from);
    const opts = mergeOptions(payload);
    // Merge-level transition propagates; per_input_options is NOT set on image merges.
    expect(opts.transition).toBe('fade');
    expect(opts.per_input_options).toBeUndefined();
    // Image merges never carry per_input_options on any input.
    for (const input of merge.inputs) {
      expect(input.per_input_options).toBeUndefined();
    }
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
    // Structured fields mirror the PHP $assetId / $declaredAssets props.
    const undeclared = thrown as GislUndeclaredAssetError;
    expect(undeclared.assetId).toBe('path:c.mp4');
    expect(undeclared.declaredAssets).toEqual(['path:a.mp4', 'path:b.mp4']);
    expect(undeclared.message).toMatch(
      /Sequence references asset 'path:c.mp4' but it wasn't declared/,
    );
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
    let thrown: unknown;
    try {
      await new MergeBuilder(mock.client, [a, b], {}).sequence(a).run({ maxWait: '30s' });
    } catch (err) {
      thrown = err;
    }
    // Structured field mirrors the PHP $unusedAssets prop.
    const unused = thrown as GislUnusedAssetError;
    expect(unused.unusedAssets).toEqual(['path:b.mp4']);
    expect(unused.message).toMatch(/were declared in merge\(\.\.\.\) but never sequenced/);
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
    let thrown: unknown;
    try {
      await new MergeBuilder(mock.client, [p1, p2], { output: 'video', videoFormat: 'mp4' })
        .sequence(p1, clip(p2, { transition: 'fade' }))
        .run({ maxWait: '30s' });
    } catch (err) {
      thrown = err;
    }
    // Structured field mirrors the PHP $mediaKind prop.
    const perInput = thrown as GislPerInputOptionsNotSupportedError;
    expect(perInput.mediaKind).toBe('image');
    expect(perInput.message).toMatch(/image merge has no per-input options today/);
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('throws GislConfigError when targetSize is an unparseable string on a VIDEO merge (before any upload)', async () => {
    // Parity with PHP test_invalid_target_size_string_raises_config_error — a
    // garbage size string must fail locally in planSequence, not after burning
    // N uploads then hitting parseSizeString from wireMergeOptions(). The .mp4
    // assets infer a video merge, where targetSize DOES cross the wire — so the
    // pre-upload validation applies (codex #176 r3 DCJUvvfA gates it to video).
    const mock = makeMockClient();
    const pending = new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
      targetSize: 'garbage',
    }).run({ maxWait: '30s' });
    await expect(pending).rejects.toBeInstanceOf(GislConfigError);
    await expect(
      new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {
        targetSize: 'garbage',
      }).run({ maxWait: '30s' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid targetSize string 'garbage'/),
    });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('does NOT validate a garbage targetSize on a NON-video merge — the field is dropped, not parsed (DCJUvvfA)', async () => {
    // targetSize → target_size_bytes is video-only (wireMergeOptions drops it for
    // image/audio). Validating its string form on a non-video merge would reject
    // the workflow over a value that never leaves the SDK. codex #176 r3 gated the
    // pre-upload check to video, so an image merge with garbage targetSize must
    // succeed and simply omit target_size_bytes from the wire. PHP parity:
    // test_garbage_target_size_string_is_ignored_on_non_video_merge.
    const mock = makeMockClient();
    await new MergeBuilder(mock.client, [asset('a.png'), asset('b.png')], {
      mediaKind: 'image',
      output: 'video',
      targetSize: 'garbage',
    }).run({ maxWait: '30s' });
    const opts = mergeOptions(mock.createWorkflow.mock.calls[0][0]);
    expect(opts.target_size_bytes).toBeUndefined();
    expect(opts.encoding_mode).toBeUndefined();
    expect(mock.uploadFile).toHaveBeenCalled();
  });

  it('throws GislConfigError on an image merge with neither output nor outputType (before any upload)', async () => {
    // Parity with PHP test_image_merge_without_output_type_raises_config_error_pre_upload —
    // the server requires output_type for image merges; detect locally so the
    // caller doesn't pay for uploads chasing a server-side 422.
    const mock = makeMockClient();
    const p1 = asset('1.jpg');
    const p2 = asset('2.jpg');
    const pending = new MergeBuilder(mock.client, [p1, p2], { mediaKind: 'image' }).run({
      maxWait: '30s',
    });
    await expect(pending).rejects.toBeInstanceOf(GislConfigError);
    await expect(
      new MergeBuilder(mock.client, [p1, p2], { mediaKind: 'image' }).run({ maxWait: '30s' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/image merges require an explicit output_type/),
    });
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

// ---------------------------------------------------------------------------
// p0SuJEeK — Result projection must surface ONLY the merge job's output.
// getWorkflowDownloads returns a group per terminal job, which now includes
// the passthrough source jobs (output = the unchanged upload). Those must NOT
// leak into Result.artifacts as if they were merge deliverables.
// ---------------------------------------------------------------------------

describe('MergeBuilder.run — projects only the merge job output (excludes passthrough src jobs)', () => {
  it('drops src_* passthrough download groups, keeping only the merge artifact', async () => {
    const mock = makeMockClient();
    // Server returns downloads for the two passthrough src jobs (the raw
    // inputs, unchanged) AND the merge job. Only the merge output is a result.
    mock.getWorkflowDownloads.mockResolvedValueOnce({
      downloads: [
        {
          jobId: 'job_src0',
          ref: 'src_0',
          files: [{
            operation: 'passthrough',
            operationId: 'opid_s0',
            filename: 'a.mp4',
            sizeBytes: 111,
            downloadUrl: 'https://signed.example.com/a.mp4',
          }],
        },
        {
          jobId: 'job_src1',
          ref: 'src_1',
          files: [{
            operation: 'passthrough',
            operationId: 'opid_s1',
            filename: 'b.mp4',
            sizeBytes: 222,
            downloadUrl: 'https://signed.example.com/b.mp4',
          }],
        },
        {
          jobId: 'job_merge',
          ref: 'merge',
          files: [{
            operation: 'merge',
            operationId: 'opid_m',
            filename: 'merged.mp4',
            sizeBytes: 5000,
            downloadUrl: 'https://signed.example.com/merged.mp4',
          }],
        },
      ],
    });
    const result = await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {}).run({
      maxWait: '30s',
    });
    // ONLY the merge output — the two passthrough inputs are plumbing.
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].ref).toBe('merge');
    expect(result.artifacts[0].url).toBe('https://signed.example.com/merged.mp4');
    expect(result.artifacts.map((a) => a.operation)).not.toContain('passthrough');
  });
});
