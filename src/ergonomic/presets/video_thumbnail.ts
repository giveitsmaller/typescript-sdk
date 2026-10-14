// VideoThumbnailPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts thumbnail.yaml `video`: width + quality (`format` deliberately unset).
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface VideoThumbnailPresetOptionsInput {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;
}

export class VideoThumbnailPresetOptions {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;

  private constructor(input: VideoThumbnailPresetOptionsInput) {
    if (input.width !== undefined) this.width = input.width;
    if (input.quality !== undefined) this.quality = input.quality;
    Object.freeze(this);
  }

  static from(input: VideoThumbnailPresetOptionsInput): VideoThumbnailPresetOptions {
    return new VideoThumbnailPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): VideoThumbnailPresetOptions {
    const cell = f3ShippedDefaultsFor('video_thumbnail', level);
    const input: VideoThumbnailPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('width' in cell) mut.width = cell.width as number;
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new VideoThumbnailPresetOptions(input);
  }
}
