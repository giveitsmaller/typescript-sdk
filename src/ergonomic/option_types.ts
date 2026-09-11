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

// ---- transform (geometric: rotate/flip; no positional-owned key) ----
// Passthrough verb (like thumbnail): the SDK accepts the op-wide union of
// keys. `flip` is honored on image/video groups but NOT on document_pdf
// (rotate only) — that per-media narrowing is server-side (a `flip` on a PDF
// 422s), matching thumbnail's coarse per-op-union validation. The whole op is
// `availability: planned` today, so a lowered transform 422s (feature_not_available)
// until the per-media Lambdas ship.
export interface TransformOptions {
  /** Clockwise rotation in degrees. document_pdf honors `rotate` only. */
  rotate?: 0 | 90 | 180 | 270;
  /** Mirror axis (applied after `rotate`). Not honored on document_pdf input. */
  flip?: 'none' | 'horizontal' | 'vertical' | 'both';
}
const TRANSFORM_OPTION_KEYS = ['rotate', 'flip'] as const;

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

/**
 * One entry in the multi-overlay stack (contract `overlays[]` items, v2.152.0).
 * Index-aligned to the overlay-role sources — `overlays[i]` places overlay
 * source `i` — and mirrors the flat single-overlay option shape. Matches the
 * generated `ImageWatermarkImageOverlaysItem`.
 */
export interface WatermarkOverlay {
  /** 9-grid anchor position for this overlay. */
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
  /**
   * Per-overlay placement for the multi-overlay stack (contract `overlays[]`,
   * v2.152.0) — one entry per overlay source, index-aligned; stacks up to 8
   * overlays on one base image (z-order = array index). MUTUALLY EXCLUSIVE with
   * the flat single-overlay options above; the server rejects mixing the two as
   * `invalid_options`. image_watermark jpeg/png/webp bases only.
   *
   * NOTE: NOT usable via `watermark()` yet — the facade composites a single
   * overlay (the positional `overlay`, wire source src_1), so `overlays[]` would
   * reference sources it cannot create. `watermark()` rejects it at lowering
   * (`overlays_unsupported`); use the flat single-overlay options above instead.
   * Kept as a valid contract wire key — multi-overlay stacking is a future
   * feature (Vbbdq9C4).
   */
  overlays?: WatermarkOverlay[];
}
const WATERMARK_OPTION_KEYS = [
  'anchor', 'margin_x', 'margin_y', 'opacity', 'overlay_width', 'overlays',
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
 * contracts v2.108.0 (jpeg/webp/avif). `auto_quality` lets the worker pick the
 * quality from a named `quality_preset` (its `depends_on`) — the output lowering
 * infers it for you when you set `quality_preset` without an `encoding_mode`.
 */
export type OutputEncodingMode = 'quality' | 'target_size' | 'auto_quality';
/** Chroma subsampling for JPEG output (contract `chroma_subsampling` enum, v2.110.0). `420` smallest → `444` highest fidelity. Honored: same_format jpeg only. */
export type OutputChromaSubsampling = '420' | '422' | '444';
/** ICC colour-profile handling (contract `color_profile` enum, v2.112.0). `keep` preserves the embedded profile; `srgb` converts to sRGB; `strip` removes it. Route/value availability is gated by the output lowering. */
export type OutputColorProfile = 'keep' | 'srgb' | 'strip';
/** Named quality preset (contract `quality_preset` enum, v2.148.0) — an alternative to the numeric `quality` slider. `best` highest fidelity → `low` smallest. Honored: same_format avif/jpeg/webp. */
export type OutputQualityPreset = 'best' | 'good' | 'fair' | 'low';

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
  /** Output quality (1-100). Honored on same-format avif/jpeg/png/webp and lossy format-change routes. */
  quality?: number;
  /** Named quality preset (`best`/`good`/`fair`/`low`) — an alternative to the numeric `quality` slider (v2.148.0). Honored: same_format avif/jpeg/webp. */
  quality_preset?: OutputQualityPreset;
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
  /** ICC colour-profile handling (`keep`/`srgb`/`strip`). Availability depends on route and value. */
  color_profile?: OutputColorProfile;
  /** Auto-rotate per EXIF orientation. STABLE since v2.120.0 (both routes). */
  auto_orient?: boolean;
  /** JPEG/WebP lossless. Honored: same_format jpeg/webp (stable since v2.101.0). */
  lossless?: boolean;
}
const OUTPUT_OPTION_KEYS = [
  'quality', 'quality_preset', 'encoding_mode', 'target_size_bytes', 'chroma_subsampling', 'width', 'height', 'fit',
  'background', 'progressive', 'optimization_level', 'avif_speed', 'metadata',
  'color_profile', 'auto_orient', 'lossless',
] as const;

// --- Source-level drift guard: interface keys must equal the key tuple (tsc-enforced). ---
// `Equal<A, B>` is `true` only when A and B are the SAME union; assigning `true` to it
// fails to compile if an interface key is added/removed without updating its tuple. The
// tuples are themselves tied to the contract metadata by the wire-key conformance guard.
// EXPORTED for `src/_audit.ts` (BQXpFV2R), which needs exact type EQUALITY for its
// signature pins. ⚠️ It does NOT reach the public surface: `index.core.ts` pulls
// `option_types` by named clause only, and the sole two `export *` in the entry graph
// are `index.ts` and `index.browser.ts` -> `index.core.ts`. The committed export
// snapshot in `tests/api-surface/` asserts that, so a leak becomes a red test.
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const _convertKeysMatch: Equal<keyof ConvertOptions, (typeof CONVERT_OPTION_KEYS)[number]> = true;
const _thumbnailKeysMatch: Equal<keyof ThumbnailOptions, (typeof THUMBNAIL_OPTION_KEYS)[number]> = true;
const _transformKeysMatch: Equal<keyof TransformOptions, (typeof TRANSFORM_OPTION_KEYS)[number]> = true;
const _textWatermarkKeysMatch: Equal<keyof TextWatermarkOptions, (typeof TEXT_WATERMARK_OPTION_KEYS)[number]> = true;
const _watermarkKeysMatch: Equal<keyof WatermarkOptions, (typeof WATERMARK_OPTION_KEYS)[number]> = true;
const _outputKeysMatch: Equal<keyof OutputOptions, (typeof OUTPUT_OPTION_KEYS)[number]> = true;
// Reference the assertions so `noUnusedLocals` doesn't strip them.
void _convertKeysMatch;
void _thumbnailKeysMatch;
void _transformKeysMatch;
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
  transform: TRANSFORM_OPTION_KEYS,
  textWatermark: TEXT_WATERMARK_OPTION_KEYS,
  watermark: WATERMARK_OPTION_KEYS,
  output: OUTPUT_OPTION_KEYS,
} as const;
