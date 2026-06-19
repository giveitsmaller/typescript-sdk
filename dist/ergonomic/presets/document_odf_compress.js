// T4a — DocumentOdfCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: ODF = 3 fields
//   (imageQuality, stripMetadata, stripUnusedStyles). Primitives only.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentOdfCompressPresetOptions {
    imageQuality;
    stripMetadata;
    stripUnusedStyles;
    constructor(input) {
        if (input.imageQuality !== undefined)
            this.imageQuality = input.imageQuality;
        if (input.stripMetadata !== undefined)
            this.stripMetadata = input.stripMetadata;
        if (input.stripUnusedStyles !== undefined)
            this.stripUnusedStyles = input.stripUnusedStyles;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentOdfCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_odf_compress', level);
        const input = {};
        const mut = input;
        if ('imageQuality' in cell)
            mut.imageQuality = cell.imageQuality;
        if ('stripMetadata' in cell)
            mut.stripMetadata = cell.stripMetadata;
        if ('stripUnusedStyles' in cell)
            mut.stripUnusedStyles = cell.stripUnusedStyles;
        return new DocumentOdfCompressPresetOptions(input);
    }
}
