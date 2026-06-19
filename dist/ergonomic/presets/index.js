// T4a — PresetDefaults immutable builder + presetDefaults() factory.
//
// Implements the user-facing path for layered preset configuration:
//
//   const defaults = presetDefaults()
//     .imageCompress(OptimizeFor.Size, { quality: 75 })
//     .videoCompress(OptimizeFor.Quality);
//
//   const client = await gisl.create({ presetDefaults: defaults });
//
// `T4a` ships only the typed slot and the builder semantics — the
// resolver (T4b) reads `defaults.cellFor(media, op, level)` and merges
// shipped defaults + this user delta + per-call overrides at workflow-
// create time.
//
// **Semantics**
// - `cellFor(media, op, level)` returns the USER-SUPPLIED DELTA stored
//   by the matching `.imageCompress(level, input)` call, or `undefined`
//   if no such delta was registered. It does NOT return shipped defaults
//   — those live on the leaf class (`*.shippedDefaultsFor(level)`).
// - Per-cell methods are immutable: each returns a fresh `PresetDefaults`
//   carrying the original entries plus the new (cell, level) registration.
//   Calling the same method twice on the same instance yields two
//   distinct objects.
// - Calling `.imageCompress(level)` with no input registers an empty
//   delta — the resolver will see "this cell asked for `level` with no
//   overrides" and apply shipped defaults verbatim.
import { ImageCompressPresetOptions, } from './image_compress.js';
import { AudioCompressPresetOptions, } from './audio_compress.js';
import { VideoCompressPresetOptions, } from './video_compress.js';
import { DocumentPdfCompressPresetOptions, } from './document_pdf_compress.js';
import { DocumentOfficeCompressPresetOptions, } from './document_office_compress.js';
import { DocumentOdfCompressPresetOptions, } from './document_odf_compress.js';
import { DocumentEpubCompressPresetOptions, } from './document_epub_compress.js';
// Re-export everything callers need from this module's root.
export { ImageCompressPresetOptions, } from './image_compress.js';
export { AudioCompressPresetOptions, } from './audio_compress.js';
export { VideoCompressPresetOptions, } from './video_compress.js';
export { DocumentPdfCompressPresetOptions, } from './document_pdf_compress.js';
export { DocumentOfficeCompressPresetOptions, } from './document_office_compress.js';
export { DocumentOdfCompressPresetOptions, } from './document_odf_compress.js';
export { DocumentEpubCompressPresetOptions, } from './document_epub_compress.js';
// Re-export ergonomic enums for callers (single canonical path).
export { OptimizeFor, ImageMode, ImageMetadataPolicy, IccProfilePolicy, ImageFormat, VideoCodec, VideoPreset, VideoFit, AudioBitrate, AudioCodec, AudioSampleRate, PdfProfile, PdfColorspace, } from '../../generated/sdk_spec/enums.js';
function cellKeyOf(media, op) {
    return `${media}_${op}`;
}
/**
 * Per-cell field-merge: parent fields ⊕ child fields where defined.
 * Re-construct the leaf DTO via the matching `<LeafClass>.from(merged)`
 * call so the result is a freshly-frozen `*PresetOptions` instance —
 * NOT a mutated reference into either input. Used by
 * {@link PresetDefaults.merge} when both parent and child registered
 * the same `(cellKey, level)` tuple.
 *
 * `definedFieldsOf` filters undefined values out of each instance
 * BEFORE the merge: with TS `useDefineForClassFields` (the ES2022
 * default), `readonly mode?: ImageMode` declarations initialise the
 * field as an enumerable own property with value `undefined` BEFORE
 * the ctor body runs. A naive `Object.assign({}, parent, child)`
 * therefore lets child's `undefined` overwrite parent's defined value
 * — caught by CI on PR #125 first run. Filter-then-spread restores
 * the documented merge-not-replace semantics.
 *
 * @internal
 */
function definedFieldsOf(opts) {
    const out = {};
    for (const key of Object.keys(opts)) {
        const value = opts[key];
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
function mergePresetOptions(cellKey, parentOpts, childOpts) {
    // Child fields win on overlap; parent fills the remaining gaps.
    // `definedFieldsOf` strips undefined-valued slots that TS class
    // field declarations create even when the ctor body skipped the
    // assignment (see helper docblock).
    const mergedFields = {
        ...definedFieldsOf(parentOpts),
        ...definedFieldsOf(childOpts),
    };
    switch (cellKey) {
        case 'image_compress':
            return ImageCompressPresetOptions.from(mergedFields);
        case 'audio_compress':
            return AudioCompressPresetOptions.from(mergedFields);
        case 'video_compress':
            return VideoCompressPresetOptions.from(mergedFields);
        case 'document_pdf_compress':
            return DocumentPdfCompressPresetOptions.from(mergedFields);
        case 'document_office_compress':
            return DocumentOfficeCompressPresetOptions.from(mergedFields);
        case 'document_odf_compress':
            return DocumentOdfCompressPresetOptions.from(mergedFields);
        case 'document_epub_compress':
            return DocumentEpubCompressPresetOptions.from(mergedFields);
    }
}
/**
 * Append `(level, options)` into a fresh map under `cellKey`, returning
 * a new outer map. Both layers stay immutable — callers' references to
 * the previous PresetDefaults remain unchanged.
 */
function withCellEntry(prev, cellKey, level, options) {
    const next = new Map(prev);
    const prevEntries = prev.get(cellKey);
    const nextEntries = new Map(prevEntries ?? []);
    nextEntries.set(level, options);
    next.set(cellKey, nextEntries);
    return next;
}
export class PresetDefaults {
    cells;
    constructor(cells) {
        this.cells = cells;
        Object.freeze(this);
    }
    /** Empty builder — entry point for `presetDefaults()`. @internal */
    static _empty() {
        return new PresetDefaults(new Map());
    }
    /**
     * Deep-merge two {@link PresetDefaults} into a new instance (T4c —
     * `ULAlOP6j`). Used by `withPresetDefaults` to stack scoped derives:
     * `client.withPresetDefaults(a).withPresetDefaults(b)` produces a
     * scoped layer equivalent to `merge(a, b)` — `b`'s per-cell fields
     * override `a`'s where defined; `a`'s fields fill gaps.
     *
     * Per-cell semantics (codex r2 #5 — scalar-leaf merge):
     * - If a `(cellKey, level)` entry is present in EITHER only, take it
     *   verbatim.
     * - If present in both, merge the per-cell `*Input` shapes via
     *   `Object.assign({}, parentInput, childInput)` and re-construct
     *   the leaf DTO. Every cell-DTO field is a scalar (primitive,
     *   enum-string, or `string | number` for `targetSize`) — shallow
     *   merge gives the correct field-wise override.
     *
     * Parent and child instances are unaffected.
     */
    static merge(parent, child) {
        const merged = new Map();
        // Seed with a clone of parent's entries (one inner Map per cellKey
        // so child writes don't bleed back into parent's frozen structure).
        for (const [cellKey, entries] of parent.cells) {
            merged.set(cellKey, new Map(entries));
        }
        // Overlay child entries. Same (cellKey, level) → field-merge;
        // child-only → take verbatim.
        for (const [cellKey, childEntries] of child.cells) {
            const target = merged.get(cellKey);
            if (target === undefined) {
                merged.set(cellKey, new Map(childEntries));
                continue;
            }
            for (const [level, childOpts] of childEntries) {
                const parentOpts = target.get(level);
                if (parentOpts === undefined) {
                    target.set(level, childOpts);
                    continue;
                }
                target.set(level, mergePresetOptions(cellKey, parentOpts, childOpts));
            }
        }
        return new PresetDefaults(merged);
    }
    /** Register a (level, delta) on the image-compress cell. Immutable. */
    imageCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'image_compress', level, ImageCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the audio-compress cell. Immutable. */
    audioCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'audio_compress', level, AudioCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the video-compress cell. Immutable. */
    videoCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'video_compress', level, VideoCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the document-pdf-compress cell. Immutable. */
    pdfCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'document_pdf_compress', level, DocumentPdfCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the document-office-compress cell. Immutable. */
    officeCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'document_office_compress', level, DocumentOfficeCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the document-odf-compress cell. Immutable. */
    odfCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'document_odf_compress', level, DocumentOdfCompressPresetOptions.from(input)));
    }
    /** Register a (level, delta) on the document-epub-compress cell. Immutable. */
    epubCompress(level, input = {}) {
        return new PresetDefaults(withCellEntry(this.cells, 'document_epub_compress', level, DocumentEpubCompressPresetOptions.from(input)));
    }
    /**
     * Return the user-supplied delta registered for `(media, op, level)`,
     * or `undefined` if none was registered.
     *
     * @internal — consumed by the T4b resolver. Not part of the public
     * surface; the resolver imports it via the type-only re-export.
     */
    cellFor(media, op, level) {
        const entries = this.cells.get(cellKeyOf(media, op));
        return entries?.get(level);
    }
}
/**
 * Construct an empty {@link PresetDefaults} builder. Chain per-cell
 * methods to register layered defaults; the resolver in T4b consumes
 * the result via `cellFor(...)`.
 */
export function presetDefaults() {
    return PresetDefaults._empty();
}
