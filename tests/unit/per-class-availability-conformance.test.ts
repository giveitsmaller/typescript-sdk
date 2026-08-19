import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * `per_class_availability` overlay pin (card `zJN6XIi5`).
 *
 * The contract can now scope an option's availability to a PROCESSING CLASS, not
 * just to a mime group. That is what lets the API refuse a long-form merge with
 * a target size at CREATE, with an honest 422, instead of the job dying
 * mid-execution — which is what happens on the published SDKs today.
 *
 * ⚠️ **THIS PIN DOES NOT GATE ANYTHING CLIENT-SIDE, AND THAT IS DELIBERATE.**
 * Routing to long-form is decided SERVER-SIDE at create-plan time from summed
 * input duration. The SDK cannot know which path a merge will take, and the
 * ticket explicitly forbids a duration heuristic: it would be wrong at the
 * boundary and would diverge from the server resolver the moment either
 * changed. If the gate cannot be exact it belongs server-side.
 *
 * So what this suite is for is narrower and still worth having: **the SDK's
 * user-facing documentation makes a factual claim about this overlay**, and the
 * overlay is the thing that could change underneath it. The MERGE `targetSize`
 * docblocks tell callers that target-size is unavailable on the long-form path.
 * If contracts ever flips `long_form_re_encode` to available — Phase 3 two-pass
 * target-size is a real roadmap item — those docblocks become lies, and nothing
 * else in this repo would notice.
 *
 * ⚠️ **COMPRESS IS A DIFFERENT AND WORSE CASE, PINNED SEPARATELY BELOW.** The
 * overlay covers `merge` ONLY — compress has NO `per_class_availability` at all,
 * so two of the four `targetSize` docblocks describe a limitation the contract
 * does not express anywhere. That ABSENCE is pinned, so the day it changes we
 * hear about it instead of the overlay landing unnoticed.
 *
 * FAILS CLOSED in both directions, same shape as the preset planned gate:
 * the option must still be declared, and it must still be `planned`.
 */

const require = createRequire(import.meta.url);

interface ClassAvailability {
  readonly availability?: string;
}
interface OptionNode {
  per_class_availability?: Record<string, ClassAvailability>;
  per_value_availability?: Record<string, OptionNode>;
}
interface Availability {
  operations: Record<
    string,
    { mime_groups?: Record<string, { options?: Record<string, OptionNode> }> }
  >;
}

const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as Availability;

const LONG_FORM_CLASS = 'long_form_re_encode';

function mergeVideoOptions(): Record<string, OptionNode> {
  return availability.operations.merge?.mime_groups?.video?.options ?? {};
}

describe('per_class_availability overlay (zJN6XIi5)', () => {
  it('the merge video option set is readable at all', () => {
    // Positive control. Every assertion below indexes into this map and would
    // pass vacuously against an empty one — which is exactly what a renamed
    // operation or mime group would produce.
    const options = mergeVideoOptions();
    expect(Object.keys(options).length).toBeGreaterThan(0);
    expect(options.encoding_mode).toBeDefined();
  });

  it('scopes encoding_mode to the long-form class as PLANNED', () => {
    // The option is rejected by PRESENCE on the long-form path, so the whole
    // option carries the overlay — not merely the target_size value.
    const perClass = mergeVideoOptions().encoding_mode?.per_class_availability;
    expect(perClass).toBeDefined();
    expect(perClass?.[LONG_FORM_CLASS]?.availability).toBe('planned');
  });

  it('scopes the target_size VALUE to the long-form class as PLANNED', () => {
    const perValue = mergeVideoOptions().encoding_mode?.per_value_availability;
    expect(perValue?.target_size?.per_class_availability?.[LONG_FORM_CLASS]?.availability).toBe(
      'planned',
    );
  });

  it('scopes normalize_audio to the long-form class as PLANNED', () => {
    const perClass = mergeVideoOptions().normalize_audio?.per_class_availability;
    expect(perClass?.[LONG_FORM_CLASS]?.availability).toBe('planned');
  });

  it('pins that COMPRESS has NO per-class overlay — the other half of the claim', () => {
    // codex f8b43b658063 caught that this suite's promise exceeded its coverage.
    // Their suggested location was wrong (operation-capabilities has zero
    // long-form nodes) and their conclusion was right, and the truth is worse:
    // COMPRESS HAS NO per_class_availability OVERLAY AT ALL. Only merge got one.
    //
    // So two of the four `targetSize` docblocks describe a limitation the
    // contract does not express anywhere. This assertion pins that ABSENCE, so
    // the day contracts extends the overlay to compress, this fires and the
    // compress docblocks get updated with the merge ones — rather than the
    // overlay landing and nothing noticing, which is the whole failure this
    // card was filed against.
    const compressVideo =
      (availability.operations.compress?.mime_groups?.video?.options ?? {}) as Record<
        string,
        OptionNode
      >;
    expect(Object.keys(compressVideo).length).toBeGreaterThan(0); // positive control
    expect(compressVideo.encoding_mode).toBeDefined();
    expect(
      compressVideo.encoding_mode?.per_class_availability,
      'compress gained a per-class overlay — pin it, and update the compress targetSize docblocks',
    ).toBeUndefined();
  });

  it('⚠️ WHEN THIS GOES RED, THE SHIPPED targetSize DOCBLOCKS BECOME LIES', () => {
    // The tripwire, stated as a test rather than as a comment somebody has to
    // read. Every `targetSize` declaration in BOTH SDKs tells callers this is
    // unavailable on long inputs. The day Phase 3 two-pass target-size ships
    // and contracts flips this to `stable`, this assertion fails — and the
    // correct response is to REWRITE THOSE DOCBLOCKS, not to relax this line.
    //
    // The MERGE declarations, which is what this assertion actually covers:
    //   packages/typescript/src/merge.ts             (MergeOptions.targetSize)
    //   packages/php/src/Ergonomic/MergeOptions.php  ($targetSize)
    // The compress pair is covered by the compress-has-no-overlay test above.
    const perClass = mergeVideoOptions().encoding_mode?.per_class_availability;
    expect(
      perClass?.[LONG_FORM_CLASS]?.availability,
      'long-form target-size became available — update the four targetSize docblocks in both SDKs',
    ).toBe('planned');
  });
});
