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
} from '../../src/ergonomic/image_output_routes.js';
import { VERB_OPTION_KEYS } from '../../src/ergonomic/option_types.js';
import { allowedKeysFor } from '../../src/ergonomic/option_validation.js';

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
interface Availability {
  operations: {
    compress: {
      mime_groups: Record<
        string,
        {
          options: Record<
            string,
            { type?: string; values?: (string | number)[]; default?: unknown; depends_on?: Record<string, unknown> }
          >;
        }
      >;
    };
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
