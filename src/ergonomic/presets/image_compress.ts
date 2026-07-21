// T4a — ImageCompressPresetOptions leaf DTO.
//
// Sparse delta over the wire `CompressImageOptions` surface. Every field
// is optional + readonly; an unset field means "fall through to the next
// layer" (shipped defaults / user delta / per-call override). Mapped via
// the ergonomic enum types from `../../generated/sdk_spec/enums.ts`, whose
// values ARE the wire backing values — so the leaf DTO is wire-compatible
// once the resolver (T4b) snake_cases the property names.
//
// Field set (3) per contracts v2.80.0 compress.image honesty pass (Option B,
//   lossy-only): image = (quality, metadata, outputFormat).
// `mode` + `iccProfile` were REMOVED — the worker is lossy-only and always
// strips metadata, so advertising a lossless mode or ICC-profile policy was
// an over-claim. `progressive` is still a per-JPEG wire option but is no
// longer carried in the preset cell.
//
// `width`/`height`/`fit`/`autoOrient` were removed earlier on the grounds that
// "the image-compress worker never resized". CAREFUL — that is still true of
// the Rust optimiser crate and NOT true end-to-end. Since contract v2.97.0
// ("resize lives inside Output") the API canonicalises an image compress
// carrying width/height/fit into a `convert` op, and convert IS the resize
// engine, so such a request returns a genuinely resized file. Their absence
// here is therefore a SURFACE choice, not a capability limit: resize is
// expressed via `output()` (see `OutputOptions`), which the compress
// conformance gate records as CROSS_VERB_ROUTING and self-verifies. Reading
// this comment as "unsupported" is what produced cySAEZHR. Whether compress()
// should ALSO carry them is an open ergonomic-expansion decision, not a bug.
//
// Per-call knobs are deliberately excluded — they belong on the per-call
// argument shape.

import {
  ImageMetadataPolicy,
  ImageFormat,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface ImageCompressPresetOptionsInput {
  readonly quality?: number;
  readonly metadata?: ImageMetadataPolicy;
  readonly outputFormat?: ImageFormat;
}

export class ImageCompressPresetOptions {
  readonly quality?: number;
  readonly metadata?: ImageMetadataPolicy;
  readonly outputFormat?: ImageFormat;

  private constructor(input: ImageCompressPresetOptionsInput) {
    if (input.quality !== undefined) this.quality = input.quality;
    if (input.metadata !== undefined) this.metadata = input.metadata;
    if (input.outputFormat !== undefined) this.outputFormat = input.outputFormat;
    Object.freeze(this);
  }

  /**
   * Construct a leaf DTO from a sparse caller-supplied delta. Fields the
   * caller omits stay undefined on the instance — they are NOT filled
   * from shipped defaults here (the resolver in T4b merges layers).
   */
  static from(input: ImageCompressPresetOptionsInput): ImageCompressPresetOptions {
    return new ImageCompressPresetOptions(input);
  }

  /**
   * Return the SDK shipped defaults for the (image, compress) cell at
   * the given level. Reads the F3 PRESETS matrix and translates member
   * names to wire backing values.
   *
   * Since the v2.80.0 honesty pass the worker is lossy-only, so every
   * level ships a concrete `quality` (Size 65 / Balanced 80 / Quality 92),
   * `metadata: All`, and `outputFormat: Original`.
   */
  static shippedDefaultsFor(level: OptimizeFor): ImageCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('image_compress', level);
    const input: ImageCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('quality' in cell) mut.quality = cell.quality as number;
    if ('metadata' in cell) mut.metadata = translateEnum('ImageMetadataPolicy', cell.metadata as string);
    if ('outputFormat' in cell) mut.outputFormat = translateEnum('ImageFormat', cell.outputFormat as string);
    return new ImageCompressPresetOptions(input);
  }
}
