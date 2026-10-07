import { describe, it, expect } from 'vitest';

import {
  validateVerbOptions,
  assertThumbnailDimensions,
  type ValidatedVerb,
} from '../../src/ergonomic/option_validation.js';
import type { ThumbnailOptions } from '../../src/ergonomic/option_types.js';
import { GislConfigError } from '../../src/errors.js';
import { MergedRecipe, Recipe, fileInput } from '../../src/file-first.js';

/**
 * Dhje3Faq — eager, synchronous, PRE-UPLOAD option-key validation for the
 * ergonomic verbs (`convert` / `thumbnail` / `textWatermark` / `watermark`).
 * `validateVerbOptions` rejects (1) a positional-owned key supplied in the bag
 * (`output_format` / `format` on convert; `text` on textWatermark) and (2) any
 * key absent from the op's contract option set — both with
 * `GislConfigError(reason: 'unknown_field')`. `assertThumbnailDimensions`
 * additionally rejects an explicit `null` width or height with
 * `reason: 'type_mismatch'` — both dimensions are OPTIONAL in the contract
 * (gkxZIIuw), so absence is accepted. The allowed key sets are read from the
 * generated `OperationMetadata` sidecars, so they track the contract.
 *
 * Mirrored by the PHP `OptionValidationTest` — keep the two in lockstep.
 *
 * Network-free: the validators are pure, and the "no upload" assertions drive a
 * `Recipe` built WITHOUT a client (the same `recipe()` pattern the other
 * file-first suites use), proving the throw happens at the verb CALL.
 */

const recipe = (path: string): Recipe => new Recipe(fileInput.path(path));
// Mirror of the file-first-watermark.test.ts `overlay()` helper — a bare
// image file-node used as the watermark overlay.
const overlay = (path = 'logo.png'): Recipe => new Recipe(fileInput.path(path));

// Re-thrown error captured for reason/conflictingFields assertions.
const captureConfigError = (fn: () => unknown): GislConfigError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof GislConfigError) return err;
    throw err;
  }
  throw new Error('expected the call to throw a GislConfigError, but it did not');
};

// ---------------------------------------------------------------------------
// validateVerbOptions — a VALID options bag passes (no throw), per verb.
// ---------------------------------------------------------------------------

describe('validateVerbOptions — valid bags pass', () => {
  const VALID: ReadonlyArray<[ValidatedVerb, Record<string, unknown>]> = [
    ['convert', { quality: 80 }],
    ['thumbnail', { width: 10, height: 10, fit: 'crop' }],
    ['textWatermark', { font_size: 12 }],
    ['watermark', { anchor: 'center' }],
  ];

  it.each(VALID)('%s accepts a real contract key without throwing', (verb, options) => {
    expect(() => validateVerbOptions(verb, options)).not.toThrow();
  });

  it('an empty bag passes for every verb', () => {
    for (const verb of ['convert', 'thumbnail', 'textWatermark', 'watermark'] as ValidatedVerb[]) {
      expect(() => validateVerbOptions(verb, {})).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// validateVerbOptions — an unknown (typo) key is rejected.
// ---------------------------------------------------------------------------

describe('validateVerbOptions — unknown key rejected', () => {
  it("convert { quaity: 80 } throws unknown_field naming the typo", () => {
    const err = captureConfigError(() => validateVerbOptions('convert', { quaity: 80 }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['quaity']);
    expect(err.message).toContain("unknown option 'quaity'");
  });

  it('thumbnail rejects an unknown key (width+height present so the dim guard is moot)', () => {
    const err = captureConfigError(() =>
      validateVerbOptions('thumbnail', { width: 1, height: 1, nope: true }),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['nope']);
  });

  it('watermark rejects an unknown key', () => {
    const err = captureConfigError(() => validateVerbOptions('watermark', { bogus: 1 }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });
});

// ---------------------------------------------------------------------------
// validateVerbOptions — positional-owned keys rejected with a specific message.
// ---------------------------------------------------------------------------

describe('validateVerbOptions — positional-owned keys rejected', () => {
  it("convert { output_format } throws unknown_field on output_format", () => {
    const err = captureConfigError(() =>
      validateVerbOptions('convert', { output_format: 'webm' }),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['output_format']);
    expect(err.message).toContain('as an argument');
  });

  it("convert { format } (the SDK alias) throws unknown_field on format", () => {
    const err = captureConfigError(() => validateVerbOptions('convert', { format: 'webm' }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['format']);
  });

  it("textWatermark { text } throws unknown_field on text", () => {
    const err = captureConfigError(() => validateVerbOptions('textWatermark', { text: 'fake' }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['text']);
    expect(err.message).toContain('as an argument');
  });

  it('the positional-owned check fires BEFORE the generic unknown-key check', () => {
    // A bag with BOTH a positional-owned key and a typo must report the
    // positional-owned one first (it is checked first), with the actionable
    // "as an argument" message rather than the generic "unknown option" one.
    const err = captureConfigError(() =>
      validateVerbOptions('convert', { output_format: 'webm', quaity: 1 }),
    );
    expect(err.conflictingFields).toEqual(['output_format']);
    expect(err.message).toContain('as an argument');
  });
});

// ---------------------------------------------------------------------------
// validateVerbOptions — watermark validates against image ∪ video keys.
// ---------------------------------------------------------------------------

describe('validateVerbOptions — watermark allows the image∪video union', () => {
  it("accepts overlay_width (a watermark-overlay key common to image+video)", () => {
    expect(() => validateVerbOptions('watermark', { overlay_width: '20%' })).not.toThrow();
  });

  it('accepts the shared anchor/margin/opacity keys', () => {
    expect(() =>
      validateVerbOptions('watermark', {
        anchor: 'top_left',
        margin_x: '5%',
        margin_y: '5%',
        opacity: 0.5,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertThumbnailDimensions — both dims OPTIONAL (contract v2.148.0+, gkxZIIuw);
// only an explicit null is refused, because it would reach the wire as JSON null.
// ---------------------------------------------------------------------------

describe('assertThumbnailDimensions', () => {
  it('passes when both width and height are present', () => {
    expect(() => assertThumbnailDimensions({ width: 10, height: 10 })).not.toThrow();
  });

  it('passes with width only (the server derives height from the aspect ratio)', () => {
    expect(() => assertThumbnailDimensions({ width: 10 })).not.toThrow();
  });

  it('passes with height only (the server derives width from the aspect ratio)', () => {
    expect(() => assertThumbnailDimensions({ height: 10 })).not.toThrow();
  });

  it('passes with neither (the server default: 320px longest edge)', () => {
    expect(() => assertThumbnailDimensions({})).not.toThrow();
  });

  it('passes a nullish bag (untyped JS caller, no arg) — no TypeError', () => {
    expect(() => assertThumbnailDimensions(undefined)).not.toThrow();
    expect(() => assertThumbnailDimensions(null)).not.toThrow();
  });

  it('passes an explicit undefined (the verbs drop it from the wire)', () => {
    expect(() => assertThumbnailDimensions({ width: 10, height: undefined })).not.toThrow();
  });

  it('rejects an explicit null width with type_mismatch and an accurate message', () => {
    // null would reach the wire as JSON null, which the contract's
    // `type: integer` refuses. PHP rejects it too (lockstep).
    const err = captureConfigError(() => assertThumbnailDimensions({ width: null, height: 1 }));
    expect(err.reason).toBe('type_mismatch');
    expect(err.conflictingFields).toEqual(['width']);
    expect(err.message).toContain('thumbnail width cannot be null');
    expect(err.message).toContain('omit the key');
    // The old message claimed the contract requires both — it does not.
    expect(err.message).not.toMatch(/requires both|marks both required/);
  });

  it('names BOTH dims when both are null', () => {
    const err = captureConfigError(() => assertThumbnailDimensions({ width: null, height: null }));
    expect(err.reason).toBe('type_mismatch');
    expect(err.conflictingFields).toEqual(['width', 'height']);
    expect(err.message).toContain('thumbnail width and height cannot be null');
  });
});

// ---------------------------------------------------------------------------
// Pre-upload: the throw happens at the VERB CALL on a Recipe with NO client /
// no upload — proving validation is synchronous and runs before any network.
// ---------------------------------------------------------------------------

describe('verb-call validation is pre-upload (no client, no network)', () => {
  it('convert with a typo throws synchronously at the verb call', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').convert('webp', { quaity: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['quaity']);
  });

  it('convert with a positional-owned bag key throws synchronously', () => {
    const err = captureConfigError(() =>
      recipe('clip.mov').convert('mp4', { output_format: 'webm' } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['output_format']);
  });

  it('textWatermark with a positional-owned text key throws synchronously', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').textWatermark('real', { text: 'fake' } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['text']);
  });

  it('thumbnail with ONE dimension is accepted at the verb call (contract: both optional)', () => {
    expect(() => recipe('photo.jpg').thumbnail({ width: 320 })).not.toThrow();
    expect(() => recipe('photo.jpg').thumbnail({ height: 240 })).not.toThrow();
  });

  it('thumbnail with NO options is accepted at the verb call (server default)', () => {
    expect(() => recipe('photo.jpg').thumbnail()).not.toThrow();
    expect(() => recipe('photo.jpg').thumbnail({})).not.toThrow();
  });

  it('thumbnail with an unknown key throws synchronously at the verb call', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').thumbnail({ width: 1, height: 1, nope: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['nope']);
  });

  it('thumbnail with a null dimension throws synchronously at the verb call', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').thumbnail({ width: 320, height: null } as never),
    );
    expect(err.reason).toBe('type_mismatch');
    expect(err.conflictingFields).toEqual(['height']);
  });
});

// ---------------------------------------------------------------------------
// The validator is COPY-PASTED into MergedRecipe / WatermarkedRecipe and the
// watermark verb body. The valid-bag paths above only exercise the base
// `Recipe`; a copy-paste OMISSION on a duplicated body would ship green. These
// drive the REJECTION path through each duplicated site so a missing
// validateVerbOptions/assertThumbnailDimensions call fails here.
// ---------------------------------------------------------------------------

describe('duplicated verb bodies reject invalid bags too', () => {
  const videoMerge = (): MergedRecipe =>
    new MergedRecipe([fileInput.path('a.mp4'), fileInput.path('b.mp4')], { mediaKind: 'video' });

  it('MergedRecipe.thumbnail rejects a null height', () => {
    const err = captureConfigError(() => videoMerge().thumbnail({ width: 320, height: null } as never));
    expect(err.reason).toBe('type_mismatch');
    expect(err.conflictingFields).toEqual(['height']);
  });

  it('MergedRecipe.thumbnail rejects an unknown key', () => {
    const err = captureConfigError(() => videoMerge().thumbnail({ width: 320, nope: 1 } as never));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['nope']);
  });

  // An untyped JS `thumbnail(null)` is the both-omitted default. Each duplicated
  // body iterates the bag to build the wire options, so a missing `?? {}` on any
  // one of them surfaces as a raw TypeError from Object.entries(null).
  it.each([
    ['Recipe', () => recipe('photo.jpg').thumbnail(null as never)],
    ['MergedRecipe', () => videoMerge().thumbnail(null as never)],
    ['WatermarkedRecipe', () => recipe('photo.jpg').watermark(overlay()).thumbnail(null as never)],
  ])('%s.thumbnail(null) is the no-dimension default, not a TypeError', (_name, call) => {
    expect(call).not.toThrow();
  });

  // ...but a non-object bag is NOT the default: it would lower as empty options
  // and silently request a 320px thumbnail.
  it.each([
    ['Recipe', (bag: unknown) => recipe('photo.jpg').thumbnail(bag as never)],
    ['MergedRecipe', (bag: unknown) => videoMerge().thumbnail(bag as never)],
    ['WatermarkedRecipe', (bag: unknown) => recipe('photo.jpg').watermark(overlay()).thumbnail(bag as never)],
  ])('%s.thumbnail rejects a non-object bag', (_name, call) => {
    class Opts {}
    for (const bag of [0, false, 'x', [320], new Date(0), new Map([['width', 320]]), /w/, new Opts()]) {
      const err = captureConfigError(() => call(bag));
      expect(err.reason).toBe('type_mismatch');
      expect(err.message).toContain('thumbnail options must be a plain object');
    }
    // A null-prototype bag IS a plain object: accepted.
    expect(() => call(Object.assign(Object.create(null), { width: 320 }))).not.toThrow();
  });

  it('WatermarkedRecipe.convert with a typo throws unknown_field', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay()).convert('webp', { quaity: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['quaity']);
  });

  it('WatermarkedRecipe.thumbnail rejects a null width', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay()).thumbnail({ width: null, height: 240 } as never),
    );
    expect(err.reason).toBe('type_mismatch');
    expect(err.conflictingFields).toEqual(['width']);
  });

  it('the watermark verb body key-validates BEFORE the media gate / upload', () => {
    // An unknown watermark option throws at the `.watermark()` call itself —
    // proving the eager key-validator fires before the media-routing gate and
    // any upload (an image base would otherwise route happily to
    // image_watermark and the bad key would slip to the server).
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay(), { bogus: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('Recipe.transform rejects an unknown key at the verb call', () => {
    const err = captureConfigError(() => recipe('photo.jpg').transform({ bogus: 1 } as never));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('MergedRecipe.transform rejects an unknown key at the verb call', () => {
    const err = captureConfigError(() => videoMerge().transform({ bogus: 1 } as never));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('WatermarkedRecipe.transform rejects an unknown key at the verb call', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay()).transform({ bogus: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });
});

// ---------------------------------------------------------------------------
// Compile-time guards.
//
// The typed `ConvertOptions` / `ThumbnailOptions` interfaces forbid an unknown
// key / a missing required dimension at `tsc` time. The `@ts-expect-error` lines
// below assert that rejection, and since jKfm0IOu they are checked: CI runs
// `npm run check:tests` (`tsc -p tsconfig.test.json`). The source-level
// `Equal<...>` assertions in `src/ergonomic/option_types.ts` (checked when the
// package builds) remain the primary guard; these pin the caller experience.
// ---------------------------------------------------------------------------

describe('typed-interface documentation (compile-time intent)', () => {
  it('an unknown convert key is a compile error for typed callers', () => {
    // @ts-expect-error unknown key 'quaity' is rejected by ConvertOptions
    const err = captureConfigError(() => recipe('photo.jpg').convert('webp', { quaity: 1 }));
    expect(err.reason).toBe('unknown_field');
  });

  it('a thumbnail with one or no dimension COMPILES (both optional in the contract)', () => {
    // Positive controls: a regression that made either dimension required again
    // would surface here as a plain tsc error under `npm run check:tests`.
    const widthOnly: ThumbnailOptions = { width: 1 };
    const heightOnly: ThumbnailOptions = { height: 1 };
    const neither: ThumbnailOptions = {};
    expect(() => recipe('photo.jpg').thumbnail(widthOnly).thumbnail(heightOnly).thumbnail(neither)).not.toThrow();
  });

  it('an unknown thumbnail key is still a compile error for typed callers', () => {
    // @ts-expect-error unknown key 'nope' is rejected by ThumbnailOptions
    const err = captureConfigError(() => recipe('photo.jpg').thumbnail({ width: 1, nope: 1 }));
    expect(err.reason).toBe('unknown_field');
  });
});
