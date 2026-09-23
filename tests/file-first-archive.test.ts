import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesRecipe, ArchivedRecipe, fileInput, isArchiveStatus } from '../src/file-first.js';
import type { ArchiveRecipeOptions } from '../src/file-first.js';
import type { GislClient } from '../src/client.js';
import type { WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislApiError, GislConfigError, GislTimeoutError } from '../src/errors.js';

/**
 * FF3b — the fluent `files([...]).archive(...)` N→1 bundle (terminal; no
 * post-bundle chain). Mirrors the PHP `ArchivedRecipeTest`: lowering shape
 * (passthrough srcs + an archive job consuming them via `job_output`), the
 * archive-must-be-first guard, the 2–50 input bounds firing BEFORE upload, and
 * the `isArchiveStatus` detection used for Handle projection.
 */

const archivedRecipe = (paths: string[], options: ArchiveRecipeOptions = {}): ArchivedRecipe =>
  new ArchivedRecipe(paths.map((p) => fileInput.path(p)), options);

describe('ArchivedRecipe — lowering', () => {
  it('lowers to one passthrough src job per input plus an archive job', () => {
    const archived = archivedRecipe(['report.pdf', 'hero.jpg', 'narration.mp3'], {
      format: 'zip',
      folderStructure: 'by_job',
    });

    const payload = archived.toWorkflowPayload(['f0', 'f1', 'f2']);

    expect(payload.jobs).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      const src = payload.jobs[i];
      expect(src.id).toBe(`src_${i}`);
      expect(src.operations[0].type).toBe('passthrough');
      expect(src.source).toEqual({ type: 'upload', file_id: `f${i}` });
    }

    const archiveJob = payload.jobs[3];
    expect(archiveJob.id).toBe('archive');
    expect(archiveJob.inputs).toHaveLength(3);
    expect(archiveJob.inputs?.[0].source).toEqual({ type: 'job_output', from: 'src_0' });

    expect(archiveJob.operations).toHaveLength(1);
    expect(archiveJob.operations[0].type).toBe('archive');
    expect(archiveJob.operations[0].options).toEqual({ format: 'zip', folder_structure: 'by_job' });
  });

  it('omits options entirely when none are set (server defaults zip/flat)', () => {
    const payload = archivedRecipe(['a.pdf', 'b.pdf']).toWorkflowPayload(['f0', 'f1']);
    const archiveJob = payload.jobs[2];
    expect(archiveJob.operations[0].options).toEqual({});
  });

  it('wires the callback url into the payload', () => {
    const payload = archivedRecipe(['a.pdf', 'b.pdf']).toWorkflowPayload(['f0', 'f1'], 'https://example.com/cb');
    expect(payload.callback_url).toBe('https://example.com/cb');
  });
});

describe('ArchivedRecipe — guards', () => {
  it('archive() must be the first operation on files([...])', () => {
    const recipe = new FilesRecipe(
      [fileInput.path('a.pdf'), fileInput.path('b.pdf')],
    ).compress(OptimizeFor.Size);

    expect(() => recipe.archive()).toThrow(GislConfigError);
    expect(() => recipe.archive()).toThrow(/archive\(\) must be the first operation/);
  });

  it('submit() rejects fewer than two inputs BEFORE any upload fires', async () => {
    const uploadFile = vi.fn();
    const archived = new ArchivedRecipe(
      [fileInput.path('only.pdf')],
      {},
      { uploadFile, createWorkflow: vi.fn(), maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    await expect(archived.submit()).rejects.toThrow(/at least 2 inputs/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('submit() rejects more than fifty inputs BEFORE any upload fires', async () => {
    const uploadFile = vi.fn();
    const archived = new ArchivedRecipe(
      Array.from({ length: 51 }, (_, i) => fileInput.path(`f-${i}.pdf`)),
      {},
      { uploadFile, createWorkflow: vi.fn(), maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    await expect(archived.submit()).rejects.toThrow(/at most 50 inputs/);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('isArchiveStatus — data-driven archive detection (for Handle projection)', () => {
  const status = (refs: string[]): WorkflowStatusResponse =>
    ({ status: 'completed', jobs: refs.map((ref) => ({ ref })) }) as unknown as WorkflowStatusResponse;

  it('is true for the src_N + archive lowering shape', () => {
    expect(isArchiveStatus(status(['src_0', 'src_1', 'archive']))).toBe(true);
  });

  it('is false for a merge shape (src_N + merge)', () => {
    expect(isArchiveStatus(status(['src_0', 'src_1', 'merge']))).toBe(false);
  });

  it('is false when there is no archive job', () => {
    expect(isArchiveStatus(status(['src_0', 'src_1']))).toBe(false);
  });

  it('is false for an empty job list', () => {
    expect(isArchiveStatus(status([]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run() — end-to-end via vi.fn client doubles (mirrors file-first-run.test.ts).
// xxy5Rlsy follow-up (Wi4OnaJE): ArchivedRecipe.run() only reached the shared
// `_uploadInputsAndCreate` helper transitively (lowering + count-guard submit
// tests). These tests drive it at RUNTIME.
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
    contentType: 'application/pdf',
    sizeBytes: 1024,
  }));
  const createWorkflow = vi.fn(async (_payload: unknown) => ({ workflowId: 'wf_1', status: 'running' }));
  const getWorkflowStatus = vi.fn(async (_id: string) => ({
    workflowId: 'wf_1',
    status: 'completed',
    jobs: [{ ref: 'archive', status: 'completed', operations: [] }],
  }));
  // The downloads carry the src_* passthrough re-exposures of the raw uploads
  // ALONGSIDE the archive output, so run()'s `ref === 'archive'` filter is
  // genuinely exercised — a regression that stopped filtering would surface the
  // src_* plumbing as artifacts.
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      { ref: 'src_0', files: [{ operation: 'passthrough', operationId: 's0', filename: 'report.pdf', sizeBytes: 1, downloadUrl: 'https://signed.example.com/report.pdf' }] },
      { ref: 'src_1', files: [{ operation: 'passthrough', operationId: 's1', filename: 'hero.jpg', sizeBytes: 1, downloadUrl: 'https://signed.example.com/hero.jpg' }] },
      { ref: 'archive', files: [{ operation: 'archive', operationId: 'oa', filename: 'bundle.zip', sizeBytes: 99, downloadUrl: 'https://signed.example.com/bundle.zip' }] },
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

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ArchivedRecipe.run — happy path through the shared helper', () => {
  it('uploads every input, creates the lowered archive DAG, and projects ONLY the archive output', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'up0', contentType: 'application/pdf', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'up1', contentType: 'image/jpeg', sizeBytes: 1 });

    const result = await new ArchivedRecipe(
      [fileInput.path('report.pdf'), fileInput.path('hero.jpg')],
      { format: 'zip' },
      mock.client,
    ).run({ maxWait: '30s' });

    // Both inputs uploaded; the probe gate is consulted once per uploaded input
    // with that input's id (the helper's per-input probe targets).
    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    expect(mock.maybeWaitForVideoProbe.mock.calls.map((c) => c[0])).toEqual(['up0', 'up1']);

    // ONE workflow created from the lowered archive DAG: a passthrough src job
    // per input (referencing the uploaded ids) + a terminal archive job.
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['src_0', 'src_1', 'archive']);
    expect(payload.jobs[0].source).toEqual({ type: 'upload', file_id: 'up0' });
    expect(payload.jobs[1].source).toEqual({ type: 'upload', file_id: 'up1' });
    expect(payload.jobs[2].operations[0].type).toBe('archive');

    // The RunResult projects ONLY the archive output — the src_* passthrough
    // downloads (raw uploads) are filtered out.
    expect(result.state).toBe('completed');
    expect(result.ok).toBe(true);
    expect(result.artifacts.map((a) => a.filename)).toEqual(['bundle.zip']);
    expect(result.url).toBe('https://signed.example.com/bundle.zip');
  });
});

describe('ArchivedRecipe.run — SSE transport selection (wf133EDR)', () => {
  it('attempts the SSE stream by default (SSE-first)', async () => {
    const mock = makeMockClient();
    await new ArchivedRecipe(
      [fileInput.path('a.pdf'), fileInput.path('b.pdf')],
      { format: 'zip' },
      mock.client,
    ).run({ maxWait: '30s' });
    expect(mock.streamEvents).toHaveBeenCalled();
  });

  it('useSSE:false polls directly and never opens the SSE stream', async () => {
    const mock = makeMockClient();
    const result = await new ArchivedRecipe(
      [fileInput.path('a.pdf'), fileInput.path('b.pdf')],
      { format: 'zip' },
      mock.client,
    ).run({ maxWait: '30s', useSSE: false });
    // Poll-direct: streamEvents skipped, terminal resolved via getWorkflowStatus.
    expect(mock.streamEvents).not.toHaveBeenCalled();
    expect(mock.getWorkflowStatus).toHaveBeenCalled();
    expect(result.state).toBe('completed');
    expect(result.artifacts.map((a) => a.filename)).toEqual(['bundle.zip']);
  });
});

describe('ArchivedRecipe.run — timeout label', () => {
  // Pin the archive label noun the shared helper threads into its timeout
  // message. A mid-batch deadline (maxWait 1ms + a slow first upload over two
  // inputs) trips the `during ${uploadsLabel} uploads` throw — asserting the
  // MESSAGE (not the racy upload call-count) locks the noun.
  it('its mid-batch timeout message names the archive label', async () => {
    const mock = makeMockClient();
    mock.uploadFile.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { fileId: 'uploaded', contentType: 'application/pdf', sizeBytes: 1 };
    });

    const err = await new ArchivedRecipe(
      [fileInput.path('a.pdf'), fileInput.path('b.pdf')],
      {},
      mock.client,
    )
      .run({ maxWait: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislTimeoutError);
    expect((err as Error).message).toContain('archive');
    expect(mock.createWorkflow).not.toHaveBeenCalled();
  });
});

// pE6JVJuc — the planned-everywhere value gate runs in the SHARED multi-input
// preflight, before any upload. archive `folder_structure: 'by_job'` is planned.
describe('ArchivedRecipe — planned value refused before upload (pE6JVJuc)', () => {
  it("folderStructure:'by_job' throws feature_not_available with ZERO uploads", async () => {
    const mock = makeMockClient();
    await expect(
      new ArchivedRecipe(
        [fileInput.path('report.pdf'), fileInput.path('hero.jpg')],
        { format: 'zip', folderStructure: 'by_job' },
        mock.client,
      ).run({ maxWait: '30s' }),
    ).rejects.toMatchObject({ reason: 'feature_not_available', conflictingFields: ['folder_structure'] });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });

  it('submit() is refused the same way', async () => {
    const mock = makeMockClient();
    await expect(
      new ArchivedRecipe(
        [fileInput.path('report.pdf'), fileInput.path('hero.jpg')],
        { folderStructure: 'by_job' },
        mock.client,
      ).submit(),
    ).rejects.toMatchObject({ reason: 'feature_not_available' });
    expect(mock.uploadFile).not.toHaveBeenCalled();
  });
});


// bTNCSX1x — a file-first recipe's terminal downloads fetch retries a 429.
describe('ArchivedRecipe — 429 on the downloads fetch (bTNCSX1x)', () => {
  it('is retried and the archive completes', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'up0', contentType: 'application/pdf', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'up1', contentType: 'image/jpeg', sizeBytes: 1 });
    mock.getWorkflowDownloads.mockRejectedValueOnce(
      new GislApiError(429, 'RATE_LIMITED', '/downloads', undefined, { responseHeaders: { 'retry-after': '1' } }),
    );
    await new ArchivedRecipe(
      [fileInput.path('report.pdf'), fileInput.path('hero.jpg')],
      { format: 'zip' },
      mock.client,
    ).run({ maxWait: '30s' });
    expect(mock.getWorkflowDownloads).toHaveBeenCalledTimes(2);
  });
});
