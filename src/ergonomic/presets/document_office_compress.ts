// T4a — DocumentOfficeCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: office = 3 fields
//   (stripMacros, stripHiddenData, stripUnusedFonts).
// All primitive values — no enum translation needed.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentOfficeCompressPresetOptionsInput {
  readonly stripMacros?: boolean;
  readonly stripHiddenData?: boolean;
  readonly stripUnusedFonts?: boolean;
}

export class DocumentOfficeCompressPresetOptions {
  readonly stripMacros?: boolean;
  readonly stripHiddenData?: boolean;
  readonly stripUnusedFonts?: boolean;

  private constructor(input: DocumentOfficeCompressPresetOptionsInput) {
    if (input.stripMacros !== undefined) this.stripMacros = input.stripMacros;
    if (input.stripHiddenData !== undefined) this.stripHiddenData = input.stripHiddenData;
    if (input.stripUnusedFonts !== undefined) this.stripUnusedFonts = input.stripUnusedFonts;
    Object.freeze(this);
  }

  static from(input: DocumentOfficeCompressPresetOptionsInput): DocumentOfficeCompressPresetOptions {
    return new DocumentOfficeCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentOfficeCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_office_compress', level);
    const input: DocumentOfficeCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('stripMacros' in cell) mut.stripMacros = cell.stripMacros as boolean;
    if ('stripHiddenData' in cell) mut.stripHiddenData = cell.stripHiddenData as boolean;
    if ('stripUnusedFonts' in cell) mut.stripUnusedFonts = cell.stripUnusedFonts as boolean;
    return new DocumentOfficeCompressPresetOptions(input);
  }
}
