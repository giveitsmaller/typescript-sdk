import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentPdfCompressPresetOptionsInput {
    /** JPEG quality 1-100 for images inside the PDF (contract default 70). */
    readonly quality?: number;
    /** Longest side in px for images inside the PDF, 64-10000 (contract default 1600). */
    readonly maxImageDimension?: number;
}
export declare class DocumentPdfCompressPresetOptions {
    /** JPEG quality 1-100 for images inside the PDF (contract default 70). */
    readonly quality?: number;
    /** Longest side in px for images inside the PDF, 64-10000 (contract default 1600). */
    readonly maxImageDimension?: number;
    private constructor();
    static from(input: DocumentPdfCompressPresetOptionsInput): DocumentPdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentPdfCompressPresetOptions;
}
