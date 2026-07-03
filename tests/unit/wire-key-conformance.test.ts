import { describe, it, expect } from 'vitest';
import {
  archiveMetadata,
  convertMetadata,
  imageWatermarkMetadata,
  mergeMetadata,
  textWatermarkMetadata,
  thumbnailMetadata,
  videoWatermarkMetadata,
  type OperationMetadata,
} from '@giveitsmaller/contracts/operations';

import { allowedKeysFor, type ValidatedVerb } from '../../src/ergonomic/option_validation.js';
import { VERB_OPTION_KEYS } from '../../src/ergonomic/option_types.js';
import { Recipe, MergedRecipe, ArchivedRecipe, fileInput, type FileInput } from '../../src/file-first.js';
import type { MergeOptions } from '../../src/merge.js';
import type { OperationDef, WorkflowCreatePayload } from '../../src/types.js';

/**
 * Wire-key conformance guard (card y2qOUp90).
 *
 * The convert `format`→`output_format` bug (FE-caught 2026-06-14, fixed in
 * PR #204/#205) slipped through because the ergonomic builders' lowered wire
 * keys were never systematically validated against the contract operation
 * schemas — only compress went through a contract-checked resolver.
 *
 * This suite turns "we hope the keys match" into a CI gate: for every
 * ergonomic op it collects the wire option keys the SDK can emit and asserts
 * each one is a real contract option key, read from the generated, in-repo
 * `OperationMetadata` sidecars (regenerated from the contract; their `options`
 * keys are the verbatim contract wire keys). A reintroduced `format` on
 * convert — or any future rename/typo — fails here at PR time.
 *
 * NOTE: `compress` conformance moved OUT of this suite (card 0fNO60BX) — it is now
 * owned by `code-builder-conformance.test.ts`, driven from the contract-authored
 * `code-builder-metadata.json` `sdk_exposure` gate (a single, stronger ledger). This
 * suite covers convert/thumbnail/text_watermark/merge/archive + the eager validator.
 *
 * Mirrored by the PHP `WireKeyConformanceTest`.
 */

/**
 * OPERATION-LEVEL contract option keys (the keys valid in `OperationDef.options`):
 * the union of every mime group's `options` plus `direct_options` for
 * media-agnostic ops (archive has no mime_groups — its keys live only in
 * `direct_options`). Deliberately EXCLUDES `per_input_options`: those are valid
 * only on a merge input's `per_input_options`, never at operation level, so
 * folding them in would let a misplaced per-input key (e.g. `trim_start`) pass.
 */
function operationOptionKeys(metadata: OperationMetadata): Set<string> {
  const keys = new Set<string>();
  for (const group of Object.values(metadata.mime_groups)) {
    for (const k of Object.keys(group.options)) keys.add(k);
  }
  for (const k of Object.keys(metadata.direct_options ?? {})) keys.add(k);
  return keys;
}

/**
 * Operation-level option keys for ONE mime group (media-precise). Used for merge,
 * whose option sets differ per media kind — validating against the specific media
 * group catches a video-only option (or a per-input-only key) emitted for, say,
 * an image merge.
 */
function mediaGroupOptionKeys(metadata: OperationMetadata, kind: string): Set<string> {
  const group = metadata.mime_groups[kind];
  expect(group, `metadata has a '${kind}' mime group`).toBeDefined();
  return new Set(Object.keys(group.options));
}

/** Assert every emitted wire option key belongs to the op's contract surface. */
function assertKeysConform(opType: string, emitted: Iterable<string>, contract: Set<string>): void {
  const stray = [...emitted].filter((k) => !contract.has(k));
  expect(
    stray,
    `${opType}: emitted wire option key(s) ${JSON.stringify(stray)} are not in the contract ` +
      `option set ${JSON.stringify([...contract].sort())}`,
  ).toEqual([]);
}

const FILE_ID = 'file_0001';

/** Lower a single-input Recipe and return its one job's operations. */
function recipeOps(r: Recipe): OperationDef[] {
  const wire: WorkflowCreatePayload = r.toWorkflowPayload(FILE_ID);
  return wire.jobs[0].operations;
}

/** The operations[] of the LAST job in a multi-job (merge/archive) payload. */
function lastJobOps(wire: WorkflowCreatePayload): OperationDef[] {
  return wire.jobs[wire.jobs.length - 1].operations;
}

/** Extract the option keys of the op named `type` from a lowered operations[] list. */
function optionKeysOf(ops: OperationDef[], type: string): string[] {
  const op = ops.find((o) => o.type === type);
  expect(op, `expected a '${type}' op in the lowered payload`).toBeDefined();
  return Object.keys((op!.options ?? {}) as Record<string, unknown>);
}

describe('wire-key conformance — convert', () => {
  const contract = operationOptionKeys(convertMetadata);

  it('lowers the format shorthand to the contract key output_format (never format)', () => {
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).convert('webp', { quality: 80, background: '#ffffff' }));
    const keys = optionKeysOf(ops, 'convert');

    expect(keys).toContain('output_format');
    // Regression pin for the 06-14 bug: the ergonomic `format` must never reach the wire.
    expect(keys).not.toContain('format');
    assertKeysConform('convert', keys, contract);
  });

  it('post-merge convert also lowers to output_format', () => {
    const merged = new MergedRecipe([fileInput.path('a.mp4'), fileInput.path('b.mp4')], { mediaKind: 'video' }).convert('webm');
    const ops = lastJobOps(merged.toWorkflowPayload([FILE_ID, 'file_0002']));
    const keys = optionKeysOf(ops, 'convert');
    expect(keys).toContain('output_format');
    expect(keys).not.toContain('format');
    assertKeysConform('convert', keys, contract);
  });
});

describe('wire-key conformance — thumbnail', () => {
  it('emitted keys (passthrough) conform to the thumbnail contract', () => {
    const contract = operationOptionKeys(thumbnailMetadata);
    // thumbnail is an open passthrough — callers supply contract keys directly.
    // Drive every documented contract key to prove none is renamed/dropped.
    const ops = recipeOps(new Recipe(fileInput.path('photo.png')).thumbnail({ width: 320, height: 240, fit: 'crop', format: 'png' }));
    assertKeysConform('thumbnail', optionKeysOf(ops, 'thumbnail'), contract);
  });
});

describe('wire-key conformance — text_watermark', () => {
  it('injected text key + passthrough options conform to the text_watermark contract', () => {
    const contract = operationOptionKeys(textWatermarkMetadata);
    const ops = recipeOps(
      new Recipe(fileInput.path('photo.png')).textWatermark('© Acme', { font_size: 48, anchor: 'bottom_right' }),
    );
    const keys = optionKeysOf(ops, 'text_watermark');
    expect(keys).toContain('text'); // SDK injects the positional text as the literal `text` wire key
    assertKeysConform('text_watermark', keys, contract);
  });
});

describe('wire-key conformance — merge', () => {
  // A fully-populated MergeOptions per media kind so every branch of
  // wireMergeOptions fires. SDK-only fields (mediaKind, allowUnusedAssets) are
  // never serialised, so they must not appear in the emitted keys either.
  const allVideo: MergeOptions = {
    mediaKind: 'video',
    transition: 'crossfade',
    crossfadeDuration: 1.0,
    normalizeAudio: true,
    reEncodeMode: 'always',
    codec: 'h264',
    crf: 23,
    preset: 'medium',
    targetResolution: '1920x1080',
    targetSize: '10MB',
    output: 'video',
  };
  const allAudio: MergeOptions = {
    mediaKind: 'audio',
    transition: 'crossfade',
    crossfadeDuration: 1.0,
    gapDuration: 0.5,
    normalizeAudio: true,
    output: 'audio',
  };
  const allImage: MergeOptions = {
    mediaKind: 'image',
    transition: 'fade',
    transitionDuration: 0.5,
    fps: 30,
    durationPerImage: 3.0,
    delay: 500,
    loopCount: 0,
    videoFormat: 'mp4',
    output: 'video',
  };

  const mergeKeys = (opts: MergeOptions): string[] => {
    const merged = new MergedRecipe([fileInput.path('a'), fileInput.path('b')], opts);
    return optionKeysOf(lastJobOps(merged.toWorkflowPayload([FILE_ID, 'file_0002'])), 'merge');
  };

  it.each([
    ['video', allVideo],
    ['audio', allAudio],
    ['image', allImage],
  ])('%s merge: every emitted merge-level key is a contract key for THAT media', (kind, opts) => {
    // Media-precise: validate against the specific media group's options so a
    // wrong-media or per-input-only key at merge level is rejected.
    assertKeysConform(`merge:${kind}`, mergeKeys(opts as MergeOptions), mediaGroupOptionKeys(mergeMetadata, kind as string));
  });

  it('does not leak SDK-only options (mediaKind / allowUnusedAssets) to the wire', () => {
    const keys = mergeKeys({ ...allVideo, allowUnusedAssets: true });
    expect(keys).not.toContain('mediaKind');
    expect(keys).not.toContain('allowUnusedAssets');
  });

  // Reverse direction (9u5aS8tU): the forward check above only catches an
  // emitted key that is NOT in the contract. It does NOT catch a contract
  // operation-level merge option the SDK FAILS to expose — the drift that lets
  // a new merge option (e.g. the delay/re_encode_mode/target_resolution this
  // ticket adds) silently go unreachable while CI stays green. For each media
  // kind, assert every op-level contract merge option (mergeMetadata
  // mime_groups[kind].options — per-input options excluded because we read
  // `.options` only) is either EMITTED by the maximal fixture above OR listed in
  // an explicit per-media omission set below.
  //
  // MERGE_INTENTIONALLY_OMITTED: op-level contract merge options the SDK
  // deliberately does NOT surface as a standalone MergeOptions field. Empty
  // today — every op-level key is reachable via a builder field:
  //   - output_type      via `output` / `outputType`
  //   - encoding_mode +
  //     target_size_bytes via `targetSize` (both emitted together)
  // A FUTURE new contract merge option fails this test until it is either
  // exposed on MergeOptions (+ wireMergeOptions) or documented here.
  const MERGE_INTENTIONALLY_OMITTED: Readonly<Record<string, ReadonlySet<string>>> = {
    video: new Set<string>(),
    audio: new Set<string>(),
    image: new Set<string>(),
  };

  it.each([
    ['video', allVideo],
    ['audio', allAudio],
    ['image', allImage],
  ])('%s merge: every op-level contract merge option is exposed or documented-omitted', (kind, opts) => {
    const contract = mediaGroupOptionKeys(mergeMetadata, kind as string);
    const emitted = new Set(mergeKeys(opts as MergeOptions));
    const allowed = new Set<string>([...emitted, ...(MERGE_INTENTIONALLY_OMITTED[kind as string] ?? [])]);
    const unexposed = [...contract].filter((k) => !allowed.has(k));
    expect(
      unexposed,
      `merge:${kind}: contract op-level option(s) ${JSON.stringify(unexposed)} are neither emitted by the ` +
        `SDK's wireMergeOptions nor in MERGE_INTENTIONALLY_OMITTED['${kind}'] — a new merge option would be ` +
        `silently unreachable. Expose it on MergeOptions (+ wireMergeOptions) or document the omission.`,
    ).toEqual([]);
  });
});

describe('wire-key conformance — archive', () => {
  it('emitted keys conform to the archive contract', () => {
    const contract = operationOptionKeys(archiveMetadata);
    const inputs: FileInput[] = [fileInput.path('a.png'), fileInput.path('b.pdf')];
    const archived = new ArchivedRecipe(inputs, { format: 'tar.gz', folderStructure: 'by_job' });
    const ops = lastJobOps(archived.toWorkflowPayload([FILE_ID, 'file_0002']));
    assertKeysConform('archive', optionKeysOf(ops, 'archive'), contract);
  });
});

/**
 * Eager option-key validator conformance (card Dhje3Faq). The runtime validator's
 * allowed-key set per verb, AND the hand-written typed-interface key tuples, must
 * both equal the contract `operationOptionKeys(metadata)` — so a contract
 * rename/add fails CI rather than silently de-syncing the validator or the typed
 * surface. `keyof Interface` is pinned to its tuple at `tsc` time (Equal<> in
 * option_types.ts); this ties the tuple to the contract metadata at test time.
 * Mirrored by the PHP `WireKeyConformanceTest`.
 */
describe('option-key validation conformance — validator + typed interfaces vs OperationMetadata', () => {
  // `output` is EXCLUDED here — its contract source is the image-output-routes
  // PROJECTION (not a single op's OperationMetadata), so its validator/typed-key
  // conformance is owned by `output-route-conformance.test.ts`.
  type MetadataVerb = Exclude<ValidatedVerb, 'output'>;
  const expectedContract: Record<MetadataVerb, ReadonlySet<string>> = {
    convert: operationOptionKeys(convertMetadata),
    thumbnail: operationOptionKeys(thumbnailMetadata),
    textWatermark: operationOptionKeys(textWatermarkMetadata),
    // watermark routes image_watermark | video_watermark; the base media may be
    // undetectable at the verb call, so the validator accepts the UNION.
    watermark: new Set<string>([
      ...operationOptionKeys(imageWatermarkMetadata),
      ...operationOptionKeys(videoWatermarkMetadata),
    ]),
  };

  // CONTRACT keys a verb owns via its first argument (so they are excluded from
  // the typed interface). `format` is an SDK alias, NOT a contract key, so it is
  // absent here — it is rejected by the positional guard, not the contract set.
  const positionalOwnedContractKeys: Partial<Record<MetadataVerb, readonly string[]>> = {
    convert: ['output_format'],
    textWatermark: ['text'],
  };

  const verbs: MetadataVerb[] = ['convert', 'thumbnail', 'textWatermark', 'watermark'];

  it.each(verbs)('%s: runtime validator allowed-key set equals the contract option set', (verb) => {
    expect([...allowedKeysFor(verb)].sort()).toEqual([...expectedContract[verb]].sort());
  });

  it.each(verbs)('%s: typed-interface keys ∪ positional-owned equal the contract option set', (verb) => {
    const reconstructed = new Set<string>([
      ...VERB_OPTION_KEYS[verb],
      ...(positionalOwnedContractKeys[verb] ?? []),
    ]);
    expect([...reconstructed].sort()).toEqual([...expectedContract[verb]].sort());
  });
});
