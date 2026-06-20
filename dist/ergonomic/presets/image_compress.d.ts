import { ImageMetadataPolicy, ImageFormat, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface ImageCompressPresetOptionsInput {
    readonly quality?: number;
    readonly metadata?: ImageMetadataPolicy;
    readonly outputFormat?: ImageFormat;
}
export declare class ImageCompressPresetOptions {
    readonly quality?: number;
    readonly metadata?: ImageMetadataPolicy;
    readonly outputFormat?: ImageFormat;
    private constructor();
    /**
     * Construct a leaf DTO from a sparse caller-supplied delta. Fields the
     * caller omits stay undefined on the instance — they are NOT filled
     * from shipped defaults here (the resolver in T4b merges layers).
     */
    static from(input: ImageCompressPresetOptionsInput): ImageCompressPresetOptions;
    /**
     * Return the SDK shipped defaults for the (image, compress) cell at
     * the given level. Reads the F3 PRESETS matrix and translates member
     * names to wire backing values.
     *
     * Since the v2.80.0 honesty pass the worker is lossy-only, so every
     * level ships a concrete `quality` (Size 65 / Balanced 80 / Quality 92),
     * `metadata: All`, and `outputFormat: Original`.
     */
    static shippedDefaultsFor(level: OptimizeFor): ImageCompressPresetOptions;
}
