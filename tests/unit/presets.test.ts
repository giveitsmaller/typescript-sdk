import { describe, expect, it } from 'vitest';

import { translateEnum } from '../../src/ergonomic/presets/_translate.js';
import { PRESETS } from '../../src/generated/sdk_spec/presets.js';
import {
  presetDefaults,
  PresetDefaults,
  ImageCompressPresetOptions,
  AudioCompressPresetOptions,
  VideoCompressPresetOptions,
  DocumentPdfCompressPresetOptions,
  DocumentOfficeCompressPresetOptions,
  DocumentOdfCompressPresetOptions,
  DocumentEpubCompressPresetOptions,
  OptimizeFor,
  ImageMetadataPolicy,
  ImageFormat,
  VideoCodec,
  VideoPreset,
  AudioBitrate,
  AudioCodec,
  AudioSampleRate,
  PdfProfile,
  PdfColorspace,
} from '../../src/index.js';
import { create, type GislCreateOptions } from '../../src/gisl.js';

// ---------------------------------------------------------------------------
// Image compress — shipped defaults per OptimizeFor
// ---------------------------------------------------------------------------

describe('ImageCompressPresetOptions.shippedDefaultsFor', () => {
  // contracts v2.80.0 (compress.image honesty pass — lossy-only): image_compress
  // presets carry only quality / metadata / outputFormat. mode / iccProfile /
  // progressive were dropped. v2.107.0 metadata rename: the shipped default is now
  // `strip` (the canonical token; `all` is a DEPRECATED alias of strip).
  it('Size — quality 65, metadata strip, outputFormat original; leaves width/height/fit undefined', () => {
    const opts = ImageCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(opts.quality).toBe(65);
    expect(opts.metadata).toBe(ImageMetadataPolicy.Strip);
    expect(opts.metadata).toBe('strip');
    // VcPeRWdD (contracts v2.73.0): Size outputFormat re-pointed Smallest -> Original
    // (`smallest` is now per_value_availability:planned — the facade self-422 guard).
    expect(opts.outputFormat).toBe(ImageFormat.Original);
    expect(opts.outputFormat).toBe('original');
  });

  it('Balanced (default) — quality 80, metadata strip, outputFormat original', () => {
    const opts = ImageCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(opts.quality).toBe(80);
    expect(opts.metadata).toBe(ImageMetadataPolicy.Strip);
    // VcPeRWdD: Balanced outputFormat re-pointed Auto -> Original (`auto` now planned).
    expect(opts.outputFormat).toBe(ImageFormat.Original);
  });

  it('Quality — quality 92, metadata strip, outputFormat original', () => {
    const opts = ImageCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    // v2.80.0: Quality now ships quality:92 (lossy-only — no more Lossless omission).
    expect(opts.quality).toBe(92);
    expect(opts.metadata).toBe(ImageMetadataPolicy.Strip);
    expect(opts.outputFormat).toBe(ImageFormat.Original);
  });
});

// ---------------------------------------------------------------------------
// Audio / Video / PDF / Office / ODF / EPUB — coverage smoke
// ---------------------------------------------------------------------------

describe('AudioCompressPresetOptions.shippedDefaultsFor', () => {
  it('translates quoted numeric enum members ("_96") to wire numbers (96)', () => {
    const size = AudioCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(size.bitrate).toBe(AudioBitrate._96);
    expect(size.bitrate).toBe(96);
    expect(size.sampleRate).toBe(AudioSampleRate._44100);
    expect(size.sampleRate).toBe(44100);
    expect(size.normalize).toBe(true);
  });

  it('Balanced / Quality cells differ on bitrate + sampleRate', () => {
    const balanced = AudioCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(balanced.bitrate).toBe(192);
    expect(balanced.sampleRate).toBe(44100);
    expect(balanced.normalize).toBe(true);

    const quality = AudioCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(quality.bitrate).toBe(320);
    expect(quality.sampleRate).toBe(48000);
    expect(quality.normalize).toBe(false);
  });

  it('channels is undefined in shipped cells (content-driven)', () => {
    const opts = AudioCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(opts.channels).toBeUndefined();
  });
});

describe('VideoCompressPresetOptions.shippedDefaultsFor', () => {
  // v2.66.0 (contracts ADR-0020): video_compress presets no longer bake
  // codec / audioCodec / faststart. Those are container-coupled, so the server
  // container-resolves effective defaults for the unset options (sparse-delta) —
  // a WebM target can no longer 422 on a baked MP4-oriented codec.
  // v2.71.0 (rza1htNO): audioBitrate ALSO dropped — the worker rejects
  // audio_bitrate + the default `copy` audio_codec (presets don't set audioCodec),
  // so audio re-encode is now opt-in. Presets carry only crf / preset.
  it('Size cell — CRF 30, Slow preset; audioBitrate/codec/audioCodec/faststart server-resolved', () => {
    const opts = VideoCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(opts.crf).toBe(30);
    expect(opts.preset).toBe(VideoPreset.Slow);
    expect(opts.audioBitrate).toBeUndefined();
    expect(opts.codec).toBeUndefined();
    expect(opts.audioCodec).toBeUndefined();
    expect(opts.faststart).toBeUndefined();
  });

  it('Balanced cell — CRF 23, Medium preset; audioBitrate/codec server-resolved', () => {
    const opts = VideoCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(opts.crf).toBe(23);
    expect(opts.preset).toBe(VideoPreset.Medium);
    expect(opts.audioBitrate).toBeUndefined();
    expect(opts.codec).toBeUndefined();
    expect(opts.faststart).toBeUndefined();
  });

  it('width / height / fit / fps / targetSize undefined in shipped cells', () => {
    const opts = VideoCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(opts.width).toBeUndefined();
    expect(opts.height).toBeUndefined();
    expect(opts.fit).toBeUndefined();
    expect(opts.fps).toBeUndefined();
    expect(opts.targetSize).toBeUndefined();
  });
});

describe('DocumentPdfCompressPresetOptions.shippedDefaultsFor', () => {
  it('Size — Screen profile + grayscale=true (v2.96.0 Acrobat-PDF realignment)', () => {
    const opts = DocumentPdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(opts.profile).toBe(PdfProfile.Screen);
    expect(opts.profile).toBe('screen');
    expect(opts.grayscale).toBe(true);
  });

  it('Balanced / Quality differ on profile + drop grayscale', () => {
    const balanced = DocumentPdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(balanced.profile).toBe(PdfProfile.Ebook);
    expect(balanced.grayscale).toBe(false);
    const quality = DocumentPdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(quality.profile).toBe(PdfProfile.Printer);
    expect(quality.grayscale).toBe(false);
  });
});

describe('DocumentOfficeCompressPresetOptions.shippedDefaultsFor', () => {
  it('Size — all strip flags true', () => {
    const opts = DocumentOfficeCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(opts.stripMacros).toBe(true);
    expect(opts.stripHiddenData).toBe(true);
    expect(opts.stripUnusedFonts).toBe(true);
  });

  it('Balanced — only stripMacros stays true', () => {
    const opts = DocumentOfficeCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(opts.stripMacros).toBe(true);
    expect(opts.stripHiddenData).toBe(false);
    expect(opts.stripUnusedFonts).toBe(false);
  });

  it('Quality — every strip flag false', () => {
    const opts = DocumentOfficeCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(opts.stripMacros).toBe(false);
    expect(opts.stripHiddenData).toBe(false);
    expect(opts.stripUnusedFonts).toBe(false);
  });
});

describe('DocumentOdfCompressPresetOptions.shippedDefaultsFor', () => {
  it('Size / Balanced / Quality', () => {
    const size = DocumentOdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(size.stripMetadata).toBe(true);
    expect(size.stripUnusedStyles).toBe(true);

    const balanced = DocumentOdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(balanced.stripMetadata).toBe(true);
    expect(balanced.stripUnusedStyles).toBe(false);

    const quality = DocumentOdfCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(quality.stripMetadata).toBe(false);
    expect(quality.stripUnusedStyles).toBe(false);
  });
});

describe('DocumentEpubCompressPresetOptions.shippedDefaultsFor', () => {
  it('Size / Balanced / Quality', () => {
    const size = DocumentEpubCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(size.fontSubsetting).toBe(true);
    expect(size.stripUnusedCss).toBe(true);

    const balanced = DocumentEpubCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(balanced.fontSubsetting).toBe(true);
    expect(balanced.stripUnusedCss).toBe(false);

    const quality = DocumentEpubCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Quality);
    expect(quality.fontSubsetting).toBe(false);
    expect(quality.stripUnusedCss).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sparse-delta construction via .from()
// ---------------------------------------------------------------------------

describe('*PresetOptions.from() — sparse-delta semantics', () => {
  it('image: from({ quality: 75 }) returns instance with only quality populated', () => {
    const opts = ImageCompressPresetOptions.from({ quality: 75 });
    expect(opts.quality).toBe(75);
    expect(opts.metadata).toBeUndefined();
    expect(opts.outputFormat).toBeUndefined();
  });

  it('video: from({ codec: H264, crf: 22 }) — exactly two fields populated', () => {
    const opts = VideoCompressPresetOptions.from({ codec: VideoCodec.H264, crf: 22 });
    expect(opts.codec).toBe('h264');
    expect(opts.crf).toBe(22);
    expect(opts.preset).toBeUndefined();
    expect(opts.audioCodec).toBeUndefined();
    expect(opts.audioBitrate).toBeUndefined();
    expect(opts.targetSize).toBeUndefined();
  });

  it('video: from() with targetSize accepts string', () => {
    const opts = VideoCompressPresetOptions.from({ targetSize: '50MB' });
    expect(opts.targetSize).toBe('50MB');
  });

  it('video: from() with targetSize accepts number (bytes)', () => {
    const opts = VideoCompressPresetOptions.from({ targetSize: 52_428_800 });
    expect(opts.targetSize).toBe(52_428_800);
  });

  it('audio: from({}) returns instance with every field undefined', () => {
    const opts = AudioCompressPresetOptions.from({});
    expect(opts.bitrate).toBeUndefined();
    expect(opts.channels).toBeUndefined();
    expect(opts.sampleRate).toBeUndefined();
    expect(opts.normalize).toBeUndefined();
  });

  it('image: instance is frozen — cannot mutate after construction', () => {
    const opts = ImageCompressPresetOptions.from({ quality: 75 });
    expect(Object.isFrozen(opts)).toBe(true);
    expect(() => {
      (opts as { quality?: number }).quality = 90;
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// PresetDefaults builder — immutability + cellFor lookup
// ---------------------------------------------------------------------------

describe('presetDefaults() / PresetDefaults', () => {
  it('returns a PresetDefaults instance with no registered cells', () => {
    const d = presetDefaults();
    expect(d).toBeInstanceOf(PresetDefaults);
    expect(d.cellFor('image', 'compress', OptimizeFor.Size)).toBeUndefined();
  });

  it('imageCompress(Size, { quality: 75 }).cellFor("image","compress",Size) returns sparse delta', () => {
    // The headline AC.
    const d = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 });
    const cell = d.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell).toBeInstanceOf(ImageCompressPresetOptions);
    expect(cell?.quality).toBe(75);
    expect(cell?.metadata).toBeUndefined();
    expect(cell?.outputFormat).toBeUndefined();
  });

  it('imageCompress(level) with no options registers empty delta', () => {
    const d = presetDefaults().imageCompress(OptimizeFor.Balanced);
    const cell = d.cellFor('image', 'compress', OptimizeFor.Balanced);
    expect(cell).toBeInstanceOf(ImageCompressPresetOptions);
    // Empty input → every field undefined; resolver will use shipped defaults.
    expect(cell?.quality).toBeUndefined();
    expect(cell?.metadata).toBeUndefined();
  });

  it('cellFor returns undefined for an unregistered (media, op, level) tuple', () => {
    const d = presetDefaults().imageCompress(OptimizeFor.Size);
    // Registered at Size — Quality lookup is undefined.
    expect(d.cellFor('image', 'compress', OptimizeFor.Quality)).toBeUndefined();
    // Image registered — video lookup is undefined.
    expect(d.cellFor('video', 'compress', OptimizeFor.Size)).toBeUndefined();
  });

  it('builder is immutable — second per-cell call returns a distinct PresetDefaults', () => {
    const a = presetDefaults();
    const b = a.imageCompress(OptimizeFor.Size, { quality: 65 });
    const c = a.imageCompress(OptimizeFor.Size, { quality: 90 });
    expect(b).not.toBe(c);
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
    // Original `a` still has no registered cells.
    expect(a.cellFor('image', 'compress', OptimizeFor.Size)).toBeUndefined();
    // Branches preserve their own registrations.
    expect(b.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(65);
    expect(c.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(90);
  });

  it('PresetDefaults instance is frozen', () => {
    const d = presetDefaults().imageCompress(OptimizeFor.Size);
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('chained per-cell calls register every cell independently', () => {
    const d = presetDefaults()
      .imageCompress(OptimizeFor.Size, { quality: 70 })
      .videoCompress(OptimizeFor.Quality, { codec: VideoCodec.H264, crf: 18 })
      .audioCompress(OptimizeFor.Balanced, { bitrate: AudioBitrate._192 })
      .pdfCompress(OptimizeFor.Size, { profile: PdfProfile.Printer })
      .officeCompress(OptimizeFor.Balanced, { stripHiddenData: true })
      .odfCompress(OptimizeFor.Quality, { stripMetadata: false })
      .epubCompress(OptimizeFor.Size, { fontSubsetting: true });

    expect(d.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(70);
    expect(d.cellFor('video', 'compress', OptimizeFor.Quality)?.crf).toBe(18);
    expect(d.cellFor('audio', 'compress', OptimizeFor.Balanced)?.bitrate).toBe(AudioBitrate._192);
    expect(d.cellFor('document_pdf', 'compress', OptimizeFor.Size)?.profile).toBe(PdfProfile.Printer);
    expect(d.cellFor('document_office', 'compress', OptimizeFor.Balanced)?.stripHiddenData).toBe(true);
    expect(d.cellFor('document_odf', 'compress', OptimizeFor.Quality)?.stripMetadata).toBe(false);
    expect(d.cellFor('document_epub', 'compress', OptimizeFor.Size)?.fontSubsetting).toBe(true);
  });

  it('a cell registered at two different levels keeps both entries (level-keyed map)', () => {
    const d = presetDefaults()
      .imageCompress(OptimizeFor.Size, { quality: 60 })
      .imageCompress(OptimizeFor.Quality, { quality: 95 });
    expect(d.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(60);
    expect(d.cellFor('image', 'compress', OptimizeFor.Quality)?.quality).toBe(95);
    // Re-registration at the SAME level should overwrite — last write wins.
    const e = d.imageCompress(OptimizeFor.Size, { quality: 70 });
    expect(e.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(70);
    // And the previous PresetDefaults `d` is unaffected.
    expect(d.cellFor('image', 'compress', OptimizeFor.Size)?.quality).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Wiring into GislCreateOptions (typed slot — no runtime behaviour change)
// ---------------------------------------------------------------------------

describe('GislCreateOptions.presetDefaults', () => {
  it('accepts a PresetDefaults instance in the create() options shape (type-level)', () => {
    // Static type assertion — the .satisfies check fails at compile if
    // presetDefaults is not in the create-options surface.
    const opts: GislCreateOptions = {
      apiKey: 'test',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
    };
    expect(opts.presetDefaults).toBeInstanceOf(PresetDefaults);
  });

  it('create({ apiKey, presetDefaults }) does not throw and does not leak the slot into transport config', async () => {
    const client = await create({
      apiKey: 'k_test_dummy',
      baseUrl: 'https://example.invalid',
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
    });
    // The ergonomic client wraps the low-level GislClient — type-narrowing
    // here just confirms the construction path accepted the slot.
    expect(client).toBeDefined();
    // The slot is read by the T4b resolver, NOT stored on the client.
    expect((client as unknown as { presetDefaults?: unknown }).presetDefaults).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ergonomic enum wire-value invariant
// ---------------------------------------------------------------------------

describe('ergonomic enums serialise to wire backing values', () => {
  it('ImageMetadataPolicy / ImageFormat', () => {
    // v2.80.0: ImageMode + IccProfilePolicy were removed entirely.
    // v2.107.0 metadata rename: `strip` is the canonical token (default); `keep`
    // preserves; `all` is now a DEPRECATED alias of `strip` (still serialises to 'all').
    // v2.92.0: compress.image output_format facade pruned to the live set —
    // ImageFormat now carries only Original + Webp.
    expect(ImageMetadataPolicy.Strip).toBe('strip');
    expect(ImageMetadataPolicy.Keep).toBe('keep');
    expect(ImageMetadataPolicy.All).toBe('all');
    expect(ImageFormat.Original).toBe('original');
    expect(ImageFormat.Webp).toBe('webp');
  });

  it('VideoCodec / VideoPreset', () => {
    expect(VideoCodec.H264).toBe('h264');
    expect(VideoCodec.H265).toBe('h265');
    expect(VideoPreset.Slow).toBe('slow');
    expect(VideoPreset.Medium).toBe('medium');
  });

  it('AudioBitrate / AudioSampleRate — numeric wire values', () => {
    expect(AudioBitrate._96).toBe(96);
    expect(AudioBitrate._128).toBe(128);
    expect(AudioBitrate._320).toBe(320);
    expect(AudioSampleRate._44100).toBe(44100);
    expect(AudioSampleRate._48000).toBe(48000);
  });

  it('AudioCodec / PdfProfile / PdfColorspace', () => {
    expect(AudioCodec.Aac).toBe('aac');
    expect(PdfProfile.Screen).toBe('screen');
    expect(PdfProfile.Prepress).toBe('prepress');
    expect(PdfColorspace.Grayscale).toBe('grayscale');
    expect(PdfColorspace.Unchanged).toBe('unchanged');
  });

  it('OptimizeFor enum stays distinct (ergonomic-only, not a wire enum)', () => {
    expect(OptimizeFor.Size).toBe('Size');
    expect(OptimizeFor.Balanced).toBe('Balanced');
    expect(OptimizeFor.Quality).toBe('Quality');
  });
});

// ---------------------------------------------------------------------------
// PRESETS drift trip-wire — every key in PRESETS[cellKey][level] must
// appear as a property on the leaf DTO returned by shippedDefaultsFor.
// Catches a future regen that adds a field nobody wired into the leaf.
// ---------------------------------------------------------------------------

describe('PRESETS regen drift trip-wire', () => {
  const CELL_TO_LEAF = [
    { cellKey: 'image_compress', fn: ImageCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'audio_compress', fn: AudioCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'video_compress', fn: VideoCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'document_pdf_compress', fn: DocumentPdfCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'document_office_compress', fn: DocumentOfficeCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'document_odf_compress', fn: DocumentOdfCompressPresetOptions.shippedDefaultsFor },
    { cellKey: 'document_epub_compress', fn: DocumentEpubCompressPresetOptions.shippedDefaultsFor },
  ] as const;

  it('every cell key in F3 PRESETS has a corresponding leaf DTO', () => {
    const wired = new Set(CELL_TO_LEAF.map((c) => c.cellKey));
    for (const cellKey of Object.keys(PRESETS)) {
      expect(wired.has(cellKey as (typeof CELL_TO_LEAF)[number]['cellKey'])).toBe(true);
    }
  });

  it('every field PRESETS populates per cell × level shows up on the leaf DTO (no silent drops)', () => {
    for (const { cellKey, fn } of CELL_TO_LEAF) {
      const group = PRESETS[cellKey];
      for (const level of ['Size', 'Balanced', 'Quality'] as const) {
        const cell = group[level];
        const leaf = fn(level) as unknown as Record<string, unknown>;
        for (const fieldName of Object.keys(cell)) {
          // `in leaf` survives `Object.freeze` + private constructor.
          expect(fieldName in leaf).toBe(true);
          // The corresponding value must be defined — if it's undefined,
          // shippedDefaultsFor silently dropped a PRESETS field.
          expect(leaf[fieldName]).toBeDefined();
        }
      }
    }
  });

  it('image_compress Quality cell ships `quality` (v2.80.0 lossy-only honesty pass — was previously omitted under Lossless)', () => {
    expect('quality' in PRESETS.image_compress.Quality).toBe(true);
    expect(PRESETS.image_compress.Quality.quality).toBe(92);
  });
});

// ---------------------------------------------------------------------------
// translateEnum throw path (defence against F3 generator drift)
// ---------------------------------------------------------------------------

describe('translateEnum (internal)', () => {
  it('happy path: known member resolves to wire backing value', () => {
    expect(translateEnum('VideoCodec', 'H264')).toBe('h264');
    expect(translateEnum('AudioBitrate', '_96')).toBe(96);
    expect(translateEnum('PdfProfile', 'Screen')).toBe('screen');
  });

  it('throws on unknown member name (no silent fall-through to wire)', () => {
    expect(() => translateEnum('VideoCodec', 'NotAMember')).toThrow(/not a member of VideoCodec/);
  });

  it('throws on inherited-property names like "toString" (Object.hasOwn — not `in`)', () => {
    // Without an own-property check, the prototype-chain `in` operator
    // would silently return Object.prototype.toString, shipping a function
    // to the wire. Codex review round 1 finding 1791738ed47c.
    expect(() => translateEnum('VideoCodec', 'toString')).toThrow(/not a member of VideoCodec/);
    expect(() => translateEnum('VideoCodec', 'hasOwnProperty')).toThrow(/not a member of VideoCodec/);
    expect(() => translateEnum('AudioBitrate', 'constructor')).toThrow(/not a member of AudioBitrate/);
  });

  it('error message lists known members so the regen drift is diagnosable', () => {
    try {
      translateEnum('VideoCodec', 'BogusKey');
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Known members:/);
      expect(msg).toContain('H264');
      expect(msg).toContain('H265');
      expect(msg).toContain('Av1');
    }
  });
});
