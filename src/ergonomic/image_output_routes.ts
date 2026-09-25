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
export const RESIZE_KEYS = ['width', 'height', 'fit'] as const;

/**
 * Options whose availability follows the INPUT format's raster capability, not
 * the output format — resize (`width`/`height`/`fit`) plus `auto_orient`. The
 * projection lists them on every `format_change` cell (keyed by OUTPUT), so on
 * a format change they must be re-gated against the INPUT's `same_format` cell:
 * a raster input carries them, an SVG (vector) input does not. Before rtkzl9gr
 * only the resize keys were input-gated, so `auto_orient` leaked onto the
 * `svg → raster` route and was rejected server-side.
 */
const INPUT_GATED_KEYS = [...RESIZE_KEYS, 'auto_orient'] as const;

/** Set form of {@link INPUT_GATED_KEYS} for `string`-keyed membership tests. */
const INPUT_GATED_KEY_SET: ReadonlySet<string> = new Set(INPUT_GATED_KEYS);

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
  /**
   * Accepted but INERT: the key is sent and the server takes it, but it has no
   * effect on this route (contract `inert_options`, `honored_on: []`). Today
   * only PNG `optimization_level`. Accepted, not refused: refusing would break
   * a caller the contract still admits.
   */
  readonly inert: readonly string[];
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
    avif: { honored: ['auto_orient', 'avif_speed', 'color_profile', 'encoding_mode', 'fit', 'height', 'metadata', 'output_format', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [], inert: [] },
    gif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [], inert: [] },
    jpeg: { honored: ['auto_orient', 'chroma_subsampling', 'color_profile', 'encoding_mode', 'fit', 'height', 'lossless', 'metadata', 'output_format', 'progressive', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [], inert: [] },
    png: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [], inert: ['optimization_level'] },
    svg: { honored: ['metadata', 'output_format'], planned: [], inert: [] },
    tiff: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'metadata', 'output_format', 'quality', 'width'], planned: [], inert: [] },
    webp: { honored: ['auto_orient', 'color_profile', 'encoding_mode', 'fit', 'height', 'lossless', 'metadata', 'output_format', 'quality', 'quality_preset', 'target_size_bytes', 'width'], planned: [], inert: [] },
  },
  format_change: {
    avif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'], inert: [] },
    gif: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'], inert: [] },
    jpeg: { honored: ['auto_orient', 'background', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'], inert: [] },
    png: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'], inert: [] },
    tiff: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'width'], planned: ['metadata'], inert: [] },
    webp: { honored: ['auto_orient', 'color_profile', 'fit', 'height', 'output_format', 'quality', 'width'], planned: ['metadata'], inert: [] },
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
  /** Accepted-but-inert option keys: sent, never refused, no effect. */
  readonly inert: ReadonlySet<string>;
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
      inert: new Set(cell.inert),
    };
  }
  const cell = IMAGE_OUTPUT_ROUTES.format_change[outToken];
  if (cell === undefined) return undefined;
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
    inert: new Set(cell.inert),
  };
}

/**
 * Input token → EVERY `compress.image*` mime-group that can carry a per-value
 * availability marker for it: the format-specific group when the metadata has one,
 * PLUS the generic `image` group. Most specific first.
 *
 * Both are needed, and the old single-group version lost one or the other whichever
 * way it chose (SB1wmTJz):
 * - The generic group carries CROSS-FORMAT markers — `color_profile: 'srgb'` is planned
 *   there and nowhere else, so a lookup that resolved only to `image_jpeg` never saw it.
 * - A specific group carries FORMAT-ONLY markers — `image_svg` marks
 *   `output_format: 'original'` planned (SVG→SVG optimisation is not built) and the
 *   generic group does not, so a lookup that resolved only to `image` never saw THAT.
 *
 * The previous implementation hard-coded `jpeg|png|avif` and fell through to `image`
 * with a trailing `// webp / gif / svg / tiff`. That comment was true when written and
 * silently stopped being true when `image_svg` and `image_webp` were added to the
 * metadata — so SVG inputs missed the one marker that mattered for them, on this gate
 * AND on the `output()` gate that shares it. Deriving the list from the metadata rather
 * than a hand-written token list is what stops it going stale a second time; the
 * mapping is pinned by `output-route-conformance.test.ts`.
 *
 * `gif`/`tiff` correctly yield `['image']` alone — the metadata genuinely has no
 * concrete group for them (verified against its actual key set, not inferred).
 */
function compressGroupsForToken(token: string): readonly string[] {
  // The historical mapping, PRESERVED EXACTLY. Every verdict it produced today must
  // keep being produced — see the note on additivity in `isPlannedValue`.
  const legacy =
    token === 'jpeg' ? 'image_jpeg' : token === 'png' ? 'image_png' : token === 'avif' ? 'image_avif' : 'image';
  const specific = `image_${token}`;
  return specific !== legacy && compressMetadata.mime_groups[specific] !== undefined
    ? [specific, legacy]
    : [legacy];
}

/**
 * Whether a specific VALUE of an option is `availability: 'planned'` for the
 * given input format — the per-value gate (e.g. `metadata: 'keep'` is planned
 * even though the `metadata` key is honored). Reads the generated
 * `compressMetadata` `per_value_availability`; same_format only (the only route
 * where value-level options like `metadata` are honored). Returns false when the
 * option / value / group is unknown (no gate).
 *
 * PURELY ADDITIVE (SB1wmTJz): planned if ANY consulted group marks this value planned.
 * The historical group is still consulted, so **every verdict this returned before still
 * holds** — the change can only turn a missed gate into a gate, never a gate into a
 * pass. That direction matters: a new false ACCEPT would send a request the server
 * rejects, which is the failure this function exists to prevent.
 *
 * Why not "most specific wins", which reads cleaner: it would flip `webp` +
 * `color_profile: 'srgb'` from gated to un-gated, because `image_webp` defines
 * `color_profile` with an empty `per_value_availability`. `RecipeOutputTest`
 * deliberately pins webp srgb as GATED (v2.134 added `srgb: planned` to the generic
 * group), and whether webp srgb actually works on the server is not something this
 * layer can know. Un-gating it on an inference would be exactly the "confident answer
 * from a check that could not tell you otherwise" pattern. Raised as a question instead.
 *
 * What this DOES fix: `image_svg` marks `output_format: 'original'` planned and the
 * generic group does not, so an SVG input previously sailed through the one marker that
 * mattered for it — on this gate and on the `output()` gate that shares it.
 */
export function isPlannedValue(inputToken: string, optionKey: string, value: unknown): boolean {
  for (const groupName of compressGroupsForToken(inputToken)) {
    const opt = compressMetadata.mime_groups[groupName]?.options[optionKey];
    if (opt?.per_value_availability[String(value)]?.availability === 'planned') return true;
  }
  return false;
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
export const COMPRESS_OPTION_VALUES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  image: { color_profile: ['keep', 'srgb', 'strip'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
  image_jpeg: { chroma_subsampling: ['420', '422', '444'], color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
  image_png: { color_profile: ['keep', 'srgb', 'strip'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
  image_avif: { color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
  image_svg: { metadata: ['strip', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'] },
  image_webp: { color_profile: ['keep', 'srgb', 'strip'], encoding_mode: ['quality', 'target_size', 'auto_quality'], fit: ['max', 'crop', 'scale'], metadata: ['strip', 'keep', 'all'], output_format: ['original', 'webp', 'auto', 'smallest'], quality_preset: ['best', 'good', 'fair', 'low'] },
} as const;

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
function enumGroupForToken(token: string): string {
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
export function isUnknownEnumValue(inputToken: string, optionKey: string, value: unknown): boolean {
  const members = COMPRESS_OPTION_VALUES[enumGroupForToken(inputToken)]?.[optionKey];
  if (members === undefined) return false;
  return !(typeof value === 'string' && members.includes(value));
}

/** A contract `depends_on` rule for a compress-image output option (ehHU08Hu). */
type OutputDependsOnRule =
  // scalar equality: the depended-on key must resolve to `requiresValue`
  // (contract shape `{ <key>: <value> }`, e.g. quality → { encoding_mode: quality }).
  | { readonly requiresKey: string; readonly requiresValue: string }
  // set/logic:or: at least ONE of `requiresAnyOf` must be present
  // (contract shape `{ k1: set, k2: set, logic: or }`, e.g. fit → width|height).
  | { readonly requiresAnyOf: readonly string[] };

/**
 * Contract `depends_on` per compress-image output option, mirroring
 * `availability.json` `operations.compress.mime_groups.<group>.options.<opt>.depends_on`
 * (ehHU08Hu). The rule is option-consistent across every image group that carries
 * the option, so this is a FLAT table (validated group-by-group by
 * `output-route-conformance.test.ts` / PHP `ImageOutputRouteConformanceTest`).
 *
 * Kept as a hand table — NOT a runtime read of the ~238KB availability sidecar —
 * so the gate stays browser-safe with no contracts-version coupling, exactly like
 * {@link COMPRESS_OPTION_VALUES}. Mirrored by PHP
 * `ImageOutputRoutes::OUTPUT_OPTION_DEPENDS_ON`.
 *
 * Generalises the 86gAu5Tr auto_quality gate: every option's dependency is
 * checked uniformly, so quality/lossless/target_size_bytes under `auto_quality`,
 * `target_size_bytes` without `target_size`, `fit` without width/height, etc. are
 * all rejected pre-upload instead of only the one hand-coded case.
 */
export const OUTPUT_OPTION_DEPENDS_ON: Readonly<Record<string, OutputDependsOnRule>> = {
  quality: { requiresKey: 'encoding_mode', requiresValue: 'quality' },
  lossless: { requiresKey: 'encoding_mode', requiresValue: 'quality' },
  quality_preset: { requiresKey: 'encoding_mode', requiresValue: 'auto_quality' },
  target_size_bytes: { requiresKey: 'encoding_mode', requiresValue: 'target_size' },
  fit: { requiresAnyOf: ['width', 'height'] },
};

/**
 * Default of each depended-on key — an ABSENT key resolves to this before the
 * dependency check (the server applies the same default). `encoding_mode`
 * defaults to `quality`, so `quality`/`lossless` are valid with no explicit mode,
 * but `target_size_bytes` / `quality_preset` are not. Pinned to `availability.json`
 * defaults by the conformance suite.
 */
export const DEPENDS_ON_KEY_DEFAULTS: Readonly<Record<string, string>> = {
  encoding_mode: 'quality',
};


/**
 * The first contract `depends_on` an already-lowered compress-image wire-option
 * set violates for the resolved `route`, or `undefined` when every dependency is
 * satisfied (ehHU08Hu). The caller ({@link Recipe} output lowering) throws
 * `invalid_option_combination` with the returned message + conflictingFields.
 * Only options PRESENT in `wireOptions` are checked; a scalar dependency reads
 * the depended-on key's effective value ({@link DEPENDS_ON_KEY_DEFAULTS} when
 * absent). A scalar (encoding_mode) dependency is skipped on a `format_change`
 * (convert has its own deps); universal deps (e.g. `fit → width|height`, identical
 * in compress + convert) run on BOTH routes. Mirrored by PHP
 * `ImageOutputRoutes::dependsOnViolation`.
 */
export function dependsOnViolation(
  wireOptions: Readonly<Record<string, unknown>>,
  route: 'same_format' | 'format_change',
): { readonly message: string; readonly conflictingFields: readonly string[] } | undefined {
  for (const [option, rule] of Object.entries(OUTPUT_OPTION_DEPENDS_ON)) {
    // A nullish value is NOT "set" — the contract `set` condition needs a real
    // value, and PHP drops null options before lowering, so treat null == absent
    // for parity (codex: `{ fit: 'max', width: null }` must reject, not bypass).
    if (wireOptions[option] == null) continue;
    if ('requiresAnyOf' in rule) {
      if (!rule.requiresAnyOf.some((key) => wireOptions[key] != null)) {
        return {
          conflictingFields: [option, ...rule.requiresAnyOf],
          message:
            `output(): '${option}' requires at least one of ${rule.requiresAnyOf.join(', ')} to be set ` +
            `(its contract dependency). Set ${rule.requiresAnyOf.join(' or ')}, or drop '${option}'.`,
        };
      }
      continue;
    }
    // Scalar deps in this (compress-image) table are all on `encoding_mode`, a
    // same_format optimiser key — validate them on same_format ONLY. The
    // universal requiresAnyOf dep (fit → width|height) above runs on BOTH routes.
    //
    // A format_change routes via `convert`, which has no encoding_mode and carries
    // its own deps — but those need NO table here (L2Ay7Uak, resolved as a no-op).
    // Every convert image dep is keyed on `output_format`, and the per-target
    // `honored` set the lowering already enforces IS that constraint materialised:
    // `output('gif', { quality: 80 })` is rejected by the honored gate, with a
    // better message, before this function runs. That equivalence is PINNED by
    // `output-route-conformance.test.ts` (+ the PHP mirror), which fails closed if
    // convert ever gains a dep keyed on something other than output_format — which
    // is the case that would genuinely need a gate here.
    if (route !== 'same_format') continue;
    const effective = wireOptions[rule.requiresKey] ?? DEPENDS_ON_KEY_DEFAULTS[rule.requiresKey];
    if (effective !== rule.requiresValue) {
      return {
        conflictingFields: [rule.requiresKey, option],
        message:
          `output(): '${option}' requires ${rule.requiresKey} '${rule.requiresValue}' (its contract ` +
          `dependency), but ${rule.requiresKey} is '${String(effective)}'. Set ${rule.requiresKey}: ` +
          `'${rule.requiresValue}', or drop '${option}'.`,
      };
    }
  }
  return undefined;
}
