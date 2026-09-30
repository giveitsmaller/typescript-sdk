// T4a — DocumentOdfCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: ODF = 2 fields + quality
//   (stripMetadata, stripUnusedStyles). Primitives only.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentOdfCompressPresetOptions {
    stripMetadata;
    stripUnusedStyles;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    quality;
    constructor(input) {
        if (input.stripMetadata !== undefined)
            this.stripMetadata = input.stripMetadata;
        if (input.stripUnusedStyles !== undefined)
            this.stripUnusedStyles = input.stripUnusedStyles;
        if (input.quality !== undefined)
            this.quality = input.quality;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentOdfCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_odf_compress', level);
        const input = {};
        const mut = input;
        if ('stripMetadata' in cell)
            mut.stripMetadata = cell.stripMetadata;
        if ('stripUnusedStyles' in cell)
            mut.stripUnusedStyles = cell.stripUnusedStyles;
        if ('quality' in cell)
            mut.quality = cell.quality;
        return new DocumentOdfCompressPresetOptions(input);
    }
}
