// T4a — DocumentPdfCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: PDF = 3 fields (profile, colorspace, flattenForms).
// Deliberately excluded: `pages` (per-call content selection).

import {
  PdfProfile,
  PdfColorspace,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface DocumentPdfCompressPresetOptionsInput {
  readonly profile?: PdfProfile;
  readonly colorspace?: PdfColorspace;
  readonly flattenForms?: boolean;
}

export class DocumentPdfCompressPresetOptions {
  readonly profile?: PdfProfile;
  readonly colorspace?: PdfColorspace;
  readonly flattenForms?: boolean;

  private constructor(input: DocumentPdfCompressPresetOptionsInput) {
    if (input.profile !== undefined) this.profile = input.profile;
    if (input.colorspace !== undefined) this.colorspace = input.colorspace;
    if (input.flattenForms !== undefined) this.flattenForms = input.flattenForms;
    Object.freeze(this);
  }

  static from(input: DocumentPdfCompressPresetOptionsInput): DocumentPdfCompressPresetOptions {
    return new DocumentPdfCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentPdfCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_pdf_compress', level);
    const input: DocumentPdfCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('profile' in cell) mut.profile = translateEnum('PdfProfile', cell.profile as string);
    if ('colorspace' in cell) mut.colorspace = translateEnum('PdfColorspace', cell.colorspace as string);
    if ('flattenForms' in cell) mut.flattenForms = cell.flattenForms as boolean;
    return new DocumentPdfCompressPresetOptions(input);
  }
}
