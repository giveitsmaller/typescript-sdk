// DocumentThumbnailPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts thumbnail.yaml `document`: width + quality (`format` deliberately unset).
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class DocumentThumbnailPresetOptions {
    /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
    width;
    /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
    quality;
    constructor(input) {
        if (input.width !== undefined)
            this.width = input.width;
        if (input.quality !== undefined)
            this.quality = input.quality;
        Object.freeze(this);
    }
    static from(input) {
        return new DocumentThumbnailPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('document_thumbnail', level);
        const input = {};
        const mut = input;
        if ('width' in cell)
            mut.width = cell.width;
        if ('quality' in cell)
            mut.quality = cell.quality;
        return new DocumentThumbnailPresetOptions(input);
    }
}
