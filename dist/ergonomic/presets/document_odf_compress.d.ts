import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface DocumentOdfCompressPresetOptionsInput {
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
}
export declare class DocumentOdfCompressPresetOptions {
    readonly stripMetadata?: boolean;
    readonly stripUnusedStyles?: boolean;
    /** Compression quality 1-100 (contract default 50) — the one stable document compress option. */
    readonly quality?: number;
    private constructor();
    static from(input: DocumentOdfCompressPresetOptionsInput): DocumentOdfCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): DocumentOdfCompressPresetOptions;
}
