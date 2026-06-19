import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentOdfCompressPresetOptionsInput {
    readonly imageQuality?: number;
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
}
export declare class DocumentOdfCompressPresetOptions {
    readonly imageQuality?: number;
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
    private constructor();
    static from(input: DocumentOdfCompressPresetOptionsInput): DocumentOdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentOdfCompressPresetOptions;
}
