import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { WATERMARK_CAPABILITY } from '../../src/file-first.js';

/**
 * Watermark capability conformance guard (FF4a / Z7zTr789).
 *
 * The watermark planned-op gate reads a hand SDK table ({@link
 * WATERMARK_CAPABILITY}) rather than the generated typed metadata, because the
 * typed `MimeGroupMetadata` carries NO supported-mime allowlist (`mimes` is not
 * a field and `per_mime_availability` is empty for these ops). The allowlist +
 * availability live only in the raw `availability.json` sidecar. This suite
 * pins the SDK table to that sidecar — a contract regen that changes the
 * supported mimes or availability of `image_watermark` / `video_watermark`
 * fails HERE (mirrors the wire-key-conformance pattern). Mirrored by the PHP
 * `WatermarkCapabilityConformanceTest`.
 */

import { mostCautious } from './availability-ladder.js';

const require = createRequire(import.meta.url);
const availabilityRoot = JSON.parse(
  readFileSync(require.resolve('@giveitsmaller/contracts/availability/availability.json'), 'utf8'),
) as {
  operations?: Record<string, {
    availability?: string;
    mime_groups?: Record<string, { availability?: string; mimes?: string[] }>;
  }>;
};
// Operations are nested under the top-level `operations` key.
const availability = availabilityRoot.operations ?? {};

function resolvedAvailability(op: string, group: string): string {
  const opMeta = availability[op];
  return mostCautious(opMeta?.availability, opMeta?.mime_groups?.[group]?.availability);
}

describe('most-cautious resolution (PMvwhNI1)', () => {
  it('a stable group under a planned root resolves to PLANNED (precedence said stable)', () => {
    expect(mostCautious('planned', 'stable')).toBe('planned');
  });
  it('a stricter group wins over a looser root', () => {
    expect(mostCautious(undefined, 'planned')).toBe('planned');
    expect(mostCautious('beta', 'experimental')).toBe('experimental');
  });
  it('absence is stable at every link', () => {
    expect(mostCautious(undefined, undefined)).toBe('stable');
  });
  it('an unknown value fails loudly rather than ranking somewhere', () => {
    expect(() => mostCautious('stable', 'gamma')).toThrow(/not on the contract ladder/);
  });
});

describe('WATERMARK_CAPABILITY conformance with availability.json', () => {
  for (const [op, groups] of Object.entries(WATERMARK_CAPABILITY)) {
    describe(op, () => {
      it('is a real contract operation', () => {
        expect(availability[op]).toBeDefined();
      });

      for (const [group, cell] of Object.entries(groups)) {
        describe(group, () => {
          it('matches the contract supported mimes', () => {
            const contractMimes = availability[op]?.mime_groups?.[group]?.mimes;
            expect(contractMimes).toBeDefined();
            expect([...cell.mimes].sort()).toEqual([...(contractMimes ?? [])].sort());
          });

          it('matches the contract availability', () => {
            expect(cell.availability).toBe(resolvedAvailability(op, group));
          });
        });
      }
    });
  }
});
