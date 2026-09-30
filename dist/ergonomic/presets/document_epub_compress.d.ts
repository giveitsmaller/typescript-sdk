import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentEpubCompressPresetOptionsInput {
    readonly fontSubsetting?: boolean;
    readonly stripUnusedCss?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
}
export declare class DocumentEpubCompressPresetOptions {
    readonly fontSubsetting?: boolean;
    readonly stripUnusedCss?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
    private constructor();
    static from(input: DocumentEpubCompressPresetOptionsInput): DocumentEpubCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentEpubCompressPresetOptions;
}
