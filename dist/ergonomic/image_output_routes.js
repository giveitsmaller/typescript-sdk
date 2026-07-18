/**
 * Route-aware image "Output" model (card YNLrGhNo, contracts tewB37Jg / v2.97.0).
 *
 * The file-first `output()`/`resize()` helpers resolve a single user-facing
 * "Output" operation to the right underlying wire op + options, driven by the
 * contract's `accepted-options/image-output-routes.json` projection. The route is
 * `(input format token, output_format token)`:
 *   - `same_format` (output == input) → `source_op: compress` (libcaesium optimiser),
 *     wire `output_format: 'original'`;
 *   - `format_change` (output != input) → `source_op: convert` (transcoder),
 *     wire `output_format: <token>`.
 *
 * Each route cell lists the options the worker HONORS (live) and PLANS (advertised,
 * not yet honored — gated unavailable). Resize (`width`/`height`/`fit`) is
 * **INPUT-gated**: since v2.103.0 convert is the resize engine, so the projection
 * lists resize on every `format_change` cell too — but resizability is keyed to the
 * INPUT (raster only — `svg` is vector and carries no resize). The lowering reads
 * resize capability from `same_format[input]` on BOTH routes, so a `png → webp +
 * resize` request resizes (png is raster) while an `svg → png + resize` request
 * does NOT (svg's same_format cell has no resize keys).
 *
 * This hand table MIRRORS the generated projection and is PINNED to it by
 * `output-route-conformance.test.ts` (the watermark-capability-gate precedent) —
 * a contract regen that changes a route's source_op / honored / planned options
 * fails that test. Kept a hand table (not a runtime JSON read) so the gate is
 * browser-safe, exactly like {@link WATERMARK_CAPABILITY}. Mirrored by the PHP
 * `ImageOutputRoutes`.
 */
import { compressMetadata } from '@giveitsmaller/contracts/operations';
/** The resize option keys — input-keyed, raster-only (see module doc). */
export const RESIZE_KEYS = ['width', 'height', 'fit'];
/**
 * Options whose availability follows the INPUT format's raster capability, not
 * the output format — resize (`width`/`height`/`fit`) plus `auto_orient`. The
 * projection lists them on every `format_change` cell (keyed by OUTPUT), so on
 * a format change they must be re-gated against the INPUT's `same_format` cell:
 * a raster input carries them, an SVG (vector) input does not. Before rtkzl9gr
 * only the resize keys were input-gated, so `auto_orient` leaked onto the
 * `svg → raster` route and was rejected server-side.
 */
const INPUT_GATED_KEYS = [...RESIZE_KEYS, 'auto_orient'];
/** Set form of {@link INPUT_GATED_KEYS} for `string`-keyed membership tests. */
const INPUT_GATED_KEY_SET = new Set(INPUT_GATED_KEYS);
/** Image area cap shared by every resizable route (projection `max_output_pixels`). */
export const MAX_OUTPUT_PIXELS = 16_000_000;
/**
 * Output formats reachable via the legacy `compress(output_format=…)` facade
 * (projection `facade_managed_outputs`). Used ONLY as the undetectable-input
 * fallback — a detectable input always routes via `source_op`.
 */
export const FACADE_MANAGED_OUTPUTS = ['webp'];
/** Canonical MIME → bare format token (projection `mime_tokens`). */
const MIME_TOKEN = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
};
/** File extension → bare format token (for path / named-blob inputs). */
const EXT_TOKEN = {
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg',
    png: 'png', webp: 'webp', gif: 'gif', avif: 'avif',
    tif: 'tiff', tiff: 'tiff', svg: 'svg',
};
/**
 * Per-route, per-output-format honored + planned option keys, mirroring
 * `image-output-routes.json` `media.image`. `source_op` is uniform
 * (same_format→compress, format_change→convert) so it is a derivation rule, not
 * a table column. `same_format` is keyed by the INPUT token; `format_change` by
 * the OUTPUT token.
 */
export const IMAGE_OUTPUT_ROUTES = {
    same_format: {
        avif: { honored: ['auto_orient', 'avif_speed', 'color_profile', 'encoding_mode', 'fit', 'height', 'metadata', 'output_format', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [] },
        gif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
        jpeg: { honored: ['auto_orient', 'chroma_subsampling', 'color_profile', 'encoding_mode', 'fit', 'height', 'lossless', 'metadata', 'output_format', 'progressive', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [] },
        png: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'optimization_level', 'output_format', 'quality', 'width'], planned: [] },
        svg: { honored: ['metadata', 'output_format'], planned: [] },
        tiff: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
        webp: { honored: ['auto_orient', 'color_profile', 'encoding_mode', 'fit', 'height', 'lossless', 'metadata', 'output_format', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [] },
    },
    format_change: {
        avif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'] },
        gif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'] },
        jpeg: { honored: ['auto_orient', 'background', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'] },
        png: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'] },
        tiff: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'] },
        webp: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'] },
    },
};
/** The bare format token for a MIME type, or undefined if not a known image MIME. */
export function tokenForMime(mime) {
    return MIME_TOKEN[mime.split(';')[0].trim().toLowerCase()];
}
/** The bare format token for a filename / path extension, or undefined. */
export function tokenForPath(path) {
    const ext = path.toLowerCase().split('.').pop();
    return ext !== undefined ? EXT_TOKEN[ext] : undefined;
}
/** Every image format token the projection knows (for validation / tests). */
export function knownImageTokens() {
    return new Set(Object.keys(IMAGE_OUTPUT_ROUTES.same_format));
}
/**
 * Resolve an Output request to its wire op + gating sets. Returns undefined when
 * the route is unrepresentable (e.g. converting TO a format no `format_change`
 * cell covers). `outputFormat` undefined → same-format (keep input format).
 */
export function resolveOutputRoute(inputToken, outputFormat) {
    const outToken = outputFormat ?? inputToken;
    if (outToken === inputToken) {
        const cell = IMAGE_OUTPUT_ROUTES.same_format[inputToken];
        if (cell === undefined)
            return undefined;
        return {
            route: 'same_format',
            sourceOp: 'compress',
            outputFormatWire: 'original',
            inputToken,
            honored: new Set(cell.honored),
            planned: new Set(cell.planned),
        };
    }
    const cell = IMAGE_OUTPUT_ROUTES.format_change[outToken];
    if (cell === undefined)
        return undefined;
    // Resize + auto_orient are INPUT-gated (see {@link INPUT_GATED_KEYS}). Since
    // v2.103.0 convert is the resize engine, so the projection lists width/height/
    // fit AND auto_orient on EVERY format_change cell — but an SVG INPUT cannot be
    // raster-resized or auto-oriented (the convert worker rejects it). So strip
    // the cell's input-gated keys and re-add only those the INPUT's same_format
    // cell honors: raster inputs carry them, svg does not. The transcoder options
    // (output_format/quality/background/color_profile) ride the cell directly.
    const transcoderHonored = cell.honored.filter((k) => !INPUT_GATED_KEY_SET.has(k));
    const inCell = IMAGE_OUTPUT_ROUTES.same_format[inputToken];
    const inputGated = inCell ? INPUT_GATED_KEYS.filter((k) => inCell.honored.includes(k)) : [];
    return {
        route: 'format_change',
        sourceOp: 'convert',
        outputFormatWire: outToken,
        inputToken,
        honored: new Set([...transcoderHonored, ...inputGated]),
        planned: new Set(cell.planned),
    };
}
/** Input token → its `compress.image*` mime-group name (for per-value availability lookup). */
function compressGroupForToken(token) {
    if (token === 'jpeg')
        return 'image_jpeg';
    if (token === 'png')
        return 'image_png';
    if (token === 'avif')
        return 'image_avif';
    return 'image'; // webp / gif / svg / tiff
}
/**
 * Whether a specific VALUE of an option is `availability: 'planned'` for the
 * given input format — the per-value gate (e.g. `metadata: 'keep'` is planned
 * even though the `metadata` key is honored). Reads the generated
 * `compressMetadata` `per_value_availability`; same_format only (the only route
 * where value-level options like `metadata` are honored). Returns false when the
 * option / value / group is unknown (no gate).
 */
export function isPlannedValue(inputToken, optionKey, value) {
    const group = compressMetadata.mime_groups[compressGroupForToken(inputToken)];
    const opt = group?.options[optionKey];
    if (opt === undefined)
        return false;
    const entry = opt.per_value_availability[String(value)];
    return entry?.availability === 'planned';
}
/**
 * Compress-route enum members per image mime-group, mirroring the shipped
 * `availability/availability.json` `operations.compress.mime_groups.<group>.
 * options.<opt>.values`. Kept as a hand table (NOT a runtime read of the ~238KB
 * availability sidecar) so the enum-membership gate stays browser-safe, exactly
 * like {@link IMAGE_OUTPUT_ROUTES} — and, crucially, so the gate has NO
 * dependency on a contracts version that carries the enum in a compact form (a
 * generated-metadata `values` field would fail open on an older published
 * `@giveitsmaller/contracts`). PINNED to `availability.json` by
 * `output-route-conformance.test.ts`; a contract regen that adds/changes an
 * enum member fails there. Mirrored by PHP `ImageOutputRoutes::COMPRESS_OPTION_VALUES`.
 *
 * `image_svg`/`image_avif` carry the NARROW `metadata: ['strip','all']` (no
 * `keep`) — the reason a value gate that consulted only the generic `image`
 * group (`['strip','keep','all']`) let `metadata: 'keep'` reach a server 422 on
 * those bases (rtkzl9gr). `output_format` is listed for a faithful projection
 * mirror but is never gated here (the Output lowering owns it positionally).
 */
export const COMPRESS_OPTION_VALUES = {
    image: { color_profile: ['keep', 'srgb', 'strip'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
    image_jpeg: { chroma_subsampling: ['420', '422', '444'], color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
    image_png: { color_profile: ['keep', 'srgb', 'strip'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
    image_avif: { color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
    image_svg: { metadata: ['strip', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
    image_webp: { color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
};
/**
 * The compress mime-group whose enum members are authoritative for an image
 * token's SAME_FORMAT route — the exact `image_<token>` group when
 * {@link COMPRESS_OPTION_VALUES} carries one, else the generic `image` group
 * (gif/tiff).
 *
 * Deliberately DISTINCT from {@link compressGroupForToken} (which the planned
 * gate uses). The planned gate routes webp/gif/svg/tiff through the generic
 * `image` group, where cross-format `planned` markers live (e.g. `srgb`).
 * Enum MEMBERSHIP is the opposite: it needs the format-specific enum, because
 * `image_svg`'s `metadata` enum is the narrow `[strip, all]` while the generic
 * group's is `[strip, keep, all]` — so only the specific group rejects
 * `metadata: 'keep'` on SVG (and AVIF, which already maps specifically).
 */
function enumGroupForToken(token) {
    const specific = `image_${token}`;
    return COMPRESS_OPTION_VALUES[specific] !== undefined ? specific : 'image';
}
/**
 * Whether a VALUE lies OUTSIDE the option's compress-route enum for the given
 * input format — the pre-upload enum-membership gate (rtkzl9gr). Reads the hand
 * {@link COMPRESS_OPTION_VALUES} table. Returns false when the option is not an
 * enum on this group (no entry), so a non-enum option (e.g. integer `quality`)
 * is never gated. Meaningful only on the same_format (compress) route, where
 * the compress option enums definitionally apply. Membership is STRICT: a value
 * whose type differs from the string enum members (e.g. numeric `420`) is
 * treated as unknown rather than coerced to a match.
 */
export function isUnknownEnumValue(inputToken, optionKey, value) {
    const members = COMPRESS_OPTION_VALUES[enumGroupForToken(inputToken)]?.[optionKey];
    if (members === undefined)
        return false;
    return !(typeof value === 'string' && members.includes(value));
}
