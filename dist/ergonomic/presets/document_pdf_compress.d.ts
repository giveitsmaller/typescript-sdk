import { PdfProfile, PdfColorspace, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentPdfCompressPresetOptionsInput {
    readonly profile?: PdfProfile;
    readonly colorspace?: PdfColorspace;
    readonly flattenForms?: boolean;
}
export declare class DocumentPdfCompressPresetOptions {
    readonly profile?: PdfProfile;
    readonly colorspace?: PdfColorspace;
    readonly flattenForms?: boolean;
    private constructor();
    static from(input: DocumentPdfCompressPresetOptionsInput): DocumentPdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentPdfCompressPresetOptions;
}
