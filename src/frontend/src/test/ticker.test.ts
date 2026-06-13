import { describe, it, expect } from 'vitest';
import { truncTitle, fmtUsd, closingLabel } from '../Ticker';

describe('ticker vote title', () => {
  it('truncates titles over 15 chars with an ellipsis', () => {
    expect(truncTitle('Adopt SNS-3 treasury allocation')).toBe('Adopt SNS-3 tre…');
    expect(truncTitle('Adopt SNS-3 tre')).toBe('Adopt SNS-3 tre'); // exactly 15, no ellipsis
    expect(truncTitle('Short')).toBe('Short');
  });
});

describe('ticker crypto price', () => {
  it('formats small prices with 2 decimals, large with commas', () => {
    expect(fmtUsd(501_000_000n)).toBe('$5.01'); // ICP ~$5.01
    expect(fmtUsd(9_843_200_000_000n)).toBe('$98,432'); // ckBTC
    expect(fmtUsd(0n)).toBeNull();
    expect(fmtUsd(undefined)).toBeNull();
  });
});

describe('ticker closing label', () => {
  const now = 1_000_000_000_000; // ms
  const ns = (msFromNow: number) => BigInt((now + msFromNow) * 1_000_000);
  it('labels minutes / hours, and nothing once passed', () => {
    expect(closingLabel(ns(5 * 60000), now)).toBe('closing 5m');
    expect(closingLabel(ns(30000), now)).toBe('closing <1m');
    expect(closingLabel(ns(3 * 3600_000), now)).toBe('closing 3h');
    expect(closingLabel(ns(-1000), now)).toBeNull();
  });
});
