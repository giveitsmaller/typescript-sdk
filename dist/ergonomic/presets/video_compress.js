// T4a — VideoCompressPresetOptions leaf DTO.
//
// Field set per ticket VhIj4S7T: video = 11 fields
//   (codec, targetSize, crf, preset, width, height, fit, fps, faststart,
//    audioCodec, audioBitrate).
// Deliberately excluded: encodingMode + targetSizeBytes (raw wire —
// replaced by ergonomic `targetSize: string|number` which the SDK derives
// at resolve time in T4b), trim_start/trim_end (per-call content selection).
//
// `targetSize` accepts `string` (e.g. "50MB") or `number` (bytes). The
// resolver in T4b converts to the wire `target_size_bytes` and sets
// `encoding_mode: target_size` accordingly.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';
export class VideoCompressPresetOptions {
    codec;
    targetSize;
    crf;
    preset;
    width;
    height;
    fit;
    fps;
    faststart;
    audioCodec;
    audioBitrate;
    constructor(input) {
        if (input.codec !== undefined)
            this.codec = input.codec;
        if (input.targetSize !== undefined)
            this.targetSize = input.targetSize;
        if (input.crf !== undefined)
            this.crf = input.crf;
        if (input.preset !== undefined)
            this.preset = input.preset;
        if (input.width !== undefined)
            this.width = input.width;
        if (input.height !== undefined)
            this.height = input.height;
        if (input.fit !== undefined)
            this.fit = input.fit;
        if (input.fps !== undefined)
            this.fps = input.fps;
        if (input.faststart !== undefined)
            this.faststart = input.faststart;
        if (input.audioCodec !== undefined)
            this.audioCodec = input.audioCodec;
        if (input.audioBitrate !== undefined)
            this.audioBitrate = input.audioBitrate;
        Object.freeze(this);
    }
    static from(input) {
        return new VideoCompressPresetOptions(input);
    }
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('video_compress', level);
        const input = {};
        const mut = input;
        if ('codec' in cell)
            mut.codec = translateEnum('VideoCodec', cell.codec);
        if ('targetSize' in cell)
            mut.targetSize = cell.targetSize;
        if ('crf' in cell)
            mut.crf = cell.crf;
        if ('preset' in cell)
            mut.preset = translateEnum('VideoPreset', cell.preset);
        if ('width' in cell)
            mut.width = cell.width;
        if ('height' in cell)
            mut.height = cell.height;
        if ('fit' in cell)
            mut.fit = translateEnum('VideoFit', cell.fit);
        if ('fps' in cell)
            mut.fps = cell.fps;
        if ('faststart' in cell)
            mut.faststart = cell.faststart;
        if ('audioCodec' in cell)
            mut.audioCodec = translateEnum('AudioCodec', cell.audioCodec);
        if ('audioBitrate' in cell)
            mut.audioBitrate = translateEnum('AudioBitrate', cell.audioBitrate);
        return new VideoCompressPresetOptions(input);
    }
}
