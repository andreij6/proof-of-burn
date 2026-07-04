---
type: idea
title: "Featured Dapp — Backend / Data Model + Task List"
tags: [ideas, featured-dapp]
timestamp: 2026-06-16T10:12:10-04:00
---

# Featured Dapp — Backend / Data Model + Task List

> Grounded in `src/backend/src/lib.rs`. Reuses the Dapp Explorer paid-listing escrow flow
> (`submit_dapp` → `admin_approve_dapp`/`admin_reject_dapp` → `delete_expired_dapps`), the XRC USD-quote
> pattern (`get_explorer_quote`/`explorer_quote_amount`/`explorer_usd_rate_e8s`), and the per-caller
> escrow subaccount (`derive_explorer_subaccount`). It does **not** reuse the PB-308 `FeaturedSlot`
> (MemoryId 78) — that's a single perpetual highest-bid slot in the **course** marketplace; this is up to
> 3 fixed-duration premium placements in the **dapp** Explorer.

## 1. Data model

Separate stable map keyed by its own id space, referencing a `DappListing` by id (independent lifecycle/
escrow/expiry; allows re-featuring later).

```rust
pub enum FeaturedStatus { Pending, Approving, Active, Expired, Rejected }
// Approving = transient reservation during the claim-before-await approval sweep (§4); revert to
// Pending if the escrow→treasury transfer fails. Append-only ⇒ upgrade-safe.

pub struct FeaturedDapp {
    pub id: u64,                 // own id space (NEXT_FEATURED_ID)
    pub listing_id: u64,         // FK into DAPPS (must be an Approved community listing)
    pub applicant: Principal,    // == listing.submitter
    pub status: FeaturedStatus,
    pub token: ExplorerToken,
    pub amount_paid: u64,        // token smallest-units moved to escrow/treasury
    pub usd_total_e8s: u64,      // premium valued in USD at quote time
    pub days: u64,               // fixed duration purchased
    pub created_at: u64,         // apply time
    pub approved_at: Option<u64>,
    pub starts_at: Option<u64>,  // = approved_at
    pub expires_at: Option<u64>, // approved_at + days*DAY_NANOS
    #[serde(default)] pub payment_block: Option<u64>, // ledger block, audit
}
impl_storable!(FeaturedDapp);
```

Stable storage (grep-confirmed free; **78 is the course slot**):
```rust
static FEATURED: StableBTreeMap<u64, FeaturedDapp, Memory>   // MemoryId 88
static NEXT_FEATURED_ID: StableCell<u64, Memory>             // MemoryId 89, init 1
static FEATURED_QUOTES: StableBTreeMap<Principal, ExplorerQuote, Memory> // MemoryId 94
```
A **separate** `FEATURED_QUOTES` (vs reusing `EXPLORER_QUOTES`) so a cheap listing quote can't be spent on
a premium slot — the `submit_dapp` quote check is token+days only, no price-tier tag (decision A).

## 2. Premium pricing

```rust
const FEATURED_PRICE_PER_DAY_USD_E8S: u64 = 1_000_000_000; // $10/day default (~10× listing)
const FEATURED_MIN_DAYS: u64 = 7;
const FEATURED_MAX_DAYS: u64 = 90;
const MAX_FEATURED_ACTIVE: usize = 3;
// Config: #[serde(default)] pub featured_price_per_day_usd_e8s: Option<u64>  (None ⇒ const)
```
`admin_set_featured_price_usd(usd_e8s)` clones `admin_set_faucet_grant_usd` with rails ($1..$1000/day).
`get_featured_quote(token, days) -> Result<ExplorerQuote>` clones `get_explorer_quote` at the featured
price. **Refactor** `explorer_quote_amount` to take `price_per_day_usd_e8s` as a parameter so both quote
paths share it. Reuse `explorer_usd_rate_e8s`, `EXPLORER_QUOTE_TTL_NANOS`, `explorer_token_decimals`.

## 3. Lifecycle — ESCROW-UNTIL-APPROVAL (corrected after review; see [04 F1–F4](./04-adversarial-review.md))

> The first draft cloned `submit_dapp` (which charges to **treasury** at apply) yet recommended
> reserve-only — a contradiction. Resolved: funds stay on the **caller's escrow subaccount** while
> Pending; they sweep to treasury only **at approval**.

1. **Apply** — `apply_featured(listing_id, token, days)`: `require_authenticated` + explorer-enabled +
   `CallerGuard`. Verify caller owns an **Approved community** listing; **reject if the caller/listing
   already has an Active or Pending featured placement** (one-slot rule, F6); validate a fresh matching
   `FEATURED_QUOTES` entry; verify the deposit on `derive_explorer_subaccount(caller)` ≥ `amount + fee`
   **but do NOT move it to treasury** — funds stay on the escrow subaccount; insert
   `FeaturedDapp { status: Pending }`; remove the quote; `log_dapp_event("featured_apply", …)`.
2. **Approve** — `admin_approve_featured(id)`: **claim-before-await** — synchronously check
   `status == Pending`, enforce max-3 counting `Active + Approving` (§4), flip `Pending → Approving`;
   THEN `await` the escrow→treasury sweep of the held funds; on success set `Active`,
   `approved_at = starts_at = now`, `expires_at = now + days*DAY_NANOS`; on sweep failure revert to
   `Pending`; log. (The flip makes the cap race-safe despite the await — F2.)
3. **Reject** — `admin_reject_featured(id)`: clone `admin_reject_dapp` — claim status **before** the
   await, restore on `REFUND_FAILED`; refund the held escrow to the caller minus one ledger fee; status →
   Rejected (keep row for audit; guard re-entry on `status != Pending`).
4. **Expire** — `expire_featured()` (in `setup_timers` after `delete_expired_dapps()`): (a) flip Active
   rows past `expires_at` → Expired (premium already in treasury — kept, no refund); (b) **auto-refund any
   `Pending` row older than the 7-day TTL** via the reject-refund path (returns the caller's escrowed
   funds, −fee) so paid applications never park indefinitely (F3).

Plus: a **paid-but-listing-gone** guard — when `delete_expired_dapps`/reject deletes a `DappListing`,
force-expire (and pro-rata refund if Active) any featured row referencing it, and `get_featured_dapps`
skips + frees the slot for a vanished listing (F7).

## 4. Max-3 enforcement

**At approval time**, not apply time (apply is permissionless + would under-count on concurrent applies).
Because approval now sweeps escrow→treasury (an `await`), it is **not** a pure no-await body, so use
**claim-before-await**: in the synchronous pre-await step, count occupied = `status ∈ {Active, Approving}
&& (status == Approving || now <= expires_at)` and reject a 4th with `FEATURED_SLOTS_FULL`; then flip the
chosen row `Pending → Approving` (reserving the slot) **before** the `await`; revert to `Pending` if the
sweep fails. Two admins (or a double-click) cannot both reserve the last slot because the count+flip is
synchronous and atomic within one message. **Count predicate hard-requirement:** include `now <=
expires_at` so an expired-but-unswept Active row does NOT consume a slot (F5 — add a test for exactly
this). Surface the live count in the quote/info as a warning, never a payment block.

## 5. Random selection

`raw_rand` is **update-only** (`lottery_random_u64`, ~line 8406). The hero must render for anonymous
logged-out visitors → it must be a **query** → it **cannot** use server randomness. **Client-side random:**
the query returns the full active set; the browser picks one with `Math.random()` per page load. Nothing
of value rides on which of ≤3 shows, so client randomness is correct and keeps the endpoint a pure query.
(Rejected: time-bucket rotation — deterministic, drifts on its own; an update endpoint — breaks anon +
adds a consensus round to every page load.)

```rust
pub struct FeaturedView { pub featured: FeaturedDapp, pub listing: DappListing } // joined for the card
pub struct FeaturedInfo {
    pub active: Vec<FeaturedView>,
    pub slots_total: u32,            // 3
    pub slots_open: u32,             // 3 - active.len()
    pub price_per_day_usd_e8s: u64,  // for the advertise state
}
#[ic_cdk::query] fn get_featured_dapps() -> FeaturedInfo
```
Filter `Active && now <= expires_at` (defensive — expiry may lag the sweep); join each to its
`DappListing` (skip deleted). Empty `active` ⇒ UI shows the advertise state.

## 6. Methods

| Method | Kind | Auth | Reuse/new |
|---|---|---|---|
| `get_featured_quote(token, days)` | update | authenticated | clone of `get_explorer_quote` |
| `apply_featured(listing_id, token, days)` | update | auth + CallerGuard | clone of `submit_dapp` |
| `get_featured_dapps()` | **query** | **anonymous OK** | new |
| `admin_approve_featured(id)` | update | admin | clone + max-3 |
| `admin_reject_featured(id)` | update | admin | clone of `admin_reject_dapp` |
| `admin_remove_featured(id, override_floor)` | update | admin | new (force-expire Active; **pro-rata refund of unused days** per OD-7; gate behind `override_floor` ack when token is ICP since the refund is a treasury outflow and the ICP floor is otherwise bypassed — F4) |
| `list_pending_featured()` | query | admin (in-body `require_admin`) | new |
| `admin_set_featured_price_usd(usd_e8s)` | update | admin | clone of `admin_set_faucet_grant_usd` |

**Anonymous access:** `get_featured_dapps`/`list_pending_featured` are **queries** — `inspect_message`
only gates ingress *update* calls, so queries bypass it; **no `ANON_OK` entry needed** (only add one if an
endpoint is forced to be an update, as `get_lottery_info` is).

## 7. Persistence / upgrade / candid / tests

- **Upgrade-safe:** new Config field + `payment_block` use `#[serde(default)]`; new maps init empty on
  first post-upgrade (no migration). `FeaturedStatus` is a plain enum (append-only safe).
- **MemoryId ledger:** add a reservation comment (like the PB-308 header). Re-confirm 88/89/94 free at
  build (the unbuilt `nueron-sale`/`id-listings` specs also reserve ids on paper).
- **Candid:** add types + methods to the `.did`, regen frontend bindings (backend-canister-dev skill).
- **Tests (host unit + mock infra — `set_mock_caller`/`TEST_MOCK_CALLER`, mocked ledger, the
  `lottery_random_u64` test fallback):** quote math at featured price; apply rejects without quote / on
  insufficient deposit / non-owned listing; approve sets the window; **max-3** (4th → `FEATURED_SLOTS_FULL`);
  reject refunds + restores on failure; sweep flips Active→Expired; `get_featured_dapps` excludes expired
  + joins listings.

## Task list (ordered, phased)

**Phase 1 — data model**
1. Add `FeaturedStatus`, `FeaturedDapp` (+`impl_storable!`), `FeaturedView`, `FeaturedInfo`; comment-reserve
   MemoryId 88/89/94. *AC:* compiles; CandidType/Serialize/Deserialize derive. *(new)*
2. `FEATURED` (88), `NEXT_FEATURED_ID` (89, init 1), `FEATURED_QUOTES` (94) + `next_featured_id()`. *AC:*
   maps init; counter increments. *(reuse pattern)*

**Phase 2 — pricing/quote**
3. Constants + `Config.featured_price_per_day_usd_e8s` + `featured_price_per_day()`. *AC:* default resolves
   when None. *(reuse)*
4. Parameterize `explorer_quote_amount(price_per_day…)`; update the existing caller. *AC:* existing
   explorer tests pass. *(reuse, refactor)*
5. `admin_set_featured_price_usd` (rails $1..$1000/day). *AC:* out-of-range → `OUT_OF_RANGE`; non-admin
   rejected. *(reuse)*
6. `get_featured_quote` → `FEATURED_QUOTES`. *AC:* featured-priced amount; 15-min TTL. *(reuse)*

**Phase 3 — apply/escrow**
7. `apply_featured` (based on `submit_dapp` but **escrow-until-approval**): owns Approved community
   listing; **one-slot rule** (reject if caller/listing already has Active/Pending — F6); valid quote;
   verify escrow deposit ≥ amount+fee **but do NOT move to treasury**; insert Pending; remove quote; log.
   *AC:* no quote → `NO_QUOTE`; under-funded → `INSUFFICIENT_DEPOSIT`; non-owner/not-approved → error;
   second concurrent placement → `ALREADY_FEATURED`; success → id + funds still on escrow subaccount +
   Pending. *(adapt — not a verbatim clone)*

**Phase 4 — approval / max-3 / reject / remove**
8. `admin_approve_featured` (**claim-before-await**): sync check Pending + max-3 over `Active+Approving`
   with `now<=expires_at`; flip `Pending→Approving`; `await` escrow→treasury sweep; set Active+window on
   success, revert to Pending on sweep failure. *AC:* 4th → `FEATURED_SLOTS_FULL`; non-Pending →
   `NOT_PENDING`; two concurrent approvals can't both take the last slot; sweep failure leaves Pending +
   funds intact; expired-unswept row doesn't block. *(new)*
9. `admin_reject_featured` (claim-before-await + restore-on-fail; refund escrow −fee). *AC:* refund issued;
   restored on `REFUND_FAILED`; double-reject safe. *(reuse)*
10. `admin_remove_featured(id, override_floor)` (Active → Expired; **pro-rata refund unused days**, OD-7;
    ICP refund needs `override_floor` ack, F4). *AC:* removed row gone from `get_featured_dapps`; refund =
    premium × remaining_days/days − fee; ICP over-floor remove without ack → `TREASURY_FLOOR`. *(new)*

**Phase 5 — expiry sweep**
11. `expire_featured()` + wire into `setup_timers` after `delete_expired_dapps()`: flip Active past
    `expires_at` → Expired; **auto-refund Pending older than 7-day TTL** (F3); **handle paid-but-listing-
    gone** (force-expire/refund rows whose listing was deleted, F7). *AC:* expired drops from active set
    (treasury keeps premium); stale Pending auto-refunded; placement for a deleted listing freed/refunded.
    *(reuse sweep pattern + new)*

**Phase 6 — random-selection query**
12. `get_featured_dapps()` (join listings, filter expired, slots_open, price). *AC:* anon query returns
    data; empty when none; excludes deleted-listing rows. *(new)*
13. `list_pending_featured()` (in-body `require_admin`). *AC:* non-admin rejected; Pending only. *(reuse)*

**Phase 7 — frontend hero + slider** *(in `src/frontend/src/Explorer.tsx`)*
14. `FeaturedHero` + 2-card slider: call `get_featured_dapps`; client `Math.random()` pick; featured card +
    ad slider; advertise/empty state from `slots_open`/price; reuse `shuffleSeeded`/`freshSeed`. *AC:*
    renders logged-out; full-width; re-rolls per load; empty state shows pricing. *(new — frontend-dev anatomy)*
15. Apply-for-featured UI: quote → deposit → `apply_featured`; reuse the listing-submit deposit UX; "Your
    featured spots" strip. *AC:* paid flow completes; applicant sees pending/active/expired. *(reuse)*

**Phase 8 — admin UI**
16. Admin "Featured applications" queue: approve/reject/remove + price setter + "{n} of 3 live" + 3-cap
    guard on Approve. *AC:* approve respects max-3; reject refunds. *(reuse admin pattern)*

**Phase 9 — tests**
17. Host unit tests (see §7) **plus the review-driven cases:** claim-before-await prevents double-approve
    into the last slot; sweep-failure reverts Approving→Pending with funds intact; **expired-unswept row
    doesn't consume a slot at approve** (F5); one-slot rule rejects a 2nd placement (F6); 7-day Pending
    auto-refund (F3); pro-rata removal refund math + ICP-floor ack (F4); placement for a deleted listing is
    freed/refunded and skipped by `get_featured_dapps` (F7). *AC:* pass under `cargo test`. *(reuse mock infra)*
18. (Optional) PocketIC e2e apply→approve→expire. *AC:* per run-tests skill.

**Phase 10 — candid / deploy**
19. Update `.did` + regen bindings. *AC:* 8 methods exposed; frontend typechecks. *(reuse build)*
20. Local deploy + seed a featured placement + verify anon hero. **No mainnet deploy without an explicit
    ask.** *AC:* anon page shows hero locally. *(icp-local-deploy)*

## Open decisions

- **A** Quote map: **separate `FEATURED_QUOTES`** (prevents cross-spending a cheap quote on a premium slot).
- **B** Random: **client-side** (keeps the endpoint an anon query).
- **C** Reject disposition: **keep `Rejected` row + guard `status != Pending`** (audit symmetry).
- **D** Coupling: **separate map by own id**, referencing `listing_id` (independent lifecycle, re-feature).
- **E** Max duration: `FEATURED_MAX_DAYS = 90` — confirm with product (premium slots are typically short).
- (See README D1/D2 for admin-approval-vs-auto and the sold-out-funds question.)

## Key references (`src/backend/src/lib.rs`)
`submit_dapp` ~10174 · `admin_approve_dapp` ~10281 · `admin_reject_dapp` ~10305 · `delete_expired_dapps`
~9863 · `get_explorer_quote` ~10145 · `explorer_quote_amount` ~9402 · `explorer_usd_rate_e8s` ~9525 ·
`derive_explorer_subaccount` ~9372 · `get_explorer_deposit_address` ~10133 · `Config` ~403 ·
`admin_set_faucet_grant_usd` ~17053 · `setup_timers` ~4612 · `inspect_message`/`ANON_OK` ~742 ·
`lottery_random_u64` ~8406 · course `FeaturedSlot` (do not reuse) ~16142. Frontend hero:
`src/frontend/src/Explorer.tsx`; helpers `src/frontend/src/arcade/courseMarket.ts`.
