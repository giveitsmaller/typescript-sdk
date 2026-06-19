import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import { ImageCompressPresetOptions, type ImageCompressPresetOptionsInput } from './image_compress.js';
import { AudioCompressPresetOptions, type AudioCompressPresetOptionsInput } from './audio_compress.js';
import { VideoCompressPresetOptions, type VideoCompressPresetOptionsInput } from './video_compress.js';
import { DocumentPdfCompressPresetOptions, type DocumentPdfCompressPresetOptionsInput } from './document_pdf_compress.js';
import { DocumentOfficeCompressPresetOptions, type DocumentOfficeCompressPresetOptionsInput } from './document_office_compress.js';
import { DocumentOdfCompressPresetOptions, type DocumentOdfCompressPresetOptionsInput } from './document_odf_compress.js';
import { DocumentEpubCompressPresetOptions, type DocumentEpubCompressPresetOptionsInput } from './document_epub_compress.js';
export { ImageCompressPresetOptions, type ImageCompressPresetOptionsInput, } from './image_compress.js';
export { AudioCompressPresetOptions, type AudioCompressPresetOptionsInput, } from './audio_compress.js';
export { VideoCompressPresetOptions, type VideoCompressPresetOptionsInput, } from './video_compress.js';
export { DocumentPdfCompressPresetOptions, type DocumentPdfCompressPresetOptionsInput, } from './document_pdf_compress.js';
export { DocumentOfficeCompressPresetOptions, type DocumentOfficeCompressPresetOptionsInput, } from './document_office_compress.js';
export { DocumentOdfCompressPresetOptions, type DocumentOdfCompressPresetOptionsInput, } from './document_odf_compress.js';
export { DocumentEpubCompressPresetOptions, type DocumentEpubCompressPresetOptionsInput, } from './document_epub_compress.js';
export { OptimizeFor, ImageMode, ImageMetadataPolicy, IccProfilePolicy, ImageFormat, VideoCodec, VideoPreset, VideoFit, AudioBitrate, AudioCodec, AudioSampleRate, PdfProfile, PdfColorspace, } from '../../generated/sdk_spec/enums.js';
/** Supported media×op pairs for preset cells in T4a. Compress-only. */
export type PresetMedia = 'image' | 'audio' | 'video' | 'document_pdf' | 'document_office' | 'document_odf' | 'document_epub';
export type PresetOp = 'compress';
/**
 * Union of leaf-DTO types the resolver will see from `cellFor()`.
 * Discriminated by which `media` the caller passes — the type system
 * narrows the return automatically via the overload set below.
 */
export type AnyPresetOptions = ImageCompressPresetOptions | AudioCompressPresetOptions | VideoCompressPresetOptions | DocumentPdfCompressPresetOptions | DocumentOfficeCompressPresetOptions | DocumentOdfCompressPresetOptions | DocumentEpubCompressPresetOptions;
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
export declare function definedFieldsOf<T extends object>(opts: T): Partial<Record<string, unknown>>;
export declare class PresetDefaults {
    private readonly cells;
    private constructor();
    /** Empty builder — entry point for `presetDefaults()`. @internal */
    static _empty(): PresetDefaults;
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
    static merge(parent: PresetDefaults, child: PresetDefaults): PresetDefaults;
    /** Register a (level, delta) on the image-compress cell. Immutable. */
    imageCompress(level: OptimizeFor, input?: ImageCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the audio-compress cell. Immutable. */
    audioCompress(level: OptimizeFor, input?: AudioCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the video-compress cell. Immutable. */
    videoCompress(level: OptimizeFor, input?: VideoCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the document-pdf-compress cell. Immutable. */
    pdfCompress(level: OptimizeFor, input?: DocumentPdfCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the document-office-compress cell. Immutable. */
    officeCompress(level: OptimizeFor, input?: DocumentOfficeCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the document-odf-compress cell. Immutable. */
    odfCompress(level: OptimizeFor, input?: DocumentOdfCompressPresetOptionsInput): PresetDefaults;
    /** Register a (level, delta) on the document-epub-compress cell. Immutable. */
    epubCompress(level: OptimizeFor, input?: DocumentEpubCompressPresetOptionsInput): PresetDefaults;
    /** @internal */ cellFor(media: 'image', op: 'compress', level: OptimizeFor): ImageCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'audio', op: 'compress', level: OptimizeFor): AudioCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'video', op: 'compress', level: OptimizeFor): VideoCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'document_pdf', op: 'compress', level: OptimizeFor): DocumentPdfCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'document_office', op: 'compress', level: OptimizeFor): DocumentOfficeCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'document_odf', op: 'compress', level: OptimizeFor): DocumentOdfCompressPresetOptions | undefined;
    /** @internal */ cellFor(media: 'document_epub', op: 'compress', level: OptimizeFor): DocumentEpubCompressPresetOptions | undefined;
}
/**
 * Construct an empty {@link PresetDefaults} builder. Chain per-cell
 * methods to register layered defaults; the resolver in T4b consumes
 * the result via `cellFor(...)`.
 */
export declare function presetDefaults(): PresetDefaults;
