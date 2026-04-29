/**
 * Pin the asyncapi schema rename from contracts v2.3.1 (PR #73 / QokFw8VR):
 * inline anonymous enums are now named `JobInputRole` and `ReEncodeDecision`.
 *
 * Reason this exists: the rename has no behaviour-level test surface in
 * the SDK (asyncapi types ship for the Rust lambdas, not the SDK's public
 * API). Without a value-bearing pin here, a future regen that re-anonymises
 * either schema would compile cleanly and slip past `tsc --noEmit` as long
 * as no consumer imports them.
 *
 * Generic guard against the T20 audit-gate lesson: type-only re-exports can
 * compile but ship nothing — assert each enum is value-bearing at runtime.
 *
 * The wire values must match the openapi/asyncapi spec exactly; if the
 * server semantics shift, this test fails first.
 */
import { describe, it, expect } from 'vitest';
import JobInputRole from '../../../../generated/typescript/asyncapi/JobInputRole.js';
import ReEncodeDecision from '../../../../generated/typescript/asyncapi/ReEncodeDecision.js';

describe('AsyncAPI named enums (contracts v2.3.1 rename)', () => {
  it('JobInputRole is value-bearing (not type-only) and exposes the three wire roles', () => {
    expect(typeof JobInputRole).toBe('object');
    expect(JobInputRole.BASE).toBe('base');
    expect(JobInputRole.OVERLAY).toBe('overlay');
    expect(JobInputRole.TRANSITION_MASK).toBe('transition_mask');
    expect(Object.values(JobInputRole).sort()).toEqual(
      ['base', 'overlay', 'transition_mask'],
    );
  });

  it('ReEncodeDecision is value-bearing and exposes both wire decisions', () => {
    expect(typeof ReEncodeDecision).toBe('object');
    expect(ReEncodeDecision.STREAM_COPY).toBe('stream_copy');
    expect(ReEncodeDecision.RE_ENCODE).toBe('re_encode');
    expect(Object.values(ReEncodeDecision).sort()).toEqual(
      ['re_encode', 'stream_copy'],
    );
  });
});
