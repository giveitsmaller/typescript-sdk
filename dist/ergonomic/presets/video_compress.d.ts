import { VideoCodec, VideoPreset, VideoFit, AudioCodec, AudioBitrate, OptimizeFor } from '../../generated/sdk_spec/enums.js';
export interface VideoCompressPresetOptionsInput {
    readonly codec?: VideoCodec;
    /**
     * Target output size (`'50MB'`-style string — BINARY units, 1 KB = 1024 — or a byte
     * count). Derived by the resolver into `target_size_bytes` + `encoding_mode:
     * 'target_size'`.
     *
     * **NOT AVAILABLE FOR LONG INPUTS.** A compress whose input duration routes to the
     * long-form path rejects it (`reject_long_form_target_size`): that path is
     * single-pass-CRF by construction and two-pass target-size is unbuilt. The request
     * fails during execution, and the SDK cannot warn earlier — routing is decided
     * server-side at create-plan time, so there is nothing here to check it against.
     * Short-form compresses honour it normally. Tracked by `zJN6XIi5`, blocked on a
     * contract that can express per-execution-path availability. The same limit applies
     * to {@link MergeOptions.targetSize}.
     */
    readonly targetSize?: string | number;
    readonly crf?: number;
    readonly preset?: VideoPreset;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly fps?: number;
    readonly faststart?: boolean;
    readonly audioCodec?: AudioCodec;
    readonly audioBitrate?: AudioBitrate;
}
export declare class VideoCompressPresetOptions {
    readonly codec?: VideoCodec;
    readonly targetSize?: string | number;
    readonly crf?: number;
    readonly preset?: VideoPreset;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly fps?: number;
    readonly faststart?: boolean;
    readonly audioCodec?: AudioCodec;
    readonly audioBitrate?: AudioBitrate;
    private constructor();
    static from(input: VideoCompressPresetOptionsInput): VideoCompressPresetOptions;
    static shippedDefaultsFor(level: OptimizeFor): VideoCompressPresetOptions;
}
