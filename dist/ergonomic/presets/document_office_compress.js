// T4a — DocumentOfficeCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: office = 4 fields
//   (imageQuality, stripMacros, stripHiddenData, stripUnusedFonts).
// All primitive values — no enum translation needed.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentOfficeCompressPresetOptions {
    imageQuality;
    stripMacros;
    stripHiddenData;
    stripUnusedFonts;
    constructor(input) {
        if (input.imageQuality !== undefined)
            this.imageQuality = input.imageQuality;
        if (input.stripMacros !== undefined)
            this.stripMacros = input.stripMacros;
        if (input.stripHiddenData !== undefined)
            this.stripHiddenData = input.stripHiddenData;
        if (input.stripUnusedFonts !== undefined)
            this.stripUnusedFonts = input.stripUnusedFonts;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentOfficeCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_office_compress', level);
        const input = {};
        const mut = input;
        if ('imageQuality' in cell)
            mut.imageQuality = cell.imageQuality;
        if ('stripMacros' in cell)
            mut.stripMacros = cell.stripMacros;
        if ('stripHiddenData' in cell)
            mut.stripHiddenData = cell.stripHiddenData;
        if ('stripUnusedFonts' in cell)
            mut.stripUnusedFonts = cell.stripUnusedFonts;
        return new DocumentOfficeCompressPresetOptions(input);
    }
}
