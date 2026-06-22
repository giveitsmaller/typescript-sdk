import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Recipe,
  WatermarkedRecipe,
  WATERMARK_CAPABILITY,
  fileInput,
  isWatermarkStatus,
} from '../src/file-first.js';
import type { GislClient } from '../src/client.js';
import type { WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError, GislTimeoutError } from '../src/errors.js';

/**
 * FF4a (Z7zTr789) — the fluent `file(base).watermark(overlay, opts)` multi-input
 * verb. Mirrors the PHP `WatermarkRecipeTest`: media routing (image ->
 * image_watermark, video -> video_watermark), the local planned-op gate
 * (throws BEFORE upload for audio/document/gif/unsupported-subtype/undetectable
 * bases + non-image overlays), the multi-input DAG lowering (src_0 base + src_1
 * overlay passthrough jobs + role-tagged job_output inputs), base-preceding /
 * overlay-own / post steps, and the `isWatermarkStatus` src_* projection.
 */

const recipe = (path: string): Recipe => new Recipe(fileInput.path(path));
const overlay = (path = 'logo.png'): Recipe => new Recipe(fileInput.path(path));

const watermarkJobOf = (payload: { jobs: readonly { id?: string }[] }) =>
  payload.jobs.find((j) => j.id === 'watermark') as unknown as {
    id: string;
    inputs: { source: { type: string; from: string }; role?: string }[];
    operations: { type: string; options?: Record<string, unknown> }[];
  };

describe('WatermarkedRecipe — routing', () => {
  it('routes an image base to image_watermark', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { anchor: 'bottom_right', opacity: 0.65 });
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('routes a video base to video_watermark', () => {
    const wr = recipe('clip.mp4').watermark(overlay(), { anchor: 'top_right' });
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('video_watermark');
  });

  it('routes a transformed base by its OUTPUT media (video + thumbnail -> image_watermark)', () => {
    const wr = recipe('clip.mp4').thumbnail({ width: 640, height: 360 }).watermark(overlay());
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('routes a base converted to a video format to video_watermark', () => {
    const wr = recipe('photo.jpg').convert('mp4').watermark(overlay());
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('video_watermark');
  });

  it('routes a named-but-typeless in-memory base by its filename extension (parity with PHP resource)', () => {
    // A File with an empty type but a recognised name must route like a path —
    // the mime falls back to the .name extension (matches _detectCompressMedia +
    // the PHP resource contentType->filename branch).
    const base = new Recipe(fileInput.blob(new File([new Uint8Array()], 'photo.png', { type: '' })));
    const wm = watermarkJobOf(base.watermark(overlay()).toWorkflowPayload(['b', 'o']));
    expect(wm.operations[0].type).toBe('image_watermark');
  });

  it('falls back to the filename when the in-memory base has a generic/unknown type', () => {
    // A non-empty but non-media-bearing type (application/octet-stream) must NOT
    // be used as the routing mime — fall back to the .name extension.
    const base = new Recipe(
      fileInput.blob(new File([new Uint8Array()], 'photo.png', { type: 'application/octet-stream' })),
    );
    const wm = watermarkJobOf(base.watermark(overlay()).toWorkflowPayload(['b', 'o']));
    expect(wm.operations[0].type).toBe('image_watermark');
  });
});

describe('WatermarkedRecipe — lowering shape', () => {
  it('lowers to src_0/src_1 passthrough jobs + a role-tagged watermark job', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { anchor: 'center', overlay_width: '30%' });
    const payload = wr.toWorkflowPayload(['base_id', 'ovl_id']);

    expect(payload.jobs).toHaveLength(3);
    const [src0, src1] = payload.jobs as unknown as {
      id: string;
      source: { type: string; file_id: string };
      operations: { type: string }[];
    }[];
    expect(src0).toMatchObject({ id: 'src_0', source: { type: 'upload', file_id: 'base_id' }, operations: [{ type: 'passthrough' }] });
    expect(src1).toMatchObject({ id: 'src_1', source: { type: 'upload', file_id: 'ovl_id' }, operations: [{ type: 'passthrough' }] });

    const wm = watermarkJobOf(payload);
    expect(wm.inputs).toEqual([
      { source: { type: 'job_output', from: 'src_0' }, role: 'base' },
      { source: { type: 'job_output', from: 'src_1' }, role: 'overlay' },
    ]);
    expect(wm.operations[0]).toEqual({
      type: 'image_watermark',
      options: { anchor: 'center', overlay_width: '30%' },
    });
  });

  it('omits the options wire key when no watermark options are given', () => {
    const wr = recipe('photo.jpg').watermark(overlay());
    const wm = watermarkJobOf(wr.toWorkflowPayload(['b', 'o']));
    expect(wm.operations[0]).toEqual({ type: 'image_watermark' });
  });

  it('lowers base preceding steps into src_0 and overlay own steps into src_1', () => {
    const wr = recipe('hero.jpg')
      .thumbnail({ width: 1200, height: 800 })
      .watermark(overlay('logo.png').convert('png'));
    const payload = wr.toWorkflowPayload(['b', 'o']) as unknown as {
      jobs: { id: string; operations: { type: string; options?: Record<string, unknown> }[] }[];
    };
    const src0 = payload.jobs.find((j) => j.id === 'src_0')!;
    const src1 = payload.jobs.find((j) => j.id === 'src_1')!;
    expect(src0.operations).toEqual([{ type: 'thumbnail', options: { width: 1200, height: 800 } }]);
    expect(src1.operations).toEqual([{ type: 'convert', options: { output_format: 'png' } }]);
  });

  it('appends post-watermark steps after the watermark op in the watermark job', () => {
    const wr = recipe('photo.jpg').watermark(overlay()).convert('webp');
    const wm = watermarkJobOf(wr.toWorkflowPayload(['b', 'o']));
    expect(wm.operations.map((o) => o.type)).toEqual(['image_watermark', 'convert']);
  });

  it('resolves a post-watermark compress preset against the watermark OUTPUT media', () => {
    // image base -> image_watermark -> the synthetic post media is image, so
    // compress(Size) resolves the IMAGE Size cell (not video / unknown).
    const wr = recipe('photo.jpg').watermark(overlay()).compress(OptimizeFor.Size);
    const wm = watermarkJobOf(wr.toWorkflowPayload(['b', 'o']));
    const compressOp = wm.operations.find((o) => o.type === 'compress');
    expect(compressOp).toBeDefined();
    expect(compressOp!.options).toBeDefined();
    // image presets never carry the video-only crf/encoding_mode keys.
    expect(compressOp!.options).not.toHaveProperty('crf');
  });

  it('resolves a post-watermark compress preset against a VIDEO watermark output', () => {
    // video base -> video_watermark -> the synthetic post media is video, so
    // compress(Size) resolves the VIDEO Size cell (the `mp4` synthetic arm).
    const wr = recipe('clip.mp4').watermark(overlay()).compress(OptimizeFor.Size);
    const wm = watermarkJobOf(wr.toWorkflowPayload(['b', 'o']));
    expect(wm.operations[0].type).toBe('video_watermark');
    const compressOp = wm.operations.find((o) => o.type === 'compress');
    expect(compressOp).toBeDefined();
    // video presets carry the video-only crf key — proves the synthetic resolved
    // against mp4 (video), not png (image).
    expect(compressOp!.options).toHaveProperty('crf');
  });

  it('wires callback_url when provided', () => {
    const wr = recipe('photo.jpg').watermark(overlay());
    const payload = wr.toWorkflowPayload(['b', 'o'], 'https://hook.example.com') as unknown as {
      callback_url?: string;
    };
    expect(payload.callback_url).toBe('https://hook.example.com');
  });
});

describe('WatermarkedRecipe — planned-op gate (throws pre-upload)', () => {
  it('throws for an audio base', () => {
    expect(() => recipe('song.mp3').watermark(overlay())).toThrow(GislConfigError);
  });

  it('throws for a document base', () => {
    expect(() => recipe('report.pdf').watermark(overlay())).toThrow(GislConfigError);
  });

  it('throws for an animated-GIF base (image_gif is planned)', () => {
    expect(() => recipe('loop.gif').watermark(overlay())).toThrow(/not yet available|planned/);
  });

  it('throws for an unsupported image subtype (avif)', () => {
    expect(() => recipe('pic.avif').watermark(overlay())).toThrow(/does not support/);
  });

  it('throws for an unsupported video subtype (mov)', () => {
    expect(() => recipe('clip.mov').watermark(overlay())).toThrow(/does not support/);
  });

  it('DEFERS an undetectable base at .watermark() call, then throws at lowering', () => {
    // A bare upload id carries no media — the eager gate is deferred (no throw
    // at the verb), and the gate fires when lowering resolves the wire op.
    const wr = new Recipe(fileInput.uploadId('u_base')).watermark(overlay());
    expect(wr).toBeInstanceOf(WatermarkedRecipe);
    expect(() => wr.toWorkflowPayload(['u_base', 'o'])).toThrow(/detectable base media/);
  });
});

describe('WatermarkedRecipe — overlay validation', () => {
  it('throws for a non-image overlay (video)', () => {
    expect(() => recipe('photo.jpg').watermark(overlay('clip.mp4'))).toThrow(/overlay must be an image/);
  });

  it('throws for a non-image overlay (audio)', () => {
    expect(() => recipe('photo.jpg').watermark(overlay('track.mp3'))).toThrow(/overlay must be an image/);
  });

  it('allows a transformed overlay whose output is an image (video -> thumbnail)', () => {
    const wr = recipe('photo.jpg').watermark(overlay('clip.mp4').thumbnail({ width: 64, height: 64 }));
    expect(wr).toBeInstanceOf(WatermarkedRecipe);
  });

  it('allows an undetectable overlay (bare upload id) — the server enforces it', () => {
    const wr = recipe('photo.jpg').watermark(new Recipe(fileInput.uploadId('u_ovl')));
    const payload = wr.toWorkflowPayload(['base', 'u_ovl']) as unknown as {
      jobs: { id: string; operations: { type: string }[] }[];
    };
    expect(payload.jobs.find((j) => j.id === 'src_1')!.operations).toEqual([{ type: 'passthrough' }]);
  });
});

describe('WatermarkedRecipe — immutability', () => {
  it('post-verbs return a new instance (clone-on-write)', () => {
    const base = recipe('photo.jpg').watermark(overlay());
    const next = base.compress(OptimizeFor.Size);
    expect(next).not.toBe(base);
    expect(base.stepCount).toBe(0);
    expect(next.stepCount).toBe(1);
  });
});

describe('isWatermarkStatus', () => {
  const status = (refs: string[]): WorkflowStatusResponse =>
    ({ jobs: refs.map((ref) => ({ ref })) }) as unknown as WorkflowStatusResponse;

  it('is true for a {src_0, src_1, watermark} workflow', () => {
    expect(isWatermarkStatus(status(['src_0', 'src_1', 'watermark']))).toBe(true);
  });

  it('is false when there is no watermark job', () => {
    expect(isWatermarkStatus(status(['src_0', 'src_1']))).toBe(false);
  });

  it('is false for a non-watermark workflow (a plain chain job)', () => {
    expect(isWatermarkStatus(status(['op']))).toBe(false);
  });

  it('is false for an empty job list', () => {
    expect(isWatermarkStatus(status([]))).toBe(false);
  });
});

describe('WATERMARK_CAPABILITY table', () => {
  it('exposes the shippable image + beta video routing', () => {
    expect(WATERMARK_CAPABILITY.image_watermark.image.availability).toBe('stable');
    expect(WATERMARK_CAPABILITY.image_watermark.image_gif.availability).toBe('planned');
    expect(WATERMARK_CAPABILITY.video_watermark.video.availability).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// run() — end-to-end via vi.fn client doubles (mirrors file-first-run.test.ts).
// xxy5Rlsy follow-up (Wi4OnaJE): WatermarkedRecipe.run() only reached the
// shared `_uploadInputsAndCreate` helper transitively (lowering + count-guard
// submit tests). These tests drive it at RUNTIME.
// ---------------------------------------------------------------------------

interface MockClientHandles {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  maybeWaitForVideoProbe: ReturnType<typeof vi.fn>;
  client: GislClient;
}

function makeMockClient(): MockClientHandles {
  const uploadFile = vi.fn(async (_input: string | Blob) => ({
    fileId: 'uploaded',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({ workflowId: 'wf_1', status: 'running' }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    jobs: [{ ref: 'watermark', status: 'completed', operations: [] }],
  }));
  // The downloads carry the src_* passthrough re-exposures of the raw base +
  // overlay uploads ALONGSIDE the watermark output, so run()'s
  // `ref === 'watermark'` filter is genuinely exercised.
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      { ref: 'src_0', files: [{ operation: 'passthrough', operationId: 's0', filename: 'photo.jpg', sizeBytes: 1, downloadUrl: 'https://signed.example.com/photo.jpg' }] },
      { ref: 'src_1', files: [{ operation: 'passthrough', operationId: 's1', filename: 'logo.png', sizeBytes: 1, downloadUrl: 'https://signed.example.com/logo.png' }] },
      { ref: 'watermark', files: [{ operation: 'image_watermark', operationId: 'ow', filename: 'photo_watermarked.jpg', sizeBytes: 99, downloadUrl: 'https://signed.example.com/photo_watermarked.jpg' }] },
    ],
  }));
  const streamEvents = vi.fn(async function* (_id: string) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
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
  return { uploadFile, createWorkflow, getWorkflowStatus, getWorkflowDownloads, streamEvents, maybeWaitForVideoProbe, client };
}

/** A client-bound base Recipe, mirroring the `gisl().file(...)` wiring. */
function boundBase(mock: MockClientHandles, path = 'photo.jpg'): Recipe {
  return new Recipe(fileInput.path(path), undefined, [], undefined, undefined, mock.client);
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WatermarkedRecipe.run — happy path through the shared helper', () => {
  it('uploads base + overlay, creates the lowered watermark DAG, and projects ONLY the watermark output', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'base0', contentType: 'image/jpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'ovl1', contentType: 'image/png', sizeBytes: 1 });

    const result = await boundBase(mock)
      .watermark(new Recipe(fileInput.path('logo.png')), { anchor: 'center' })
      .run({ maxWait: '30s' });

    // Base + overlay both uploaded, in that order; the probe gate is consulted
    // once per uploaded input with that input's id.
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    expect(mock.maybeWaitForVideoProbe.mock.calls.map((c) => c[0])).toEqual(['base0', 'ovl1']);

    // ONE workflow created from the lowered watermark DAG: src_0 base + src_1
    // overlay passthrough jobs + the role-tagged watermark job.
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['src_0', 'src_1', 'watermark']);
    const wm = payload.jobs.find((j: { id: string }) => j.id === 'watermark');
    expect(wm.operations[0].type).toBe('image_watermark');

    // The RunResult projects ONLY the watermark output — the src_* passthrough
    // downloads (raw base/overlay) are filtered out.
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts.map((a) => a.filename)).toEqual(['photo_watermarked.jpg']);
    expect(result.url).toBe('https://signed.example.com/photo_watermarked.jpg');
  });
});

describe('WatermarkedRecipe.run — timeout label', () => {
  // Pin the watermark label noun the shared helper threads into its timeout
  // message. A mid-batch deadline (maxWait 1ms + a slow first upload over the
  // base + overlay inputs) trips the `during ${uploadsLabel} uploads` throw —
  // asserting the MESSAGE (not the racy upload call-count) locks the noun.
  it('its mid-batch timeout message names the watermark label', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { fileId: 'uploaded', contentType: 'image/jpeg', sizeBytes: 1 };
    });

    const err = await boundBase(mock)
      .watermark(new Recipe(fileInput.path('logo.png')))
      .run({ maxWait: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislTimeoutError);
    expect((err as Error).message).toContain('watermark');
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });
});
