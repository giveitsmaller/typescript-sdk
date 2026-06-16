import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Recipe, FilesRecipe, MergedRecipe, fileInput } from '../../src/file-first.js';
import { OperationBuilder } from '../../src/builder.js';
import { MergeBuilder, asset } from '../../src/merge.js';
import type { GislClient } from '../../src/client.js';

/**
 * YOA6FpFr PR2 — seam-wiring: every ergonomic upload→create path must call
 * `client.maybeWaitForVideoProbe` AFTER the upload and BEFORE createWorkflow,
 * passing the recipe's media classification (isVideo), the upload response's
 * sizeBytes, and `enabled = probeBeforeCreate ?? true`. The gate's own
 * behaviour is covered in maybe-wait-for-video-probe.test.ts; here we assert
 * the WIRING (args + order) with a spy double for maybeWaitForVideoProbe.
 */

interface MockClientHandles {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
  maybeWaitForVideoProbe: ReturnType<typeof vi.fn>;
  client: GislClient;
}

/** Upload double that returns the requested sizeBytes (default 99 MB). */
function makeMockClient(uploadSizeBytes = 99_000_000): MockClientHandles {
  const uploadFile = vi.fn(async (_input: string | Blob) => ({
    fileId: 'file_up',
    contentType: 'video/mp4',
    sizeBytes: uploadSizeBytes,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({ workflowId: 'wf_1', status: 'running' }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    jobs: [
      { ref: 'op', status: 'completed', operations: [] },
      { ref: 'file-0', status: 'completed', operations: [] },
      { ref: 'file-1', status: 'completed', operations: [] },
      { ref: 'merge', status: 'completed', operations: [] },
    ],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({ downloads: [] }));
  const streamEvents = vi.fn(async function* (_id: string, _opts?: unknown) {
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
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Recipe (file-first single input).
// ---------------------------------------------------------------------------

describe('Recipe.run — probe-before-create wiring', () => {
  it('calls maybeWaitForVideoProbe once for a VIDEO input, with the upload sizeBytes', async () => {
    const mock = makeMockClient(99_000_000);
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .run({ maxWait: '30s' });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: true, isVideo: true, sizeBytes: 99_000_000 });
  });

  it('calls the gate BEFORE createWorkflow (order via invocationCallOrder)', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .run({ maxWait: '30s' });

    const probeOrder = mock.maybeWaitForVideoProbe.mock.invocationCallOrder[0];
    const createOrder = mock.createWorkflow.mock.invocationCallOrder[0];
    const uploadOrder = mock.uploadFile.mock.invocationCallOrder[0];
    expect(uploadOrder).toBeLessThan(probeOrder); // after upload
    expect(probeOrder).toBeLessThan(createOrder); // before create
  });

  it('passes isVideo:false for an IMAGE input', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('photo.jpg'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .run({ maxWait: '30s' });

    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ isVideo: false });
  });

  it('run({ probeBeforeCreate: false }) passes enabled:false to the gate', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .run({ maxWait: '30s', probeBeforeCreate: false });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: false });
  });

  it('run({ probeTimeoutMs }) threads the timeout to the gate', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .run({ maxWait: '30s', probeTimeoutMs: 4321 });

    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ timeoutMs: 4321 });
  });

  it('uploadId (pre-uploaded) input → gate is NOT called (no local sizeBytes)', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.uploadId('file_existing'), undefined, [], undefined, undefined, mock.client)
      .convert('webp')
      .run({ maxWait: '30s' });

    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.maybeWaitForVideoProbe).not.toHaveBeenCalled();
  });
});

describe('Recipe.submit — probe-before-create wiring', () => {
  it("submit('https://hook', { probeBeforeCreate: false }) threads enabled:false", async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .submit('https://hook', { probeBeforeCreate: false });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: false, isVideo: true });
  });

  it('submit() defaults enabled:true and fires the gate before createWorkflow', async () => {
    const mock = makeMockClient();
    await new Recipe(fileInput.path('clip.mp4'), undefined, [], undefined, undefined, mock.client)
      .compress()
      .submit();

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: true });
    expect(mock.maybeWaitForVideoProbe.mock.invocationCallOrder[0]).toBeLessThan(
      mock.createWorkflow.mock.invocationCallOrder[0],
    );
  });
});

// ---------------------------------------------------------------------------
// OperationBuilder (operation-first single input).
// ---------------------------------------------------------------------------

describe('OperationBuilder.run — probe-before-create wiring', () => {
  it('calls the gate with isVideo:true for a .mp4 input, before createWorkflow', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'clip.mp4', {}).run({ maxWait: '30s' });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: true, isVideo: true, sizeBytes: 99_000_000 });
    expect(mock.maybeWaitForVideoProbe.mock.invocationCallOrder[0]).toBeLessThan(
      mock.createWorkflow.mock.invocationCallOrder[0],
    );
  });

  it('passes isVideo:false for a .jpg input', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'photo.jpg', {}).run({ maxWait: '30s' });
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ isVideo: false });
  });

  it('run({ probeBeforeCreate: false }) → enabled:false', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'clip.mp4', {}).run({
      maxWait: '30s',
      probeBeforeCreate: false,
    });
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: false });
  });

  it('submit({ probeBeforeCreate: false }) → enabled:false', async () => {
    const mock = makeMockClient();
    await new OperationBuilder(mock.client, 'compress', 'clip.mp4', {}).submit({
      webhook: 'https://hook',
      probeBeforeCreate: false,
    });
    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    const [, opts] = mock.maybeWaitForVideoProbe.mock.calls[0];
    expect(opts).toMatchObject({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// FilesRecipe (multi-input homogeneous fan-out) — per-input isVideo.
// ---------------------------------------------------------------------------

describe('FilesRecipe.run — probe-before-create wiring (per input)', () => {
  it('calls the gate per uploaded input with the correct isVideo per input (mixed video+image)', async () => {
    const mock = makeMockClient();
    // Distinct sizeBytes per upload so we can match each gate call to its input.
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'v0', contentType: 'video/mp4', sizeBytes: 50_000_000 })
      .mockResolvedValueOnce({ fileId: 'i1', contentType: 'image/jpeg', sizeBytes: 60_000_000 });

    await new FilesRecipe(
      [fileInput.path('clip.mp4'), fileInput.path('photo.jpg')],
      [],
      undefined,
      undefined,
      mock.client,
    )
      .compress()
      .run({ maxWait: '30s' });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledTimes(2);
    const calls = mock.maybeWaitForVideoProbe.mock.calls;
    const videoCall = calls.find((c) => c[0] === 'v0');
    const imageCall = calls.find((c) => c[0] === 'i1');
    expect(videoCall?.[1]).toMatchObject({ isVideo: true, sizeBytes: 50_000_000 });
    expect(imageCall?.[1]).toMatchObject({ isVideo: false, sizeBytes: 60_000_000 });
  });

  it('uploadId inputs are NOT probed (only uploaded inputs are)', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockResolvedValueOnce({ fileId: 'v0', contentType: 'video/mp4', sizeBytes: 50_000_000 });

    await new FilesRecipe(
      [fileInput.path('clip.mp4'), fileInput.uploadId('pre_uploaded')],
      [],
      undefined,
      undefined,
      mock.client,
    )
      .compress()
      .run({ maxWait: '30s' });

    // One uploaded input → exactly one gate call; the uploadId input is skipped.
    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledOnce();
    expect(mock.maybeWaitForVideoProbe.mock.calls[0][0]).toBe('v0');
  });

  it('run({ probeBeforeCreate: false }) threads enabled:false to every per-input gate call', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'v0', contentType: 'video/mp4', sizeBytes: 50_000_000 })
      .mockResolvedValueOnce({ fileId: 'v1', contentType: 'video/mp4', sizeBytes: 60_000_000 });

    await new FilesRecipe(
      [fileInput.path('a.mp4'), fileInput.path('b.mp4')],
      [],
      undefined,
      undefined,
      mock.client,
    )
      .compress()
      .run({ maxWait: '30s', probeBeforeCreate: false });

    for (const call of mock.maybeWaitForVideoProbe.mock.calls) {
      expect(call[1]).toMatchObject({ enabled: false });
    }
  });
});

// ---------------------------------------------------------------------------
// MergedRecipe (file-first N→1 merge) — per-input isVideo.
// ---------------------------------------------------------------------------

describe('MergedRecipe.run — probe-before-create wiring (per input)', () => {
  it('calls the gate per uploaded input with per-input isVideo (mixed video+image)', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'v0', contentType: 'video/mp4', sizeBytes: 50_000_000 })
      .mockResolvedValueOnce({ fileId: 'i1', contentType: 'image/jpeg', sizeBytes: 60_000_000 });

    await new MergedRecipe(
      [fileInput.path('clip.mp4'), fileInput.path('photo.jpg')],
      { mediaKind: 'video', output: 'video' },
      [],
      undefined,
      undefined,
      mock.client,
    ).run({ maxWait: '30s' });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledTimes(2);
    const calls = mock.maybeWaitForVideoProbe.mock.calls;
    expect(calls.find((c) => c[0] === 'v0')?.[1]).toMatchObject({ isVideo: true, sizeBytes: 50_000_000 });
    expect(calls.find((c) => c[0] === 'i1')?.[1]).toMatchObject({ isVideo: false, sizeBytes: 60_000_000 });
  });
});

// ---------------------------------------------------------------------------
// MergeBuilder (operation-first merge) — per-input isVideo.
// ---------------------------------------------------------------------------

describe('MergeBuilder.run — probe-before-create wiring (per input)', () => {
  it('calls the gate per uploaded asset, before createWorkflow', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'm0', contentType: 'video/mp4', sizeBytes: 50_000_000 })
      .mockResolvedValueOnce({ fileId: 'm1', contentType: 'video/mp4', sizeBytes: 60_000_000 });

    await new MergeBuilder(mock.client, [asset('a.mp4'), asset('b.mp4')], {}).run({ maxWait: '30s' });

    expect(mock.maybeWaitForVideoProbe).toHaveBeenCalledTimes(2);
    for (const call of mock.maybeWaitForVideoProbe.mock.calls) {
      expect(call[1]).toMatchObject({ enabled: true, isVideo: true });
    }
    // All gate calls precede createWorkflow.
    const createOrder = mock.createWorkflow.mock.invocationCallOrder[0];
    for (const order of mock.maybeWaitForVideoProbe.mock.invocationCallOrder) {
      expect(order).toBeLessThan(createOrder);
    }
  });
});
