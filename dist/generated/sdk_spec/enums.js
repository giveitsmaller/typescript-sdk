// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.
// Top-level preset selector. Resolved client-side to concrete wire fields per presets.yaml.
export const OptimizeFor = {
    Size: "Size",
    Balanced: "Balanced",
    Quality: "Quality",
};
// Image output format for compress. Original keeps the input format; Webp recompresses to WebP. Other format changes (jpeg/png/avif/...) are the convert operation's job, not compress.
export const ImageFormat = {
    Original: "original",
    Webp: "webp",
};
// Image metadata handling (compress.image, optimiser/same_format route):
//   Strip = remove all EXIF/IPTC/XMP (default, smallest file) — the canonical
//           strip token (renamed from `all` 2026-06-23; `all` reading as
//           "strip all" was counterintuitive).
//   Keep  = preserve EXIF/ICC/XMP — worker-proven on the libcaesium formats
//           (JPEG/PNG/WebP/GIF/TIFF; lambdas PR #260, un-parked 2026-06-23).
//   All   = DEPRECATED alias of Strip (still accepted on the wire, emits
//           Deprecation/Sunset; the API lowers `strip`→`all` at the worker
//           boundary). Migrate to Strip.
// Keep is NOT available for AVIF (ravif) / SVG (SVGO) — those re-encode from
// pixels and cannot preserve metadata, so the worker rejects it there (the
// `metadata` enum is narrowed to [strip, all] on those groups).
export const ImageMetadataPolicy = {
    Strip: "strip",
    Keep: "keep",
    All: "all",
};
// Video codec. H264 = widest compatibility; H265/Av1 = better compression but slower.
export const VideoCodec = {
    H264: "h264",
    H265: "h265",
    Vp9: "vp9",
    Av1: "av1",
};
// Encoding speed vs compression ratio trade-off (FFmpeg-style x264/x265 preset names).
export const VideoPreset = {
    Ultrafast: "ultrafast",
    Superfast: "superfast",
    Veryfast: "veryfast",
    Faster: "faster",
    Fast: "fast",
    Medium: "medium",
    Slow: "slow",
    Slower: "slower",
    Veryslow: "veryslow",
};
// Video resize mode. Only applies when width or height is set. Pad is video-only (image fit lacks pad).
export const VideoFit = {
    Max: "max",
    Crop: "crop",
    Scale: "scale",
    Pad: "pad",
};
// Audio output bitrate in kbps. Shared between compress (audio + video.audioBitrate) cells.
export const AudioBitrate = {
    _64: 64,
    _96: 96,
    _128: 128,
    _192: 192,
    _256: 256,
    _320: 320,
};
// Audio codec. Aac = widest compatibility; Opus = best quality/size; Copy = passthrough (no re-encode).
export const AudioCodec = {
    Aac: "aac",
    Opus: "opus",
    Vorbis: "vorbis",
    Copy: "copy",
};
// Audio sample rate in Hz.
export const AudioSampleRate = {
    _22050: 22050,
    _44100: 44100,
    _48000: 48000,
};
/** Catalog of every ergonomic enum (canonicalName → wire). */
export const ERGONOMIC_ENUMS = {
    OptimizeFor,
    ImageFormat,
    ImageMetadataPolicy,
    VideoCodec,
    VideoPreset,
    VideoFit,
    AudioBitrate,
    AudioCodec,
    AudioSampleRate,
};
