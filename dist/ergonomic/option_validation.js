import { convertMetadata, thumbnailMetadata, transformMetadata, textWatermarkMetadata, imageWatermarkMetadata, videoWatermarkMetadata, } from '@giveitsmaller/contracts/operations';
import { GislConfigError } from '../errors.js';
import { VERB_OPTION_KEYS } from './option_types.js';
/**
 * Eager, synchronous, PRE-UPLOAD option-key validation for the ergonomic verbs
 * (card Dhje3Faq). The file-first builders accept verb options as untyped bags;
 * a user typo (`{ quaity: 80 }`) would otherwise flow to the server and 422.
 * This module rejects unknown keys at the verb call — before any upload —
 * mirroring the existing `compress()` optimize-check and the watermark eager
 * gate. The allowed key set is read from the generated `OperationMetadata`
 * sidecars (the same contract-anchored source the wire-key conformance guard
 * uses), so it can never silently drift from the contract.
 *
 * SCOPE: `convert` / `thumbnail` / `textWatermark` / `watermark` / `output`
 * only. `compress` is deliberately EXCLUDED — its bag legitimately carries SDK-only keys
 * (`optimize`, `presetOverrides`) and camelCase resolver aliases (`targetSize`,
 * `outputFormat`) that are not `operationOptionKeys(compressMetadata)`; it has its
 * own `unknown_field` validation through the preset resolver.
 *
 * Mirrored by the PHP `OptionValidation` helper — keep the two in lockstep.
 */
/**
 * OPERATION-LEVEL contract option keys (the keys valid in `OperationDef.options`):
 * the union of every mime group's `options` plus `direct_options` for
 * media-agnostic ops. Deliberately EXCLUDES `per_input_options` (valid only on a
 * merge input). Promoted from the wire-key conformance guard for runtime reuse.
 */
export function operationOptionKeys(metadata) {
    const keys = new Set();
    for (const group of Object.values(metadata.mime_groups)) {
        for (const k of Object.keys(group.options))
            keys.add(k);
    }
    for (const k of Object.keys(metadata.direct_options ?? {}))
        keys.add(k);
    return keys;
}
function union(...sets) {
    const out = new Set();
    for (const set of sets)
        for (const k of set)
            out.add(k);
    return out;
}
/**
 * The contract option-key set per validated verb (the GENERIC allowed set).
 * `watermark` is the UNION of `image_watermark` + `video_watermark` because the
 * base media may be undetectable at the `.watermark()` call; the existing
 * media-routing gate still rejects the wrong route by media.
 */
const ALLOWED_KEYS = {
    convert: operationOptionKeys(convertMetadata),
    thumbnail: operationOptionKeys(thumbnailMetadata),
    // transform is a passthrough verb (rotate/flip). The generic allowed set is
    // the op-wide union {rotate, flip}; `flip`-on-PDF is narrowed server-side.
    transform: operationOptionKeys(transformMetadata),
    textWatermark: operationOptionKeys(textWatermarkMetadata),
    watermark: union(operationOptionKeys(imageWatermarkMetadata), operationOptionKeys(videoWatermarkMetadata)),
    // `output` is the image Output facade — its allowed keys are the UNION of every
    // image route's honored+planned options (the image-output-routes projection),
    // INCLUDING `output_format` (in every cell's honored set) which — like `convert`
    // — is in the allowed set but rejected first by the positional-owned guard. This
    // is the COARSE static gate (reject keys no image route ever honors, e.g. a video
    // `crf`); the precise per-route honored/planned narrowing happens in the
    // `output()` lowering (`resolveOutputRoute`). Pinned to the projection union by
    // the output-route conformance test.
    output: new Set([...VERB_OPTION_KEYS.output, 'output_format']),
};
/**
 * Keys a verb OWNS via a positional argument: a user must not also supply them
 * in the options bag (they would be silently overridden by the positional). The
 * guard runs BEFORE the generic check so these get a specific, actionable
 * message rather than the generic "unknown option" one. `format` is an SDK alias
 * for the positional (not a contract key) and is owned too.
 */
const POSITIONAL_OWNED = {
    convert: ['output_format', 'format'],
    textWatermark: ['text'],
    // `output(format, …)` sets the target format via its first argument; the wire
    // key `output_format` and the SDK alias `format` must not be supplied in the bag.
    output: ['output_format', 'format'],
};
/** Accessor for the conformance guard (pins these sets to the contract metadata). */
export function allowedKeysFor(verb) {
    return ALLOWED_KEYS[verb];
}
/**
 * Validate a USER-supplied options bag for an ergonomic verb. Throws
 * {@link GislConfigError} (reason `unknown_field`) synchronously, BEFORE any
 * upload or wire-key injection. Call this at the TOP of every verb body, before
 * the `format`-drop / `output_format` / `text` injection.
 *
 * @throws {GislConfigError} reason `unknown_field` when the bag carries a key the
 *   verb owns via a positional argument, or a key absent from the op's contract
 *   option set.
 */
export function validateVerbOptions(verb, options) {
    // An untyped JS caller can pass an explicit `null`/`undefined` bag. A nullish
    // bag has no keys to reject, so it must not surface as a raw TypeError.
    if (options === null || options === undefined)
        return;
    const owned = POSITIONAL_OWNED[verb];
    if (owned !== undefined) {
        for (const key of owned) {
            if (Object.prototype.hasOwnProperty.call(options, key)) {
                const arg = verb === 'textWatermark' ? 'text' : 'output format';
                throw new GislConfigError(`${verb}() takes the ${arg} as an argument; remove '${key}' from the options bag.`, { reason: 'unknown_field', conflictingFields: [key] });
            }
        }
    }
    const allowed = ALLOWED_KEYS[verb];
    for (const key of Object.keys(options)) {
        if (!allowed.has(key)) {
            throw new GislConfigError(`${verb}: unknown option '${key}'. Valid options: ${[...allowed].sort().join(', ')}.`, { reason: 'unknown_field', conflictingFields: [key] });
        }
    }
}
/**
 * Reject an explicit `null` thumbnail `width` / `height`. Both dimensions are
 * OPTIONAL in the contract (thumbnail.yaml, every mime group, since v2.148.0):
 * omitting one lets the server derive it from the source aspect ratio, omitting
 * both gives a 320px longest edge. So absence (and an explicit `undefined`, which
 * the verbs drop from the wire) is accepted. `null` is not: it would reach the
 * wire as a JSON `null`, which the contract's `type: integer` refuses with a 422.
 * The PHP `assertThumbnailDimensions` rejects `null` too, so a null dimension is
 * a pre-upload error in BOTH languages. Mirrored in PHP.
 *
 * @throws {GislConfigError} reason `type_mismatch` naming the null dimension(s)
 *   in `conflictingFields`.
 */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function describeBag(value) {
    if (Array.isArray(value))
        return 'an array';
    if (typeof value === 'object' && value !== null)
        return `a ${value.constructor?.name ?? 'non-plain object'}`;
    return typeof value;
}
export function assertThumbnailDimensions(options) {
    // Null-safe: an untyped JS `thumbnail()` with no bag is the contract's
    // both-omitted default, not an error. Anything else that is not a plain
    // object (`0`, `false`, an array, a Date/Map/class instance) would lower as
    // an empty bag and silently request that default, so it is refused.
    if (options !== null && options !== undefined && !isPlainObject(options)) {
        throw new GislConfigError(`thumbnail options must be a plain object (or omitted); got ${describeBag(options)}.`, { reason: 'type_mismatch', conflictingFields: [] });
    }
    const o = options ?? {};
    const nulled = [];
    if (o.width === null)
        nulled.push('width');
    if (o.height === null)
        nulled.push('height');
    if (nulled.length > 0) {
        throw new GislConfigError(`thumbnail ${nulled.join(' and ')} cannot be null; pass an integer (1-16384) or omit the key ` +
            `(the contract makes both optional: omit one to derive it from the source aspect ratio, ` +
            `omit both for a 320px longest edge).`, { reason: 'type_mismatch', conflictingFields: nulled });
    }
}
