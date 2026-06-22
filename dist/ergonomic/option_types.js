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
const CONVERT_OPTION_KEYS = [
    'quality', 'background', 'crf', 'trim_start', 'trim_end', 'fps', 'width',
    'max_colors', 'loop', 'dither', 'bitrate', 'pages', 'dpi',
];
const THUMBNAIL_OPTION_KEYS = [
    'width', 'height', 'fit', 'format', 'quality', 'timestamp', 'source', 'page',
];
const TEXT_WATERMARK_OPTION_KEYS = [
    'font_size', 'color', 'font_family', 'rotation', 'watermark_mode',
    'tile_spacing', 'anchor', 'margin_x', 'margin_y', 'opacity',
];
const WATERMARK_OPTION_KEYS = [
    'anchor', 'margin_x', 'margin_y', 'opacity', 'overlay_width',
];
const _convertKeysMatch = true;
const _thumbnailKeysMatch = true;
const _textWatermarkKeysMatch = true;
const _watermarkKeysMatch = true;
// Reference the assertions so `noUnusedLocals` doesn't strip them.
void _convertKeysMatch;
void _thumbnailKeysMatch;
void _textWatermarkKeysMatch;
void _watermarkKeysMatch;
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
};
