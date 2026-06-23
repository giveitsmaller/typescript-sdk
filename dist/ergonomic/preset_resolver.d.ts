import type { ResolvedOptions } from '../builder.js';
import type { OptimizeFor } from '../generated/sdk_spec/enums.js';
import { type PresetDefaults, type PresetMedia, type PresetOp } from './presets/index.js';
/**
 * The preset matrix version emitted on every resolve. Re-exported from the
 * GENERATED `sdk_spec/version.ts` (source of truth: contracts
 * `sdk-spec/version.yaml` `presetVersion`) so it can NEVER drift from the
 * generated preset cells — a regen that bumps the cells bumps this by
 * construction. Previously a hand-typed literal that the v2.73.0 regen had to
 * bump manually (yREs0srv).
 */
export declare const PRESET_VERSION: "1.5";
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
    /**
     * Scoped defaults attached via `client.withPresetDefaults(...)` (T4c —
     * `ULAlOP6j`). Layered between `presetDefaults` and `presetOverrides`
     * in the resolver chain. The derived client closes over this
     * reference; `undefined` for clients that never went through a
     * `withPresetDefaults` call.
     */
    readonly scopedPresetDefaults?: PresetDefaults;
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
    /**
     * Classifier result from media detection. When `true` on audio, the
     * shipped-preset (sdkDefault) bitrate is dropped — the worker rejects
     * `bitrate` on lossless outputs (flac/wav — contracts iakhSy3E).
     */
    readonly audioLossless?: boolean;
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
export declare function _parseTargetSize(value: unknown): number;
export declare const KNOWN_WIRE_FIELDS: Readonly<Record<PresetMedia, ReadonlySet<string>>>;
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
export declare function resolveCompressOptions(input: ResolveCompressOptionsInput): ResolveCompressOptionsOutput;
