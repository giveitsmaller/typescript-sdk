import { describe, expect, it } from 'vitest';

import { PRESET_VERSION as GENERATED_PRESET_VERSION } from '../../src/generated/sdk_spec/version.js';
import {
  resolveCompressOptions,
  PRESET_VERSION,
  presetDefaults,
  PresetDefaults,
  ImageCompressPresetOptions,
  AudioCompressPresetOptions,
  VideoCompressPresetOptions,
  OptimizeFor,
  VideoCodec,
  AudioBitrate,
  ImageMetadataPolicy,
  ImageFormat,
} from '../../src/index.js';
import { _parseTargetSize } from '../../src/ergonomic/preset_resolver.js';
import { GislConfigError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Layer 1 — SDK shipped defaults
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 1 (sdkDefault)', () => {
  it('image OptimizeFor.Size shipped defaults flow into wire payload', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    // v2.80.0 (compress.image honesty pass — lossy-only): the image-compress
    // wire surface is now only {quality, metadata, output_format}. mode /
    // icc_profile / progressive are no longer emitted.
    expect(wireOptions.quality).toBe(65);
    expect(wireOptions.metadata).toBe('all');
    // VcPeRWdD (contracts v2.73.0): Size outputFormat re-pointed Smallest -> Original.
    expect(wireOptions.output_format).toBe('original');
    expect('mode' in wireOptions).toBe(false);
    expect('icc_profile' in wireOptions).toBe(false);
    expect('progressive' in wireOptions).toBe(false);
    expect(resolvedOptions.preset).toBe(OptimizeFor.Size);
    expect(resolvedOptions.sources.sdkDefault).toContain('quality');
    expect(resolvedOptions.sources.sdkDefault).toContain('metadata');
    expect(resolvedOptions.sources.sdkDefault).toContain('output_format');
    expect(resolvedOptions.sources.explicit).toEqual([]);
  });

  it('no-optimize: no shipped defaults apply', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
    });
    expect(wireOptions).toEqual({});
    expect(resolvedOptions.preset).toBeNull();
    expect(resolvedOptions.sources.sdkDefault).toEqual([]);
  });

  it('no-optimize + explicit knobs: only the explicit fields land on the wire', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 80 },
    });
    expect(wireOptions).toEqual({ quality: 80 });
    expect(resolvedOptions.preset).toBeNull();
    expect(resolvedOptions.sources.sdkDefault).toEqual([]);
    expect(resolvedOptions.sources.explicit).toEqual(['quality']);
    // Back-compat mirror.
    expect(resolvedOptions.overrides).toEqual(['quality']);
  });

  it('audio Size shipped defaults — numeric wire bitrate / sample_rate via _PresetOptions translation', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'audio',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(wireOptions.bitrate).toBe(96);
    expect(wireOptions.sample_rate).toBe(44100);
    expect(wireOptions.normalize).toBe(true);
    expect([...resolvedOptions.sources.sdkDefault].sort()).toEqual(['bitrate', 'normalize', 'sample_rate'].sort());
  });

  it('video Size shipped defaults — CRF 30 Slow preset; audio_bitrate/codec/audio_codec server-resolved', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(wireOptions.crf).toBe(30);
    expect(wireOptions.preset).toBe('slow');
    // v2.71.0 (rza1htNO): audioBitrate dropped from video_compress presets
    // (audio re-encode is opt-in — the worker rejects audio_bitrate + default
    // `copy` audio_codec), so it no longer reaches the wire from a preset.
    expect(wireOptions.audio_bitrate).toBeUndefined();
    // v2.66.0 (ADR-0020): presets no longer bake codec / audio_codec / faststart;
    // the server container-resolves them (sparse-delta), so they are absent here.
    expect(wireOptions.codec).toBeUndefined();
    expect(wireOptions.audio_codec).toBeUndefined();
    expect(wireOptions.faststart).toBeUndefined();
    // crf with no targetSize implies encoding_mode='crf' (resolver derives).
    expect(wireOptions.encoding_mode).toBe('crf');
    expect(resolvedOptions.sources.sdkDefault).toContain('encoding_mode');
  });

  it('image Quality cell — quality 92 on wire, no mode key (v2.80.0 lossy-only)', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Quality,
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(92);
    expect('mode' in wireOptions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — client.presetDefaults
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 2 (clientDefault)', () => {
  const defaults = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 });

  it('client default OVERRIDES sdkDefault for the same level', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(75); // client beats sdkDefault's 65
    expect(wireOptions.metadata).toBe('all'); // metadata untouched by client, falls back to sdkDefault
    expect(resolvedOptions.sources.clientDefault).toEqual(['quality']);
    expect(resolvedOptions.sources.sdkDefault).toContain('metadata');
  });

  it('client default for a different level does NOT apply when caller picks another level', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Quality,
      presetDefaults: defaults,
      explicitOptions: {},
    });
    // defaults are registered at Size only — Quality cell lookup is undefined.
    expect(resolvedOptions.sources.clientDefault).toEqual([]);
  });

  it('no optimize: layer 2 is bypassed entirely (no cell to look up)', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetDefaults: defaults,
      explicitOptions: {},
    });
    expect(wireOptions).toEqual({});
    expect(resolvedOptions.sources.clientDefault).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — scoped (reserved, always empty in T4b)
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 3 (scopedDefault, reserved for T4c)', () => {
  it('scopedDefault is always [] in T4b', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 70 }),
      presetOverrides: { quality: 60 },
      explicitOptions: { quality: 60 },
    });
    expect(resolvedOptions.sources.scopedDefault).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — per-call presetOverrides
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 4 (callPresetOverride)', () => {
  it('presetOverrides BEAT clientDefault on the same field', () => {
    const defaults = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      presetOverrides: { quality: 70 },
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(70);
    expect(resolvedOptions.sources.callPresetOverride).toEqual(['quality']);
    expect(resolvedOptions.sources.clientDefault).toEqual([]); // client lost on quality
  });

  it('presetOverrides BEAT sdkDefault on the same field', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 90 },
      explicitOptions: {},
    });
    expect(wireOptions.quality).toBe(90);
    expect(resolvedOptions.sources.callPresetOverride).toEqual(['quality']);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — explicit knobs (highest precedence)
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — layer 5 (explicit) wins over every lower layer', () => {
  it('explicit beats sdkDefault', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { quality: 100 },
    });
    expect(wireOptions.quality).toBe(100);
    expect(resolvedOptions.sources.explicit).toContain('quality');
    expect(resolvedOptions.sources.sdkDefault).not.toContain('quality');
  });

  it('explicit beats clientDefault', () => {
    const defaults = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 70 });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      explicitOptions: { quality: 95 },
    });
    expect(wireOptions.quality).toBe(95);
    expect(resolvedOptions.sources.explicit).toEqual(['quality']);
    expect(resolvedOptions.sources.clientDefault).toEqual([]);
  });

  it('explicit beats presetOverrides', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 70 },
      explicitOptions: { quality: 95 },
    });
    expect(wireOptions.quality).toBe(95);
    expect(resolvedOptions.sources.explicit).toEqual(['quality']);
    expect(resolvedOptions.sources.callPresetOverride).toEqual([]);
  });

  it('explicit camelCase fields snake-cased on the wire', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { metadata: ImageMetadataPolicy.All, outputFormat: ImageFormat.Webp },
    });
    expect(wireOptions.metadata).toBe('all');
    expect(wireOptions.output_format).toBe('webp');
    expect([...resolvedOptions.sources.explicit].sort()).toEqual(['metadata', 'output_format']);
  });
});

// ---------------------------------------------------------------------------
// targetSize parser
// ---------------------------------------------------------------------------

describe('_parseTargetSize (binary multipliers)', () => {
  it('integer input passes through raw', () => {
    expect(_parseTargetSize(52_428_800)).toBe(52_428_800);
    expect(_parseTargetSize(1)).toBe(1);
  });

  it("'1KB' = 1024 (binary)", () => {
    expect(_parseTargetSize('1KB')).toBe(1024);
  });

  it("'1MB' = 1_048_576 (binary, matches contract target_size_bytes.min)", () => {
    expect(_parseTargetSize('1MB')).toBe(1_048_576);
  });

  it("'50MB' = 52_428_800 (matches plan canonical example)", () => {
    expect(_parseTargetSize('50MB')).toBe(52_428_800);
  });

  it("'1GB' = 2^30 = 1_073_741_824 (binary)", () => {
    expect(_parseTargetSize('1GB')).toBe(1_073_741_824);
  });

  it("'1.5GB' = floor(1.5 * 2^30) = 1_610_612_736", () => {
    expect(_parseTargetSize('1.5GB')).toBe(1_610_612_736);
  });

  it("'1TB' = 2^40", () => {
    expect(_parseTargetSize('1TB')).toBe(2 ** 40);
  });

  it("case-insensitive suffix: 'mb', 'mB', 'MB' all equivalent", () => {
    expect(_parseTargetSize('1mb')).toBe(1_048_576);
    expect(_parseTargetSize('1mB')).toBe(1_048_576);
    expect(_parseTargetSize('1MB')).toBe(1_048_576);
  });

  it('unitless string defaults to bytes', () => {
    expect(_parseTargetSize('1024')).toBe(1024);
  });

  it('rejects negative integers', () => {
    expect(() => _parseTargetSize(-1)).toThrow(GislConfigError);
    expect(() => _parseTargetSize(-1)).toThrow(/invalid_target_size|positive whole byte/);
  });

  it('rejects zero', () => {
    expect(() => _parseTargetSize(0)).toThrow(GislConfigError);
  });

  it('rejects non-integer numbers', () => {
    expect(() => _parseTargetSize(1.5)).toThrow(GislConfigError);
  });

  it('rejects Infinity / NaN', () => {
    expect(() => _parseTargetSize(Number.POSITIVE_INFINITY)).toThrow(GislConfigError);
    expect(() => _parseTargetSize(Number.NaN)).toThrow(GislConfigError);
  });

  it('rejects unknown unit suffix', () => {
    expect(() => _parseTargetSize('1XB')).toThrow(/unit '?XB'? is not recognised/);
  });

  it('rejects malformed string', () => {
    expect(() => _parseTargetSize('not a size')).toThrow(GislConfigError);
    expect(() => _parseTargetSize('MB')).toThrow(GislConfigError);
  });

  it('rejects non-string non-number input', () => {
    expect(() => _parseTargetSize(null)).toThrow(GislConfigError);
    expect(() => _parseTargetSize(undefined)).toThrow(GislConfigError);
    expect(() => _parseTargetSize({})).toThrow(GislConfigError);
  });

  it('error carries reason=invalid_target_size and conflictingFields=[targetSize]', () => {
    try {
      _parseTargetSize('bogus');
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('invalid_target_size');
      expect(e.conflictingFields).toEqual(['targetSize']);
      expect(e.suggestion).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// targetSize integration (video op): wire emits target_size_bytes + encoding_mode
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — targetSize derivation on video', () => {
  it("explicit targetSize='50MB' emits target_size_bytes=52428800 and encoding_mode='target_size'", () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      explicitOptions: { codec: VideoCodec.H264, targetSize: '50MB' },
    });
    expect(wireOptions.target_size_bytes).toBe(52_428_800);
    expect(wireOptions.encoding_mode).toBe('target_size');
    // targetSize is consumed (not in wire payload).
    expect('targetSize' in wireOptions).toBe(false);
    expect('target_size' in wireOptions).toBe(false);
  });

  it('integer targetSize: passed through raw', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      explicitOptions: { codec: VideoCodec.H264, targetSize: 52_428_800 },
    });
    expect(wireOptions.target_size_bytes).toBe(52_428_800);
    expect(wireOptions.encoding_mode).toBe('target_size');
  });

  it('targetSize sourced from client default still derives wire fields', () => {
    const defaults = presetDefaults().videoCompress(OptimizeFor.Size, {
      codec: VideoCodec.H264,
      targetSize: '100MB',
    });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      explicitOptions: {},
    });
    expect(wireOptions.target_size_bytes).toBe(100 * 1024 * 1024);
    expect(wireOptions.encoding_mode).toBe('target_size');
    expect(resolvedOptions.sources.clientDefault).toContain('target_size_bytes');
    expect(resolvedOptions.sources.clientDefault).toContain('encoding_mode');
  });
});

// ---------------------------------------------------------------------------
// Invalid-combo validations (all throw augmented GislConfigError)
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — invalid-combo validations', () => {
  it('targetSize + non-H264 codec → reason=invalid_combination, conflictingFields=[targetSize, codec]', () => {
    try {
      resolveCompressOptions({
        media: 'video',
        op: 'compress',
        explicitOptions: { codec: VideoCodec.H265, targetSize: '50MB' },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e).toBeInstanceOf(GislConfigError);
      expect(e.reason).toBe('invalid_combination');
      expect(e.conflictingFields).toEqual(['targetSize', 'codec']);
      expect(e.resolvedSnapshot).toBeDefined();
    }
  });

  it('post-merge: explicit H265 overrides client default H264 → still rejects targetSize', () => {
    const defaults = presetDefaults().videoCompress(OptimizeFor.Size, {
      codec: VideoCodec.H264,
      targetSize: '50MB',
    });
    expect(() =>
      resolveCompressOptions({
        media: 'video',
        op: 'compress',
        optimize: OptimizeFor.Size,
        presetDefaults: defaults,
        explicitOptions: { codec: VideoCodec.H265 },
      }),
    ).toThrow(/targetSize.*h265|invalid_combination/);
  });

  it('targetSize + explicit crf → reason=invalid_combination, conflictingFields=[targetSize, crf]', () => {
    try {
      resolveCompressOptions({
        media: 'video',
        op: 'compress',
        explicitOptions: { codec: VideoCodec.H264, targetSize: '50MB', crf: 22 },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('invalid_combination');
      expect(e.conflictingFields).toEqual(['targetSize', 'crf']);
    }
  });

  it('presetOverrides type mismatch (video-shaped overrides on image op) → reason=type_mismatch', () => {
    try {
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        presetOverrides: { codec: 'h264', crf: 22, preset: 'medium' },
        explicitOptions: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('type_mismatch');
      expect(e.conflictingFields).toContain('codec');
      expect(e.conflictingFields).toContain('crf');
    }
  });

  it('unknown field in explicit (nonsense field name) → unknown_field defence-in-depth', () => {
    try {
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        explicitOptions: { quality: 80, bogusField: 'oops' },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('unknown_field');
      expect(e.conflictingFields).toEqual(['bogusField']);
    }
  });
});

// ---------------------------------------------------------------------------
// presetConfigHash — present iff cell registered
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — presetConfigHash', () => {
  it('only sdkDefault participated → no hash', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBeUndefined();
  });

  it('explicit only → no hash (no clientDefault/scopedDefault/callPresetOverride)', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 80 },
    });
    expect(resolvedOptions.presetConfigHash).toBeUndefined();
  });

  it('clientDefault cell registered (even empty delta) → hash present', () => {
    const defaults = presetDefaults().imageCompress(OptimizeFor.Size);
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('callPresetOverride participated → hash present', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 70 },
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hash is deterministic: same inputs → same hash', () => {
    const inputs = {
      media: 'image' as const,
      op: 'compress' as const,
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 70 },
      explicitOptions: {},
    };
    const a = resolveCompressOptions(inputs).resolvedOptions.presetConfigHash;
    const b = resolveCompressOptions(inputs).resolvedOptions.presetConfigHash;
    expect(a).toBe(b);
  });

  it('hash differs when callPresetOverride changes', () => {
    const a = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 70 },
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const b = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 80 },
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    expect(a).not.toBe(b);
  });

  // CROSS-LANGUAGE DETERMINISM ANCHOR (koMKJjLY / P6). These exact digests
  // are ALSO pinned in the PHP suite (PresetResolverTest.php) for the SAME
  // logical inputs. If TS and PHP canonical-JSON serialisation ever diverge
  // (key ordering, the empty-cell `{}` edge, number formatting), one side's
  // pin breaks — that is the whole point of `presetConfigHash`. Do NOT relax
  // to a regex; the byte-identity across runners IS the contract.
  it('exact hash — single override {quality:70}, no optimize', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetOverrides: { quality: 70 },
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:5a5b9d555e824e78f2a06f0b57fe9c5c09c9e2fc396d79f2b0510a457018bd23',
    );
  });

  it('exact hash — override {metadata:"all", quality:70} canonical regardless of key order (cross-anchored with PHP)', () => {
    // v2.80.0: `progressive` left the image wire surface, so this key-sorting
    // anchor now uses two surviving image fields. Both insertion orders must
    // produce the SAME byte-identical digest, also pinned in the PHP suite.
    const a = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetOverrides: { quality: 70, metadata: 'all' },
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const b = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetOverrides: { metadata: 'all', quality: 70 },
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    expect(a).toBe(b);
    expect(a).toBe(
      'sha256:62daaae9d0b8717221d87f7a2e9823cea7fd833220b5cda7cdcd9c845f96c104',
    );
  });

  it('exact hash — empty registered override serialises as {}', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetOverrides: {},
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:1ff6cf5e4bcbc2dbeb458597b0726417ab369f013c4696b3b1a485a475cfb25d',
    );
  });

  // CROSS-ANCHORED clientDefault path (SVQcoR1K). A REGISTERED client-default
  // cell now hashes byte-identically to PHP: `presetDefaultsCellRecord`
  // normalises the leaf DTO to a sparse camelCase record (dropping the
  // undefined-valued keys that `useDefineForClassFields` declares), matching
  // PHP's `leafToRecord`. These exact digests are ALSO pinned in the PHP suite
  // (PresetResolverTest.php) for the SAME logical inputs.
  it('exact hash — clientDefault {quality:75} at Size (cross-anchored with PHP)', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 75 }),
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:2d0bc3473e067653a67d92c0e03ff3666ff498f737b74b9550eb116e91bb2c96',
    );
  });

  it('exact hash — clientDefault {outputFormat:Webp} enum→wire (cross-anchored with PHP)', () => {
    // Guards enum→wire on the REGISTERED-cell path: canonical clientDefault
    // record is {outputFormat:"webp"} (camelCase key, wire enum value). The
    // override anchors only exercise enum parity on the override path.
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { outputFormat: ImageFormat.Webp }),
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:77af8c77695cc88aed893346ccb5e74b6a2c0df8596ce01854cd312578c69878',
    );
  });

  it('exact hash — clientDefault {quality:0} keeps the falsy value in the hashed record (cross-anchored with PHP)', () => {
    // v2.80.0 dropped the boolean `progressive` field that previously guarded
    // the falsy-KEEP symmetry, so this now uses a falsy NUMBER (quality:0):
    // TS `definedFieldsOf` drops only `undefined` (never 0/false), matching
    // PHP's leaf normalisation. A regression where the registered cell is
    // dropped because its only value is falsy would make the hash disappear.
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: presetDefaults().imageCompress(OptimizeFor.Size, { quality: 0 }),
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:65a242e8070dccc9befe4770232de2c9b2f83eb942e1644212dcafc26b03e8bb',
    );
  });
});

// ---------------------------------------------------------------------------
// presetVersion + back-compat constants
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — invariants', () => {
  it('presetVersion tracks the GENERATED sdk_spec PRESET_VERSION (no hand-typed literal — yREs0srv)', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    // Pin to the generated source of truth, NOT a literal, so a regen that bumps
    // the preset matrix can never leave the resolver emitting a stale version.
    expect(resolvedOptions.presetVersion).toBe(GENERATED_PRESET_VERSION);
    expect(PRESET_VERSION).toBe(GENERATED_PRESET_VERSION);
  });

  it('overrides[] back-compat mirrors sources.explicit verbatim', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 80, metadata: ImageMetadataPolicy.All },
    });
    // Mirror exact contents.
    expect([...resolvedOptions.overrides].sort()).toEqual([...resolvedOptions.sources.explicit].sort());
  });

  it('applied is a copy of the merged wire payload (not a reference)', () => {
    const out = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(out.resolvedOptions.applied).toEqual(out.wireOptions);
    expect(out.resolvedOptions.applied).not.toBe(out.wireOptions);
  });
});

// ---------------------------------------------------------------------------
// GislConfigError backward-compat
// ---------------------------------------------------------------------------

describe('GislConfigError back-compat', () => {
  it('new GislConfigError(message) still works (no metadata)', () => {
    const e = new GislConfigError('just a message');
    expect(e.message).toBe('just a message');
    expect(e.name).toBe('GislConfigError');
    expect(e.reason).toBeUndefined();
    expect(e.conflictingFields).toBeUndefined();
    expect(e.resolvedSnapshot).toBeUndefined();
    expect(e.suggestion).toBeUndefined();
  });

  it('new GislConfigError(message, metadata) populates the optional fields', () => {
    const snapshot = { codec: 'h265', target_size_bytes: 1024 };
    const e = new GislConfigError('bad combo', {
      reason: 'invalid_combination',
      conflictingFields: ['targetSize', 'codec'],
      resolvedSnapshot: snapshot,
      suggestion: 'Use codec H264.',
    });
    expect(e.reason).toBe('invalid_combination');
    expect(e.conflictingFields).toEqual(['targetSize', 'codec']);
    expect(e.resolvedSnapshot).toEqual(snapshot);
    expect(e.suggestion).toBe('Use codec H264.');
  });

  it('GislConfigError partial metadata only populates the fields provided', () => {
    const e = new GislConfigError('bad combo', { reason: 'invalid_combination' });
    expect(e.reason).toBe('invalid_combination');
    expect(e.conflictingFields).toBeUndefined();
    expect(e.resolvedSnapshot).toBeUndefined();
    expect(e.suggestion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PresetDefaults type-check (architect adjustment e1 — verify Proxy inheritance)
// ---------------------------------------------------------------------------

describe('PresetDefaults builder integration (T4a x T4b)', () => {
  it('builder produces a PresetDefaults whose cellFor returns the registered delta', () => {
    const d = presetDefaults()
      .imageCompress(OptimizeFor.Size, { quality: 75, outputFormat: ImageFormat.Webp })
      .audioCompress(OptimizeFor.Balanced, { bitrate: AudioBitrate._192 });
    expect(d).toBeInstanceOf(PresetDefaults);
    const cell = d.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell).toBeInstanceOf(ImageCompressPresetOptions);
    expect(cell?.quality).toBe(75);
    expect(cell?.outputFormat).toBe(ImageFormat.Webp);
  });

  it('shippedDefaultsFor wires up the same wire values the resolver consumes', () => {
    const shipped = VideoCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(shipped.crf).toBe(23);
    expect(shipped.preset).toBe('medium');
    // v2.66.0: codec no longer baked into the preset (server container-resolves).
    expect(shipped.codec).toBeUndefined();
  });

  it('AudioCompressPresetOptions.shippedDefaultsFor Size translates _96 → 96', () => {
    const shipped = AudioCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Size);
    expect(shipped.bitrate).toBe(96);
    expect(shipped.sampleRate).toBe(44100);
  });
});

// ---------------------------------------------------------------------------
// Code-review (cross-model R1) regression guards
// ---------------------------------------------------------------------------

describe('code-review R1 regression: targetSize supersession does not leave stale crf in source buckets', () => {
  it('client-default crf is stripped from BOTH applied AND sources when explicit targetSize supersedes', () => {
    const defaults = presetDefaults().videoCompress(OptimizeFor.Quality, { crf: 22 });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Quality,
      presetDefaults: defaults,
      explicitOptions: { codec: VideoCodec.H264, targetSize: '50MB' },
    });
    // crf stripped from wire payload
    expect('crf' in wireOptions).toBe(false);
    // and from applied
    expect('crf' in resolvedOptions.applied).toBe(false);
    // and from EVERY source bucket — no phantom entry anywhere
    for (const bucketKey of ['sdkDefault', 'clientDefault', 'scopedDefault', 'callPresetOverride', 'explicit'] as const) {
      expect(resolvedOptions.sources[bucketKey]).not.toContain('crf');
    }
    // The derived wire fields land on the explicit bucket (caller's targetSize won).
    expect(resolvedOptions.sources.explicit).toContain('target_size_bytes');
    expect(resolvedOptions.sources.explicit).toContain('encoding_mode');
  });

  it('sdk-default crf (video Size cell ships crf:30) is stripped when explicit targetSize supersedes', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { codec: VideoCodec.H264, targetSize: '100MB' },
    });
    expect('crf' in wireOptions).toBe(false);
    expect(resolvedOptions.sources.sdkDefault).not.toContain('crf');
  });
});

describe('code-review R1 regression: presetConfigHash is canonical across nested key-insertion order', () => {
  it('two presetOverrides with the same logical content but different key order produce the SAME hash', () => {
    const a = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { quality: 75, metadata: 'all' } as Readonly<Record<string, unknown>>,
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const b = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { metadata: 'all', quality: 75 } as Readonly<Record<string, unknown>>,
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('code-review R1 regression: type_mismatch suggestion uses correct PascalCase class name', () => {
  it('document_pdf suggestion names DocumentPdfCompressPresetOptionsInput (not Documentpdf…)', () => {
    try {
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        // PDF-flavoured fields on an image op — triggers type_mismatch
        // (profile + grayscale both belong to document_pdf).
        presetOverrides: { profile: 'screen', grayscale: true },
        explicitOptions: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('type_mismatch');
      expect(e.suggestion).toContain('DocumentPdfCompressPresetOptionsInput');
      // Negative — the buggy lowercase form must NOT appear.
      expect(e.suggestion).not.toContain('Documentpdf');
    }
  });

  it('audio (single-segment) suggestion still names AudioCompressPresetOptionsInput', () => {
    try {
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        presetOverrides: { bitrate: 96, sampleRate: 44100, normalize: true },
        explicitOptions: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('type_mismatch');
      expect(e.suggestion).toContain('AudioCompressPresetOptionsInput');
    }
  });

  it('image Size sample assertion (chained Image fields end up in wire snake_case)', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { metadata: ImageMetadataPolicy.All, outputFormat: ImageFormat.Webp },
    });
    expect(wireOptions.metadata).toBe('all');
    expect(wireOptions.output_format).toBe('webp');
  });
});

// ---------------------------------------------------------------------------
// 0Vcogefw — audio_compress lossless bitrate drop
// ---------------------------------------------------------------------------
//
// The shipped audio preset bakes a bitrate (Size 96 / Balanced 192 /
// Quality 320). The worker rejects `bitrate` on lossless outputs
// (flac/wav — contracts iakhSy3E). The resolver drops ONLY the
// sdkDefault-sourced bitrate when `audioLossless === true`; sample_rate
// and normalize from the same cell MUST survive. Any user-supplied
// bitrate (clientDefault / scoped / override / explicit) is KEPT so the
// worker's 422 surfaces — no silent-ignore.

describe('resolveCompressOptions — audio lossless bitrate drop (0Vcogefw)', () => {
  it.each([
    [OptimizeFor.Size, 96, 44100],
    [OptimizeFor.Balanced, 192, 44100],
    [OptimizeFor.Quality, 320, 48000],
  ])(
    'lossy audio %s KEEPS the shipped bitrate %d (sample_rate / normalize survive)',
    (optimize, expectedBitrate, expectedSampleRate) => {
      const { wireOptions, resolvedOptions } = resolveCompressOptions({
        media: 'audio',
        op: 'compress',
        optimize,
        explicitOptions: {},
        audioLossless: false,
      });
      expect(wireOptions.bitrate).toBe(expectedBitrate);
      expect(wireOptions.sample_rate).toBe(expectedSampleRate);
      expect('normalize' in wireOptions).toBe(true);
      expect(resolvedOptions.sources.sdkDefault).toContain('bitrate');
    },
  );

  it.each([
    [OptimizeFor.Size, 44100],
    [OptimizeFor.Balanced, 44100],
    [OptimizeFor.Quality, 48000],
  ])(
    'lossless audio %s DROPS the shipped bitrate but keeps the level-correct sample_rate + normalize',
    (optimize, expectedSampleRate) => {
      const { wireOptions, resolvedOptions } = resolveCompressOptions({
        media: 'audio',
        op: 'compress',
        optimize,
        explicitOptions: {},
        audioLossless: true,
      });
      expect('bitrate' in wireOptions).toBe(false);
      // The rest of the preset cell survives the drop — value-checked per
      // level so a Quality-only sample_rate corruption (48000→44100) fails.
      expect(wireOptions.sample_rate).toBe(expectedSampleRate);
      expect('normalize' in wireOptions).toBe(true);
      // The audit trail no longer attributes a bitrate to any layer.
      expect(resolvedOptions.sources.sdkDefault).not.toContain('bitrate');
      expect(resolvedOptions.applied).not.toHaveProperty('bitrate');
    },
  );

  it('lossless audio with optimize UNSET does not crash (no sdkDefault bitrate to drop)', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'audio',
      op: 'compress',
      explicitOptions: {},
      audioLossless: true,
    });
    expect(wireOptions).toEqual({});
    expect('bitrate' in wireOptions).toBe(false);
  });

  // --- worker-authoritative: USER-supplied bitrate is NEVER dropped -------

  it('lossless audio KEEPS an EXPLICIT bitrate (winning source != sdkDefault → 422 surfaces)', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'audio',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { bitrate: AudioBitrate._320 },
      audioLossless: true,
    });
    expect(wireOptions.bitrate).toBe(320);
    expect(resolvedOptions.sources.explicit).toContain('bitrate');
  });

  it('lossless audio KEEPS a presetOverrides bitrate', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'audio',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { bitrate: AudioBitrate._192 },
      explicitOptions: {},
      audioLossless: true,
    });
    expect(wireOptions.bitrate).toBe(192);
    expect(resolvedOptions.sources.callPresetOverride).toContain('bitrate');
  });

  it('lossless audio KEEPS a clientDefault preset bitrate', () => {
    const defaults = presetDefaults().audioCompress(OptimizeFor.Size, { bitrate: AudioBitrate._320 });
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'audio',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
      explicitOptions: {},
      audioLossless: true,
    });
    expect(wireOptions.bitrate).toBe(320);
    expect(resolvedOptions.sources.clientDefault).toContain('bitrate');
  });

  it('audioLossless flag is inert for non-audio media (defensive)', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
      audioLossless: true,
    });
    // Image has no bitrate concept; the flag changes nothing.
    expect(wireOptions.quality).toBe(65);
    expect('bitrate' in wireOptions).toBe(false);
  });
});
