import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  IMAGE_OUTPUT_ROUTES,
  FACADE_MANAGED_OUTPUTS,
  MAX_OUTPUT_PIXELS,
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
