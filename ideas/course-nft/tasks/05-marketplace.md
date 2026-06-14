# Course Marketplace (PB-305)

> Phase 1. The primary arcade UI surface for the Course NFT feature; doubles as
> the course picker before a round. Browse all minted courses, filter them, and
> launch a play session or buy a listing.
>
> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md)
> first — this spec assumes its decisions (D1–D4), the shared `course_data`
> schema, the MemoryId table, and the repo conventions.
>
> **Depends on:** PB-301 (CourseNFT canister — authoritative ownership +
> metadata), PB-304 (minting flow — auto-lists a freshly minted course).
> **Hands off to:** PB-307 (`buy_course_nft` + royalty split), PB-308 (featured
> slot auction), PB-306 (play sessions / ticket crediting), PB-303 (the engine a
> "Play" click hands the `course_data` blob to).

---

## Part A — Design / UX

### A1. Where it lives

The marketplace replaces Mini Golf as the arcade's mini-golf surface (decision
D4, owned by [09](09-leaderboard-removal-and-arcade-migration.md)). It is a new
page module rendered inside the existing arcade shell. It is gated by the arcade
feature flag (see A7) and uses the `idea-board-container` (1080) layout — the
same wide browse/marketplace grid `IdeaBoard.tsx` and the Explorer use.

Page anatomy (matches every other page, per the overview §6):
`idea-board-container` → `<Eyebrow accent>Play & earn</Eyebrow>` → `gamepad`/
`flag` icon + `<h4>Course Marketplace</h4>` → subtitle + `<MoreInfo>` explaining
the create→mint→list→earn→sell loop and that playing earns lottery tickets.

### A2. Layout & ordering

Top to bottom:

1. **Header** (eyebrow/title/subtitle/MoreInfo) with a right-aligned primary
   button **"Create a course"** (routes to the editor, PB-302) and, when the
   caller owns ≥1 course, a secondary **"My courses"** filter toggle.
2. **Featured card (pinned slot).** One full-width course card pinned at the very
   top with a **"Featured"** badge. The *placement and the slot read* are owned
   here; the *auction mechanics* (`bid_featured_slot`, displacement, refunds) are
   PB-308. Until PB-308 ships, this spec defines the read contract:
   - The marketplace query (A-impl) returns an optional `featured_token_id` field
     (sourced from `FEATURED_SLOT`, MemoryId 78, owned by PB-308). When present
     and the token still resolves to a live listing, render its card in the
     pinned slot with the Featured badge and **exclude it from the pool below**
     (no duplicate). When absent or stale (token burned/transferred away in a way
     that voids the slot), render no pinned card and a thin **"Feature your
     course"** call-to-action strip whose button is disabled with tooltip
     "Coming soon" until PB-308 wires the bid modal.
   - The featured card is rendered with the **same component** as a pool card —
     it is not special apart from the badge and full-width spanning.
3. **Filter bar** (A3) — a single sticky-ish row, no sort control.
4. **Random pool grid** — `idea-grid` of course cards (A4), 9 per page (3×3,
   `GRID_PAGE_SIZE = 9`, matching IdeaBoard), with the existing Prev/Next pager.
   **Randomly ordered** per page load (A5). There is deliberately **no sort
   control** — the random order is the fairness mechanism (overview D-params).

Empty state: a centered `flag` icon + "No courses minted yet — be the first to
create one." with a "Create a course" button (mirrors IdeaBoard's empty state).

### A3. Filters

A single filter row, all client-driven into the query args (A-impl `MarketplaceFilter`):

| Filter | Control | Options | Maps to |
|---|---|---|---|
| **Difficulty** | pill group | Any · Easy (par ≤ 27) · Medium (28–44) · Hard (par ≥ 45) | `par_total` buckets |
| **Theme** | pill group | Any · Desert · Ocean · Space · Forest · Custom | cached `theme` |
| **Listed for sale** | pill group | Any · Yes · No | cached `listed` |

Buckets are computed from `par_total` exactly as the editor doc defines them
(Easy ≤ 27, Hard ≥ 45, Medium otherwise). The difficulty edges are derived from
par, never stored as a separate enum, so a re-tuned course can't drift out of
sync — but the listing caches `par_total` so the backend can filter cheaply
without a cross-canister call (A-impl A9).

Changing any filter resets the pager to page 0 and **re-rolls** the random order
(A5) so the user sees a fresh fair shuffle of the filtered set.

### A4. The course card

Each card (reused for pool + featured) shows, top to bottom:

- **Top row:** a status chip — `Featured` (burn tone) on the pinned card,
  otherwise `For sale` (ok tone) when listed-with-price or `Not for sale` (muted)
  — and a right-aligned `par_total` + difficulty label (e.g. "Par 34 · Medium").
- **Theme stripe / name:** course `name` (`<h6>`), theme chip.
- **Creator + owner line:** `creator` username and, when the owner differs,
  `owner` username (resolve via the existing username/principal formatting helper
  — `formatPrincipal` fallback, same as IdeaBoard). Label as "by {creator}" and,
  if owner ≠ creator, a muted "· owned by {owner}".
- **Stats row:** `total_plays` (the `play_count` metric — rounds that reached
  hole 2) as a chip with the `target`/`flag` icon. Optionally `tickets_distributed`
  as a secondary muted chip ("N tickets earned") — this is the yield track record
  buyers price against.
- **Price line:** when listed → `fmtICP(price_e8s)` ICP in mono; otherwise the
  muted text **"Not for sale"**.
- **Footer buttons:**
  - **Play** (primary) — always enabled for a live listing; anonymous users get
    "Sign in to play" routing to `onSignIn` (play-to-earn for the player needs
    Tier 2+, but anyone can play for fun; the owner still earns — that gating
    lives in PB-306). Clicking Play loads the token's `course_data` blob and
    hands it to the engine (PB-303), opening a play session (PB-306
    `start_play_session`).
  - **Buy** (secondary) — shown only when `listed && price_e8s > 0` and the
    caller is **not** the current owner. Disabled with "You own this" when the
    caller is the owner. The buy flow itself (ICRC-2 approve → `buy_course_nft`)
    is **PB-307**; in Phase 1 this button opens a modal whose confirm is disabled
    with "Secondary market coming soon" so the surface ships before PB-307.
  - **Manage** (ghost, owner-only) — opens the owner modal (A6) to list / change
    price / delist.

A **Details** affordance (card click or a ghost button) opens a detail modal
showing the full hole-by-hole summary (hole name + par from `course_data`),
creator/owner, mint provenance (`mint_fee_e8s`, `created_at`), play count,
tickets distributed, and the same Play/Buy/Manage actions.

### A6. Owner: list / delist (this spec owns the candid)

The owner-only **Manage** modal:
- Price input in ICP (decimal → e8s via the existing `parseTokenAmount`).
- **List for sale** → `list_course_for_sale(token_id, price_e8s)`.
- **Update price** → same call with a new price (idempotent overwrite).
- **Delist** → `delist_course(token_id)` (keeps the listing row, sets
  `listed = false`, clears price). Note in the copy: **delisted courses earn no
  owner tickets** (listing is required for ticket accrual — PB-306 checks
  `listed` before crediting), and the course disappears from the public browser
  but the owner can re-list any time at no cost.

Only the **current owner** (resolved against the CourseNFT canister) may list,
re-price, or delist — enforced server-side (A-impl A11). Direct
`icrc7_transfer` gifting/OTC is out of scope here (the new owner just calls
`list_course_for_sale` themselves).

### A5. Fair random ordering — decision: server-seeded, client-shuffled

**Decision: the random order is produced client-side from a server-provided
per-load seed.** Rationale:

- A canister **query** has no good entropy source (`raw_rand` is an update-only
  async call; using time-as-seed in a query is weak and makes the response
  non-deterministic across the query's replicas, which can fail consensus on a
  replicated/certified query). Shuffling server-side in a query is therefore not
  fair *and* not safe.
- Doing the shuffle in an **update** call just to randomize a browse list is
  wasteful (costs cycles, no entropy benefit for a read).

So: `list_marketplace_courses` is a **query** that returns the filtered set in a
**stable, deterministic order** (ascending `token_id`) plus a `seed: u64` derived
cheaply (e.g. `current_time()` low bits) purely as a *hint*. The frontend
generates its own per-page-load seed (`Math.random()`-seeded PRNG) on mount and
on every filter change, and Fisher–Yates shuffles the returned vector with it.
This gives a genuinely fresh fair shuffle on every page load without any
consensus or entropy hazard, and keeps the backend a pure cheap query. The
featured token is removed from the array before shuffling so it never appears
twice.

(If a future iteration wants server-authoritative randomness — e.g. to prevent a
client pinning their own course to the top via a rigged shuffle — that would be a
separate update-call endpoint seeded by `raw_rand`; out of scope for Phase 1
since the order carries no economic weight.)

### A7. Feature-flag gating — decision: reuse the `arcade` flag

**Decision: reuse the existing `arcade` parent flag; do NOT add a `course_nft`
flag in Phase 1.** Rationale:

- D4 makes the marketplace *the* mini-golf surface inside the arcade; it is not a
  parallel feature. The arcade flag is already the master switch the nav, route
  guard (`App.tsx` `arcadeEnabled`), and `require_arcade_enabled()` all key off.
- There is already a per-game flag pattern (`arcade_minigolf` /
  `arcade_fieldgoal` / `arcade_turborush`). The mini-golf surface should key off
  **`arcade_minigolf`** for its own kill switch, exactly like the other games —
  reuse it rather than minting a new flag. So: a marketplace endpoint requires
  **both** `arcade` (parent) **and** `arcade_minigolf` (sub) to be visible, via
  the existing `require_arcade_game_enabled("minigolf")` helper.
- Repo convention: new flags ship **default OFF**. The arcade flags already
  exist and already default OFF (seeded on in `deploy-local.sh`), so no new flag
  default is introduced. If product later wants to dark-ship the *NFT economy*
  independently of the simple game, a dedicated `course_nft` flag (default OFF,
  added to `KNOWN_FEATURE_FLAGS`, count 12→13) can be introduced then — noted as
  the documented escape hatch, not built now.

Anonymous viewers can browse + play-for-fun; ticket-earning and buy/list require
sign-in (and Tier-2 for player tickets, per PB-306).

### A8. Acceptance criteria (UX)

- Marketplace renders inside the arcade shell behind the arcade flag; hidden in
  nav + route-guarded when `arcade`/`arcade_minigolf` is off for the caller.
- Featured card, when a slot is set, pins on top with a badge and is absent from
  the pool; when unset, a disabled "Feature your course (coming soon)" strip
  shows.
- Pool is randomly ordered, re-shuffles on each load and on filter change, never
  shows the featured token twice, paginates 9/page.
- Difficulty/Theme/Listed filters narrow the set correctly; difficulty buckets
  match Easy ≤ 27 / Hard ≥ 45 / Medium.
- Card shows name, creator (+owner when differ), theme, par total, total plays,
  price-or-"Not for sale", and Play/Buy/Manage as specified.
- Owner can list/re-price/delist; non-owners cannot; delist copy warns tickets
  stop accruing.
- Play hands the course's `course_data` to the engine and opens a session.

---

## Part B — Implementation

All backend work lands in `src/backend/src/lib.rs` under a new banner
`// ===== 20. Course NFT marketplace =====` (the marketplace controller half;
mint/buy/play/featured live in their own specs under the same or adjacent
banners). Candid in `src/backend/backend.did` is hand-maintained and updated in
lockstep. Bindings regenerate from the `.did`.

### B1. Stable state — `COURSE_LISTINGS` (MemoryId 77)

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CourseListing {
    pub token_id: u64,
    pub listed: bool,
    pub price_e8s: u64,              // 0 when not listed
    // ── Cached from the CourseNFT canister for cheap query-time filtering /
    //    card rendering WITHOUT a cross-canister call. Refreshed by the
    //    controller whenever it mutates the token (mint/buy) and by
    //    refresh_course_listing (B6). #[serde(default)] on every field for
    //    upgrade-safety (overview §6).
    #[serde(default)] pub owner: Option<Principal>,
    #[serde(default)] pub creator: Option<Principal>,
    #[serde(default)] pub play_count: u64,
    #[serde(default)] pub tickets_distributed: u64,
    #[serde(default)] pub par_total: u8,
    #[serde(default)] pub theme: u8,           // Theme discriminant (0..=4), Custom=4
    #[serde(default)] pub created_at: u64,
    #[serde(default)] pub mint_fee_e8s: u64,
}
impl_storable!(CourseListing);

thread_local! {
    static COURSE_LISTINGS: RefCell<StableBTreeMap<u64, CourseListing, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableBTreeMap::init(mm.borrow().get(MemoryId::new(77)))));
}
```

`difficulty` is **derived** from `par_total`, never stored:
`fn difficulty_bucket(par_total: u8) -> Difficulty { ≤27 Easy / ≥45 Hard / else Medium }`.

**Authority model:** the **CourseNFT canister is authoritative** for ownership +
metadata. `COURSE_LISTINGS` is a *controller-side cache + marketplace state*
(price/listed). The cache is updated whenever the controller is the actor that
changed the token (mint in PB-304 seeds the row + `listed=true`; buy in PB-307
flips `owner`). Anything that can drift (a direct owner `icrc7_transfer` for
gifting/OTC) is reconciled lazily by `refresh_course_listing` (B6) and at every
write that reads the live owner.

### B2. Filter args

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum DifficultyFilter { Any, Easy, Medium, Hard }
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum ListedFilter { Any, Yes, No }
// Theme filter reuses an Option<u8> (None = Any) to avoid a second enum.

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MarketplaceFilter {
    pub difficulty: DifficultyFilter,
    pub theme: Option<u8>,        // None = Any; 0..=4 selects a theme
    pub listed: ListedFilter,
    pub mine_only: bool,          // owner == caller (My courses toggle)
}
```

### B3. Marketplace query

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MarketplacePage {
    pub courses: Vec<CourseCard>,      // deterministic asc token_id order
    pub featured_token_id: Option<u64>,// from FEATURED_SLOT (PB-308); None pre-308
    pub seed: u64,                     // shuffle hint (see A5)
    pub total: u64,                    // matching set size (pre-pagination)
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CourseCard {
    pub token_id: u64,
    pub name: String,                  // cached on the listing (add to B1 if not)
    pub creator: Option<Principal>,
    pub owner: Option<Principal>,
    pub par_total: u8,
    pub play_count: u64,
    pub tickets_distributed: u64,
    pub theme: u8,
    pub listed: bool,
    pub price_e8s: u64,
    pub created_at: u64,
    pub is_caller_owner: bool,         // filled per-caller
}

#[ic_cdk::query]
fn list_marketplace_courses(filter: MarketplaceFilter) -> MarketplacePage { ... }
```

Behaviour: requires `arcade` + `arcade_minigolf` visible for the caller
(`require_arcade_game_enabled("minigolf")` — but as a *query* it returns an empty
page rather than trapping when disabled, matching how `get_arcade_info` degrades;
the nav already hides it). Filters over `COURSE_LISTINGS` in memory (cheap —
cached fields only), excludes the featured token from `courses`, returns in
ascending `token_id` order, and supplies `featured_token_id` + a cheap `seed`.
`name` should be cached on the listing too (add `pub name: String` to B1) so the
card needs no cross-canister read; if not cached, the query stays cheap by
returning ids and the frontend batch-reads metadata — **decision: cache `name`
on the listing** (bounded, set at mint, immutable) to keep the query a single
cheap read. (This also sidesteps review C5: cards never batch-read the heavy
`course_data` blob; the only `course_data` reads are single-token, via
`get_course_data` below, and `icrc7_token_metadata` batches are capped at 25 in
PB-301 A.5.)

`get_course(token_id) -> Option<CourseCard>` — single-card read for the detail
modal / deep link. The full `course_data` blob for Play is fetched from the
**CourseNFT canister** directly (`icrc7_token_metadata`) or via a thin controller
passthrough `get_course_data(token_id) -> Option<blob>`; **decision: add the
passthrough** so the frontend talks only to the backend for play (the backend
already needs the blob to open a session in PB-306).

### B4. List / delist endpoints (candid owned here)

```rust
#[ic_cdk::update]
fn list_course_for_sale(token_id: u64, price_e8s: u64) -> Result<(), String> {
    require_authenticated()?;
    require_arcade_game_enabled("minigolf")?;
    // resolve live owner from CourseNFT; reject if caller != owner
    // reject price_e8s == 0 (use delist instead) and price_e8s > MAX_LISTING_E8S
    // upsert COURSE_LISTINGS row: listed=true, price_e8s, refresh cached owner
}

#[ic_cdk::update]
fn delist_course(token_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_arcade_game_enabled("minigolf")?;
    // caller must be live owner; set listed=false, price_e8s=0 (keep the row)
}
```

`buy_course_nft`, the royalty split, and the featured-slot bid are **NOT** in
this spec (PB-307 / PB-308). This spec only adds list/delist + the read surface.

### B5. Owner resolution

A shared helper used by B4/B6/PB-306/PB-307:
`async fn course_owner_of(token_id: u64) -> Result<Principal, String>` →
inter-canister `icrc7_owner_of` on the CourseNFT canister (id stored in
`Config`/a new config field set by an admin call, mirror
`admin_set_token_ledger`). Because it is async, `list_course_for_sale` /
`delist_course` are `update`s that `await` the owner read before mutating —
acceptable (low frequency, owner-gated).

### B6. Cache reconciliation

`refresh_course_listing(token_id)` (callable by anyone; cheap, idempotent):
re-reads owner + metadata from CourseNFT and updates the cached fields on the
`COURSE_LISTINGS` row. Called opportunistically by the frontend after a play
session or when a card's cached owner looks stale, and internally after
mint/buy. Keeps the cache eventually-consistent with the authoritative canister
without a heavyweight sync loop. (A periodic timer sweep is **out of scope** —
add only if drift proves a problem.)

### B7. Candid (`backend.did`) additions

Add types `CourseListing` is internal (not exposed); expose `MarketplaceFilter`,
`DifficultyFilter`, `ListedFilter`, `MarketplacePage`, `CourseCard`, and methods:

```
list_marketplace_courses : (MarketplaceFilter) -> (MarketplacePage) query;
get_course : (nat64) -> (opt CourseCard) query;
get_course_data : (nat64) -> (opt blob) query;     // passthrough for Play
list_course_for_sale : (nat64, nat64) -> (Result);
delist_course : (nat64) -> (Result);
refresh_course_listing : (nat64) -> (Result);
```

Reuse the existing `Result` (`variant { Ok; Err: text }`) alias for the updates.

### B8. Frontend file plan

- **`src/frontend/src/CourseMarketplace.tsx`** (new) — the page. Props mirror
  `Arcade`/`IdeaBoard` (`actor, identity, principal, host, rootKey, onSignIn`,
  plus an `onCreateCourse` to route to the editor and an `onPlay(courseData,
  tokenId)` to launch the engine view). State: filters, gridPage, the shuffled
  page array, a `seedRef` reset on mount + filter change. Reuse `ui.tsx`
  primitives and the `idea-board-container` / `idea-grid` classes. Reuse
  `fmtICP` and `parseTokenAmount`/`fmtTokenAmount` from IdeaBoard for the price
  input.
- **`src/frontend/src/courseCard.tsx`** (optional small shared component) — the
  card used for both featured + pool to guarantee they render identically.
- **Wiring:** rendered from the arcade surface. The arcade Mini Golf tab becomes
  the marketplace entry point — this re-wire is **owned by PB-309**; this spec
  builds the component PB-309 mounts. Reads decode candid opts via the
  `{__kind__}` wrapper and treat `nat64`/`nat` as `bigint` (overview §6 / the
  frontend-dev skill's opt-decoding trap).
- **Random shuffle:** a small seeded PRNG (mulberry32) seeded from
  `seedRef.current`; Fisher–Yates over `page.courses` after removing
  `featured_token_id`.

### B9. Acceptance criteria (impl)

- `cargo test -p backend --lib` green; new unit tests:
  - `difficulty_bucket` edges (27→Easy, 28→Medium, 44→Medium, 45→Hard).
  - `list_marketplace_courses` filters: difficulty/theme/listed/mine_only narrow
    the set; featured token excluded from `courses`; `total` reflects the
    pre-pagination match count.
  - `list_course_for_sale` rejects non-owner (mock `course_owner_of` seam),
    rejects price 0 / over cap, sets `listed=true`; `delist_course` keeps the row
    with `listed=false`.
  - upgrade round-trip: a `CourseListing` written pre-new-field deserializes with
    `#[serde(default)]` fields.
- `cd src/frontend && npx tsc -b && npx vitest run` green.
- `bash scripts/deploy-local.sh` then manual: mint a course (PB-304), see it in
  the marketplace, filter it, list/delist it, Play it.

### B10. Test plan

- **Unit (backend):** B9 list above, with a native mock seam for
  `course_owner_of` (overview §6 mandates a mock seam for value/cross-canister
  logic).
- **Integration (PocketIC):** install backend + a CourseNFT stub; mint→listing
  row appears; list_course_for_sale/delist round-trip against the real
  `icrc7_owner_of`; a direct `icrc7_transfer` then `refresh_course_listing`
  updates the cached owner.
- **Frontend (vitest):** the shuffle is a permutation (no drops/dupes) and is
  stable within a render but differs across seeds; difficulty-bucket label
  mapping; "Not for sale" vs price rendering; Buy hidden for the owner.
- **Manual local:** the deploy-local walk-through in B9, plus anonymous browse +
  "Sign in to play".

### B11. Out of scope

- `buy_course_nft`, ICRC-2 approve buy flow, royalty/resale split → **PB-307**.
- Featured-slot **auction** (bidding, ck-token escrow, USD comparison,
  displacement, treasury routing) → **PB-308**. This spec only reads the slot.
- Ticket crediting, play sessions, anti-cheat → **PB-306**.
- The editor and the mint flow → **PB-302 / PB-304**.
- The CourseNFT canister itself → **PB-301**.
- Ratings/reviews → **PB-310**.
- A new dedicated `course_nft` feature flag (documented escape hatch only).

### B12. Dependencies

- **PB-301** — CourseNFT canister (`icrc7_owner_of`, `icrc7_token_metadata`,
  config of the canister id in the backend).
- **PB-304** — mint seeds the `COURSE_LISTINGS` row (`listed=true`) + cached
  metadata; this spec's cache shape is what mint writes.
- **PB-303** — the engine + `course_data` format the Play button feeds.
- **PB-306** — `start_play_session` (Play button target); reads `listed` before
  crediting owner tickets.
- **PB-307** — Buy button's real implementation.
- **PB-308** — populates `FEATURED_SLOT` (MemoryId 78) that `featured_token_id`
  reads.
- **PB-309** — mounts this page as the arcade mini-golf entry point and removes
  the old leaderboard/built-in course.
