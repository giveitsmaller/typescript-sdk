// T4a — DocumentOdfCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: ODF = 3 fields
//   (imageQuality, stripMetadata, stripUnusedStyles). Primitives only.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentOdfCompressPresetOptionsInput {
  readonly imageQuality?: number;
  readonly stripMetadata?: boolean;
  readonly stripUnusedStyles?: boolean;
}

export class DocumentOdfCompressPresetOptions {
  readonly imageQuality?: number;
  readonly stripMetadata?: boolean;
  readonly stripUnusedStyles?: boolean;

  private constructor(input: DocumentOdfCompressPresetOptionsInput) {
    if (input.imageQuality !== undefined) this.imageQuality = input.imageQuality;
    if (input.stripMetadata !== undefined) this.stripMetadata = input.stripMetadata;
    if (input.stripUnusedStyles !== undefined) this.stripUnusedStyles = input.stripUnusedStyles;
    Object.freeze(this);
  }

  static from(input: DocumentOdfCompressPresetOptionsInput): DocumentOdfCompressPresetOptions {
    return new DocumentOdfCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentOdfCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_odf_compress', level);
    const input: DocumentOdfCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('imageQuality' in cell) mut.imageQuality = cell.imageQuality as number;
    if ('stripMetadata' in cell) mut.stripMetadata = cell.stripMetadata as boolean;
    if ('stripUnusedStyles' in cell) mut.stripUnusedStyles = cell.stripUnusedStyles as boolean;
    return new DocumentOdfCompressPresetOptions(input);
  }
}
