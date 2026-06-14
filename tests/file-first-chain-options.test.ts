import { describe, it, expect } from 'vitest';

import { FilesRecipe, MergedRecipe, Recipe, fileInput } from '../src/file-first.js';
import { resolveCompressOptions } from '../src/ergonomic/preset_resolver.js';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError } from '../src/errors.js';
import type { OperationDef, WorkflowCreatePayload } from '../src/types.js';
import type { MergeOptions } from '../src/merge.js';

/**
 * 0rb1QlUC — the ergonomic file-first CHAIN methods now accept an optional
 * per-op options bag (`Record<string, unknown>`), mirroring the op-first
 * surface. This suite pins the lowering of those options across `Recipe`,
 * `FilesRecipe` (fan-out), and `MergedRecipe` (post-combine), proving each
 * surface threads explicit options to the wire and that compress precedence
 * matches the shared op-first resolver. Mirrors the PHP
 * `RecipeChainOptionsTest` / `*ChainOptionsTest`. Network-free: only the pure
 * `toWorkflowPayload()` lowering seam is exercised.
 */

const FILE_ID = 'file_0001';

const recipe = (path: string): Recipe => new Recipe(fileInput.path(path));

const loweredJob = (r: Recipe): WorkflowCreatePayload['jobs'][number] => {
  const wire = r.toWorkflowPayload(FILE_ID);
  expect(wire.jobs).toHaveLength(1);
  return wire.jobs[0];
};

const operations = (r: Recipe): OperationDef[] => loweredJob(r).operations;

// ---------------------------------------------------------------------------
// 1. Each chain op carries explicit options into the lowered OperationDef.
// ---------------------------------------------------------------------------

describe('Recipe chain options — explicit options reach the wire', () => {
  it('convert(format, options) merges the bag after format', () => {
    const ops = operations(recipe('clip.mov').convert('mp4', { codec: 'h265', quality: 90 }));
    expect(ops).toEqual([
      { type: 'convert', options: { format: 'mp4', codec: 'h265', quality: 90 } },
    ]);
  });

  it('thumbnail(options) carries ALL defined keys (not just width/height)', () => {
    const ops = operations(
      recipe('photo.jpg').thumbnail({ width: 200, fit: 'cover', format: 'webp' }),
    );
    expect(ops).toEqual([
      { type: 'thumbnail', options: { width: 200, fit: 'cover', format: 'webp' } },
    ]);
  });

  it('thumbnail(options) drops an undefined value', () => {
    // TS drops only `undefined` (the absent-key signal); the PHP mirror drops
    // `null` (its absent-key signal). Each language drops its own omission
    // sentinel — see the PHP RecipeChainOptionsTest::thumbnail_drops_a_null_value.
    const ops = operations(
      recipe('photo.jpg').thumbnail({ width: 200, height: undefined, fit: 'cover' }),
    );
    expect(ops).toEqual([{ type: 'thumbnail', options: { width: 200, fit: 'cover' } }]);
    expect(ops[0].options).not.toHaveProperty('height');
  });

  it('textWatermark(text, options) merges the bag after text', () => {
    const ops = operations(
      recipe('photo.jpg').textWatermark('hi', { position: 'bottom-right', opacity: 0.5 }),
    );
    expect(ops).toEqual([
      { type: 'text_watermark', options: { text: 'hi', position: 'bottom-right', opacity: 0.5 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1b. The explicit shorthand arg is AUTHORITATIVE over a bag key (codex r2).
//     options are spread FIRST, then the explicit format/text, so a bag key
//     can never silently override the call's explicit argument.
// ---------------------------------------------------------------------------

describe('Recipe chain options — explicit shorthand arg wins over a bag key', () => {
  it('convert(\'mp4\', { format: \'webm\' }) lowers format=mp4 (the bag format is overridden)', () => {
    const ops = operations(recipe('clip.mov').convert('mp4', { format: 'webm' }));
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('convert');
    expect((ops[0].options as Record<string, unknown>).format).toBe('mp4');
  });

  it('textWatermark(\'real\', { text: \'fake\' }) lowers text=real (the bag text is overridden)', () => {
    const ops = operations(recipe('photo.jpg').textWatermark('real', { text: 'fake' }));
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('text_watermark');
    expect((ops[0].options as Record<string, unknown>).text).toBe('real');
  });

  it('files([...]).merge().convert(\'mp4\', { format: \'webm\' }) lowers format=mp4 on the merge job', () => {
    const payload = new MergedRecipe([fileInput.path('a.mp4'), fileInput.path('b.mp4')], {
      mediaKind: 'video',
    })
      .convert('mp4', { format: 'webm' })
      .toWorkflowPayload(['f0', 'f1']);

    const mergeJob = payload.jobs[2]; // 2 src jobs + the merge job
    expect(mergeJob.operations[1].type).toBe('convert');
    expect((mergeJob.operations[1].options as Record<string, unknown>).format).toBe('mp4');
  });
});

// ---------------------------------------------------------------------------
// 2. compress: chain precedence == op-first precedence.
// ---------------------------------------------------------------------------

describe('Recipe chain compress — precedence mirrors the op-first resolver', () => {
  it('explicit option OVERRIDES the preset; same wireOptions as the op-first resolver', () => {
    // The op-first surface (client.compress(input, { optimize: Balanced, quality: 55 }))
    // delegates to resolveCompressOptions with optimize=Balanced + explicitOptions
    // {quality:55}; the chain MUST produce identical wireOptions, proving the two
    // surfaces share the same explicit-layer-wins precedence.
    const opFirst = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 55 },
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    const ops = operations(recipe('photo.jpg').compress(OptimizeFor.Balanced, { quality: 55 }));
    expect(ops[0].type).toBe('compress');
    expect(ops[0].options).toEqual(opFirst);
    // Explicit quality:55 won over the Balanced preset's own quality (which is 80
    // for image — see ff_lowering_single_compress.yaml).
    expect((ops[0].options as Record<string, unknown>).quality).toBe(55);
  });

  it('presetOverrides routes through the callPresetOverride layer', () => {
    const overrides = { quality: 42 };
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
      presetOverrides: overrides,
    }).wireOptions;

    const ops = operations(
      recipe('photo.jpg').compress(OptimizeFor.Balanced, { presetOverrides: overrides }),
    );
    expect(ops[0].options).toEqual(expected);
    // The override landed (not the shipped preset quality), and `presetOverrides`
    // itself is NOT leaked as a wire key.
    expect((ops[0].options as Record<string, unknown>).quality).toBe(42);
    expect(ops[0].options).not.toHaveProperty('presetOverrides');
  });

  it('the explicit optimize param wins over an optimize key in the bag', () => {
    // optimize=Size param must beat optimize:Balanced in the bag.
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Size,
    }).wireOptions;

    const ops = operations(
      recipe('photo.jpg').compress(OptimizeFor.Size, {
        optimize: OptimizeFor.Balanced,
      } as Record<string, unknown>),
    );
    expect(ops[0].options).toEqual(expected);
    // The bag's optimize value never reaches the wire (it is consumed as a layer).
    expect(ops[0].options).not.toHaveProperty('optimize');
  });
});

// ---------------------------------------------------------------------------
// 2b. Codex regression parity — bag-supplied optimize is preserved/resolved.
// (PHP had a bug where omitting the shorthand nulled a bag optimize; TS already
//  preserves it via the spread. Lock the TS behaviour so it can't regress and
//  the two surfaces can't drift.)
// ---------------------------------------------------------------------------

describe('Recipe chain compress — bag-supplied optimize is resolved (regression parity)', () => {
  it('compress(undefined, { optimize: Balanced }) lowers identically to compress(Balanced)', () => {
    const viaBag = operations(
      recipe('photo.jpg').compress(undefined, {
        optimize: OptimizeFor.Balanced,
      } as Record<string, unknown>),
    );
    const viaShorthand = operations(recipe('photo.jpg').compress(OptimizeFor.Balanced));

    expect(viaBag[0].options).toEqual(viaShorthand[0].options);
    // The preset actually resolved (a preset field is present, not skipped).
    expect((viaBag[0].options as Record<string, unknown>).quality).toBe(80);
    expect(viaBag[0].options).not.toHaveProperty('optimize');
  });

  it('compress(Size, { optimize: Balanced }) — the shorthand param wins (Size, not Balanced)', () => {
    const expectedSize = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Size,
    }).wireOptions;
    const expectedBalanced = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    const ops = operations(
      recipe('photo.jpg').compress(OptimizeFor.Size, {
        optimize: OptimizeFor.Balanced,
      } as Record<string, unknown>),
    );
    expect(ops[0].options).toEqual(expectedSize);
    expect(ops[0].options).not.toEqual(expectedBalanced);
  });
});

// ---------------------------------------------------------------------------
// 2c. Codex r3 — the lowering chokepoint validates bag-supplied special keys.
//     The compress() shorthand-param guard only checks a PARAM optimize; a bag
//     optimize / presetOverrides (param omitted) bypassed it, so a bad value
//     surfaced as a raw preset-lookup error / TypeError. lowerCompressOptions
//     now raises the typed SDK error. (PHP covers this via coerceOptimize at
//     call time + normalisePresetOverrides — see the PHP mirrors.)
// ---------------------------------------------------------------------------

describe('Recipe chain compress — bag special-key validation (codex r3)', () => {
  const lower = (r: Recipe): void => {
    r.toWorkflowPayload(FILE_ID);
  };

  it('a bag-supplied invalid optimize (param omitted) throws invalid_optimize', () => {
    // The exact bypass codex flagged: optimize lives in the bag, NOT the param,
    // so the compress() param guard never ran. Lowering must reject it.
    const r = recipe('photo.jpg').compress(undefined, {
      optimize: 'Bogus',
    } as Record<string, unknown>);
    expect(() => lower(r)).toThrow(GislConfigError);
    try {
      lower(r);
      expect.unreachable('a bogus bag optimize must throw at lowering');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('invalid_optimize');
    }
  });

  it.each([
    ['a scalar string', 'not-an-object' as unknown],
    ['null', null as unknown],
    ['an array', ['x'] as unknown],
  ])('a presetOverrides that is %s throws invalid_preset_overrides', (_label, value) => {
    const r = recipe('photo.jpg').compress(undefined, {
      presetOverrides: value,
    } as Record<string, unknown>);
    expect(() => lower(r)).toThrow(GislConfigError);
    try {
      lower(r);
      expect.unreachable('a non-object presetOverrides must throw at lowering');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('invalid_preset_overrides');
    }
  });

  it('a valid plain-object presetOverrides does NOT throw and reaches the resolver', () => {
    // Sanity: the validation rejects only null / scalar / array — a plain object
    // is the valid shape and the override (quality:40) reaches the resolver.
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
      presetOverrides: { quality: 40 },
    }).wireOptions;

    const ops = operations(
      recipe('photo.jpg').compress(OptimizeFor.Balanced, { presetOverrides: { quality: 40 } }),
    );
    expect(ops[0].options).toEqual(expected);
    // The override landed (quality 40), not the Balanced preset default (80).
    expect((ops[0].options as Record<string, unknown>).quality).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 3. Media-undefined passthrough.
// ---------------------------------------------------------------------------

describe('Recipe chain compress — media-undefined passthrough', () => {
  it('compress(undefined, { crf: 23 }) on a bare upload-id passes options through verbatim', () => {
    // A pre-uploaded id has no inferable media → no preset resolution. With NO
    // optimize, the explicit bag passes through verbatim (no throw).
    const r = new Recipe(fileInput.uploadId('uploaded-xyz')).compress(undefined, { crf: 23 });
    const ops = operations(r);
    expect(ops).toEqual([{ type: 'compress', options: { crf: 23 } }]);
  });

  it('compress(Balanced, {...}) on the same media-unknown input STILL throws media_unknown', () => {
    const r = new Recipe(fileInput.uploadId('uploaded-xyz')).compress(OptimizeFor.Balanced, {
      crf: 23,
    });
    expect(() => r.toWorkflowPayload(FILE_ID)).toThrow(GislConfigError);
    try {
      r.toWorkflowPayload(FILE_ID);
      expect.unreachable('compress(optimize) on media-unknown must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('media_unknown');
    }
  });

  it('compress(undefined, { presetOverrides }) on media-unknown throws media_unknown (codex r2)', () => {
    // presetOverrides override a RESOLVED preset; with no inferable media there
    // is no preset to override, so it now FAILS FAST rather than silently
    // dropping the override. Same input as the optimize throw above.
    const r = new Recipe(fileInput.uploadId('uploaded-xyz')).compress(undefined, {
      presetOverrides: { quality: 50 },
    });
    expect(() => r.toWorkflowPayload(FILE_ID)).toThrow(GislConfigError);
    try {
      r.toWorkflowPayload(FILE_ID);
      expect.unreachable('compress(presetOverrides) on media-unknown must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('media_unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Minimal forms unchanged (regression guard).
// ---------------------------------------------------------------------------

describe('Recipe chain options — minimal forms unchanged (regression guard)', () => {
  it('compress(Balanced) lowers exactly as the resolver with empty explicit options', () => {
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
    }).wireOptions;
    expect(operations(recipe('photo.jpg').compress(OptimizeFor.Balanced))[0].options).toEqual(
      expected,
    );
  });

  it('bare compress() on an extensionless path emits NO options key', () => {
    const ops = operations(recipe('photo').compress());
    expect(ops).toEqual([{ type: 'compress' }]);
    expect(ops[0]).not.toHaveProperty('options');
  });

  it('convert(format) with no bag carries only the format', () => {
    expect(operations(recipe('clip.mov').convert('png'))).toEqual([
      { type: 'convert', options: { format: 'png' } },
    ]);
  });

  it('thumbnail({ width }) with no extra keys is unchanged', () => {
    expect(operations(recipe('photo.jpg').thumbnail({ width: 100 }))).toEqual([
      { type: 'thumbnail', options: { width: 100 } },
    ]);
  });

  it('textWatermark(text) with no bag carries only the text', () => {
    expect(operations(recipe('photo.jpg').textWatermark('x'))).toEqual([
      { type: 'text_watermark', options: { text: 'x' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. FilesRecipe (fan-out) + MergedRecipe carry options through BOTH builders.
// ---------------------------------------------------------------------------

describe('FilesRecipe chain options — fan-out threads options into every job', () => {
  it('convert(format, options) carries the option into EVERY job', () => {
    const payload = new FilesRecipe([fileInput.path('a.mov'), fileInput.path('b.mov')])
      .convert('mp4', { codec: 'h265' })
      .toWorkflowPayload(['f0', 'f1']);

    expect(payload.jobs).toHaveLength(2);
    payload.jobs.forEach((job) => {
      expect(job.operations).toEqual([
        { type: 'convert', options: { format: 'mp4', codec: 'h265' } },
      ]);
    });
  });

  it('compress(optimize, options) explicit override reaches every job', () => {
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 55 },
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    const payload = new FilesRecipe([fileInput.path('a.jpg'), fileInput.path('b.jpg')])
      .compress(OptimizeFor.Balanced, { quality: 55 })
      .toWorkflowPayload(['f0', 'f1']);

    payload.jobs.forEach((job) => {
      expect(job.operations[0]).toEqual({ type: 'compress', options: expected });
      expect((job.operations[0].options as Record<string, unknown>).quality).toBe(55);
    });
  });

  it('thumbnail(options) carries extra keys into every job', () => {
    const payload = new FilesRecipe([fileInput.path('a.jpg'), fileInput.path('b.jpg')])
      .thumbnail({ width: 200, fit: 'cover' })
      .toWorkflowPayload(['f0', 'f1']);
    payload.jobs.forEach((job) => {
      expect(job.operations).toEqual([
        { type: 'thumbnail', options: { width: 200, fit: 'cover' } },
      ]);
    });
  });
});

describe('MergedRecipe chain options — post-combine ops carry options', () => {
  const mergedVideo = (paths: string[], options: MergeOptions = { mediaKind: 'video' }): MergedRecipe =>
    new MergedRecipe(paths.map((p) => fileInput.path(p)), options);

  it('merge().compress(optimize, { crf }) carries the override onto the merge job', () => {
    // Merged media is video, so use a video-valid knob (crf), not image quality.
    const expected = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      explicitOptions: { crf: 28 },
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    const payload = mergedVideo(['a.mp4', 'b.mp4'])
      .compress(OptimizeFor.Balanced, { crf: 28 })
      .toWorkflowPayload(['f0', 'f1']);

    // 2 src jobs + the merge job (last).
    const mergeJob = payload.jobs[2];
    expect(mergeJob.id).toBe('merge');
    expect(mergeJob.operations.map((o) => o.type)).toEqual(['merge', 'compress']);
    const compressOp = mergeJob.operations[1];
    expect(compressOp.options).toEqual(expected);
    expect((compressOp.options as Record<string, unknown>).crf).toBe(28);
  });

  it('merge().convert(format, options) carries the bag onto the merge job', () => {
    const payload = mergedVideo(['a.mp4', 'b.mp4'])
      .convert('webm', { codec: 'vp9' })
      .toWorkflowPayload(['f0', 'f1']);

    const mergeJob = payload.jobs[2];
    expect(mergeJob.operations[1]).toEqual({
      type: 'convert',
      options: { format: 'webm', codec: 'vp9' },
    });
  });

  it('merge().thumbnail(options) carries extra keys onto the merge job', () => {
    const payload = mergedVideo(['a.mp4', 'b.mp4'])
      .thumbnail({ width: 320, format: 'jpeg' })
      .toWorkflowPayload(['f0', 'f1']);

    const mergeJob = payload.jobs[2];
    expect(mergeJob.operations[1]).toEqual({
      type: 'thumbnail',
      options: { width: 320, format: 'jpeg' },
    });
  });
});
