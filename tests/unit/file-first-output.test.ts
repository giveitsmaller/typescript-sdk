import { describe, it, expect } from 'vitest';

import { Recipe, fileInput } from '../../src/file-first.js';
import { GislConfigError } from '../../src/errors.js';
import type { OperationDef, WorkflowCreatePayload } from '../../src/types.js';

/**
 * Image "Output" + Resize file-first helpers (card YNLrGhNo, contracts v2.97.0).
 *
 * `output(format?, options)` resolves the route from (input format, output_format)
 * against the image-output-routes projection and lowers to that route's wire op —
 * `compress` (same_format, `output_format: 'original'`) or `convert` (format_change,
 * `output_format: <fmt>`) — emitting only route-honored options. `resize()` merges
 * width/height/fit into the SAME Output step (one artifact, never a thumbnail).
 * Planned / not-honored / planned-per-value options throw BEFORE upload.
 */

const FILE_ID = 'file_0001';

/** Lower a single-input Recipe and return its one job's operations. */
function ops(r: Recipe): OperationDef[] {
  const wire: WorkflowCreatePayload = r.toWorkflowPayload(FILE_ID);
  return wire.jobs[0].operations;
}

/** The single lowered op (asserts exactly one). */
function soleOp(r: Recipe): OperationDef {
  const list = ops(r);
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('output() — route resolution + wire op', () => {
  it('same-format → compress op with output_format:original', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.jpg')).output('jpeg', { quality: 80 }));
    expect(op).toEqual({ type: 'compress', options: { output_format: 'original', quality: 80 } });
  });

  it('format omitted → same-format (keep input format) compress op', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.png')).output(undefined, { quality: 70 }));
    expect(op).toEqual({ type: 'compress', options: { output_format: 'original', quality: 70 } });
  });

  it('format-change → convert op with the target output_format', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.png')).output('webp', { quality: 80 }));
    expect(op).toEqual({ type: 'convert', options: { output_format: 'webp', quality: 80 } });
  });

  it('never emits a thumbnail op', () => {
    const list = ops(new Recipe(fileInput.path('photo.png')).output('webp').resize(800, 600));
    expect(list.some((o) => o.type === 'thumbnail')).toBe(false);
  });
});

describe('output() + resize() — one artifact', () => {
  it('format-change + resize → ONE convert op carrying resize keys', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.png')).output('webp').resize(1200, 800, 'max'));
    expect(op).toEqual({
      type: 'convert',
      options: { output_format: 'webp', width: 1200, height: 800, fit: 'max' },
    });
  });

  it('same-format + width-only resize (height optional)', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.jpg')).output('jpeg').resize(800));
    expect(op).toEqual({ type: 'compress', options: { output_format: 'original', width: 800 } });
  });

  it('resize() with no preceding output step appends a same-format Output step', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.png')).resize(800, 600));
    expect(op).toEqual({ type: 'compress', options: { output_format: 'original', width: 800, height: 600 } });
  });

  it('resize merges into the preceding output step (no extra op)', () => {
    expect(ops(new Recipe(fileInput.path('photo.png')).output('webp').resize(800))).toHaveLength(1);
  });
});

describe('output() — route-aware option gating', () => {
  it('progressive honored on same-format jpeg', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.jpg')).output('jpeg', { progressive: true }));
    expect(op.options).toMatchObject({ progressive: true });
  });

  it('progressive NOT honored on a format-change → throws option_not_on_route', () => {
    expect(() => ops(new Recipe(fileInput.path('photo.png')).output('jpeg', { progressive: true }))).toThrow(
      GislConfigError,
    );
    try {
      ops(new Recipe(fileInput.path('photo.png')).output('jpeg', { progressive: true }));
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });

  it('background honored on format-change→jpeg (rides convert)', () => {
    const op = soleOp(new Recipe(fileInput.path('photo.png')).output('jpeg', { background: '#ffffff' }));
    expect(op).toEqual({ type: 'convert', options: { output_format: 'jpeg', background: '#ffffff' } });
  });

  it('background NOT honored on same-format → throws', () => {
    expect(() => ops(new Recipe(fileInput.path('photo.jpg')).output('jpeg', { background: '#fff' }))).toThrow(
      /not honored/,
    );
  });

  it('optimization_level honored on same-format png only', () => {
    expect(soleOp(new Recipe(fileInput.path('a.png')).output('png', { optimization_level: 6 })).options).toMatchObject({
      optimization_level: 6,
    });
    expect(() => ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { optimization_level: 6 }))).toThrow();
  });
});

describe('output() — lossless (stable on jpeg/webp since v2.101.0)', () => {
  it('lossless honored on same-format jpeg', () => {
    expect(soleOp(new Recipe(fileInput.path('photo.jpg')).output('jpeg', { lossless: true })).options).toMatchObject({
      lossless: true,
    });
  });

  it('lossless honored on same-format webp', () => {
    expect(soleOp(new Recipe(fileInput.path('photo.webp')).output('webp', { lossless: true })).options).toMatchObject({
      lossless: true,
    });
  });

  it('lossless NOT honored on png (no lossless route) → throws option_not_on_route', () => {
    try {
      ops(new Recipe(fileInput.path('photo.png')).output('png', { lossless: true }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });
});

describe('output() — removed and still-planned options gated locally', () => {
  it('lossy (removed from png output) throws unknown_field', () => {
    try {
      new Recipe(fileInput.path('photo.png')).output('png', { lossy: true } as never);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('unknown_field');
    }
  });

  it("metadata 'strip'/'keep' honored on same-format jpeg (v2.107.0 rename all->strip)", () => {
    expect(soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { metadata: 'strip' })).options).toMatchObject({
      metadata: 'strip',
    });
    expect(soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { metadata: 'keep' })).options).toMatchObject({
      metadata: 'keep',
    });
  });

  it('metadata PLANNED on a format-change route → feature_not_available (v2.106.0 convert.image metadata)', () => {
    try {
      ops(new Recipe(fileInput.path('a.png')).output('webp', { metadata: 'strip' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('feature_not_available');
    }
  });
});

describe('output() — target-size (v2.108.0; encoding_mode + target_size_bytes STABLE)', () => {
  it("encoding_mode 'quality' honored on same-format webp (the default mode)", () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.webp')).output('webp', { encoding_mode: 'quality' })).options,
    ).toMatchObject({ encoding_mode: 'quality' });
  });

  it("encoding_mode 'target_size' honored on same-format jpeg (stable since v2.108.0 — emitted, not gated)", () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { encoding_mode: 'target_size' })).options,
    ).toMatchObject({ encoding_mode: 'target_size' });
  });

  it('target_size_bytes honored on same-format jpeg (stable — reaches the wire)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { encoding_mode: 'target_size', target_size_bytes: 50_000 })).options,
    ).toMatchObject({ encoding_mode: 'target_size', target_size_bytes: 50_000 });
  });

  it('encoding_mode NOT honored on a format-change route → option_not_on_route', () => {
    // encoding_mode is an optimiser (same_format) knob; a format-change routes via
    // convert, which does not honor it.
    try {
      ops(new Recipe(fileInput.path('a.png')).output('webp', { encoding_mode: 'quality' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });
});

describe('output() — chroma_subsampling (v2.110.0 stable) + quality_preset (v2.148.0 stable)', () => {
  it('chroma_subsampling honored on same-format jpeg', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { chroma_subsampling: '420' })).options,
    ).toMatchObject({ chroma_subsampling: '420' });
  });

  it('chroma_subsampling NOT honored on same-format webp (jpeg-only) → option_not_on_route', () => {
    try {
      ops(new Recipe(fileInput.path('a.webp')).output('webp', { chroma_subsampling: '420' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });

  it('quality_preset infers encoding_mode:auto_quality so it forms a valid request (86gAu5Tr)', () => {
    // quality_preset depends_on encoding_mode=auto_quality; without the inference
    // it shipped without encoding_mode and 422-ed. Now the SDK adds it.
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { quality_preset: 'good' })).options,
    ).toEqual({ output_format: 'original', quality_preset: 'good', encoding_mode: 'auto_quality' });
  });

  it('quality_preset with an explicit NON-auto_quality encoding_mode is rejected (depends_on)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { quality_preset: 'good', encoding_mode: 'quality' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
    }
  });

  it('quality_preset WITH an explicit encoding_mode: auto_quality is allowed', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { quality_preset: 'good', encoding_mode: 'auto_quality' }))
        .options,
    ).toMatchObject({ quality_preset: 'good', encoding_mode: 'auto_quality' });
  });

  // auto_quality forbids the mode-specific siblings whose depends_on names a
  // different encoding_mode; the SDK rejects them client-side instead of
  // shipping a payload the worker refuses as invalid_options (86gAu5Tr).
  it.each(['quality', 'lossless', 'target_size_bytes'])(
    'quality_preset + %s is rejected — auto_quality forbids it (86gAu5Tr)',
    (field) => {
      const value = field === 'lossless' ? true : field === 'target_size_bytes' ? 50_000 : 80;
      try {
        ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { quality_preset: 'good', [field]: value }));
        throw new Error('expected throw');
      } catch (e) {
        expect((e as GislConfigError).reason).toBe('invalid_option_combination');
        expect((e as GislConfigError).conflictingFields).toEqual(['encoding_mode', field]);
      }
    },
  );

  it('explicit encoding_mode: auto_quality + quality is rejected even without quality_preset (86gAu5Tr)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { encoding_mode: 'auto_quality', quality: 80 }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
    }
  });

  it('quality_preset NOT honored on same-format png (avif/jpeg/webp-only) → option_not_on_route', () => {
    try {
      ops(new Recipe(fileInput.path('a.png')).output('png', { quality_preset: 'good' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });

  // General contract depends_on validation (ehHU08Hu) — beyond the auto_quality
  // family: target_size_bytes needs target_size mode, fit needs a dimension.
  it('target_size_bytes without encoding_mode:target_size is rejected (default is quality)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { target_size_bytes: 50_000 }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
      expect((e as GislConfigError).conflictingFields).toEqual(['encoding_mode', 'target_size_bytes']);
    }
  });

  it('quality with no encoding_mode is allowed — encoding_mode defaults to quality (no over-reject)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { quality: 80 })).options,
    ).toEqual({ output_format: 'original', quality: 80 });
  });

  it('fit without width or height is rejected (depends_on { width|height set })', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { fit: 'max' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
      expect((e as GislConfigError).conflictingFields).toEqual(['fit', 'width', 'height']);
    }
  });

  it('fit with a width is allowed', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { fit: 'max', width: 800 })).options,
    ).toMatchObject({ fit: 'max', width: 800 });
  });

  it('fit with a null width is still rejected — null is not "set" (parity with PHP)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { fit: 'max', width: null as unknown as number }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
      expect((e as GislConfigError).conflictingFields).toEqual(['fit', 'width', 'height']);
    }
  });

  // fit → width|height is IDENTICAL in compress + convert, so it is validated on
  // BOTH routes (codex: same_format-only scoping had disabled it on convert).
  it('fit without a dimension is rejected on a format_change too (shared dep)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('webp', { fit: 'max' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_combination');
      expect((e as GislConfigError).conflictingFields).toEqual(['fit', 'width', 'height']);
    }
  });

  it('fit with a width is allowed on a format_change', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('webp', { fit: 'max', width: 800 })).options,
    ).toMatchObject({ fit: 'max', width: 800 });
  });

  it('a null dependent option is dropped, not shipped — full null parity (codex)', () => {
    // target_size_bytes: null is dropped at build (like PHP), so it never reaches
    // the wire and triggers no dependency error.
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { target_size_bytes: null as unknown as number }))
        .options,
    ).toEqual({ output_format: 'original' });
  });
});

describe('output() — color_profile (un-gated v2.128.0) + auto_orient (STABLE since v2.120.0)', () => {
  it('color_profile keep honored on same-format jpeg (un-gated v2.128.0)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { color_profile: 'keep' })).options,
    ).toMatchObject({ color_profile: 'keep' });
  });

  it('color_profile srgb honored on same-format jpeg (jpeg srgb is live; webp/gif/tiff srgb stay planned)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { color_profile: 'srgb' })).options,
    ).toMatchObject({ color_profile: 'srgb' });
  });

  it('color_profile keep honored on same-format webp (keep/strip live)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.webp')).output('webp', { color_profile: 'keep' })).options,
    ).toMatchObject({ color_profile: 'keep' });
  });

  it('color_profile keep honored on same-format avif (un-gated v2.137.0)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.avif')).output('avif', { color_profile: 'keep' })).options,
    ).toMatchObject({ color_profile: 'keep' });
  });

  // v2.134 added `srgb: planned` to the generic compress `image` group, through
  // which webp/gif/svg/tiff route — so webp srgb stays gated pre-upload. (AVIF
  // routes through image_avif, where srgb flipped planned->stable in v2.148 — see
  // the honored avif test below.)
  it('color_profile srgb on webp throws feature_not_available (planned per-value)', () => {
    try {
      ops(new Recipe(fileInput.path('a.webp')).output('webp', { color_profile: 'srgb' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('feature_not_available');
    }
  });

  it('color_profile srgb honored on same-format avif (srgb planned->stable v2.148.0)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.avif')).output('avif', { color_profile: 'srgb' })).options,
    ).toMatchObject({ color_profile: 'srgb' });
  });

  it('auto_orient honored on same-format jpeg (stable since v2.120.0 — emitted, not gated)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { auto_orient: true })).options,
    ).toMatchObject({ auto_orient: true });
  });

  it('auto_orient honored on a format-change route too (stable on both routes)', () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.png')).output('webp', { auto_orient: true })).options,
    ).toMatchObject({ auto_orient: true });
  });
});

describe('output() — out-of-enum value gate (rtkzl9gr)', () => {
  it("metadata 'keep' rejected pre-upload on same-format avif (enum is [strip,all])", () => {
    try {
      ops(new Recipe(fileInput.path('a.avif')).output('avif', { metadata: 'keep' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_value');
      expect((e as GislConfigError).conflictingFields).toEqual(['metadata']);
    }
  });

  it("metadata 'keep' rejected pre-upload on same-format svg (enum is [strip,all])", () => {
    // svg routes through the generic `image` group for PLANNED gating, but the
    // enum gate must use the narrow image_svg enum — this pins that split.
    try {
      ops(new Recipe(fileInput.path('logo.svg')).output('svg', { metadata: 'keep' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_value');
    }
  });

  it("metadata 'keep' still honored on same-format png (image group enum includes keep)", () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.png')).output('png', { metadata: 'keep' })).options,
    ).toMatchObject({ metadata: 'keep' });
  });

  it("metadata 'all' (deprecated alias, in-enum) still passes on avif — deprecated is not invalid", () => {
    // 'all' is a deprecated alias omitted from the narrow hand-written union but
    // still a valid runtime enum member — the gate must not reject it.
    expect(
      soleOp(new Recipe(fileInput.path('a.avif')).output('avif', { metadata: 'all' as never })).options,
    ).toMatchObject({ metadata: 'all' });
  });

  it('an out-of-enum value on any gated option is rejected (fit: bogus on same-format jpeg)', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { fit: 'bogus' as never }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('invalid_option_value');
    }
  });

  it('auto_orient on an svg format-change is rejected pre-upload (input-gated, not honored)', () => {
    // svg is vector: it cannot be auto-oriented, so the option is stripped from
    // the svg→raster route and caught locally instead of 422-ing server-side.
    try {
      ops(new Recipe(fileInput.path('logo.svg')).output('png', { auto_orient: true }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });
});

describe('output() — unrepresentable routes + svg (vector, no resize)', () => {
  it('converting TO a format with no route throws unsupported_route', () => {
    // svg is not a format_change target (cannot transcode TO svg).
    try {
      ops(new Recipe(fileInput.path('photo.png')).output('svg'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('unsupported_route');
    }
  });

  it('svg input has no resize on its route → resize throws not-honored', () => {
    expect(() => ops(new Recipe(fileInput.path('logo.svg')).output('svg').resize(200, 200))).toThrow(/not honored/);
  });

  it('svg input quality is no longer honored → throws option_not_on_route', () => {
    try {
      ops(new Recipe(fileInput.path('logo.svg')).output('svg', { quality: 80 }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('option_not_on_route');
    }
  });
});

describe('output() — undetectable input (bare upload id)', () => {
  it('facade-managed webp emits the compress facade', () => {
    const op = soleOp(new Recipe(fileInput.uploadId('upl_x')).output('webp'));
    expect(op).toEqual({ type: 'compress', options: { output_format: 'webp' } });
  });

  it('non-facade target throws media_unknown', () => {
    try {
      ops(new Recipe(fileInput.uploadId('upl_x')).output('jpeg'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('media_unknown');
    }
  });

  it('resize on an undetectable input throws media_unknown (needs a route)', () => {
    try {
      ops(new Recipe(fileInput.uploadId('upl_x')).output('webp').resize(800));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('media_unknown');
    }
  });
});

describe('output() — eager key validation', () => {
  it('rejects an unknown option key pre-upload', () => {
    expect(() => new Recipe(fileInput.path('a.jpg')).output('jpeg', { bogus: 1 } as never)).toThrow(GislConfigError);
  });

  it('rejects a bag-supplied output_format (owned by the positional arg)', () => {
    expect(() => new Recipe(fileInput.path('a.jpg')).output('jpeg', { output_format: 'webp' } as never)).toThrow(
      /output format via its first argument|output_format/,
    );
  });
});
