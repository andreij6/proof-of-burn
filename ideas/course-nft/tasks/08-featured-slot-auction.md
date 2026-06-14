# Course NFT — Featured Slot Auction (PB-308, Phase 3)

> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md) first.
> Depends on **PB-305** (marketplace + `COURSE_LISTINGS`, MemoryId 77). Uses
> `FEATURED_SLOT` (MemoryId 78), already allocated to this spec in the overview.
> Reuses the multi-token machinery from the Dapp Explorer (XRC oracle
> `explorer_usd_rate_e8s`, ck-token ledgers, `call_icrc2_transfer_from`,
> `call_icrc2_approve`, `TREASURY_SUBACCOUNT`).

---

## A. Design / UX / behaviour

### A1. What the featured slot is

A single course card pinned at the very top of every marketplace page load, above the
randomly-ordered pool (PB-305). It carries a **Featured** badge and no other mechanical
advantage. The slot is a perpetual highest-bid auction: held until someone outbids the
current holder. There is **one** slot globally.

### A2. Bidding

- `bid_featured_slot(token_id, token, amount)` — any authenticated user, any time.
- Accepted tokens: **ckBTC, ckETH, ckUSDT, ckUSDC only.** ICP is *not* accepted (locked
  decision). Reject `ExplorerToken::ICP` with `UNSUPPORTED_TOKEN`.
- Each bid's `amount` (token smallest-units) is converted to a **USD value** at bid time
  via the XRC oracle (`explorer_usd_rate_e8s`), so a ckBTC bid and a ckUSDC bid compete
  on equal footing.
- **A bid wins only if its USD value strictly exceeds the current holder's USD value.**
  Equal or lower → `BID_TOO_LOW` (with the current USD figure to beat).
- The bidder may feature *any* minted+listed course `token_id` — including a course they
  do not own (you can pay to promote any course). The course must exist in
  `COURSE_LISTINGS` and be `listed` (visible). Reject unknown/unlisted with `NOT_LISTABLE`.

### A3. Payment: 100% to treasury, non-refundable

- The full winning bid goes to the **treasury** (`TREASURY_SUBACCOUNT` on that token's
  ledger). No split, no cycles, no royalty — this is pure house revenue.
- **Non-refundable.** When a new bid displaces the current holder, the displaced holder
  gets **no refund** — their earlier bid was already collected and spent into the treasury.
  This is by design (locked): the slot is sold per-bid, not escrowed. There is therefore
  no "held funds" to return and no escrow accounting for displaced bids.
- Because each bid is collected immediately and irrevocably, the *only* persisted auction
  state is the current winner (token, bidder, amount, usd_value, time) — there is no
  bid history or pending-bid pool to manage.

### A4. Slot lifecycle when the featured course changes state

Decision (justified): **the slot is RETAINED, not cleared, if the featured course is
delisted, sold, or transferred while featured.**

Rationale:
- The bidder paid for *exposure of that course* and the money is already in the treasury
  and non-refundable. Clearing the slot on a delist would let the course owner grief the
  bidder (delist to nuke a rival's paid placement) at zero cost to themselves.
- Concretely:
  - **Course sold (PB-307) or transferred out-of-band:** the slot stays; the featured
    card simply reflects the new owner (the card reads live owner from `COURSE_LISTINGS`/
    `icrc7_owner_of`). The bidder paid to feature the *course*, which is unchanged.
  - **Course delisted (PB-307 `delist_course` / PB-305 unlist):** the featured card is
    still shown pinned (slot retained) but rendered in a "delisted — not currently for
    sale / not accruing tickets" state, OR (simpler) the marketplace shows the pinned
    card with its Play button disabled if the course is no longer playable. The slot is
    NOT vacated and a fresh bid is still required to displace it.
  - **Edge: course's listing row is hard-deleted** (only possible via an admin purge, not
    a normal flow): the slot's `token_id` would dangle. Guard the marketplace read to
    drop a featured card whose `token_id` no longer resolves, and let the next bid
    overwrite the cell. This is the single case where the slot effectively self-clears.
- Admin escape hatch: `admin_clear_featured_slot()` (require_admin) to vacate the cell
  for moderation (e.g. an abusive course name). No refund (consistent with A3).

### A5. UX

- **Marketplace top card** ("Featured" `Chip`/badge): shows the course as a normal card
  plus a small line: **"Featured bid to beat: ${usd}"** (formatted from `usd_value_e8s`).
- **Bid action** (a "Promote a course" control / a Bid button on any card): modal with
  - token selector (ckBTC / ckETH / ckUSDT / ckUSDC) reusing the Explorer's token chooser,
  - amount input in that token's units,
  - a live **USD preview** of the entered amount (client computes from a rate query, or
    the modal shows the server-confirmed value after submit),
  - the current **"to beat"** USD figure prominently displayed,
  - copy: "100% goes to the treasury and is non-refundable, even if you're later outbid."
- Two-step like other paid flows: (1) `icrc2_approve` the backend for `amount + token_fee`
  on the chosen token's ledger (mirror `Payouts.tsx` `makeApprover`), (2) call
  `bid_featured_slot`. On `BID_TOO_LOW`, show the returned current USD and let the user
  re-enter without re-approving if the new amount fits the existing allowance.
- A `get_featured_slot()` query feeds the pinned card and the "to beat" figure.

---

## B. Implementation

### B1. File map

- Backend `src/backend/src/lib.rs`, section `// ===== 20. Course NFT marketplace =====`
  (featured-slot subsection). Reuse: `explorer_usd_rate_e8s`, `explorer_token_ledger`,
  `explorer_token_fee`, `explorer_token_decimals`, `call_icrc2_transfer_from`,
  `TREASURY_SUBACCOUNT`, `require_authenticated`, `feature_visible`, `impl_storable!`.
- Candid `src/backend/backend.did`: add `FeaturedSlot` record, `bid_featured_slot`,
  `get_featured_slot`, `admin_clear_featured_slot`. `ExplorerToken` already exists.
- Frontend: featured card + bid modal in the PB-305 marketplace page. Bindings
  regenerated from `backend.did`.

### B2. Data model — `FEATURED_SLOT` (MemoryId 78)

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct FeaturedSlot {
    pub token_id: u64,
    pub bidder: Principal,
    pub token: ExplorerToken,     // ck-token only
    pub amount: u64,              // token smallest-units actually collected
    pub usd_value_e8s: u64,      // amount valued in USD (e8s) at bid time
    pub at: u64,                 // ns timestamp of the winning bid
}
impl_storable!(FeaturedSlot);

thread_local! {
    static FEATURED_SLOT: RefCell<StableCell<Option<FeaturedSlot>, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableCell::init(mm.borrow().get(MemoryId::new(78)), None).unwrap()
        ));
}
```

`Option<FeaturedSlot>` must implement `Storable` for the cell — wrap with the existing
`impl_storable!` pattern (the repo already uses `StableCell<Option<...>>`-style cells,
e.g. config cells) or store a sentinel; match whatever the codebase's existing
`StableCell` option-cell convention is.

USD valuation helper (reuses the oracle the Explorer uses):

```rust
/// USD (e8s) value of `amount` smallest-units of `token`, at the current oracle rate.
async fn token_amount_usd_e8s_live(token: ExplorerToken, amount: u64, cfg: &Config) -> Result<u64, String> {
    let rate = explorer_usd_rate_e8s(token, cfg).await?;       // USD-e8s per whole token
    let scale = 10u128.pow(explorer_token_decimals(token));
    Ok(u64::try_from((amount as u128) * (rate as u128) / scale).unwrap_or(u64::MAX))
}
```
(There is already a sync `token_amount_usd_e8s` for cached rates; the bid path should use
the **async, oracle-refreshing** form so the comparison uses a fresh rate, then store the
resolved `usd_value_e8s` so later "to beat" reads are free and stable.)

### B3. Endpoint

```rust
#[ic_cdk::update]
async fn bid_featured_slot(token_id: u64, token: ExplorerToken, amount: u64) -> Result<(), String> {
    require_authenticated()?;
    require_course_market_enabled()?;            // FLAG (PB-305); featured slot is Phase 3
    let bidder = get_caller();
    if matches!(token, ExplorerToken::ICP) { return Err("UNSUPPORTED_TOKEN".into()); }
    if amount == 0 { return Err("BAD_AMOUNT".into()); }

    // course must exist + be listed/visible
    let listing = COURSE_LISTINGS.with(|m| m.borrow().get(&token_id)).ok_or("NOT_LISTABLE")?;
    if !listing.listed { return Err("NOT_LISTABLE".into()); }

    let cfg = get_config();
    let usd = token_amount_usd_e8s_live(token, amount, &cfg).await?;

    // must strictly beat the current holder's USD value
    if let Some(cur) = FEATURED_SLOT.with(|c| c.borrow().get().clone()) {
        if usd <= cur.usd_value_e8s {
            return Err(format!("BID_TOO_LOW:{}", cur.usd_value_e8s));
        }
    }

    // collect 100% to treasury (idempotency: pull is a single transfer_from; see B4)
    let ledger = explorer_token_ledger(token, &cfg);
    let fee = explorer_token_fee(token, &cfg);
    let treasury = LedgerAccount { owner: get_canister_id(), subaccount: Some(TREASURY_SUBACCOUNT) };
    call_icrc2_transfer_from(ledger, bidder, treasury, amount.saturating_sub(fee), fee).await
        .map_err(|e| format!("PAYMENT_FAILED: {}", e))?;

    // win: overwrite the slot AFTER funds are collected
    FEATURED_SLOT.with(|c| c.borrow_mut().set(Some(FeaturedSlot {
        token_id, bidder, token, amount, usd_value_e8s: usd, at: current_time(),
    })));
    Ok(())
}

#[ic_cdk::query]
fn get_featured_slot() -> Option<FeaturedSlot> { /* drop if token_id no longer resolves */ }

#[ic_cdk::update(guard = "require_admin")]
fn admin_clear_featured_slot() -> Result<(), String> { FEATURED_SLOT.with(|c| c.borrow_mut().set(None)); Ok(()) }
```

### B4. Idempotency / safety notes

- Payment is a **single** `icrc2_transfer_from` (one leg), so there is no multi-leg saga
  to journal. The ordering invariant is: **collect funds first, then set the slot.** If
  the transfer fails, the slot is unchanged and the bidder lost nothing (allowance
  consumed only on success). If the transfer succeeds but the canister traps before
  `set`, the bidder paid without winning — to bound this, do `set` immediately after the
  `await` with no intervening awaits (the only failure window is a trap between the two,
  which is acceptable for a single non-refundable bid and matches the "non-refundable"
  policy; document it). No reentrancy lock needed because the worst case is two bids both
  succeeding and the higher one winning the `set` race — but to be safe, re-check
  `usd <= current` *after* collecting is unsafe (funds already taken). Instead: take a
  lightweight in-flight guard (`FEATURED_BID_LOCK` heap bool) so two concurrent bids
  serialize; the second re-reads the (possibly updated) current holder before collecting.
- The "to beat" comparison uses the **stored** `usd_value_e8s` of the prior winner, not a
  re-valuation of the prior bid's token (which would drift with the market). New bids are
  valued fresh; this is intentional — the holder locked in their USD value at their bid time.

### B5. Candid (`backend.did`)

```candid
type FeaturedSlot = record {
  token_id : nat64; bidder : principal; token : ExplorerToken;
  amount : nat64; usd_value_e8s : nat64; at : nat64;
};
bid_featured_slot        : (nat64, ExplorerToken, nat64) -> (Result);
get_featured_slot        : () -> (opt FeaturedSlot) query;
admin_clear_featured_slot: () -> (Result);
```

Error strings (text in `Result.Err`): `UNSUPPORTED_TOKEN`, `BAD_AMOUNT`, `NOT_LISTABLE`,
`BID_TOO_LOW:{usd_e8s}` (carries the figure to beat), `PAYMENT_FAILED: ...`,
`FEATURE_DISABLED`, plus XRC errors propagated (`XRC_ERROR`, `XRC_ZERO_RATE`) from the
valuation helper.

### B6. Acceptance criteria

- Only ck-tokens accepted; ICP rejected.
- A bid wins iff its fresh USD value strictly exceeds the stored current USD value;
  equal/lower returns `BID_TOO_LOW` carrying the current figure.
- On a win, exactly `amount` (minus one token fee) lands in the treasury on that token's
  ledger, and `FEATURED_SLOT` reflects the new winner.
- The displaced holder receives **no** refund and the slot does not escrow anything.
- `get_featured_slot` returns the current winner; the marketplace pins that course and
  shows the "to beat" USD figure.
- Delist/sell/transfer of the featured course does **not** vacate the slot (retained);
  only `admin_clear_featured_slot` or a dangling `token_id` clears it.
- ckBTC vs ckUSDC bids compare correctly in USD via the oracle.

### B7. Test plan

Unit (`cargo test -p backend --lib`; XRC uses the static fallback rates off-wasm,
`call_icrc2_transfer_from` is a no-op off-wasm):
- USD valuation across decimals (ckBTC 8, ckETH 18, ckUSDC/USDT 6) using the fallback
  rates; assert a 0.001 ckBTC bid beats a 50 ckUSDC bid, etc.
- strict-exceed rule (equal USD → `BID_TOO_LOW`).
- ICP rejected; unknown/unlisted token_id rejected.
- slot overwrite on a higher bid; admin clear; dangling token_id drop in `get_featured_slot`.

Integration (PocketIC with local ck-token ledgers):
- approve → bid → assert treasury balance increased and slot set.
- second higher bid displaces; first bidder gets nothing back; treasury holds both bids.
- featured course delisted (PB-307) → slot retained, card flagged.

Manual local (`deploy-local.sh`, ck-token ledgers seeded per `icp-local-deploy` skill):
- bid ckUSDC from identity A; outbid with ckBTC from identity B; verify pinned card and
  "to beat" figure; confirm no refund to A.

### B8. Out of scope

- Refunds / escrow for displaced holders (explicitly none).
- ICP or non-ck tokens; auctions with time limits or auto-extend; multiple slots.
- Bid history / analytics (only the current winner is persisted).
- Token→ICP conversion (bids are held as the bid token in the treasury, like Explorer
  fees; treasury withdrawal of ck-tokens is the existing admin path).
- Marketplace card layout/ordering (PB-305 owns it; this adds the pinned-card data).

### B9. Dependencies

- **PB-305** — `COURSE_LISTINGS` (MemoryId 77), marketplace page + card, feature flag.
- Reuses Dapp Explorer multi-token machinery: `explorer_usd_rate_e8s` (XRC oracle),
  `explorer_token_ledger`/`_fee`/`_decimals`, `call_icrc2_approve`,
  `call_icrc2_transfer_from`, `TREASURY_SUBACCOUNT`, `ExplorerToken`.
- Independent of PB-307 (buy/sell), PB-310 (ratings).
