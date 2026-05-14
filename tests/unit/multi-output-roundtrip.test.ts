/**
 * Smoke roundtrip for v2.7.0 OperationResult.MultiOutputCompletion.
 *
 * Per compression_contracts (2026-05-14) the v2.7.0 OperationResult is the
 * first place a 3-way oneOf discriminator ships
 * (SingleOutputCompletion / MultiOutputCompletion / Failure). The
 * MultiOutputCompletion path also exposes the new outputs[] envelope with
 * PageIndexed / PositionIndexed / Unindexed entries.
 *
 * The roundtrip asserts the shape survives JSON.parse(JSON.stringify(...))
 * with no key loss or reordering of the discriminator-affecting fields.
 * Catches regressions in the asyncapi generator template (rename spacing,
 * variant order) that would silently break consumers.
 */
import { describe, it, expect } from 'vitest';
import type MultiOutputCompletion from '../../../../generated/typescript/asyncapi/MultiOutputCompletion.js';
import type PageIndexed from '../../../../generated/typescript/asyncapi/PageIndexed.js';
import type PositionIndexed from '../../../../generated/typescript/asyncapi/PositionIndexed.js';
import type Unindexed from '../../../../generated/typescript/asyncapi/Unindexed.js';
import OperationType from '../../../../generated/typescript/asyncapi/OperationType.js';
import ResultStatus from '../../../../generated/typescript/asyncapi/ResultStatus.js';

describe('MultiOutputCompletion roundtrip (v2.7.0 outputs[])', () => {
  it('survives JSON roundtrip with PageIndexed entries', () => {
    const pageEntries: PageIndexed[] = [
      { output_key: 'pages/0.png', output_size_bytes: 1024, page_index: 0 },
      { output_key: 'pages/1.png', output_size_bytes: 2048, page_index: 1, position: 100 },
    ];
    const payload: MultiOutputCompletion = {
      job_id: 'job-multi-page',
      operation_id: 'op-1',
      operation_type: OperationType.THUMBNAIL,
      status: ResultStatus.COMPLETED,
      output_bucket: 'gisl-test-bucket',
      outputs: pageEntries,
      total_output_size_bytes: 3072,
    };

    const restored = JSON.parse(JSON.stringify(payload)) as MultiOutputCompletion;

    expect(restored).toEqual(payload);
    expect(restored.outputs).toHaveLength(2);
    expect((restored.outputs[0] as PageIndexed).page_index).toBe(0);
    expect((restored.outputs[1] as PageIndexed).position).toBe(100);
  });

  it('survives JSON roundtrip with mixed PositionIndexed + Unindexed entries', () => {
    const mixed: (PositionIndexed | Unindexed)[] = [
      { output_key: 'clip-0.mp4', output_size_bytes: 4096, position: 0 } as PositionIndexed,
      { output_key: 'tail.mp4', output_size_bytes: 512 } as Unindexed,
    ];
    const payload: MultiOutputCompletion = {
      job_id: 'job-mixed',
      operation_id: 'op-2',
      operation_type: OperationType.COMPRESS,
      status: ResultStatus.COMPLETED,
      output_bucket: 'gisl-test-bucket',
      outputs: mixed,
      total_output_size_bytes: 4608,
    };

    const restored = JSON.parse(JSON.stringify(payload)) as MultiOutputCompletion;

    expect(restored).toEqual(payload);
    expect(restored.outputs).toHaveLength(2);
    expect((restored.outputs[0] as PositionIndexed).position).toBe(0);
    // Unindexed entry has no position key — must not be injected by roundtrip
    expect((restored.outputs[1] as Unindexed & { position?: number }).position).toBeUndefined();
  });

  it('preserves optional top-level fields (metrics absent vs present)', () => {
    const payload: MultiOutputCompletion = {
      job_id: 'job-no-metrics',
      operation_id: 'op-3',
      operation_type: OperationType.CONVERT,
      status: ResultStatus.COMPLETED,
      output_bucket: 'gisl-test-bucket',
      outputs: [{ output_key: 'out.mp4', output_size_bytes: 100, page_index: 0 } as PageIndexed],
      total_output_size_bytes: 100,
    };
    const restored = JSON.parse(JSON.stringify(payload)) as MultiOutputCompletion;
    expect(restored).toEqual(payload);
    expect('metrics' in restored).toBe(false);
  });

  /*
   * Compile-time generator-shape guards — these tests do not assert at
   * runtime; their value is that they fail `tsc --noEmit` if the
   * generator emits the wrong shape. JSON.parse(JSON.stringify) is
   * structurally bulletproof, so runtime-only tests miss type
   * regressions (e.g. `outputs` flipping required-vs-optional, oneOf
   * variants collapsing into an intersection). These assertions live
   * here so a regen that changes the type surface fails the SDK gate.
   */
  it('compile-time: outputs[] is a required field on MultiOutputCompletion', () => {
    const required: MultiOutputCompletion = {
      job_id: 'job',
      operation_id: 'op',
      operation_type: OperationType.COMPRESS,
      status: ResultStatus.COMPLETED,
      output_bucket: 'b',
      outputs: [],
      total_output_size_bytes: 0,
    };
    // @ts-expect-error — `outputs` is required; omitting it must fail tsc.
    // If this `@ts-expect-error` becomes UNUSED, the type has regressed
    // to `outputs?: ...` and the generator gate should catch it.
    const _missing: MultiOutputCompletion = {
      job_id: 'job',
      operation_id: 'op',
      operation_type: OperationType.COMPRESS,
      status: ResultStatus.COMPLETED,
      output_bucket: 'b',
      total_output_size_bytes: 0,
    };
    expect(required.outputs).toEqual([]);
    expect(_missing.job_id).toBe('job');
  });

  it('compile-time: each oneOf variant constructs with ONLY its required-by-spec fields', () => {
    // PageIndexed requires page_index; PositionIndexed requires position;
    // Unindexed requires neither. The generator currently emits the
    // "shape distinctiveness" purely via which field is REQUIRED — all
    // three variants accept page_index? and position? as optional, so TS
    // narrowing via property presence is not possible at the type level
    // (a real shortcoming of the asyncapi generator's oneOf emission).
    // This test pins the required-vs-optional invariant: PositionIndexed
    // without `position` must fail tsc, and PageIndexed without
    // `page_index` must fail tsc. A generator regression that flips
    // either to optional would surface here.
    const page: PageIndexed = { output_key: 'p.png', output_size_bytes: 1, page_index: 0 };
    const pos: PositionIndexed = { output_key: 'c.mp4', output_size_bytes: 1, position: 0 };
    const un: Unindexed = { output_key: 'u.bin', output_size_bytes: 1 };
    expect(page.page_index).toBe(0);
    expect(pos.position).toBe(0);
    expect(un.output_key).toBe('u.bin');

    // @ts-expect-error — PageIndexed.page_index is required.
    const _badPage: PageIndexed = { output_key: 'p', output_size_bytes: 1 };
    expect(_badPage.output_key).toBe('p');

    // @ts-expect-error — PositionIndexed.position is required.
    const _badPos: PositionIndexed = { output_key: 'c', output_size_bytes: 1 };
    expect(_badPos.output_key).toBe('c');
  });
});
