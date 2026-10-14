import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface VideoConvertPresetOptionsInput {
    /** Constant Rate Factor 0-51, lower = better (draft ladder 30 / 23 / 18). */
    readonly crf?: number;
}
export declare class VideoConvertPresetOptions {
    /** Constant Rate Factor 0-51, lower = better (draft ladder 30 / 23 / 18). */
    readonly crf?: number;
    private constructor();
    static from(input: VideoConvertPresetOptionsInput): VideoConvertPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): VideoConvertPresetOptions;
}
