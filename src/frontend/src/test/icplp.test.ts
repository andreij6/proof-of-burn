import { describe, it, expect } from 'vitest';
import { friendlyIcpLpErr, parsePrincipal, parsePositionId } from '../IcpLp';

describe('friendlyIcpLpErr', () => {
  it('maps every stake/unstake code to actionable copy', () => {
    expect(friendlyIcpLpErr('FEATURE_DISABLED')).toContain("isn't open");
    expect(friendlyIcpLpErr('POOL_NOT_CONFIGURED')).toContain('pool');
    expect(friendlyIcpLpErr('POSITION_NOT_TRANSFERRED')).toContain('Transfer Position');
    expect(friendlyIcpLpErr('POSITION_ALREADY_STAKED')).toContain('already registered');
    expect(friendlyIcpLpErr('NOT_YOUR_POSITION')).toContain('staked this position');
    // Unknown codes read as the shared plain-English fallback (owner 2026-07-14);
    // the raw code still lands in the error log.
    expect(friendlyIcpLpErr('SOMETHING_ELSE')).toBe('Something went wrong. Please try again.');
  });
});

describe('parsePrincipal', () => {
  it('parses valid principals (with surrounding whitespace)', () => {
    expect(parsePrincipal('aaaaa-aa')?.toString()).toBe('aaaaa-aa');
    expect(parsePrincipal('  ryjl3-tyaaa-aaaaa-aaaba-cai  ')?.toString()).toBe('ryjl3-tyaaa-aaaaa-aaaba-cai');
  });

  it('returns null for empty or invalid text', () => {
    expect(parsePrincipal('')).toBeNull();
    expect(parsePrincipal('   ')).toBeNull();
    expect(parsePrincipal('not-a-principal!!')).toBeNull();
    expect(parsePrincipal('ryjl3-tyaaa-aaaaa-aaaba-caX')).toBeNull();
  });
});

describe('parsePositionId', () => {
  it('parses non-negative integers (with whitespace) as bigint', () => {
    expect(parsePositionId('0')).toBe(0n);
    expect(parsePositionId(' 42 ')).toBe(42n);
    expect(parsePositionId('123456789012345678901')).toBe(123456789012345678901n);
  });

  it('rejects empties, negatives, decimals, and junk', () => {
    expect(parsePositionId('')).toBeNull();
    expect(parsePositionId('-1')).toBeNull();
    expect(parsePositionId('1.5')).toBeNull();
    expect(parsePositionId('42abc')).toBeNull();
    expect(parsePositionId('abc')).toBeNull();
  });
});
