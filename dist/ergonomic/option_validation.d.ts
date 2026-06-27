import { type OperationMetadata } from '@giveitsmaller/contracts/operations';
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
export declare function operationOptionKeys(metadata: OperationMetadata): ReadonlySet<string>;
/** The ergonomic verbs whose option bags this module key-validates. */
export type ValidatedVerb = 'convert' | 'thumbnail' | 'textWatermark' | 'watermark' | 'output';
/** Accessor for the conformance guard (pins these sets to the contract metadata). */
export declare function allowedKeysFor(verb: ValidatedVerb): ReadonlySet<string>;
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
export declare function validateVerbOptions(verb: ValidatedVerb, options: object | null | undefined): void;
/**
 * Assert thumbnail `width` AND `height` are both present and non-nullish (the
 * contract marks both `required` for image/video/document). The typed signature
 * already enforces this at compile time; this RUNTIME guard catches JS callers and
 * an explicit `undefined`/`null` BEFORE upload. Rejecting `null` (not just
 * `undefined`) keeps TS in lockstep with the PHP `assertThumbnailDimensions`, which
 * must reject `null` because PHP drops null values pre-lower — so a `null` dimension
 * is a pre-upload error in BOTH languages, never a wire `null` that 422s. Mirrored
 * in PHP.
 *
 * @throws {GislConfigError} reason `missing_required_field` naming the absent
 *   dimension(s) in `conflictingFields`.
 */
export declare function assertThumbnailDimensions(options: {
    width?: unknown;
    height?: unknown;
} | null | undefined): void;
