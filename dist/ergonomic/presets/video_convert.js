// VideoConvertPresetOptions leaf DTO (f5ti3pik).
//
// Field set per contracts convert.yaml `video`: crf only (convert.video has no `preset`).
// Primitives only.
//
// NOT YET CONSUMED: presetDefaults() and optimize do not read this class;
// cellFor/merge stay compress-only. The wiring is card uUSSVNJA.
//
// DRAFT VALUES: the shipped cells are DRAFT per contracts v2.234.0 -
// "a coherent ladder, not measured".
//
// GIF: an explicit `crf` on a `gif` output is REJECTED by the contract
// (invalid_options at workflow-create). The uUSSVNJA resolver must drop `crf`
// when the output format is gif; this DTO carries it unconditionally.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
export class VideoConvertPresetOptions {
    /** Constant Rate Factor 0-51, lower = better (draft ladder 30 / 23 / 18). */
    crf;
    constructor(input) {
        if (input.crf !== undefined)
            this.crf = input.crf;
        Object.freeze(this);
    }
    static from(input) {
        return new VideoConvertPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('video_convert', level);
        const input = {};
        const mut = input;
        if ('crf' in cell)
            mut.crf = cell.crf;
        return new VideoConvertPresetOptions(input);
    }
}
