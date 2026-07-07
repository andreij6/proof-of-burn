import { describe, it, expect } from 'vitest';
import { countdownShort } from '../hubLogic';

// countdownShort drives the sidebar's next-draw chip. (Its former home, the
// Dashboard hub, was removed 2026-07 — these tests moved from dashboard.test.ts.)
describe('countdownShort', () => {
  const nowMs = 1_700_000_000_000;
  const ns = (msAhead: number) => BigInt(nowMs + msAhead) * 1_000_000n;

  it('formats days+hours, hours+minutes, and bare minutes', () => {
    expect(countdownShort(ns(2 * 86_400_000 + 4 * 3_600_000), nowMs)).toBe('2d 4h');
    expect(countdownShort(ns(3 * 3_600_000 + 12 * 60_000), nowMs)).toBe('3h 12m');
    expect(countdownShort(ns(45 * 60_000), nowMs)).toBe('45m');
  });

  it('floors sub-minute remainders to 1m and nulls the past/unset', () => {
    expect(countdownShort(ns(30_000), nowMs)).toBe('1m');
    expect(countdownShort(ns(-1), nowMs)).toBeNull();
    expect(countdownShort(0n, nowMs)).toBeNull();
  });
});
