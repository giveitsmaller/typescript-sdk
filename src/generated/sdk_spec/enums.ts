// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.

// Top-level preset selector. Resolved client-side to concrete wire fields per presets.yaml.
export const OptimizeFor = {
  Size: "Size",
  Balanced: "Balanced",
  Quality: "Quality",
} as const;
export type OptimizeFor = typeof OptimizeFor[keyof typeof OptimizeFor];

// Image compression algorithm. lossy = smaller file; lossless = no quality loss; auto = format-best.
export const ImageMode = {
  Lossy: "lossy",
  Lossless: "lossless",
  Auto: "auto",
} as const;
export type ImageMode = typeof ImageMode[keyof typeof ImageMode];

// Image output format selection. Original keeps input; Auto picks best per browser support; Smallest tries all and returns smallest.
export const ImageFormat = {
  Original: "original",
  Auto: "auto",
  Smallest: "smallest",
  Jpeg: "jpeg",
  Png: "png",
  Webp: "webp",
  Avif: "avif",
} as const;
export type ImageFormat = typeof ImageFormat[keyof typeof ImageFormat];

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
} as const;
export type ImageMetadataPolicy = typeof ImageMetadataPolicy[keyof typeof ImageMetadataPolicy];

// ICC color profile handling.
export const IccProfilePolicy = {
  Preserve: "preserve",
  Strip: "strip",
  Srgb: "srgb",
} as const;
export type IccProfilePolicy = typeof IccProfilePolicy[keyof typeof IccProfilePolicy];

// Video codec. H264 = widest compatibility; H265/Av1 = better compression but slower.
export const VideoCodec = {
  H264: "h264",
  H265: "h265",
  Vp9: "vp9",
  Av1: "av1",
} as const;
export type VideoCodec = typeof VideoCodec[keyof typeof VideoCodec];

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
} as const;
export type VideoPreset = typeof VideoPreset[keyof typeof VideoPreset];

// Video resize mode. Only applies when width or height is set. Pad is video-only (image fit lacks pad).
export const VideoFit = {
  Max: "max",
  Crop: "crop",
  Scale: "scale",
  Pad: "pad",
} as const;
export type VideoFit = typeof VideoFit[keyof typeof VideoFit];

// Audio output bitrate in kbps. Shared between compress (audio + video.audioBitrate) cells.
export const AudioBitrate = {
  _64: 64,
  _96: 96,
  _128: 128,
  _192: 192,
  _256: 256,
  _320: 320,
} as const;
export type AudioBitrate = typeof AudioBitrate[keyof typeof AudioBitrate];

// Audio codec. Aac = widest compatibility; Opus = best quality/size; Copy = passthrough (no re-encode).
export const AudioCodec = {
  Aac: "aac",
  Opus: "opus",
  Vorbis: "vorbis",
  Copy: "copy",
} as const;
export type AudioCodec = typeof AudioCodec[keyof typeof AudioCodec];

// Audio sample rate in Hz.
export const AudioSampleRate = {
  _22050: 22050,
  _44100: 44100,
  _48000: 48000,
} as const;
export type AudioSampleRate = typeof AudioSampleRate[keyof typeof AudioSampleRate];

// PDF optimization profile. Web = aggressive; Print = preserve quality; Archive = PDF/A; Max = smallest.
export const PdfProfile = {
  Web: "web",
  Print: "print",
  Archive: "archive",
  Max: "max",
} as const;
export type PdfProfile = typeof PdfProfile[keyof typeof PdfProfile];

// PDF output color space.
export const PdfColorspace = {
  Unchanged: "unchanged",
  Rgb: "rgb",
  Cmyk: "cmyk",
  Grayscale: "grayscale",
} as const;
export type PdfColorspace = typeof PdfColorspace[keyof typeof PdfColorspace];

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
} as const;
