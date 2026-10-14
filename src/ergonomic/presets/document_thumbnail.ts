// DocumentThumbnailPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts thumbnail.yaml `document`: width + quality (`format` deliberately unset).
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentThumbnailPresetOptionsInput {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;
}

export class DocumentThumbnailPresetOptions {
  /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
  readonly width?: number;
  /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
  readonly quality?: number;

  private constructor(input: DocumentThumbnailPresetOptionsInput) {
    if (input.width !== undefined) this.width = input.width;
    if (input.quality !== undefined) this.quality = input.quality;
    Object.freeze(this);
  }

  static from(input: DocumentThumbnailPresetOptionsInput): DocumentThumbnailPresetOptions {
    return new DocumentThumbnailPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentThumbnailPresetOptions {
    const cell = f3ShippedDefaultsFor('document_thumbnail', level);
    const input: DocumentThumbnailPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('width' in cell) mut.width = cell.width as number;
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new DocumentThumbnailPresetOptions(input);
  }
}
