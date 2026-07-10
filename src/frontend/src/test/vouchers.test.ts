import { describe, it, expect } from 'vitest';
import {
  friendlyVoucherErr, buybackQuoteE8s, buybackAvailable, listingDeltaPct,
  promoDaysLeft, parseWrapIcp, parsePriceIcp, isPromo,
} from '../Vouchers';
import { validateClaimPrincipal } from '../ClaimPromo';

describe('friendlyVoucherErr', () => {
  it('maps every voucher endpoint code to actionable copy', () => {
    expect(friendlyVoucherErr('FEATURE_DISABLED')).toContain("aren't open");
    expect(friendlyVoucherErr('BUYBACK_UNAVAILABLE')).toContain('buyback fund');
    expect(friendlyVoucherErr('CAMPAIGN_CLOSED')).toContain("isn't open");
    expect(friendlyVoucherErr('CAMPAIGN_EXHAUSTED')).toContain('claimed');
    expect(friendlyVoucherErr('DAILY_LIMIT')).toContain('tomorrow');
    expect(friendlyVoucherErr('ALREADY_CLAIMED')).toContain('one per account');
    expect(friendlyVoucherErr('INVALID_PRINCIPAL')).toContain('principal');
    expect(friendlyVoucherErr('NOT_YOUR_VOUCHER')).toContain('current owner');
    expect(friendlyVoucherErr('VOUCHER_LISTED')).toContain('cancel the listing');
    expect(friendlyVoucherErr('PROMO_NOT_ALLOWED')).toContain('tickets only');
    expect(friendlyVoucherErr('INSUFFICIENT_STAKE')).toContain('unwrapped stake');
    expect(friendlyVoucherErr('BELOW_MINIMUM')).toContain('1 ICP');
    expect(friendlyVoucherErr('ESCROW_NOT_FUNDED')).toContain('exact');
    expect(friendlyVoucherErr('NOT_LISTED')).toContain('for sale');
    // Unknown codes pass through verbatim.
    expect(friendlyVoucherErr('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });
});

describe('buybackQuoteE8s (the 85% instant-exit math)', () => {
  it('pays principal minus the discount, floor division', () => {
    // 100 ICP at the owner-locked 15% discount → exactly 85 ICP.
    expect(buybackQuoteE8s(10_000_000_000n, 1500)).toBe(8_500_000_000n);
    // 1 ICP → 0.85 ICP.
    expect(buybackQuoteE8s(100_000_000n, 1500)).toBe(85_000_000n);
    // Odd amounts floor (never round the house's payment up).
    expect(buybackQuoteE8s(3n, 1500)).toBe(2n); // 3 * 8500 / 10000 = 2.55 → 2
  });

  it('clamps out-of-range discounts instead of over/underflowing', () => {
    expect(buybackQuoteE8s(100n, 0)).toBe(100n);       // no discount
    expect(buybackQuoteE8s(100n, 10_000)).toBe(0n);     // 100% discount
    expect(buybackQuoteE8s(100n, 20_000)).toBe(0n);     // clamped
    expect(buybackQuoteE8s(100n, -5)).toBe(100n);       // clamped
  });
});

describe('buybackAvailable (the balance gate)', () => {
  it('is available only when the fund covers the quote', () => {
    // 100 ICP voucher, 15% discount → quote 85 ICP.
    const amount = 10_000_000_000n;
    expect(buybackAvailable(amount, 1500, 8_500_000_000n)).toBe(true);   // exact
    expect(buybackAvailable(amount, 1500, 8_499_999_999n)).toBe(false);  // 1 e8s short
    expect(buybackAvailable(amount, 1500, 100_000_000_000n)).toBe(true); // plenty
    expect(buybackAvailable(amount, 1500, 0n)).toBe(false);              // empty fund
  });

  it('a zero quote is never "available"', () => {
    expect(buybackAvailable(0n, 1500, 1_000_000n)).toBe(false);
  });
});

describe('listingDeltaPct (ask vs principal)', () => {
  it('signs the delta: negative = discount for the buyer', () => {
    expect(listingDeltaPct(90_000_000n, 100_000_000n)).toBe(-10);   // 10% under
    expect(listingDeltaPct(110_000_000n, 100_000_000n)).toBe(10);   // 10% over
    expect(listingDeltaPct(100_000_000n, 100_000_000n)).toBe(0);    // at principal
    expect(listingDeltaPct(85_000_000n, 100_000_000n)).toBe(-15);   // matches buyback
  });

  it('handles a zero-amount voucher without dividing by zero', () => {
    expect(listingDeltaPct(100n, 0n)).toBe(0);
  });
});

describe('promoDaysLeft (Golden Ticket countdown)', () => {
  const now = 1_700_000_000_000; // ms
  const ns = (ms: number) => BigInt(ms) * 1_000_000n;

  it('counts whole days remaining, ceiling', () => {
    expect(promoDaysLeft(ns(now + 60 * 86_400_000), now)).toBe(60);
    expect(promoDaysLeft(ns(now + 1), now)).toBe(1);              // any future → ≥1
    expect(promoDaysLeft(ns(now + 36 * 3_600_000), now)).toBe(2); // 1.5 days → 2
  });

  it('is 0 once expired (never negative)', () => {
    expect(promoDaysLeft(ns(now), now)).toBe(0);
    expect(promoDaysLeft(ns(now - 86_400_000), now)).toBe(0);
  });
});

describe('parseWrapIcp (whole-ICP wrap amounts)', () => {
  it('accepts whole ICP and converts to e8s', () => {
    expect(parseWrapIcp('1')).toBe(100_000_000n);
    expect(parseWrapIcp('25')).toBe(2_500_000_000n);
  });

  it('rejects fractions, zero, negatives, and junk', () => {
    expect(parseWrapIcp('1.5')).toBeNull();
    expect(parseWrapIcp('0')).toBeNull();
    expect(parseWrapIcp('-3')).toBeNull();
    expect(parseWrapIcp('abc')).toBeNull();
  });
});

describe('parsePriceIcp (listing asks, up to 4 decimals)', () => {
  it('accepts fractional ICP asks', () => {
    expect(parsePriceIcp('0.9')).toBe(90_000_000n);
    expect(parsePriceIcp('12.3456')).toBe(1_234_560_000n);
    expect(parsePriceIcp('  3  ')).toBe(300_000_000n);
  });

  it('rejects zero, too many decimals, and junk', () => {
    expect(parsePriceIcp('0')).toBeNull();
    expect(parsePriceIcp('1.23456')).toBeNull();
    expect(parsePriceIcp('1,5')).toBeNull();
    expect(parsePriceIcp('')).toBeNull();
  });
});

describe('isPromo (voucher class discriminant)', () => {
  it('distinguishes the two classes', () => {
    expect(isPromo({ Promo: null })).toBe(true);
    expect(isPromo({ Backed: null })).toBe(false);
  });
});

describe('validateClaimPrincipal (paste-a-wallet claims)', () => {
  it('accepts a self-authenticating user principal (with whitespace)', () => {
    const v = validateClaimPrincipal('  a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe  ');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.principal.toText()).toBe('a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe');
  });

  it('rejects the anonymous principal', () => {
    const v = validateClaimPrincipal('2vxsx-fae');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.err).toContain('anonymous');
  });

  it('rejects canister ids (nobody can ever sign in as one)', () => {
    const v = validateClaimPrincipal('ryjl3-tyaaa-aaaaa-aaaba-cai');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.err).toContain('canister');
  });

  it('rejects empty and malformed input', () => {
    expect(validateClaimPrincipal('').ok).toBe(false);
    expect(validateClaimPrincipal('   ').ok).toBe(false);
    expect(validateClaimPrincipal('not-a-principal!!').ok).toBe(false);
    expect(validateClaimPrincipal('a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqX').ok).toBe(false);
  });
});
