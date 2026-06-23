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

describe('output() — still-planned options gated unavailable', () => {
  it('lossy (planned, png) throws feature_not_available', () => {
    try {
      ops(new Recipe(fileInput.path('photo.png')).output('png', { lossy: true }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('feature_not_available');
    }
  });

  it("metadata 'all' and 'keep' both honored since v2.102.0 (keep/strip un-parked)", () => {
    expect(soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { metadata: 'all' })).options).toMatchObject({
      metadata: 'all',
    });
    expect(soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { metadata: 'keep' })).options).toMatchObject({
      metadata: 'keep',
    });
  });
});

describe('output() — target-size (v2.104.0; encoding_mode quality live / target_size planned)', () => {
  it("encoding_mode 'quality' honored on same-format webp (the live default mode)", () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.webp')).output('webp', { encoding_mode: 'quality' })).options,
    ).toMatchObject({ encoding_mode: 'quality' });
  });

  it("encoding_mode 'quality' honored on same-format jpeg", () => {
    expect(
      soleOp(new Recipe(fileInput.path('a.jpg')).output('jpeg', { encoding_mode: 'quality' })).options,
    ).toMatchObject({ encoding_mode: 'quality' });
  });

  it("encoding_mode 'target_size' (planned VALUE) throws feature_not_available", () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { encoding_mode: 'target_size' }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('feature_not_available');
    }
  });

  it('target_size_bytes (planned KEY) throws feature_not_available on same-format jpeg', () => {
    try {
      ops(new Recipe(fileInput.path('a.jpg')).output('jpeg', { target_size_bytes: 50_000 }));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as GislConfigError).reason).toBe('feature_not_available');
    }
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
