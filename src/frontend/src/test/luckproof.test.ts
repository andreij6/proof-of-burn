import { describe, it, expect } from 'vitest';
import {
  edgeBp, fmtEvBp, fmtTrack, practiceGamble, friendlyDailyErr,
  buildSeries, oddsTone, TRACK_START, SHOT_CLOCK_MS, PRACTICE_ROUNDS, type LPGamble,
} from '../arcade/LuckProof';

const g = (odds_pct: number, risk: number, reward: number): LPGamble => ({ odds_pct, risk, reward });

describe('Sklansky EV math (mirrors the backend exactly)', () => {
  it('edgeBp = P·reward − (1−P)·risk, in bp', () => {
    // 60% to win $100 profit risking $50 → +$40 (backend test twin).
    expect(edgeBp(g(60, 50, 100))).toBe(400_000);
    // 20% for $100 risking $80 → 20 − 64 = −$44.
    expect(edgeBp(g(20, 80, 100))).toBe(-440_000);
    // Break-even: 50% for $50 risking $50.
    expect(edgeBp(g(50, 50, 50))).toBe(0);
  });

  it('fmtEvBp renders signed dollars', () => {
    expect(fmtEvBp(400_000)).toBe('+$40.0');
    expect(fmtEvBp(-440_000)).toBe('−$44.0');
    expect(fmtEvBp(0)).toBe('$0.0');
    expect(fmtEvBp(123_456n)).toBe('+$12.3');
  });

  it('fmtTrack starts at $1,000 and moves with the delta', () => {
    expect(fmtTrack(TRACK_START, 0)).toBe('$1,000');
    expect(fmtTrack(TRACK_START, 400_000)).toBe('$1,040');
    expect(fmtTrack(TRACK_START, -10_500_000)).toBe('−$50');
  });
});

describe('practiceGamble (client mirror of the balanced generator)', () => {
  it('respects the demo ranges and mixes both edge signs', () => {
    // Deterministic LCG so the test never flakes.
    let seed = 42;
    const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
    let plus = 0, minus = 0;
    for (let i = 0; i < 300; i++) {
      const gam = practiceGamble(rand);
      expect(gam.risk).toBeGreaterThanOrEqual(20);
      expect(gam.risk).toBeLessThanOrEqual(100);
      expect(gam.odds_pct).toBeGreaterThanOrEqual(20);
      expect(gam.odds_pct).toBeLessThanOrEqual(80);
      expect(gam.reward).toBeGreaterThanOrEqual(1);
      if (edgeBp(gam) > 0) plus++; else minus++;
    }
    expect(plus).toBeGreaterThan(60);
    expect(minus).toBeGreaterThan(60);
  });
});

describe('buildSeries (chart data: cumulative per-hand tracks)', () => {
  it('EV moves on takes only; cash moves on resolved takes', () => {
    const gambles = [g(60, 50, 100), g(20, 80, 100), g(60, 50, 100)];
    // take(+$40, won), take(−$44, lost), decline.
    const s = buildSeries(gambles, [true, true, false], [true, false, undefined]);
    expect(s.ev).toEqual([1000, 1040, 996, 996]);
    expect(s.cash).toEqual([1000, 1100, 1020, 1020]);
  });

  it('declines never touch either track', () => {
    const s = buildSeries([g(60, 50, 100)], [false], [undefined]);
    expect(s.ev).toEqual([1000, 1000]);
    expect(s.cash).toEqual([1000, 1000]);
  });
});

describe('oddsTone (red / yellow / green bands)', () => {
  it('maps <40 red, 40–60 yellow, >60 green', () => {
    expect(oddsTone(20)).toBe('var(--ember)');
    expect(oddsTone(39)).toBe('var(--ember)');
    expect(oddsTone(40)).toBe('var(--haze-ink)');
    expect(oddsTone(60)).toBe('var(--haze-ink)');
    expect(oddsTone(61)).toBe('var(--sprout-ink)');
    expect(oddsTone(80)).toBe('var(--sprout-ink)');
  });
});

describe('session constants', () => {
  it('shot clock is 3 seconds, practice sessions are 50 hands', () => {
    expect(SHOT_CLOCK_MS).toBe(3_000);
    expect(PRACTICE_ROUNDS).toBe(50);
  });
});

describe('friendlyDailyErr', () => {
  it('maps the competition gate codes to actionable copy', () => {
    expect(friendlyDailyErr('NOT_STAKED')).toContain('stake');
    expect(friendlyDailyErr('ALREADY_PLAYED_TODAY')).toContain('00:00 UTC');
    expect(friendlyDailyErr('RUN_EXPIRED')).toContain('1-hour');
    expect(friendlyDailyErr('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });
});
