// ImageThumbnailPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts thumbnail.yaml `image`: width + quality (`format` deliberately unset).
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface ImageThumbnailPresetOptionsInput {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;
}

export class ImageThumbnailPresetOptions {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;

  private constructor(input: ImageThumbnailPresetOptionsInput) {
    if (input.width !== undefined) this.width = input.width;
    if (input.quality !== undefined) this.quality = input.quality;
    Object.freeze(this);
  }

  static from(input: ImageThumbnailPresetOptionsInput): ImageThumbnailPresetOptions {
    return new ImageThumbnailPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): ImageThumbnailPresetOptions {
    const cell = f3ShippedDefaultsFor('image_thumbnail', level);
    const input: ImageThumbnailPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('width' in cell) mut.width = cell.width as number;
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new ImageThumbnailPresetOptions(input);
  }
}
