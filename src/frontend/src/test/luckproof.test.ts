import { describe, it, expect } from 'vitest';
import {
  edgeBp, evLeakedBp, fmtChipsBp, gambleText, decisionFeedback,
  LP_ROUNDS, type LPGamble,
} from '../arcade/LuckProof';

const g = (p_bp: number, cost: number, payout: number, framing = 0, outs = 0, cards = 0): LPGamble =>
  ({ p_bp, cost, payout, framing, outs, cards });

describe('Luck-Proof scoring helpers (mirror the backend exactly)', () => {
  it('edgeBp: p·payout − cost, in chip-basis-points', () => {
    // p=60%, cost 50, payout 100 → +10 chips = 100_000 bp (backend test twin).
    expect(edgeBp(g(6_000, 50, 100))).toBe(100_000);
    expect(edgeBp(g(4_000, 50, 100))).toBe(-100_000);
    expect(edgeBp(g(5_000, 50, 100))).toBe(0);
  });

  it('evLeakedBp: 0 for perfect play; |edge| per wrong decision', () => {
    const plus = g(6_000, 50, 100);
    const minus = g(4_000, 50, 100);
    expect(evLeakedBp([plus, minus], [true, false])).toBe(0);
    expect(evLeakedBp([plus, minus], [false, true])).toBe(200_000);
    // A close call barely costs anything either way.
    expect(evLeakedBp([g(5_001, 50, 100)], [false])).toBe(100);
  });

  it('fmtChipsBp renders one-decimal chips', () => {
    expect(fmtChipsBp(100_000)).toBe('10.0');
    expect(fmtChipsBp(123_456)).toBe('12.3');
    expect(fmtChipsBp(0n)).toBe('0.0');
  });

  it('LP_ROUNDS matches the backend run length', () => {
    expect(LP_ROUNDS).toBe(10);
  });
});

describe('gambleText — each framing states its exact numbers', () => {
  it('percent framing', () => {
    const t = gambleText(g(6_250, 40, 80, 0));
    expect(t).toContain('62.5%');
    expect(t).toContain('40 chips');
    expect(t).toContain('80 chips');
  });

  it('odds framing reuses outs:cards as a:b against', () => {
    const t = gambleText(g(4_000, 30, 90, 1, 3, 2)); // 3:2 against
    expect(t).toContain('3 : 2 AGAINST');
    expect(t).toContain('30 chips');
  });

  it('outs framing', () => {
    const t = gambleText(g(2_826, 20, 100, 2, 13, 46));
    expect(t).toContain('13 of the 46 unseen cards');
    expect(t).toContain('20 chips');
  });
});

describe('decisionFeedback', () => {
  it('classifies takes and passes by the true edge', () => {
    const plus = g(6_000, 50, 100);  // +10 chips
    const minus = g(4_000, 50, 100); // −10 chips
    expect(decisionFeedback(plus, true).good).toBe(true);
    expect(decisionFeedback(plus, false).good).toBe(false);
    expect(decisionFeedback(minus, false).good).toBe(true);
    expect(decisionFeedback(minus, true).good).toBe(false);
    expect(decisionFeedback(minus, true).text).toContain('10.0');
  });

  it('near-zero edges are called coin flips, never punished', () => {
    const close = g(5_002, 50, 100); // edge = 0.02 chips
    expect(decisionFeedback(close, true).good).toBe(true);
    expect(decisionFeedback(close, false).good).toBe(true);
    expect(decisionFeedback(close, false).text).toContain('Coin flip');
  });
});
