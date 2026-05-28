// Internal: translate F3 PRESETS member-name strings to wire backing values
// via the ergonomic enum const maps emitted at
// `../../generated/sdk_spec/enums.ts`.
//
// **Why this exists:** the F3 generator emits preset cell values as
// ergonomic-enum MEMBER NAMES (e.g. `"Lossy"`, `"Smallest"`, `"_96"`),
// NOT wire backing values (`"lossy"`, `"smallest"`, `96`). Member names
// keep the contracts presets.yaml readable; the SDK is responsible for
// resolving them to the wire shape before they hit the workflow payload.
//
// **Lookup grammar:** `(ERGONOMIC_ENUMS[<EnumName>] as Record<string, unknown>)[memberName]`.
// Primitives (booleans, numbers, strings whose target field is not an
// enum-typed field) pass through unchanged. Unknown member names for an
// enum-typed field throw — silent fall-through would ship the literal
// member-name to the wire.

import { ERGONOMIC_ENUMS } from '../../generated/sdk_spec/enums.js';

type EnumName = keyof typeof ERGONOMIC_ENUMS;

/**
 * Translate a PRESETS member-name string to its wire backing value via
 * the named ergonomic enum. Throws if `memberName` is not a key of the
 * enum const — protects against typos / drift in the generator output.
 *
 * @internal
 */
export function translateEnum(enumName: EnumName, memberName: string): string | number {
  const enumObj = ERGONOMIC_ENUMS[enumName] as Record<string, string | number>;
  // `Object.hasOwn` rather than the `in` operator — `in` follows the
  // prototype chain and would silently accept inherited members like
  // `toString`/`hasOwnProperty`, returning a function value to the wire.
  if (!Object.hasOwn(enumObj, memberName)) {
    throw new Error(
      `PRESETS ergonomic translation: '${memberName}' is not a member of ${enumName}. ` +
        `Known members: ${Object.keys(enumObj).join(', ')}. ` +
        `This usually means the F3 generator emitted a member name that no longer exists in the ergonomic enum — regenerate or fix the contracts source.`,
    );
  }
  return enumObj[memberName] as string | number;
}

