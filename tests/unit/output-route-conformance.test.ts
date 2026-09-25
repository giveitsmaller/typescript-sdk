import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  IMAGE_OUTPUT_ROUTES,
  FACADE_MANAGED_OUTPUTS,
  MAX_OUTPUT_PIXELS,
  COMPRESS_OPTION_VALUES,
  OUTPUT_OPTION_DEPENDS_ON,
  DEPENDS_ON_KEY_DEFAULTS,
  tokenForMime,
  isPlannedValue,
} from '../../src/ergonomic/image_output_routes.js';
import { VERB_OPTION_KEYS } from '../../src/ergonomic/option_types.js';
import { allowedKeysFor } from '../../src/ergonomic/option_validation.js';
import { compressMetadata } from '@giveitsmaller/contracts/operations';

/**
 * Output-route conformance guard (card YNLrGhNo).
 *
 * The Output gate reads a hand SDK table ({@link IMAGE_OUTPUT_ROUTES}) rather than
 * the raw projection at runtime, so the gate stays browser-safe (mirrors the
 * watermark-capability gate). This suite PINS that table to the generated
 * `accepted-options/image-output-routes.json` projection — a contract regen that
 * changes a route's source_op / honored / planned options, the facade-managed
 * outputs, the area cap, or the mime tokens fails HERE. Mirrored by the PHP
 * `ImageOutputRouteConformanceTest`.
 */

const require = createRequire(import.meta.url);
interface RouteCell {
  source_op: string;
  honored_options: string[];
  planned_options: string[];
  inert_options: string[];
}
interface Projection {
  media: {
    image: {
      facade_managed_outputs: string[];
      max_output_pixels: number;
      mime_tokens: Record<string, string>;
      same_format: Record<string, RouteCell>;
      format_change: Record<string, RouteCell>;
    };
  };
}
const projection = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/accepted-options/image-output-routes.json'), 'utf8'),
) as Projection;
const img = projection.media.image;

describe('IMAGE_OUTPUT_ROUTES conformance with image-output-routes.json', () => {
  it('mirrors facade_managed_outputs', () => {
    expect([...FACADE_MANAGED_OUTPUTS].sort()).toEqual([...img.facade_managed_outputs].sort());
  });

  it('mirrors the area cap', () => {
    expect(MAX_OUTPUT_PIXELS).toBe(img.max_output_pixels);
  });

  it('every projection mime token resolves via tokenForMime', () => {
    for (const [mime, token] of Object.entries(img.mime_tokens)) {
      expect(tokenForMime(mime)).toBe(token);
    }
  });

  for (const route of ['same_format', 'format_change'] as const) {
    describe(route, () => {
      const cells = img[route];
      const expectedSourceOp = route === 'same_format' ? 'compress' : 'convert';

      it('covers exactly the projection formats', () => {
        expect(Object.keys(IMAGE_OUTPUT_ROUTES[route]).sort()).toEqual(Object.keys(cells).sort());
      });

      for (const [fmt, cell] of Object.entries(cells)) {
        describe(fmt, () => {
          it(`source_op is the uniform ${expectedSourceOp}`, () => {
            // The SDK derives source_op (same_format→compress, format_change→convert)
            // rather than storing it; pin that the projection still agrees.
            expect(cell.source_op).toBe(expectedSourceOp);
          });

          it('honored options match', () => {
            expect([...IMAGE_OUTPUT_ROUTES[route][fmt]!.honored].sort()).toEqual([...cell.honored_options].sort());
          });

          it('planned options match', () => {
            expect([...IMAGE_OUTPUT_ROUTES[route][fmt]!.planned].sort()).toEqual([...cell.planned_options].sort());
          });

          it('inert options match', () => {
            expect([...IMAGE_OUTPUT_ROUTES[route][fmt]!.inert].sort()).toEqual([...cell.inert_options].sort());
          });
        });
      }
    });
  }
});

/**
 * Enum-membership table conformance (rtkzl9gr). The Output value gate reads a
 * hand table ({@link COMPRESS_OPTION_VALUES}) rather than the ~238KB availability
 * sidecar at runtime (browser-safe; no contracts-version coupling). This suite
 * PINS that table to the shipped `availability/availability.json` — a contract
 * regen that adds/changes a compress-image enum member fails HERE. Mirrored by
 * the PHP `ImageOutputRouteConformanceTest`.
 */
interface AvailabilityGroups {
  mime_groups: Record<
    string,
    {
      options: Record<
        string,
        { type?: string; values?: (string | number)[]; default?: unknown; depends_on?: Record<string, unknown> }
      >;
    }
  >;
}
interface Availability {
  operations: {
    compress: AvailabilityGroups;
    convert: AvailabilityGroups;
  };
}
const availability = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as Availability;

describe('COMPRESS_OPTION_VALUES conformance with availability.json', () => {
  const compressGroups = availability.operations.compress.mime_groups;
  // The gate keys off `image` (gif/tiff fallback) plus every `image_<fmt>` group.
  const imageGroups = Object.keys(compressGroups).filter((g) => g === 'image' || g.startsWith('image_'));

  it('covers exactly the image compress groups', () => {
    expect(Object.keys(COMPRESS_OPTION_VALUES).sort()).toEqual([...imageGroups].sort());
  });

  for (const group of imageGroups) {
    describe(group, () => {
      const enumOpts = Object.entries(compressGroups[group]!.options).filter(([, o]) => o.type === 'enum');

      it("mirrors exactly the group's enum options", () => {
        expect(Object.keys(COMPRESS_OPTION_VALUES[group]!).sort()).toEqual(enumOpts.map(([k]) => k).sort());
      });

      for (const [opt, def] of enumOpts) {
        it(`${opt} values match`, () => {
          const members = def.values ?? [];
          // The runtime gate uses STRICT string membership, so pin that the
          // contract keeps these enum members as strings — a string→number
          // contract change (which the gate would then reject) surfaces HERE
          // rather than passing silently under a `.map(String)` coercion.
          for (const m of members) expect(typeof m).toBe('string');
          expect([...COMPRESS_OPTION_VALUES[group]![opt]!].sort()).toEqual([...(members as string[])].sort());
        });
      }
    });
  }
});

describe('OUTPUT_OPTION_DEPENDS_ON conformance with availability.json', () => {
  const compressGroups = availability.operations.compress.mime_groups;
  const imageGroups = Object.keys(compressGroups).filter((g) => g === 'image' || g.startsWith('image_'));

  // Normalise an availability `depends_on` to the flat-table rule shape, FAILING
  // CLOSED on any shape the flat model can't represent (multi-key AND, array /
  // set-membership values, a `logic` other than `or`) — so a contract regen that
  // introduces an unsupported dependency form fails HERE instead of being
  // silently dropped (codex).
  const toRule = (dep: Record<string, unknown>): unknown => {
    const entries = Object.entries(dep);
    if ('logic' in dep) {
      // set/logic:or — { k1: 'set', k2: 'set', logic: 'or' }.
      expect(dep.logic).toBe('or');
      const conditions = entries.filter(([k]) => k !== 'logic');
      for (const [, v] of conditions) expect(v).toBe('set');
      return { requiresAnyOf: conditions.map(([k]) => k).sort() };
    }
    // scalar equality — EXACTLY one key mapping to a scalar string value.
    expect(entries).toHaveLength(1);
    const [key, value] = entries[0]!;
    expect(typeof value).toBe('string');
    return { requiresKey: key, requiresValue: value };
  };

  // Gather every option→depends_on across the image groups; a given option must
  // carry the SAME depends_on in every group (which justifies the FLAT table).
  const contractRules = new Map<string, unknown>();
  for (const group of imageGroups) {
    for (const [opt, def] of Object.entries(compressGroups[group]!.options)) {
      if (def.depends_on === undefined) continue;
      const rule = toRule(def.depends_on);
      const existing = contractRules.get(opt);
      if (existing !== undefined) expect(JSON.stringify(rule)).toBe(JSON.stringify(existing));
      contractRules.set(opt, rule);
    }
  }

  it('the hand table covers exactly the image options that carry a depends_on', () => {
    expect(Object.keys(OUTPUT_OPTION_DEPENDS_ON).sort()).toEqual([...contractRules.keys()].sort());
  });

  for (const [opt, rule] of contractRules) {
    it(`${opt} depends_on matches the contract`, () => {
      const handRule = OUTPUT_OPTION_DEPENDS_ON[opt]!;
      const normalisedHand =
        'requiresAnyOf' in handRule
          ? { requiresAnyOf: [...handRule.requiresAnyOf].sort() }
          : { requiresKey: handRule.requiresKey, requiresValue: handRule.requiresValue };
      expect(JSON.stringify(normalisedHand)).toBe(JSON.stringify(rule));
    });
  }

  it('encoding_mode default matches the contract (DEPENDS_ON_KEY_DEFAULTS)', () => {
    // Every image group that HAS encoding_mode defaults it to the pinned value —
    // the general gate reads this default when the key is absent.
    for (const group of imageGroups) {
      const mode = compressGroups[group]!.options.encoding_mode;
      if (mode === undefined) continue;
      expect(mode.default).toBe(DEPENDS_ON_KEY_DEFAULTS.encoding_mode);
    }
  });
});

describe('output verb allowlist conformance', () => {
  // The UNION of every image route's honored+planned option keys (the full
  // contract surface output() can emit, incl. `output_format`).
  const projectionUnionAll = (): Set<string> => {
    const keys = new Set<string>();
    for (const route of ['same_format', 'format_change'] as const) {
      for (const cell of Object.values(img[route])) {
        for (const k of cell.honored_options) keys.add(k);
        for (const k of cell.planned_options) keys.add(k);
        for (const k of cell.inert_options) keys.add(k);
      }
    }
    return keys;
  };

  it('typed OutputOptions keys equal the projection union minus positional output_format', () => {
    // output_format is set via the positional `format` arg → excluded from the bag interface.
    const expected = projectionUnionAll();
    expected.delete('output_format');
    expect([...VERB_OPTION_KEYS.output].sort()).toEqual([...expected].sort());
  });

  it('runtime validator allowed-key set equals the full projection union', () => {
    // Like convert, the allowlist INCLUDES the positional-owned output_format
    // (rejected first by the positional guard, not the allowed-key check).
    expect([...allowedKeysFor('output')].sort()).toEqual([...projectionUnionAll()].sort());
  });
});

/**
 * Convert (`format_change`) `depends_on` conformance — card L2Ay7Uak.
 *
 * L2Ay7Uak was filed to add a SECOND hand table of convert `depends_on` rules and
 * validate it on the format_change route, because `dependsOnViolation` deliberately
 * skips scalar deps there. Investigating it showed a runtime table would be dead
 * code: every convert image `depends_on` is keyed on `output_format`, and the
 * per-target `honored_options` projection the lowering ALREADY enforces is exactly
 * that constraint materialised — `output('gif', { quality: 80 })` is rejected by the
 * honored gate (quality is not honored on the gif format_change route) before
 * `dependsOnViolation` is ever reached, with a better message.
 *
 * That equivalence is the load-bearing claim, and nothing pinned it. This suite does:
 * for every convert image option carrying an `output_format` dependency, the option
 * must appear in a format_change target's honored set IFF that target is in the
 * dependency's allowed set. And it FAILS CLOSED on any dependency shape that is NOT
 * expressible that way — a future convert dep keyed on something other than
 * `output_format` is NOT implied by the honored projection and would genuinely need
 * the runtime gate L2Ay7Uak proposed.
 *
 * Mirrored by the PHP `ImageOutputRouteConformanceTest`.
 */
describe('convert format_change depends_on is subsumed by the honored projection', () => {
  const convertGroups = availability.operations.convert.mime_groups;
  const imageGroups = Object.keys(convertGroups).filter((g) => g === 'image' || g.startsWith('image_'));
  const targets = Object.keys(img.format_change);

  /**
   * The set of output formats a dependency permits, or `null` when the rule is a
   * `logic: or` set-condition (e.g. `fit → width|height`), which is media-agnostic,
   * already validated on BOTH routes by `dependsOnViolation`, and so is not an
   * output_format constraint at all.
   */
  const allowedFormats = (group: string, option: string, dep: Record<string, unknown>): string[] | null => {
    if ('logic' in dep) {
      expect(dep.logic, `${group}.${option}: only 'or' set-logic is modelled`).toBe('or');
      const conditions: string[] = [];
      for (const [k, v] of Object.entries(dep)) {
        if (k === 'logic') continue;
        expect(v, `${group}.${option}: set-condition '${k}'`).toBe('set');
        conditions.push(k);
      }
      // A set-condition is NOT an output_format rule, so the honored projection
      // does not encode it — it is gated at runtime by OUTPUT_OPTION_DEPENDS_ON,
      // which runs on BOTH routes. Skipping it here without checking would let a
      // convert-side set-condition drift (or a brand-new one on a convert-only
      // option) pass conformance while the runtime gate stayed stale or absent
      // (codex). Assert the runtime rule exists and matches, exactly.
      const handRule = OUTPUT_OPTION_DEPENDS_ON[option];
      expect(
        handRule,
        `convert ${group}.${option} carries a set-condition depends_on, which the honored ` +
          `projection cannot encode, but OUTPUT_OPTION_DEPENDS_ON has no rule for it — the ` +
          `format_change route would be ungated`,
      ).toBeDefined();
      expect(
        handRule !== undefined && 'requiresAnyOf' in handRule
          ? [...handRule.requiresAnyOf].sort()
          : undefined,
        `convert ${group}.${option}: runtime rule must be the same set-condition as the contract`,
      ).toEqual(conditions.sort());
      return null;
    }
    const entries = Object.entries(dep);
    // Fail closed: a multi-key AND, or a key other than output_format, is NOT
    // encoded by the per-target honored sets and needs a real runtime gate.
    expect(entries, `${group}.${option}: only single-key depends_on is modelled`).toHaveLength(1);
    const [key, value] = entries[0]!;
    expect(
      key,
      `${group}.${option}: depends_on '${key}' is not keyed on output_format, so the honored ` +
        `projection does not encode it — this needs a runtime gate on the format_change route ` +
        `(the L2Ay7Uak table), not just this conformance check`,
    ).toBe('output_format');
    if (Array.isArray(value)) {
      for (const v of value) expect(typeof v).toBe('string');
      return value as string[];
    }
    expect(typeof value, `${group}.${option}: scalar depends_on value`).toBe('string');
    return [value as string];
  };

  const rules: Array<{ group: string; option: string; allowed: string[] }> = [];
  for (const group of imageGroups) {
    for (const [option, def] of Object.entries(convertGroups[group]!.options)) {
      if (def.depends_on === undefined) continue;
      const allowed = allowedFormats(group, option, def.depends_on);
      if (allowed !== null) rules.push({ group, option, allowed });
    }
  }

  it('there is at least one output_format dependency to check (guards a vacuous pass)', () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  // The checks above are driven BY the contract, so an option that LOSES its
  // depends_on is simply not visited — and the flat runtime rule, which is pinned
  // to the COMPRESS groups, would keep rejecting a request convert now considers
  // legal (an over-rejection, pre-upload). Drive this one from the RUNTIME table
  // instead: every convert image group that defines an option carrying a
  // set-condition rule must still declare that same condition (codex).
  for (const [option, rule] of Object.entries(OUTPUT_OPTION_DEPENDS_ON)) {
    if (!('requiresAnyOf' in rule)) continue;
    for (const group of imageGroups) {
      const def = convertGroups[group]!.options[option];
      if (def === undefined) continue;
      it(`${group}.${option}: convert still declares the set-condition the runtime rule enforces`, () => {
        expect(
          def.depends_on,
          `OUTPUT_OPTION_DEPENDS_ON gates '${option}' on ${JSON.stringify([...rule.requiresAnyOf])} for BOTH ` +
            `routes, but convert group '${group}' no longer declares a depends_on for it — the ` +
            `format_change route would reject a request the contract now allows`,
        ).toBeDefined();
        const dep = def.depends_on!;
        expect(dep.logic, `${group}.${option}: expected an 'or' set-condition`).toBe('or');
        const conditions = Object.keys(dep).filter((k) => k !== 'logic').sort();
        expect(conditions).toEqual([...rule.requiresAnyOf].sort());
      });
    }
  }

  for (const { group, option, allowed } of rules) {
    it(`${group}.${option}: honored exactly on its permitted format_change targets`, () => {
      for (const target of targets) {
        const honored = img.format_change[target]!.honored_options.includes(option);
        expect(
          honored,
          `convert ${group}.${option} depends_on output_format ${JSON.stringify(allowed)}, but the ` +
            `format_change '${target}' route ${honored ? 'HONORS' : 'does not honor'} it — the honored ` +
            `gate and the contract dependency disagree, so the pre-upload rejection is no longer ` +
            `equivalent to the contract`,
        ).toBe(allowed.includes(target));
      }
    });
  }
});

describe('group-mapping reachability pin (SB1wmTJz)', () => {
  /**
   * The pin that stops a FOURTH visit to this defect.
   *
   * `rtkzl9gr` fixed this class for the enum-membership gate and left the sibling
   * per-value gate reading a hand-written token list whose trailing comment
   * (`// webp / gif / svg / tiff`) was true when written and silently became false once
   * `image_svg` and `image_webp` were added to the metadata. SVG inputs therefore missed
   * the one marker that mattered for them — on the preset gate AND on `output()`.
   *
   * So this does NOT pin a token list; a token list is exactly what went stale. It
   * asserts the PROPERTY, driven from the metadata's real groups: every planned
   * per-value marker on a concrete `image_<token>` group must be reachable through
   * `isPlannedValue` for that token. It exercises the shared function, so it covers
   * EVERY gate that consults it, not just the one being fixed today.
   */
  it('every concrete-group marker is reachable for its token', () => {
    let checked = 0;
    for (const [groupName, group] of Object.entries(compressMetadata.mime_groups)) {
      if (!groupName.startsWith('image_')) continue;
      const token = groupName.slice('image_'.length);
      for (const [optionKey, option] of Object.entries(group.options)) {
        for (const [value, entry] of Object.entries(option.per_value_availability)) {
          if (entry.availability !== 'planned') continue;
          checked += 1;
          expect(
            isPlannedValue(token, optionKey, value),
            `planned marker ${groupName}.${optionKey}=${value} is unreachable for token '${token}' — the group mapping has gone stale again`,
          ).toBe(true);
        }
      }
    }
    // Positive control: if the metadata stops carrying concrete-group markers the loop
    // becomes a no-op and would pass while proving nothing.
    expect(checked).toBeGreaterThan(0);
  });

  it('the widening is additive — historical verdicts hold', () => {
    // webp srgb stays GATED (RecipeOutputTest pins it) and jpeg srgb stays LIVE. If a
    // future change flips either, that is a behaviour change to be argued, not absorbed.
    expect(isPlannedValue('webp', 'color_profile', 'srgb')).toBe(true);
    expect(isPlannedValue('jpeg', 'color_profile', 'srgb')).toBe(false);
    // SVG output_format=original is NO LONGER planned, and that is the pin doing its job
    // rather than a regression. `image_svg` compress was restored to STABLE upstream
    // (contracts G9O6yrQD, vendored here at v2.188.0), so the marker SB1wmTJz existed to
    // reach no longer exists — the ticket is vendored past, not fixed. The reachability
    // machinery above still has teeth: its own positive control asserts it checked > 0
    // concrete-group markers, so this flip cannot quietly turn that loop into a no-op.
    expect(isPlannedValue('svg', 'output_format', 'original')).toBe(false);
  });
});
