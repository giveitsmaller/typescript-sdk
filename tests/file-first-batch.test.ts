import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchRecipe, FilesRecipe, Recipe, fileInput } from '../src/file-first.js';
import type { FileInput } from '../src/file-first.js';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError, GislItemFailedError } from '../src/errors.js';
import type { GislClient } from '../src/client.js';

/**
 * FF7 (MFaCjL8d) — the keyed multi-recipe {@link BatchRecipe}: N DISTINCT
 * single-input keyed recipes lowered into ONE workflow (`b{i}` job ids), run
 * end-to-end, then partitioned into a keyed {@link RunResult} addressable by the
 * caller key given at `client.file(input, key)` time. Network-free: every call
 * goes through the {@link GislClient} methods, which are replaced with `vi.fn`
 * doubles (mirrors `file-first-files.test.ts`). Mirrors the PHP `BatchRecipeTest`.
 */

// The cross-language GOLDEN lowered payload — BOTH the TS and PHP suites assert
// their batch lowers a fixed 2-entry keyed-thumbnail batch to EXACTLY this. Any
// drift (job order, `b0`/`b1` ids, per-job key order, source shape, or an
// unexpected callback_url) breaks the pin in one language and not the other.
const GOLDEN_PAYLOAD = {
  jobs: [
    {
      id: 'b0',
      source: { type: 'upload', file_id: 'id0' },
      operations: [{ type: 'thumbnail', options: { width: 1200, height: 630 } }],
    },
    {
      id: 'b1',
      source: { type: 'upload', file_id: 'id1' },
      operations: [{ type: 'thumbnail', options: { width: 256, height: 256 } }],
    },
  ],
};
const GOLDEN_JSON =
  '{"jobs":[{"id":"b0","source":{"type":"upload","file_id":"id0"},"operations":[{"type":"thumbnail","options":{"width":1200,"height":630}}]},{"id":"b1","source":{"type":"upload","file_id":"id1"},"operations":[{"type":"thumbnail","options":{"width":256,"height":256}}]}]}';

// ---------------------------------------------------------------------------
// run() — end-to-end via vi.fn client doubles (mirrors file-first-files.test.ts).
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
  // Batch job refs are `b{i}` (a distinct namespace from the fan-out `file-{i}`).
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    jobs: [
      { ref: 'b0', status: 'completed', operations: [] },
      { ref: 'b1', status: 'completed', operations: [] },
    ],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      { ref: 'b0', files: [{ operation: 'thumbnail', operationId: 'o0', filename: 'hero.png', sizeBytes: 10, downloadUrl: 'https://cdn/hero.png' }] },
      { ref: 'b1', files: [{ operation: 'thumbnail', operationId: 'o1', filename: 'avatar.png', sizeBytes: 20, downloadUrl: 'https://cdn/avatar.png' }] },
    ],
  }));
  const streamEvents = vi.fn(async function* (_id: string) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
  });
  // YOA6FpFr PR2 — no-op probe gate stub (the upload→create seam calls it per
  // video input; the batch entries here are images / pre-uploaded ids).
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

/** A single-input keyed thumbnail recipe (no client — the batch supplies it). */
function keyedThumb(
  input: FileInput,
  key: string | undefined,
  width: number,
  height: number,
): Recipe {
  return new Recipe(input, key).thumbnail({ width, height });
}

/** Build a BatchRecipe carrying the mock client, mirroring `client.batch([...])`. */
function boundBatch(mock: MockClientHandles, recipes: readonly Recipe[]): BatchRecipe {
  return new BatchRecipe(recipes, mock.client);
}

/** N all-completed `b{i}` jobs — terminal-status double for an N-entry batch. */
function completedStatus(n: number) {
  return {
    workflowId: 'wf_1',
    status: 'completed',
    jobs: Array.from({ length: n }, (_unused, i) => ({ ref: `b${i}`, status: 'completed', operations: [] })),
  };
}

/** N `b{i}` downloads, one thumbnail output each — pairs with {@link completedStatus}. */
function completedDownloads(n: number) {
  return {
    downloads: Array.from({ length: n }, (_unused, i) => ({
      ref: `b${i}`,
      files: [{ operation: 'thumbnail', operationId: `o${i}`, filename: `out${i}.png`, sizeBytes: 1, downloadUrl: `https://cdn/out${i}.png` }],
    })),
  };
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('BatchRecipe.run — happy path (keyed partition)', () => {
  it('runs two single-input recipes as ONE workflow and addresses each output by its caller key', async () => {
    const mock = makeMockClient();
    const hero = keyedThumb(fileInput.uploadId('id0'), 'hero', 1200, 630);
    const avatar = keyedThumb(fileInput.uploadId('id1'), 'avatar', 256, 256);

    const result = await boundBatch(mock, [hero, avatar]).run({ maxWait: '30s' });

    // uploadId arm → NO upload; exactly ONE create carrying both `b{i}` jobs.
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['b0', 'b1']);

    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    // Each entry is addressed by the caller key (NOT a positional string index).
    expect(result.byKey('hero').key).toBe('hero');
    expect(result.byKey('hero').outputs[0].url).toBe('https://cdn/hero.png');
    expect(result.byKey('avatar').key).toBe('avatar');
    expect(result.byKey('avatar').outputs[0].url).toBe('https://cdn/avatar.png');
    // succeeded carries both keys in job order.
    expect(result.succeeded.map((s) => s.key)).toEqual(['hero', 'avatar']);
  });

  it('uploads every PATH input and threads its uploaded id into the create payload in ENTRY ORDER', async () => {
    // The uploadId happy path above never exercises the upload→create fileId
    // threading seam. With PATH inputs the batch uploads each entry (in order),
    // then the create payload's per-job source.file_id must carry the uploaded
    // ids positionally: b0 ← first upload, b1 ← second.
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'up0', contentType: 'image/jpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'up1', contentType: 'image/jpeg', sizeBytes: 1 });

    const hero = keyedThumb(fileInput.path('hero.jpg'), 'hero', 1200, 630);
    const avatar = keyedThumb(fileInput.path('avatar.jpg'), 'avatar', 256, 256);
    const result = await boundBatch(mock, [hero, avatar]).run({ maxWait: '30s' });

    // Distinct path inputs → dedupe does not apply; each uploads once (2 total).
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    // b0 ← first upload id, b1 ← second — the fileId threading is entry-ordered.
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['b0', 'b1']);
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'up0',
      'up1',
    ]);
    expect(result.ok).toBe(true);
    expect(result.succeeded.map((s) => s.key)).toEqual(['hero', 'avatar']);
  });
});

describe('BatchRecipe.run — cross-entry upload dedupe (1LwSJcz1)', () => {
  it('uploads a shared path input ONCE and points every job at the shared fileId', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockResolvedValue({ fileId: 'shared', contentType: 'image/jpeg', sizeBytes: 1 });
    // Two entries, byte-identical caller path string → ONE upload, both jobs
    // share the resulting fileId (correctness-neutral: same bytes → same output).
    const a = keyedThumb(fileInput.path('same.jpg'), 'a', 100, 100);
    const b = keyedThumb(fileInput.path('same.jpg'), 'b', 200, 200);

    const result = await boundBatch(mock, [a, b]).run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledOnce();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    // N-length jobs preserved; both b0 + b1 carry the ONE shared upload id.
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['b0', 'b1']);
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'shared',
      'shared',
    ]);
    // Per-entry RunResult keys stay independent despite the shared source.
    expect(result.succeeded.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('does NOT dedupe paths that differ by string (exact-string identity, no normalisation)', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'up0', contentType: 'image/jpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'up1', contentType: 'image/jpeg', sizeBytes: 1 });
    // `'./same.jpg'` and `'same.jpg'` reference the same file but are DISTINCT
    // strings → two uploads (dedupe is exact-string, never path-normalised).
    const a = keyedThumb(fileInput.path('./same.jpg'), 'a', 100, 100);
    const b = keyedThumb(fileInput.path('same.jpg'), 'b', 200, 200);

    await boundBatch(mock, [a, b]).run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'up0',
      'up1',
    ]);
  });

  it('dedupes ONLY the shared input in a mixed batch (shared + distinct paths)', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'upShared', contentType: 'image/jpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'upDistinct', contentType: 'image/jpeg', sizeBytes: 1 });
    mock.getWorkflowStatus.mockResolvedValue(completedStatus(3));
    mock.getWorkflowDownloads.mockResolvedValue(completedDownloads(3));
    // `shared.jpg` appears at index 0 AND 2; `distinct.jpg` only at 1.
    const first = keyedThumb(fileInput.path('shared.jpg'), 'first', 100, 100);
    const middle = keyedThumb(fileInput.path('distinct.jpg'), 'middle', 150, 150);
    const last = keyedThumb(fileInput.path('shared.jpg'), 'last', 200, 200);

    const result = await boundBatch(mock, [first, middle, last]).run({ maxWait: '30s' });

    // 3 entries, 2 unique inputs → exactly 2 uploads (first-appearance order).
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['b0', 'b1', 'b2']);
    // b0 + b2 (the shared input) share the first upload; b1 (distinct) its own.
    // The expand map yields an N-length file_id list with no undefined holes.
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'upShared',
      'upDistinct',
      'upShared',
    ]);
    expect(result.succeeded.map((s) => s.key)).toEqual(['first', 'middle', 'last']);
  });

  it('dedupes the SAME Blob by reference but uploads distinct-but-equal Blobs separately', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockResolvedValue({ fileId: 'up', contentType: 'image/jpeg', sizeBytes: 1 });
    mock.getWorkflowStatus.mockResolvedValue(completedStatus(4));
    mock.getWorkflowDownloads.mockResolvedValue(completedDownloads(4));
    const shared = new Blob(['pixels'], { type: 'image/jpeg' });
    const twinA = new Blob(['pixels'], { type: 'image/jpeg' }); // distinct object, equal bytes
    const twinB = new Blob(['pixels'], { type: 'image/jpeg' });
    // shared appears twice (same ref → 1 upload); twinA + twinB are distinct
    // objects (referential identity → 2 uploads) → 3 unique uploads for 4 entries.
    const e0 = keyedThumb(fileInput.blob(shared), 'e0', 10, 10);
    const e1 = keyedThumb(fileInput.blob(shared), 'e1', 20, 20);
    const e2 = keyedThumb(fileInput.blob(twinA), 'e2', 30, 30);
    const e3 = keyedThumb(fileInput.blob(twinB), 'e3', 40, 40);

    const result = await boundBatch(mock, [e0, e1, e2, e3]).run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledTimes(3);
    expect(result.succeeded.map((s) => s.key)).toEqual(['e0', 'e1', 'e2', 'e3']);
  });

  it('collapses two identical uploadId entries to ZERO uploads (a pure no-op)', async () => {
    const mock = makeMockClient();
    const a = keyedThumb(fileInput.uploadId('pre'), 'a', 100, 100);
    const b = keyedThumb(fileInput.uploadId('pre'), 'b', 200, 200);

    const result = await boundBatch(mock, [a, b]).run({ maxWait: '30s' });

    // uploadId inputs never upload; deduping them is a no-op, both jobs keep the id.
    expect(mock.uploadFile).not.toHaveBeenCalled();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'pre',
      'pre',
    ]);
    expect(result.succeeded.map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('BatchRecipe.run — mixed success / failure', () => {
  it('a failed entry lands in `failed` (typed error) while the other succeeds; ok=false', async () => {
    const mock = makeMockClient();
    // The avatar (b1) job fails; the hero (b0) job completes → partially_failed.
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.partially_failed', data: { status: 'partially_failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'partially_failed',
      jobs: [
        { ref: 'b0', status: 'completed', operations: [] },
        { ref: 'b1', status: 'failed', operations: [{ errorMessage: 'codec exploded' }] },
      ],
    });
    mock.getWorkflowDownloads.mockResolvedValue({
      downloads: [
        { ref: 'b0', files: [{ operation: 'thumbnail', operationId: 'o0', filename: 'hero.png', sizeBytes: 10, downloadUrl: 'https://cdn/hero.png' }] },
      ],
    });

    const hero = keyedThumb(fileInput.uploadId('id0'), 'hero', 1200, 630);
    const avatar = keyedThumb(fileInput.uploadId('id1'), 'avatar', 256, 256);
    const result = await boundBatch(mock, [hero, avatar]).run({ maxWait: '30s' });

    expect(result.state).toBe('partially_failed');
    expect(result.ok).toBe(false);
    // hero succeeded, avatar failed — one failure does not sink the rest.
    expect(result.succeeded.map((s) => s.key)).toEqual(['hero']);
    expect(result.byKey('hero').outputs[0].url).toBe('https://cdn/hero.png');
    expect(result.failed.map((f) => f.key)).toEqual(['avatar']);
    expect(result.failed[0].error).toBeInstanceOf(GislItemFailedError);
    // The failed item carries THAT job's per-job scoped error message.
    expect(result.failed[0].error.message).toBe('failed: codec exploded');
    expect(result.failed[0].error.key).toBe('avatar');
    expect(result.failed[0].error.state).toBe('failed');
    expect(result.failed[0].error.errorMessage).toBe('codec exploded');
  });
});

describe('BatchRecipe.run — validation guards (pre-upload)', () => {
  it('an empty batch throws GislConfigError(no_recipes)', async () => {
    const mock = makeMockClient();
    await expect(boundBatch(mock, []).run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(boundBatch(mock, []).run()).rejects.toMatchObject({ reason: 'no_recipes' });
  });

  it('a multi-input recipe entry throws GislConfigError(multi_input_recipe_unsupported)', async () => {
    const mock = makeMockClient();
    // A FilesRecipe (multi-input builder) is REJECTED — checked BEFORE the
    // not-a-Recipe catch-all (it does not extend Recipe, so the catch-all would
    // otherwise misreport it as a plain type error).
    const files = new FilesRecipe([fileInput.uploadId('id0')]).compress();
    const entries = [files as unknown as Recipe];
    await expect(boundBatch(mock, entries).run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(boundBatch(mock, entries).run()).rejects.toMatchObject({
      reason: 'multi_input_recipe_unsupported',
    });
  });

  it('a non-Recipe entry throws GislConfigError(invalid_recipe)', async () => {
    const mock = makeMockClient();
    const entries = [{} as unknown as Recipe];
    await expect(boundBatch(mock, entries).run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(boundBatch(mock, entries).run()).rejects.toMatchObject({ reason: 'invalid_recipe' });
  });

  it('a keyless entry throws GislConfigError(missing_key)', async () => {
    const mock = makeMockClient();
    // Built via client.file(input) with NO key — every batch entry needs a key.
    const noKey = keyedThumb(fileInput.uploadId('id0'), undefined, 1200, 630);
    await expect(boundBatch(mock, [noKey]).run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(boundBatch(mock, [noKey]).run()).rejects.toMatchObject({ reason: 'missing_key' });
  });

  it('two entries with the same key throw GislConfigError(duplicate_key)', async () => {
    const mock = makeMockClient();
    const a = keyedThumb(fileInput.uploadId('id0'), 'dup', 1200, 630);
    const b = keyedThumb(fileInput.uploadId('id1'), 'dup', 256, 256);
    await expect(boundBatch(mock, [a, b]).run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(boundBatch(mock, [a, b]).run()).rejects.toMatchObject({ reason: 'duplicate_key' });
  });
});

describe('BatchRecipe.run — validation runs BEFORE any upload', () => {
  it('a duplicate-key batch of path inputs uploads NOTHING (STRUCTURAL guard trips pre-upload)', async () => {
    const mock = makeMockClient();
    // Path inputs WOULD upload — but the duplicate-key guard fires first, so a
    // later invalid entry never leaves an earlier input uploaded.
    const a = keyedThumb(fileInput.path('hero.jpg'), 'dup', 1200, 630);
    const b = keyedThumb(fileInput.path('avatar.jpg'), 'dup', 256, 256);

    await expect(boundBatch(mock, [a, b]).run({ maxWait: '30s' })).rejects.toMatchObject({
      reason: 'duplicate_key',
    });
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });

  it('an un-lowerable LATER entry fails the lowering PREFLIGHT before any upload (distinct keys)', async () => {
    // Distinct keys, so the STRUCTURAL guards all pass — this exercises the
    // per-entry lowering preflight (`entry.toWorkflowPayload('preflight')`) that
    // validatePreUpload runs for EVERY entry pre-upload. Entry 'a' is a valid
    // PATH input that WOULD upload; entry 'b' is compress(optimize) on a bare
    // upload id, which has no inferable media → media_unknown at lowering. Because
    // the preflight runs before `_uploadInputsAndCreate`, the valid entry 'a' is
    // never uploaded and no workflow is created.
    const mock = makeMockClient();
    const a = keyedThumb(fileInput.path('hero.jpg'), 'a', 1200, 630);
    const b = new Recipe(fileInput.uploadId('id1'), 'b').compress(OptimizeFor.Size);

    await expect(boundBatch(mock, [a, b]).run({ maxWait: '30s' })).rejects.toBeInstanceOf(
      GislConfigError,
    );
    await expect(boundBatch(mock, [a, b]).run({ maxWait: '30s' })).rejects.toMatchObject({
      reason: 'media_unknown',
    });
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });
});

describe('BatchRecipe.run — no-client guard', () => {
  it('throws GislConfigError(no_client) for a directly-constructed BatchRecipe', async () => {
    const bare = new BatchRecipe([keyedThumb(fileInput.uploadId('id0'), 'hero', 1200, 630)]);
    await expect(bare.run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(bare.run()).rejects.toMatchObject({ reason: 'no_client' });
  });
});

describe('BatchRecipe.run — SSE transport selection (wf133EDR)', () => {
  it('attempts the SSE stream by default (SSE-first)', async () => {
    const mock = makeMockClient();
    const hero = keyedThumb(fileInput.uploadId('id0'), 'hero', 1200, 630);
    const avatar = keyedThumb(fileInput.uploadId('id1'), 'avatar', 256, 256);
    await boundBatch(mock, [hero, avatar]).run({ maxWait: '30s' });
    expect(mock.streamEvents).toHaveBeenCalled();
  });

  it('useSSE:false polls directly and never opens the SSE stream', async () => {
    const mock = makeMockClient();
    const hero = keyedThumb(fileInput.uploadId('id0'), 'hero', 1200, 630);
    const avatar = keyedThumb(fileInput.uploadId('id1'), 'avatar', 256, 256);
    const result = await boundBatch(mock, [hero, avatar]).run({ maxWait: '30s', useSSE: false });

    // Poll-direct: streamEvents skipped, terminal resolved via getWorkflowStatus.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.succeeded.map((s) => s.key)).toEqual(['hero', 'avatar']);
  });
});

// ---------------------------------------------------------------------------
// toWorkflowPayload — the cross-language GOLDEN lowering pin (codex r2 #4). The
// PHP BatchRecipeTest asserts its batch lowers the SAME 2-entry keyed-thumbnail
// batch to the SAME expected JSON. No validation / preflight runs here (that is
// run()'s job), so a client-less BatchRecipe lowers purely.
// ---------------------------------------------------------------------------

describe('BatchRecipe.toWorkflowPayload — golden lowered payload', () => {
  const goldenBatch = (): BatchRecipe =>
    new BatchRecipe([
      keyedThumb(fileInput.uploadId('u0'), 'hero', 1200, 630),
      keyedThumb(fileInput.uploadId('u1'), 'avatar', 256, 256),
    ]);

  it('lowers to the exact shared shape (b0/b1 ids, per-job source, preserved operations)', () => {
    const payload = goldenBatch().toWorkflowPayload(['id0', 'id1']);
    expect(payload).toEqual(GOLDEN_PAYLOAD);
  });

  it('serialises byte-identically to the cross-language golden JSON', () => {
    const payload = goldenBatch().toWorkflowPayload(['id0', 'id1']);
    expect(JSON.stringify(payload)).toBe(GOLDEN_JSON);
  });

  it('omits callback_url when no webhook is given', () => {
    const payload = goldenBatch().toWorkflowPayload(['id0', 'id1']);
    expect('callback_url' in payload).toBe(false);
    expect(payload.callback_url).toBeUndefined();
  });

  it('builds callback_url INTO the payload when a webhook is supplied', () => {
    const payload = goldenBatch().toWorkflowPayload(['id0', 'id1'], 'https://webhook.test/x');
    expect(payload.callback_url).toBe('https://webhook.test/x');
    // Job order + ids are unchanged by the webhook.
    expect(payload.jobs.map((j) => j.id)).toEqual(['b0', 'b1']);
  });
});

describe('BatchRecipe — recipeCount', () => {
  it('reports the number of entries', () => {
    const batch = new BatchRecipe([
      keyedThumb(fileInput.uploadId('u0'), 'hero', 1200, 630),
      keyedThumb(fileInput.uploadId('u1'), 'avatar', 256, 256),
    ]);
    expect(batch.recipeCount).toBe(2);
    expect(new BatchRecipe([]).recipeCount).toBe(0);
  });
});
