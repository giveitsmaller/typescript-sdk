/** @internal — exported for tests. */
export declare function _isPlannedEverywhere(opType: string, optionKey: string, value: unknown): boolean;
/** @internal — the first option value that is planned everywhere it can apply, or undefined. */
export declare function _firstPlannedValue(opType: string, wireOptions: Record<string, unknown>): {
    key: string;
    value: unknown;
} | undefined;
/**
 * @internal — throw the pre-upload refusal for the first planned-everywhere value in
 * any of `operations`. Shared by the file-first preflights (pE6JVJuc).
 */
export declare function _refusePlannedInOperations(operations: readonly {
    type: string;
    options?: Record<string, unknown>;
}[]): void;
