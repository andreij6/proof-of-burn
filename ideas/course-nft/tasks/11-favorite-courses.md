# Favorite Courses (PB-311)

> Phase 2. A private, per-user "favorites" layer on top of the Course
> Marketplace: a heart toggle on every course card plus a **Favorites** filter
> (and a compact quick-replay surface) so a user jumps straight to the courses
> they like and hits **Play**. Favorites are convenience metadata only — they do
> **not** affect tickets, listings, ownership, or any economics.
>
> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md)
> first — this spec assumes its decisions (D1–D4), the shared `course_data`
> schema, the MemoryId table (**MemoryId 87 = `FAVORITE_COURSES`** is already
> allocated to this spec), and the repo conventions (§6). It plugs into the
> shipped [`05-marketplace.md`](05-marketplace.md) (PB-305) surface — the
> `COURSE_LISTINGS` cache, `CourseCard` shape, `list_marketplace_courses` query,
> and `CourseMarketplace.tsx`.
>
> **Depends on:** PB-305 (the marketplace it extends — `COURSE_LISTINGS`,
> `CourseCard`, `listing_to_card`, `CourseMarketplace.tsx`).
> **Independent of:** PB-307 (buy), PB-308 (featured), PB-306 (play/tickets) — a
> favorite never touches any of their state.

---

## Part A — Design / UX

### A1. Why this exists

A player who finds a course they enjoy currently has to re-find it in a randomly
ordered, paginated grid every session (the marketplace re-shuffles on every page
load by design — PB-305 A5). Favorites give a stable, personal shortlist that
survives the shuffle and survives sign-out/sign-in, so "play the one I liked
again" is one click, not a hunt. This is the natural Phase-2 retention companion
to the secondary market (PB-307): people replay what they like, those courses
accrue plays/tickets, and that track record is what buyers price against.

### A2. Where it lives

Two touch points, both inside the existing marketplace page
(`CourseMarketplace.tsx`, the arcade mini-golf surface — PB-305 A1). No new
route, no new nav entry.

1. **Heart toggle on every course card** (pool cards and the pinned featured
   card — they render through the same `CourseCardView`, PB-305 A4). A small
   `heart` icon button in the card's top row, next to the status chip. Filled =
   favorited, outline = not. Tapping it toggles.
2. **A "Favorites" filter** in the existing filter bar (A4) — a pill that
   narrows the grid to the caller's favorited courses.
3. **A compact "quick replay" strip** (A5) at the top of the page (above the
   featured slot) that shows up to ~6 of the caller's favorites as tiny
   play-now chips — the fast path described in the feature brief.

The heart, the filter, and the quick-replay strip are **Tier 2+ (signed-in)
only**. Anonymous users see the heart **disabled** with a sign-in nudge and do
not see the Favorites filter pill or the quick-replay strip (A6).

### A3. The heart toggle (card)

- Position: card top row, right of the `Featured`/`For sale`/`Not for sale`
  status chip, left of the par/difficulty label — reuse the existing `Icon`
  primitive (`heart`) inside a small ghost `Btn`.
- States:
  - **Signed in, not favorited** → outline heart, tooltip "Add to favorites".
  - **Signed in, favorited** → filled heart (burn/ember tone), tooltip "Remove
    from favorites".
  - **Anonymous** → disabled outline heart, tooltip "Sign in to save favorites";
    click routes to `onSignIn` (same pattern as the Play button's
    "Sign in to play").
- **Optimistic + reconcile:** clicking flips the icon immediately, then calls
  `toggle_favorite_course(token_id)`. The call returns the **new** boolean state
  (`Ok(true)` = now favorited, `Ok(false)` = now removed). The UI reconciles to
  that authoritative value on the `{ __kind__ }` result; on `Err` (e.g. the
  token was burned, or the per-user cap is full) it rolls the icon back and shows
  the error inline/as a toast (A6).
- Idempotence is server-side: toggling is a pure flip, so a double-tap that races
  ends on whatever the last reconciled result says — no drift.

### A4. The Favorites filter

Add one pill to the existing filter row (PB-305 A3), alongside Difficulty /
Theme / Listed:

| Filter | Control | Options |
|---|---|---|
| **Favorites** | pill toggle | Off (all) · **Only favorites** |

When **Only favorites** is on, the grid shows just the caller's favorited
courses. Because favorites are stored as an explicit id list, this can resolve
through `list_my_favorite_courses` (B5) — a dedicated, already-filtered read —
rather than over-fetching the full marketplace and filtering client-side. The
filter:

- is hidden/disabled for anonymous users (A6);
- resets the pager to page 0 and **re-rolls** the random shuffle on change, like
  every other filter (PB-305 A3) — favorites are still shuffled within the
  favorites set for visual consistency;
- composes with the other filters where practical (difficulty/theme/listed can
  further narrow the favorites set client-side after the favorites read; the
  decision is to fetch favorites then apply the remaining pills in memory, since
  the favorites set is capped small — A8).

### A5. Quick-replay strip (the fast path)

A thin strip at the very top of the page (above the featured slot), shown only
when signed in and the caller has ≥1 favorite:

- Eyebrow-style label "Your favorites" + a small `heart` icon.
- Up to 6 compact chips, each = course name (truncated) + a `flame`/`flag`
  "Play" affordance. Clicking a chip's Play calls the same `onPlay(card)` path as
  a full card (loads `course_data`, opens a session — PB-306). An "X" on each
  chip un-favorites it (same `toggle_favorite_course` call).
- A trailing "See all (N)" link that flips the **Favorites** filter on (A4).
- Sourced from `list_my_favorite_courses` (B5), so deleted/burned tokens are
  already skipped — a favorited course that no longer exists simply doesn't show.

This is the "jump straight to a favorited course and hit Play" surface from the
brief; it is purely additive and degrades to nothing when there are no
favorites.

### A6. Auth gating + anonymous nudge

- All three surfaces require **Tier 2+ / signed-in**. The product rule is
  "favoriting is a signed-in convenience"; the backend enforces
  `require_authenticated` (B4) so even a crafted call from an anonymous principal
  is rejected.
- Anonymous users: heart rendered **disabled** with tooltip "Sign in to save
  favorites" and an `onSignIn` click; Favorites filter pill and quick-replay
  strip not rendered. This mirrors how PB-305 disables ticket-earning surfaces
  for anonymous users (browse/play-for-fun stays open; favoriting does not).
- Favorites are **private per user** — there is no query that returns another
  principal's favorites, no aggregate "N people favorited this" count, and no
  field on the public `CourseCard`. Privacy is structural (point-access map keyed
  by the caller's principal — B1).

### A7. Persistence + scope

- Favorites **persist across sessions** because they live in a backend stable
  structure (`FAVORITE_COURSES`, MemoryId 87 — B1), not in `localStorage`. Sign
  in on another device and your favorites are there.
- Favoriting is **per token_id** (the NFT), not per creator or per
  `course_data`. If a favorited course is later sold (PB-307) it stays in your
  list and you can still replay it; if it is burned/deleted it is silently
  skipped in reads (B5) and can be toggled back off to tidy the list.

### A8. Acceptance criteria (UX)

- Every course card (pool + featured) shows a heart that reflects the caller's
  current favorite state and toggles it optimistically, reconciling to the
  returned boolean.
- Anonymous users see a disabled heart with a sign-in nudge; no Favorites filter
  pill; no quick-replay strip.
- The Favorites filter narrows the grid to the caller's favorites; toggling it
  re-rolls the shuffle and resets paging.
- The quick-replay strip appears only when signed in with ≥1 favorite, lets the
  user Play or un-favorite directly, and never shows a deleted course.
- Favorites survive a full reload / re-login (server-side persistence).
- Nothing about favoriting changes plays, tickets, listings, price, or
  ownership.

---

## Part B — Implementation

All backend work lands in `src/backend/src/lib.rs` under the existing
`// ===== 20. Course NFT marketplace =====` banner (a small `// ── Favorites
(PB-311) ──` sub-section next to the listing read surface). Candid in
`src/backend/backend.did` is hand-maintained and updated in lockstep; bindings
regenerate from the `.did`.

### B1. Stable state — `FAVORITE_COURSES` (MemoryId 87)

```rust
const MAX_FAVORITE_COURSES: usize = 200; // per-user cap (overview §5)

/// Private, per-user favorites list. Point-access ONLY (get/insert/remove by
/// the caller's Principal) — never range-scanned. Therefore the default
/// `impl_storable!` CBOR codec is correct and sufficient; this map needs NO
/// custom `Storable`/`Bound` impl. (Contrast the range-scanned composite keys
/// in this feature — DayCapKey/PairCapKey/CommitmentKey — which DO need an
/// order-preserving custom encoding because they are iterated by prefix. A
/// principal->blob point map has no such requirement, see review item C2.)
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct FavoriteList {
    #[serde(default)]
    pub ids: Vec<u64>,
}
impl_storable!(FavoriteList);

thread_local! {
    static FAVORITE_COURSES: RefCell<StableBTreeMap<Principal, FavoriteList, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableBTreeMap::init(mm.borrow().get(MemoryId::new(87)))));
}
```

Invariants maintained on every mutation:
- **De-duped**: `ids` never contains the same `token_id` twice (a toggle that
  would re-add is a no-op add; the toggle semantics make this naturally true, but
  the add path also guards with `contains`).
- **Capped**: adding when `ids.len() >= MAX_FAVORITE_COURSES` returns
  `Err("FAVORITES_FULL")` — the toggle does not silently drop the oldest.
- Stored as a single `Vec<u64>` per principal: bounded by the cap (≤ 200 × 8
  bytes ≈ 1.6 KB), so read/insert is cheap and well under message limits.
- An empty list (last favorite removed) **removes the principal's row** rather
  than storing an empty `FavoriteList`, to keep the map tidy.

### B2. Toggle

```rust
#[ic_cdk::update(guard = "require_authenticated")]
async fn toggle_favorite_course(token_id: u64) -> Result<bool, String> {
    require_arcade_game_enabled(ARCADE_GAME_MINIGOLF)?;
    let caller = get_caller();

    // Favoriting a non-existent token errors (cannot favorite what isn't there).
    // The marketplace cache is the cheap source of truth that a token was minted;
    // verify it resolves to a live listing row (mint seeds it — PB-304). A row
    // whose token was burned is reconciled away by PB-307/refresh; treat a
    // missing row as NONEXISTENT.
    let exists = COURSE_LISTINGS.with(|m| m.borrow().contains_key(&token_id));
    if !exists {
        return Err("COURSE_NOT_FOUND".to_string());
    }

    FAVORITE_COURSES.with(|m| {
        let mut map = m.borrow_mut();
        let mut list = map.get(&caller).unwrap_or_default();
        if let Some(pos) = list.ids.iter().position(|&id| id == token_id) {
            list.ids.remove(pos);
            if list.ids.is_empty() {
                map.remove(&caller);
            } else {
                map.insert(caller, list);
            }
            Ok(false) // removed -> now NOT a favorite
        } else {
            if list.ids.len() >= MAX_FAVORITE_COURSES {
                return Err("FAVORITES_FULL".to_string());
            }
            list.ids.push(token_id); // de-dup guaranteed by the position() miss above
            map.insert(caller, list);
            Ok(true) // added -> now a favorite
        }
    })
}
```

Notes:
- Returns the **new** state (`true` = now favorited, `false` = now removed) so
  the frontend can reconcile its optimistic flip without a follow-up read.
- This is an `async fn` only for forward-compatibility with an
  `icrc7_owner_of`-style existence check; the chosen existence check is the cheap
  in-memory `COURSE_LISTINGS` lookup (no cross-canister call, no cycles), so it
  could be a sync `update`. **Decision: keep it a sync `update`** (no `await`) —
  the listing cache is authoritative-enough for "was this ever minted", matching
  how `start_play_session` (PB-306) gates on the cache without a cross-canister
  read. (Drop the `async` from the signature above; shown for contrast.)
- Guard: `require_authenticated` (overview §6 — every mutating endpoint) plus the
  arcade-game flag gate the rest of the surface already uses.

### B3. Query: is_favorite

```rust
#[ic_cdk::query]
fn is_favorite(token_id: u64) -> bool {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        return false; // anonymous never has favorites
    }
    FAVORITE_COURSES.with(|m| {
        m.borrow()
            .get(&caller)
            .map(|l| l.ids.contains(&token_id))
            .unwrap_or(false)
    })
}
```

A query (cheap, point-access). Used for a single-card deep link / detail modal;
the grid does not call it per-card — instead it reads the whole list once via
`list_my_favorite_courses` (B5) or a small `my_favorite_ids` helper and computes
the heart state locally (B7), avoiding N queries.

### B4. Query: list_my_favorite_courses

```rust
#[ic_cdk::query]
fn list_my_favorite_courses() -> Vec<CourseCard> {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        return vec![];
    }
    let ids = FAVORITE_COURSES.with(|m| {
        m.borrow().get(&caller).map(|l| l.ids.clone()).unwrap_or_default()
    });
    COURSE_LISTINGS.with(|m| {
        let map = m.borrow();
        ids.iter()
            .filter_map(|id| map.get(id))               // skip burned/missing tokens
            .map(|l| listing_to_card(&l, caller))       // reuse PB-305 card builder
            .collect()
    })
}
```

- Resolves each favorited `token_id` through `COURSE_LISTINGS` (the same cache
  the marketplace renders from — PB-305 B1) and reuses `listing_to_card`
  (PB-305) so favorites cards are byte-identical to marketplace cards (same
  name/price/owner/`is_caller_owner`/etc.).
- **Skips ids whose listing row is gone** (burned/deleted), so a stale id never
  produces a broken card. The id stays in the user's list until they toggle it
  off; reads just omit it. (Optional tidy: a future `prune_favorites` could drop
  dead ids, but it is out of scope — reads are already safe.)
- Preserves the user's add order; the frontend shuffles for display if it wants
  visual parity with the main grid (A4).
- Also expose a thin `my_favorite_ids() -> vec nat64` so the grid can mark heart
  state across the *current page* of marketplace cards in one read without
  resolving full cards.

### B5. Candid (`backend.did`) additions

`FavoriteList` is internal (not exposed). Reuse the existing `CourseCard` record
(exposed by PB-305) and the `Result` alias. Add a `nat`-result variant for the
boolean toggle (use the repo's existing `Result_*` naming convention — a
`variant { Ok : bool; Err : text }`, named e.g. `ResultBool` if not already
present):

```
toggle_favorite_course : (nat64) -> (ResultBool);
is_favorite            : (nat64) -> (bool) query;
list_my_favorite_courses : ()   -> (vec CourseCard) query;
my_favorite_ids        : ()     -> (vec nat64) query;
```

If a `variant { Ok : bool; Err : text }` alias does not already exist in
`backend.did`, add it next to the existing `Result` aliases and keep the naming
consistent with the file's convention.

### B6. Upgrade safety

- New stable structure at a **fresh, never-reused** MemoryId (**87**; 86 is `SYSTEM_COURSE_MINTED`/PB-309, pre-allocated
  in overview §5). No existing map's id is touched.
- `FavoriteList.ids` carries `#[serde(default)]` so a future field added to the
  struct deserializes old rows (overview §6). No migration needed; an absent row
  simply means "no favorites".

### B7. Frontend

- **`src/frontend/src/CourseMarketplace.tsx`** (extend the shipped page):
  - On load (signed in), read `my_favorite_ids()` once into a `Set<bigint>`
    (`favoriteIds`) used to render each card's heart state; the Favorites filter
    path instead calls `list_my_favorite_courses()`.
  - Add the heart to `CourseCardView`: a small ghost `Btn` with the `heart`
    `Icon` (reuse `ui.tsx` primitives — `Icon`, `Btn`, `Chip` — overview §6),
    filled when `favoriteIds.has(card.token_id)`. Disabled + `onSignIn` for
    anonymous (mirror the existing "Sign in to play" pattern already in
    `CourseCardView`).
  - `onToggleFavorite(card)`: optimistically flip the id in `favoriteIds`, call
    `actor.toggle_favorite_course(card.token_id)`, and on the `{ __kind__ }`
    result reconcile to `res.Ok` (the authoritative new boolean) or roll back +
    surface `res.Err` on `'Err'` (same error-handling shape as `ManageModal`'s
    list/delist).
  - Add the **Favorites** filter pill to the filter bar (signed-in only),
    re-rolling the seed + resetting paging on change like the existing pills.
  - Add the **quick-replay strip** (A5) above the featured slot, signed-in +
    ≥1 favorite only, fed by `list_my_favorite_courses()`; Play wires to the
    existing `onPlay`, the "X" calls `onToggleFavorite`.
- **Shared pure logic** goes in the existing
  `src/frontend/src/arcade/courseMarket.ts` (where `difficultyBucket`,
  `mulberry32`, `shuffleSeeded`, `poolOrder`, `pageSlice` already live and are
  unit-tested): add a pure `applyFavoritesFilter(cards, favoriteIds, onlyFavs)`
  (and/or `markFavorites`) helper so the favorites narrowing is testable without
  React (B9).
- Reads decode candid opts via the `{ __kind__ }` wrapper and treat
  `nat64`/`nat` as `bigint` (overview §6 / frontend-dev skill).
- Persistence is entirely server-side; no `localStorage`.

### B8. Acceptance criteria (impl)

- `cargo test -p backend --lib` green; new unit tests (B9).
- `cd src/frontend && npx tsc -b && npx vitest run` green; new pure-logic test
  for the favorites filter (B9).
- `bash scripts/deploy-local.sh` then manual: mint/list a course (PB-304/305),
  favorite it (heart fills), reload → heart still filled, Favorites filter shows
  it, quick-replay Play launches it, un-favorite removes it everywhere.

### B9. Test plan

**Unit (backend, native, in the existing `// ===== 20. ... tests =====` block,
reusing `course_test_setup()`, `set_caller`/`TEST_MOCK_CALLER`, and a seeded
`COURSE_LISTINGS` row):**
- **Toggle on/off idempotence:** `toggle_favorite_course(t)` → `Ok(true)`;
  again → `Ok(false)`; again → `Ok(true)` — state strictly alternates and
  `is_favorite` agrees after each.
- **De-dupe:** a token already in the list is never added twice — after
  on/off/on the list contains the id exactly once (assert `ids` length).
- **Cap enforcement:** seed a caller at `MAX_FAVORITE_COURSES` favorites (200),
  one more add → `Err("FAVORITES_FULL")`; removing one then adding succeeds.
- **Favorite-missing-token error:** `toggle_favorite_course(unknown_id)` →
  `Err("COURSE_NOT_FOUND")` and the list is unchanged.
- **List resolves cards and skips deleted:** favorite three tokens, remove one
  listing row (simulate burn by `COURSE_LISTINGS.remove`), then
  `list_my_favorite_courses()` returns exactly the two live cards (built via
  `listing_to_card`, correct `is_caller_owner`), in add order, dead id omitted.
- **Auth gate:** with the anonymous caller, `toggle_favorite_course` →
  `Err` (require_authenticated), `is_favorite` → `false`,
  `list_my_favorite_courses` → empty.
- **Privacy / per-user isolation:** caller A favorites a token; caller B's
  `is_favorite`/`my_favorite_ids`/`list_my_favorite_courses` do not see it.

**Frontend (vitest, `src/frontend/src/test/courseMarket.test.ts`, pure logic
only):**
- `applyFavoritesFilter(cards, favoriteIds, true)` returns exactly the favorited
  subset (and the original set when `false`); preserves no dupes; bigint id set
  membership matches by value.
- `markFavorites` correctly flags heart state per card from a `Set<bigint>`.

**Manual local:** the B8 walk-through, plus: open in a second identity and
confirm favorites are isolated; sign out and confirm the heart is disabled with
the sign-in nudge.

### B10. Out of scope

- Public favorite **counts** / "N people favorited this" aggregates, social
  surfacing, or any cross-user read of favorites (favorites are strictly
  private — A6).
- Any effect on tickets, plays, listings, price, ownership, mint, buy, or the
  featured slot — favoriting is convenience metadata only.
- Folders/tags/ordering of favorites beyond a flat capped list, and a
  `prune_favorites` cleanup of dead ids (reads already skip them — B4).
- `localStorage`/client-only favorites (persistence is server-side by design —
  A7).
- The buy flow (PB-307), play/ticket crediting (PB-306), and featured auction
  (PB-308) — favorites compose with the surfaces these own without modifying
  them.

### B11. Dependencies

- **PB-305** — the marketplace this extends: `COURSE_LISTINGS` (MemoryId 77),
  the `CourseCard` candid record + `listing_to_card` helper, the
  `list_marketplace_courses` page, and `CourseMarketplace.tsx` /
  `arcade/courseMarket.ts` (where the heart, filter, quick-replay strip, and the
  pure filter helper are added).
- **PB-301 / PB-304** — supply the minted tokens + the seeded `COURSE_LISTINGS`
  rows that favorites resolve against (existence check + card resolution). No new
  call into the CourseNFT canister is added by this spec.
