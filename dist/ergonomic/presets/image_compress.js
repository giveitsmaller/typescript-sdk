// T4a — ImageCompressPresetOptions leaf DTO.
//
// Sparse delta over the wire `CompressImageOptions` surface. Every field
// is optional + readonly; an unset field means "fall through to the next
// layer" (shipped defaults / user delta / per-call override). Mapped via
// the ergonomic enum types from `../../generated/sdk_spec/enums.ts`, whose
// values ARE the wire backing values — so the leaf DTO is wire-compatible
// once the resolver (T4b) snake_cases the property names.
//
// Field set (6) per EsD1hs5u / contracts v2.60.0: image =
//   (mode, quality, metadata, iccProfile, progressive, outputFormat).
// `width`/`height`/`fit`/`autoOrient` were REMOVED — the image-compress
// worker never resized (resize-fit lives on thumbnail/convert; video keeps
// its own fit). Trim / per-call knobs are deliberately excluded — they
// belong on the per-call argument shape, not the preset cell.
import { shippedDefaultsFor as f3ShippedDefaultsFor } from '../../generated/sdk_spec/presets.js';
import { translateEnum } from './_translate.js';
export class ImageCompressPresetOptions {
    mode;
    quality;
    metadata;
    iccProfile;
    progressive;
    outputFormat;
    constructor(input) {
        if (input.mode !== undefined)
            this.mode = input.mode;
        if (input.quality !== undefined)
            this.quality = input.quality;
        if (input.metadata !== undefined)
            this.metadata = input.metadata;
        if (input.iccProfile !== undefined)
            this.iccProfile = input.iccProfile;
        if (input.progressive !== undefined)
            this.progressive = input.progressive;
        if (input.outputFormat !== undefined)
            this.outputFormat = input.outputFormat;
        Object.freeze(this);
    }
    /**
     * Construct a leaf DTO from a sparse caller-supplied delta. Fields the
     * caller omits stay undefined on the instance — they are NOT filled
     * from shipped defaults here (the resolver in T4b merges layers).
     */
    static from(input) {
        return new ImageCompressPresetOptions(input);
    }
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
    static shippedDefaultsFor(level) {
        const cell = f3ShippedDefaultsFor('image_compress', level);
        const input = {};
        const mut = input;
        if ('mode' in cell)
            mut.mode = translateEnum('ImageMode', cell.mode);
        if ('quality' in cell)
            mut.quality = cell.quality;
        if ('metadata' in cell)
            mut.metadata = translateEnum('ImageMetadataPolicy', cell.metadata);
        if ('iccProfile' in cell)
            mut.iccProfile = translateEnum('IccProfilePolicy', cell.iccProfile);
        if ('progressive' in cell)
            mut.progressive = cell.progressive;
        if ('outputFormat' in cell)
            mut.outputFormat = translateEnum('ImageFormat', cell.outputFormat);
        return new ImageCompressPresetOptions(input);
    }
}
