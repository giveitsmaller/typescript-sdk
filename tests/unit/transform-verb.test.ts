import { describe, expect, it } from 'vitest';

import { create } from '../../src/gisl.js';
import { GislConfigError } from '../../src/errors.js';
import { FilesRecipe, MergedRecipe, Recipe, fileInput } from '../../src/file-first.js';
import type { OperationDef, WorkflowCreatePayload } from '../../src/types.js';

/**
 * `transform` passthrough verb (rotate/flip) — LOWERING + validation across every
 * ergonomic surface (Recipe / FilesRecipe / MergedRecipe / WatermarkedRecipe +
 * the exported single-op client builder). Mirrors the `thumbnail` passthrough
 * pattern: the SDK forwards the option bag verbatim (unknown keys rejected
 * pre-upload, no positional-owned key, no required dimensions) and does NOT gate
 * on media/availability — the op is `availability: planned`, so a no-op or a
 * per-media-unsupported combo (e.g. `flip` on a PDF) is a SERVER 422, never a
 * client-side reject. These tests pin the wire shape only.
 *
 * NOTE: an EMPTY option bag lowers to a bare `{ type: 'transform' }` (no
 * `options` key) — the shared `lowerStep` omits an empty options object so TS
 * (undefined → absent) and PHP (null → absent) serialise byte-identically. That
 * is the actual source behaviour asserted below.
 */

const FILE_ID = 'file_0001';

/** Lower a single-input Recipe and return its one job's operations. */
function recipeOps(r: Recipe): OperationDef[] {
  return r.toWorkflowPayload(FILE_ID).jobs[0].operations;
}

/** The operations[] of the LAST job (merge/watermark append their post-op there). */
function lastJobOps(wire: WorkflowCreatePayload): OperationDef[] {
  return wire.jobs[wire.jobs.length - 1].operations;
}

/** Find the single lowered `transform` op (fails the test if absent). */
function transformOp(ops: OperationDef[]): OperationDef {
  const op = ops.find((o) => o.type === 'transform');
  expect(op, 'expected a transform op in the lowered payload').toBeDefined();
  return op!;
}

describe('Recipe.transform — passthrough lowering', () => {
  it('lowers to { type: transform, options: { rotate, flip } } with both passed through', () => {
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).transform({ rotate: 90, flip: 'horizontal' }));
    expect(transformOp(ops)).toEqual({ type: 'transform', options: { rotate: 90, flip: 'horizontal' } });
  });

  it('drops an undefined option — transform({ rotate: 90 }) emits only rotate', () => {
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).transform({ rotate: 90 }));
    expect(transformOp(ops)).toEqual({ type: 'transform', options: { rotate: 90 } });
  });

  it('drops an EXPLICIT undefined option — transform({ flip: undefined }) lowers to a bare op', () => {
    // A present-but-undefined key exercises the `value !== undefined` guard the
    // absent-key case above never reaches; without the guard the wire would
    // carry `options: { flip: undefined }` instead of a bare op.
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).transform({ flip: undefined }));
    expect(transformOp(ops)).toEqual({ type: 'transform' });
  });

  it('transform({}) lowers to a bare transform op (empty options omitted; a no-op is server-rejected)', () => {
    // The shared lowerStep omits an empty options object entirely — no client-side
    // no-op rejection (rotate:0 + flip:none is an `invalid_options` 422 server-side).
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).transform({}));
    expect(transformOp(ops)).toEqual({ type: 'transform' });
  });
});

describe('FilesRecipe.transform — shared op across the fan-out', () => {
  it('emits the SAME transform op into every per-file job', () => {
    const payload = new FilesRecipe([fileInput.path('a.jpg'), fileInput.path('b.jpg')])
      .transform({ flip: 'vertical' })
      .toWorkflowPayload(['f0', 'f1']);

    expect(payload.jobs).toHaveLength(2);
    for (const job of payload.jobs) {
      expect(transformOp(job.operations)).toEqual({ type: 'transform', options: { flip: 'vertical' } });
    }
  });
});

describe('MergedRecipe.transform — post-merge lowering', () => {
  it('appends a transform op to the merge job', () => {
    const merged = new MergedRecipe([fileInput.path('a.mp4'), fileInput.path('b.mp4')], { mediaKind: 'video' })
      .transform({ rotate: 180 });
    const ops = lastJobOps(merged.toWorkflowPayload([FILE_ID, 'file_0002']));
    // The post-verb appends to the merge job, so the wire order is merge → transform
    // (parity with the PHP TransformVerbTest merge-order assertion).
    expect(ops.map((o) => o.type)).toEqual(['merge', 'transform']);
    expect(transformOp(ops)).toEqual({ type: 'transform', options: { rotate: 180 } });
  });
});

describe('WatermarkedRecipe.transform — post-watermark lowering', () => {
  it('appends a transform op after the watermark op in the watermark job', () => {
    const wr = new Recipe(fileInput.path('photo.jpg'))
      .watermark(new Recipe(fileInput.path('logo.png')))
      .transform({ rotate: 90 });
    // The watermark job is the last job ([src_0, src_1, watermark]); post-verbs
    // append to it, so the wire order is image_watermark → transform.
    const ops = lastJobOps(wr.toWorkflowPayload(['base', 'ovl']));
    expect(ops.map((o) => o.type)).toEqual(['image_watermark', 'transform']);
    expect(transformOp(ops)).toEqual({ type: 'transform', options: { rotate: 90 } });
  });
});

describe('client transform() — exported single-op builder (gisl proxy)', () => {
  async function client() {
    return create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
  }

  it('builds an OperationBuilder for a valid bag (no throw)', async () => {
    const c = await client();
    expect(() => c.transform('photo.png', { rotate: 90 })).not.toThrow();
    expect(() => c.transform('photo.png', {})).not.toThrow();
  });

  it('rejects an unknown option key pre-upload with GislConfigError', async () => {
    const c = await client();
    expect(() => c.transform('photo.png', { rotate: 90, bogus: 1 })).toThrow(GislConfigError);
    expect(() => c.transform('photo.png', { bogus: 1 })).toThrow(/unknown option 'bogus'/);
    // Structured-prop parity with the PHP client rejection test.
    try {
      c.transform('photo.png', { bogus: 1 });
      expect.unreachable('an unknown transform key must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('unknown_field');
      expect((err as GislConfigError).conflictingFields).toEqual(['bogus']);
    }
  });
});
