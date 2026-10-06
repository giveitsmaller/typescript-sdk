import { describe, expect, it } from 'vitest';

import {
  RunResult,
  projectDownloadsToRunResult,
  projectMultiJobToRunResult,
} from '../src/file-first.js';
import type { OutputFile } from '../src/file-first.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';

/**
 * bYOCX61m — a same-format compress that cannot make a file smaller returns the
 * ORIGINAL, marked `already_optimal` (+ `already_optimal_kind`) on its
 * `/downloads` entry (contracts v2.221.0). The projection lands both on each
 * {@link OutputFile}. Mirrors the PHP `RunResultAlreadyOptimalTest`.
 *
 * Load-bearing invariants pinned here:
 *  1. **omit-when-absent (parity-critical):** an unmarked output keeps the
 *     pre-feature shape — no `undefined`-valued key on the live object or in
 *     `toJSON()`, so PHP's omit-when-null `toArray()` matches.
 *  2. **`false` is a value, not an absence:** projected verbatim, like
 *     `targetSizeMet`.
 *  3. **field order:** the two keys come LAST, after the auto_quality keys.
 *  4. **an unknown kind is carried verbatim**, not dropped or rejected.
 *
 * Download rows are cast through `unknown` so the test does not depend on the
 * locally-resolved contracts package carrying the v2.221.0 fields.
 */

function download(o: {
  filename?: string;
  sizeBytes?: number;
  alreadyOptimal?: boolean;
  alreadyOptimalKind?: string;
  measuredQuality?: number;
  qualityMetric?: string;
}): OperationDownload {
  const filename = o.filename ?? 'photo.jpg';
  return {
    operation: 'compress',
    operationId: 'op_x',
    filename,
    sizeBytes: o.sizeBytes ?? 1024,
    downloadUrl: `https://cdn.example.com/${filename}`,
    ...(o.measuredQuality !== undefined ? { measuredQuality: o.measuredQuality } : {}),
    ...(o.qualityMetric !== undefined ? { qualityMetric: o.qualityMetric } : {}),
    ...(o.alreadyOptimal !== undefined ? { alreadyOptimal: o.alreadyOptimal } : {}),
    ...(o.alreadyOptimalKind !== undefined ? { alreadyOptimalKind: o.alreadyOptimalKind } : {}),
  } as unknown as OperationDownload;
}

function completedStatus(): WorkflowStatusResponse {
  return { status: 'completed', jobs: [] } as unknown as WorkflowStatusResponse;
}

describe('projection — single job, already_optimal true / false / absent', () => {
  const r = projectDownloadsToRunResult(
    'wf',
    completedStatus(),
    [
      {
        files: [
          download({ filename: 'original.jpg', sizeBytes: 51200, alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' }),
          download({ filename: 'smaller.jpg', sizeBytes: 20480, alreadyOptimal: false }),
          download({ filename: 'plain.jpg', sizeBytes: 10000 }),
        ],
      },
    ],
    null,
  );

  it('projects true + the kind onto the live OutputFile and toJSON', () => {
    expect(r.ok).toBe(true);
    expect(r.artifacts[0].alreadyOptimal).toBe(true);
    expect(r.artifacts[0].alreadyOptimalKind).toBe('not_smaller');
    expect(r.toJSON().artifacts[0]).toEqual({
      url: 'https://cdn.example.com/original.jpg',
      filename: 'original.jpg',
      sizeBytes: 51200,
      operation: 'compress',
      alreadyOptimal: true,
      alreadyOptimalKind: 'not_smaller',
    });
  });

  it('keeps an explicit false, with no kind key', () => {
    expect(r.artifacts[1].alreadyOptimal).toBe(false);
    expect('alreadyOptimalKind' in r.artifacts[1]).toBe(false);
    expect(Object.keys(r.toJSON().artifacts[1])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'alreadyOptimal',
    ]);
  });

  it('omits both keys when absent, on the live object and in toJSON', () => {
    expect('alreadyOptimal' in r.artifacts[2]).toBe(false);
    expect('alreadyOptimalKind' in r.artifacts[2]).toBe(false);
    expect(Object.keys(r.toJSON().artifacts[2])).toEqual(['url', 'filename', 'sizeBytes', 'operation']);
  });

  it('the per-input succeeded outputs carry the same projection', () => {
    expect(r.succeeded[0].outputs[0]).toMatchObject({ alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' });
  });
});

describe('projection — an unknown kind', () => {
  it('reaches the caller verbatim', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ alreadyOptimal: true, alreadyOptimalKind: 'declined_efficient_source' })] }],
      null,
    );
    expect(r.artifacts[0].alreadyOptimalKind).toBe('declined_efficient_source');
    expect(r.toJSON().artifacts[0].alreadyOptimalKind).toBe('declined_efficient_source');
  });
});

describe('multi-job (files fan-out) projection', () => {
  it('marks the already-optimal job and leaves the other bare; keyed 0/1', () => {
    const status = {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
    const r = projectMultiJobToRunResult(
      'wf',
      status,
      [
        { ref: 'file-0', files: [download({ filename: 'a.jpg', alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' })] },
        { ref: 'file-1', files: [download({ filename: 'b.jpg' })] },
      ],
      new Map(),
    );

    expect(r.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(r.artifacts[0]).toMatchObject({ alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' });
    expect('alreadyOptimal' in r.artifacts[1]).toBe(false);
    expect(r.succeeded[0].outputs[0]).toMatchObject({ alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' });
    expect('alreadyOptimal' in r.succeeded[1].outputs[0]).toBe(false);
  });
});

describe('toJSON — re-projection', () => {
  it('emits the two keys LAST, after the auto_quality keys', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ measuredQuality: 0.82, qualityMetric: 'ssimulacra2', alreadyOptimal: true, alreadyOptimalKind: 'not_smaller' })] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'measuredQuality',
      'qualityMetric',
      'alreadyOptimal',
      'alreadyOptimalKind',
    ]);
  });

  it('carries the fields from a hand-built OutputFile', () => {
    const o: OutputFile = {
      url: 'https://cdn.example.com/a.jpg',
      filename: 'a.jpg',
      sizeBytes: 10,
      operation: 'compress',
      alreadyOptimal: true,
      alreadyOptimalKind: 'not_smaller',
    };
    const a = new RunResult('wf', 'completed', [o], [], []).toJSON().artifacts[0];
    expect(a.alreadyOptimal).toBe(true);
    expect(a.alreadyOptimalKind).toBe('not_smaller');
  });
});
