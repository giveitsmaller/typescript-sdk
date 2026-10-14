import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { create } from '../../src/gisl.js';
import { GislClient } from '../../src/client.js';
import { GislConfigError, GislSinkError } from '../../src/errors.js';
import { OperationBuilder } from '../../src/builder.js';
import { BatchRecipe, Recipe, SplitRecipe, fileInput } from '../../src/file-first.js';
import type { SplitOptions } from '../../src/ergonomic/option_types.js';
import type { OperationDef, WorkflowCreatePayload } from '../../src/types.js';

/**
 * x1nYxBQx — the `split` verb in the TS ergonomic layer: `Recipe.split()`
 * returning the TERMINAL {@link SplitRecipe}, and the single-op `client.split()`.
 *
 * Pinned here:
 *  - lowering per mime group (GIF, PDF both modes, audio silence, video), with
 *    undefined values dropped and pre-steps lowered into a `pre` job;
 *  - compile-time: nothing chains after split, it cannot enter batch(), an
 *    excess key / bad mode literal / missing bag are type errors;
 *  - runtime: unknown keys rejected at the verb call on both surfaces; a second
 *    sole_op step rejected eagerly; `precision: 'exact'` refused with ZERO
 *    uploads on BOTH surfaces, and `fast` passes (control);
 *  - beta groups and the beta silence mode reach createWorkflow unchanged
 *    (control against an accidental SDK gate);
 *  - run() over 3 outputs and submit() -> handle.result().
 */

const FILE_ID = 'file_0001';

/** The one `split` op in a lowered payload (fails the test if absent). */
function splitOp(payload: WorkflowCreatePayload): OperationDef {
  const op = payload.jobs.flatMap((j) => j.operations).find((o) => o.type === 'split');
  expect(op, 'expected a split op in the lowered payload').toBeDefined();
  return op!;
}

const captureConfigError = (fn: () => unknown): GislConfigError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof GislConfigError) return err;
    throw err;
  }
  throw new Error('expected the call to throw a GislConfigError, but it did not');
};

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

describe('Recipe.split — lowering per mime group', () => {
  it('GIF: frame_range + output_format, one job, no id', () => {
    const payload = new Recipe(fileInput.path('anim.gif'))
      .split({ frame_range: '1-10', output_format: 'webp' })
      .toWorkflowPayload(FILE_ID);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0]).toEqual({
      source: { type: 'upload', file_id: FILE_ID },
      operations: [{ type: 'split', options: { frame_range: '1-10', output_format: 'webp' } }],
    });
  });

  it('PDF page_range and page_groups lower verbatim', () => {
    const range = new Recipe(fileInput.path('doc.pdf')).split({ mode: 'page_range', page_range: '1-3,8' });
    expect(splitOp(range.toWorkflowPayload(FILE_ID))).toEqual({
      type: 'split',
      options: { mode: 'page_range', page_range: '1-3,8' },
    });
    const groups = new Recipe(fileInput.path('doc.pdf')).split({ mode: 'page_groups', page_groups: 5 });
    expect(splitOp(groups.toWorkflowPayload(FILE_ID))).toEqual({
      type: 'split',
      options: { mode: 'page_groups', page_groups: 5 },
    });
  });

  it('audio silence mode lowers every silence key', () => {
    const payload = new Recipe(fileInput.path('talk.mp3'))
      .split({ mode: 'silence', silence_threshold_db: -40, silence_min_duration: 0.5, silence_handling: 'keep_at_end' })
      .toWorkflowPayload(FILE_ID);
    expect(splitOp(payload).options).toEqual({
      mode: 'silence',
      silence_threshold_db: -40,
      silence_min_duration: 0.5,
      silence_handling: 'keep_at_end',
    });
  });

  it('video cut_points lowers the array as-is', () => {
    const payload = new Recipe(fileInput.path('clip.mp4'))
      .split({ mode: 'cut_points', cut_points: [1.5, 3, 7.25], precision: 'fast' })
      .toWorkflowPayload(FILE_ID);
    expect(splitOp(payload).options).toEqual({ mode: 'cut_points', cut_points: [1.5, 3, 7.25], precision: 'fast' });
  });

  it('drops an explicit undefined value', () => {
    const payload = new Recipe(fileInput.path('clip.mp4'))
      .split({ mode: 'count', count: 4, precision: undefined })
      .toWorkflowPayload(FILE_ID);
    expect(splitOp(payload).options).toEqual({ mode: 'count', count: 4 });
  });

  it('a pre-step lowers into a `pre` job feeding the `split` job', () => {
    const split = new Recipe(fileInput.path('deck.docx')).convert('pdf').split({ mode: 'page_groups', page_groups: 2 });
    expect(split.stepCount).toBe(2);
    const payload = split.toWorkflowPayload(FILE_ID);
    expect(payload.jobs.map((j) => j.id)).toEqual(['pre', 'split']);
    expect(payload.jobs[0].source).toEqual({ type: 'upload', file_id: FILE_ID });
    expect(payload.jobs[0].operations.map((o) => o.type)).toEqual(['convert']);
    expect(payload.jobs[1].source).toEqual({ type: 'job_output', from: 'pre' });
    expect(payload.jobs[1].operations).toEqual([{ type: 'split', options: { mode: 'page_groups', page_groups: 2 } }]);
  });

  it('threads the recipe key and a callback url', () => {
    const split = new Recipe(fileInput.path('doc.pdf'), 'report').split({ page_range: '1-2' });
    expect(split.key()).toBe('report');
    expect(split.toWorkflowPayload(FILE_ID, 'https://hooks.example.com/x').callback_url).toBe(
      'https://hooks.example.com/x',
    );
  });
});

// ---------------------------------------------------------------------------
// Compile-time guards (the directives fail `npm run check:tests` if unused)
// ---------------------------------------------------------------------------

describe('SplitRecipe — compile-time surface', () => {
  it('is terminal: nothing chains after split', () => {
    const split = new Recipe(fileInput.path('doc.pdf')).split({ page_range: '1' });
    expect('compress' in split).toBe(false);
    expect('split' in split).toBe(false);
    expect(() => {
      // @ts-expect-error — SplitRecipe has no compress(); split is terminal.
      split.compress();
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — SplitRecipe has no convert(); split is terminal.
      split.convert('png');
    }).toThrow(TypeError);
  });

  it('exposes exactly the terminal surface and no Recipe step method', () => {
    // Pins the whole prototype, not a sample: adding any step verb (transform,
    // thumbnail, textWatermark, output, watermark, ...) to SplitRecipe fails here.
    expect(Object.getOwnPropertyNames(SplitRecipe.prototype).sort()).toEqual(
      ['constructor', 'key', 'run', 'stepCount', 'submit', 'toWorkflowPayload'],
    );
  });

  it('cannot enter batch()', () => {
    const split = new Recipe(fileInput.path('doc.pdf'), 'a').split({ page_range: '1' });
    // @ts-expect-error — a SplitRecipe is not a Recipe, so batch() rejects it at compile time.
    const batch = new BatchRecipe([split]);
    expect(batch).toBeInstanceOf(BatchRecipe);
  });

  it('rejects an excess key, a bad mode literal and a missing bag at compile time', () => {
    const r = new Recipe(fileInput.path('doc.pdf'));
    // @ts-expect-error — `pages` is not a split option (it is convert's).
    expect(() => r.split({ pages: '1-2' })).toThrow(GislConfigError);
    // @ts-expect-error — 'pages' is not a split mode.
    const badMode: SplitOptions = { mode: 'pages' };
    expect(badMode.mode).toBe('pages');
    // @ts-expect-error — the split bag is required.
    expect(r.split()).toBeInstanceOf(SplitRecipe);
  });
});

// ---------------------------------------------------------------------------
// Runtime validation at the call
// ---------------------------------------------------------------------------

describe('split — runtime option validation', () => {
  it('Recipe.split rejects an unknown key at the verb call', () => {
    const err = captureConfigError(() => new Recipe(fileInput.path('doc.pdf')).split({ bogus: 1 } as never));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('client.split rejects an unknown key at the call', async () => {
    const c = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    const err = captureConfigError(() => c.split('doc.pdf', { bogus: 1 } as never));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('client.split builds an OperationBuilder for a valid bag', async () => {
    const c = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    expect(c.split('doc.pdf', { mode: 'page_range', page_range: '1-2' })).toBeInstanceOf(OperationBuilder);
    // @ts-expect-error — the split bag is required on the client verb too.
    expect(c.split('doc.pdf')).toBeInstanceOf(OperationBuilder);
  });

  it('a recipe already holding a sole_op step fails at the split() call', () => {
    const err = captureConfigError(() =>
      new Recipe(fileInput.path('photo.png')).textWatermark('(c) Acme').split({ frame_range: '1-2' }),
    );
    expect(err.reason).toBe('multi_sole_op_unsupported');
    expect(err.message).toContain('split()');
    expect(err.message).toContain('text_watermark');
  });

  it('a non-sole_op pre-step is allowed (control for the eager check)', () => {
    expect(() => new Recipe(fileInput.path('deck.docx')).convert('pdf').split({ page_range: '1' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// run() / submit() through a mock client
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

function pageFile(page: number): Record<string, unknown> {
  return {
    operation: 'split',
    operationId: `op_${page}`,
    filename: `deck-${page}.pdf`,
    sizeBytes: 100 + page,
    downloadUrl: `https://signed.example.com/deck-${page}.pdf`,
    pageIndex: page,
  };
}

/** A completed `pre` -> `split` chain: the pre job's PDF plus 3 split outputs. */
function makeMockClient(): MockClientHandles {
  const uploadFile = vi.fn(async (_input: string | Blob) => ({
    fileId: 'uploaded',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({ workflowId: 'wf_split', status: 'running' }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_split',
    status: 'completed',
    jobs: [
      { ref: 'pre', status: 'completed', operations: [] },
      { ref: 'split', status: 'completed', operations: [] },
    ],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      {
        ref: 'pre',
        files: [{ operation: 'convert', operationId: 'op_pre', filename: 'deck.pdf', sizeBytes: 9, downloadUrl: 'https://signed.example.com/deck.pdf' }],
      },
      { ref: 'split', files: [pageFile(1), pageFile(3), pageFile(5)] },
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

const bound = (path: string, client: GislClient, key?: string): Recipe =>
  new Recipe(fileInput.path(path), key, [], undefined, undefined, client);

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SplitRecipe.run — N outputs', () => {
  it('returns only the split job outputs, with pageIndex, and no single-output url', async () => {
    const mock = makeMockClient();
    const result = await bound('deck.docx', mock.client, 'deck')
      .convert('pdf')
      .split({ mode: 'page_groups', page_groups: 2 })
      .run({ maxWait: '30s', useSSE: false });

    expect(mock.uploadFile).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0] as WorkflowCreatePayload;
    expect(payload.jobs.map((j) => j.id)).toEqual(['pre', 'split']);

    // The `pre` job's intermediate PDF is filtered out.
    expect(result.artifacts.map((a) => a.filename)).toEqual(['deck-1.pdf', 'deck-3.pdf', 'deck-5.pdf']);
    expect(result.artifacts.map((a) => a.pageIndex)).toEqual([1, 3, 5]);
    expect(result.artifacts.every((a) => !('position' in a))).toBe(true);
    expect(result.url).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].key).toBe('deck');
    expect(result.succeeded[0].outputs).toHaveLength(3);
  });

  it('toFile() refuses a multi-output result with not_single_output', async () => {
    const mock = makeMockClient();
    const result = await bound('deck.docx', mock.client)
      .convert('pdf')
      .split({ page_range: '1,3,5' })
      .run({ maxWait: '30s', useSSE: false });
    await expect(result.toFile('/tmp/never-written.pdf')).rejects.toBeInstanceOf(GislSinkError);
    await expect(result.toFile('/tmp/never-written.pdf')).rejects.toMatchObject({ reason: 'not_single_output' });
  });

  it('a lone split keeps every download (no chain filter) and carries position 0', async () => {
    const mock = makeMockClient();
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_split',
      status: 'completed',
      jobs: [{ ref: 'job_1', status: 'completed', operations: [] }],
    });
    mock.getWorkflowDownloads.mockResolvedValue({
      downloads: [
        {
          ref: 'job_1',
          files: [0, 1].map((position) => ({
            operation: 'split',
            operationId: `op_${position}`,
            filename: `talk-${position}.mp3`,
            sizeBytes: 10,
            downloadUrl: `https://signed.example.com/talk-${position}.mp3`,
            position,
          })),
        },
      ],
    });
    const result = await bound('talk.mp3', mock.client)
      .split({ mode: 'count', count: 2 })
      .run({ maxWait: '30s', useSSE: false });
    const payload = mock.createWorkflow.mock.calls[0][0] as WorkflowCreatePayload;
    expect(payload.jobs).toHaveLength(1);
    expect(result.artifacts.map((a) => a.position)).toEqual([0, 1]);
    expect(result.toJSON().artifacts[0].position).toBe(0);
  });
});

describe('SplitRecipe.submit — handle result', () => {
  it('returns a keyed handle whose result() projects the split outputs', async () => {
    const mock = makeMockClient();
    const handle = await bound('deck.docx', mock.client, 'deck')
      .convert('pdf')
      .split({ page_range: '1,3,5' })
      .submit('https://hooks.example.com/split');

    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(handle.workflowId).toBe('wf_split');
    const payload = mock.createWorkflow.mock.calls[0][0] as WorkflowCreatePayload;
    expect(payload.callback_url).toBe('https://hooks.example.com/split');

    const result = await handle.result();
    expect(result.artifacts.map((a) => a.pageIndex)).toEqual([1, 3, 5]);
    expect(result.succeeded[0].key).toBe('deck');
  });
});

// ---------------------------------------------------------------------------
// Availability: precision 'exact' refused before upload; beta passes through
// ---------------------------------------------------------------------------

describe("precision 'exact' — refused with ZERO uploads on both surfaces", () => {
  it('Recipe.split run() and submit() refuse it in the preflight', async () => {
    const mock = makeMockClient();
    const split = bound('clip.mp4', mock.client).split({ mode: 'count', count: 3, precision: 'exact' });
    await expect(split.run({ maxWait: '30s' })).rejects.toMatchObject({
      reason: 'feature_not_available',
      conflictingFields: ['precision'],
    });
    await expect(split.submit()).rejects.toMatchObject({ reason: 'feature_not_available' });
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });

  it("Recipe.split with precision 'fast' reaches createWorkflow (control)", async () => {
    const mock = makeMockClient();
    await bound('clip.mp4', mock.client)
      .split({ mode: 'count', count: 3, precision: 'fast' })
      .run({ maxWait: '30s', useSSE: false });
    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
  });

  it('client.split run() and submit() refuse it before any upload', async () => {
    const uploadSpy = vi.spyOn(GislClient.prototype, 'uploadFile');
    const createSpy = vi.spyOn(GislClient.prototype, 'createWorkflow');
    const c = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    const builder = c.split('talk.mp3', { mode: 'interval', interval: 30, precision: 'exact' });
    await expect(builder.run({ maxWait: '30s' })).rejects.toMatchObject({
      reason: 'feature_not_available',
      conflictingFields: ['precision'],
    });
    await expect(builder.submit()).rejects.toMatchObject({ reason: 'feature_not_available' });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("client.split with precision 'fast' uploads and creates (control)", async () => {
    const uploadSpy = vi.spyOn(GislClient.prototype, 'uploadFile').mockResolvedValue({
      fileId: 'f1',
      contentType: 'audio/mpeg',
      sizeBytes: 100,
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.uploadFile>>);
    vi.spyOn(GislClient.prototype, 'maybeWaitForVideoProbe').mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof GislClient.prototype.maybeWaitForVideoProbe>>,
    );
    const createSpy = vi.spyOn(GislClient.prototype, 'createWorkflow').mockResolvedValue({
      workflowId: 'wf_c',
      status: 'running',
    } as unknown as Awaited<ReturnType<typeof GislClient.prototype.createWorkflow>>);
    const c = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    await c.split('talk.mp3', { mode: 'interval', interval: 30, precision: 'fast' }).submit();
    expect(uploadSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledOnce();
    const wire = createSpy.mock.calls[0][0] as unknown as WorkflowCreatePayload;
    expect(wire.jobs[0].operations[0]).toEqual({
      type: 'split',
      options: { mode: 'interval', interval: 30, precision: 'fast' },
    });
  });
});

describe('beta groups pass through with no SDK gate (control)', () => {
  it('audio silence mode (beta) reaches createWorkflow unchanged', async () => {
    const mock = makeMockClient();
    await bound('talk.mp3', mock.client)
      .split({ mode: 'silence', silence_threshold_db: -45 })
      .run({ maxWait: '30s', useSSE: false });
    expect(mock.uploadFile).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0] as WorkflowCreatePayload;
    expect(splitOp(payload).options).toEqual({ mode: 'silence', silence_threshold_db: -45 });
  });

  it('video interval (beta group) reaches createWorkflow unchanged', async () => {
    const mock = makeMockClient();
    await bound('clip.mp4', mock.client)
      .split({ mode: 'interval', interval: 10 })
      .run({ maxWait: '30s', useSSE: false });
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0] as WorkflowCreatePayload;
    expect(splitOp(payload).options).toEqual({ mode: 'interval', interval: 10 });
  });
});
