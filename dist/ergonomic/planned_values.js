/**
 * Generic per-VALUE `planned` gate for the operation-first builders (99Da2uyx).
 *
 * The image-output gate (`isPlannedValue` in image_output_routes.ts) covers compress
 * image routes only. Every other SINGLE-input operation-first call sent a value the
 * contract marks `planned` straight to the upload, and the API refused it at create, AFTER the bytes had
 * gone up. First live case: contracts v2.209.0 marks `split` `precision: exact`
 * planned on audio and video.
 *
 * ⚠️ THE RULE IS "PLANNED EVERYWHERE IT CAN APPLY", NOT "PLANNED ANYWHERE". This gate
 * runs before the upload, when the SDK does not reliably know which mime group the
 * server will resolve the input to. So a value is refused only when EVERY group of
 * the operation that declares the option (plus `direct_options`) marks that value
 * planned. A value planned in one group and available in another passes, and the
 * API decides at create. The failure this avoids is a false REFUSAL of a request the
 * server would have accepted, which is worse than a late one.
 *
 * SCOPE: `OperationBuilder` (operation(), typed verbs, mapEach children), the
 * file-first single-input `Recipe` preflight, and the shared multi-input
 * preflight in `_uploadInputsAndCreate` (merge, files().archive(), overlays,
 * fan-out) - every lowered operation of every job (pE6JVJuc).
 */
import * as operations from '@giveitsmaller/contracts/operations';
import { GislConfigError } from '../errors.js';
function metadataFor(opType) {
    const exportName = `${opType.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())}Metadata`;
    const candidate = operations[exportName];
    return typeof candidate === 'object' && candidate !== null && 'mime_groups' in candidate
        ? candidate
        : undefined;
}
/** @internal — exported for tests. */
export function _isPlannedEverywhere(opType, optionKey, value) {
    const meta = metadataFor(opType);
    if (meta === undefined)
        return false;
    const declaring = [];
    for (const group of Object.values(meta.mime_groups)) {
        const opt = group.options[optionKey];
        if (opt !== undefined)
            declaring.push(opt);
    }
    const direct = meta.direct_options?.[optionKey];
    if (direct !== undefined)
        declaring.push(direct);
    if (declaring.length === 0)
        return false;
    const token = String(value);
    return declaring.every((opt) => opt.per_value_availability[token]?.availability === 'planned');
}
/** @internal — the first option value that is planned everywhere it can apply, or undefined. */
export function _firstPlannedValue(opType, wireOptions) {
    for (const [key, value] of Object.entries(wireOptions)) {
        if (value === undefined || value === null || typeof value === 'object')
            continue;
        if (_isPlannedEverywhere(opType, key, value))
            return { key, value };
    }
    return undefined;
}
/**
 * @internal — throw the pre-upload refusal for the first planned-everywhere value in
 * any of `operations`. Shared by the file-first preflights (pE6JVJuc).
 */
export function _refusePlannedInOperations(operations) {
    for (const op of operations) {
        const planned = _firstPlannedValue(op.type, op.options ?? {});
        if (planned !== undefined) {
            throw new GislConfigError(`${op.type}: '${planned.key}: ${String(planned.value)}' is advertised but not available yet (planned).`, { reason: 'feature_not_available', conflictingFields: [planned.key] });
        }
    }
}
