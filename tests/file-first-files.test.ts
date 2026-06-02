import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FilesRecipe,
  Recipe,
  RunResult,
  fileInput,
  projectMultiJobToRunResult,
} from '../src/file-first.js';
import { create } from '../src/gisl.js';
import { resolveCompressOptions } from '../src/ergonomic/preset_resolver.js';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError, GislNoSuchKeyError, GislTimeoutError } from '../src/errors.js';
import type { GislClient } from '../src/client.js';
import type { WorkflowStatusResponse, OperationDownload } from '@giveitsmaller/contracts/openapi';

/**
 * FF3a (u0hBt6fl) — the file-first {@link FilesRecipe} homogeneous fan-out:
 * clone-on-write immutability, multi-job lowering (one job per file, the
 * `file-{i}` id scheme, per-file media-hint), and the partitioned
 * {@link RunResult} (string-index keys, one-failure-doesn't-sink). Mirrors the
 * PHP `FilesRecipeTest`.
 */

const filesRecipe = (...paths: string[]): FilesRecipe =>
  new FilesRecipe(paths.map((p) => fileInput.path(p)));

// ---------------------------------------------------------------------------
// Immutability (clone-on-write) — the headline AC, mirroring Recipe.
// ---------------------------------------------------------------------------

describe('FilesRecipe — immutability (clone-on-write)', () => {
  it('chaining an op returns a NEW FilesRecipe and does not mutate the original', () => {
    const base = filesRecipe('a.jpg', 'b.jpg');
    const compressed = base.compress(OptimizeFor.Balanced);

    expect(base.stepCount).toBe(0);
    expect(compressed.stepCount).toBe(1);
    expect(compressed).not.toBe(base);
    // The input list is preserved across the clone.
    expect(compressed.inputCount).toBe(2);
    expect(base.inputCount).toBe(2);
  });

  it('two branches off one base are independent', () => {
    const base = filesRecipe('a.mov', 'b.mov');
    const branchA = base.convert('mp4').compress(OptimizeFor.Size);
    const branchB = base.thumbnail({ width: 320 });

    expect(base.stepCount).toBe(0);
    expect(branchA.stepCount).toBe(2);
    expect(branchB.stepCount).toBe(1);

    // Re-lower the base AFTER both branches are built — its jobs must still
    // carry ZERO operations (catches a shared-array mutation stepCount misses).
    const baseJobs = base.toWorkflowPayload(['f0', 'f1']).jobs;
    expect(baseJobs.map((j) => j.operations)).toEqual([[], []]);
    expect(branchA.toWorkflowPayload(['f0', 'f1']).jobs[0].operations.map((o) => o.type)).toEqual([
      'convert',
      'compress',
    ]);
  });
});

// ---------------------------------------------------------------------------
// client.files() entry point.
// ---------------------------------------------------------------------------

describe('FilesRecipe — client.files() entry point', () => {
  it('returns a FilesRecipe carrying the inputs', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    const r = client.files(['a.jpg', 'b.jpg', 'c.jpg']);

    expect(r).toBeInstanceOf(FilesRecipe);
    expect(r.inputCount).toBe(3);
    expect(r.stepCount).toBe(0);
  });

  it('accepts a mix of string paths and pre-uploaded FileInputs', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    const r = client.files(['a.jpg', fileInput.uploadId('uploaded-123')]).convert('webp');
    const jobs = r.toWorkflowPayload(['file_0000', 'file_0001']).jobs;

    expect(jobs[0].source).toEqual({ type: 'upload', file_id: 'file_0000' });
    expect(jobs[1].source).toEqual({ type: 'upload', file_id: 'file_0001' });
  });

  it('files([]) (empty list) throws GislConfigError(no_inputs) — a zero-input fan-out is a caller error', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    // The guard fires synchronously, before any upload/create — "one bad input
    // doesn't sink the rest" is meaningless with no inputs.
    expect(() => client.files([])).toThrow(GislConfigError);
    try {
      client.files([]);
      expect.unreachable('files([]) must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('no_inputs');
    }
  });
});

// ---------------------------------------------------------------------------
// toWorkflowPayload — one job per file, id scheme, shared operations[].
// ---------------------------------------------------------------------------

describe('FilesRecipe — toWorkflowPayload (multi-job lowering)', () => {
  it('emits one job per input with id "file-{i}", upload source, and the SHARED chain', () => {
    const payload = filesRecipe('a.jpg', 'b.jpg', 'c.jpg')
      .convert('webp')
      .toWorkflowPayload(['file_0', 'file_1', 'file_2']);

    expect(payload.jobs).toHaveLength(3);
    expect(payload.jobs.map((j) => j.id)).toEqual(['file-0', 'file-1', 'file-2']);
    payload.jobs.forEach((job, i) => {
      expect(job.source).toEqual({ type: 'upload', file_id: `file_${i}` });
      // Every input gets the SAME lowered operations[].
      expect(job.operations).toEqual([{ type: 'convert', options: { format: 'webp' } }]);
      // Wire key order (id, source, operations) for cross-language JSON parity.
      expect(Object.keys(job)).toEqual(['id', 'source', 'operations']);
    });
  });

  it('resolves the compress preset PER FILE so different media classes diverge', () => {
    // a.jpg → image preset cell; clip.mov → video preset cell. The fan-out must
    // compose Recipe per input so each picks its own media-hint, NOT lower once.
    const payload = filesRecipe('a.jpg', 'clip.mov')
      .compress(OptimizeFor.Balanced)
      .toWorkflowPayload(['file_0', 'file_1']);

    const imageExpected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
    }).wireOptions;
    const videoExpected = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    expect(payload.jobs[0].operations[0]).toEqual({ type: 'compress', options: imageExpected });
    expect(payload.jobs[1].operations[0]).toEqual({ type: 'compress', options: videoExpected });
    // Proof they actually differ (image and video presets are distinct cells).
    expect(payload.jobs[0].operations[0].options).not.toEqual(
      payload.jobs[1].operations[0].options,
    );
  });

  it('forwards client preset defaults into every job via files()', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    const r = client.files(['a.jpg', 'b.jpg']);
    expect(r).toBeInstanceOf(FilesRecipe);
    // Lowering does not throw and produces two jobs — defaults flow through the
    // per-file Recipe composition.
    const payload = r.compress(OptimizeFor.Size).toWorkflowPayload(['f0', 'f1']);
    expect(payload.jobs).toHaveLength(2);
    expect(payload.jobs.every((j) => j.operations[0].type === 'compress')).toBe(true);
  });

  it('rejects an unknown optimize value (reuses Recipe validation)', () => {
    expect(() => filesRecipe('a.jpg').compress('Smallest' as OptimizeFor)).toThrow(GislConfigError);
  });

  it('serialises a single-input fan-out to a stable JSON shape', () => {
    const json = JSON.stringify(filesRecipe('a.jpg').convert('webp').toWorkflowPayload(['file_0']));
    expect(json).toBe(
      '{"jobs":[{"id":"file-0","source":{"type":"upload","file_id":"file_0"},"operations":[{"type":"convert","options":{"format":"webp"}}]}]}',
    );
  });
});

// ---------------------------------------------------------------------------
// projectMultiJobToRunResult — the partition producer (string-index keys,
// one-failure-doesn't-sink). Exercised directly so the partition logic is
// pinned without driving the whole run() orchestration.
// ---------------------------------------------------------------------------

const dl = (
  ref: string,
  files: { url: string; filename: string; sizeBytes: number; operation: string }[],
): { ref: string; files: readonly OperationDownload[] } => ({
  ref,
  files: files.map((f) => ({
    downloadUrl: f.url,
    filename: f.filename,
    sizeBytes: f.sizeBytes,
    operation: f.operation,
    operationId: 'opid',
  })) as unknown as OperationDownload[],
});

const keyByRef = (n: number): ReadonlyMap<string, string | null> =>
  new Map(Array.from({ length: n }, (_, i) => [`file-${i}`, String(i)] as const));

describe('projectMultiJobToRunResult — partition', () => {
  it('partitions all-completed jobs into succeeded keyed by string index, ok=true', () => {
    const status = {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
    const result = projectMultiJobToRunResult(
      'wf_1',
      status,
      [
        dl('file-0', [{ url: 'u0', filename: 'a.webp', sizeBytes: 10, operation: 'compress' }]),
        dl('file-1', [{ url: 'u1', filename: 'b.webp', sizeBytes: 20, operation: 'compress' }]),
      ],
      keyByRef(2),
    );

    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(result.byKey('0').outputs[0].filename).toBe('a.webp');
    expect(result.byKey('1').outputs[0].filename).toBe('b.webp');
    // The flat artifacts[] carries every job's outputs in job order.
    expect(result.artifacts.map((a) => a.url)).toEqual(['u0', 'u1']);
  });

  it('one failing job does NOT sink the rest — succeeded=[0,2], failed=[1], ok=false', () => {
    const status = {
      status: 'partially_failed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'failed', operations: [{ errorMessage: 'codec exploded' }] },
        { ref: 'file-2', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
    const result = projectMultiJobToRunResult(
      'wf_1',
      status,
      [
        dl('file-0', [{ url: 'u0', filename: 'a.webp', sizeBytes: 10, operation: 'compress' }]),
        dl('file-2', [{ url: 'u2', filename: 'c.webp', sizeBytes: 30, operation: 'compress' }]),
      ],
      keyByRef(3),
    );

    expect(result.state).toBe('partially_failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded.map((s) => s.key)).toEqual(['0', '2']);
    expect(result.failed.map((f) => f.key)).toEqual(['1']);
    // The failed item carries THAT job's first op error, scoped via the PER-JOB
    // status (not the workflow state): "{jobStatus}: {message}".
    expect(result.failed[0].error).toBeInstanceOf(Error);
    expect((result.failed[0].error as Error).message).toBe('failed: codec exploded');
    // The succeeded outputs are still resolvable; the failed job carries none.
    expect(result.byKey('0').outputs[0].url).toBe('u0');
    expect(result.byKey('2').outputs[0].url).toBe('u2');
    expect(result.artifacts.map((a) => a.url)).toEqual(['u0', 'u2']);
  });

  it('a non-completed job with no op error message falls back to the bare status', () => {
    const status = {
      status: 'partially_failed',
      jobs: [{ ref: 'file-0', status: 'failed', operations: [] }],
    } as unknown as WorkflowStatusResponse;
    const result = projectMultiJobToRunResult('wf_1', status, [], keyByRef(1));
    expect((result.failed[0].error as Error).message).toBe('failed');
  });

  it('ALL jobs failed (workflow `failed`, not partially_failed) → failed=[0,1], succeeded=[], zero artifacts, no `url` key', () => {
    // The symmetric bookend to the one-failure-doesn't-sink case: when EVERY
    // input fails the workflow state is `failed`. Both jobs partition into
    // failed, each carrying ITS OWN scoped error; nothing succeeds; the flat
    // artifacts[] is empty and toJSON() OMITS the single-output `url` sugar.
    const status = {
      status: 'failed',
      jobs: [
        { ref: 'file-0', status: 'failed', operations: [{ errorMessage: 'codec exploded' }] },
        { ref: 'file-1', status: 'failed', operations: [{ errorMessage: 'unsupported pixel format' }] },
      ],
    } as unknown as WorkflowStatusResponse;
    const result = projectMultiJobToRunResult('wf_1', status, [], keyByRef(2));

    expect(result.state).toBe('failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded).toEqual([]);
    expect(result.failed.map((f) => f.key)).toEqual(['0', '1']);
    // Each failed item carries THAT job's first op error, scoped via its PER-JOB
    // status: "{jobStatus}: {message}".
    expect((result.failed[0].error as Error).message).toBe('failed: codec exploded');
    expect((result.failed[1].error as Error).message).toBe('failed: unsupported pixel format');
    expect(result.artifacts).toEqual([]);
    // Zero artifacts → single-output `url` sugar is undefined and toJSON() omits
    // the key entirely (cross-language parity with PHP's omit-when-null toArray()).
    expect(result.url).toBeUndefined();
    expect('url' in result.toJSON()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// byKey — string-index keys resolve; missing keys + integer-style lookups
// throw GislNoSuchKeyError.
// ---------------------------------------------------------------------------

describe('FilesRecipe RunResult — byKey string-index addressing', () => {
  const completed = (): RunResult => {
    const status = {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
    return projectMultiJobToRunResult(
      'wf_1',
      status,
      [
        dl('file-0', [{ url: 'u0', filename: 'a.webp', sizeBytes: 10, operation: 'compress' }]),
        dl('file-1', [{ url: 'u1', filename: 'b.webp', sizeBytes: 20, operation: 'compress' }]),
      ],
      keyByRef(2),
    );
  };

  it("byKey('0') resolves the first input", () => {
    expect(completed().byKey('0').key).toBe('0');
  });

  it('byKey of a missing key throws GislNoSuchKeyError', () => {
    expect(() => completed().byKey('5')).toThrow(GislNoSuchKeyError);
    expect(() => completed().byKey('hero')).toThrow(GislNoSuchKeyError);
  });

  it('the key is the STRING index, so a numeric-style lookup that stringifies differently misses', () => {
    // Keys are strings ("0", "1"). A lookup for a key that does not stringify to
    // exactly "0"/"1" (e.g. a leading-zero or float form) finds nothing — proving
    // the partition keys are the verbatim String(i) values, not loose-equal ints.
    const r = completed();
    expect(r.byKey('0').key).toBe('0');
    expect(() => r.byKey('00')).toThrow(GislNoSuchKeyError);
    expect(() => r.byKey('0.0')).toThrow(GislNoSuchKeyError);
  });
});

// ---------------------------------------------------------------------------
// run() — end-to-end via vi.fn client doubles (mirrors file-first-run.test.ts).
// ---------------------------------------------------------------------------

interface MockClientHandles {
  uploadFile: ReturnType<typeof vi.fn>;
  createWorkflow: ReturnType<typeof vi.fn>;
  getWorkflowStatus: ReturnType<typeof vi.fn>;
  getWorkflowDownloads: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
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
    jobs: [
      { ref: 'file-0', status: 'completed', operations: [] },
      { ref: 'file-1', status: 'completed', operations: [] },
    ],
  }));
  const getWorkflowDownloads = vi.fn(async (_id: string) => ({
    downloads: [
      { ref: 'file-0', files: [{ operation: 'compress', operationId: 'o0', filename: 'a.webp', sizeBytes: 10, downloadUrl: 'u0' }] },
      { ref: 'file-1', files: [{ operation: 'compress', operationId: 'o1', filename: 'b.webp', sizeBytes: 20, downloadUrl: 'u1' }] },
    ],
  }));
  const streamEvents = vi.fn(async function* (_id: string) {
    yield { event: 'workflow.completed', data: { status: 'completed' } };
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

function boundFilesRecipe(mock: MockClientHandles, ...inputs: ReturnType<typeof fileInput.uploadId>[]): FilesRecipe {
  return new FilesRecipe(inputs, [], undefined, undefined, mock.client);
}

beforeEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response('{}', { status: 200 }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilesRecipe.run — happy path', () => {
  it('creates ONE multi-job workflow and partitions per input', async () => {
    const mock = makeMockClient();
    const result = await boundFilesRecipe(
      mock,
      fileInput.uploadId('id0'),
      fileInput.uploadId('id1'),
    )
      .compress()
      .run({ maxWait: '30s' });

    // uploadId arm → NO upload; ONE create with both jobs.
    expect(mock.uploadFile).not.toHaveBeenCalled();
    expect(mock.createWorkflow).toHaveBeenCalledOnce();
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { id: string }) => j.id)).toEqual(['file-0', 'file-1']);

    expect(result.ok).toBe(true);
    expect(result.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(result.byKey('1').outputs[0].url).toBe('u1');
  });

  it('uploads every path input and threads its uploaded id into the create payload', async () => {
    const mock = makeMockClient();
    mock.uploadFile
      .mockResolvedValueOnce({ fileId: 'up0', contentType: 'image/jpeg', sizeBytes: 1 })
      .mockResolvedValueOnce({ fileId: 'up1', contentType: 'image/jpeg', sizeBytes: 1 });

    await new FilesRecipe(
      [fileInput.path('a.jpg'), fileInput.path('b.jpg')],
      [],
      undefined,
      undefined,
      mock.client,
    )
      .convert('webp')
      .run({ maxWait: '30s' });

    expect(mock.uploadFile).toHaveBeenCalledTimes(2);
    const payload = mock.createWorkflow.mock.calls[0][0];
    expect(payload.jobs.map((j: { source: { file_id: string } }) => j.source.file_id)).toEqual([
      'up0',
      'up1',
    ]);
  });
});

describe('FilesRecipe.run — partial failure end-to-end', () => {
  it('a partially_failed workflow yields both partitions with ok=false', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.partially_failed', data: { status: 'partially_failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'partially_failed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'failed', operations: [{ errorMessage: 'boom' }] },
      ],
    });
    mock.getWorkflowDownloads.mockResolvedValue({
      downloads: [
        { ref: 'file-0', files: [{ operation: 'compress', operationId: 'o0', filename: 'a.webp', sizeBytes: 10, downloadUrl: 'u0' }] },
      ],
    });

    const result = await boundFilesRecipe(mock, fileInput.uploadId('id0'), fileInput.uploadId('id1'))
      .compress()
      .run({ maxWait: '30s' });

    expect(result.state).toBe('partially_failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded.map((s) => s.key)).toEqual(['0']);
    expect(result.failed.map((f) => f.key)).toEqual(['1']);
    expect((result.failed[0].error as Error).message).toBe('failed: boom');
  });
});

describe('FilesRecipe.run — all-jobs-failed end-to-end', () => {
  it('a `failed` workflow (every input failed) yields all-failed partitions, zero artifacts, ok=false', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      yield { event: 'workflow.failed', data: { status: 'failed' } };
    });
    mock.getWorkflowStatus.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'failed',
      jobs: [
        { ref: 'file-0', status: 'failed', operations: [{ errorMessage: 'codec exploded' }] },
        { ref: 'file-1', status: 'failed', operations: [{ errorMessage: 'unsupported pixel format' }] },
      ],
    });
    // No job produced output.
    mock.getWorkflowDownloads.mockResolvedValue({ downloads: [] });

    const result = await boundFilesRecipe(mock, fileInput.uploadId('id0'), fileInput.uploadId('id1'))
      .compress()
      .run({ maxWait: '30s' });

    expect(result.state).toBe('failed');
    expect(result.ok).toBe(false);
    expect(result.succeeded).toEqual([]);
    expect(result.failed.map((f) => f.key)).toEqual(['0', '1']);
    expect((result.failed[0].error as Error).message).toBe('failed: codec exploded');
    expect((result.failed[1].error as Error).message).toBe('failed: unsupported pixel format');
    expect(result.artifacts).toEqual([]);
    expect(result.url).toBeUndefined();
    expect('url' in result.toJSON()).toBe(false);
  });
});

describe('FilesRecipe.run — no-client guard', () => {
  it('throws GislConfigError(no_client) for a directly-constructed FilesRecipe', async () => {
    const bare = new FilesRecipe([fileInput.uploadId('id0')]);
    await expect(bare.compress().run()).rejects.toBeInstanceOf(GislConfigError);
    await expect(bare.compress().run()).rejects.toMatchObject({ reason: 'no_client' });
  });
});

describe('FilesRecipe.run — timeout', () => {
  it('throws GislTimeoutError when the deadline elapses before terminal', async () => {
    const mock = makeMockClient();
    mock.streamEvents.mockImplementation(async function* () {
      return;
      // eslint-disable-next-line no-unreachable
      yield;
    });
    mock.getWorkflowStatus.mockResolvedValue({ workflowId: 'wf_1', status: 'running' });
    await expect(
      boundFilesRecipe(mock, fileInput.uploadId('id0')).compress().run({ maxWait: 1, pollIntervalMs: 5 }),
    ).rejects.toBeInstanceOf(GislTimeoutError);
    expect(mock.getWorkflowDownloads).not.toHaveBeenCalled();
  });
});

// FilesRecipe extends the file-first surface; it composes Recipe internally.
const _typeProof: Recipe = new Recipe(fileInput.path('x.jpg'));
void _typeProof;
