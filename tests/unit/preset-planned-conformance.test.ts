import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  PLANNED_COMPRESS_OPTIONS,
  KNOWN_WIRE_FIELDS,
  resolveCompressOptions,
} from '../../src/ergonomic/preset_resolver.js';
import { OptimizeFor } from '../../src/generated/sdk_spec/enums.js';

/**
 * Planned-option emission guard (card 5Eksm9s7).
 *
 * Published 0.21.0 / PHP 0.15.0 shipped preset cells for the three document media
 * whose keys are `availability: planned` in the contract we ship. The API rejects a
 * planned option when the KEY IS PRESENT and ignores it when absent
 * (`CreateWorkflowCommandHandler::recordPlannedFromMap` — a materialized default
 * deliberately does not trigger it), so every document compress with an `optimizeFor`
 * was a 422 `feature_not_available` at create, from a value the caller never typed.
 *
 * The seven keys were the instance; THIS SUITE IS THE DELIVERABLE. It fails closed on
 * the next option contracts flips to `planned`, in both directions:
 *
 *   1. the hand table is a faithful projection of `availability.json` (marking or
 *      unmarking an option breaks the build, not the caller), and
 *   2. no shipped preset cell can emit a planned option, at any media × any level —
 *      asserted against the resolver's real output, not against the table.
 *
 * (2) is the one that matters: it would have caught this bug with an EMPTY table,
 * because it reads availability.json directly rather than trusting our projection of
 * it. A gate that only checked (1) would have passed happily on the broken build.
 *
 * Mirrored by the PHP `PresetPlannedConformanceTest`.
 */

const require = createRequire(import.meta.url);

interface AvailabilityOption {
  availability?: string;
  default?: unknown;
  per_value_availability?: Record<string, { availability?: string }>;
}
interface Availability {
  operations: Record<
    string,
    { mime_groups?: Record<string, { options?: Record<string, AvailabilityOption> }> }
  >;
}

const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as Availability;

const compressGroups = availability.operations.compress.mime_groups ?? {};

/** Planned option keys for a compress mime-group, read straight from the sidecar. */
function plannedKeysFromContract(group: string): Set<string> {
  const options = compressGroups[group]?.options ?? {};
  return new Set(
    Object.entries(options)
      .filter(([, opt]) => opt.availability === 'planned')
      .map(([key]) => key),
  );
}

const PRESET_MEDIA = Object.keys(KNOWN_WIRE_FIELDS) as (keyof typeof KNOWN_WIRE_FIELDS)[];
const LEVELS: OptimizeFor[] = [OptimizeFor.Size, OptimizeFor.Balanced, OptimizeFor.Quality];

describe('PLANNED_COMPRESS_OPTIONS conformance with availability.json', () => {
  it('covers exactly the preset media, so a new medium cannot skip the gate', () => {
    expect(Object.keys(PLANNED_COMPRESS_OPTIONS).sort()).toEqual([...PRESET_MEDIA].sort());
  });

  it.each(PRESET_MEDIA)('%s: the hand table matches the contract exactly', (media) => {
    // Every preset medium must be a real compress mime-group — otherwise the lookup
    // below silently reads `{}` and the whole gate passes vacuously.
    expect(Object.keys(compressGroups)).toContain(media);

    const fromContract = [...plannedKeysFromContract(media)].sort();
    const fromTable = [...PLANNED_COMPRESS_OPTIONS[media]].sort();
    expect(fromTable).toEqual(fromContract);
  });

  it('positive control: the contract genuinely marks options planned', () => {
    // Guards against the whole suite passing because `availability.json` was
    // restructured and every lookup now yields an empty set — the exact
    // uniform-and-clean result that would make the it.each above meaningless.
    const total = PRESET_MEDIA.reduce((n, m) => n + plannedKeysFromContract(m).size, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe('shipped presets never emit a planned option', () => {
  for (const media of PRESET_MEDIA) {
    for (const level of LEVELS) {
      it(`${media} / ${level}: no planned key on the wire`, () => {
        const { wireOptions, resolvedOptions } = resolveCompressOptions({
          media,
          op: 'compress',
          optimize: level,
          explicitOptions: {},
        });

        const planned = plannedKeysFromContract(media);
        const onWire = Object.keys(wireOptions).filter((k) => planned.has(k));
        expect(onWire).toEqual([]);

        // The introspection surface must agree with the wire — a caller reading
        // `resolvedOptions.applied` should not be told we sent something we dropped.
        const applied = Object.keys(resolvedOptions.applied).filter((k) => planned.has(k));
        expect(applied).toEqual([]);
      });
    }
  }

  it('positive control: a medium whose preset survives the drop still emits keys', () => {
    // Guards "emits nothing" being read as "emits nothing planned". Uses `video`
    // BECAUSE its preset cell is untouched by the drop — if this ever goes empty the
    // drop has over-reached. It deliberately does NOT speak for the document media,
    // which the next test covers and which behave differently.
    const { wireOptions } = resolveCompressOptions({
      media: 'video',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
    });
    expect(Object.keys(wireOptions).length).toBeGreaterThan(0);
  });

  it.each(['document_office', 'document_odf', 'document_epub'] as const)(
    '%s: KNOWN CONSEQUENCE — the preset is now a no-op at every level',
    (media) => {
      // Pinning a real product consequence rather than hiding it: every key these
      // three cells shipped was `planned`, so after the drop all three levels resolve
      // to an EMPTY payload and `optimizeFor` no longer distinguishes Size from
      // Quality for documents. That is strictly better than the 422 it replaces, and
      // it is not nothing: the contract exposes a stable `quality` on these groups
      // that the SDK's document preset DTOs have never carried, so there is a real
      // option available to make these levels mean something again.
      //
      // Choosing a quality-per-level for documents is a PRODUCT call and it would
      // move the generated preset table (and with it PRESET_VERSION /
      // presetConfigHash), so it is deliberately NOT made here. Raised with the hub;
      // this test fails the moment someone gives these cells a value, which is the
      // point — the change should be deliberate, not incidental.
      for (const level of LEVELS) {
        const { wireOptions } = resolveCompressOptions({
          media,
          op: 'compress',
          optimize: level,
          explicitOptions: {},
        });
        expect(wireOptions).toEqual({});
      }
    },
  );
});

describe('planned per-VALUE gating on the resolved preset media', () => {
  // Option-level `availability` is not the only way a key can be unavailable: a
  // stable option can carry a `planned` VALUE (`per_value_availability`). A shipped
  // preset that emits such a value is the same defect wearing a different hat.
  //
  // LIMIT, stated so this is not read as more coverage than it is: this checks the
  // PRESET MEDIA's group only (`image`, `audio`, …). It does NOT check the concrete
  // mime group the server will resolve from the actual file — `compress.image_svg`
  // marks `output_format: 'original'` PLANNED, and our image preset emits exactly
  // that at every level, so an SVG input is still a live 422. The resolver cannot
  // gate it today: it receives `media: 'image'` and never learns the input format.
  // Fixing that means plumbing the concrete input token through the resolver in both
  // languages — filed as SB1wmTJz rather than smuggled into this fix.
  for (const media of PRESET_MEDIA) {
    for (const level of LEVELS) {
      it(`${media} / ${level}: no planned VALUE on the wire`, () => {
        const { wireOptions } = resolveCompressOptions({
          media,
          op: 'compress',
          optimize: level,
          explicitOptions: {},
        });

        const options = compressGroups[media]?.options ?? {};
        const offenders = Object.entries(wireOptions).filter(([key, value]) => {
          const perValue = options[key]?.per_value_availability ?? {};
          return perValue[String(value)]?.availability === 'planned';
        });
        expect(offenders).toEqual([]);
      });
    }
  }

  it('positive control: the contract does mark some enum values planned', () => {
    const anyPerValuePlanned = Object.values(compressGroups).some((group) =>
      Object.values(group.options ?? {}).some((opt) =>
        Object.values(opt.per_value_availability ?? {}).some((v) => v.availability === 'planned'),
      ),
    );
    expect(anyPerValuePlanned).toBe(true);
  });
});

describe('a caller-supplied planned option is NOT swallowed', () => {
  // Drop only what WE put there. An explicit request for a planned option is left on
  // the wire for the server to refuse honestly — a silent no-op would be worse than
  // the 422, and would be us committing the defect while fixing it.
  it('keeps an explicitly-set planned option', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'document_office',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: { stripMacros: true },
    });

    expect(wireOptions.strip_macros).toBe(true);
    expect(resolvedOptions.sources.explicit).toContain('strip_macros');
    // …while the sdkDefault-sourced siblings are still dropped.
    expect(wireOptions.strip_hidden_data).toBeUndefined();
    expect(wireOptions.strip_unused_fonts).toBeUndefined();
  });

  it('keeps a planned option supplied as a per-call preset override', () => {
    const { wireOptions, resolvedOptions } = resolveCompressOptions({
      media: 'document_epub',
      op: 'compress',
      optimize: OptimizeFor.Size,
      explicitOptions: {},
      presetOverrides: { fontSubsetting: false },
    });

    expect(wireOptions.font_subsetting).toBe(false);
    expect(resolvedOptions.sources.callPresetOverride).toContain('font_subsetting');
    expect(wireOptions.strip_unused_css).toBeUndefined();
  });
});
