// T4a — DocumentEpubCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: EPUB = 3 fields
//   (imageQuality, fontSubsetting, stripUnusedCss). Primitives only.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentEpubCompressPresetOptions {
    imageQuality;
    fontSubsetting;
    stripUnusedCss;
    constructor(input) {
        if (input.imageQuality !== undefined)
            this.imageQuality = input.imageQuality;
        if (input.fontSubsetting !== undefined)
            this.fontSubsetting = input.fontSubsetting;
        if (input.stripUnusedCss !== undefined)
            this.stripUnusedCss = input.stripUnusedCss;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentEpubCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_epub_compress', level);
        const input = {};
        const mut = input;
        if ('imageQuality' in cell)
            mut.imageQuality = cell.imageQuality;
        if ('fontSubsetting' in cell)
            mut.fontSubsetting = cell.fontSubsetting;
        if ('stripUnusedCss' in cell)
            mut.stripUnusedCss = cell.stripUnusedCss;
        return new DocumentEpubCompressPresetOptions(input);
    }
}
