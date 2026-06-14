import { describe, it, expect } from 'vitest';
import type { CourseCard } from '../bindings/backend';
import {
  difficultyBucket, themeLabel, mulberry32, shuffleSeeded, poolOrder,
  pageSlice, pageCount, GRID_PAGE_SIZE,
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
