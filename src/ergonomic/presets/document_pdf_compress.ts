// DocumentPdfCompressPresetOptions leaf DTO (oavTfC6C).
//
// Field set per contracts compress.yaml `document_pdf` (beta): quality +
// max_image_dimension. Both act on the IMAGES inside the PDF. Primitives only.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentPdfCompressPresetOptionsInput {
  /** JPEG quality 1-100 for images inside the PDF (contract default 70). */
  readonly quality?: number;
  /** Longest side in px for images inside the PDF, 64-10000 (contract default 1600). */
  readonly maxImageDimension?: number;
}

export class DocumentPdfCompressPresetOptions {
  /** JPEG quality 1-100 for images inside the PDF (contract default 70). */
  readonly quality?: number;
  /** Longest side in px for images inside the PDF, 64-10000 (contract default 1600). */
  readonly maxImageDimension?: number;

  private constructor(input: DocumentPdfCompressPresetOptionsInput) {
    if (input.quality !== undefined) this.quality = input.quality;
    if (input.maxImageDimension !== undefined) this.maxImageDimension = input.maxImageDimension;
    Object.freeze(this);
  }

  static from(input: DocumentPdfCompressPresetOptionsInput): DocumentPdfCompressPresetOptions {
    return new DocumentPdfCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentPdfCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_pdf_compress', level);
    const input: DocumentPdfCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('quality' in cell) mut.quality = cell.quality as number;
    if ('maxImageDimension' in cell) mut.maxImageDimension = cell.maxImageDimension as number;
    return new DocumentPdfCompressPresetOptions(input);
  }
}
