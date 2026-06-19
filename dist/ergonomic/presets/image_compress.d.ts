import { ImageMode, ImageMetadataPolicy, IccProfilePolicy, ImageFormat, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface ImageCompressPresetOptionsInput {
    readonly mode?: ImageMode;
    readonly quality?: number;
    readonly metadata?: ImageMetadataPolicy;
    readonly iccProfile?: IccProfilePolicy;
    readonly progressive?: boolean;
    readonly outputFormat?: ImageFormat;
}
export declare class ImageCompressPresetOptions {
    readonly mode?: ImageMode;
    readonly quality?: number;
    readonly metadata?: ImageMetadataPolicy;
    readonly iccProfile?: IccProfilePolicy;
    readonly progressive?: boolean;
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
     * Note for OptimizeFor.Quality: the F3 PRESETS cell deliberately
     * omits `quality` because the contract has `depends_on: { mode: lossy }`
     * on the quality field — under `mode: Lossless` the API ignores
     * `quality`, so shipping a default would mislead callers.
     */
    static shippedDefaultsFor(level: OptimizeFor): ImageCompressPresetOptions;
}
