// CODE GENERATED — DO NOT EDIT.
// Source: compression_contracts/sdk-spec/ (see sdk-spec/README.md).
// Regenerate with: scripts/generate.py.
export const PRESETS = Object.freeze({
    "image_compress": Object.freeze({
        Size: Object.freeze({
            "quality": 65,
            "metadata": "Strip",
            "outputFormat": "Original",
        }),
        Balanced: Object.freeze({
            "quality": 80,
            "metadata": "Strip",
            "outputFormat": "Original",
        }),
        Quality: Object.freeze({
            "quality": 92,
            "metadata": "Strip",
            "outputFormat": "Original",
        }),
    }),
    "audio_compress": Object.freeze({
        Size: Object.freeze({
            "bitrate": "_96",
            "sampleRate": "_44100",
            "normalize": true,
        }),
        Balanced: Object.freeze({
            "bitrate": "_192",
            "sampleRate": "_44100",
            "normalize": true,
        }),
        Quality: Object.freeze({
            "bitrate": "_320",
            "sampleRate": "_48000",
            "normalize": false,
        }),
    }),
    "video_compress": Object.freeze({
        Size: Object.freeze({
            "crf": 30,
            "preset": "Slow",
        }),
        Balanced: Object.freeze({
            "crf": 23,
            "preset": "Medium",
        }),
        Quality: Object.freeze({
            "crf": 18,
            "preset": "Slow",
        }),
    }),
    "document_office_compress": Object.freeze({
        Size: Object.freeze({
            "stripMacros": true,
            "stripHiddenData": true,
            "stripUnusedFonts": true,
        }),
        Balanced: Object.freeze({
            "stripMacros": true,
            "stripHiddenData": false,
            "stripUnusedFonts": false,
        }),
        Quality: Object.freeze({
            "stripMacros": false,
            "stripHiddenData": false,
            "stripUnusedFonts": false,
        }),
    }),
    "document_odf_compress": Object.freeze({
        Size: Object.freeze({
            "stripMetadata": true,
            "stripUnusedStyles": true,
        }),
        Balanced: Object.freeze({
            "stripMetadata": true,
            "stripUnusedStyles": false,
        }),
        Quality: Object.freeze({
            "stripMetadata": false,
            "stripUnusedStyles": false,
        }),
    }),
    "document_epub_compress": Object.freeze({
        Size: Object.freeze({
            "fontSubsetting": true,
            "stripUnusedCss": true,
        }),
        Balanced: Object.freeze({
            "fontSubsetting": true,
            "stripUnusedCss": false,
        }),
        Quality: Object.freeze({
            "fontSubsetting": false,
            "stripUnusedCss": false,
        }),
    }),
});
/** Lookup the shipped preset cell for (mediaOp, level). Throws on unknown keys. */
export function shippedDefaultsFor(mediaOp, level) {
    const group = PRESETS[mediaOp];
    if (!group)
        throw new Error(`Unknown preset mediaOp: ${mediaOp}`);
    const cell = group[level];
    if (!cell)
        throw new Error(`Unknown preset level for ${mediaOp}: ${level}`);
    return cell;
}
