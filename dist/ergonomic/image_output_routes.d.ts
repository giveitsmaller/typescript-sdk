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
/** The resize option keys — input-keyed, raster-only (see module doc). */
export declare const RESIZE_KEYS: readonly ["width", "height", "fit"];
/** Image area cap shared by every resizable route (projection `max_output_pixels`). */
export declare const MAX_OUTPUT_PIXELS = 16000000;
/**
 * Output formats reachable via the legacy `compress(output_format=…)` facade
 * (projection `facade_managed_outputs`). Used ONLY as the undetectable-input
 * fallback — a detectable input always routes via `source_op`.
 */
export declare const FACADE_MANAGED_OUTPUTS: readonly string[];
interface RouteCell {
    readonly honored: readonly string[];
    readonly planned: readonly string[];
}
/**
 * Per-route, per-output-format honored + planned option keys, mirroring
 * `image-output-routes.json` `media.image`. `source_op` is uniform
 * (same_format→compress, format_change→convert) so it is a derivation rule, not
 * a table column. `same_format` is keyed by the INPUT token; `format_change` by
 * the OUTPUT token.
 */
export declare const IMAGE_OUTPUT_ROUTES: {
    readonly same_format: Readonly<Record<string, RouteCell>>;
    readonly format_change: Readonly<Record<string, RouteCell>>;
};
export type OutputRoute = 'same_format' | 'format_change';
/** A resolved Output lowering target. */
export interface ResolvedOutputRoute {
    readonly route: OutputRoute;
    /** The wire op to emit. */
    readonly sourceOp: 'compress' | 'convert';
    /** The wire `output_format` value ('original' for same_format, the token for format_change). */
    readonly outputFormatWire: string;
    /** The input format token the route resolved against (for per-value gating). */
    readonly inputToken: string;
    /** Effective honored option keys (incl. input-keyed resize on format_change). */
    readonly honored: ReadonlySet<string>;
    /** Planned option keys → gate as `feature_not_available`. */
    readonly planned: ReadonlySet<string>;
}
/** The bare format token for a MIME type, or undefined if not a known image MIME. */
export declare function tokenForMime(mime: string): string | undefined;
/** The bare format token for a filename / path extension, or undefined. */
export declare function tokenForPath(path: string): string | undefined;
/** Every image format token the projection knows (for validation / tests). */
export declare function knownImageTokens(): ReadonlySet<string>;
/**
 * Resolve an Output request to its wire op + gating sets. Returns undefined when
 * the route is unrepresentable (e.g. converting TO a format no `format_change`
 * cell covers). `outputFormat` undefined → same-format (keep input format).
 */
export declare function resolveOutputRoute(inputToken: string, outputFormat: string | undefined): ResolvedOutputRoute | undefined;
/**
 * Whether a specific VALUE of an option is `availability: 'planned'` for the
 * given input format — the per-value gate (e.g. `metadata: 'keep'` is planned
 * even though the `metadata` key is honored). Reads the generated
 * `compressMetadata` `per_value_availability`; same_format only (the only route
 * where value-level options like `metadata` are honored). Returns false when the
 * option / value / group is unknown (no gate).
 */
export declare function isPlannedValue(inputToken: string, optionKey: string, value: unknown): boolean;
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
export declare const COMPRESS_OPTION_VALUES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
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
export declare function isUnknownEnumValue(inputToken: string, optionKey: string, value: unknown): boolean;
export {};
