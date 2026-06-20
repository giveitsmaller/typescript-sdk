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
// (e.g. targetSize + codec on video) catch combinations where
// the explicit knob and a layered default disagree. Resolver
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
import { sha256Hex } from '../sha256.js';
import { GislConfigError } from '../errors.js';
import { PRESET_VERSION as GENERATED_PRESET_VERSION } from '../generated/sdk_spec/version.js';
import { ImageCompressPresetOptions, AudioCompressPresetOptions, VideoCompressPresetOptions, DocumentPdfCompressPresetOptions, DocumentOfficeCompressPresetOptions, DocumentOdfCompressPresetOptions, DocumentEpubCompressPresetOptions, definedFieldsOf, } from './presets/index.js';
/**
 * The preset matrix version emitted on every resolve. Re-exported from the
 * GENERATED `sdk_spec/version.ts` (source of truth: contracts
 * `sdk-spec/version.yaml` `presetVersion`) so it can NEVER drift from the
 * generated preset cells — a regen that bumps the cells bumps this by
 * construction. Previously a hand-typed literal that the v2.73.0 regen had to
 * bump manually (yREs0srv).
 */
export const PRESET_VERSION = GENERATED_PRESET_VERSION;
// ---------------------------------------------------------------------------
// Wire-field alias map (declarative — NOT generic toSnakeCase).
// ---------------------------------------------------------------------------
//
// Lifted from docs/plans/sdk-ergonomics/plan.md §11a. Maps camelCase
// ergonomic-DTO field names to their snake_case wire counterparts.
// Fields whose ergonomic name IS the wire name (`quality`, `codec`,
// …) are NOT in this map — `applyAlias` returns them unchanged. A
// generic snake-case regex would mistranslate acronym/camel names
// (e.g. an `outputFormat` → `output_format` rename or an acronym like
// the former `iccProfile`); the declarative map is the only safe path.
const WIRE_ALIASES = Object.freeze({
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
function applyAlias(camelKey) {
    return WIRE_ALIASES[camelKey] ?? camelKey;
}
// ---------------------------------------------------------------------------
// targetSize parser
// ---------------------------------------------------------------------------
const TARGET_SIZE_MULTIPLIERS = Object.freeze({
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
export function _parseTargetSize(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
            throw new GislConfigError(`targetSize integer must be a positive whole byte count; got ${String(value)}.`, {
                reason: 'invalid_target_size',
                conflictingFields: ['targetSize'],
                suggestion: 'Pass a positive integer or a suffixed string like "50MB".',
            });
        }
        return value;
    }
    if (typeof value !== 'string') {
        throw new GislConfigError(`targetSize must be a positive integer (bytes) or a string like "50MB"; got ${typeof value}.`, {
            reason: 'invalid_target_size',
            conflictingFields: ['targetSize'],
            suggestion: 'Pass a positive integer or a suffixed string like "50MB".',
        });
    }
    const trimmed = value.trim();
    // Case-insensitive: `^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$` (unit
    // optional → defaults to B).
    const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/.exec(trimmed);
    if (match === null) {
        throw new GislConfigError(`targetSize string '${value}' is not a valid size — expected '<number><B|KB|MB|GB|TB>'.`, {
            reason: 'invalid_target_size',
            conflictingFields: ['targetSize'],
            suggestion: "Use '50MB', '1.5GB', or a raw integer byte count.",
        });
    }
    const magnitudeStr = match[1];
    const unitStr = match[2] === undefined ? 'B' : match[2].toUpperCase();
    if (!Object.hasOwn(TARGET_SIZE_MULTIPLIERS, unitStr)) {
        throw new GislConfigError(`targetSize unit '${match[2] ?? ''}' is not recognised — expected B / KB / MB / GB / TB.`, {
            reason: 'invalid_target_size',
            conflictingFields: ['targetSize'],
            suggestion: 'Use one of B / KB / MB / GB / TB (binary; 1 KB = 1024).',
        });
    }
    const magnitude = Number.parseFloat(magnitudeStr);
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
        throw new GislConfigError(`targetSize magnitude '${magnitudeStr}' must be a positive number.`, {
            reason: 'invalid_target_size',
            conflictingFields: ['targetSize'],
        });
    }
    const bytes = Math.floor(magnitude * TARGET_SIZE_MULTIPLIERS[unitStr]);
    if (bytes <= 0) {
        throw new GislConfigError(`targetSize '${value}' resolves to zero bytes after binary multiplication.`, {
            reason: 'invalid_target_size',
            conflictingFields: ['targetSize'],
        });
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
function sdkDefaultRecord(media, op, optimize) {
    if (op !== 'compress') {
        throw new GislConfigError(`Preset resolution is only wired for compress operations today; got op='${op}'.`, { reason: 'unsupported_op' });
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
/**
 * Look up the `(media, op, optimize)` cell in a `PresetDefaults` and
 * return a plain Record. Shared between layer 2 (clientDefault) and
 * layer 3 (scopedDefault — T4c) — both layers ask the same question
 * against different `PresetDefaults` references. Returns `undefined`
 * when the defaults aren't supplied or the cell wasn't registered.
 */
function presetDefaultsCellRecord(defaults, media, op, optimize) {
    if (defaults === undefined)
        return undefined;
    if (op !== 'compress')
        return undefined;
    // Each overload returns `<Specific>PresetOptions | undefined`. We
    // erase the per-media type at runtime by reducing the instance to a
    // plain Record. `cellFor` returns `undefined` when no delta was
    // registered for the tuple — the resolver treats that the same as
    // "this layer did not participate."
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
    if (cell === undefined)
        return undefined;
    // Reduce to a SPARSE camelCase record, dropping undefined-valued keys.
    // The leaf DTO's field DECLARATIONS define every field as an
    // own-enumerable `undefined` property under `useDefineForClassFields`
    // (ES2022) even when the ctor skipped the assignment — a naive spread
    // would carry those `undefined`s into the presetConfigHash input,
    // diverging from PHP's sparse `leafToRecord` (SVQcoR1K). `mergeLayer`
    // already ignores `undefined`, so this only affects the hash path.
    // Reuses the same helper `PresetDefaults.merge` uses for this exact
    // `useDefineForClassFields` problem.
    return definedFieldsOf(cell);
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
const MEDIA_FIELDS = Object.freeze({
    image: new Set(['quality', 'metadata', 'outputFormat']),
    audio: new Set(['bitrate', 'channels', 'sampleRate', 'normalize']),
    video: new Set(['codec', 'targetSize', 'crf', 'preset', 'width', 'height', 'fit', 'fps', 'faststart', 'audioCodec', 'audioBitrate']),
    document_pdf: new Set(['profile', 'colorspace', 'flattenForms']),
    document_office: new Set(['imageQuality', 'stripMacros', 'stripHiddenData', 'stripUnusedFonts']),
    document_odf: new Set(['imageQuality', 'stripMetadata', 'stripUnusedStyles']),
    document_epub: new Set(['imageQuality', 'fontSubsetting', 'stripUnusedCss']),
});
function detectMismatchedOverrides(media, overrides) {
    const expected = MEDIA_FIELDS[media];
    const keys = Object.keys(overrides);
    // Empty override is fine — equivalent to "register no per-call delta."
    if (keys.length === 0)
        return;
    // If EVERY key in overrides is recognised for the operation's media,
    // we accept it. If ALL keys belong to a different media, we throw a
    // type_mismatch. If keys mix recognised + unrecognised, the
    // unknown_field validation downstream will catch the strays.
    const unknownFields = keys.filter((k) => !expected.has(k));
    if (unknownFields.length === 0)
        return;
    // Look up which OTHER media owns every unknown field — if a single
    // OTHER media's field set covers them all, that's a type_mismatch.
    for (const otherMedia of Object.keys(MEDIA_FIELDS)) {
        if (otherMedia === media)
            continue;
        const otherSet = MEDIA_FIELDS[otherMedia];
        if (unknownFields.every((k) => otherSet.has(k))) {
            // PascalCase every underscore-separated segment so multi-segment
            // media (`document_pdf` → `DocumentPdf…`) emit the actual exported
            // class name (code-review MEDIUM: previously emitted
            // `Documentpdf…` which doesn't resolve in user code).
            const className = otherMedia
                .split('_')
                .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                .join('') + 'CompressPresetOptionsInput';
            throw new GislConfigError(`presetOverrides for operation media '${media}' contained fields from '${otherMedia}': ${unknownFields.join(', ')}.`, {
                reason: 'type_mismatch',
                conflictingFields: unknownFields,
                suggestion: `Pass an ${className} shape, or use the matching builder method.`,
            });
        }
    }
    // Otherwise the unknown fields are nonsense — fall through to the
    // unknown_field validation that runs against the merged record.
}
// ---------------------------------------------------------------------------
// Deep-merge with provenance tracking
// ---------------------------------------------------------------------------
const SOURCE_KEYS = ['sdkDefault', 'clientDefault', 'scopedDefault', 'callPresetOverride', 'explicit'];
function mergeLayer(acc, layer, source) {
    if (layer === undefined)
        return;
    for (const camelKey of Object.keys(layer)) {
        const value = layer[camelKey];
        if (value === undefined)
            continue;
        const wireKey = applyAlias(camelKey);
        acc.merged[wireKey] = value;
        acc.winners.set(wireKey, source);
    }
}
// ---------------------------------------------------------------------------
// Validations on the merged wire payload
// ---------------------------------------------------------------------------
// Exported so the wire-key conformance guard (tests/unit/wire-key-conformance.test.ts)
// can pin this hand-maintained allowlist to the generated contract metadata: every
// field the resolver may emit MUST be a real contract option key for `compress`.
export const KNOWN_WIRE_FIELDS = Object.freeze({
    image: new Set(['quality', 'metadata', 'output_format']),
    audio: new Set(['bitrate', 'channels', 'sample_rate', 'normalize', 'trim_start', 'trim_end']),
    video: new Set(['codec', 'encoding_mode', 'crf', 'target_size_bytes', 'preset', 'width', 'height', 'fit', 'fps', 'faststart', 'audio_codec', 'audio_bitrate', 'trim_start', 'trim_end']),
    document_pdf: new Set(['profile', 'colorspace', 'pages', 'flatten_forms']),
    document_office: new Set(['image_quality', 'strip_macros', 'strip_hidden_data', 'strip_unused_fonts']),
    document_odf: new Set(['image_quality', 'strip_metadata', 'strip_unused_styles']),
    document_epub: new Set(['image_quality', 'font_subsetting', 'strip_unused_css']),
});
function validateMerged(media, merged, explicitKeys, winners) {
    // Unknown-field defence-in-depth: every key must belong to the
    // media's wire surface OR be one of the resolver-derived wire keys
    // (target_size_bytes / encoding_mode for video). `targetSize` itself
    // never reaches `merged` — it is consumed by the resolver before
    // emission.
    const known = KNOWN_WIRE_FIELDS[media];
    for (const key of Object.keys(merged)) {
        if (!known.has(key)) {
            const snapshot = { ...merged };
            throw new GislConfigError(`Resolved wire payload contains unknown field '${key}' for media '${media}'.`, {
                reason: 'unknown_field',
                conflictingFields: [key],
                resolvedSnapshot: Object.freeze(snapshot),
            });
        }
    }
    // Video: targetSize-derived encoding_mode='target_size' is only
    // valid for H264 today. Catch the combination post-merge — explicit
    // codec overrides a layered default and either resolution must end
    // up at h264.
    if (media === 'video' && merged.encoding_mode === 'target_size') {
        if (merged.codec !== undefined && merged.codec !== 'h264') {
            const snapshot = { ...merged };
            throw new GislConfigError(`Video compress: 'targetSize' only supports codec 'h264' today; resolved codec is '${String(merged.codec)}'.`, {
                reason: 'invalid_combination',
                conflictingFields: ['targetSize', 'codec'],
                resolvedSnapshot: Object.freeze(snapshot),
                suggestion: "Either use codec H264, or drop targetSize and use crf instead.",
            });
        }
        // Mutual exclusion with explicit crf — the EXPLICIT layer is the
        // one that conflicts. If crf came in only from a lower layer it
        // would have been overwritten by encoding_mode='target_size' (and
        // we strip it below).
        if (explicitKeys.has('crf')) {
            const snapshot = { ...merged };
            throw new GislConfigError(`Video compress: 'targetSize' and 'crf' are mutually exclusive encoding modes.`, {
                reason: 'invalid_combination',
                conflictingFields: ['targetSize', 'crf'],
                resolvedSnapshot: Object.freeze(snapshot),
                suggestion: 'Choose one — drop targetSize to use crf, or drop crf to use targetSize.',
            });
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
function canonicalJson(value) {
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
    const record = value;
    // Skip undefined-valued keys (mirror `JSON.stringify` object semantics,
    // which omit undefined members). Without this, `canonicalJson(undefined)`
    // would serialise the literal token `undefined` into the hash input — a
    // latent foot-gun. The registered-cell records are already sparse (see
    // `presetDefaultsCellRecord`), so this is defense-in-depth; the
    // override-path anchors carry no undefined and are unaffected (SVQcoR1K).
    const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
    return ('{' +
        keys
            .map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k]))
            .join(',') +
        '}');
}
function computePresetConfigHash(clientDefault, scopedDefault, callPresetOverride) {
    // Per architect's adjustment 4: hash is present iff a cell was
    // REGISTERED (i.e. one of these three records is defined), not iff
    // any field was set. An empty-delta cell still contributes presence.
    const anyParticipated = clientDefault !== undefined || scopedDefault !== undefined || callPresetOverride !== undefined;
    if (!anyParticipated)
        return undefined;
    const canonical = canonicalJson({
        clientDefault: clientDefault ?? null,
        scopedDefault: scopedDefault ?? null,
        callPresetOverride: callPresetOverride ?? null,
    });
    return `sha256:${sha256Hex(canonical)}`;
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
export function resolveCompressOptions(input) {
    const { media, op, presetDefaults, scopedPresetDefaults, presetOverrides, optimize, explicitOptions, audioLossless } = input;
    if (op !== 'compress') {
        throw new GislConfigError(`Preset resolution is only wired for compress operations today; got op='${op}'.`, { reason: 'unsupported_op' });
    }
    // 0. Type-mismatch detection runs BEFORE the merge so the error
    // points at the typed argument the caller passed, not at the
    // resolved wire shape.
    if (presetOverrides !== undefined) {
        detectMismatchedOverrides(media, presetOverrides);
    }
    // 1-5. Walk layers and accumulate.
    const acc = { merged: {}, winners: new Map() };
    const sdkDefault = optimize === undefined ? undefined : sdkDefaultRecord(media, op, optimize);
    const clientDefault = presetDefaultsCellRecord(presetDefaults, media, op, optimize ?? 'Balanced');
    // Scoped layer (T4c — ULAlOP6j): reads from the derived client's
    // `_scopedPresetDefaults` closure. `undefined` for non-derived
    // clients; otherwise the merged stack from `withPresetDefaults`.
    const scopedDefault = presetDefaultsCellRecord(scopedPresetDefaults, media, op, optimize ?? 'Balanced');
    // optimize-unset skips clientDefault AND scopedDefault — the caller
    // chose to opt out of layered preset resolution entirely. Without an
    // optimize level there's no cell to look up at either layer
    // (architect adjustment 2 — symmetry with clientDefault).
    const effectiveClientDefault = optimize === undefined ? undefined : clientDefault;
    const effectiveScopedDefault = optimize === undefined ? undefined : scopedDefault;
    const effectivePresetOverrides = presetOverrides;
    mergeLayer(acc, sdkDefault, 'sdkDefault');
    mergeLayer(acc, effectiveClientDefault, 'clientDefault');
    mergeLayer(acc, effectiveScopedDefault, 'scopedDefault');
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
            // Walk the precedence chain HIGH → LOW (architect adjustment 1
            // for T4c: scopedDefault inserted between callPresetOverride and
            // clientDefault). Without the scoped arm, a scoped-set targetSize
            // would mis-attribute to sdkDefault and presetConfigHash /
            // sources.scopedDefault would be wrong.
            const targetSizeSource = (() => {
                if (explicitOptions['targetSize'] !== undefined)
                    return 'explicit';
                if (effectivePresetOverrides?.['targetSize'] !== undefined)
                    return 'callPresetOverride';
                if (effectiveScopedDefault?.['targetSize'] !== undefined)
                    return 'scopedDefault';
                if (effectiveClientDefault?.['targetSize'] !== undefined)
                    return 'clientDefault';
                return 'sdkDefault';
            })();
            acc.merged.target_size_bytes = bytes;
            acc.merged.encoding_mode = 'target_size';
            acc.winners.set('target_size_bytes', targetSizeSource);
            acc.winners.set('encoding_mode', targetSizeSource);
        }
        else if (acc.merged.crf !== undefined && acc.merged.encoding_mode === undefined) {
            // Explicit crf with no targetSize: emit encoding_mode='crf' so
            // the wire is unambiguous. Source attribution follows whoever
            // owns `crf` (typically explicit, but a layered default also fine).
            const crfSource = acc.winners.get('crf') ?? 'explicit';
            acc.merged.encoding_mode = 'crf';
            acc.winners.set('encoding_mode', crfSource);
        }
    }
    // audio_compress bakes a bitrate (Size 96 / Balanced 192 / Quality 320); the
    // worker rejects `bitrate` on lossless outputs (flac/wav — contracts iakhSy3E).
    // Drop ONLY the shipped-preset (sdkDefault) bitrate for clear-cut lossless
    // audio; any user-supplied bitrate (client/scoped default, per-call override
    // or explicit) is left for the worker to reject — no silent-ignore.
    if (media === 'audio' && audioLossless === true && acc.winners.get('bitrate') === 'sdkDefault') {
        delete acc.merged.bitrate;
        acc.winners.delete('bitrate');
    }
    // 7. Validate the merged payload (post-merge — catches cross-layer
    // disagreements). May throw GislConfigError with resolvedSnapshot.
    const explicitWireKeys = new Set();
    for (const camelKey of Object.keys(explicitOptions)) {
        explicitWireKeys.add(applyAlias(camelKey));
    }
    if (explicitOptions['targetSize'] !== undefined)
        explicitWireKeys.add('targetSize');
    if (explicitOptions['crf'] !== undefined)
        explicitWireKeys.add('crf');
    validateMerged(media, acc.merged, explicitWireKeys, acc.winners);
    // 8. Build the source buckets from the winners map.
    const sources = (() => {
        const buckets = {
            sdkDefault: [],
            clientDefault: [],
            scopedDefault: [],
            callPresetOverride: [],
            explicit: [],
        };
        for (const [wireKey, source] of acc.winners)
            buckets[source].push(wireKey);
        for (const key of SOURCE_KEYS)
            buckets[key].sort();
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
    const presetConfigHash = computePresetConfigHash(effectiveClientDefault, effectiveScopedDefault, effectivePresetOverrides);
    // 10. Build the ResolvedOptions surface. `overrides` retained for
    // back-compat (mirror of sources.explicit per architect's adjustment 1).
    const resolvedOptions = {
        preset: optimize ?? null,
        applied: { ...acc.merged },
        overrides: sources.explicit,
        presetVersion: PRESET_VERSION,
        sources,
        ...(presetConfigHash !== undefined ? { presetConfigHash } : {}),
    };
    // 11. Final wire payload — drop any field whose merged value is
    // undefined (mergeLayer already skips them, but defence in depth).
    const wireOptions = {};
    for (const k of Object.keys(acc.merged)) {
        const v = acc.merged[k];
        if (v !== undefined)
            wireOptions[k] = v;
    }
    return { wireOptions, resolvedOptions };
}
