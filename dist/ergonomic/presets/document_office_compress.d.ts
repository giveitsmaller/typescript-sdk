import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentOfficeCompressPresetOptionsInput {
    readonly stripMacros?: boolean;
    readonly stripHiddenData?: boolean;
    readonly stripUnusedFonts?: boolean;
}
export declare class DocumentOfficeCompressPresetOptions {
    readonly stripMacros?: boolean;
    readonly stripHiddenData?: boolean;
    readonly stripUnusedFonts?: boolean;
    private constructor();
    static from(input: DocumentOfficeCompressPresetOptionsInput): DocumentOfficeCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentOfficeCompressPresetOptions;
}
