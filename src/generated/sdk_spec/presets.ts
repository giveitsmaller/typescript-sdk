// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.

export type PresetLevel = 'Size' | 'Balanced' | 'Quality';

export type PresetCell = Readonly<Record<string, string | number | boolean>>;

export type PresetMatrix = Readonly<Record<string, Readonly<Record<PresetLevel, PresetCell>>>>;

export const PRESETS: PresetMatrix = Object.freeze({
  "image_compress": Object.freeze({
    Size: Object.freeze({
      "quality": 65,
      "metadata": "Strip",
      "outputFormat": "Original",
    } as PresetCell),
    Balanced: Object.freeze({
      "quality": 80,
      "metadata": "Strip",
      "outputFormat": "Original",
    } as PresetCell),
    Quality: Object.freeze({
      "quality": 92,
      "metadata": "Strip",
      "outputFormat": "Original",
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "audio_compress": Object.freeze({
    Size: Object.freeze({
      "bitrate": "_96",
      "sampleRate": "_44100",
      "normalize": true,
    } as PresetCell),
    Balanced: Object.freeze({
      "bitrate": "_192",
      "sampleRate": "_44100",
      "normalize": true,
    } as PresetCell),
    Quality: Object.freeze({
      "bitrate": "_320",
      "sampleRate": "_48000",
      "normalize": false,
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "video_compress": Object.freeze({
    Size: Object.freeze({
      "crf": 30,
      "preset": "Slow",
    } as PresetCell),
    Balanced: Object.freeze({
      "crf": 23,
      "preset": "Medium",
    } as PresetCell),
    Quality: Object.freeze({
      "crf": 18,
      "preset": "Slow",
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "document_pdf_compress": Object.freeze({
    Size: Object.freeze({
      "profile": "Screen",
      "grayscale": true,
    } as PresetCell),
    Balanced: Object.freeze({
      "profile": "Ebook",
      "grayscale": false,
    } as PresetCell),
    Quality: Object.freeze({
      "profile": "Printer",
      "grayscale": false,
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "document_office_compress": Object.freeze({
    Size: Object.freeze({
      "stripMacros": true,
      "stripHiddenData": true,
      "stripUnusedFonts": true,
    } as PresetCell),
    Balanced: Object.freeze({
      "stripMacros": true,
      "stripHiddenData": false,
      "stripUnusedFonts": false,
    } as PresetCell),
    Quality: Object.freeze({
      "stripMacros": false,
      "stripHiddenData": false,
      "stripUnusedFonts": false,
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "document_odf_compress": Object.freeze({
    Size: Object.freeze({
      "stripMetadata": true,
      "stripUnusedStyles": true,
    } as PresetCell),
    Balanced: Object.freeze({
      "stripMetadata": true,
      "stripUnusedStyles": false,
    } as PresetCell),
    Quality: Object.freeze({
      "stripMetadata": false,
      "stripUnusedStyles": false,
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
  "document_epub_compress": Object.freeze({
    Size: Object.freeze({
      "fontSubsetting": true,
      "stripUnusedCss": true,
    } as PresetCell),
    Balanced: Object.freeze({
      "fontSubsetting": true,
      "stripUnusedCss": false,
    } as PresetCell),
    Quality: Object.freeze({
      "fontSubsetting": false,
      "stripUnusedCss": false,
    } as PresetCell),
  } as Readonly<Record<PresetLevel, PresetCell>>),
} as PresetMatrix);

/** Lookup the shipped preset cell for (mediaOp, level). Throws on unknown keys. */
export function shippedDefaultsFor(mediaOp: string, level: PresetLevel): PresetCell {
  const group = PRESETS[mediaOp];
  if (!group) throw new Error(`Unknown preset mediaOp: ${mediaOp}`);
  const cell = group[level];
  if (!cell) throw new Error(`Unknown preset level for ${mediaOp}: ${level}`);
  return cell;
}
