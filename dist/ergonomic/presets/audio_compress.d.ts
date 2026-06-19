import { AudioBitrate, AudioSampleRate, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface AudioCompressPresetOptionsInput {
    readonly bitrate?: AudioBitrate;
    readonly channels?: number;
    readonly sampleRate?: AudioSampleRate;
    readonly normalize?: boolean;
}
export declare class AudioCompressPresetOptions {
    readonly bitrate?: AudioBitrate;
    readonly channels?: number;
    readonly sampleRate?: AudioSampleRate;
    readonly normalize?: boolean;
    private constructor();
    static from(input: AudioCompressPresetOptionsInput): AudioCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): AudioCompressPresetOptions;
}
