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
 * **INPUT-keyed**: it lives only on the `same_format[input]` cell but applies on
 * EITHER route, gated by input resizability (raster only — `svg` is vector and
 * carries no resize). So a `png → webp + resize` request reads its resize
 * capability from `same_format.png` and its transcoder options from
 * `format_change.webp`.
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
export const RESIZE_KEYS = ['width', 'height', 'fit'] as const;

/** Image area cap shared by every resizable route (projection `max_output_pixels`). */
export const MAX_OUTPUT_PIXELS = 16_000_000;

/**
 * Output formats reachable via the legacy `compress(output_format=…)` facade
 * (projection `facade_managed_outputs`). Used ONLY as the undetectable-input
 * fallback — a detectable input always routes via `source_op`.
 */
export const FACADE_MANAGED_OUTPUTS: readonly string[] = ['webp'];

/** Canonical MIME → bare format token (projection `mime_tokens`). */
const MIME_TOKEN: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
};

/** File extension → bare format token (for path / named-blob inputs). */
const EXT_TOKEN: Readonly<Record<string, string>> = {
  jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg',
  png: 'png', webp: 'webp', gif: 'gif', avif: 'avif',
  tif: 'tiff', tiff: 'tiff', svg: 'svg',
};

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
export const IMAGE_OUTPUT_ROUTES: {
  readonly same_format: Readonly<Record<string, RouteCell>>;
  readonly format_change: Readonly<Record<string, RouteCell>>;
} = {
  same_format: {
    avif: { honored: ['avif_speed', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
    gif: { honored: ['fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
    jpeg: { honored: ['fit', 'height', 'lossless', 'metadata', 'output_format', 'progressive', 'quality', 'width'], planned: [] },
    png: { honored: ['fit', 'height', 'metadata', 'optimization_level', 'output_format', 'quality', 'width'], planned: ['lossy'] },
    svg: { honored: ['metadata', 'output_format', 'quality'], planned: [] },
    tiff: { honored: ['fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
    webp: { honored: ['fit', 'height', 'lossless', 'metadata', 'output_format', 'quality', 'width'], planned: [] },
  },
  format_change: {
    avif: { honored: ['output_format', 'quality'], planned: [] },
    gif: { honored: ['output_format'], planned: [] },
    jpeg: { honored: ['background', 'output_format', 'quality'], planned: [] },
    png: { honored: ['output_format'], planned: [] },
    tiff: { honored: ['output_format'], planned: [] },
    webp: { honored: ['output_format', 'quality'], planned: [] },
  },
} as const;

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
export function tokenForMime(mime: string): string | undefined {
  return MIME_TOKEN[mime.split(';')[0]!.trim().toLowerCase()];
}

/** The bare format token for a filename / path extension, or undefined. */
export function tokenForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split('.').pop();
  return ext !== undefined ? EXT_TOKEN[ext] : undefined;
}

/** Every image format token the projection knows (for validation / tests). */
export function knownImageTokens(): ReadonlySet<string> {
  return new Set(Object.keys(IMAGE_OUTPUT_ROUTES.same_format));
}

/**
 * Resolve an Output request to its wire op + gating sets. Returns undefined when
 * the route is unrepresentable (e.g. converting TO a format no `format_change`
 * cell covers). `outputFormat` undefined → same-format (keep input format).
 */
export function resolveOutputRoute(
  inputToken: string,
  outputFormat: string | undefined,
): ResolvedOutputRoute | undefined {
  const outToken = outputFormat ?? inputToken;
  if (outToken === inputToken) {
    const cell = IMAGE_OUTPUT_ROUTES.same_format[inputToken];
    if (cell === undefined) return undefined;
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
  if (cell === undefined) return undefined;
  // Input-keyed resize: the format_change cell carries only transcoder options;
  // resize capability comes from the INPUT's same_format cell (raster only).
  const inCell = IMAGE_OUTPUT_ROUTES.same_format[inputToken];
  const resize = inCell ? RESIZE_KEYS.filter((k) => inCell.honored.includes(k)) : [];
  return {
    route: 'format_change',
    sourceOp: 'convert',
    outputFormatWire: outToken,
    inputToken,
    honored: new Set([...cell.honored, ...resize]),
    planned: new Set(cell.planned),
  };
}

/** Input token → its `compress.image*` mime-group name (for per-value availability lookup). */
function compressGroupForToken(token: string): string {
  if (token === 'jpeg') return 'image_jpeg';
  if (token === 'png') return 'image_png';
  if (token === 'avif') return 'image_avif';
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
export function isPlannedValue(inputToken: string, optionKey: string, value: unknown): boolean {
  const group = compressMetadata.mime_groups[compressGroupForToken(inputToken)];
  const opt = group?.options[optionKey];
  if (opt === undefined) return false;
  const entry = opt.per_value_availability[String(value)];
  return entry?.availability === 'planned';
}
