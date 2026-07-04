---
type: idea
title: "02 — Implementation (backend + frontend + reuse)"
tags: [ideas, x-farm-published-tracking]
timestamp: 2026-06-20T01:26:49-04:00
---

# 02 — Implementation (backend + frontend + reuse)

Line numbers approximate (2026-06-20) — verify before building. The
`backend-canister-dev` and `frontend-dev` skills cover the mechanics.

## Backend (`src/backend/src/lib.rs`)

### New struct + stable map

```rust
#[derive(CandidType, Deserialize)]
pub struct PublishedLog {
    pub id: u64,
    pub farmer_id: u64,
    pub owner: Principal,
    pub draft_id: u64,
    pub tweet_url: String,        // <= ~120 chars; validate starts_with("https://x.com/") || "https://twitter.com/"
    pub created_at: u64,           // ns
}
```

Stable map, **MemoryId 57** (free — x-farm backend uses 54/55/56; see
`03-risks-gates.md` for the free-ID table):

```rust
thread_local! {
    static XFARM_PUBLISHED: RefCell<StableBTreeMap<u64, PublishedLog, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(57)))));
    static XFARM_PUBLISHED_NEXT_ID: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(58)), 1u64)));
}
```

> `Farmer` itself (`lib.rs:86`) gets **no new field** in v1 — counts are derived
> from the log on call. If scale demands, add `published_count_30d: u64` later
> (upgrade-safe via `Option`/default). Keeps the upgrade story trivial for v1.

### Endpoints (3, all behind the existing `x_farm` flag)

```rust
// Owner-scoped — caller must own the farmer_id.
async fn log_published(farmer_id: u64, draft_id: u64, tweet_url: String)
    -> Result<PublishedLog, String>;

fn get_my_published(farmer_id: u64) -> Vec<PublishedLog>;   // owner only
fn get_xfarm_leaderboard(limit: u32) -> Vec<LeaderboardRow>; // public
```

`log_published` validation order (all return `Err` strings the frontend already
displays via `useErrorImpression`):

1. `x_farm` enabled + farmer exists + `farmer.owner == caller` (reuse the
   `require_*` / owner check already in `get_farmer_drafts` /
   `renew_farmer`).
2. URL shape: `starts_with("https://x.com/") || "https://twitter.com/"`, length
   ≤ 240. (No fetch — just shape. Real validation is Q1.)
3. **Idempotency:** reject if any existing log has the same `(farmer_id,
   draft_id)` — return the existing entry as `Ok` (idempotent, not an error) so a
   double-submit is harmless. (Linear scan of that farmer's logs; the per-farmer
   set is tiny — ≤ `drafts_per_day × 30`.)
4. **Global URL cap:** reject if the same `tweet_url` is already logged by a
   *different* `(farmer_id, draft_id)` → `"TWEET_ALREADY_LOGGED"`. (Linear scan;
   fine at expected volume. If this ever becomes hot, add a
   `tweet_url → log_id` index map.)
5. **Daily cap:** count this farmer's logs with `created_at` in today's UTC day;
   reject if ≥ its `drafts_per_day` → `"DAILY_PUBLISH_CAP"`.
6. Insert, return.

`get_xfarm_leaderboard`: scan all published logs in the 30-day window, group by
`farmer_id`, count, join to `Farmer` (for `tier_id`/`burned_cycles`/`persona`),
sort by count desc then `burned_cycles` desc, take `limit` (cap 50). Public rows
return `owner` (principal) + counts; **no tweet URLs on rows that aren't the
caller's own** (privacy — see `01` "Out of scope").

### Pruning

In `xfarm_sweep` (`lib.rs:19307`) — the existing tick that already reaps depleted
farmers — add a pass that drops published logs older than 30 days. Same window the
farmer wasm uses for drafts.

### Candid sync

Add the 3 methods + `PublishedLog` / `LeaderboardRow` records to the `.did` and
regenerate `src/frontend/src/bindings/...` (the `backend-canister-dev` skill covers
this). Types imported into `XFarm.tsx` like the existing `Farmer`/`XFarmDraft`.

## Frontend (`src/frontend/src/XFarm.tsx`)

### `DraftRow` — "I posted it" affordance
- Add local state `posted: PublishedLog | null`, a `logBusy` flag, an inline
  expandable URL input.
- On confirm → `actor.log_published(farmer.id, d.id, url)`; on `Ok` set `posted`
  and surface a `✓ posted` chip (reuse `Chip tone="ok"`).
- The existing `shareDraftOnX` is untouched; the new button sits beside it.
- Error → `useErrorImpression(err, 'xfarm_log_published')` (matches the existing
  `'xfarm_create'` / `'xfarm_generate'` impression keys).

### `FarmerCard` status row
- Fetch `get_my_published(farmer.id)` alongside the existing `get_farmer_drafts`
  call; show `posted: {n}/{drafted} (30d)` next to `burned:`. A small
  `Skeleton` while loading, same pattern as the draft list.

### Leaderboard section
- New `<Leaderboard actor={actor} mine={farmers} />` rendered on the X-Farm page
  (below the owner's farms; hidden in the no-farms empty state or shown as a
  "see who's amplifying" teaser — TBD in `01`).
- Polls `get_xfarm_leaderboard(20)` on mount; pins the caller's own row.
- Reuses `Eyebrow` + `Chip` + card grid primitives.

### Empty-state gallery tweak
- Optional fifth use-case card "See your impact" in `XFARM_USE_CASES` — but the
  grid is currently `repeat(2, 1fr)` (2×2); adding a third card requires reverting
  to `auto-fit, minmax(220px, 1fr)` or accepting a 3-up row. **Decide before
  building** — see open question Q2.

## Reuse map

| Need | Reuse | Where |
|---|---|---|
| Owner check on `farmer_id` | the guard in `get_farmer_status` / `renew_farmer` | `lib.rs:19286`, `19167` |
| Authenticated owner-scoped write (no money) | `post_idea` / `list_my_farmers` shape | `lib.rs:18934` |
| Feature flag + dark launch | `FLAG_XFARM` + `feature_visible` | `lib.rs` flag table |
| 30-day prune | `xfarm_sweep` tick | `lib.rs:19307` |
| Audit log of self-attested writes | `audit(event_type, …)` | `lib.rs` B4 |
| Share-on-X base | `shareDraftOnX` | `XFarm.tsx` |
| Error impression analytics | `useErrorImpression` | `XFarm.tsx:173` |
| UI primitives | `Btn`/`Chip`/`Eyebrow`/`Skeleton`/`Icon` | `ui.tsx` |
| Leaderboard card grid | `PersonaGallery` grid pattern | `XFarm.tsx` |

## Net-new (no precedent in the repo)

- The `PublishedLog` stable map + its 3 endpoints. That's it — everything else is
  a clone of an existing pattern.

## MemoryId budget

Backend MemoryIds in use around x-farm: 54 (farmers map), 55 (next-id), 56
(config cell). **57 + 58 are free** for the published log + its next-id cell.
Verify with `grep -nE "MemoryId::new\((57|58)\)" src/backend/src/lib.rs` before
allocating (see `03-risks-gates.md`).