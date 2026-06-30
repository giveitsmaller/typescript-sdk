import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentOdfCompressPresetOptionsInput {
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
}
export declare class DocumentOdfCompressPresetOptions {
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
    private constructor();
    static from(input: DocumentOdfCompressPresetOptionsInput): DocumentOdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentOdfCompressPresetOptions;
}
