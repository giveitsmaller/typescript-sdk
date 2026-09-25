import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { MULTI_INPUT_OPERATION_TYPES } from '../../src/gisl.js';

/**
 * Multi-input conformance guard (7vD8RGlI).
 *
 * `MultiInputOperationType` keeps multi-input ops out of the single-input
 * `operation()` escape hatch, and its docblock names the builder for each. Two
 * claims live there that nothing used to check: that the list covers every op
 * the contract marks `input.model: multi`, and that the ops WITHOUT a builder are
 * the ones the contract does not let anyone run. This suite pins both to the
 * shipped `operation-capabilities.json`.
 *
 * ⭐ When the builderless test goes red, that is the good news: an op was
 * re-listed and now needs a builder in BOTH SDKs (the PHP arm is
 * `MultiInputConformanceTest`). Write it, then flip its `HAS_BUILDER` entry —
 * never the other way round.
 */

const require = createRequire(import.meta.url);
const caps = JSON.parse(
  readFileSync(
    require.resolve('@giveitsmaller/contracts/operation-capabilities/operation-capabilities.json'),
    'utf8',
  ),
) as { operations: Record<string, { availability?: string; input?: { model?: string } }> };

// Ops with a dedicated builder. Everything else in MULTI_INPUT_OPERATION_TYPES
// is builderless.
const HAS_BUILDER: Record<string, boolean> = {
  merge: true,
  archive: true,
  image_watermark: true,
  video_watermark: true,
  audio_overlay: false,
  audio_to_video: false,
  custom_luma: false,
};

describe('MultiInputOperationType conformance with operation-capabilities.json', () => {
  it('names exactly the ops the contract marks multi-input', () => {
    const contractMultiOps = Object.entries(caps.operations)
      .filter(([, c]) => c.input?.model === 'multi')
      .map(([op]) => op)
      .sort();
    expect([...MULTI_INPUT_OPERATION_TYPES].sort()).toEqual(contractMultiOps);
    expect(Object.keys(HAS_BUILDER).sort()).toEqual(contractMultiOps);
  });

  it('leaves an op without a builder only while the contract marks it planned', () => {
    const builderless = Object.entries(HAS_BUILDER)
      .filter(([, hasBuilder]) => !hasBuilder)
      .map(([op]) => op);
    expect(builderless.length).toBeGreaterThan(0);
    for (const op of builderless) {
      expect(
        caps.operations[op]?.availability,
        `${op} is no longer planned: it needs a builder in both SDKs (7vD8RGlI)`,
      ).toBe('planned');
    }
  });
});
