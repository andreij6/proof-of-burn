// ==========================================
// Course marketplace — pure logic (PB-305 frontend).
//
// Extracted per the frontend-dev "pull pure logic out of the component" rule so
// the shuffle, difficulty bucketing, theme labels, and the featured-exclusion
// are unit-testable without React. The marketplace page (CourseMarketplace.tsx)
// is a thin shell over these.
// ==========================================

import type { CourseCard } from '../bindings/backend';
import { DifficultyFilter, ListedFilter } from '../bindings/backend';

// ── Difficulty buckets (Easy ≤ 27 · Medium 28–44 · Hard ≥ 45), derived from
//    par_total exactly as the editor/marketplace specs define them. ──
export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export function difficultyBucket(parTotal: number): Difficulty {
  if (parTotal <= 27) return 'Easy';
  if (parTotal >= 45) return 'Hard';
  return 'Medium';
}

// ── Theme discriminant (0..=4) → label. Custom = 4. Mirrors the CourseDataV1
//    Theme enum order in courseData.ts. ──
export const THEME_LABELS = ['Desert', 'Ocean', 'Space', 'Forest', 'Custom'] as const;

export function themeLabel(theme: number): string {
  return THEME_LABELS[theme] ?? 'Custom';
}

// ── A seeded PRNG (mulberry32) so a page's shuffle is reproducible within a
//    render but re-rolls when the seed changes (PB-305 A5). ──
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of a copy of `arr` using the seeded PRNG. Pure. */
export function shuffleSeeded<T>(arr: readonly T[], seed: number): T[] {
  const out = arr.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Remove the featured token from the pool (so it never appears twice — it is
 * rendered separately in the pinned slot) and shuffle the rest with the seed.
 */
export function poolOrder(
  courses: readonly CourseCard[],
  featuredTokenId: bigint | undefined,
  seed: number,
): CourseCard[] {
  const pool = featuredTokenId === undefined
    ? courses
    : courses.filter((c) => c.token_id !== featuredTokenId);
  return shuffleSeeded(pool, seed);
}

/** Slice a pool into a page (0-based) of `pageSize` cards. */
export const GRID_PAGE_SIZE = 9;
export function pageSlice<T>(items: readonly T[], page: number, pageSize = GRID_PAGE_SIZE): T[] {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCount(total: number, pageSize = GRID_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// ── Filter-UI option lists (the page maps these into MarketplaceFilter). ──
export const DIFFICULTY_OPTIONS: { value: DifficultyFilter; label: string }[] = [
  { value: DifficultyFilter.Any, label: 'Any' },
  { value: DifficultyFilter.Easy, label: 'Easy' },
  { value: DifficultyFilter.Medium, label: 'Medium' },
  { value: DifficultyFilter.Hard, label: 'Hard' },
];

export const LISTED_OPTIONS: { value: ListedFilter; label: string }[] = [
  { value: ListedFilter.Any, label: 'Any' },
  { value: ListedFilter.Yes, label: 'For sale' },
  { value: ListedFilter.No, label: 'Not listed' },
];

// theme filter: undefined = Any, 0..=4 selects a theme.
export const THEME_OPTIONS: { value: number | undefined; label: string }[] = [
  { value: undefined, label: 'Any' },
  { value: 0, label: 'Desert' },
  { value: 1, label: 'Ocean' },
  { value: 2, label: 'Space' },
  { value: 3, label: 'Forest' },
  { value: 4, label: 'Custom' },
];

/** A fresh page-load seed (used by the page; not pure, so kept tiny). */
export function freshSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
