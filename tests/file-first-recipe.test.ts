import { describe, it, expect } from 'vitest';
import { Recipe, fileInput, type FileInput } from '../src/file-first.js';
import { create } from '../src/gisl.js';
import { resolveCompressOptions } from '../src/ergonomic/preset_resolver.js';
import { presetDefaults } from '../src/ergonomic/presets/index.js';
import { OptimizeFor } from '../src/generated/sdk_spec/enums.js';
import { GislConfigError } from '../src/errors.js';
import type { OperationDef, WorkflowCreatePayload } from '../src/types.js';

/**
 * FF2a — the file-first {@link Recipe} builder: immutability (clone-on-write),
 * single-input op mapping, sequential-chain lowering to ONE job, and compress
 * preset delegation. Network-free: only the pure `toWorkflowPayload()` lowering
 * seam is exercised (no `run()` until FF2b). Mirrors the PHP `RecipeTest`.
 */

const FILE_ID = 'file_0001';

const recipe = (path: string): Recipe => new Recipe(fileInput.path(path));

const loweredJob = (r: Recipe): WorkflowCreatePayload['jobs'][number] => {
  const wire = r.toWorkflowPayload(FILE_ID);
  expect(wire.jobs).toHaveLength(1);
  return wire.jobs[0];
};

const operations = (r: Recipe): OperationDef[] => loweredJob(r).operations;

describe('Recipe — immutability (clone-on-write)', () => {
  it('chaining an op does not mutate the original recipe', () => {
    const base = recipe('photo.jpg');
    const compressed = base.compress(OptimizeFor.Balanced);

    expect(base.stepCount).toBe(0);
    expect(compressed.stepCount).toBe(1);
    expect(compressed).not.toBe(base);
  });

  it('two branches off one base are independent', () => {
    const base = recipe('clip.mov');
    const branchA = base.convert('mp4').compress(OptimizeFor.Size);
    const branchB = base.thumbnail({ width: 320, height: 240 });

    expect(base.stepCount).toBe(0);
    expect(branchA.stepCount).toBe(2);
    expect(branchB.stepCount).toBe(1);

    expect(operations(branchA).map((o) => o.type)).toEqual(['convert', 'compress']);
    expect(operations(branchB).map((o) => o.type)).toEqual(['thumbnail']);

    // Re-lower the base AFTER both branches are built — operations[] must
    // still be empty (catches a shared-array mutation stepCount would miss).
    expect(operations(base)).toEqual([]);
  });
});

describe('Recipe — client.file() entry point', () => {
  it('returns a recipe carrying the key', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    const r = client.file('photo.jpg', 'hero');

    expect(r).toBeInstanceOf(Recipe);
    expect(r.key()).toBe('hero');
    expect(r.stepCount).toBe(0);
  });

  it('accepts a pre-uploaded FileInput', async () => {
    const client = await create({ apiKey: 'sk_test', baseUrl: 'https://api.test' });
    const r = client.file(fileInput.uploadId('uploaded-123')).convert('webp');

    expect(loweredJob(r).source).toEqual({ type: 'upload', file_id: FILE_ID });
  });
});

describe('Recipe — single-op lowering', () => {
  it('convert lowers to an output_format option', () => {
    expect(operations(recipe('clip.mov').convert('mp4'))).toEqual([
      { type: 'convert', options: { output_format: 'mp4' } },
    ]);
  });

  it('textWatermark lowers to the text_watermark op', () => {
    expect(operations(recipe('photo.jpg').textWatermark('PROOF'))).toEqual([
      { type: 'text_watermark', options: { text: 'PROOF' } },
    ]);
  });

  it('thumbnail carries both dimensions', () => {
    expect(operations(recipe('photo.jpg').thumbnail({ width: 320, height: 240 }))).toEqual([
      { type: 'thumbnail', options: { width: 320, height: 240 } },
    ]);
  });

  it('thumbnail rejects a missing height', () => {
    // The contract marks BOTH width and height required for image/video/document.
    // A JS caller omitting one (the typed interface forbids it) is rejected
    // eagerly at the verb call (assertThumbnailDimensions), before any upload.
    expect(() => recipe('photo.jpg').thumbnail({ width: 320 } as never)).toThrow(GislConfigError);
    try {
      recipe('photo.jpg').thumbnail({ width: 320 } as never);
      expect.unreachable('thumbnail without a height must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('missing_required_field');
      expect((err as GislConfigError).conflictingFields).toContain('height');
    }
  });

  it('thumbnail rejects a missing width', () => {
    expect(() => recipe('photo.jpg').thumbnail({ height: 240 } as never)).toThrow(GislConfigError);
    try {
      recipe('photo.jpg').thumbnail({ height: 240 } as never);
      expect.unreachable('thumbnail without a width must throw');
    } catch (err) {
      expect((err as GislConfigError).reason).toBe('missing_required_field');
      expect((err as GislConfigError).conflictingFields).toContain('width');
    }
  });

  it('an op with empty options omits the options key', () => {
    // A compress on an extensionless path has no inferable media, so preset
    // resolution yields empty options — which must omit the `options` key
    // (matching the PHP `null` → absent behaviour for byte parity).
    const ops = operations(recipe('photo').compress());
    expect(ops).toEqual([{ type: 'compress' }]);
    expect(ops[0]).not.toHaveProperty('options');
  });
});

describe('Recipe — job shape', () => {
  it('emits one job with an upload source and no id, source before operations', () => {
    const job = loweredJob(recipe('photo.jpg').convert('webp'));

    expect(job.source).toEqual({ type: 'upload', file_id: FILE_ID });
    expect(job).not.toHaveProperty('id');
    // Wire key order (source, operations) matters for JSON-string parity.
    expect(Object.keys(job)).toEqual(['source', 'operations']);
  });

  it('a chain preserves operation order in one job', () => {
    const ops = operations(recipe('clip.mov').convert('mp4').thumbnail({ width: 100, height: 100 }));
    expect(ops.map((o) => o.type)).toEqual(['convert', 'thumbnail']);
  });
});

describe('Recipe — compress preset delegation', () => {
  it('delegates to the shared preset resolver', () => {
    // The Recipe must lower compress to EXACTLY what the operation-first
    // resolver produces for the same media + optimize.
    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Balanced,
    }).wireOptions;

    const ops = operations(recipe('photo.jpg').compress(OptimizeFor.Balanced));
    expect(ops[0].type).toBe('compress');
    expect(ops[0].options).toEqual(expected);
    expect(Object.keys(ops[0].options ?? {}).length).toBeGreaterThan(0);
  });

  it('uses client preset defaults via file()', async () => {
    // client.file() must forward the client's preset defaults into the Recipe
    // so a file-first compress resolves with them — the bare-constructor tests
    // never exercise that arm.
    const defaults = presetDefaults().imageCompress(OptimizeFor.Size, { quality: 50 });
    const client = await create({
      apiKey: 'sk_test',
      baseUrl: 'https://api.test',
      presetDefaults: defaults,
    });

    const expected = resolveCompressOptions({
      media: 'image',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Size,
      presetDefaults: defaults,
    }).wireOptions;

    const ops = operations(client.file('photo.jpg').compress(OptimizeFor.Size));
    expect(ops[0].type).toBe('compress');
    expect(ops[0].options).toEqual(expected);
    expect((ops[0].options as Record<string, unknown>).quality).toBe(50);
  });

  it('rejects an unknown optimize value', () => {
    // JS callers can bypass the type; mirror the PHP runtime validation.
    expect(() => recipe('photo.jpg').compress('Smallest' as OptimizeFor)).toThrow(GislConfigError);
  });

  it('fails fast when optimize is set but media is unknown', () => {
    // 'photo' has no extension → media cannot be inferred. An explicit
    // optimize must NOT be silently dropped — lowering throws.
    expect(() => recipe('photo').compress(OptimizeFor.Size).toWorkflowPayload(FILE_ID)).toThrow(
      GislConfigError,
    );
  });

  it('0Vcogefw — file-first compress on a *.flac input lowers WITHOUT bitrate', () => {
    // Proves the file-first call-site is wired (a regression here = only the
    // operation-first site got the audio-lossless drop). The Recipe must
    // resolve audioLossless from the *.flac path and drop the sdkDefault
    // bitrate while keeping sample_rate / normalize.
    const ops = operations(recipe('track.flac').compress(OptimizeFor.Size));
    expect(ops[0].type).toBe('compress');
    const options = ops[0].options as Record<string, unknown>;
    expect('bitrate' in options).toBe(false);
    expect(options.sample_rate).toBe(44100);
    expect(options.normalize).toBe(true);
  });

  it('0Vcogefw — file-first compress on a *.mp3 input KEEPS bitrate (lossy)', () => {
    const ops = operations(recipe('song.mp3').compress(OptimizeFor.Size));
    const options = ops[0].options as Record<string, unknown>;
    expect(options.bitrate).toBe(96);
    expect(options.sample_rate).toBe(44100);
  });

  it('example 02 chain lowers convert then resolved compress', () => {
    // examples/php/02-chain.php: clip.mov → convert(mp4) → compress(Size).
    const expectedCompress = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      explicitOptions: {},
      optimize: OptimizeFor.Size,
    }).wireOptions;

    const ops = operations(recipe('clip.mov').convert('mp4').compress(OptimizeFor.Size));

    expect(ops.map((o) => o.type)).toEqual(['convert', 'compress']);
    expect(ops[0].options).toEqual({ output_format: 'mp4' });
    expect(ops[1].options).toEqual(expectedCompress);
  });
});

describe('Recipe — cross-language byte parity', () => {
  it('serialises a chain to a stable JSON shape', () => {
    const json = JSON.stringify(recipe('clip.mov').convert('mp4').toWorkflowPayload(FILE_ID));
    expect(json).toBe(
      `{"jobs":[{"source":{"type":"upload","file_id":"${FILE_ID}"},"operations":[{"type":"convert","options":{"output_format":"mp4"}}]}]}`,
    );
  });
});

// Type-level: FileInput is a defined discriminated union (compile-time check).
const _typeArms: FileInput[] = [
  fileInput.path('a.jpg'),
  fileInput.uploadId('id'),
];
void _typeArms;
