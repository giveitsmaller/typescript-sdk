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

import { OptimizeFor } from '../../generated/sdk_spec/enums.js';
import {
  ImageCompressPresetOptions,
  type ImageCompressPresetOptionsInput,
} from './image_compress.js';
import {
  AudioCompressPresetOptions,
  type AudioCompressPresetOptionsInput,
} from './audio_compress.js';
import {
  VideoCompressPresetOptions,
  type VideoCompressPresetOptionsInput,
} from './video_compress.js';
import {
  DocumentPdfCompressPresetOptions,
  type DocumentPdfCompressPresetOptionsInput,
} from './document_pdf_compress.js';
import {
  DocumentOfficeCompressPresetOptions,
  type DocumentOfficeCompressPresetOptionsInput,
} from './document_office_compress.js';
import {
  DocumentOdfCompressPresetOptions,
  type DocumentOdfCompressPresetOptionsInput,
} from './document_odf_compress.js';
import {
  DocumentEpubCompressPresetOptions,
  type DocumentEpubCompressPresetOptionsInput,
} from './document_epub_compress.js';

// Re-export everything callers need from this module's root.
export {
  ImageCompressPresetOptions,
  type ImageCompressPresetOptionsInput,
} from './image_compress.js';
export {
  AudioCompressPresetOptions,
  type AudioCompressPresetOptionsInput,
} from './audio_compress.js';
export {
  VideoCompressPresetOptions,
  type VideoCompressPresetOptionsInput,
} from './video_compress.js';
export {
  DocumentPdfCompressPresetOptions,
  type DocumentPdfCompressPresetOptionsInput,
} from './document_pdf_compress.js';
export {
  DocumentOfficeCompressPresetOptions,
  type DocumentOfficeCompressPresetOptionsInput,
} from './document_office_compress.js';
export {
  DocumentOdfCompressPresetOptions,
  type DocumentOdfCompressPresetOptionsInput,
} from './document_odf_compress.js';
export {
  DocumentEpubCompressPresetOptions,
  type DocumentEpubCompressPresetOptionsInput,
} from './document_epub_compress.js';

// Re-export ergonomic enums for callers (single canonical path).
export {
  OptimizeFor,
  ImageMode,
  ImageFit,
  ImageMetadataPolicy,
  IccProfilePolicy,
  ImageFormat,
  VideoCodec,
  VideoPreset,
  VideoFit,
  AudioBitrate,
  AudioCodec,
  AudioSampleRate,
  PdfProfile,
  PdfColorspace,
} from '../../generated/sdk_spec/enums.js';

// ---------------------------------------------------------------------------
// cellFor signature
// ---------------------------------------------------------------------------

/** Supported media×op pairs for preset cells in T4a. Compress-only. */
export type PresetMedia =
  | 'image'
  | 'audio'
  | 'video'
  | 'document_pdf'
  | 'document_office'
  | 'document_odf'
  | 'document_epub';

export type PresetOp = 'compress';

/**
 * Union of leaf-DTO types the resolver will see from `cellFor()`.
 * Discriminated by which `media` the caller passes — the type system
 * narrows the return automatically via the overload set below.
 */
export type AnyPresetOptions =
  | ImageCompressPresetOptions
  | AudioCompressPresetOptions
  | VideoCompressPresetOptions
  | DocumentPdfCompressPresetOptions
  | DocumentOfficeCompressPresetOptions
  | DocumentOdfCompressPresetOptions
  | DocumentEpubCompressPresetOptions;

// ---------------------------------------------------------------------------
// PresetDefaults builder
// ---------------------------------------------------------------------------

/** Internal storage shape. Keyed by `<media>_<op>` + OptimizeFor level. */
type CellKey =
  | 'image_compress'
  | 'audio_compress'
  | 'video_compress'
  | 'document_pdf_compress'
  | 'document_office_compress'
  | 'document_odf_compress'
  | 'document_epub_compress';

type CellEntries = ReadonlyMap<OptimizeFor, AnyPresetOptions>;

function cellKeyOf(media: PresetMedia, op: PresetOp): CellKey {
  return `${media}_${op}` as CellKey;
}

/**
 * Append `(level, options)` into a fresh map under `cellKey`, returning
 * a new outer map. Both layers stay immutable — callers' references to
 * the previous PresetDefaults remain unchanged.
 */
function withCellEntry(
  prev: ReadonlyMap<CellKey, CellEntries>,
  cellKey: CellKey,
  level: OptimizeFor,
  options: AnyPresetOptions,
): ReadonlyMap<CellKey, CellEntries> {
  const next = new Map(prev);
  const prevEntries = prev.get(cellKey);
  const nextEntries = new Map(prevEntries ?? []);
  nextEntries.set(level, options);
  next.set(cellKey, nextEntries);
  return next;
}

export class PresetDefaults {
  private readonly cells: ReadonlyMap<CellKey, CellEntries>;

  private constructor(cells: ReadonlyMap<CellKey, CellEntries>) {
    this.cells = cells;
    Object.freeze(this);
  }

  /** Empty builder — entry point for `presetDefaults()`. @internal */
  static _empty(): PresetDefaults {
    return new PresetDefaults(new Map());
  }

  /** Register a (level, delta) on the image-compress cell. Immutable. */
  imageCompress(level: OptimizeFor, input: ImageCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'image_compress', level, ImageCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the audio-compress cell. Immutable. */
  audioCompress(level: OptimizeFor, input: AudioCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'audio_compress', level, AudioCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the video-compress cell. Immutable. */
  videoCompress(level: OptimizeFor, input: VideoCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'video_compress', level, VideoCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the document-pdf-compress cell. Immutable. */
  pdfCompress(level: OptimizeFor, input: DocumentPdfCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'document_pdf_compress', level, DocumentPdfCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the document-office-compress cell. Immutable. */
  officeCompress(
    level: OptimizeFor,
    input: DocumentOfficeCompressPresetOptionsInput = {},
  ): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'document_office_compress', level, DocumentOfficeCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the document-odf-compress cell. Immutable. */
  odfCompress(level: OptimizeFor, input: DocumentOdfCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'document_odf_compress', level, DocumentOdfCompressPresetOptions.from(input)),
    );
  }

  /** Register a (level, delta) on the document-epub-compress cell. Immutable. */
  epubCompress(level: OptimizeFor, input: DocumentEpubCompressPresetOptionsInput = {}): PresetDefaults {
    return new PresetDefaults(
      withCellEntry(this.cells, 'document_epub_compress', level, DocumentEpubCompressPresetOptions.from(input)),
    );
  }

  // Overload set: narrowing return type by media.
  /** @internal */ cellFor(media: 'image', op: 'compress', level: OptimizeFor): ImageCompressPresetOptions | undefined;
  /** @internal */ cellFor(media: 'audio', op: 'compress', level: OptimizeFor): AudioCompressPresetOptions | undefined;
  /** @internal */ cellFor(media: 'video', op: 'compress', level: OptimizeFor): VideoCompressPresetOptions | undefined;
  /** @internal */ cellFor(
    media: 'document_pdf',
    op: 'compress',
    level: OptimizeFor,
  ): DocumentPdfCompressPresetOptions | undefined;
  /** @internal */ cellFor(
    media: 'document_office',
    op: 'compress',
    level: OptimizeFor,
  ): DocumentOfficeCompressPresetOptions | undefined;
  /** @internal */ cellFor(
    media: 'document_odf',
    op: 'compress',
    level: OptimizeFor,
  ): DocumentOdfCompressPresetOptions | undefined;
  /** @internal */ cellFor(
    media: 'document_epub',
    op: 'compress',
    level: OptimizeFor,
  ): DocumentEpubCompressPresetOptions | undefined;
  /**
   * Return the user-supplied delta registered for `(media, op, level)`,
   * or `undefined` if none was registered.
   *
   * @internal — consumed by the T4b resolver. Not part of the public
   * surface; the resolver imports it via the type-only re-export.
   */
  cellFor(
    media: PresetMedia,
    op: PresetOp,
    level: OptimizeFor,
  ): AnyPresetOptions | undefined {
    const entries = this.cells.get(cellKeyOf(media, op));
    return entries?.get(level);
  }
}

/**
 * Construct an empty {@link PresetDefaults} builder. Chain per-cell
 * methods to register layered defaults; the resolver in T4b consumes
 * the result via `cellFor(...)`.
 */
export function presetDefaults(): PresetDefaults {
  return PresetDefaults._empty();
}
