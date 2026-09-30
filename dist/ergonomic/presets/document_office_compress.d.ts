import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentOfficeCompressPresetOptionsInput {
    readonly stripMacros?: boolean;
    readonly stripHiddenData?: boolean;
    readonly stripUnusedFonts?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
}
export declare class DocumentOfficeCompressPresetOptions {
    readonly stripMacros?: boolean;
    readonly stripHiddenData?: boolean;
    readonly stripUnusedFonts?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
    private constructor();
    static from(input: DocumentOfficeCompressPresetOptionsInput): DocumentOfficeCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentOfficeCompressPresetOptions;
}
