# Course NFT — Secondary Market & Royalties (PB-307, Phase 2)

> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md) first.
> This spec depends on **PB-301** (course_nft canister: `custodial_transfer`,
> `icrc7_owner_of`) and **PB-305** (marketplace: `COURSE_LISTINGS`, MemoryId 77).
> It adds the buy/sell loop with an on-chain-enforced royalty split, modelled on
> the existing `settle_burn_split` saga (per-leg block-index idempotency, treasury
> fronts ledger fees, CMC cycle top-ups).

---

## A. Design / UX / behaviour

### A1. The loop this closes

Phase 1 mints courses, lists them, and accrues lottery tickets to the owner. Phase 2
lets an owner **sell** the earning rights and lets the original creator keep a
**permanent royalty** on every resale. Sales are ICP-denominated, fixed-price, and
mediated by the backend marketplace controller — there are no auctions or offers here.

### A2. Listing for sale

The current owner sets a fixed ICP price:

- `list_course_for_sale(token_id, price_e8s)` — owner-gated. Writes `price_e8s`
  and `for_sale = true` into the token's `COURSE_LISTINGS` row (MemoryId 77).
- `delist_course(token_id)` — owner-gated. Sets `for_sale = false`, clears `price_e8s`.
- A course that is **not** in `COURSE_LISTINGS` at all is not minted/known; delisting
  only flips the for-sale flag — the listing row (and its cached metadata for the
  marketplace browser) stays so the course remains *playable and ticket-accruing*.
  (Per the design docs, "listed" for marketplace visibility/ticket accrual is the
  PB-305 concept; "for sale" is the separate price flag this spec adds.)

Constraints:
- `price_e8s` must be `>= MIN_SALE_PRICE_E8S` (default `10_000_000` = 0.1 ICP) and
  `<= MAX_SALE_PRICE_E8S` (default `1_000_000_000_000` = 10,000 ICP) — guards against
  fat-finger dust sales that can't cover the 4 ledger fees, and absurd values.
- Owner check is resolved **live** via `course_nft.icrc7_owner_of(token_id)` at call
  time, not from the cached `COURSE_LISTINGS.owner` (which can be stale after an
  out-of-band `icrc7_transfer`). On mismatch, refresh the cached owner and proceed
  only if the caller is the live owner.

### A3. Purchase flow (the buyer's experience)

1. Buyer taps **Buy** on a listed-for-sale course card.
2. Frontend reads the live price, then calls `icrc2_approve` on the **ICP ledger**
   approving the backend canister as spender for `price_e8s + ICP_FEE` (a **single**
   pull into escrow). The approve UX mirrors `Payouts.tsx` / `Explorer.tsx`
   (`makeApprover(icpLedger).icrc2_approve(...)`).
3. Frontend calls `buy_course_nft(token_id)`.
4. Backend runs the **buy saga** (A4/A6, pure escrow): pulls the full `price_e8s` into
   a backend-controlled per-sale **escrow subaccount**, transfers the token
   seller→buyer via `course_nft.custodial_transfer` **first**, and only on success
   pays the four split legs **out of the escrow** and updates the listing. If the
   transfer fails, the escrowed funds are returned to the buyer — no treasury fronting
   of the price (review C3).
5. From settlement onward the buyer is the live owner and receives all play-based
   owner ticket credits (PB-306 resolves the owner at hole-2 completion time).

### A4. The split (on-chain enforced, seller cannot route around it)

Per the locked decision, every resale of `price_e8s` splits:

All legs are paid **out of the per-sale escrow subaccount** (after the NFT has moved),
never buyer→party directly — so a failed transfer refunds cleanly from escrow (A6/C3):

| Leg | Share | Destination | Mechanism |
|---|---|---|---|
| Seller | **75%** | live owner principal | ledger transfer escrow→seller |
| Creator royalty | **10%** | `creator` from NFT metadata | ledger transfer escrow→creator |
| Backend cycles | **5%** | backend canister via CMC | escrow→CMC top-up (backend) |
| Frontend cycles | **5%** | frontend canister via CMC | escrow→CMC top-up (frontend) |
| Treasury | **5%** | `TREASURY_SUBACCOUNT` | escrow→treasury (in-canister subaccount move) |

The buyer covers only one ledger fee (the pull into escrow, `price + ICP_FEE` approved);
the **treasury fronts the per-leg payout ledger fees** so each recipient nets the exact
bps share — identical to `settle_burn_split`. This is bounded (≤ 5 × 10k e8s), unlike
fronting the full price. (Review O1 — batching the two CMC cycle legs is deferred as a
protocol-wide optimization, not adopted per-feature; see [00 §9](00-overview-and-architecture.md).)

- The **creator** is read immutably from `course_nft.icrc7_token_metadata(token_id)`
  (or the `creator` cached in `COURSE_LISTINGS`, but verified against metadata on the
  first buy). The seller has no input into the creator address, so the royalty cannot
  be bypassed.
- **Edge case — seller IS the creator** (first resale by the minter): the 75% seller
  leg and 10% royalty leg both target the same principal. Pay them as two transfers
  (simpler, idempotent) OR coalesce into one 85% transfer (saves one fee). Decision:
  **coalesce** when `seller == creator` to save a ledger fee — but only the *transfer*
  is coalesced; the journal still records both `seller_block` and `royalty_block`
  pointing at the same block index so the idempotency logic is uniform.
- bps are computed off `price_e8s`: `seller=7500, royalty=1000, backend=500,
  frontend=500, treasury=500` (sums to 10000). Remainder from integer division goes
  to the treasury leg (computed last as `price - others`), exactly like
  `settle_burn_split`'s `frontend_amt = amount - treasury - backend`.

### A5. Concurrency / race handling (must-cover)

The buy saga spans multiple awaits; ownership and price can change underneath it.

- **Two buyers race the same token.** Take a `CallerGuard`-style per-token reentrancy
  lock (`BUY_LOCKS: token_id` in-flight set, heap-only). The second concurrent
  `buy_course_nft` returns `SaleInProgress`. After the first completes, the token is
  no longer for-sale (or owned by the new owner) so the second buyer's retry fails
  cleanly with `NotForSale`/`PriceChanged`.
- **Price change / delist mid-buy.** `buy_course_nft(token_id)` re-reads the listing
  *inside the lock* and binds the price at saga start into a `CourseSale` journal row
  (B2). The buyer's approve was for the price they saw; if the live price differs from
  the approved amount the saga aborts before pulling funds with `PriceChanged{ current }`
  (frontend re-approves). A delist between approve and call yields `NotForSale`.
- **Owner transferred out-of-band** (seller did `icrc7_transfer` to a third party, or
  sold via OTC). In the escrow model **payment happens after the NFT moves**, so a stale
  seller can never be paid: immediately before transferring, the saga resolves the live
  owner via `icrc7_owner_of` and calls `custodial_transfer(from=live_owner, to=buyer)`
  (PB-301 asserts `from == current owner`); the 75% leg then pays that same resolved
  owner. If ownership moves between resolution and transfer, `custodial_transfer`
  rejects, the saga **refunds the buyer from escrow** and returns `OwnershipChanged` —
  no split has been distributed yet (see A6).
- **Buyer == seller.** Reject with `CannotBuyOwnCourse` before pulling funds.

### A6. Atomicity guarantee (pure escrow — review C3)

Mirror `settle_burn_split`'s invariant — *a partial failure never loses funds and never
transfers the token without paying* — using a **pure escrow** ordering that keeps the
treasury off the hook for the principal. **Order: pull-to-escrow → transfer NFT →
pay-from-escrow.**

1. **Validate, then pull to escrow.** Inside the `BUY_LOCKS` lock (A5) re-read the
   listing and reject `PriceChanged` / `NotForSale` / `CannotBuyOwnCourse` *before*
   moving any money. Then `icrc2_transfer_from(buyer → escrow_sub)` for `price_e8s`,
   where `escrow_sub = derive_subaccount(buyer, token_id)`. The backend now custodies
   the exact funds. Journal `pull_block` on the `CourseSale` row.
2. **Transfer the NFT first.** Resolve the live owner, then
   `course_nft.custodial_transfer(from=live_owner, to=buyer)`. Journal `nft_done`.
3. **Pay the splits from escrow** (only after `nft_done`): seller 75% / creator 10% /
   treasury 5% / backend 5% / frontend 5%, each idempotent via its own block index on
   the `CourseSale` row, treasury fronting only the per-leg ledger fees. Then update the
   listing (owner→buyer, `for_sale=false`).

Failure handling:
- **Transfer (step 2) fails** (`OwnershipChanged`, course_nft unavailable, etc.):
  refund the escrow to the buyer (`escrow_sub → buyer`, journal `refund_block`,
  treasury fronts the single refund fee) and return the error. **The refund is 100%
  funded by the escrow — the treasury never fronts the price.** This closes the C3
  drain/liquidity vector: an attacker who forces a failed transfer can only get their
  own escrowed money back.
- **A payout leg (step 3) fails** after the NFT moved: never reverse (the buyer already
  owns the token). The saga is **resumable** — re-running skips completed legs by block
  index and pays the remaining legs from the still-held escrow; unpaid funds sit safely
  in escrow until the retry/sweep lands.
- A failure **between pull and transfer**: resumable — escrow holds the funds; the retry
  either completes the transfer+payout or (if the listing is gone) refunds from escrow.
- The `BUY_LOCKS` reentrancy guard (A5) serializes sagas per token so escrow rows and
  block indices never interleave.

### A7. Frontend buy UX

- Course card gains a **Buy — {fmtICP(price)}** button when `for_sale` and caller is
  not the owner; owner sees **List / Delist** controls instead.
- Buy click → modal: shows price, the four-way split breakdown (75/10/5/5/5), and a
  one-line "the creator earns 10% on every resale" note. Two steps with progress copy
  (mirror `Explorer.tsx` `subStep`): (1) "Approving {fmtICP(total)}…" (2) "Settling
  sale…". On success: "You now own {name} — it earns you a lottery ticket every time a
  player reaches hole 2."
- Errors surface the Result `Err` text verbatim in the existing error banner pattern;
  `PriceChanged` triggers a re-fetch + re-approve prompt.
- List flow: owner enters an ICP price (validated client-side against min/max), calls
  `list_course_for_sale`. Delist is a single confirm.

---

## B. Implementation

### B1. File map

- Backend: `src/backend/src/lib.rs`, new section banner
  `// ===== 20. Course NFT marketplace =====` (shared with PB-304/305/306/308/310;
  this spec adds the sale subsection). Reuse: `call_icrc2_transfer_from` (escrow pull),
  `derive_subaccount` (per-sale escrow subaccount), `call_cmc_topup_transfer`,
  `notify_cmc_topup`, `call_ledger_transfer` (escrow→legs and escrow→buyer refund),
  `call_ledger_balance`, `TREASURY_SUBACCOUNT`, `frontend_canister_id`, `get_config`,
  `require_authenticated`, `CallerGuard`, `impl_storable!`.
- Candid: `src/backend/backend.did` (hand-maintained) — add `CourseSale`-related
  types only if exposed; add the three methods + Result variants.
- course_nft crate: consumes `custodial_transfer(from, to, token_id)` and
  `icrc7_owner_of`/`icrc7_token_metadata` (defined by PB-301; this spec does not modify
  the crate beyond confirming `custodial_transfer` asserts `from == current owner`).
- Frontend: marketplace card + buy/list modal in the PB-305 marketplace page
  (`src/frontend/src/` flat page file, e.g. `CourseMarket.tsx`). Bindings regenerated
  from `backend.did`.

### B2. Data models

`COURSE_LISTINGS` (MemoryId 77, owned by PB-305) gains two fields — **add with
`#[serde(default)]`** for upgrade safety:

```rust
// extends PB-305's CourseListing
pub struct CourseListing {
    pub token_id: u64,
    pub owner: Principal,         // cached; payment always re-resolves live
    pub creator: Principal,       // cached from metadata (immutable)
    pub play_count: u64,
    pub par_total: u8,
    pub theme: u8,
    pub listed: bool,             // PB-305: marketplace visibility / ticket accrual
    #[serde(default)] pub for_sale: bool,       // PB-307
    #[serde(default)] pub price_e8s: u64,       // PB-307 (0 when not for sale)
}
```

New journal for buy-saga idempotency. **MemoryId 84** (assigned in the overview's
allocation table):

```rust
// MemoryId 84: COURSE_SALES: u64(token_id) -> CourseSale  (active/last sale per token)
pub struct CourseSale {
    pub token_id: u64,
    pub buyer: Principal,
    pub seller: Principal,        // resolved live immediately before transfer (A5/A6)
    pub creator: Principal,
    pub price_e8s: u64,
    pub started_at: u64,
    // escrow pull (step 1) — funds held in derive_subaccount(buyer, token_id)
    pub pull_block: Option<u64>,
    // NFT transfer (step 2) — happens BEFORE any payout
    pub transferred: bool,
    // payout legs from escrow (step 3); per-leg idempotency, mirrors Commitment/PoolNeuron
    pub seller_block: Option<u64>,
    pub royalty_block: Option<u64>,
    pub backend_cmc_block: Option<u64>,
    pub frontend_cmc_block: Option<u64>,
    pub treasury_block: Option<u64>,
    // refund path (set only when step 2 fails → escrow returned to buyer)
    pub refund_block: Option<u64>,
}
impl_storable!(CourseSale);
```

Heap-only reentrancy lock (not stable; cleared on upgrade is fine since a half-run saga
resumes from its journal):

```rust
thread_local! { static BUY_LOCKS: RefCell<BTreeSet<u64>> = const { RefCell::new(BTreeSet::new()) }; }
```

Constants:
```rust
const MIN_SALE_PRICE_E8S: u64 = 10_000_000;        // 0.1 ICP
const MAX_SALE_PRICE_E8S: u64 = 1_000_000_000_000; // 10,000 ICP
const COURSE_SALE_SELLER_BPS: u64 = 7_500;
const COURSE_SALE_ROYALTY_BPS: u64 = 1_000;
const COURSE_SALE_BACKEND_BPS: u64 = 500;
const COURSE_SALE_FRONTEND_BPS: u64 = 500;
// treasury = remainder
```

### B3. Endpoints

```rust
#[ic_cdk::update]
async fn list_course_for_sale(token_id: u64, price_e8s: u64) -> Result<(), String> {
    require_authenticated()?;
    require_course_market_enabled()?;            // FLAG_ARCADE_MINIGOLF / dedicated flag (PB-305)
    let caller = get_caller();
    if !(MIN_SALE_PRICE_E8S..=MAX_SALE_PRICE_E8S).contains(&price_e8s) {
        return Err("BAD_PRICE".into());
    }
    let owner = course_nft_owner_of(token_id).await?;   // live
    if owner != caller { return Err("NOT_OWNER".into()); }
    // upsert COURSE_LISTINGS row: owner=caller, for_sale=true, price_e8s
}

#[ic_cdk::update]
async fn delist_course(token_id: u64) -> Result<(), String> { /* owner-gated; for_sale=false, price_e8s=0 */ }

#[ic_cdk::update]
async fn buy_course_nft(token_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_course_market_enabled()?;
    let buyer = get_caller();
    // reentrancy lock on token_id (drop-guard); SaleInProgress if held
    // resume-or-create CourseSale journal:
    //   - read listing; NotForSale if !for_sale
    //   - resolve live seller via icrc7_owner_of; CannotBuyOwnCourse if seller==buyer
    //   - bind price; PriceChanged if listing price != journal price (re-approve)
    // run_buy_saga(&mut sale).await?  // idempotent legs (B4)
    // course_nft custodial_transfer(seller -> buyer); on reject => refund saga, OwnershipChanged
    // update listing: owner=buyer, for_sale=false, price_e8s=0
}
```

### B4. The buy saga (`run_buy_saga`) — mirrors `settle_burn_split`

```text
icp_ledger = config.ledger_canister_id;  fee = ICP_FEE_E8S (10_000)
seller_amt   = price * 7500 / 10000
royalty_amt  = price * 1000 / 10000
backend_amt  = price *  500 / 10000
frontend_amt = price *  500 / 10000
treasury_amt = price - seller_amt - royalty_amt - backend_amt - frontend_amt  // remainder

// 1. seller (75%)  — coalesce with royalty if seller==creator
if sale.seller_block.is_none() {
    sale.seller_block = Some(transfer_from(buyer -> seller_acct, seller_amt + (coalesced? royalty_amt:0)));
    persist(sale);
}
// 2. creator royalty (10%) — skipped/aliased when coalesced
if sale.royalty_block.is_none() {
    sale.royalty_block = Some(if coalesced { sale.seller_block } else { transfer_from(buyer -> creator_acct, royalty_amt) });
    persist(sale);
}
// 3. backend cycles (5%): transfer_from buyer -> backend escrow sub, then CMC top-up backend
//    (same CMC_REFUNDED -> drop block -> retry handling as settle_burn_split)
// 4. frontend cycles (5%): -> frontend canister via CMC
// 5. treasury (5%): transfer_from buyer -> TREASURY_SUBACCOUNT
// each leg: persist sale immediately after setting its block index (never run twice)
```

For the CMC legs, the buyer's approved funds are pulled to a dedicated escrow
subaccount (`derive_subaccount(&buyer, COURSE_CMC_SEED)` or the token's sale sub), then
`call_cmc_topup_transfer` + `notify_cmc_topup` run exactly as in `settle_burn_split`
(including the `CMC_REFUNDED → block=None → retry` recovery). This keeps the CMC legs
identical to the proven path rather than inventing a new top-up route.

Refund saga (only on `OwnershipChanged` after payment): pay `price` back to the buyer
from the treasury on the ICP ledger (treasury fronts it; `refund_block` idempotency),
matching `refundable_with_treasury_cover`'s balance-checked top-up so retries never
over-refund.

### B5. Candid (`backend.did`)

```candid
list_course_for_sale : (nat64, nat64) -> (Result);
delist_course        : (nat64) -> (Result);
buy_course_nft       : (nat64) -> (Result);
```

`Result = variant { Ok; Err : text }` already exists. Error strings (text payload,
matching repo convention of SCREAMING_SNAKE codes):
`NOT_OWNER`, `BAD_PRICE`, `NOT_FOR_SALE`, `PRICE_CHANGED`, `CANNOT_BUY_OWN_COURSE`,
`SALE_IN_PROGRESS`, `OWNERSHIP_CHANGED`, `PAYMENT_FAILED`, `FEATURE_DISABLED`,
plus the underlying ledger/CMC error strings propagated verbatim
(`TREASURY_XFER`, `BACKEND_CMC_NOTIFY`, etc., like `settle_burn_split`).

### B6. Acceptance criteria

- Owner can list (within price bounds) and delist; non-owner cannot.
- `buy_course_nft` pays exactly 75/10/5/5/5 of `price_e8s`; the seller's share goes to
  the **live** owner and the royalty to the **immutable** creator; seller cannot
  redirect the royalty.
- After a successful buy, `icrc7_owner_of` returns the buyer, the listing shows
  `for_sale=false`, and subsequent hole-2 completions credit the buyer (PB-306).
- A saga interrupted after any payment leg resumes without double-paying (each leg's
  block index gates it).
- A token transfer that fails post-payment refunds the buyer in full from the treasury
  and returns `OWNERSHIP_CHANGED`; the buyer never both loses funds and lacks the token.
- Two concurrent buys: one succeeds, the other gets `SALE_IN_PROGRESS` then
  `NOT_FOR_SALE`/`OWNERSHIP_CHANGED` on retry — never a double transfer or double charge.
- `seller == creator` first resale pays 85% in one (or two journaled) transfers correctly.

### B7. Test plan

Unit (host, `cargo test -p backend --lib`, using the existing native mock seams —
`call_icrc2_transfer_from`/`call_cmc_topup_transfer` are no-ops off-wasm; add a
`TEST_MOCK_*` toggle if a leg needs to simulate failure):
- split math sums to `price_e8s` for representative prices incl. odd remainders.
- **escrow ordering (C3):** payouts are journaled only *after* `transferred == true`;
  assert no leg block is set while `transferred` is false.
- idempotent resume: run saga, fail at each leg boundary, re-run, assert each block
  index set once and totals correct; pull is never repeated (`pull_block` set once).
- `seller==creator` coalescing.
- guards: non-owner list, buyer==seller, price-out-of-bounds, not-for-sale, price-changed —
  all reject **before** the escrow pull (no funds moved).
- **C3 refund safety:** force `custodial_transfer` to fail (mock) → assert the buyer is
  refunded the full `price_e8s` from the **escrow subaccount**, `refund_block` set once,
  **and the treasury balance is unchanged except for the one ledger fee** (i.e. the
  treasury never fronts the price). Assert escrow subaccount nets to ~0 after refund.

Integration (PocketIC, `cargo test -p course_nft` + cross-canister harness):
- end-to-end approve→buy→escrow pull→`custodial_transfer`→payouts with a real local ICP
  ledger + course_nft; assert balances of seller/creator/treasury and the new owner, and
  that the escrow subaccount is drained to ~0.
- out-of-band `icrc7_transfer` between approve and buy → `OWNERSHIP_CHANGED`, buyer
  refunded from escrow, treasury principal untouched.
- treasury-drain attack sim: attacker buys own course via puppet, moves NFT out-of-band
  pre-transfer → refund comes from escrow only; treasury liquid balance does not drop.

Manual local (`bash scripts/deploy-local.sh`, see `.claude/skills/icp-local-deploy`):
- mint (PB-304) → list → second identity approves + buys → verify ownership + tickets
  follow the new owner; verify the creator (first identity) received 10%.

### B8. Out of scope

- Auctions, best-offer, time-limited sales (fixed price only here).
- Multi-token sale pricing (sales are ICP-only; featured-slot bids are multi-token — PB-308).
- Featured slot (PB-308), ratings (PB-310), mint (PB-304), play/tickets (PB-306).
- ICRC-37 approval-based NFT transfers (D2: backend custodial transfer only).

### B9. Dependencies

- **PB-301** — `custodial_transfer(from,to,token_id)` (asserts `from`==owner),
  `icrc7_owner_of`, `icrc7_token_metadata` (immutable `creator`).
- **PB-305** — `COURSE_LISTINGS` (MemoryId 77), marketplace feature flag, card UI.
- **PB-306** — owner ticket credit resolves the live owner post-sale (no change needed).
- Reuses existing: `settle_burn_split` pattern, `call_icrc2_transfer_from` (PB-236/237),
  CMC top-up helpers, `TREASURY_SUBACCOUNT`, XRC not needed (ICP-denominated).
