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
import type { WatermarkOptions, WatermarkOverlay } from '../src/ergonomic/option_types.js';

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

// PIiUit28 — image_watermark/video_watermark are `sole_op`, so post-watermark
// steps lower into a DOWNSTREAM `post` job that consumes the watermark output
// via `job_output` (from: watermark) rather than co-bundling into the
// watermark job. This locates that job.
const postJobOf = (payload: { jobs: readonly { id?: string }[] }) =>
  payload.jobs.find((j) => j.id === 'post') as unknown as {
    id: string;
    source: { type: string; from: string };
    operations: { type: string; options?: Record<string, unknown> }[];
  };

describe('WatermarkedRecipe — routing', () => {
  it('routes an image base to image_watermark', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { anchor: 'bottom_right', opacity: 0.65 });
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('routes a TIFF base to image_watermark (image_tiff stable, v2.148.0)', () => {
    const wr = recipe('scan.tiff').watermark(overlay());
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('routes a BMP base to image_watermark (image_bmp stable, v2.148.0)', () => {
    const wr = recipe('pic.bmp').watermark(overlay());
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('REFUSES a video base — video_watermark was WITHDRAWN in contracts v2.203.0', () => {
    // 🔴 THIS ASSERTED A SUCCESSFUL ROUTE UNTIL 2026-09-16, and the route was
    // real: video_watermark was `stable`. The contract withdrew it to `planned`
    // on owner GO after three measured staging proofs — a worker EXISTS and
    // cannot serve the advertised ceiling.
    //
    // ⇒ The SDK now refuses BEFORE any upload rather than building a workflow the
    // server answers with feature_not_available. That is the gate working, and it
    // is the customer-visible half of this re-vendor.
    // ⚠️ The refusal is EAGER — it lands on `.watermark()`, not on
    // `toWorkflowPayload()`, because the gate runs at chain-build time so a
    // caller learns before uploading anything. Asserting on the payload call
    // would let the error escape the expectation entirely.
    expect(() => recipe('clip.mp4').watermark(overlay(), { anchor: 'top_right' })).toThrow(
      /video_watermark is 'planned'/,
    );
  });

  it('routes a transformed base by its OUTPUT media (video + thumbnail -> image_watermark)', () => {
    const wr = recipe('clip.mp4').thumbnail({ width: 640, height: 360 }).watermark(overlay());
    const payload = wr.toWorkflowPayload(['base', 'ovl']);
    expect(watermarkJobOf(payload).operations[0].type).toBe('image_watermark');
  });

  it('REFUSES a base converted to a video format for the same reason', () => {
    // The routing logic is unchanged — an output-media video still SELECTS
    // video_watermark; it is the availability of that op that now stops it.
    expect(() => recipe('photo.jpg').convert('mp4').watermark(overlay())).toThrow(/not available/);
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

  it('lowers post-watermark steps into a downstream `post` job (sole_op split, PIiUit28)', () => {
    // image_watermark is `sole_op`: the watermark job carries ONLY the watermark
    // op, and the post-step (convert) lowers into a separate `post` job that
    // consumes the watermark output via job_output.
    const wr = recipe('photo.jpg').watermark(overlay()).convert('webp');
    const payload = wr.toWorkflowPayload(['b', 'o']);
    const wm = watermarkJobOf(payload);
    expect(wm.operations.map((o) => o.type)).toEqual(['image_watermark']);

    const post = postJobOf(payload);
    expect(post.source).toEqual({ type: 'job_output', from: 'watermark' });
    expect(post.operations.map((o) => o.type)).toEqual(['convert']);
  });

  it('resolves a post-watermark compress preset against the watermark OUTPUT media', () => {
    // image base -> image_watermark -> the synthetic post media is image, so
    // compress(Size) resolves the IMAGE Size cell (not video / unknown). The
    // compress op now lives in the downstream `post` job (sole_op split).
    const wr = recipe('photo.jpg').watermark(overlay()).compress(OptimizeFor.Size);
    const payload = wr.toWorkflowPayload(['b', 'o']);
    const wm = watermarkJobOf(payload);
    // watermark job carries ONLY the sole_op watermark op.
    expect(wm.operations.map((o) => o.type)).toEqual(['image_watermark']);

    const post = postJobOf(payload);
    const compressOp = post.operations.find((o) => o.type === 'compress');
    expect(compressOp).toBeDefined();
    expect(compressOp!.options).toBeDefined();
    // image presets never carry the video-only crf/encoding_mode keys.
    expect(compressOp!.options).not.toHaveProperty('crf');
  });

  it.skip('SKIPPED: post-watermark compress against a VIDEO watermark output', () => {
    // ⚠️ SKIPPED, NOT DELETED, AND THE DIFFERENCE MATTERS. This pinned the
    // synthetic post-media resolution for a VIDEO watermark — that a
    // `compress(Size)` after a video watermark resolves the VIDEO Size cell and
    // lands in the downstream sole_op job. None of that logic changed.
    //
    // It cannot run because contracts v2.203.0 WITHDREW video_watermark to
    // `planned`, so the gate refuses before the payload exists. The coverage is
    // genuinely lost in the meantime, and deleting it would lose the knowledge
    // that it should come back: 🔑 RE-ENABLE THIS WHEN video_watermark IS
    // RE-LISTED at an honest ceiling. The image path below still covers the
    // sole_op split; what is uncovered is the VIDEO synthetic media arm.
    // video base -> video_watermark -> the synthetic post media is video, so
    // compress(Size) resolves the VIDEO Size cell (the `mp4` synthetic arm). The
    // compress op now lives in the downstream `post` job (sole_op split).
    const wr = recipe('clip.mp4').watermark(overlay()).compress(OptimizeFor.Size);
    const payload = wr.toWorkflowPayload(['b', 'o']);
    const wm = watermarkJobOf(payload);
    expect(wm.operations[0].type).toBe('video_watermark');
    // watermark job carries ONLY the sole_op watermark op.
    expect(wm.operations.map((o) => o.type)).toEqual(['video_watermark']);

    const post = postJobOf(payload);
    const compressOp = post.operations.find((o) => o.type === 'compress');
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

describe('WatermarkedRecipe — sole_op post-step split (PIiUit28)', () => {
  it('lowers ALL post-watermark steps into a downstream `post` job, in order', () => {
    // image_watermark is sole_op (ADR-0025): the watermark job carries ONLY the
    // watermark op; every chained post-step lowers into the `post` job that
    // consumes the watermark output via job_output, preserving chain order.
    const wr = recipe('photo.jpg').watermark(overlay()).convert('webp').compress(OptimizeFor.Size);
    const payload = wr.toWorkflowPayload(['b', 'o']);

    // The sole_op job holds exactly the watermark op — nothing else.
    const wm = watermarkJobOf(payload);
    expect(wm.operations.map((o) => o.type)).toEqual(['image_watermark']);

    // The downstream `post` job consumes the watermark output and carries the
    // post-steps in chain order.
    const post = postJobOf(payload);
    expect(post.id).toBe('post');
    expect(post.source).toEqual({ type: 'job_output', from: 'watermark' });
    expect(post.operations.map((o) => o.type)).toEqual(['convert', 'compress']);

    // The `post` job is the LAST job, appended after src_0/src_1/watermark.
    expect(payload.jobs.map((j) => (j as { id?: string }).id)).toEqual([
      'src_0',
      'src_1',
      'watermark',
      'post',
    ]);
  });

  it('emits NO `post` job when there are no post-watermark steps', () => {
    const wr = recipe('photo.jpg').watermark(overlay());
    const payload = wr.toWorkflowPayload(['b', 'o']);
    expect(postJobOf(payload)).toBeUndefined();
    expect(payload.jobs.map((j) => (j as { id?: string }).id)).toEqual(['src_0', 'src_1', 'watermark']);
  });
});

describe('WatermarkedRecipe — planned-op gate (throws pre-upload)', () => {
  it('throws for an audio base', () => {
    expect(() => recipe('song.mp3').watermark(overlay())).toThrow(GislConfigError);
  });

  it('throws for a document base without misdirecting to textWatermark (ZRkctunz)', () => {
    expect(() => recipe('report.pdf').watermark(overlay())).toThrow(GislConfigError);
    // The message must NOT tell the caller to use textWatermark() (which is
    // image-only, so following that advice would upload + fail server-side) —
    // it says textWatermark() is not an alternative for document bases.
    expect(() => recipe('report.pdf').watermark(overlay())).toThrow(
      /not an alternative for document/,
    );
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

describe('WatermarkedRecipe — overlays[] gate (Vbbdq9C4)', () => {
  // watermark() composites exactly ONE overlay (the positional overlay, src_1),
  // so overlays[] references sources the facade can't build and is invalid wire.
  // The gate lives at LOWERING so a post-construction mutation can't slip past.
  it('rejects a non-empty overlays[] at lowering', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { overlays: [{ anchor: 'center' }] });
    try {
      wr.toWorkflowPayload(['b', 'o']);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('overlays_unsupported');
      expect((e as GislConfigError).conflictingFields).toEqual(['overlays']);
      expect((e as Error).message).toMatch(/overlays\[\]/);
    }
  });

  it('rejects an empty overlays: [] at lowering (contract minItems: 1 makes it invalid too)', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { overlays: [] });
    expect(() => wr.toWorkflowPayload(['b', 'o'])).toThrow(/overlays\[\]/);
  });

  it('rejects overlays[] added by MUTATION after watermark() — the gate is at lowering', () => {
    const opts: WatermarkOptions = { anchor: 'center' };
    const wr = recipe('photo.jpg').watermark(overlay(), opts);
    // A caller mutating the (by-reference) options object AFTER the verb must not
    // slip past an eager construction-time guard — lowering re-reads the final options.
    opts.overlays = [{ anchor: 'top_left' }];
    expect(() => wr.toWorkflowPayload(['b', 'o'])).toThrow(/overlays\[\]/);
  });

  it('rejects a present overlays: null (reject-all — parity with PHP array_key_exists)', () => {
    // `null` is off-type, but the reject-all gate keys on "present, not undefined",
    // so it is rejected — matching the PHP array_key_exists('overlays') check.
    const wr = recipe('photo.jpg').watermark(overlay(), { overlays: null as unknown as WatermarkOverlay[] });
    expect(() => wr.toWorkflowPayload(['b', 'o'])).toThrow(/overlays\[\]/);
  });

  it('still lowers the flat single-overlay options when no overlays key is present', () => {
    const wr = recipe('photo.jpg').watermark(overlay(), { anchor: 'center', overlay_width: '30%' });
    const wm = watermarkJobOf(wr.toWorkflowPayload(['b', 'o']));
    expect(wm.operations[0]).toEqual({
      type: 'image_watermark',
      options: { anchor: 'center', overlay_width: '30%' },
    });
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

// ⚠️ THIS FILE'S COPY OF THE AVAILABILITY VALUES IS THE SECOND ONE, AND IT IS
// THE WEAKER ONE. `watermark-capability-conformance.test.ts` pins the SAME table
// to the generated `availability.json`, so it fails on its own the moment a
// contract regen moves a value — which is what a tripwire should do. The literals
// below cannot detect anything the conformance test misses; they can only go
// stale and demand a hand-edit, which is exactly what happened on the v2.201.0
// re-vendor when `video_watermark` was promoted beta -> stable and BOTH tests
// went red for the same single cause.
//
// ⇒ What is asserted here is the SHAPE the gate depends on — that every group
// carries a non-empty mime list and an availability drawn from the contract's
// vocabulary — not the values, which the contract owns and the conformance test
// checks. Keeping a value assertion here would be a decoration that also has to
// be maintained.
describe('WATERMARK_CAPABILITY table', () => {
  it('exposes every routable group with a non-empty mime list', () => {
    const groups = Object.values(WATERMARK_CAPABILITY).flatMap((op) => Object.values(op));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.mimes.length).toBeGreaterThan(0);
      expect(['stable', 'beta', 'experimental', 'planned', 'deprecated']).toContain(
        group.availability,
      );
    }
  });

  it('routes both wire ops', () => {
    expect(Object.keys(WATERMARK_CAPABILITY).sort()).toEqual([
      'image_watermark',
      'video_watermark',
    ]);
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

describe('WatermarkedRecipe.run — preflight before upload (T3ltXsou)', () => {
  it('a lowering error in the composed chain throws BEFORE any upload', async () => {
    // The shared multi-input helper now lowers with placeholder ids before
    // uploading, so a lowering-time gate (here overlays[]) fails pre-upload —
    // no wasted upload bytes. Mirrors the single-input 0azjb6Rg preflight.
    const mock = makeMockClient();
    const err = await boundBase(mock)
      .watermark(new Recipe(fileInput.path('logo.png')), { overlays: [{ anchor: 'center' }] })
      .run({ maxWait: '30s' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GislConfigError);
    expect((err as GislConfigError).reason).toBe('overlays_unsupported');
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });
});

describe('WatermarkedRecipe.run — SSE transport selection (wf133EDR)', () => {
  it('attempts the SSE stream by default (SSE-first)', async () => {
    const mock = makeMockClient();
    await boundBase(mock)
      .watermark(new Recipe(fileInput.path('logo.png')), { anchor: 'center' })
      .run({ maxWait: '30s' });
    expect(mock.streamEvents).toHaveBeenCalled();
  });

  it('useSSE:false polls directly and never opens the SSE stream', async () => {
    const mock = makeMockClient();
    const result = await boundBase(mock)
      .watermark(new Recipe(fileInput.path('logo.png')), { anchor: 'center' })
      .run({ maxWait: '30s', useSSE: false });
    // Poll-direct: streamEvents skipped, terminal resolved via getWorkflowStatus.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.artifacts.map((a) => a.filename)).toEqual(['photo_watermarked.jpg']);
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
