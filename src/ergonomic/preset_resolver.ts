// T4b — compress preset resolver (ticket 27rE1fZn).
//
// Walks five precedence layers (low → high) for a single compress
// operation call and emits both:
//   - `wireOptions` — snake_case payload ready to drop into the operation
//                     argument the low-level SDK sends on the wire.
//   - `resolvedOptions` — debug projection: which layer contributed each
//                         field, plus presetVersion + optional
//                         presetConfigHash.
//
// Layer order (lowest precedence first; later layers overwrite earlier):
//   1. `*PresetOptions.shippedDefaultsFor(optimize)` — SDK defaults from
//      F3 PRESETS. Skipped entirely when `optimize` is unset.
//   2. `client.presetDefaults.cellFor(media, op, optimize)` — caller-side
//      defaults registered via `presetDefaults()...` and passed into
//      `gisl.create({ presetDefaults: ... })`.
//   3. Scoped layer (reserved for T4c — `withPresetDefaults` derive).
//      Always empty in T4b; the slot exists so T4c is a pure addition.
//   4. Per-call `presetOverrides` argument.
//   5. Explicit per-call knobs (existing operation argument fields —
//      `quality: 100`, `codec: 'h264'`, …).
//
// Validation runs AFTER merge so post-merge-only invariants
// (targetSize + codec, Lossless + quality) catch combinations where
// e.g. the explicit knob and a layered default disagree. Resolver
// throws `GislConfigError` BEFORE any network round-trip, with a
// `resolvedSnapshot` showing the would-have-been-sent payload.
//
// `targetSize` on video accepts:
//   - integer bytes (>=0) — passed through raw
//   - case-insensitive string with B / KB / MB / GB / TB suffix —
//     BINARY multipliers (1 KB = 1024, 1 MB = 2^20, …). User-pinned
//     2026-05-28 (see memory targetsize-unit-decision); matches the
//     plan's canonical example and the contract minimum.
// On a parse, the resolver also writes `encoding_mode='target_size'`
// to the wire; conversely if `crf` is explicit, `encoding_mode='crf'`.

import { createHash } from 'node:crypto';

import { GislConfigError } from '../errors.js';
import type { ResolvedOptions, ResolvedOptionsSources } from '../builder.js';
import type { OptimizeFor } from '../generated/sdk_spec/enums.js';
import {
  ImageCompressPresetOptions,
  AudioCompressPresetOptions,
  VideoCompressPresetOptions,
  DocumentPdfCompressPresetOptions,
  DocumentOfficeCompressPresetOptions,
  DocumentOdfCompressPresetOptions,
  DocumentEpubCompressPresetOptions,
  type PresetDefaults,
  type PresetMedia,
  type PresetOp,
} from './presets/index.js';

/** Bumped on any change to a `*PresetOptions.shippedDefaultsFor(...)` cell value. */
export const PRESET_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Wire-field alias map (declarative — NOT generic toSnakeCase).
// ---------------------------------------------------------------------------
//
// Lifted from docs/plans/sdk-ergonomics/plan.md §11a. Maps camelCase
// ergonomic-DTO field names to their snake_case wire counterparts.
// Fields whose ergonomic name IS the wire name (`mode`, `quality`,
// `codec`, …) are NOT in this map — `applyAlias` returns them
// unchanged. A generic snake-case regex would mistranslate names like
// `iccProfile` to `i_c_c_profile`; the declarative map is the only
// safe path.

const WIRE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  iccProfile: 'icc_profile',
  autoOrient: 'auto_orient',
  outputFormat: 'output_format',
  sampleRate: 'sample_rate',
  audioCodec: 'audio_codec',
  audioBitrate: 'audio_bitrate',
  flattenForms: 'flatten_forms',
  imageQuality: 'image_quality',
  stripMacros: 'strip_macros',
  stripHiddenData: 'strip_hidden_data',
  stripUnusedFonts: 'strip_unused_fonts',
  stripMetadata: 'strip_metadata',
  stripUnusedStyles: 'strip_unused_styles',
  fontSubsetting: 'font_subsetting',
  stripUnusedCss: 'strip_unused_css',
  // `targetSize` is a resolver-only ergonomic field — translated below
  // into `target_size_bytes` + `encoding_mode`. Don't emit it under
  // its own snake form.
});

function applyAlias(camelKey: string): string {
  return WIRE_ALIASES[camelKey] ?? camelKey;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link resolveCompressOptions}. `media` selects which leaf
 * DTO drives sdkDefault + clientDefault lookups + invalid-combo
 * validations. `op` is currently always `'compress'`; future ops will
 * extend the union.
 */
export interface ResolveCompressOptionsInput {
  readonly media: PresetMedia;
  readonly op: PresetOp;
  /** Defaults registered via `gisl.create({ presetDefaults: ... })`. */
  readonly presetDefaults?: PresetDefaults;
  /** Per-call `presetOverrides` argument from the operation builder. */
  readonly presetOverrides?: Readonly<Record<string, unknown>>;
  /**
   * `optimize` selects the preset level. When unset, NO shipped
   * defaults apply (resolver layer 1 contributes nothing); the
   * resulting `resolvedOptions.preset` is `null`.
   */
  readonly optimize?: OptimizeFor;
  /**
   * Explicit per-call knobs the caller passed alongside `optimize` —
   * e.g. `{ autoOrient: true }`. These are the highest-precedence
   * layer.
   */
  readonly explicitOptions: Readonly<Record<string, unknown>>;
}

/**
 * Output of {@link resolveCompressOptions}. `wireOptions` is the
 * snake_case payload ready for the operation argument; `resolvedOptions`
 * is the introspection projection surfaced on `Result.resolvedOptions`.
 */
export interface ResolveCompressOptionsOutput {
  readonly wireOptions: Record<string, unknown>;
  readonly resolvedOptions: ResolvedOptions;
}

// ---------------------------------------------------------------------------
// targetSize parser
// ---------------------------------------------------------------------------

const TARGET_SIZE_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
});

/**
 * Parse a `targetSize` value into a positive integer byte count.
 *
 * - Integer input passes through after non-negative + finite checks.
 * - String input must match `<number><unit?>` with unit in
 *   `B|KB|MB|GB|TB` (case-insensitive). Multipliers are BINARY
 *   (1 KB = 1024). Decimal fractions allowed in the magnitude
 *   (`'1.5GB'` → `1.5 * 2^30` rounded down to integer bytes).
 *
 * Throws {@link GislConfigError} with `reason: 'invalid_target_size'`
 * on any other input — including negative numbers, infinities, missing
 * magnitude, unknown unit, or zero magnitude.
 *
 * @internal — exported for unit tests.
 */
export function _parseTargetSize(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new GislConfigError(
        `targetSize integer must be a positive whole byte count; got ${String(value)}.`,
        {
          reason: 'invalid_target_size',
          conflictingFields: ['targetSize'],
          suggestion: 'Pass a positive integer or a suffixed string like "50MB".',
        },
      );
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new GislConfigError(
      `targetSize must be a positive integer (bytes) or a string like "50MB"; got ${typeof value}.`,
      {
        reason: 'invalid_target_size',
        conflictingFields: ['targetSize'],
        suggestion: 'Pass a positive integer or a suffixed string like "50MB".',
      },
    );
  }

  const trimmed = value.trim();
  // Case-insensitive: `^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$` (unit
  // optional → defaults to B).
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/.exec(trimmed);
  if (match === null) {
    throw new GislConfigError(
      `targetSize string '${value}' is not a valid size — expected '<number><B|KB|MB|GB|TB>'.`,
      {
        reason: 'invalid_target_size',
        conflictingFields: ['targetSize'],
        suggestion: "Use '50MB', '1.5GB', or a raw integer byte count.",
      },
    );
  }
  const magnitudeStr = match[1] as string;
  const unitStr = match[2] === undefined ? 'B' : match[2].toUpperCase();
  if (!Object.hasOwn(TARGET_SIZE_MULTIPLIERS, unitStr)) {
    throw new GislConfigError(
      `targetSize unit '${match[2] ?? ''}' is not recognised — expected B / KB / MB / GB / TB.`,
      {
        reason: 'invalid_target_size',
        conflictingFields: ['targetSize'],
        suggestion: 'Use one of B / KB / MB / GB / TB (binary; 1 KB = 1024).',
      },
    );
  }
  const magnitude = Number.parseFloat(magnitudeStr);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new GislConfigError(
      `targetSize magnitude '${magnitudeStr}' must be a positive number.`,
      {
        reason: 'invalid_target_size',
        conflictingFields: ['targetSize'],
      },
    );
  }
  const bytes = Math.floor(magnitude * TARGET_SIZE_MULTIPLIERS[unitStr]!);
  if (bytes <= 0) {
    throw new GislConfigError(
      `targetSize '${value}' resolves to zero bytes after binary multiplication.`,
      {
        reason: 'invalid_target_size',
        conflictingFields: ['targetSize'],
      },
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Per-media DTO accessors
// ---------------------------------------------------------------------------
//
// Three things change per (media, op) tuple: which `*PresetOptions`
// leaf supplies sdkDefaults, the typed shape of the `presetOverrides`
// argument, and the cellFor() return type. T4b only ships `compress`;
// future ops will append rows here.

function sdkDefaultRecord(media: PresetMedia, op: PresetOp, optimize: OptimizeFor): Readonly<Record<string, unknown>> {
  if (op !== 'compress') {
    throw new GislConfigError(
      `Preset resolution is only wired for compress operations today; got op='${op}'.`,
      { reason: 'unsupported_op' },
    );
  }
  switch (media) {
    case 'image':
      return { ...ImageCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'audio':
      return { ...AudioCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'video':
      return { ...VideoCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'document_pdf':
      return { ...DocumentPdfCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'document_office':
      return { ...DocumentOfficeCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'document_odf':
      return { ...DocumentOdfCompressPresetOptions.shippedDefaultsFor(optimize) };
    case 'document_epub':
      return { ...DocumentEpubCompressPresetOptions.shippedDefaultsFor(optimize) };
  }
}

function clientDefaultRecord(
  defaults: PresetDefaults | undefined,
  media: PresetMedia,
  op: PresetOp,
  optimize: OptimizeFor,
): Readonly<Record<string, unknown>> | undefined {
  if (defaults === undefined) return undefined;
  if (op !== 'compress') return undefined;
  // Each overload returns `<Specific>PresetOptions | undefined`. We
  // erase the per-media type at runtime by spreading the instance
  // into a plain Record. `cellFor` returns `undefined` when no delta
  // was registered for the tuple — the resolver treats that the same
  // as "this layer did not participate."
  let cell;
  switch (media) {
    case 'image':
      cell = defaults.cellFor('image', 'compress', optimize);
      break;
    case 'audio':
      cell = defaults.cellFor('audio', 'compress', optimize);
      break;
    case 'video':
      cell = defaults.cellFor('video', 'compress', optimize);
      break;
    case 'document_pdf':
      cell = defaults.cellFor('document_pdf', 'compress', optimize);
      break;
    case 'document_office':
      cell = defaults.cellFor('document_office', 'compress', optimize);
      break;
    case 'document_odf':
      cell = defaults.cellFor('document_odf', 'compress', optimize);
      break;
    case 'document_epub':
      cell = defaults.cellFor('document_epub', 'compress', optimize);
      break;
  }
  if (cell === undefined) return undefined;
  return { ...cell };
}

// ---------------------------------------------------------------------------
// presetOverrides type-mismatch detection
// ---------------------------------------------------------------------------
//
// The caller passes `presetOverrides: ImageCompressPresetOptionsInput`
// (a plain object), `VideoCompressPresetOptionsInput`, etc. We check
// for class instances (where the call site used `Image.from(...)`) AND
// for clearly-typed plain objects whose key set only intersects with a
// non-matching media.

const MEDIA_FIELDS: Readonly<Record<PresetMedia, ReadonlySet<string>>> = Object.freeze({
  image: new Set(['mode', 'quality', 'width', 'height', 'fit', 'metadata', 'iccProfile', 'autoOrient', 'progressive', 'outputFormat']),
  audio: new Set(['bitrate', 'channels', 'sampleRate', 'normalize']),
  video: new Set(['codec', 'targetSize', 'crf', 'preset', 'width', 'height', 'fit', 'fps', 'faststart', 'audioCodec', 'audioBitrate']),
  document_pdf: new Set(['profile', 'colorspace', 'flattenForms']),
  document_office: new Set(['imageQuality', 'stripMacros', 'stripHiddenData', 'stripUnusedFonts']),
  document_odf: new Set(['imageQuality', 'stripMetadata', 'stripUnusedStyles']),
  document_epub: new Set(['imageQuality', 'fontSubsetting', 'stripUnusedCss']),
});

function detectMismatchedOverrides(
  media: PresetMedia,
  overrides: Readonly<Record<string, unknown>>,
): void {
  const expected = MEDIA_FIELDS[media];
  const keys = Object.keys(overrides);
  // Empty override is fine — equivalent to "register no per-call delta."
  if (keys.length === 0) return;
  // If EVERY key in overrides is recognised for the operation's media,
  // we accept it. If ALL keys belong to a different media, we throw a
  // type_mismatch. If keys mix recognised + unrecognised, the
  // unknown_field validation downstream will catch the strays.
  const unknownFields = keys.filter((k) => !expected.has(k));
  if (unknownFields.length === 0) return;
  // Look up which OTHER media owns every unknown field — if a single
  // OTHER media's field set covers them all, that's a type_mismatch.
  for (const otherMedia of Object.keys(MEDIA_FIELDS) as PresetMedia[]) {
    if (otherMedia === media) continue;
    const otherSet = MEDIA_FIELDS[otherMedia];
    if (unknownFields.every((k) => otherSet.has(k))) {
      // PascalCase every underscore-separated segment so multi-segment
      // media (`document_pdf` → `DocumentPdf…`) emit the actual exported
      // class name (code-review MEDIUM: previously emitted
      // `Documentpdf…` which doesn't resolve in user code).
      const className =
        otherMedia
          .split('_')
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join('') + 'CompressPresetOptionsInput';
      throw new GislConfigError(
        `presetOverrides for operation media '${media}' contained fields from '${otherMedia}': ${unknownFields.join(', ')}.`,
        {
          reason: 'type_mismatch',
          conflictingFields: unknownFields,
          suggestion: `Pass an ${className} shape, or use the matching builder method.`,
        },
      );
    }
  }
  // Otherwise the unknown fields are nonsense — fall through to the
  // unknown_field validation that runs against the merged record.
}

// ---------------------------------------------------------------------------
// Deep-merge with provenance tracking
// ---------------------------------------------------------------------------

const SOURCE_KEYS = ['sdkDefault', 'clientDefault', 'scopedDefault', 'callPresetOverride', 'explicit'] as const;
type SourceKey = typeof SOURCE_KEYS[number];

interface MergeAccumulator {
  readonly merged: Record<string, unknown>;
  /** wire-side (snake_case) field name -> the source that last set it. */
  readonly winners: Map<string, SourceKey>;
}

function mergeLayer(
  acc: MergeAccumulator,
  layer: Readonly<Record<string, unknown>> | undefined,
  source: SourceKey,
): void {
  if (layer === undefined) return;
  for (const camelKey of Object.keys(layer)) {
    const value = layer[camelKey];
    if (value === undefined) continue;
    const wireKey = applyAlias(camelKey);
    acc.merged[wireKey] = value;
    acc.winners.set(wireKey, source);
  }
}

// ---------------------------------------------------------------------------
// Validations on the merged wire payload
// ---------------------------------------------------------------------------

const KNOWN_WIRE_FIELDS: Readonly<Record<PresetMedia, ReadonlySet<string>>> = Object.freeze({
  image: new Set(['mode', 'quality', 'width', 'height', 'fit', 'metadata', 'icc_profile', 'auto_orient', 'progressive', 'output_format']),
  audio: new Set(['bitrate', 'channels', 'sample_rate', 'normalize', 'trim_start', 'trim_end']),
  video: new Set(['codec', 'encoding_mode', 'crf', 'target_size_bytes', 'preset', 'width', 'height', 'fit', 'fps', 'faststart', 'audio_codec', 'audio_bitrate', 'trim_start', 'trim_end']),
  document_pdf: new Set(['profile', 'colorspace', 'pages', 'flatten_forms']),
  document_office: new Set(['image_quality', 'strip_macros', 'strip_hidden_data', 'strip_unused_fonts']),
  document_odf: new Set(['image_quality', 'strip_metadata', 'strip_unused_styles']),
  document_epub: new Set(['image_quality', 'font_subsetting', 'strip_unused_css']),
});

function validateMerged(
  media: PresetMedia,
  merged: Record<string, unknown>,
  explicitKeys: ReadonlySet<string>,
  winners: Map<string, SourceKey>,
): void {
  // Unknown-field defence-in-depth: every key must belong to the
  // media's wire surface OR be one of the resolver-derived wire keys
  // (target_size_bytes / encoding_mode for video). `targetSize` itself
  // never reaches `merged` — it is consumed by the resolver before
  // emission.
  const known = KNOWN_WIRE_FIELDS[media];
  for (const key of Object.keys(merged)) {
    if (!known.has(key)) {
      const snapshot = { ...merged };
      throw new GislConfigError(
        `Resolved wire payload contains unknown field '${key}' for media '${media}'.`,
        {
          reason: 'unknown_field',
          conflictingFields: [key],
          resolvedSnapshot: Object.freeze(snapshot),
        },
      );
    }
  }

  // Image: `mode: Lossless` + `quality` set is invalid per the wire
  // contract (`depends_on: { mode: lossy }`). Runs on post-merge so a
  // caller passing explicit `quality` and inheriting `mode=Lossless`
  // from a client preset is caught.
  if (media === 'image' && merged.mode === 'lossless' && merged.quality !== undefined) {
    const snapshot = { ...merged };
    throw new GislConfigError(
      `Image compress: 'quality' is ignored when 'mode' is Lossless — passing both is a configuration bug.`,
      {
        reason: 'missing_dependency',
        conflictingFields: ['quality', 'mode'],
        resolvedSnapshot: Object.freeze(snapshot),
        suggestion: "Either drop 'quality' for lossless output, or set 'mode' to Lossy.",
      },
    );
  }

  // Video: targetSize-derived encoding_mode='target_size' is only
  // valid for H264 today. Catch the combination post-merge — explicit
  // codec overrides a layered default and either resolution must end
  // up at h264.
  if (media === 'video' && merged.encoding_mode === 'target_size') {
    if (merged.codec !== undefined && merged.codec !== 'h264') {
      const snapshot = { ...merged };
      throw new GislConfigError(
        `Video compress: 'targetSize' only supports codec 'h264' today; resolved codec is '${String(merged.codec)}'.`,
        {
          reason: 'invalid_combination',
          conflictingFields: ['targetSize', 'codec'],
          resolvedSnapshot: Object.freeze(snapshot),
          suggestion: "Either use codec H264, or drop targetSize and use crf instead.",
        },
      );
    }
    // Mutual exclusion with explicit crf — the EXPLICIT layer is the
    // one that conflicts. If crf came in only from a lower layer it
    // would have been overwritten by encoding_mode='target_size' (and
    // we strip it below).
    if (explicitKeys.has('crf')) {
      const snapshot = { ...merged };
      throw new GislConfigError(
        `Video compress: 'targetSize' and 'crf' are mutually exclusive encoding modes.`,
        {
          reason: 'invalid_combination',
          conflictingFields: ['targetSize', 'crf'],
          resolvedSnapshot: Object.freeze(snapshot),
          suggestion: 'Choose one — drop targetSize to use crf, or drop crf to use targetSize.',
        },
      );
    }
    // crf coming from a lower layer is silently dropped since
    // encoding_mode='target_size' supersedes it. Caller signal is now
    // the audit trail — keep `applied` and `sources.*` consistent
    // (code-review HIGH: orphaned winners entry would surface a
    // phantom crf contribution in the source buckets when the field
    // was actually stripped from the wire — caught by the
    // R1-regression test on PR #123's first real CI run).
    if ('crf' in merged) {
      delete merged.crf;
      winners.delete('crf');
    }
  }
}

// ---------------------------------------------------------------------------
// presetConfigHash
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  // Recursive canonicalisation — sorts keys at every level (code-review
  // MEDIUM: top-level-only sort would let two presetOverrides records
  // with the same logical content but different insertion order
  // produce different sha256 hashes, defeating the deterministic
  // contract). Primitives + arrays delegate to JSON.stringify directly
  // (arrays preserve order — order IS semantic — but our hash inputs
  // currently never contain arrays).
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k]))
      .join(',') +
    '}'
  );
}

function computePresetConfigHash(
  clientDefault: Readonly<Record<string, unknown>> | undefined,
  scopedDefault: Readonly<Record<string, unknown>> | undefined,
  callPresetOverride: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  // Per architect's adjustment 4: hash is present iff a cell was
  // REGISTERED (i.e. one of these three records is defined), not iff
  // any field was set. An empty-delta cell still contributes presence.
  const anyParticipated =
    clientDefault !== undefined || scopedDefault !== undefined || callPresetOverride !== undefined;
  if (!anyParticipated) return undefined;
  const canonical = canonicalJson({
    clientDefault: clientDefault ?? null,
    scopedDefault: scopedDefault ?? null,
    callPresetOverride: callPresetOverride ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the wire payload + introspection projection for a compress
 * operation call. Throws {@link GislConfigError} before any network
 * round-trip when the merged options violate a documented constraint.
 *
 * Layers are applied in fixed order:
 *   SDK shipped → client default → scoped (T4c) → callPresetOverride → explicit.
 *
 * `optimize` unset ⇒ layer 1 contributes nothing; `resolvedOptions.preset = null`.
 */
export function resolveCompressOptions(
  input: ResolveCompressOptionsInput,
): ResolveCompressOptionsOutput {
  const { media, op, presetDefaults, presetOverrides, optimize, explicitOptions } = input;
  if (op !== 'compress') {
    throw new GislConfigError(
      `Preset resolution is only wired for compress operations today; got op='${op}'.`,
      { reason: 'unsupported_op' },
    );
  }

  // 0. Type-mismatch detection runs BEFORE the merge so the error
  // points at the typed argument the caller passed, not at the
  // resolved wire shape.
  if (presetOverrides !== undefined) {
    detectMismatchedOverrides(media, presetOverrides);
  }

  // 1-5. Walk layers and accumulate.
  const acc: MergeAccumulator = { merged: {}, winners: new Map() };

  const sdkDefault: Readonly<Record<string, unknown>> | undefined =
    optimize === undefined ? undefined : sdkDefaultRecord(media, op, optimize);
  const clientDefault = clientDefaultRecord(presetDefaults, media, op, optimize ?? ('Balanced' as OptimizeFor));
  // Scoped is empty in T4b; declared here so the source bucket order
  // matches the public ResolvedOptionsSources type.
  const scopedDefault: Readonly<Record<string, unknown>> | undefined = undefined;

  // optimize-unset skips clientDefault too — the caller chose to opt
  // out of layered preset resolution entirely. Without an optimize
  // level there's no cell to look up.
  const effectiveClientDefault = optimize === undefined ? undefined : clientDefault;
  const effectivePresetOverrides = presetOverrides;

  mergeLayer(acc, sdkDefault, 'sdkDefault');
  mergeLayer(acc, effectiveClientDefault, 'clientDefault');
  mergeLayer(acc, scopedDefault, 'scopedDefault');
  mergeLayer(acc, effectivePresetOverrides, 'callPresetOverride');
  mergeLayer(acc, explicitOptions, 'explicit');

  // 6. Resolve `targetSize` (video-only ergonomic field) to wire
  // `target_size_bytes` + set `encoding_mode='target_size'`. The
  // resolver does this on the merged record so a lower layer's
  // targetSize can be overridden by a higher layer setting it to
  // something else (or by an explicit `crf` flipping the encoding
  // mode).
  if (media === 'video') {
    // After alias application above, `targetSize` is still the camelCase key
    // because it has no entry in WIRE_ALIASES (it gets DERIVED, not aliased).
    if ('targetSize' in acc.merged) {
      const rawTargetSize = acc.merged.targetSize;
      delete acc.merged.targetSize;
      acc.winners.delete('targetSize');
      const bytes = _parseTargetSize(rawTargetSize);
      // The source that "wins" target_size_bytes / encoding_mode is
      // whichever layer last set the camelCase `targetSize`. We
      // recover that from the original layer records since acc.winners
      // already lost it on the delete.
      const targetSizeSource: SourceKey = (() => {
        if (explicitOptions['targetSize'] !== undefined) return 'explicit';
        if (effectivePresetOverrides?.['targetSize'] !== undefined) return 'callPresetOverride';
        if (effectiveClientDefault?.['targetSize'] !== undefined) return 'clientDefault';
        return 'sdkDefault';
      })();
      acc.merged.target_size_bytes = bytes;
      acc.merged.encoding_mode = 'target_size';
      acc.winners.set('target_size_bytes', targetSizeSource);
      acc.winners.set('encoding_mode', targetSizeSource);
    } else if (acc.merged.crf !== undefined && acc.merged.encoding_mode === undefined) {
      // Explicit crf with no targetSize: emit encoding_mode='crf' so
      // the wire is unambiguous. Source attribution follows whoever
      // owns `crf` (typically explicit, but a layered default also fine).
      const crfSource = acc.winners.get('crf') ?? 'explicit';
      acc.merged.encoding_mode = 'crf';
      acc.winners.set('encoding_mode', crfSource);
    }
  }

  // 7. Validate the merged payload (post-merge — catches cross-layer
  // disagreements). May throw GislConfigError with resolvedSnapshot.
  const explicitWireKeys = new Set<string>();
  for (const camelKey of Object.keys(explicitOptions)) {
    explicitWireKeys.add(applyAlias(camelKey));
  }
  if (explicitOptions['targetSize'] !== undefined) explicitWireKeys.add('targetSize');
  if (explicitOptions['crf'] !== undefined) explicitWireKeys.add('crf');
  validateMerged(media, acc.merged, explicitWireKeys, acc.winners);

  // 8. Build the source buckets from the winners map.
  const sources: ResolvedOptionsSources = (() => {
    const buckets: Record<SourceKey, string[]> = {
      sdkDefault: [],
      clientDefault: [],
      scopedDefault: [],
      callPresetOverride: [],
      explicit: [],
    };
    for (const [wireKey, source] of acc.winners) buckets[source].push(wireKey);
    for (const key of SOURCE_KEYS) buckets[key].sort();
    return {
      sdkDefault: buckets.sdkDefault,
      clientDefault: buckets.clientDefault,
      scopedDefault: buckets.scopedDefault,
      callPresetOverride: buckets.callPresetOverride,
      explicit: buckets.explicit,
    };
  })();

  // 9. presetConfigHash — present iff any non-SDK layer's cell was
  // registered (architect's adjustment 4).
  const presetConfigHash = computePresetConfigHash(
    effectiveClientDefault,
    scopedDefault,
    effectivePresetOverrides,
  );

  // 10. Build the ResolvedOptions surface. `overrides` retained for
  // back-compat (mirror of sources.explicit per architect's adjustment 1).
  const resolvedOptions: ResolvedOptions = {
    preset: optimize ?? null,
    applied: { ...acc.merged },
    overrides: sources.explicit,
    presetVersion: PRESET_VERSION,
    sources,
    ...(presetConfigHash !== undefined ? { presetConfigHash } : {}),
  };

  // 11. Final wire payload — drop any field whose merged value is
  // undefined (mergeLayer already skips them, but defence in depth).
  const wireOptions: Record<string, unknown> = {};
  for (const k of Object.keys(acc.merged)) {
    const v = acc.merged[k];
    if (v !== undefined) wireOptions[k] = v;
  }

  return { wireOptions, resolvedOptions };
}
