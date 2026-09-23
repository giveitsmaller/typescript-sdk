/** @internal — exported for tests. */
export declare function _isPlannedEverywhere(opType: string, optionKey: string, value: unknown): boolean;
/** @internal — the first option value that is planned everywhere it can apply, or undefined. */
export declare function _firstPlannedValue(opType: string, wireOptions: Record<string, unknown>): {
    key: string;
    value: unknown;
} | undefined;
