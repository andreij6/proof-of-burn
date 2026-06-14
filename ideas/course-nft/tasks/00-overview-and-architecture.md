# Course NFT — Build Specs: Overview & Architecture (PB-300)

> Anchor document for the Mini-Golf Course NFT feature. Every task spec in this
> folder references the decisions, shared data models, MemoryId allocations, and
> PB task IDs defined here. Read this first.

Source design docs (parent dir): [`course-nft-design.md`](../course-nft-design.md),
[`economy-and-ux.md`](../economy-and-ux.md), [`course-editor.md`](../course-editor.md).

---

## 1. The loop (what we're building)

**create → mint (burn 0.5 ICP) → list → earn lottery tickets passively as people
play → sell to someone who values the earning rights more.** Courses are
yield-bearing ICRC-7 NFTs; the creator keeps a permanent royalty on every resale.

---

## 2. Decisions locked (from clarifying Q&A, 2026-06-13)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Anti-cheat = signed play-session + per-day caps.** No server-side physics replay. | Backend issues a session token at round start, accepts only ordered hole events for that session, dedupes, and caps owner/player tickets per day. See [06](06-play-to-earn-and-anticheat.md). |
| D2 | **Core ICRC-7 only** — no ICRC-37 (approvals) or ICRC-3 (tx log). | CourseNFT canister implements mint + `icrc7_owner_of` + `icrc7_transfer` + `icrc7_token_metadata` + `icrc7_tokens_of` + collection metadata. Backend is an **allowlisted minter/custodian** so it can execute marketplace-mediated transfers without ICRC-37 approvals. Owners can still `icrc7_transfer` directly for gifting/OTC. See [01](01-coursenft-canister-icrc7.md). |
| D3 | **Specs are implementation-ready AND design-level.** | Each spec has both a Design/UX/behavior half and an Implementation half (data models, candid, MemoryIds, file paths, acceptance criteria, test plan). |
| D4 | **Marketplace replaces the built-in mini-golf course; extend the engine.** | The arcade mini-golf entry point becomes the marketplace/course-picker. The global mini-golf leaderboard is removed. The physics engine + serialization format are extended to support the full element set (moving obstacles, tunnels, ramps, speed/slow tiles). See [03](03-minigolf-engine-and-course-format.md) and [09](09-leaderboard-removal-and-arcade-migration.md). |

Other settled parameters from the design docs (do not re-litigate in specs):
- Exactly **9 holes** per course, enforced client-side and again at mint.
- **Mint fee 0.5 ICP**, split **50% treasury / 25% backend cycles / 25% frontend cycles** (reuse the existing burn-split pattern).
- **Owner earns 1 ticket** when a player completes hole 2; **player earns 1 ticket** (Tier 2+ only) on full 9-hole completion.
- **Resale split 75% seller / 10% creator royalty / 10% cycles (5% backend + 5% frontend) / 5% treasury**, all enforced on-chain by `buy_course_nft`.
- **Featured slot**: bids in ckBTC/ckETH/ckUSDT/ckUSDC, compared in USD via the XRC oracle, **100% to treasury, non-refundable**, held until outbid.
- Marketplace ordering is **random per page load**; featured card pinned on top; no sort control.

---

## 3. Canister architecture

```
┌────────────────────────────────────────┐        ┌──────────────────────────────┐
│  backend (existing, src/backend)        │        │  course_nft (NEW canister)   │
│  = Marketplace Controller               │ calls  │  = ICRC-7 ledger (core)      │
│                                         │ ─────► │                              │
│  mint_course_nft()      ───────────────────────► │  mint(to, meta)  [minter]    │
│  buy_course_nft()       ───────────────────────► │  custodial_transfer() [minter]│
│  record_hole_event()    ──► icrc7_owner_of() ◄── │  icrc7_owner_of()            │
│  list/delist_course()                            │  icrc7_transfer()  (owner)   │
│  bid_featured_slot()                             │  icrc7_token_metadata()      │
│  start_play_session()                            │  icrc7_tokens_of()           │
│  holds ICP/ck-tokens during sales & bids         │  icrc7_collection_metadata() │
│  enforces royalty split, credits tickets         │                              │
└────────────────────────────────────────┘        └──────────────────────────────┘
```

- The **backend** stays the single source of truth for marketplace state (listings,
  prices, featured slot, play sessions, ticket crediting, fee/royalty splits). It
  holds funds during sales and bids and reuses the existing treasury/cycles/XRC/
  ledger machinery.
- The **course_nft canister** is a thin, standards-shaped ICRC-7 token. It stores
  the authoritative ownership + on-chain metadata (incl. the serialized
  `course_data` blob) so any ICP wallet/explorer can read it. It trusts an
  **allowlisted minter principal** (the backend) for `mint` and `custodial_transfer`.

New canister lives at `src/course_nft/` (its own crate) and is added to `icp.yaml`.

---

## 4. Shared `course_data` blob schema (authoritative — used by editor, engine, NFT)

Versioned CBOR (`ciborium`), stored as the NFT's `course_data: Blob`. Editor
writes it, the play engine reads it, the NFT stores it verbatim. Full element
catalog + physics params are specified in [03](03-minigolf-engine-and-course-format.md);
this is the top-level shape every spec must agree on:

```
CourseDataV1 {
  version: u8 = 1,
  theme: Theme,                       // Desert|Ocean|Space|Forest|Custom{primary,secondary}
  holes: [Hole; 9],                   // exactly 9
}
Hole {
  name: Option<String>,               // <= 30 chars
  par: u8,                            // 2..=5
  grid_w: u16, grid_h: u16,
  tee: Cell, cup: Cell,               // exactly one each
  elements: Vec<Element>,             // terrain, walls, obstacles, moving, special
}
Element { kind: ElementKind, x: u16, y: u16, rot: u8 /*0..3*/, params: ElementParams }
```

Hard limits (validated at mint, see [04](04-minting-flow.md)): max serialized blob
size, max elements/hole, paired tunnels/ramps balanced. Exact numbers defined in [03].

---

## 5. MemoryId allocation (DO NOT COLLIDE)

The existing **backend** canister uses MemoryIds `0–75` (75 = `POOL_REWARDS_PAID`,
most recent). **All new backend stable structures for this feature use 76+:**

| MemoryId | Map | Owner spec |
|---|---|---|
| 76 | `COURSE_DRAFTS: Principal → CourseDraft` (one draft/user) | [02](02-course-editor.md) |
| 77 | `COURSE_LISTINGS: u64(token_id) → CourseListing` (price, listed, cached owner/play_count/par/theme) | [05](05-marketplace.md) |
| 78 | `FEATURED_SLOT: StableCell<Option<FeaturedSlot>>` | [08](08-featured-slot-auction.md) |
| 79 | `PLAY_SESSIONS: u64(session_id) → PlaySession` | [06](06-play-to-earn-and-anticheat.md) |
| 80 | `COURSE_TICKET_CAPS: (Principal, u32 day) → TicketCapEntry{player,owner}` | [06](06-play-to-earn-and-anticheat.md) |
| 81 | `COURSE_RATINGS: (u64 token_id, Principal) → Rating` (Phase 3) | [10](10-ratings-and-reviews.md) |
| 82 | `NEXT_SESSION_ID / counters` cell | [06](06-play-to-earn-and-anticheat.md) |
| 83 | `MINT_SAGAS: Principal → MintSaga` (two-canister mint idempotency) | [04](04-minting-flow.md) |
| 84 | `COURSE_SALES: u64(token_id) → CourseSale` (buy-saga idempotency) | [07](07-secondary-market-royalties.md) |
| 85 | `COURSE_PAIR_CAPS: (Principal, u64 token_id, u32 day) → u32` (per-course/day farm cap) | [06](06-play-to-earn-and-anticheat.md) |
| 86–89 | **reserved** for this feature's growth | — |

The **course_nft canister** has its own independent MemoryId space starting at 0:

| MemoryId | Map | 
|---|---|
| 0 | `TOKENS: u64 → CourseToken` |
| 1 | `OWNER_TOKENS: (Principal, u64) → ()` (index for `icrc7_tokens_of`) |
| 2 | `NEXT_TOKEN_ID: StableCell<u64>` |
| 3 | `CONFIG: StableCell<NftConfig>` (collection metadata + allowlisted minter principal) |

Specs that add a stable structure MUST claim the next free id here and update this
table in the same change.

---

## 6. Repo conventions every spec must follow

- **Backend** is one file `src/backend/src/lib.rs`, navigated by `// ===== N. Title =====`
  banners; add a new section `// ===== 20. Course NFT marketplace =====`. Candid in
  `src/backend/backend.did` is **hand-maintained** and must be updated in lockstep.
  Stable structs use the `impl_storable!` macro; **new fields need `#[serde(default)]`**;
  **never reuse a MemoryId**. Guards from §4 (`require_authenticated`, `require_admin`,
  `require_local_dev`) on every update. Amounts are `u64` e8s. Value-moving logic needs
  a native mock seam for unit tests. See skill `.claude/skills/backend-canister-dev`.
- **course_nft** is a new crate: mirror the backend's stable-structures + candid +
  `impl_storable!` + upgrade-safety conventions.
- **Frontend** is React 19 + TS in `src/frontend/src` (flat page files). Reuse `ui.tsx`
  primitives (`Icon`, `Eyebrow`, `Chip`, `Btn`, `MoreInfo`, `LiveDot`, `fmtICP`).
  Page anatomy = `dashboard-container` (720) or `idea-board-container` (1080) +
  `<Eyebrow accent>` + icon + `<h4>` + subtitle + `<MoreInfo>`. Candid bindings are
  **generated** from `backend.did` (never hand-edit `src/bindings`); `opt T` decodes via
  the `{__kind__}` wrapper; `nat64`/`nat` are `bigint`. See skill `.claude/skills/frontend-dev`.
- **Visuals are a swappable render layer (art must be upgradable).** On-chain
  `course_data` and the physics engine carry **logical, art-agnostic** data only
  (element kind, transform, gameplay params, canonical collision geometry); **all**
  drawing lives in a pluggable `RenderKit` keyed by `(ElementKind, Theme)`. Upgrading
  element art (the first-pass sand/walls/windmill are deliberately low-fi) is a
  client-side render-layer change — no schema bump, no physics change, no re-mint, and
  it lifts the editor and the game together. The render-layer contract is specified in
  [PB-303 A.6](03-minigolf-engine-and-course-format.md) and reused by [PB-302](02-course-editor.md)/[PB-309](09-leaderboard-removal-and-arcade-migration.md).
- **Ticket crediting** reuses the existing lottery system: `LOTTERY_TICKETS:
  StableBTreeMap<Principal, TicketEntry{round,count,last_claim_day}>` (per-round counts).
  Course tickets add to the caller/owner's current-round `count` (model after
  `dev_grant_lottery_tickets`). Specs must credit into the *current round* and respect
  admin-exclusion rules already in the lottery.
- **Ticket lifetime (confirmed product rule, 2026-06-13):** lottery tickets are
  **never voided**. The *only* reset is **winning the lottery** — a draw bumps
  `lottery_state().round`, which uniformly zeroes every user's stale-round count on next
  touch. This applies identically to **all** sources: staking daily-grant, course play,
  and NFT-holding. Tickets are **not** voided on unstake. This requires removing the
  existing on-unstake `void_current_round_tickets` call (see §8); admin-exclusion is a
  separate rule that stays.
- **Fee/royalty splits** reuse the existing `settle_burn_split`-style pattern: per-leg
  block-index idempotency, treasury fronts ledger fees, CMC top-ups for cycle legs.
  XRC USD valuation + ck-token ledgers (ckBTC/ckETH/ckUSDC/ckUSDT) + `call_icrc2_approve`
  already exist (Dapp Explorer / multi-token commit) — reuse them.
- **Local deploy/test gates**: `cargo test -p backend --lib`, `cargo test -p course_nft`,
  `cd src/frontend && npx tsc -b && npx vitest run`, then `bash scripts/deploy-local.sh`
  (extend it to install the new canister). NEVER deploy to mainnet. See skill
  `.claude/skills/icp-local-deploy`.

Each spec ends with: **Acceptance criteria**, **Test plan** (unit + integration +
manual local), **Out of scope**, and a **Dependencies** line referencing other PB-3xx.

---

## 7. Task index & phasing

Phases follow the design docs. Build order respects dependencies (canister + format
+ editor first, then mint/marketplace/play, then secondary market, then featured slot,
then ratings).

| PB | Spec file | Phase | Depends on |
|---|---|---|---|
| **PB-301** | [01-coursenft-canister-icrc7.md](01-coursenft-canister-icrc7.md) | 1 | — |
| **PB-302** | [02-course-editor.md](02-course-editor.md) | 1 | 303 |
| **PB-303** | [03-minigolf-engine-and-course-format.md](03-minigolf-engine-and-course-format.md) | 1 | — |
| **PB-304** | [04-minting-flow.md](04-minting-flow.md) | 1 | 301, 303 |
| **PB-305** | [05-marketplace.md](05-marketplace.md) | 1 | 301, 304 |
| **PB-306** | [06-play-to-earn-and-anticheat.md](06-play-to-earn-and-anticheat.md) | 1 | 301, 303, 305 |
| **PB-307** | [07-secondary-market-royalties.md](07-secondary-market-royalties.md) | 2 | 301, 305 |
| **PB-308** | [08-featured-slot-auction.md](08-featured-slot-auction.md) | 3 | 305 |
| **PB-309** | [09-leaderboard-removal-and-arcade-migration.md](09-leaderboard-removal-and-arcade-migration.md) | 1 | 303, 305 |
| **PB-310** | [10-ratings-and-reviews.md](10-ratings-and-reviews.md) | 3 | 305 |

**Phase 1 (MVP):** PB-301, 303, 302, 304, 305, 306, 309.
**Phase 2 (Secondary market):** PB-307.
**Phase 3 (Featured slot + ratings):** PB-308, 310.

---

## 8. Cross-cutting risks to address in the relevant specs

- **Anti-cheat is the highest-value risk** (tickets convert to lottery prize ICP).
  PB-306 owns the session/caps model; every ticket-crediting path must route through it.
- **Custodial transfer authorization** (PB-301/307): the backend must be the only
  non-owner principal that can move a token, and only as part of a settled sale.
- **Two-canister atomicity** (PB-304/307): mint and buy span backend↔course_nft calls
  and ledger transfers — specify the saga ordering + idempotent retry so a partial
  failure never double-charges or loses a token (mirror the existing settlement sagas).
- **Upgrade safety** for both canisters (serde defaults, no MemoryId reuse).
- **course_data size** bounds to keep mint calls + metadata queries under message limits.
- **Companion change to existing lottery (not course-NFT-specific):** remove the
  on-unstake `void_current_round_tickets` call so tickets are only ever cleared by a
  lottery win (per §6 ticket-lifetime rule). Small edit to the existing staking/unstake
  path in `lib.rs`; keep admin-exclusion. Sequence it with Phase 1 so course tickets and
  staking tickets share identical, never-voided semantics from day one.

## 9. Deferred / rejected review items

- **O1 — buffer/batch CMC cycle top-ups (DEFERRED, not adopted in these specs).** The
  spec review suggests accumulating the 25%/5% cycle fractions in a local pool and doing
  one CMC top-up per threshold instead of per mint/sale, to save ledger fees + latency.
  It's a real win, **but it's protocol-wide** — every fee split in the app (burns, pool
  fees, explorer, arcade) goes through the same per-event `settle_burn_split` path, and
  introducing a buffered cycles pool only for course mints/sales would diverge from that
  reused machinery and add reconciliation state. Decision: **keep per-event CMC top-ups**
  here for consistency, and track O1 as a separate **protocol-wide** optimization ticket
  against `settle_burn_split` (out of scope for the course feature). PB-304/PB-307 note
  this inline.
- **O2 — `float64` for the rating average (REJECTED).** PB-310 keeps candid integer-typed
  (`rating_sum` + `count`, plus an `avg_x10` convenience) per the repo's no-floats-on-the-
  wire convention; the frontend formats the average. Rationale in [10](10-ratings-and-reviews.md).
