# 01 — Design & UX

## The closed loop

```
draft ready ──► owner taps "Share on X" (intent opens, unchanged)
            └─► owner posts on X
            └─► owner taps "I posted it" on that DraftRow
                 └─► paste tweet URL ──► backend log_published(farmer_id, draft_id, url)
                                          └─► recorded; FarmerCard stats + leaderboard update
```

The log step is **opt-in and best-effort** — nothing breaks if the owner never logs.
The draft, the burn, and the share flow are all unchanged.

## What we store

A single **published-log** entry (backend stable map, MemoryId 57):

| field | type | notes |
|---|---|---|
| `id` | `u64` | monotonic seq |
| `farmer_id` | `u64` | FK to `Farmer.id` |
| `owner` | `Principal` | denormalized for leaderboard filtering by caller |
| `draft_id` | `u64` | the `XFarmDraft.id` this claim refers to |
| `tweet_url` | `String` | `https://x.com/.../status/...` — display + click-through |
| `created_at` | `u64` (ns) | for 30-day windowing |

Keyed by `id`; secondary lookups by `(farmer_id, draft_id)` (idempotency — a draft
can be logged **once**, not spammed) and by `owner` (leaderboard / "my published").

## Trust model — explicit, scoped, non-financial

**We cannot trustlessly verify the owner posted this tweet, or that the tweet is
theirs, or that the text matches the draft.** X account ownership is off-chain and
unverifiable from the IC without a paid X API outcall (see open question Q1).
So the published log is **self-attested**. We accept that and bound the blast radius:

- **Cap per draft:** one published entry per `(farmer_id, draft_id)` — idempotent
  insert; a second log for the same draft is a no-op (not an error).
- **Cap per day:** ≤ `drafts_per_day` published entries per farmer per UTC day —
  you can't claim you posted more than the farm drafted.
- **Cap per tweet_url:** one published entry per distinct URL globally — prevents
  re-logging one real tweet across many farms.
- **No payout, ever.** Leaderboard rank is the only reward. This removes the
  economic incentive to game it (the reason X-Farm's lottery/staking split exists
  elsewhere does **not** apply here — there is no split).

The leaderboard is therefore a **signal**, not a score. Copy says
"self-reported amplification" so nobody mistakes it for verified reach.

## Leaderboard ranking

`get_xfarm_leaderboard(limit: u32)` returns the top farms by **published count in
the last 30 days**, tie-broken by `burned_cycles` (real burns outrank cheap farms
that logged the same count). Each row:

```
{ rank, farmer_id, owner, tier_name, published_30d, drafted_30d, burned_cycles, persona_label }
```

- **Owner identity:** show principal (truncated) — no doxxing, no X handle.
- **Window:** 30-day rolling, recomputed on call (the log map is small; a linear
  scan + sort is fine at expected volumes). If scale ever demands it, add a
  denormalized `published_30d` counter on `Farmer` updated on `log_published` —
  but **start without it** (YAGNI; avoid an upgrade-safety field until needed).
- **Pruning:** published entries older than 30 days are pruned by the existing
  `xfarm_sweep` tick (`lib.rs:19307`) — same 30-day window the farmer-wasm uses
  for its draft archive (`prune_drafts`, `src/xfarm_farmer/src/lib.rs:431`).

## UX

### On each `DraftRow` (after "Share on X")
- Existing "Share on X" button stays.
- Add a secondary **"I posted it"** ghost button. Tapping it expands an inline
  input (tweet URL) + confirm. On confirm → `log_published` → the row shows a small
  `✓ posted` chip and the tweet URL becomes a click-through "source" link.
- If already logged, the row shows `✓ posted` + link, no input.

### On the `FarmerCard` status row
- Add `posted: 4/7 (30d)` next to `burned:` — published over drafted, 30-day
  window. Drives home "this farm turned burns into real posts."

### A leaderboard section on the X-Farm page
- Below the owner's own farms (or as a tab): a ranked list of top farms.
- The owner's own row is **always pinned** (even if off-page) so they see their
  rank: `You: #12 · 9 posted (30d)`.
- Empty state (no published logs anywhere yet): a friendly "Be the first to log a
  posted draft" line — reuses the empty-state voice from the persona gallery.

### Empty-state (no farms) gallery
- The "Why this helps" cards already on the page can grow a fifth use-case card:
  **"See your impact"** — *log a posted draft and climb the amplification
  leaderboard; watch your burns turn into real reach.* (Reuses the existing
  `PersonaGallery` use-case grid — but note the grid is currently 2×2; adding a
  third card means switching back to a responsive grid or accepting 3-up.)

## Out of scope (explicitly not doing)

- **Verified reach / impression counts** — needs X API (paid, new outcall). Q1.
- **Cross-farm text-match validation** — fetching tweet text to compare against
  the draft. Same X-API cost problem; skip for v1.
- **Any reward / payout** for posting. Never. (See trust model.)
- **Leaderboard for non-owners** to see *which* tweets — only counts + principal.
  We don't republish tweet content from the log; the URL is owner-visible only on
  their own rows, public rows show counts.