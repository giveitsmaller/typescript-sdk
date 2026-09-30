// T4a — DocumentOfficeCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: office = 3 fields + quality
//   (stripMacros, stripHiddenData, stripUnusedFonts).
// All primitive values — no enum translation needed.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentOfficeCompressPresetOptions {
    stripMacros;
    stripHiddenData;
    stripUnusedFonts;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    quality;
    constructor(input) {
        if (input.stripMacros !== undefined)
            this.stripMacros = input.stripMacros;
        if (input.stripHiddenData !== undefined)
            this.stripHiddenData = input.stripHiddenData;
        if (input.stripUnusedFonts !== undefined)
            this.stripUnusedFonts = input.stripUnusedFonts;
        if (input.quality !== undefined)
            this.quality = input.quality;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentOfficeCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_office_compress', level);
        const input = {};
        const mut = input;
        if ('stripMacros' in cell)
            mut.stripMacros = cell.stripMacros;
        if ('stripHiddenData' in cell)
            mut.stripHiddenData = cell.stripHiddenData;
        if ('stripUnusedFonts' in cell)
            mut.stripUnusedFonts = cell.stripUnusedFonts;
        if ('quality' in cell)
            mut.quality = cell.quality;
        return new DocumentOfficeCompressPresetOptions(input);
    }
}
