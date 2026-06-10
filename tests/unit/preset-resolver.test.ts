import { describe, expect, it } from 'vitest';

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
  ImageMode,
  ImageMetadataPolicy,
  IccProfilePolicy,
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
    expect(wireOptions.mode).toBe('lossy');
    expect(wireOptions.quality).toBe(65);
    expect(wireOptions.metadata).toBe('all');
    expect(wireOptions.icc_profile).toBe('strip');
    expect(wireOptions.progressive).toBe(true);
    expect(wireOptions.output_format).toBe('smallest');
    expect(resolvedOptions.preset).toBe(OptimizeFor.Size);
    expect(resolvedOptions.sources.sdkDefault).toContain('mode');
    expect(resolvedOptions.sources.sdkDefault).toContain('icc_profile');
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

  it('video Size shipped defaults — H265 CRF 30 Slow preset, audio_codec/audio_bitrate snake-cased', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(wireOptions.codec).toBe('h265');
    expect(wireOptions.crf).toBe(30);
    expect(wireOptions.preset).toBe('slow');
    expect(wireOptions.audio_codec).toBe('aac');
    expect(wireOptions.audio_bitrate).toBe(96);
    // crf with no targetSize implies encoding_mode='crf' (resolver derives).
    expect(wireOptions.encoding_mode).toBe('crf');
    expect(resolvedOptions.sources.sdkDefault).toContain('encoding_mode');
  });

  it('image Quality cell — mode=lossless and quality undefined (no quality key on wire)', () => {
    const { wireOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Quality,
      explicitOptions: {},
    });
    expect(wireOptions.mode).toBe('lossless');
    expect('quality' in wireOptions).toBe(false);
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
    expect(wireOptions.mode).toBe('lossy'); // mode untouched by client, falls back to sdkDefault
    expect(resolvedOptions.sources.clientDefault).toEqual(['quality']);
    expect(resolvedOptions.sources.sdkDefault).toContain('mode');
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
      presetOverrides: { progressive: false },
      explicitOptions: { progressive: false },
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
      explicitOptions: { progressive: false, iccProfile: IccProfilePolicy.Preserve },
    });
    expect(wireOptions.progressive).toBe(false);
    expect(wireOptions.icc_profile).toBe('preserve');
    expect([...resolvedOptions.sources.explicit].sort()).toEqual(['icc_profile', 'progressive']);
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

  it('lossless + quality (post-merge) → reason=missing_dependency, conflictingFields=[quality, mode]', () => {
    try {
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        explicitOptions: { mode: ImageMode.Lossless, quality: 90 },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GislConfigError;
      expect(e.reason).toBe('missing_dependency');
      expect(e.conflictingFields).toEqual(['quality', 'mode']);
      expect(e.resolvedSnapshot?.mode).toBe('lossless');
    }
  });

  it('lossless from client default + quality from explicit → still rejects (post-merge)', () => {
    const defaults = presetDefaults().imageCompress(OptimizeFor.Quality);
    expect(() =>
      resolveCompressOptions({
        media: 'image',
        op: 'compress',
        optimize: OptimizeFor.Quality,
        presetDefaults: defaults,
        explicitOptions: { quality: 90 },
      }),
    ).toThrow(/quality.*Lossless|missing_dependency/);
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

  it('exact hash — override {quality:70, progressive:true} sorts keys', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      presetOverrides: { quality: 70, progressive: true },
      explicitOptions: {},
    });
    expect(resolvedOptions.presetConfigHash).toBe(
      'sha256:26aa8ab195e269b4dde191a94f5018e50fc84493251074c2974f90e88b93e40b',
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

  // NOTE: the clientDefault-layer hash is deliberately NOT cross-anchored.
  // PHP and TS reconstruct a REGISTERED client-default cell into different
  // record shapes (PHP a sparse {quality:75}; TS carries extra structure), so
  // the same logical client config hashes differently across the two SDKs.
  // The override-path anchors above prove the canonicalJson serialiser itself
  // is byte-identical; the clientDefault representational divergence is tracked
  // as a follow-up (cross-SDK presetConfigHash for client defaults). The PHP
  // suite keeps a within-PHP determinism pin for the clientDefault path.
});

// ---------------------------------------------------------------------------
// presetVersion + back-compat constants
// ---------------------------------------------------------------------------

describe('resolveCompressOptions — invariants', () => {
  it("presetVersion === '1.0' (matches PRESET_VERSION export)", () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(resolvedOptions.presetVersion).toBe('1.0');
    expect(PRESET_VERSION).toBe('1.0');
  });

  it('overrides[] back-compat mirrors sources.explicit verbatim', () => {
    const { resolvedOptions } = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: { quality: 80, progressive: false },
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
      .imageCompress(OptimizeFor.Size, { quality: 75, progressive: true })
      .audioCompress(OptimizeFor.Balanced, { bitrate: AudioBitrate._192 });
    expect(d).toBeInstanceOf(PresetDefaults);
    const cell = d.cellFor('image', 'compress', OptimizeFor.Size);
    expect(cell).toBeInstanceOf(ImageCompressPresetOptions);
    expect(cell?.quality).toBe(75);
    expect(cell?.progressive).toBe(true);
  });

  it('shippedDefaultsFor wires up the same wire values the resolver consumes', () => {
    const shipped = VideoCompressPresetOptions.shippedDefaultsFor(OptimizeFor.Balanced);
    expect(shipped.codec).toBe('h264');
    expect(shipped.crf).toBe(23);
    expect(shipped.preset).toBe('medium');
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
      presetOverrides: { quality: 75, progressive: true } as Readonly<Record<string, unknown>>,
      explicitOptions: {},
    }).resolvedOptions.presetConfigHash;
    const b = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      optimize: OptimizeFor.Size,
      presetOverrides: { progressive: true, quality: 75 } as Readonly<Record<string, unknown>>,
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
        // (profile + colorspace + flattenForms all belong to document_pdf).
        presetOverrides: { profile: 'web', colorspace: 'rgb', flattenForms: false },
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
      explicitOptions: { metadata: ImageMetadataPolicy.None, outputFormat: ImageFormat.Jpeg },
    });
    expect(wireOptions.metadata).toBe('none');
    expect(wireOptions.output_format).toBe('jpeg');
  });
});
