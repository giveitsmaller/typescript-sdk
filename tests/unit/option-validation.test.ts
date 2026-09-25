import { describe, it, expect } from 'vitest';

import {
  validateVerbOptions,
  validateSingleOpConvertOptions,
  assertThumbnailDimensions,
  type ValidatedVerb,
} from '../../src/ergonomic/option_validation.js';
import { GislConfigError } from '../../src/errors.js';
import { MergedRecipe, Recipe, fileInput } from '../../src/file-first.js';

/**
 * Dhje3Faq — eager, synchronous, PRE-UPLOAD option-key validation for the
 * ergonomic verbs (`convert` / `thumbnail` / `textWatermark` / `watermark`).
 * `validateVerbOptions` rejects (1) a positional-owned key supplied in the bag
 * (`output_format` / `format` on convert; `text` on textWatermark) and (2) any
 * key absent from the op's contract option set — both with
 * `GislConfigError(reason: 'unknown_field')`. `assertThumbnailDimensions`
 * additionally rejects a missing/undefined width or height with
 * `reason: 'missing_required_field'`. The allowed key sets are read from the
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
    expect(err.message).toContain('first argument');
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
    expect(err.message).toContain('first argument');
  });

  it('the positional-owned check fires BEFORE the generic unknown-key check', () => {
    // A bag with BOTH a positional-owned key and a typo must report the
    // positional-owned one first (it is checked first), with the actionable
    // "first argument" message rather than the generic "unknown option" one.
    const err = captureConfigError(() =>
      validateVerbOptions('convert', { output_format: 'webm', quaity: 1 }),
    );
    expect(err.conflictingFields).toEqual(['output_format']);
    expect(err.message).toContain('first argument');
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
// assertThumbnailDimensions — both dims required.
// ---------------------------------------------------------------------------

describe('assertThumbnailDimensions', () => {
  it('passes when both width and height are present', () => {
    expect(() => assertThumbnailDimensions({ width: 10, height: 10 })).not.toThrow();
  });

  it('throws missing_required_field naming height when height is absent', () => {
    const err = captureConfigError(() => assertThumbnailDimensions({ width: 10 }));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['height']);
    expect(err.message).toContain('missing: height');
  });

  it('throws missing_required_field naming width when width is absent', () => {
    const err = captureConfigError(() => assertThumbnailDimensions({ height: 10 }));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['width']);
  });

  it('throws naming BOTH dims when both are absent', () => {
    const err = captureConfigError(() => assertThumbnailDimensions({}));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['width', 'height']);
  });

  it('treats a nullish bag (untyped JS caller, no arg) as both dims absent — clean error, not a TypeError', () => {
    const err = captureConfigError(() => assertThumbnailDimensions(undefined));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['width', 'height']);
  });

  it('thumbnail() called with NO argument (JS caller) throws a clean GislConfigError, not a raw TypeError', () => {
    // The typed signature requires `{ width, height }`, but an untyped JS caller
    // can omit the argument entirely. The verb must surface a clean, pre-upload
    // GislConfigError — captureConfigError re-throws anything that is NOT one
    // (e.g. a TypeError), so this fails if the nullish bag is unhandled.
    const callNoArg = recipe('photo.jpg').thumbnail as (opts?: unknown) => unknown;
    const err = captureConfigError(() => callNoArg());
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['width', 'height']);
  });

  it('treats an explicit undefined as absent (the JS-caller bypass)', () => {
    const err = captureConfigError(() =>
      assertThumbnailDimensions({ width: 10, height: undefined }),
    );
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['height']);
  });

  it('treats an explicit null as absent too (PHP-lockstep: PHP drops null pre-lower)', () => {
    // TS rejects `null` as well as `undefined` so a null dimension is a
    // pre-upload error in BOTH languages, never a wire `null` that 422s.
    const err = captureConfigError(() =>
      assertThumbnailDimensions({ width: null, height: 1 }),
    );
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['width']);
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

  it('thumbnail missing a dimension throws synchronously at the verb call', () => {
    const err = captureConfigError(() => recipe('photo.jpg').thumbnail({ width: 320 } as never));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toContain('height');
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
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toContain('height');
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

  it('MergedRecipe.thumbnail({ width }) rejects the missing height', () => {
    const err = captureConfigError(() => videoMerge().thumbnail({ width: 320 } as never));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toContain('height');
  });

  it('WatermarkedRecipe.convert with a typo throws unknown_field', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay()).convert('webp', { quaity: 1 } as never),
    );
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['quaity']);
  });

  it('WatermarkedRecipe.thumbnail({ width }) rejects the missing height', () => {
    const err = captureConfigError(() =>
      recipe('photo.jpg').watermark(overlay()).thumbnail({ width: 320 } as never),
    );
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toContain('height');
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

// ---------------------------------------------------------------------------
// validateSingleOpConvertOptions — the single-op convert guard (ExVcchMz).
// DISTINCT from validateVerbOptions('convert'): the single-op builder has no
// positional format, so it ALLOWS + REQUIRES `output_format` in the bag while
// rejecting unknown keys and the `format` alias. Mirrors the PHP
// `OptionValidationTest` single-op convert cases — keep in lockstep.
// ---------------------------------------------------------------------------

describe('validateSingleOpConvertOptions (single-op convert; ExVcchMz)', () => {
  it('accepts output_format + contract keys', () => {
    expect(() => validateSingleOpConvertOptions({ output_format: 'webp', quality: 80 })).not.toThrow();
  });

  it('rejects a missing output_format', () => {
    const err = captureConfigError(() => validateSingleOpConvertOptions({ quality: 80 }));
    expect(err.reason).toBe('missing_required_field');
    expect(err.conflictingFields).toEqual(['output_format']);
  });

  it('rejects a null output_format', () => {
    const err = captureConfigError(() => validateSingleOpConvertOptions({ output_format: null }));
    expect(err.reason).toBe('missing_required_field');
  });

  it('rejects an unknown key', () => {
    const err = captureConfigError(() => validateSingleOpConvertOptions({ output_format: 'webp', bogus: 1 }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['bogus']);
  });

  it('rejects the `format` alias (single-op needs the wire key output_format)', () => {
    const err = captureConfigError(() => validateSingleOpConvertOptions({ format: 'webp' }));
    expect(err.reason).toBe('unknown_field');
    expect(err.conflictingFields).toEqual(['format']);
  });
});

describe('typed-interface documentation (compile-time intent)', () => {
  it('an unknown convert key is a compile error for typed callers', () => {
    // @ts-expect-error unknown key 'quaity' is rejected by ConvertOptions
    const err = captureConfigError(() => recipe('photo.jpg').convert('webp', { quaity: 1 }));
    expect(err.reason).toBe('unknown_field');
  });

  it('a thumbnail missing height is a compile error for typed callers', () => {
    // @ts-expect-error ThumbnailOptions requires both width and height
    const err = captureConfigError(() => recipe('photo.jpg').thumbnail({ width: 1 }));
    expect(err.reason).toBe('missing_required_field');
  });
});
