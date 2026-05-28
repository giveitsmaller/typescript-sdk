// T4a — ImageCompressPresetOptions leaf DTO.
//
// Sparse delta over the wire `CompressImageOptions` surface. Every field
// is optional + readonly; an unset field means "fall through to the next
// layer" (shipped defaults / user delta / per-call override). Mapped via
// the ergonomic enum types from `../../generated/sdk_spec/enums.ts`, whose
// values ARE the wire backing values — so the leaf DTO is wire-compatible
// once the resolver (T4b) snake_cases the property names.
//
// Field set per ticket VhIj4S7T (codex r3 lock): image = 10 fields
//   (mode, quality, width, height, fit, metadata, iccProfile, autoOrient,
//    progressive, outputFormat).
// Trim / per-call knobs are deliberately excluded — they belong on the
// per-call argument shape, not the preset cell.

import {
  ImageMode,
  ImageFit,
  ImageMetadataPolicy,
  IccProfilePolicy,
  ImageFormat,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface ImageCompressPresetOptionsInput {
  readonly mode?: ImageMode;
  readonly quality?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly metadata?: ImageMetadataPolicy;
  readonly iccProfile?: IccProfilePolicy;
  readonly autoOrient?: boolean;
  readonly progressive?: boolean;
  readonly outputFormat?: ImageFormat;
}

export class ImageCompressPresetOptions {
  readonly mode?: ImageMode;
  readonly quality?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly metadata?: ImageMetadataPolicy;
  readonly iccProfile?: IccProfilePolicy;
  readonly autoOrient?: boolean;
  readonly progressive?: boolean;
  readonly outputFormat?: ImageFormat;

  private constructor(input: ImageCompressPresetOptionsInput) {
    if (input.mode !== undefined) this.mode = input.mode;
    if (input.quality !== undefined) this.quality = input.quality;
    if (input.width !== undefined) this.width = input.width;
    if (input.height !== undefined) this.height = input.height;
    if (input.fit !== undefined) this.fit = input.fit;
    if (input.metadata !== undefined) this.metadata = input.metadata;
    if (input.iccProfile !== undefined) this.iccProfile = input.iccProfile;
    if (input.autoOrient !== undefined) this.autoOrient = input.autoOrient;
    if (input.progressive !== undefined) this.progressive = input.progressive;
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
   * Note for OptimizeFor.Quality: the F3 PRESETS cell deliberately
   * omits `quality` because the contract has `depends_on: { mode: lossy }`
   * on the quality field — under `mode: Lossless` the API ignores
   * `quality`, so shipping a default would mislead callers.
   */
  static shippedDefaultsFor(level: OptimizeFor): ImageCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('image_compress', level);
    const input: ImageCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('mode' in cell) mut.mode = translateEnum('ImageMode', cell.mode as string);
    if ('quality' in cell) mut.quality = cell.quality as number;
    if ('width' in cell) mut.width = cell.width as number;
    if ('height' in cell) mut.height = cell.height as number;
    if ('fit' in cell) mut.fit = translateEnum('ImageFit', cell.fit as string);
    if ('metadata' in cell) mut.metadata = translateEnum('ImageMetadataPolicy', cell.metadata as string);
    if ('iccProfile' in cell) mut.iccProfile = translateEnum('IccProfilePolicy', cell.iccProfile as string);
    if ('autoOrient' in cell) mut.autoOrient = cell.autoOrient as boolean;
    if ('progressive' in cell) mut.progressive = cell.progressive as boolean;
    if ('outputFormat' in cell) mut.outputFormat = translateEnum('ImageFormat', cell.outputFormat as string);
    return new ImageCompressPresetOptions(input);
  }
}
