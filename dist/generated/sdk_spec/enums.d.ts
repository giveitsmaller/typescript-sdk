export declare const OptimizeFor: {
    readonly Size: "Size";
    readonly Balanced: "Balanced";
    readonly Quality: "Quality";
};
export type OptimizeFor = typeof OptimizeFor[keyof typeof OptimizeFor];
export declare const ImageFormat: {
    readonly Original: "original";
    readonly Webp: "webp";
};
export type ImageFormat = typeof ImageFormat[keyof typeof ImageFormat];
export declare const ImageMetadataPolicy: {
    readonly Strip: "strip";
    readonly Keep: "keep";
    readonly All: "all";
};
export type ImageMetadataPolicy = typeof ImageMetadataPolicy[keyof typeof ImageMetadataPolicy];
export declare const VideoCodec: {
    readonly H264: "h264";
    readonly H265: "h265";
    readonly Vp9: "vp9";
    readonly Av1: "av1";
};
export type VideoCodec = typeof VideoCodec[keyof typeof VideoCodec];
export declare const VideoPreset: {
    readonly Ultrafast: "ultrafast";
    readonly Superfast: "superfast";
    readonly Veryfast: "veryfast";
    readonly Faster: "faster";
    readonly Fast: "fast";
    readonly Medium: "medium";
    readonly Slow: "slow";
    readonly Slower: "slower";
    readonly Veryslow: "veryslow";
};
export type VideoPreset = typeof VideoPreset[keyof typeof VideoPreset];
export declare const VideoFit: {
    readonly Max: "max";
    readonly Crop: "crop";
    readonly Scale: "scale";
    readonly Pad: "pad";
};
export type VideoFit = typeof VideoFit[keyof typeof VideoFit];
export declare const AudioBitrate: {
    readonly _64: 64;
    readonly _96: 96;
    readonly _128: 128;
    readonly _192: 192;
    readonly _256: 256;
    readonly _320: 320;
};
export type AudioBitrate = typeof AudioBitrate[keyof typeof AudioBitrate];
export declare const AudioCodec: {
    readonly Aac: "aac";
    readonly Opus: "opus";
    readonly Vorbis: "vorbis";
    readonly Copy: "copy";
};
export type AudioCodec = typeof AudioCodec[keyof typeof AudioCodec];
export declare const AudioSampleRate: {
    readonly _22050: 22050;
    readonly _44100: 44100;
    readonly _48000: 48000;
};
export type AudioSampleRate = typeof AudioSampleRate[keyof typeof AudioSampleRate];
/** Catalog of every ergonomic enum (canonicalName → wire). */
export declare const ERGONOMIC_ENUMS: {
    readonly OptimizeFor: {
        readonly Size: "Size";
        readonly Balanced: "Balanced";
        readonly Quality: "Quality";
    };
    readonly ImageFormat: {
        readonly Original: "original";
        readonly Webp: "webp";
    };
    readonly ImageMetadataPolicy: {
        readonly Strip: "strip";
        readonly Keep: "keep";
        readonly All: "all";
    };
    readonly VideoCodec: {
        readonly H264: "h264";
        readonly H265: "h265";
        readonly Vp9: "vp9";
        readonly Av1: "av1";
    };
    readonly VideoPreset: {
        readonly Ultrafast: "ultrafast";
        readonly Superfast: "superfast";
        readonly Veryfast: "veryfast";
        readonly Faster: "faster";
        readonly Fast: "fast";
        readonly Medium: "medium";
        readonly Slow: "slow";
        readonly Slower: "slower";
        readonly Veryslow: "veryslow";
    };
    readonly VideoFit: {
        readonly Max: "max";
        readonly Crop: "crop";
        readonly Scale: "scale";
        readonly Pad: "pad";
    };
    readonly AudioBitrate: {
        readonly _64: 64;
        readonly _96: 96;
        readonly _128: 128;
        readonly _192: 192;
        readonly _256: 256;
        readonly _320: 320;
    };
    readonly AudioCodec: {
        readonly Aac: "aac";
        readonly Opus: "opus";
        readonly Vorbis: "vorbis";
        readonly Copy: "copy";
    };
    readonly AudioSampleRate: {
        readonly _22050: 22050;
        readonly _44100: 44100;
        readonly _48000: 48000;
    };
};
