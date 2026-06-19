// T4a — AudioCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: audio = 4 fields
//   (bitrate, channels, sampleRate, normalize).
// Trim is deliberately excluded — content selection lives on the per-call
// operation argument, not the preset cell.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';
export class AudioCompressPresetOptions {
    bitrate;
    channels;
    sampleRate;
    normalize;
    constructor(input) {
        if (input.bitrate !== undefined)
            this.bitrate = input.bitrate;
        if (input.channels !== undefined)
            this.channels = input.channels;
        if (input.sampleRate !== undefined)
            this.sampleRate = input.sampleRate;
        if (input.normalize !== undefined)
            this.normalize = input.normalize;
        Object.freeze(this);
    }
    static from(input) {
        return new AudioCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('audio_compress', level);
        const input = {};
        const mut = input;
        // bitrate / sampleRate values in PRESETS are member-name strings like
        // "_96" / "_44100"; translateEnum resolves them to the numeric wire
        // value (`AudioBitrate._96 === 96`).
        if ('bitrate' in cell)
            mut.bitrate = translateEnum('AudioBitrate', cell.bitrate);
        if ('channels' in cell)
            mut.channels = cell.channels;
        if ('sampleRate' in cell)
            mut.sampleRate = translateEnum('AudioSampleRate', cell.sampleRate);
        if ('normalize' in cell)
            mut.normalize = cell.normalize;
        return new AudioCompressPresetOptions(input);
    }
}
