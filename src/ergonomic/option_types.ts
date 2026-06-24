/**
 * Typed per-op option interfaces for the ergonomic verbs (card Dhje3Faq).
 * These replace the untyped `Record<string, unknown>` bags so the IDE can offer
 * key completion and `tsc` rejects typos. The KEY SET of each interface is pinned
 * to the contract two ways: (1) the source-level `Equal<...>` assertions below tie
 * each interface to its `*_OPTION_KEYS` tuple at `tsc` time; (2) the wire-key
 * conformance guard ties each tuple (∪ positional-owned) to the generated
 * `OperationMetadata` at test time. Value types are best-effort (per-value/enum
 * sync is out of scope — keys are the contract anchor).
 *
 * Keys a verb owns via a positional argument are EXCLUDED from its interface
 * (`output_format` on convert, `text` on textWatermark) — they are set by the
 * first argument and rejected if supplied in the bag (see `option_validation.ts`).
 *
 * Mirrored by the PHP array-shape docblocks — keep in lockstep.
 */

/** 9-grid anchor shared by text/image/video watermark. */
export type WatermarkAnchor =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'center_left'
  | 'center'
  | 'center_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

// ---- convert (output_format is positional-owned → excluded) ----
export interface ConvertOptions {
  /** Output quality for lossy image formats (1-100). */
  quality?: number;
  /** Background colour (hex) for transparent images → JPEG. */
  background?: string;
  /** Video Constant Rate Factor (0 best — 51 worst). */
  crf?: number;
  /** Trim from the start, in seconds (video). */
  trim_start?: number;
  /** Trim from the end, in seconds (video). */
  trim_end?: number;
  /** Output frame rate for video → GIF. */
  fps?: number;
  /** Resize width in px. Image convert: resize-on-convert (1-16384, width*height ≤ 16MP, v2.103.0). Video → GIF: downscale cap. */
  width?: number;
  /** Resize height in px for image convert (1-16384, v2.103.0). Omit for width-only / aspect-preserving resize. Not honored for SVG input. */
  height?: number;
  /** Resize mode for image convert (applies when width or height is set, v2.103.0). `max` never upscales. */
  fit?: 'max' | 'crop' | 'scale';
  /** Metadata policy for image convert (`strip` removes EXIF/IPTC/XMP, `keep` preserves). PLANNED on convert.image (v2.106.0). */
  metadata?: 'strip' | 'keep';
  /** ICC colour-profile handling for image convert (`keep`/`srgb`/`strip`). PLANNED on convert.image (v2.112.0). */
  color_profile?: 'keep' | 'srgb' | 'strip';
  /** Auto-rotate per EXIF orientation for image convert. STABLE since v2.120.0. */
  auto_orient?: boolean;
  /** GIF palette size (2-256). */
  max_colors?: number;
  /** GIF loop count (0 infinite, N>0 N times, -1 once). */
  loop?: number;
  /** GIF dithering method. */
  dither?: 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2' | 'sierra2_4a';
  /** Output bitrate in kbps (lossy audio). */
  bitrate?: 64 | 96 | 128 | 192 | 256 | 320;
  /** Page selection for PDF → image (e.g. '1-5,8'). */
  pages?: string;
  /** Render resolution in DPI for PDF → image. */
  dpi?: number;
}
const CONVERT_OPTION_KEYS = [
  'quality', 'background', 'crf', 'trim_start', 'trim_end', 'fps', 'width', 'height', 'fit', 'metadata',
  'color_profile', 'auto_orient', 'max_colors', 'loop', 'dither', 'bitrate', 'pages', 'dpi',
] as const;

// ---- thumbnail (width + height REQUIRED per contract) ----
export interface ThumbnailOptions {
  /** Target width in pixels (1-16384). REQUIRED. */
  width: number;
  /** Target height in pixels (1-16384). REQUIRED. */
  height: number;
  /** Resize mode. */
  fit?: 'max' | 'crop' | 'scale';
  /** Output format for the thumbnail. */
  format?: 'jpg' | 'png' | 'webp';
  /** Output quality for lossy thumbnail formats (image input). */
  quality?: number;
  /** Background fill colour (hex) for transparency flattened to JPG output (v2.118.0). */
  background?: string;
  /** Frame timestamp for video input (e.g. '00:00:01'). */
  timestamp?: string;
  /** Document source: a printed page or the cover. */
  source?: 'page' | 'cover';
  /** 1-based page index for document input. */
  page?: number;
}
const THUMBNAIL_OPTION_KEYS = [
  'width', 'height', 'fit', 'format', 'quality', 'background', 'timestamp', 'source', 'page',
] as const;

// ---- textWatermark (text is positional-owned → excluded) ----
export interface TextWatermarkOptions {
  /** Font size in pixels (8-512). */
  font_size?: number;
  /** Text colour as hex RGB/RGBA (e.g. '#FFFFFF80'). */
  color?: string;
  /** Font family (bundled). */
  font_family?: 'liberation_sans';
  /** Rotation angle in degrees (-360..360). */
  rotation?: number;
  /** Rendering mode. */
  watermark_mode?: 'single' | 'tiled';
  /** Spacing between tiled labels in pixels (tiled mode). */
  tile_spacing?: number;
  /** 9-grid anchor position. */
  anchor?: WatermarkAnchor;
  /** Horizontal offset from the anchor (e.g. '40px' or '5%'). */
  margin_x?: string;
  /** Vertical offset from the anchor. */
  margin_y?: string;
  /** Overlay opacity (0-1). */
  opacity?: number;
}
const TEXT_WATERMARK_OPTION_KEYS = [
  'font_size', 'color', 'font_family', 'rotation', 'watermark_mode',
  'tile_spacing', 'anchor', 'margin_x', 'margin_y', 'opacity',
] as const;

// ---- watermark (image/video overlay; union of image_watermark + video_watermark) ----
export interface WatermarkOptions {
  /** 9-grid anchor position. */
  anchor?: WatermarkAnchor;
  /** Horizontal offset from the anchor (e.g. '40px' or '5%'). */
  margin_x?: string;
  /** Vertical offset from the anchor. */
  margin_y?: string;
  /** Overlay opacity (0-1). */
  opacity?: number;
  /** Overlay width (e.g. '120px' or '20%'). */
  overlay_width?: string;
}
const WATERMARK_OPTION_KEYS = [
  'anchor', 'margin_x', 'margin_y', 'opacity', 'overlay_width',
] as const;

// ---- output (image Output facade; output_format is positional-owned → excluded) ----
/** Resize mode (contract `fit` enum, v2.97.0). */
export type OutputFit = 'max' | 'crop' | 'scale';
/**
 * Metadata policy (contract `metadata` enum). `strip` (default) removes all
 * EXIF/IPTC/XMP; `keep` preserves them. Honored on same_format; PLANNED on
 * format_change (v2.106.0). Renamed in contracts v2.107.0 — the legacy `all`
 * token is now a DEPRECATED alias of `strip` (still accepted on the wire, emits
 * a Deprecation header); use `strip`.
 */
export type OutputMetadata = 'strip' | 'keep';
/**
 * Compression mode on the optimiser (same_format) route (contract `encoding_mode`
 * enum). `quality` (default) drives the encode by the quality slider; `target_size`
 * targets a byte budget via the worker's encode-measure loop — STABLE since
 * contracts v2.108.0 (jpeg/webp/avif).
 */
export type OutputEncodingMode = 'quality' | 'target_size';
/** Chroma subsampling for JPEG output (contract `chroma_subsampling` enum, v2.110.0). `420` smallest → `444` highest fidelity. Honored: same_format jpeg only. */
export type OutputChromaSubsampling = '420' | '422' | '444';
/** ICC colour-profile handling (contract `color_profile` enum, v2.112.0). `keep` preserves the embedded profile; `srgb` converts to sRGB; `strip` removes it. PLANNED — gated unavailable. */
export type OutputColorProfile = 'keep' | 'srgb' | 'strip';

/**
 * Options for the file-first `output()` image transform. The KEY SET is the
 * UNION of every image route's honored + planned option keys (image-output-routes
 * projection); the PER-ROUTE honored/planned narrowing happens in the lowering
 * (`resolveOutputRoute`), so supplying an option not honored on the resolved
 * route (or a planned one) throws pre-upload. `output_format` is set via the
 * positional `format` argument, so it is excluded here. Resize (`width`/`height`/
 * `fit`) is honored on raster routes; `height` is optional (width-only resize).
 */
export interface OutputOptions {
  /** Output quality for lossy formats (1-100). Honored: avif/jpeg/webp routes. */
  quality?: number;
  /** Compression mode (same_format avif/jpeg/webp). `quality` (default) or `target_size` — STABLE since v2.108.0. */
  encoding_mode?: OutputEncodingMode;
  /** Target output size in bytes (≥1024) for `encoding_mode: 'target_size'`. STABLE since v2.108.0. Honored: same_format avif/jpeg/webp. */
  target_size_bytes?: number;
  /** Chroma subsampling for JPEG output. Honored: same_format jpeg only (v2.110.0). */
  chroma_subsampling?: OutputChromaSubsampling;
  /** Resize target width in px (1-16384; width*height <= 16MP). */
  width?: number;
  /** Resize target height in px (optional — width-only resize preserves aspect). */
  height?: number;
  /** Resize mode (applies when width or height is set). */
  fit?: OutputFit;
  /** Background colour (hex) for transparent images → JPEG. Honored: format_change→jpeg only. */
  background?: string;
  /** Progressive JPEG. Honored: same_format jpeg only. */
  progressive?: boolean;
  /** PNG lossless optimisation effort. Honored: same_format png only. */
  optimization_level?: number;
  /** AVIF encode speed. Honored: same_format avif only. */
  avif_speed?: number;
  /** Metadata policy (`strip` default / `keep`). Honored: same_format; PLANNED on format_change (v2.106.0). */
  metadata?: OutputMetadata;
  /** Selective per-category metadata keep (`copyright`/`gps`/`date`); refines `metadata: 'strip'`. PLANNED (gated unavailable; v2.106.0). */
  keep_metadata?: string[];
  /** ICC colour-profile handling (`keep`/`srgb`/`strip`). PLANNED — gated unavailable (v2.112.0). */
  color_profile?: OutputColorProfile;
  /** Auto-rotate per EXIF orientation. STABLE since v2.120.0 (both routes). */
  auto_orient?: boolean;
  /** JPEG/WebP lossless. Honored: same_format jpeg/webp (stable since v2.101.0). */
  lossless?: boolean;
  /** Lossy PNG quantization. PLANNED (gated unavailable; licence-gated). */
  lossy?: boolean;
}
const OUTPUT_OPTION_KEYS = [
  'quality', 'encoding_mode', 'target_size_bytes', 'chroma_subsampling', 'width', 'height', 'fit',
  'background', 'progressive', 'optimization_level', 'avif_speed', 'metadata', 'keep_metadata',
  'color_profile', 'auto_orient', 'lossless', 'lossy',
] as const;

// --- Source-level drift guard: interface keys must equal the key tuple (tsc-enforced). ---
// `Equal<A, B>` is `true` only when A and B are the SAME union; assigning `true` to it
// fails to compile if an interface key is added/removed without updating its tuple. The
// tuples are themselves tied to the contract metadata by the wire-key conformance guard.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const _convertKeysMatch: Equal<keyof ConvertOptions, (typeof CONVERT_OPTION_KEYS)[number]> = true;
const _thumbnailKeysMatch: Equal<keyof ThumbnailOptions, (typeof THUMBNAIL_OPTION_KEYS)[number]> = true;
const _textWatermarkKeysMatch: Equal<keyof TextWatermarkOptions, (typeof TEXT_WATERMARK_OPTION_KEYS)[number]> = true;
const _watermarkKeysMatch: Equal<keyof WatermarkOptions, (typeof WATERMARK_OPTION_KEYS)[number]> = true;
const _outputKeysMatch: Equal<keyof OutputOptions, (typeof OUTPUT_OPTION_KEYS)[number]> = true;
// Reference the assertions so `noUnusedLocals` doesn't strip them.
void _convertKeysMatch;
void _thumbnailKeysMatch;
void _textWatermarkKeysMatch;
void _watermarkKeysMatch;
void _outputKeysMatch;

/**
 * The user-supplyable option keys per verb (excludes positional-owned keys).
 * Exported for the wire-key conformance guard, which asserts each tuple ∪ its
 * positional-owned keys equals the contract `operationOptionKeys(metadata)`.
 */
export const VERB_OPTION_KEYS = {
  convert: CONVERT_OPTION_KEYS,
  thumbnail: THUMBNAIL_OPTION_KEYS,
  textWatermark: TEXT_WATERMARK_OPTION_KEYS,
  watermark: WATERMARK_OPTION_KEYS,
  output: OUTPUT_OPTION_KEYS,
} as const;
