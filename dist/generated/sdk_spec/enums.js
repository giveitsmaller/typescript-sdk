// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.
// Top-level preset selector. Resolved client-side to concrete wire fields per presets.yaml.
export const OptimizeFor = {
    Size: "Size",
    Balanced: "Balanced",
    Quality: "Quality",
};
// Image compression algorithm. lossy = smaller file; lossless = no quality loss; auto = format-best.
export const ImageMode = {
    Lossy: "lossy",
    Lossless: "lossless",
    Auto: "auto",
};
// Image output format selection. Original keeps input; Auto picks best per browser support; Smallest tries all and returns smallest.
export const ImageFormat = {
    Original: "original",
    Auto: "auto",
    Smallest: "smallest",
    Jpeg: "jpeg",
    Png: "png",
    Webp: "webp",
    Avif: "avif",
};
// Image metadata handling. Counter-intuitive wire naming:
//   All       = strip everything (smallest file)
//   None      = keep all EXIF/IPTC/XMP
//   Copyright = keep only copyright/author fields
//   Sensitive = keep EXIF but strip GPS/location (GDPR-friendly)
export const ImageMetadataPolicy = {
    All: "all",
    None: "none",
    Copyright: "copyright",
    Sensitive: "sensitive",
};
// ICC color profile handling.
export const IccProfilePolicy = {
    Preserve: "preserve",
    Strip: "strip",
    Srgb: "srgb",
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
// PDF optimization profile. Web = aggressive; Print = preserve quality; Archive = PDF/A; Max = smallest.
export const PdfProfile = {
    Web: "web",
    Print: "print",
    Archive: "archive",
    Max: "max",
};
// PDF output color space.
export const PdfColorspace = {
    Unchanged: "unchanged",
    Rgb: "rgb",
    Cmyk: "cmyk",
    Grayscale: "grayscale",
};
/** Catalog of every ergonomic enum (canonicalName → wire). */
export const ERGONOMIC_ENUMS = {
    OptimizeFor,
    ImageMode,
    ImageFormat,
    ImageMetadataPolicy,
    IccProfilePolicy,
    VideoCodec,
    VideoPreset,
    VideoFit,
    AudioBitrate,
    AudioCodec,
    AudioSampleRate,
    PdfProfile,
    PdfColorspace,
};
