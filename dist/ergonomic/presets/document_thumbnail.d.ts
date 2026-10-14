import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentThumbnailPresetOptionsInput {
    /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
    readonly width?: number;
    /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
    readonly quality?: number;
}
export declare class DocumentThumbnailPresetOptions {
    /** Target width in px, 1-16384 (draft ladder 160 / 320 / 640). */
    readonly width?: number;
    /** Output quality 1-100 for the thumbnail (draft ladder 70 / 85 / 92). */
    readonly quality?: number;
    private constructor();
    static from(input: DocumentThumbnailPresetOptionsInput): DocumentThumbnailPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentThumbnailPresetOptions;
}
