// ImageConvertPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts convert.yaml `image`: quality, honoured on lossy targets (jpeg/webp/avif) only.
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class ImageConvertPresetOptions {
    /** Output quality 1-100 for lossy targets (draft ladder 65 / 80 / 92). */
    quality;
    constructor(input) {
        if (input.quality !== undefined)
            this.quality = input.quality;
        Object.freeze(this);
    }
    static from(input) {
        return new ImageConvertPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('image_convert', level);
        const input = {};
        const mut = input;
        if ('quality' in cell)
            mut.quality = cell.quality;
        return new ImageConvertPresetOptions(input);
    }
}
