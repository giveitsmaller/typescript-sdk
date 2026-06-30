// T4a — DocumentEpubCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: EPUB = 2 fields
//   (fontSubsetting, stripUnusedCss). Primitives only.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentEpubCompressPresetOptionsInput {
  readonly fontSubsetting?: boolean;
  readonly stripUnusedCss?: boolean;
}

export class DocumentEpubCompressPresetOptions {
  readonly fontSubsetting?: boolean;
  readonly stripUnusedCss?: boolean;

  private constructor(input: DocumentEpubCompressPresetOptionsInput) {
    if (input.fontSubsetting !== undefined) this.fontSubsetting = input.fontSubsetting;
    if (input.stripUnusedCss !== undefined) this.stripUnusedCss = input.stripUnusedCss;
    Object.freeze(this);
  }

  static from(input: DocumentEpubCompressPresetOptionsInput): DocumentEpubCompressPresetOptions {
    return new DocumentEpubCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentEpubCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_epub_compress', level);
    const input: DocumentEpubCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('fontSubsetting' in cell) mut.fontSubsetting = cell.fontSubsetting as boolean;
    if ('stripUnusedCss' in cell) mut.stripUnusedCss = cell.stripUnusedCss as boolean;
    return new DocumentEpubCompressPresetOptions(input);
  }
}
