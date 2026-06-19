import { VideoCodec, VideoPreset, VideoFit, AudioCodec, AudioBitrate, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface VideoCompressPresetOptionsInput {
    readonly codec?: VideoCodec;
    readonly targetSize?: string | number;
    readonly crf?: number;
    readonly preset?: VideoPreset;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly fps?: number;
    readonly faststart?: boolean;
    readonly audioCodec?: AudioCodec;
    readonly audioBitrate?: AudioBitrate;
}
export declare class VideoCompressPresetOptions {
    readonly codec?: VideoCodec;
    readonly targetSize?: string | number;
    readonly crf?: number;
    readonly preset?: VideoPreset;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly fps?: number;
    readonly faststart?: boolean;
    readonly audioCodec?: AudioCodec;
    readonly audioBitrate?: AudioBitrate;
    private constructor();
    static from(input: VideoCompressPresetOptionsInput): VideoCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): VideoCompressPresetOptions;
}
