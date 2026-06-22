// T4a — DocumentPdfCompressPresetOptions leaf DTO.
//
// Field set (2): profile, grayscale — the worker-honored stable PDF controls
// (contracts v2.96.0 Acrobat-PDF realignment Lw1LseYr). The earlier
// {profile, colorspace, flattenForms} set was retired: colorspace + flatten_forms
// are `planned` (not read by the worker) so presets never emit them, and
// `image_dpi` + `pages` are per-call knobs, not preset cells.

import {
  PdfProfile,
  OptimizeFor,
} from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';

export interface DocumentPdfCompressPresetOptionsInput {
  readonly profile?: PdfProfile;
  readonly grayscale?: boolean;
}

export class DocumentPdfCompressPresetOptions {
  readonly profile?: PdfProfile;
  readonly grayscale?: boolean;

  private constructor(input: DocumentPdfCompressPresetOptionsInput) {
    if (input.profile !== undefined) this.profile = input.profile;
    if (input.grayscale !== undefined) this.grayscale = input.grayscale;
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
    if ('grayscale' in cell) mut.grayscale = cell.grayscale as boolean;
    return new DocumentPdfCompressPresetOptions(input);
  }
}
