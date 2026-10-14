import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface ImageConvertPresetOptionsInput {
    /** Output quality 1-100 for lossy targets (draft ladder 65 / 80 / 92). */
    readonly quality?: number;
}
export declare class ImageConvertPresetOptions {
    /** Output quality 1-100 for lossy targets (draft ladder 65 / 80 / 92). */
    readonly quality?: number;
    private constructor();
    static from(input: ImageConvertPresetOptionsInput): ImageConvertPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): ImageConvertPresetOptions;
}
