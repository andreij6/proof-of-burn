import { describe, it, expect } from 'vitest';
import { deriveFastLaneStep, FAST_LANE_STAKE_E8S, FAST_LANE_FUND_TARGET_E8S } from '../FastLane';

describe('Fast Lane step derivation', () => {
  it('lands the user on the first unsatisfied step', () => {
    expect(deriveFastLaneStep(false, 0n, false)).toBe('signin');
    expect(deriveFastLaneStep(true, 0n, false)).toBe('fund');
    expect(deriveFastLaneStep(true, FAST_LANE_FUND_TARGET_E8S - 1n, false)).toBe('fund');
    expect(deriveFastLaneStep(true, FAST_LANE_FUND_TARGET_E8S, false)).toBe('stake');
    expect(deriveFastLaneStep(true, 500_000_000n, false)).toBe('stake');
  });

  it('an existing stake completes the lane regardless of balance', () => {
    expect(deriveFastLaneStep(true, 0n, true)).toBe('done');
    expect(deriveFastLaneStep(true, 500_000_000n, true)).toBe('done');
  });

  it('funding target covers the 1 ICP stake plus one ledger fee', () => {
    expect(FAST_LANE_STAKE_E8S).toBe(100_000_000n);
    expect(FAST_LANE_FUND_TARGET_E8S).toBe(100_010_000n);
  });
});
