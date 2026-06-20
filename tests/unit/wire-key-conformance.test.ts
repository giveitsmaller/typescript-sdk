import { describe, it, expect } from 'vitest';
import {
  archiveMetadata,
  compressMetadata,
  convertMetadata,
  mergeMetadata,
  textWatermarkMetadata,
  thumbnailMetadata,
  type OperationMetadata,
} from '@giveitsmaller/contracts/operations';

import { KNOWN_WIRE_FIELDS } from '../../src/ergonomic/preset_resolver.js';
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

describe('wire-key conformance — compress', () => {
  // KNOWN_WIRE_FIELDS is the SDK's own declared compress wire vocabulary (the
  // post-rename allowlist the preset resolver validates against). Pin it to the
  // contract so a contract rename/removal that the hand-maintained list misses
  // fails CI instead of shipping a silently-wrong key.
  it('every KNOWN_WIRE_FIELDS key is a real compress contract option', () => {
    const contract = operationOptionKeys(compressMetadata);
    const declared = new Set<string>();
    for (const set of Object.values(KNOWN_WIRE_FIELDS)) {
      for (const k of set) declared.add(k);
    }
    assertKeysConform('compress', declared, contract);
  });

  // Reverse direction (7dUpPmDZ): the check above only catches a contract key
  // REMOVED/renamed out from under KNOWN_WIRE_FIELDS. It does NOT catch a contract
  // key ADDED that KNOWN_WIRE_FIELDS lacks — which is the real drift risk: the
  // ergonomic resolver would throw `unknown_field` on a field the wire accepts,
  // silently lagging the contract. Pin the reverse PER MEDIA so a new compress
  // option fails CI until it is either exposed (added to KNOWN_WIRE_FIELDS) or
  // explicitly documented as intentionally omitted below.
  //
  // INTENTIONALLY_OMITTED: contract compress options the ergonomic resolver
  // deliberately does NOT expose.
  //
  // `output_format` on compress is the API-side "compress + change format"
  // facade surface (contracts VcPeRWdD / ADR-0021) — canonicalized to a
  // `convert` op server-side. Changing format is a `convert()` concern in the
  // ergonomic SDK, never an ergonomic `compress()` option, so compress's
  // `output_format` is omitted for audio + video REGARDLESS of availability:
  //   - audio: ALL values flipped `stable` in contracts v2.78.0 (RTokti20) — now
  //     live, but still omitted here (format-change goes through `convert`).
  //   - video: non-`original` values are `per_value_availability: planned`
  //     (facade unbuilt for video) — omitted; exposing a planned value would let
  //     the resolver emit a field the worker can't honour.
  // (Image keeps `output_format` in KNOWN_WIRE_FIELDS — its preset emits the
  // stable `original` value — so it is NOT listed for image.)
  //
  // Image format-specific knobs (contracts v2.80.0 honesty pass): compress.image
  // is now a 4-group family — image (webp/gif/svg/tiff), image_jpeg, image_png,
  // image_avif. The ergonomic resolver models image-compress with ONE
  // format-agnostic `image` media that emits only the options common to every
  // image input format (quality / metadata / output_format). The per-format
  // advanced knobs are NOT emitted by the format-agnostic path and are omitted
  // until per-input-format ergonomic options ship (tracked follow-up):
  //   - progressive        (image_jpeg only)
  //   - optimization_level (image_png only)
  //   - avif_speed         (image_avif only)
  // Document compress `quality` (contracts v2.83.0 document-compress honesty
  // pass): a stable, real per-document-group quality knob the ergonomic
  // document-compress preset path does not expose yet (the document preset DTOs
  // carry profile/image_quality/strip_* but not `quality`) — omitted until a
  // document-quality ergonomic option ships (tracked follow-up).
  const INTENTIONALLY_OMITTED: Readonly<Record<string, ReadonlySet<string>>> = {
    image: new Set(['progressive', 'optimization_level', 'avif_speed']),
    audio: new Set(['output_format']),
    video: new Set(['output_format']),
    document_pdf: new Set(['quality']),
    document_office: new Set(['quality']),
    document_odf: new Set(['quality']),
    document_epub: new Set(['quality']),
  };

  // The SDK's single format-agnostic `image` media maps to the contract's
  // image-family groups (`image` + every `image_*`); all other SDK media map
  // 1:1 to a same-named mime group.
  const imageFamilyGroups = (m: OperationMetadata): string[] =>
    Object.keys(m.mime_groups).filter((g) => g === 'image' || g.startsWith('image_'));

  it('every contract compress option (per media) is in KNOWN_WIRE_FIELDS or the documented omission set', () => {
    for (const media of Object.keys(KNOWN_WIRE_FIELDS)) {
      // For `image` the contract surface is the UNION of every image-family
      // group (so a per-format option like optimization_level is captured);
      // for other media it is the one same-named group. mediaGroupOptionKeys
      // asserts the group exists → a renamed/dropped PresetMedia⇄mime_group
      // mapping fails loudly rather than silently skipping.
      const contractForMedia = media === 'image'
        ? new Set<string>(
            imageFamilyGroups(compressMetadata).flatMap(
              (g) => [...mediaGroupOptionKeys(compressMetadata, g)],
            ),
          )
        : mediaGroupOptionKeys(compressMetadata, media);
      const allowed = new Set<string>(KNOWN_WIRE_FIELDS[media as keyof typeof KNOWN_WIRE_FIELDS]);
      for (const k of INTENTIONALLY_OMITTED[media] ?? []) allowed.add(k);
      const stray = [...contractForMedia].filter((k) => !allowed.has(k));
      expect(
        stray,
        `compress[${media}]: contract option(s) ${JSON.stringify(stray)} are neither in ` +
          `KNOWN_WIRE_FIELDS['${media}'] nor INTENTIONALLY_OMITTED['${media}'] — the ergonomic ` +
          `resolver would throw 'unknown_field' on a field the wire accepts. Either add it to ` +
          `KNOWN_WIRE_FIELDS (and its preset/alias plumbing) or document the omission.`,
      ).toEqual([]);
    }
  });

  // Whole-media-group coverage (closes the blind spot one level up): the per-media
  // reverse check above iterates KNOWN_WIRE_FIELDS keys, so a contract mime_group
  // ABSENT from KNOWN_WIRE_FIELDS would be skipped silently — the resolver would
  // unknown_field-throw on every option for that media while CI stays green. Assert
  // every contract compress mime_group has a KNOWN_WIRE_FIELDS entry — folding the
  // image-family groups (image + image_*) into the SDK's single `image` media.
  it('every contract compress mime_group is covered by KNOWN_WIRE_FIELDS', () => {
    const known = new Set(Object.keys(KNOWN_WIRE_FIELDS));
    const uncovered = Object.keys(compressMetadata.mime_groups).filter(
      (m) => !known.has(m) && !(known.has('image') && (m === 'image' || m.startsWith('image_'))),
    );
    expect(
      uncovered,
      `contract compress mime_group(s) ${JSON.stringify(uncovered)} have no KNOWN_WIRE_FIELDS ` +
        `entry — the per-media reverse check silently skips them. Add the media to KNOWN_WIRE_FIELDS.`,
    ).toEqual([]);
  });
});

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
    codec: 'h264',
    crf: 23,
    preset: 'medium',
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
