import { describe, it, expect } from 'vitest';
import { usdToTokenUnits, unitsToDecimalString, commitInsufficient, parseTokenUnits } from '../tokens';

// USD-per-whole-token rates (e8s) mirroring production get_usd_rates.
const RATE_ICP = 227_154_568n;        // ~$2.27
const RATE_CKBTC = 10_000_000_000_000n; // ~$100,000
const RATE_CKETH = 300_000_000_000n;  // ~$3,000
const RATE_STABLE = 100_000_000n;     // $1 (ckUSDC / ckUSDT)

describe('usdToTokenUnits — correct across token decimals', () => {
  it('ckUSDT/ckUSDC ($1, 6 decimals): $1 = 1.000000, $45 = 45.000000', () => {
    expect(usdToTokenUnits(1, RATE_STABLE, 6)).toBe(1_000_000n);
    expect(usdToTokenUnits(45, RATE_STABLE, 6)).toBe(45_000_000n);
  });

  it('ICP ($2.27, 8 decimals): $1 ceil-converts against the rate', () => {
    const expected = (100_000_000n * 100_000_000n + RATE_ICP - 1n) / RATE_ICP;
    expect(usdToTokenUnits(1, RATE_ICP, 8)).toBe(expected);
  });

  it('ckBTC ($100k, 8 decimals): $100 ≈ 0.001 BTC = 100_000 sats', () => {
    expect(usdToTokenUnits(100, RATE_CKBTC, 8)).toBe(100_000n);
  });

  it('ckETH ($3000, 18 decimals): $1 ≈ 1/3000 ETH, stays in wei range', () => {
    const wei = usdToTokenUnits(1, RATE_CKETH, 18)!;
    expect(wei).toBeGreaterThan(300_000_000_000_000n); // > 0.0003 ETH
    expect(wei).toBeLessThan(400_000_000_000_000n);    // < 0.0004 ETH
  });

  it('rejects non-positive amount or rate', () => {
    expect(usdToTokenUnits(0, RATE_STABLE, 6)).toBeNull();
    expect(usdToTokenUnits(-1, RATE_STABLE, 6)).toBeNull();
    expect(usdToTokenUnits(NaN, RATE_STABLE, 6)).toBeNull();
    expect(usdToTokenUnits(1, 0n, 6)).toBeNull();
  });

  it('round-trips through unitsToDecimalString + parseTokenUnits', () => {
    for (const [units, dec] of [[1_000_000n, 6], [45_000_000n, 6], [1_500_000n, 6], [100_000_000n, 8]] as [bigint, number][]) {
      const s = unitsToDecimalString(units, dec);
      expect(parseTokenUnits(s, dec)).toBe(units);
    }
    expect(unitsToDecimalString(45_000_000n, 6)).toBe('45');
    expect(unitsToDecimalString(1_500_000n, 6)).toBe('1.5');
  });
});

describe('commitInsufficient — the vote gate', () => {
  it('REGRESSION: 45 ckUSDT held but balance not yet loaded (null) is NOT insufficient', () => {
    // This was the prod bug: non-ICP balances load only when the wallet opens, so
    // on the voting page the balance was null → treated as 0 → "Not enough funds".
    const needed = usdToTokenUnits(1, RATE_STABLE, 6)!; // $1 = 1 ckUSDT
    expect(commitInsufficient(null, needed)).toBe(false);
  });

  it('known balance: insufficient only when needed exceeds it', () => {
    const held = 45_000_000n; // 45 ckUSDT
    expect(commitInsufficient(held, usdToTokenUnits(1, RATE_STABLE, 6)!)).toBe(false);   // need 1
    expect(commitInsufficient(held, usdToTokenUnits(45, RATE_STABLE, 6)!)).toBe(false);  // need exactly all
    expect(commitInsufficient(held, usdToTokenUnits(46, RATE_STABLE, 6)!)).toBe(true);   // need more
    expect(commitInsufficient(0n, 1n)).toBe(true);
  });
});
