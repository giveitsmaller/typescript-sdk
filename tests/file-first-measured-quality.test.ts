import { describe, expect, it } from 'vitest';

import {
  RunResult,
  projectDownloadsToRunResult,
  projectMultiJobToRunResult,
} from '../src/file-first.js';
import type { OutputFile } from '../src/file-first.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';

/**
 * pAVd5oC4 — surface the auto_quality metrics on the file-first result. The
 * generated {@link OperationDownload} carries `measuredQuality` (float 0-1) +
 * `qualityMetric` (string); the projection now lands them on each
 * {@link OutputFile}. Mirrors the target-size projection (9u4YGZ4V) exactly and
 * the PHP `RunResultMeasuredQualityTest`.
 *
 * Load-bearing invariants pinned here:
 *  1. **omit-when-absent (parity-critical):** an output the worker did not
 *     measure stays byte-identical to the pre-feature shape — the two new keys
 *     are omitted, NOT emitted as `undefined`, so PHP's omit-when-null
 *     `toArray()` matches.
 *  2. **independent omission:** the two spreads are separate, so an output
 *     carrying only one field serialises only that field.
 *  3. **field order:** the quality keys come AFTER `operation` (and after the
 *     target-size keys when those are also present), so JSON-string parity
 *     holds against PHP.
 *
 * Network-free — exercises the projection seams directly. Cast the download
 * rows through `unknown` so the test does not depend on the locally-resolved
 * contracts package carrying the v2.148 fields (the in-repo generated tree / CI
 * fresh-contracts build does).
 */

function download(o: {
  filename?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  operation?: string;
  chosenQuality?: number;
  targetSizeMet?: boolean;
  measuredQuality?: number;
  qualityMetric?: string;
}): OperationDownload {
  return {
    operation: o.operation ?? 'compress',
    operationId: 'op_x',
    filename: o.filename ?? 'photo.webp',
    sizeBytes: o.sizeBytes ?? 1024,
    downloadUrl: o.downloadUrl ?? 'https://cdn.example.com/photo.webp',
    ...(o.chosenQuality !== undefined ? { chosenQuality: o.chosenQuality } : {}),
    ...(o.targetSizeMet !== undefined ? { targetSizeMet: o.targetSizeMet } : {}),
    ...(o.measuredQuality !== undefined ? { measuredQuality: o.measuredQuality } : {}),
    ...(o.qualityMetric !== undefined ? { qualityMetric: o.qualityMetric } : {}),
  } as unknown as OperationDownload;
}

/** A completed terminal status (no jobs needed — the completed path ignores them). */
function completedStatus(jobs: unknown[] = []): WorkflowStatusResponse {
  return { status: 'completed', jobs } as unknown as WorkflowStatusResponse;
}

/** A bare {@link OutputFile} literal, with the quality fields set only when supplied. */
function out(o: {
  name?: string;
  measuredQuality?: number;
  qualityMetric?: string;
}): OutputFile {
  const name = o.name ?? 'a.webp';
  return {
    url: `https://cdn.example.com/${name}`,
    filename: name,
    sizeBytes: 10,
    operation: 'compress',
    ...(o.measuredQuality !== undefined ? { measuredQuality: o.measuredQuality } : {}),
    ...(o.qualityMetric !== undefined ? { qualityMetric: o.qualityMetric } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Projection PRESENT — a measured download lands both fields on OutputFile.
// ---------------------------------------------------------------------------

describe('projection — auto_quality fields present', () => {
  it('projects measuredQuality (float) + qualityMetric onto the OutputFile', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ measuredQuality: 0.82, qualityMetric: 'ssimulacra2' })] }],
      null,
    );
    expect(r.artifacts[0].measuredQuality).toBe(0.82);
    expect(r.artifacts[0].qualityMetric).toBe('ssimulacra2');

    const json = r.toJSON();
    expect(json.artifacts[0]).toMatchObject({ measuredQuality: 0.82, qualityMetric: 'ssimulacra2' });
  });
});

// ---------------------------------------------------------------------------
// 2. Projection ABSENT — a non-measured output stays byte-identical.
// ---------------------------------------------------------------------------

describe('projection — auto_quality fields absent', () => {
  it('leaves both fields undefined and OMITS them from toJSON (byte-identical to the bare shape)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ filename: 'plain.webp', downloadUrl: 'https://cdn.example.com/plain.webp', sizeBytes: 2048 })] }],
      null,
    );
    expect(r.artifacts[0].measuredQuality).toBeUndefined();
    expect(r.artifacts[0].qualityMetric).toBeUndefined();
    // Omit on the LIVE object too — no enumerable undefined-valued key.
    expect('measuredQuality' in r.artifacts[0]).toBe(false);
    expect('qualityMetric' in r.artifacts[0]).toBe(false);

    const json = r.toJSON();
    expect(json.artifacts[0]).toEqual({
      url: 'https://cdn.example.com/plain.webp',
      filename: 'plain.webp',
      sizeBytes: 2048,
      operation: 'compress',
    });
    expect('measuredQuality' in json.artifacts[0]).toBe(false);
    expect('qualityMetric' in json.artifacts[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Independent single-field omission (TS↔PHP symmetry). The two conditional
//    spreads are separate, so an output with only one field set serialises
//    only that field.
// ---------------------------------------------------------------------------

describe('toJSON — independent single-field omission', () => {
  it('emits measuredQuality but OMITS qualityMetric when only measuredQuality is set', () => {
    const r = new RunResult('wf', 'completed', [out({ name: 'a.webp', measuredQuality: 0.9 })], [], []);
    const a = r.toJSON().artifacts[0];
    expect(a.measuredQuality).toBe(0.9);
    expect('qualityMetric' in a).toBe(false);
  });

  it('emits qualityMetric but OMITS measuredQuality when only qualityMetric is set', () => {
    const r = new RunResult('wf', 'completed', [out({ name: 'b.webp', qualityMetric: 'ssimulacra2' })], [], []);
    const a = r.toJSON().artifacts[0];
    expect(a.qualityMetric).toBe('ssimulacra2');
    expect('measuredQuality' in a).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-job (files fan-out) projection — present on one job, absent on the
//    other; keyed 0/1; per-output fields preserved on both artifacts[] and the
//    per-input succeeded outputs.
// ---------------------------------------------------------------------------

describe('multi-job (files fan-out) projection', () => {
  function fanoutStatus(): WorkflowStatusResponse {
    return {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
  }

  it('a measured job beside a non-measured job → per-output fields; keyed 0/1', () => {
    const r = projectMultiJobToRunResult(
      'wf',
      fanoutStatus(),
      [
        { ref: 'file-0', files: [download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', measuredQuality: 0.82, qualityMetric: 'ssimulacra2' })] },
        { ref: 'file-1', files: [download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp' })] },
      ],
      new Map(),
    );

    expect(r.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(r.artifacts[0].measuredQuality).toBe(0.82);
    expect(r.artifacts[0].qualityMetric).toBe('ssimulacra2');
    expect(r.artifacts[1].measuredQuality).toBeUndefined();
    expect('qualityMetric' in r.artifacts[1]).toBe(false);
    // The per-input succeeded outputs carry the same projection as the flat artifacts.
    expect(r.succeeded[0].outputs[0]).toMatchObject({ measuredQuality: 0.82, qualityMetric: 'ssimulacra2' });
  });
});

// ---------------------------------------------------------------------------
// 5. Field-ORDER assertions. The parity comparator is order-INSENSITIVE, so an
//    explicit Object.keys assertion is what catches a reordered projection.
// ---------------------------------------------------------------------------

describe('serialised field order', () => {
  it('quality keys come AFTER operation, in measuredQuality→qualityMetric order', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ measuredQuality: 0.82, qualityMetric: 'ssimulacra2' })] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'measuredQuality',
      'qualityMetric',
    ]);
  });

  it('with target-size AND quality present: chosenQuality→targetSizeMet→measuredQuality→qualityMetric', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ chosenQuality: 63, targetSizeMet: true, measuredQuality: 0.82, qualityMetric: 'ssimulacra2' })] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'chosenQuality',
      'targetSizeMet',
      'measuredQuality',
      'qualityMetric',
    ]);
  });
});
