import { describe, expect, it } from 'vitest';

import {
  RunResult,
  projectDownloadsToRunResult,
  projectMultiJobToRunResult,
} from '../src/file-first.js';
import type { OutputFile } from '../src/file-first.js';
import type { OperationDownload, WorkflowStatusResponse } from '@giveitsmaller/contracts/openapi';

/**
 * 9u4YGZ4V (ergonomic A) — surface the target-size encode outcome on the
 * file-first result. The generated {@link OperationDownload} carries
 * `chosenQuality`/`targetSizeMet`; the projection now lands them on each
 * {@link OutputFile}, and {@link RunResult} derives `targetSizeMissed` from
 * them.
 *
 * Two load-bearing invariants are pinned here:
 *  1. **omit-when-absent (parity-critical):** a non-target-size output stays
 *     byte-identical to the pre-feature `toJSON()` — the two new keys are
 *     omitted, NOT emitted as `undefined`, so PHP's omit-when-null `toArray()`
 *     matches. The parity comparator filters undefined/null, so the explicit
 *     `Object.keys` order assertions below are what actually catches a
 *     reordered / leaked projection.
 *  2. **`targetSizeMissed` = `some(targetSizeMet === false)`** with an
 *     `undefined` short-circuit when NO artifact reports an outcome.
 *
 * Exercises the projection seams directly (the single-job
 * {@link projectDownloadsToRunResult} and the multi-job
 * {@link projectMultiJobToRunResult} `files([...])` fan-out) plus the
 * {@link RunResult} constructor / `toJSON()`. Network-free — no client needed.
 * Mirrors the PHP `RunResultTargetSizeTest`.
 */

/**
 * Build a generated-shape download row. The two target-size fields are set
 * ONLY when supplied (a real `target_size_met` from the encode-measure loop is
 * present; a plain compress output omits them). Cast through `unknown` so the
 * test does not depend on the locally-resolved contracts package carrying the
 * v2.117 fields (the in-repo generated tree / CI fresh-contracts build does).
 */
function download(o: {
  filename?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  operation?: string;
  chosenQuality?: number;
  targetSizeMet?: boolean;
}): OperationDownload {
  return {
    operation: o.operation ?? 'compress',
    operationId: 'op_x',
    filename: o.filename ?? 'photo.webp',
    sizeBytes: o.sizeBytes ?? 1024,
    downloadUrl: o.downloadUrl ?? 'https://cdn.example.com/photo.webp',
    ...(o.chosenQuality !== undefined ? { chosenQuality: o.chosenQuality } : {}),
    ...(o.targetSizeMet !== undefined ? { targetSizeMet: o.targetSizeMet } : {}),
  } as unknown as OperationDownload;
}

/** A completed terminal status (no jobs needed — the completed path ignores them). */
function completedStatus(jobs: unknown[] = []): WorkflowStatusResponse {
  return { status: 'completed', jobs } as unknown as WorkflowStatusResponse;
}

/** A bare {@link OutputFile} literal, with the target-size fields set only when supplied. */
function out(o: {
  name?: string;
  chosenQuality?: number;
  targetSizeMet?: boolean;
}): OutputFile {
  const name = o.name ?? 'a.webp';
  return {
    url: `https://cdn.example.com/${name}`,
    filename: name,
    sizeBytes: 10,
    operation: 'compress',
    ...(o.chosenQuality !== undefined ? { chosenQuality: o.chosenQuality } : {}),
    ...(o.targetSizeMet !== undefined ? { targetSizeMet: o.targetSizeMet } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Projection PRESENT — a target-size download lands both fields on OutputFile.
// ---------------------------------------------------------------------------

describe('projection — target-size fields present', () => {
  it('projects chosenQuality + targetSizeMet (met) onto the OutputFile', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ chosenQuality: 63, targetSizeMet: true })] }],
      null,
    );
    expect(r.artifacts[0].chosenQuality).toBe(63);
    expect(r.artifacts[0].targetSizeMet).toBe(true);
    // present-and-met → not missed.
    expect(r.targetSizeMissed).toBe(false);
  });

  it('projects a MISSED target (targetSizeMet false) and serialises both fields', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ chosenQuality: 30, targetSizeMet: false })] }],
      null,
    );
    expect(r.artifacts[0].targetSizeMet).toBe(false);
    expect(r.artifacts[0].chosenQuality).toBe(30);
    expect(r.targetSizeMissed).toBe(true);

    const json = r.toJSON();
    expect(json.targetSizeMissed).toBe(true);
    expect(json.artifacts[0]).toMatchObject({ chosenQuality: 30, targetSizeMet: false });
  });
});

// ---------------------------------------------------------------------------
// 2. Projection ABSENT — a normal output stays byte-identical to the old shape.
//    This is the parity-critical case: undefined fields are OMITTED, never
//    serialised, so PHP's omit-when-null toArray() matches.
// ---------------------------------------------------------------------------

describe('projection — target-size fields absent (non-target-size run)', () => {
  it('leaves both fields undefined and OMITS them from toJSON (byte-identical to the old shape)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ filename: 'plain.webp', downloadUrl: 'https://cdn.example.com/plain.webp', sizeBytes: 2048 })] }],
      null,
    );
    expect(r.artifacts[0].chosenQuality).toBeUndefined();
    expect(r.artifacts[0].targetSizeMet).toBeUndefined();
    // Omit on the LIVE object too — no enumerable undefined-valued key.
    expect('chosenQuality' in r.artifacts[0]).toBe(false);
    expect('targetSizeMet' in r.artifacts[0]).toBe(false);
    expect(r.targetSizeMissed).toBeUndefined();

    const json = r.toJSON();
    // The serialised OutputFile is EXACTLY the four pre-feature fields.
    expect(json.artifacts[0]).toEqual({
      url: 'https://cdn.example.com/plain.webp',
      filename: 'plain.webp',
      sizeBytes: 2048,
      operation: 'compress',
    });
    expect('chosenQuality' in json.artifacts[0]).toBe(false);
    expect('targetSizeMet' in json.artifacts[0]).toBe(false);
    // The RunResult head omits targetSizeMissed entirely.
    expect('targetSizeMissed' in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. targetSizeMissed derivation: true / false / omitted.
// ---------------------------------------------------------------------------

describe('RunResult.targetSizeMissed derivation', () => {
  it('is true when SOME artifact has targetSizeMet === false', () => {
    const r = new RunResult(
      'wf',
      'completed',
      [out({ name: 'a.webp', chosenQuality: 70, targetSizeMet: true }), out({ name: 'b.webp', chosenQuality: 30, targetSizeMet: false })],
      [],
      [],
    );
    expect(r.targetSizeMissed).toBe(true);
  });

  it('is false when EVERY reporting artifact met its target', () => {
    const r = new RunResult(
      'wf',
      'completed',
      [out({ name: 'a.webp', chosenQuality: 70, targetSizeMet: true }), out({ name: 'b.webp', chosenQuality: 80, targetSizeMet: true })],
      [],
      [],
    );
    expect(r.targetSizeMissed).toBe(false);
  });

  it('is undefined (omitted) when NO artifact reports a target-size outcome', () => {
    const r = new RunResult(
      'wf',
      'completed',
      [out({ name: 'a.webp' }), out({ name: 'b.webp' })],
      [],
      [],
    );
    expect(r.targetSizeMissed).toBeUndefined();
  });

  it('is undefined for a zero-artifact run', () => {
    expect(new RunResult('wf', 'completed', [], [], []).targetSizeMissed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3b. toJSON omits the two OutputFile fields INDEPENDENTLY (TS↔PHP symmetry).
//     The two conditional spreads are separate, so an output with only one
//     field set must serialise only that field — mirrors the PHP
//     `output_file_omits_each_target_size_field_independently` case.
// ---------------------------------------------------------------------------

describe('toJSON — independent single-field omission', () => {
  it('emits chosenQuality but OMITS targetSizeMet when only chosenQuality is set', () => {
    const r = new RunResult('wf', 'completed', [out({ name: 'a.webp', chosenQuality: 63 })], [], []);
    const a = r.toJSON().artifacts[0];
    expect(a.chosenQuality).toBe(63);
    expect('targetSizeMet' in a).toBe(false);
  });

  it('emits targetSizeMet but OMITS chosenQuality when only targetSizeMet is set', () => {
    const r = new RunResult('wf', 'completed', [out({ name: 'b.webp', targetSizeMet: false })], [], []);
    const a = r.toJSON().artifacts[0];
    expect(a.targetSizeMet).toBe(false);
    expect('chosenQuality' in a).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. MIXED multi-output — some artifacts report, others omit — for BOTH the
//    single-job projection AND the multi-job (files fan-out) projection. This
//    is the main ambiguity of the some(=== false) rule.
// ---------------------------------------------------------------------------

describe('mixed multi-output — single-job projection', () => {
  it('a missed output beside a non-reporting output → targetSizeMissed true; per-output fields preserved', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [
        {
          files: [
            download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', chosenQuality: 40, targetSizeMet: false }),
            download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp' }),
          ],
        },
      ],
      null,
    );
    expect(r.artifacts[0].targetSizeMet).toBe(false);
    expect(r.artifacts[0].chosenQuality).toBe(40);
    expect(r.artifacts[1].targetSizeMet).toBeUndefined();
    expect(r.artifacts[1].chosenQuality).toBeUndefined();
    expect(r.targetSizeMissed).toBe(true);

    const json = r.toJSON();
    expect(json.artifacts[0]).toMatchObject({ chosenQuality: 40, targetSizeMet: false });
    // The non-reporting output keeps the bare four-field shape.
    expect('targetSizeMet' in json.artifacts[1]).toBe(false);
    expect('chosenQuality' in json.artifacts[1]).toBe(false);
  });

  it('a met output beside a non-reporting output → targetSizeMissed false (reported, none missed)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [
        {
          files: [
            download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', chosenQuality: 72, targetSizeMet: true }),
            download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp' }),
          ],
        },
      ],
      null,
    );
    expect(r.targetSizeMissed).toBe(false);
  });
});

describe('mixed multi-output — multi-job (files fan-out) projection', () => {
  function fanoutStatus(): WorkflowStatusResponse {
    return {
      status: 'completed',
      jobs: [
        { ref: 'file-0', status: 'completed', operations: [] },
        { ref: 'file-1', status: 'completed', operations: [] },
      ],
    } as unknown as WorkflowStatusResponse;
  }

  it('a missed job beside a non-reporting job → targetSizeMissed true; keyed 0/1; fields per output', () => {
    const r = projectMultiJobToRunResult(
      'wf',
      fanoutStatus(),
      [
        { ref: 'file-0', files: [download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', chosenQuality: 35, targetSizeMet: false })] },
        { ref: 'file-1', files: [download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp' })] },
      ],
      new Map(),
    );

    expect(r.succeeded.map((s) => s.key)).toEqual(['0', '1']);
    expect(r.artifacts[0].targetSizeMet).toBe(false);
    expect(r.artifacts[0].chosenQuality).toBe(35);
    expect(r.artifacts[1].targetSizeMet).toBeUndefined();
    expect(r.targetSizeMissed).toBe(true);
    // The per-input succeeded outputs carry the same projection as the flat artifacts.
    expect(r.succeeded[0].outputs[0]).toMatchObject({ chosenQuality: 35, targetSizeMet: false });
  });

  it('all jobs met → targetSizeMissed false', () => {
    const r = projectMultiJobToRunResult(
      'wf',
      fanoutStatus(),
      [
        { ref: 'file-0', files: [download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', chosenQuality: 60, targetSizeMet: true })] },
        { ref: 'file-1', files: [download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp', chosenQuality: 65, targetSizeMet: true })] },
      ],
      new Map(),
    );
    expect(r.targetSizeMissed).toBe(false);
  });

  it('no job reports → targetSizeMissed undefined (omitted)', () => {
    const r = projectMultiJobToRunResult(
      'wf',
      fanoutStatus(),
      [
        { ref: 'file-0', files: [download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp' })] },
        { ref: 'file-1', files: [download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp' })] },
      ],
      new Map(),
    );
    expect(r.targetSizeMissed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Field-ORDER assertions. The parity comparator is order-INSENSITIVE, so an
//    explicit Object.keys assertion is what catches a reordered projection.
//    Mirrors the existing failed[] key-order pattern (file-first-run.test.ts).
// ---------------------------------------------------------------------------

describe('serialised field order', () => {
  it('OutputFile: target-size keys come AFTER operation, in chosenQuality→targetSizeMet order', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ chosenQuality: 63, targetSizeMet: false })] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual([
      'url',
      'filename',
      'sizeBytes',
      'operation',
      'chosenQuality',
      'targetSizeMet',
    ]);
  });

  it('OutputFile (absent): exactly the four pre-feature keys, in order', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({})] }],
      null,
    );
    expect(Object.keys(r.toJSON().artifacts[0])).toEqual(['url', 'filename', 'sizeBytes', 'operation']);
  });

  it('RunResult head: targetSizeMissed sits immediately after ok, before url (single output)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({ chosenQuality: 30, targetSizeMet: false })] }],
      null,
    );
    expect(Object.keys(r.toJSON())).toEqual([
      'workflowId',
      'state',
      'ok',
      'targetSizeMissed',
      'url',
      'artifacts',
      'succeeded',
      'failed',
    ]);
  });

  it('RunResult head: targetSizeMissed after ok with NO url (multi output)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [
        {
          files: [
            download({ filename: 'a.webp', downloadUrl: 'https://cdn.example.com/a.webp', chosenQuality: 30, targetSizeMet: false }),
            download({ filename: 'b.webp', downloadUrl: 'https://cdn.example.com/b.webp', chosenQuality: 70, targetSizeMet: true }),
          ],
        },
      ],
      null,
    );
    expect(Object.keys(r.toJSON())).toEqual([
      'workflowId',
      'state',
      'ok',
      'targetSizeMissed',
      'artifacts',
      'succeeded',
      'failed',
    ]);
  });

  it('RunResult head: targetSizeMissed OMITTED for a non-target-size run (key order unchanged)', () => {
    const r = projectDownloadsToRunResult(
      'wf',
      completedStatus(),
      [{ files: [download({})] }],
      null,
    );
    expect(Object.keys(r.toJSON())).toEqual([
      'workflowId',
      'state',
      'ok',
      'url',
      'artifacts',
      'succeeded',
      'failed',
    ]);
  });
});
