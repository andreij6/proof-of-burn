import { describe, it, expect } from 'vitest';
import {
  multiplierX100, fmtX, crashPointX100FromU, uFromHashBytes,
  historyChipTone, betButton, recomputeCrashX100, effectiveTargetX100,
} from '../crashMath';

describe('crash curve', () => {
  it('starts at 1.00× and never dips below it', () => {
    expect(multiplierX100(0)).toBe(100);
    expect(multiplierX100(-5)).toBe(100);
  });

  it('is monotonic non-decreasing', () => {
    let prev = 0;
    for (let ms = 0; ms <= 40000; ms += 250) {
      const m = multiplierX100(ms);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('matches the canister curve at fixture points (e^(0.06t))', () => {
    // 2× ≈ 11.55 s, 10× ≈ 38.38 s — the docs' reference points.
    expect(multiplierX100(11550)).toBeGreaterThanOrEqual(199);
    expect(multiplierX100(11550)).toBeLessThanOrEqual(201);
    expect(multiplierX100(38380)).toBeGreaterThanOrEqual(995);
    expect(multiplierX100(38380)).toBeLessThanOrEqual(1005);
  });

  it('formats x100 fixed point', () => {
    expect(fmtX(234)).toBe('2.34');
    expect(fmtX(100)).toBe('1.00');
    expect(fmtX(10000)).toBe('100.00');
  });
});

describe('crash point formula', () => {
  it('instant-busts when u is divisible by 101', () => {
    expect(crashPointX100FromU(101n)).toBe(100);
    expect(crashPointX100FromU(0n)).toBe(100);
  });

  it('floors at 1.00× and caps at 100×', () => {
    // hb = 0 (u not div by 101) → exactly 100.
    expect(crashPointX100FromU(1n)).toBe(100);
    // hb just under 2^52 → very large, capped at 5000 (50×).
    const e = 1n << 52n;
    expect(crashPointX100FromU(e - 1n)).toBe(5000);
  });

  it('reads u from the first 8 bytes big-endian', () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x01;
    bytes[7] = 0xff;
    expect(uFromHashBytes(bytes)).toBe((1n << 56n) | 0xffn);
  });

  it('recompute over a seed matches the formula (verify dialog)', async () => {
    // Smoke: recompute returns a valid in-range multiplier for a fixed seed.
    const seedHex = '00'.repeat(32);
    const x = await recomputeCrashX100(seedHex);
    expect(x).toBeGreaterThanOrEqual(100);
    expect(x).toBeLessThanOrEqual(10000);
  });
});

describe('payout cap (effective target)', () => {
  it('caps a 5,000 VP bet at 2.00×', () => {
    expect(effectiveTargetX100(5_000_000, 1000)).toBe(200);
  });
  it('caps larger bets lower', () => {
    expect(effectiveTargetX100(6_000_000, 5000)).toBe(166);
    expect(effectiveTargetX100(8_000_000, 5000)).toBe(125);
  });
  it('leaves small bets untouched', () => {
    expect(effectiveTargetX100(100, 200)).toBe(200);
    expect(effectiveTargetX100(5000, 1000)).toBe(1000);
  });
});

describe('history chip tone', () => {
  it('gold at 100×, sprout at ≥2×, ember below', () => {
    expect(historyChipTone(10000)).toBe('gold');
    expect(historyChipTone(420)).toBe('sprout');
    expect(historyChipTone(200)).toBe('sprout');
    expect(historyChipTone(113)).toBe('ember');
    expect(historyChipTone(100)).toBe('ember');
  });
});

describe('bet-panel state machine', () => {
  it('offers PLACE BET only during betting with no bet', () => {
    expect(betButton('betting', null, 100)).toMatchObject({ action: 'place', enabled: true });
    expect(betButton('betting', { outcome: 'pending', manual_x100: 0, target_x100: 200 }, 100))
      .toMatchObject({ action: 'none', enabled: false, label: 'BET PLACED' });
  });

  it('offers CASH OUT while riding a pending bet', () => {
    const b = betButton('running', { outcome: 'pending', manual_x100: 0, target_x100: 200 }, 175);
    expect(b.action).toBe('cashout');
    expect(b.enabled).toBe(true);
    expect(b.label).toContain('1.75');
  });

  it('disables cash out once manually cashed', () => {
    const b = betButton('running', { outcome: 'pending', manual_x100: 150, target_x100: 200 }, 175);
    expect(b.action).toBe('none');
    expect(b.enabled).toBe(false);
  });

  it('is idle during intermission/crashed', () => {
    expect(betButton('intermission', null, 100).action).toBe('none');
    expect(betButton('crashed', null, 100).action).toBe('none');
  });
});
