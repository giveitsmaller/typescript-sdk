import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { SOLE_OP_TYPES } from '../../src/file-first.js';

/**
 * sole_op conformance guard (IQc01rj0).
 *
 * The single-input `Recipe.toWorkflowPayload` split reads a hand SDK set
 * ({@link SOLE_OP_TYPES}) rather than the raw `operation-capabilities.json`
 * sidecar at runtime, so the split stays browser-safe (the raw-JSON subpath is
 * Node-only) and carries NO dependency on a contracts version exposing it a
 * different way — exactly like `WATERMARK_CAPABILITY`. This suite PINS that set
 * to the shipped `operation-capabilities.json` `operations.<op>.sole_op` — a
 * contract regen that flips an op's `sole_op` (or adds an 11th sole_op op) fails
 * HERE. Mirrored by the PHP `SoleOpConformanceTest`.
 */

const require = createRequire(import.meta.url);
const caps = JSON.parse(
  readFileSync(
    require.resolve('@giveitsmaller/contracts/operation-capabilities/operation-capabilities.json'),
    'utf8',
  ),
) as { operations: Record<string, { sole_op?: boolean }> };

describe('SOLE_OP_TYPES conformance with operation-capabilities.json', () => {
  it('mirrors exactly the ops the contract marks sole_op', () => {
    const contractSoleOps = Object.entries(caps.operations)
      .filter(([, c]) => c.sole_op === true)
      .map(([op]) => op)
      .sort();
    expect([...SOLE_OP_TYPES].sort()).toEqual(contractSoleOps);
  });
});
