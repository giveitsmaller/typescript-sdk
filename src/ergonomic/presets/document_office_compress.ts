// T4a — DocumentOfficeCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: office = 3 fields + quality
//   (stripMacros, stripHiddenData, stripUnusedFonts).
// All primitive values — no enum translation needed.

// f3JiTxkK adds `quality` (1-100), the one STABLE document compress option;
// the strip_* fields beside it are `planned` in the contract.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentOfficeCompressPresetOptionsInput {
  readonly stripMacros?: boolean;
  readonly stripHiddenData?: boolean;
  readonly stripUnusedFonts?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;
}

export class DocumentOfficeCompressPresetOptions {
  readonly stripMacros?: boolean;
  readonly stripHiddenData?: boolean;
  readonly stripUnusedFonts?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;

  private constructor(input: DocumentOfficeCompressPresetOptionsInput) {
    if (input.stripMacros !== undefined) this.stripMacros = input.stripMacros;
    if (input.stripHiddenData !== undefined) this.stripHiddenData = input.stripHiddenData;
    if (input.stripUnusedFonts !== undefined) this.stripUnusedFonts = input.stripUnusedFonts;
    if (input.quality !== undefined) this.quality = input.quality;
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
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new DocumentOfficeCompressPresetOptions(input);
  }
}
