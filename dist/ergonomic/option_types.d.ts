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
export type WatermarkAnchor = 'top_left' | 'top_center' | 'top_right' | 'center_left' | 'center' | 'center_right' | 'bottom_left' | 'bottom_center' | 'bottom_right';
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
    /** Max output width in pixels (video → GIF downscale cap). */
    width?: number;
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
    /** Frame timestamp for video input (e.g. '00:00:01'). */
    timestamp?: string;
    /** Document source: a printed page or the cover. */
    source?: 'page' | 'cover';
    /** 1-based page index for document input. */
    page?: number;
}
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
/**
 * The user-supplyable option keys per verb (excludes positional-owned keys).
 * Exported for the wire-key conformance guard, which asserts each tuple ∪ its
 * positional-owned keys equals the contract `operationOptionKeys(metadata)`.
 */
export declare const VERB_OPTION_KEYS: {
    readonly convert: readonly ["quality", "background", "crf", "trim_start", "trim_end", "fps", "width", "max_colors", "loop", "dither", "bitrate", "pages", "dpi"];
    readonly thumbnail: readonly ["width", "height", "fit", "format", "quality", "timestamp", "source", "page"];
    readonly textWatermark: readonly ["font_size", "color", "font_family", "rotation", "watermark_mode", "tile_spacing", "anchor", "margin_x", "margin_y", "opacity"];
    readonly watermark: readonly ["anchor", "margin_x", "margin_y", "opacity", "overlay_width"];
};
