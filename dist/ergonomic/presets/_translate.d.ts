import { ERGONOMIC_ENUMS } from '../../generated/sdk_spec/enums.js';
type EnumName = keyof typeof ERGONOMIC_ENUMS;
/**
 * Translate a PRESETS member-name string to its wire backing value via
 * the named ergonomic enum. Throws if `memberName` is not a key of the
 * enum const — protects against typos / drift in the generator output.
 *
 * @internal
 */
export declare function translateEnum(enumName: EnumName, memberName: string): string | number;
export {};
