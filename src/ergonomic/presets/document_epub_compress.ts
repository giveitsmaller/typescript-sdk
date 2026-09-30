// T4a — DocumentEpubCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: EPUB = 2 fields + quality
//   (fontSubsetting, stripUnusedCss). Primitives only.

// f3JiTxkK adds `quality` (1-100), the one STABLE document compress option;
// the strip_* fields beside it are `planned` in the contract.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentEpubCompressPresetOptionsInput {
  readonly fontSubsetting?: boolean;
  readonly stripUnusedCss?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;
}

export class DocumentEpubCompressPresetOptions {
  readonly fontSubsetting?: boolean;
  readonly stripUnusedCss?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;

  private constructor(input: DocumentEpubCompressPresetOptionsInput) {
    if (input.fontSubsetting !== undefined) this.fontSubsetting = input.fontSubsetting;
    if (input.stripUnusedCss !== undefined) this.stripUnusedCss = input.stripUnusedCss;
    if (input.quality !== undefined) this.quality = input.quality;
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
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new DocumentEpubCompressPresetOptions(input);
  }
}
