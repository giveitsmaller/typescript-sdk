// T4a — DocumentOdfCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: ODF = 2 fields + quality
//   (stripMetadata, stripUnusedStyles). Primitives only.

// f3JiTxkK adds `quality` (1-100), the one STABLE document compress option;
// the strip_* fields beside it are `planned` in the contract.

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';

export interface DocumentOdfCompressPresetOptionsInput {
  readonly stripMetadata?: boolean;
  readonly stripUnusedStyles?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;
}

export class DocumentOdfCompressPresetOptions {
  readonly stripMetadata?: boolean;
  readonly stripUnusedStyles?: boolean;
  /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
  readonly quality?: number;

  private constructor(input: DocumentOdfCompressPresetOptionsInput) {
    if (input.stripMetadata !== undefined) this.stripMetadata = input.stripMetadata;
    if (input.stripUnusedStyles !== undefined) this.stripUnusedStyles = input.stripUnusedStyles;
    if (input.quality !== undefined) this.quality = input.quality;
    Object.freeze(this);
  }

  static from(input: DocumentOdfCompressPresetOptionsInput): DocumentOdfCompressPresetOptions {
    return new DocumentOdfCompressPresetOptions(input);
  }

  static shippedDefaultsFor(level: OptimizeFor): DocumentOdfCompressPresetOptions {
    const cell = f3ShippedDefaultsFor('document_odf_compress', level);
    const input: DocumentOdfCompressPresetOptionsInput = {};
    const mut = input as Record<string, unknown>;
    if ('stripMetadata' in cell) mut.stripMetadata = cell.stripMetadata as boolean;
    if ('stripUnusedStyles' in cell) mut.stripUnusedStyles = cell.stripUnusedStyles as boolean;
    if ('quality' in cell) mut.quality = cell.quality as number;
    return new DocumentOdfCompressPresetOptions(input);
  }
}
