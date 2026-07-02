// ==========================================
// Course marketplace — pure logic (PB-305 frontend).
//
// Extracted per the frontend-dev "pull pure logic out of the component" rule so
// the shuffle, difficulty bucketing, and the featured-exclusion are
// unit-testable without React. The marketplace page (CourseMarketplace.tsx)
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

/** A fresh page-load seed (used by the page; not pure, so kept tiny). */
export function freshSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

// ── Favorites (PB-311) — pure helpers. The page reads my_favorite_ids() into a
//    Set<bigint> once and derives heart state + the Favorites filter from it. ──

/** True when this card is in the caller's favorites set (bigint membership). */
export function isFavorite(tokenId: bigint, favoriteIds: ReadonlySet<bigint>): boolean {
  return favoriteIds.has(tokenId);
}

/**
 * Apply the "Only favorites" filter. When `onlyFavs` is false, returns the input
 * unchanged; otherwise narrows to cards whose token_id is in `favoriteIds`.
 */
export function applyFavoritesFilter(
  cards: readonly CourseCard[],
  favoriteIds: ReadonlySet<bigint>,
  onlyFavs: boolean,
): CourseCard[] {
  if (!onlyFavs) return cards.slice();
  return cards.filter((c) => favoriteIds.has(c.token_id));
}

/** Optimistically flip a token in a favorites set, returning a NEW set. */
export function toggleFavoriteId(tokenId: bigint, favoriteIds: ReadonlySet<bigint>): Set<bigint> {
  const next = new Set(favoriteIds);
  if (next.has(tokenId)) next.delete(tokenId); else next.add(tokenId);
  return next;
}

// ── Ratings (PB-310) — pure formatting. The card aggregate is "★ 4.3 (27)" or
//    "No ratings yet"; avg comes from avg_x10 (avg×10, integer). ──

/** Format a rating aggregate for a card/detail header. */
export function formatRating(avgX10: number, count: number): string {
  if (count <= 0) return 'No ratings yet';
  return `★ ${(avgX10 / 10).toFixed(1)} (${count})`;
}

// ── Featured slot (PB-308) — pure USD compare. A bid wins iff its USD value
//    strictly exceeds the current holder's. amount→USD uses an e8s rate per
//    whole token and the token's decimals (mirrors the backend valuation). ──

/** USD value (e8s) of `amount` smallest-units at `rateUsdE8s` per whole token. */
export function tokenAmountUsdE8s(amount: bigint, rateUsdE8s: bigint, decimals: number): bigint {
  if (amount <= 0n || rateUsdE8s <= 0n) return 0n;
  const scale = 10n ** BigInt(decimals);
  return (amount * rateUsdE8s) / scale;
}

/** True iff a fresh bid's USD value strictly beats the current "to beat" USD. */
export function bidBeats(bidUsdE8s: bigint, toBeatUsdE8s: bigint): boolean {
  return bidUsdE8s > toBeatUsdE8s;
}

// ── "View NFT ↗" link (PB-3xx) — the course_nft canister serves per-token
//    metadata at `/token/<id>` over the gateway. We build the canister-subdomain
//    URL from the wired course_nft canister id and the environment, mirroring how
//    the app distinguishes local vs mainnet elsewhere (App.tsx `isLocal`).
//    course_nft certifies these responses (IC Response Verification v2, §11 of
//    its lib.rs), so the link uses the NORMAL gateway domain (no `.raw.` needed):
//      local:   http://<id>.localhost:8000/token/<id>
//      mainnet: https://<id>.icp0.io/token/<id>
//    Returns null when the course_nft canister is unwired (`opt principal` = None)
//    so the caller hides the link instead of rendering a dead anchor. ──

/**
 * Build the course_nft per-token metadata URL, or null if the canister is
 * unwired. `courseNftCanisterId` is the decoded `Config.course_nft_canister`
 * (undefined ⇒ None ⇒ no link).
 */
export function courseNftTokenUrl(
  courseNftCanisterId: string | undefined | null,
  tokenId: bigint,
  isLocal: boolean,
): string | null {
  const id = courseNftCanisterId?.trim();
  if (!id) return null;
  return isLocal
    ? `http://${id}.localhost:8000/token/${tokenId}`
    : `https://${id}.icp0.io/token/${tokenId}`;
}
