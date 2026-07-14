import { describe, it, expect } from 'vitest';
import { hashPrincipal, icp } from '../analytics';

describe('hashPrincipal', () => {
  it('is a stable 16-hex-char digest', () => {
    const p = 'vok7i-2hq5b-fdezn-oa5yp-tpvht-ioifx-mratr-liy7v-pkzb2-hydj2-5ae';
    const h = hashPrincipal(p);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashPrincipal(p)).toBe(h); // deterministic
  });
  it('never returns the raw principal', () => {
    const p = 'aaaaa-aa';
    expect(hashPrincipal(p)).not.toContain(p);
  });
  it('distinguishes different principals', () => {
    expect(hashPrincipal('aaaaa-aa')).not.toBe(hashPrincipal('bbbbb-bb'));
  });
});

describe('icp (e8s → whole-ICP Number for GA4 value)', () => {
  it('converts bigint e8s', () => {
    expect(icp(100_000_000n)).toBe(1);
    expect(icp(250_000_000n)).toBe(2.5);
    expect(icp(0n)).toBe(0);
  });
  it('accepts number e8s', () => {
    expect(icp(170_000_000)).toBe(1.7);
  });
  it('returns a plain number, never a bigint', () => {
    expect(typeof icp(100_000_000n)).toBe('number');
  });
});
