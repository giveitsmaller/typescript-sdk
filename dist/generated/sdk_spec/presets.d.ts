export type PresetLevel = 'Size' | 'Balanced' | 'Quality';
export type PresetCell = Readonly<Record<string, string | number | boolean>>;
export type PresetMatrix = Readonly<Record<string, Readonly<Record<PresetLevel, PresetCell>>>>;
export declare const PRESETS: PresetMatrix;
/** Lookup the shipped preset cell for (mediaOp, level). Throws on unknown keys. */
export declare function shippedDefaultsFor(mediaOp: string, level: PresetLevel): PresetCell;
