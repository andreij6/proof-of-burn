import { describe, it, expect } from 'vitest';
import { Principal } from '@icp-sdk/core/principal';
import { parseTokenAmount, fmtTokenAmount, ideaDaysLeft, tokenMeta, sortIdeas, goalPct } from '../IdeaBoard';
import { IdeaToken } from '../bindings/backend';
import type { Idea, IdeaBoardInfo } from '../bindings/backend';

const ICP_LEDGER = Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai');
const CKBTC_LEDGER = Principal.fromText('mxzaz-hqaaa-aaaar-qaada-cai');
const CKETH_LEDGER = Principal.fromText('ss2fx-dyaaa-aaaar-qacoq-cai');

function fakeInfo(overrides: Partial<IdeaBoardInfo> = {}): IdeaBoardInfo {
  return {
    enabled: true,
    icp_ledger: ICP_LEDGER,
    ckbtc_ledger: CKBTC_LEDGER,
    cketh_ledger: CKETH_LEDGER,
    min_upvote_icp_e8s: 20_000_000n,
    min_upvote_ckbtc_e8s: 1_000n,
    min_upvote_cketh_wei: 330_000_000_000_000n,
    fee_icp_e8s: 10_000n,
    fee_ckbtc_sats: 10n,
    fee_cketh_wei: 2_000_000_000_000n,
    expiry_nanos: 2_592_000_000_000_000n,
    post_fee_e8s: 100_000_000n,
    ...overrides,
  };
}

function fakeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 1n,
    poster: ICP_LEDGER,
    title: 't',
    description: 'd',
    detail: '',
    created_at: 1_000n,
    last_upvote_at: 1_000n,
    upvote_count: 0n,
    views: 0n,
    total_icp_e8s: 0n,
    total_ckbtc_e8s: 0n,
    total_cketh_wei: 0n,
    ...overrides,
  };
}

describe('parseTokenAmount', () => {
  it('parses whole and fractional amounts into smallest units', () => {
    expect(parseTokenAmount('1', 8)).toBe(100_000_000n);
    expect(parseTokenAmount('0.01', 8)).toBe(1_000_000n);
    expect(parseTokenAmount('12.5', 8)).toBe(1_250_000_000n);
    expect(parseTokenAmount('0.0001', 18)).toBe(100_000_000_000_000n);
  });

  it('rejects malformed input instead of rounding', () => {
    expect(parseTokenAmount('', 8)).toBeNull();
    expect(parseTokenAmount('abc', 8)).toBeNull();
    expect(parseTokenAmount('-1', 8)).toBeNull();
    expect(parseTokenAmount('1.2.3', 8)).toBeNull();
    expect(parseTokenAmount('1e3', 8)).toBeNull();
    // more precision than the token supports
    expect(parseTokenAmount('0.000000001', 8)).toBeNull();
  });

  it('round-trips with fmtTokenAmount', () => {
    const units = parseTokenAmount('3.14', 8)!;
    expect(fmtTokenAmount(units, 8)).toBe('3.14');
  });
});

describe('fmtTokenAmount', () => {
  it('trims trailing zeros and groups thousands', () => {
    expect(fmtTokenAmount(100_000_000n, 8)).toBe('1');
    expect(fmtTokenAmount(125_000_000n, 8)).toBe('1.25');
    expect(fmtTokenAmount(123_456_700_000_000n, 8)).toBe('1,234,567');
    expect(fmtTokenAmount(0n, 8)).toBe('0');
  });
});

describe('ideaDaysLeft', () => {
  const DAY_NS = 86_400_000_000_000n;
  const EXPIRY = 30n * DAY_NS;

  it('counts down whole days until deletion', () => {
    const lastUpvoteNs = 1_700_000_000_000n * 1_000_000n; // epoch ms → ns
    const nowMs = 1_700_000_000_000;
    expect(ideaDaysLeft(lastUpvoteNs, EXPIRY, nowMs)).toBe(30);
    expect(ideaDaysLeft(lastUpvoteNs, EXPIRY, nowMs + 29 * 86_400_000)).toBe(1);
    expect(ideaDaysLeft(lastUpvoteNs, EXPIRY, nowMs + 31 * 86_400_000)).toBe(0);
  });
});

describe('tokenMeta', () => {
  it('uses per-token economics from the board info', () => {
    const info = fakeInfo();
    expect(tokenMeta(IdeaToken.ICP, info).decimals).toBe(8);
    expect(tokenMeta(IdeaToken.CkBTC, info).fee).toBe(10n);
    expect(tokenMeta(IdeaToken.CkETH, info).decimals).toBe(18);
    expect(tokenMeta(IdeaToken.CkBTC, info).min).toBe(1_000n);
    expect(tokenMeta(IdeaToken.CkBTC, info).onIcpFallback).toBe(false);
  });

  it('exchange-rate alignment: minimums differ per token', () => {
    const info = fakeInfo();
    const minIcp = tokenMeta(IdeaToken.ICP, info).min;
    const minBtc = tokenMeta(IdeaToken.CkBTC, info).min;
    expect(minBtc).toBeLessThan(minIcp); // a sat is worth far more than an e8
  });

  it('falls back to ICP-ledger economics when a token resolves to it', () => {
    const info = fakeInfo({ ckbtc_ledger: ICP_LEDGER, fee_ckbtc_sats: 10_000n });
    const m = tokenMeta(IdeaToken.CkBTC, info);
    expect(m.onIcpFallback).toBe(true);
    expect(m.decimals).toBe(8);
    expect(m.fee).toBe(10_000n);
  });
});

describe('sortIdeas', () => {
  const a = fakeIdea({ id: 1n, created_at: 100n, upvote_count: 5n, views: 1n });
  const b = fakeIdea({ id: 2n, created_at: 200n, upvote_count: 2n, views: 9n });
  const c = fakeIdea({ id: 3n, created_at: 300n, upvote_count: 5n, views: 4n });

  it('newest first by default', () => {
    expect(sortIdeas([a, b, c], 'newest').map(i => i.id)).toEqual([3n, 2n, 1n]);
  });
  it('most votes, ties broken by recency', () => {
    expect(sortIdeas([a, b, c], 'votes').map(i => i.id)).toEqual([3n, 1n, 2n]);
  });
  it('most viewed', () => {
    expect(sortIdeas([a, b, c], 'views').map(i => i.id)).toEqual([2n, 3n, 1n]);
  });
});

describe('goalPct', () => {
  it('caps at 100 and handles zero goals', () => {
    expect(goalPct(50n, 100n)).toBe(50);
    expect(goalPct(150n, 100n)).toBe(100);
    expect(goalPct(0n, 100n)).toBe(0);
    expect(goalPct(10n, 0n)).toBe(0);
  });
});
