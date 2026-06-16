import { describe, expect, it, vi } from 'vitest';

import { FilesRecipe, ArchivedRecipe, fileInput, isArchiveStatus } from '../src/file-first.js';
import type { ArchiveRecipeOptions } from '../src/file-first.js';
import type { GislClient } from '../src/client.js';
import type { WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError } from '../src/errors.js';

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
