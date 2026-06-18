import { describe, expect, it, vi } from 'vitest';

import { FilesRecipe, MergedRecipe, fileInput, isMergeStatus } from '../src/file-first.js';
import type { MergeOptions } from '../src/merge.js';
import type { GislClient } from '../src/client.js';
import type { WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError, GislTimeoutError } from '../src/errors.js';

/**
 * FF3b (IE29x9QL) — the fluent `files([...]).merge(...)` N→1 combine + the
 * post-combine chain on the merged output. Mirrors the PHP `MergedRecipeTest`:
 * lowering shape (passthrough srcs + a merge job consuming them via
 * `job_output`), the `merge().compress()` flagship chain, callback-url wiring,
 * the merge-must-be-first guard, and the <2-inputs guard firing BEFORE upload.
 */

const mergedRecipe = (paths: string[], options: MergeOptions = {}): MergedRecipe =>
  new MergedRecipe(paths.map((p) => fileInput.path(p)), options);

describe('MergedRecipe — lowering', () => {
  it('lowers to one passthrough src job per input plus a merge job', () => {
    const merged = mergedRecipe(['intro.mp4', 'body.mp4', 'outro.mp4'], {
      transition: 'crossfade',
      crossfadeDuration: 0.5,
      mediaKind: 'video',
    });

    const payload = merged.toWorkflowPayload(['f0', 'f1', 'f2']);

    // 3 passthrough source jobs + 1 merge job (last).
    expect(payload.jobs).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      const src = payload.jobs[i];
      expect(src.id).toBe(`src_${i}`);
      expect(src.operations[0].type).toBe('passthrough');
      expect(src.source).toEqual({ type: 'upload', file_id: `f${i}` });
    }

    const mergeJob = payload.jobs[3];
    expect(mergeJob.id).toBe('merge');
    // The merge job consumes the src jobs via job_output, in input order.
    expect(mergeJob.inputs).toHaveLength(3);
    expect(mergeJob.inputs?.[0].source).toEqual({ type: 'job_output', from: 'src_0' });
    expect(mergeJob.inputs?.[2].source).toEqual({ type: 'job_output', from: 'src_2' });

    // Merge op first, options wired through wireMergeOptions.
    expect(mergeJob.operations[0].type).toBe('merge');
    expect(mergeJob.operations[0].options).toMatchObject({
      transition: 'crossfade',
      crossfade_duration: 0.5,
    });
  });

  it('merge().compress() appends compress after merge in the same job (example 14)', () => {
    const merged = mergedRecipe(['a.mp4', 'b.mp4'], { mediaKind: 'video' }).compress(OptimizeFor.Size);

    const payload = merged.toWorkflowPayload(['f0', 'f1']);

    const mergeJob = payload.jobs[2]; // 2 src jobs + merge
    expect(mergeJob.id).toBe('merge');
    expect(mergeJob.operations.map((o) => o.type)).toEqual(['merge', 'compress']);
  });

  it('wires the callback url into the payload', () => {
    const merged = mergedRecipe(['a.mp4', 'b.mp4'], { mediaKind: 'video' });
    const payload = merged.toWorkflowPayload(['f0', 'f1'], 'https://example.com/cb');
    expect(payload.callback_url).toBe('https://example.com/cb');
  });
});

describe('MergedRecipe — immutability (clone-on-write)', () => {
  it('chaining a post-combine op returns a NEW MergedRecipe', () => {
    const base = mergedRecipe(['a.mp4', 'b.mp4'], { mediaKind: 'video' });
    const compressed = base.compress(OptimizeFor.Size);

    expect(base.stepCount).toBe(0);
    expect(compressed.stepCount).toBe(1);
    expect(compressed).not.toBe(base);
    // Re-lower the base AFTER chaining — its merge job must still carry ONLY
    // the merge op (catches a shared-array mutation stepCount misses).
    const baseMergeJob = base.toWorkflowPayload(['f0', 'f1']).jobs[2];
    expect(baseMergeJob.operations.map((o) => o.type)).toEqual(['merge']);
  });
});

describe('MergedRecipe — guards', () => {
  it('merge() must be the first operation on files([...])', () => {
    const recipe = new FilesRecipe(
      [fileInput.path('a.mp4'), fileInput.path('b.mp4')],
    ).compress(OptimizeFor.Size);

    expect(() => recipe.merge()).toThrow(GislConfigError);
    expect(() => recipe.merge()).toThrow(/merge\(\) must be the first operation/);
  });

  it('submit() rejects fewer than two inputs BEFORE any upload fires', async () => {
    const uploadFile = vi.fn();
    const createWorkflow = vi.fn();
    const merged = new MergedRecipe(
      [fileInput.path('only.mp4')],
      {},
      [],
      undefined,
      undefined,
      // A client whose transport must never be reached; the <2 guard fires first.
      { uploadFile, createWorkflow, maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    await expect(merged.submit()).rejects.toThrow(/at least 2 inputs/);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it('submit() rejects more than ten inputs BEFORE any upload fires', async () => {
    const uploadFile = vi.fn();
    const merged = new MergedRecipe(
      Array.from({ length: 11 }, (_, i) => fileInput.path(`clip-${i}.mp4`)),
      { mediaKind: 'video' },
      [],
      undefined,
      undefined,
      { uploadFile, createWorkflow: vi.fn(), maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    await expect(merged.submit()).rejects.toThrow(/at most 10 inputs/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('submit() rejects an image merge with no output_type BEFORE any upload fires', async () => {
    const uploadFile = vi.fn();
    const merged = new MergedRecipe(
      [fileInput.path('a.jpg'), fileInput.path('b.jpg')],
      {}, // image inferred from .jpg, but no output / outputType
      [],
      undefined,
      undefined,
      { uploadFile, createWorkflow: vi.fn(), maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    await expect(merged.submit()).rejects.toThrow(/output_type/);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('isMergeStatus — data-driven merge detection (for Handle projection)', () => {
  const status = (refs: string[]): WorkflowStatusResponse =>
    ({ status: 'completed', jobs: refs.map((ref) => ({ ref })) }) as unknown as WorkflowStatusResponse;

  it('is true for the src_N + merge lowering shape', () => {
    expect(isMergeStatus(status(['src_0', 'src_1', 'merge']))).toBe(true);
  });

  it('is false for a files([...]) fan-out (file-{i} refs)', () => {
    expect(isMergeStatus(status(['file-0', 'file-1']))).toBe(false);
  });

  it('is false when there is no merge job', () => {
    expect(isMergeStatus(status(['src_0', 'src_1']))).toBe(false);
  });

  it('is false for an empty job list', () => {
    expect(isMergeStatus(status([]))).toBe(false);
  });
});

describe('MergedRecipe.run — timeout label', () => {
  // xxy5Rlsy follow-up (Wi4OnaJE): pin the merge label noun the shared
  // `_uploadInputsAndCreate` helper threads into its timeout message. A
  // mid-batch deadline (maxWait 1ms + a slow first upload over two inputs)
  // trips the `during ${uploadsLabel} uploads` throw — the message MUST carry
  // the merge noun so a label swap can never pass CI. The MESSAGE is asserted
  // (not the upload call-count, which races on a slow host).
  it('its mid-batch timeout message names the merge label', async () => {
    const uploadFile = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { fileId: 'uploaded', contentType: 'video/mp4', sizeBytes: 1 };
    });
    const createWorkflow = vi.fn();
    const merged = new MergedRecipe(
      [fileInput.path('intro.mp4'), fileInput.path('outro.mp4')],
      { mediaKind: 'video' },
      [],
      undefined,
      undefined,
      { uploadFile, createWorkflow, maybeWaitForVideoProbe: vi.fn(async () => undefined) } as unknown as GislClient,
    );

    const err = await merged.run({ maxWait: 1 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GislTimeoutError);
    expect((err as Error).message).toContain('merge');
    expect(createWorkflow).not.toHaveBeenCalled();
  });
});
