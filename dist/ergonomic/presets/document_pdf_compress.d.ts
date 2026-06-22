import { PdfProfile, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentPdfCompressPresetOptionsInput {
    readonly profile?: PdfProfile;
    readonly grayscale?: boolean;
}
export declare class DocumentPdfCompressPresetOptions {
    readonly profile?: PdfProfile;
    readonly grayscale?: boolean;
    private constructor();
    static from(input: DocumentPdfCompressPresetOptionsInput): DocumentPdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentPdfCompressPresetOptions;
}
