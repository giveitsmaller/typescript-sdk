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

// Image output format for compress. Original keeps the input format; Webp recompresses to WebP. Other format changes (jpeg/png/avif/...) are the convert operation's job, not compress.
export const ImageFormat = {
  Original: "original",
  Webp: "webp",
} as const;
export type ImageFormat = typeof ImageFormat[keyof typeof ImageFormat];

// Image metadata handling (compress.image, optimiser/same_format route):
//   All  = strip all EXIF/IPTC/XMP (default, smallest file)
//   Keep = preserve EXIF/ICC/XMP — worker-proven on the libcaesium formats
//          (JPEG/PNG/WebP/GIF/TIFF; lambdas PR #260, un-parked 2026-06-23).
// Keep is NOT available for AVIF (ravif) / SVG (SVGO) — those re-encode from
// pixels and cannot preserve metadata, so the worker rejects it there (the
// `metadata` enum is narrowed to [all] on those groups).
export const ImageMetadataPolicy = {
  All: "all",
  Keep: "keep",
} as const;
export type ImageMetadataPolicy = typeof ImageMetadataPolicy[keyof typeof ImageMetadataPolicy];

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

// PDF Ghostscript preset. Screen = smallest; Ebook = mid; Printer = 300dpi; Prepress = print-production.
export const PdfProfile = {
  Screen: "screen",
  Ebook: "ebook",
  Printer: "printer",
  Prepress: "prepress",
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
  ImageFormat,
  ImageMetadataPolicy,
  VideoCodec,
  VideoPreset,
  VideoFit,
  AudioBitrate,
  AudioCodec,
  AudioSampleRate,
  PdfProfile,
  PdfColorspace,
} as const;
