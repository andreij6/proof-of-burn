import { describe, it, expect } from 'vitest';
import type { CourseCard } from '../bindings/backend';
import {
  difficultyBucket, themeLabel, mulberry32, shuffleSeeded, poolOrder,
  pageSlice, pageCount, GRID_PAGE_SIZE,
  isFavorite, applyFavoritesFilter, toggleFavoriteId,
  formatRating, tokenAmountUsdE8s, bidBeats, courseNftTokenUrl,
} from '../arcade/courseMarket';

function card(id: number, overrides: Partial<CourseCard> = {}): CourseCard {
  return {
    token_id: BigInt(id),
    name: `Course ${id}`,
    theme: 0,
    creator: undefined,
    owner: undefined,
    is_caller_owner: false,
    par_total: 30,
    play_count: 0n,
    tickets_distributed: 0n,
    price_e8s: 0n,
    listed: false,
    for_sale: false,
    created_at: 0n,
    ...overrides,
  };
}

describe('difficultyBucket', () => {
  it('Easy ≤ 27, Hard ≥ 45, Medium otherwise', () => {
    expect(difficultyBucket(18)).toBe('Easy');
    expect(difficultyBucket(27)).toBe('Easy');
    expect(difficultyBucket(28)).toBe('Medium');
    expect(difficultyBucket(44)).toBe('Medium');
    expect(difficultyBucket(45)).toBe('Hard');
    expect(difficultyBucket(60)).toBe('Hard');
  });
});

describe('themeLabel', () => {
  it('maps discriminants and falls back to Custom', () => {
    expect(themeLabel(0)).toBe('Desert');
    expect(themeLabel(3)).toBe('Forest');
    expect(themeLabel(4)).toBe('Custom');
    expect(themeLabel(99)).toBe('Custom');
  });
});

describe('shuffleSeeded', () => {
  it('is a permutation (no drops, no dupes)', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffleSeeded(arr, 12345);
    expect(out).toHaveLength(arr.length);
    expect([...out].sort((a, b) => a - b)).toEqual(arr);
  });

  it('is stable for the same seed and differs across seeds', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffleSeeded(arr, 7)).toEqual(shuffleSeeded(arr, 7));
    expect(shuffleSeeded(arr, 7)).not.toEqual(shuffleSeeded(arr, 8));
  });

  it('does not mutate the input', () => {
    const arr = [1, 2, 3, 4, 5];
    shuffleSeeded(arr, 1);
    expect(arr).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('mulberry32', () => {
  it('produces deterministic values in [0,1)', () => {
    const r = mulberry32(42);
    const vals = [r(), r(), r()];
    for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    const r2 = mulberry32(42);
    expect([r2(), r2(), r2()]).toEqual(vals);
  });
});

describe('poolOrder', () => {
  it('removes the featured token so it never appears twice', () => {
    const cards = [card(1), card(2), card(3)];
    const out = poolOrder(cards, 2n, 999);
    expect(out.map((c) => Number(c.token_id)).sort()).toEqual([1, 3]);
  });

  it('keeps all cards when there is no featured token', () => {
    const cards = [card(1), card(2), card(3)];
    expect(poolOrder(cards, undefined, 1)).toHaveLength(3);
  });
});

describe('paging', () => {
  it('pageSlice returns the right window', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(pageSlice(items, 0)).toEqual(items.slice(0, GRID_PAGE_SIZE));
    expect(pageSlice(items, 2)).toEqual(items.slice(18, 25));
  });

  it('pageCount is at least 1 and ceils', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(9)).toBe(1);
    expect(pageCount(10)).toBe(2);
    expect(pageCount(18)).toBe(2);
    expect(pageCount(19)).toBe(3);
  });
});

describe('favorites (PB-311)', () => {
  it('isFavorite matches bigint set membership by value', () => {
    const set = new Set<bigint>([1n, 5n, 9n]);
    expect(isFavorite(5n, set)).toBe(true);
    expect(isFavorite(BigInt(5), set)).toBe(true); // same value, different literal
    expect(isFavorite(2n, set)).toBe(false);
  });

  it('applyFavoritesFilter returns the full set when off, subset when on', () => {
    const cards = [card(1), card(2), card(3), card(4)];
    const favs = new Set<bigint>([2n, 4n]);
    expect(applyFavoritesFilter(cards, favs, false)).toHaveLength(4);
    const only = applyFavoritesFilter(cards, favs, true);
    expect(only.map((c) => Number(c.token_id)).sort()).toEqual([2, 4]);
  });

  it('applyFavoritesFilter never duplicates and returns a copy', () => {
    const cards = [card(1), card(2)];
    const out = applyFavoritesFilter(cards, new Set(), false);
    expect(out).not.toBe(cards);
    expect(out).toEqual(cards);
  });

  it('toggleFavoriteId flips membership and returns a new set', () => {
    const set = new Set<bigint>([1n]);
    const added = toggleFavoriteId(2n, set);
    expect(added.has(2n)).toBe(true);
    expect(set.has(2n)).toBe(false); // original untouched
    const removed = toggleFavoriteId(1n, set);
    expect(removed.has(1n)).toBe(false);
  });
});

describe('formatRating (PB-310)', () => {
  it('shows "No ratings yet" with zero count', () => {
    expect(formatRating(0, 0)).toBe('No ratings yet');
    expect(formatRating(50, 0)).toBe('No ratings yet');
  });

  it('formats avg_x10 to one decimal with count', () => {
    expect(formatRating(43, 27)).toBe('★ 4.3 (27)');
    expect(formatRating(50, 1)).toBe('★ 5.0 (1)');
    expect(formatRating(38, 12)).toBe('★ 3.8 (12)');
  });
});

describe('featured bid USD compare (PB-308)', () => {
  it('values amounts in USD across decimals', () => {
    // 0.001 ckBTC (8 dec) at $60,000/BTC = $60
    const btc = tokenAmountUsdE8s(100_000n, 60_000n * 100_000_000n, 8);
    expect(btc).toBe(60n * 100_000_000n);
    // 50 ckUSDC (6 dec) at $1 = $50
    const usdc = tokenAmountUsdE8s(50_000_000n, 1n * 100_000_000n, 6);
    expect(usdc).toBe(50n * 100_000_000n);
  });

  it('returns 0 for non-positive amount/rate', () => {
    expect(tokenAmountUsdE8s(0n, 100n, 8)).toBe(0n);
    expect(tokenAmountUsdE8s(100n, 0n, 8)).toBe(0n);
  });

  it('bidBeats is strict-exceed', () => {
    expect(bidBeats(60n * 100_000_000n, 50n * 100_000_000n)).toBe(true);
    expect(bidBeats(50n * 100_000_000n, 50n * 100_000_000n)).toBe(false); // equal loses
    expect(bidBeats(40n * 100_000_000n, 50n * 100_000_000n)).toBe(false);
  });

  it('a small ckBTC bid beats a larger ckUSDC bid in USD terms', () => {
    const btcUsd = tokenAmountUsdE8s(100_000n, 60_000n * 100_000_000n, 8); // 0.001 BTC = $60
    const usdcUsd = tokenAmountUsdE8s(50_000_000n, 1n * 100_000_000n, 6);  // 50 USDC = $50
    expect(bidBeats(btcUsd, usdcUsd)).toBe(true);
  });
});

describe('courseNftTokenUrl', () => {
  const ID = 'be2us-64aaa-aaaaa-qaabq-cai';

  it('builds the local canister-subdomain URL', () => {
    expect(courseNftTokenUrl(ID, 7n, true)).toBe(`http://${ID}.localhost:8000/token/7`);
  });

  it('builds the mainnet icp0.io URL', () => {
    expect(courseNftTokenUrl(ID, 42n, false)).toBe(`https://${ID}.icp0.io/token/42`);
  });

  it('returns null when the course_nft canister is unwired (None)', () => {
    expect(courseNftTokenUrl(undefined, 1n, false)).toBeNull();
    expect(courseNftTokenUrl(null, 1n, true)).toBeNull();
    expect(courseNftTokenUrl('', 1n, false)).toBeNull();
    expect(courseNftTokenUrl('   ', 1n, true)).toBeNull();
  });
});
