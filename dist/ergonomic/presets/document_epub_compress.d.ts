import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentEpubCompressPresetOptionsInput {
    readonly imageQuality?: number;
    readonly fontSubsetting?: boolean;
    readonly stripUnusedCss?: boolean;
}
export declare class DocumentEpubCompressPresetOptions {
    readonly imageQuality?: number;
    readonly fontSubsetting?: boolean;
    readonly stripUnusedCss?: boolean;
    private constructor();
    static from(input: DocumentEpubCompressPresetOptionsInput): DocumentEpubCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentEpubCompressPresetOptions;
}
