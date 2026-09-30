// T4a — DocumentEpubCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: EPUB = 2 fields + quality
//   (fontSubsetting, stripUnusedCss). Primitives only.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentEpubCompressPresetOptions {
    fontSubsetting;
    stripUnusedCss;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    quality;
    constructor(input) {
        if (input.fontSubsetting !== undefined)
            this.fontSubsetting = input.fontSubsetting;
        if (input.stripUnusedCss !== undefined)
            this.stripUnusedCss = input.stripUnusedCss;
        if (input.quality !== undefined)
            this.quality = input.quality;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentEpubCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_epub_compress', level);
        const input = {};
        const mut = input;
        if ('fontSubsetting' in cell)
            mut.fontSubsetting = cell.fontSubsetting;
        if ('stripUnusedCss' in cell)
            mut.stripUnusedCss = cell.stripUnusedCss;
        if ('quality' in cell)
            mut.quality = cell.quality;
        return new DocumentEpubCompressPresetOptions(input);
    }
}
