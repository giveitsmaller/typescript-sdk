import { describe, expect, it } from 'vitest';

import { create } from '../../src/gisl.js';
import { FilesRecipe, Recipe, fileInput } from '../../src/file-first.js';
import {
  KNOWN_WIRE_FIELDS,
  WIRE_ALIASES,
  resolveCompressOptions,
} from '../../src/ergonomic/preset_resolver.js';
import { COMPRESS_OPTION_KEYS, type CompressOptions } from '../../src/ergonomic/option_types.js';
import {
  ImageCompressPresetOptions,
  VideoCompressPresetOptions,
  type PresetMedia,
} from '../../src/ergonomic/presets/index.js';
import { AudioSampleRate, OptimizeFor, VideoCodec } from '../../src/generated/sdk_spec/enums.js';
import { GislConfigError } from '../../src/errors.js';

/**
 * YdxagJOI — `compress()` (operation-first and the four file-first verbs) and
 * operation-first `transform()` take TYPED option bags. Two halves:
 *
 * 1. The `CompressOptions` key set is pinned to the preset resolver's own tables
 *    (`KNOWN_WIRE_FIELDS` + `WIRE_ALIASES` + the derived `targetSize`), in both
 *    directions, and to the resolver's BEHAVIOUR: every declared key is accepted for
 *    some media, a misspelled one is refused for every media. The type can therefore
 *    neither narrow what the resolver accepts nor promise a key it refuses.
 * 2. Compile-time guards: `@ts-expect-error` on a misspelled key for every typed
 *    surface. vitest strips types, so these assert nothing at runtime — they are
 *    enforced by `npm run check:tests` (`tsc -p tsconfig.test.json`), which CI and
 *    `make project/test` run. An unused directive is itself a compile error, so if a
 *    surface reverts to `Record<string, unknown>` the build goes red here.
 */

const MEDIA = Object.keys(KNOWN_WIRE_FIELDS) as PresetMedia[];
const SDK_ONLY_KEYS = ['optimize', 'presetOverrides'] as const;

function resolveExplicit(media: PresetMedia, key: string, value: unknown): GislConfigError | undefined {
  try {
    resolveCompressOptions({ media, op: 'compress', explicitOptions: { [key]: value } });
    return undefined;
  } catch (err) {
    if (err instanceof GislConfigError) return err;
    throw err;
  }
}

describe('CompressOptions key set == what the compress preset resolver accepts (YdxagJOI)', () => {
  it('the tuple equals SDK-only keys + every media wire key + their camelCase aliases + targetSize', () => {
    const wireKeys = new Set(MEDIA.flatMap((m) => [...KNOWN_WIRE_FIELDS[m]]));
    // An alias whose target no media accepts would let the type promise a refused key.
    for (const [camel, wire] of Object.entries(WIRE_ALIASES)) {
      expect(wireKeys.has(wire), `alias ${camel} -> ${wire} targets no media's wire field`).toBe(true);
    }
    const expected = new Set<string>([
      ...SDK_ONLY_KEYS,
      ...wireKeys,
      ...Object.keys(WIRE_ALIASES),
      'targetSize',
    ]);
    expect([...COMPRESS_OPTION_KEYS].sort()).toEqual([...expected].sort());
    expect(new Set(COMPRESS_OPTION_KEYS).size).toBe(COMPRESS_OPTION_KEYS.length);
  });

  it.each(COMPRESS_OPTION_KEYS.filter((k) => !(SDK_ONLY_KEYS as readonly string[]).includes(k)))(
    'explicit key %s is accepted (not unknown_field) for at least one media',
    (key) => {
      const value = key === 'targetSize' ? '50MB' : 1;
      const acceptedBy = MEDIA.filter((m) => resolveExplicit(m, key, value)?.reason !== 'unknown_field');
      expect(acceptedBy.length, `no media accepts '${key}'`).toBeGreaterThan(0);
    },
  );

  it.each(MEDIA)('a misspelled key is refused as unknown_field for %s', (media) => {
    expect(resolveExplicit(media, 'qualty', 80)?.reason).toBe('unknown_field');
  });
});

describe('compress()/transform() option bags are typed — compile-time guards (YdxagJOI)', () => {
  it('rejects a misspelled key on every typed surface, accepts the real ones', async () => {
    const c = await create({ apiKey: 'k', baseUrl: 'https://api.example.com' });
    const recipe = new Recipe(fileInput.path('photo.jpg'));
    const files = new FilesRecipe([fileInput.path('a.mp4'), fileInput.path('b.mp4')]);
    const merged = files.merge();
    const watermarked = recipe.watermark(new Recipe(fileInput.path('logo.png')));

    // Never invoked: only the compile-time contract is under test here.
    const negatives = [
      // @ts-expect-error — `qualty` is not a CompressOptions key (operation-first compress).
      (): unknown => c.compress('photo.jpg', { qualty: 80 }),
      // @ts-expect-error — `rotation` is not a TransformOptions key (operation-first transform).
      (): unknown => c.transform('photo.jpg', { rotation: 90 }),
      // @ts-expect-error — misspelled key on Recipe.compress.
      (): unknown => recipe.compress(OptimizeFor.Size, { qualty: 80 }),
      // @ts-expect-error — misspelled key on FilesRecipe.compress.
      (): unknown => files.compress(undefined, { crff: 23 }),
      // @ts-expect-error — misspelled key on MergedRecipe.compress.
      (): unknown => merged.compress(OptimizeFor.Balanced, { crff: 23 }),
      // @ts-expect-error — misspelled key on WatermarkedRecipe.compress.
      (): unknown => watermarked.compress(undefined, { qualty: 80 }),
      // @ts-expect-error — the value is typed too: `h263` is not a VideoCodec.
      (): unknown => c.compress('clip.mp4', { codec: 'h263' }),
      // @ts-expect-error — `optimize` takes an OptimizeFor, not an arbitrary string.
      (): unknown => c.compress('photo.jpg', { optimize: 'Smallest' }),
      // @ts-expect-error — presetOverrides takes the camelCase preset shape, not a wire key.
      (): unknown => c.compress('photo.jpg', { presetOverrides: { qualty: 40 } }),
      // @ts-expect-error — rotate is 0/90/180/270 only.
      (): unknown => c.transform('photo.jpg', { rotate: 45 }),
    ];

    // Positive controls — these MUST compile (a regression would be a plain tsc error).
    const positives = [
      (): unknown => c.compress('photo.jpg'),
      (): unknown => c.compress('photo.jpg', { quality: 80 }),
      (): unknown => c.compress('photo.jpg', { optimize: OptimizeFor.Size, presetOverrides: { quality: 40 } }),
      (): unknown =>
        c.compress('photo.jpg', { presetOverrides: ImageCompressPresetOptions.from({ quality: 40 }) }),
      (): unknown => c.compress('clip.mp4', { codec: 'h264', targetSize: '50MB', trim_start: 5 }),
      (): unknown => c.compress('clip.mp4', { codec: VideoCodec.H265, crf: 28, audioCodec: 'aac' }),
      (): unknown =>
        c.compress('clip.mp4', { presetOverrides: VideoCompressPresetOptions.from({ crf: 30 }) }),
      (): unknown => c.compress('song.wav', { sample_rate: AudioSampleRate._44100, normalize: true }),
      (): unknown => c.compress('song.wav', { sampleRate: 48000, bitrate: 192 }),
      (): unknown => c.compress('deck.pptx', { quality: 70, stripMacros: true }),
      (): unknown => c.transform('photo.jpg', { rotate: 90, flip: 'horizontal' }),
      (): unknown => c.transform('photo.jpg'),
      (): unknown => recipe.compress(OptimizeFor.Balanced, { quality: 55 }),
      (): unknown => files.compress(undefined, { crf: 23 }),
      (): unknown => merged.compress(OptimizeFor.Size, { targetSize: 8 * 1024 * 1024 }),
      (): unknown => watermarked.compress(undefined, { quality: 70 }),
    ];

    // An ALIASED bag is not excess-property checked — the documented limit, and why
    // the resolver's runtime unknown_field check stays as the backstop.
    const aliased = { quality: 80, qualty: 80 };
    const aliasedCompiles = (): unknown => c.compress('photo.jpg', aliased);
    const typed: CompressOptions = { quality: 80 };

    expect([...negatives, ...positives, aliasedCompiles].every((f) => typeof f === 'function')).toBe(true);
    expect(typed.quality).toBe(80);
  });
});
