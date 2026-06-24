# 02 — Implementation

**This entire doc is conditional on the load-bearing gate (see `01` and `03`).** Do not
build the settlement step until idgeek's sale contract has been probed and confirmed to
either (Path A) support `new_controller = buyer` at settlement, or (Path B) only hand over
II-anchor credentials. The validation + funding-registry pieces are valuable regardless and
can ship first.

Line numbers approximate (2026-06-20) — verify before building. MemoryId **103** is next
free (102 highest in use); **conflicts with the FCM idea** (`ideas/lottery-fcm-reminder/`)
which also claims 103 — first built takes 103, the other renumbers to 104. Everything is
gated on a new `FLAG_II_PURCHASE` flag so it stays dark.

## Backend (`src/backend/src/lib.rs`)

### Funding registry — `II_LISTINGS` + `II_PLEDGES` (MemoryId 103, 104)

A listing is an admin-curated target (the app doesn't scrape idgeek; an admin pins a
listing id + price + expected validation hashes). A pledge is a user's escrowed ICP toward
a listing.

```rust
thread_local! {
    // MemoryId 103 — admin-curated purchase targets (if FCM took 103, use 104)
    static II_LISTINGS: StableBTreeMap<u64, IIListing, Memory> =
        StableBTreeMap::init(MemoryId::new(103));
    // MemoryId 104 — pledges keyed by (listing_id, pledger)
    static II_PLEDGES: StableBTreeMap<(u64, Principal), IIPledge, Memory> =
        StableBTreeMap::init(MemoryId::new(104));
}

pub struct IIListing {
    pub listing_id: u64,                 // idgeek sale-contract listing id (admin-pinned)
    pub idgeek_contract_id: Principal,   // the sale contract canister for this listing
    pub expected_module_hash: [u8; 32],   // admin-pinned expected Wasm hash (geekfactory method)
    pub expected_controllers: Vec<Principal>, // admin-pinned expected controller set
    pub price_e8s: u64,                   // asking price
    pub raised_e8s: u64,                  // running total of escrowed pledges
    pub status: IIStatus,                 // Open | Validated | Settling | Folded | Cancelled
    pub fold_target: FoldTarget,          // Lottery | Syndicate
    pub created_at: u64,
    pub acquired_neuron_id: Option<u64>,  // set on Path A settlement
    #[serde(default)] pub operator: Option<Principal>, // Path B: the human buyer
}

pub struct IIPledge {
    pub listing_id: u64,
    pub pledger: Principal,
    pub amount_e8s: u64,
    pub escrow_subaccount: [u8; 32],   // derived per (caller, listing) — reclaimable
    pub created_at: u64,
}
```

All new stored structs use `#[serde(default)]` on every added field for upgrade safety
(per the backend-canister-dev convention). MemoryIds 103/104 are never reused/renumbered.

### Validation — `validate_idgeek_contract` (reused from id-listings)

On-chain, any-canister-callable `canister_info(target) -> { module_hash, controllers, ... }`
(available in the repo's pinned `ic-cdk` 0.19). Compare returned `module_hash` and
`controllers` to the listing's admin-pinned `expected_*`. Verdict is canister-computed,
not a trusted off-chain assertion.

```rust
async fn validate_idgeek_contract(listing: &IIListing) -> Result<(), String> {
    let info = call_canister_info(listing.idgeek_contract_id).await?;
    if info.module_hash != Some(listing.expected_module_hash.to_vec()) {
        return Err("MODULE_HASH_MISMATCH".to_string());  // code changed → re-validate
    }
    if info.controllers != listing.expected_controllers {
        return Err("CONTROLLERS_MISMATCH".to_string());   // ownership changed → re-validate
    }
    Ok(())
}
```

This is the on-chain "validate that a contract is valid and not a scam" the user asked for.
Re-run it **immediately before settlement** (TOCTOU: a listing could be swapped between
validation and purchase — see R5). The admin-pinned hashes are the trust root; if idgeek
upgrades its sale contract, the admin re-pins.

### Endpoints (common to both paths)

```rust
#[ic_cdk::update]
async fn pledge_ii_purchase(listing_id: u64) -> Result<(), String>
//   require_authenticated(); CallerGuard; listing Open; validate_idgeek_contract();
//   derive escrow subaccount per (caller, listing); user transfers ICP in (pay-first);
//   record pledge; bump listing.raised_e8s. Reuses the pay-first-then-call escrow pattern.

#[ic_cdk::update]
async fn reclaim_ii_pledge(listing_id: u64) -> Result<u64, String>
//   reclaim_escrow(EscrowKind::IIPurchase, key: Some(listing_id)) — the 2026-06-20 generalized
//   reclaim already supports a new kind via the same CallerGuard mutex. Add an
//   EscrowKind::IIPurchase variant + its subaccount derivation (MUST match pledge's derivation).

#[ic_cdk::query]
fn get_ii_listings() -> Vec<IIListing>          // public — the funding page reads this
#[ic_cdk::query]
fn get_my_ii_pledges() -> Vec<IIPledge>          // caller's own

#[ic_cdk::update]
fn admin_create_ii_listing(target: IIListingInput) -> Result<u64, String>  // admin pins a target
#[ic_cdk::update]
fn admin_cancel_ii_listing(listing_id: u64) -> Result<(), String>          // refund all pledges
```

The escrow subaccount derivation for `IIPurchase` MUST equal the `reclaim_escrow`
derivation (same invariant the 2026-06-20 escrow fix established for every kind — table in
`docs/escrow-fix-review-2026-06-20.md`).

### Path A — programmatic settlement (gate = YES)

```rust
#[ic_cdk::update]
async fn settle_ii_purchase(listing_id: u64) -> Result<u64, String>
//   admin-triggered (or auto when raised ≥ price). Guard: listing Validated + raised ≥ price.
//   1. Re-run validate_idgeek_contract() (TOCTOU re-check inside the locked section).
//   2. transfer listing.price_e8s from escrow-pool → idgeek sale contract (buyer = canister).
//      journal the block BEFORE the await (saga pattern — recoverable on transient failure).
//   3. call idgeek sale-contract purchase endpoint with buyer = canister principal,
//      requesting new_controller = <canister> on settlement.
//   4. consume returned created_neuron_id.
//   5. fold_acquired_neuron(neuron_id, listing.fold_target).
//   6. mark listing Folded; audit-log. Excess pledges (raised − price) stay escrowed → refundable
//      or rolled to next listing (admin choice — default refund pro-rata).
```

The money leg mirrors `buy_course_nft` / `run_buy_saga` (treasury + cycles fee legs
optional — here the fee is the discount captured, not a percentage). The idgeek
sale-contract call is the only wasm-only-without-mock-seam piece — add a
`call_idgeek_settle` wrapper with a host stub + `TEST_IDGEEK_SETTLE_FAIL` seam so the saga
is unit-testable (same pattern as `xfarm_create_canister` / `xfarm_extend_farmer`).

### Path B — semi-manual operator (gate = NO)

```rust
#[ic_cdk::update]
async fn admin_release_purchase_funds(listing_id: u64, operator: Principal) -> Result<(), String>
//   admin sets listing.operator; validates contract once more; transfers listing.price_e8s
//   treasury → operator. Journals block. Marks listing Settling. The operator is now the
//   buyer of record on idgeek (manually, with their II).

#[ic_cdk::update]
async fn admin_confirm_syndicate_fold(neuron_id: u64, listing_id: u64) -> Result<(), String>
//   admin reports the operator's acquired neuron_id. Reuses create_pool_draft(neuron_id)
//   which asserts HOTKEY_MISSING (canister in hotkeys) + NOT_FOLLOWING (follows primary
//   leader) — the on-chain proof the operator actually Configured the neuron toward the
//   syndicate. If those fail, the funds were released but the fold didn't happen → R3.
//   On success: mark listing Folded; audit-log.
```

Path B reuses `create_pool_draft` verbatim for the fold — no new neuron-control code. The
**lottery fold is not available in Path B** (the canister isn't the controller, so it
can't `gov_disburse_maturity`); Path B listings must set `fold_target: Syndicate`.

### Fold dispatcher

```rust
async fn fold_acquired_neuron(neuron_id: u64, target: FoldTarget) -> Result<(), String> {
    match target {
        FoldTarget::Lottery => {
            // canister is controller (Path A only) → disburse maturity to LOTTERY_SUBACCOUNT
            gov_disburse_maturity(neuron_id).await?;
            // optionally add canister-as-hotkey + follow for syndicate voting too
        }
        FoldTarget::Syndicate => {
            // create_pool_draft asserts hotkey + follow; the canister running Configure
            // on its own freshly-spawned neuron (Path A) always passes.
            create_pool_draft(neuron_id).await?;
            finalize_pool_registration(neuron_id).await?;
        }
    }
    Ok(())
}
```

### Candid sync (`backend.did`)

Add `IIListing`, `IIPledge`, `IIStatus`, `FoldTarget` types; the `EscrowKind::IIPurchase`
variant; and the endpoints above. Regenerate `bindings/` (`npm run gen:bindings`).
`EscrowKind` gains a variant (Candid-compatible) and `reclaim_escrow` keeps its trailing
optional `key` — both safe per the 2026-06-20 escrow-fix analysis.

### Upgrade safety

- New maps 103/104 — never reuse/renumber; lazy init (empty on first upgrade, no
  `init`/`post_upgrade` seeding).
- Every new stored struct field is `#[serde(default)]` or `Option`.
- New `FLAG_II_PURCHASE` flag off by default; the whole feature is dark until the admin
  turns it on (mirrors `x_farm`, `discussions`, `early_adopters`).
- No existing struct mutated. Purely additive.

## Frontend (`src/frontend/src/`)

A new "II Purchase" / "Acquire neurons" page (or a section on the existing Participate
nav). Lists `get_ii_listings()`: each card shows the idgeek listing, asking price,
raised/total, fold target (Lottery/Syndicate), and a validation badge (✓ validated
on-chain / ⚠ hash mismatch). A "Pledge" button calls `pledge_ii_purchase` (pay-first
escrow, like the existing Dapp-Explorer listing flow). "My pledges" via
`get_my_ii_pledges`; "Reclaim" via `reclaim_ii_pledge`. Admin: a "Pin listing" form
(`admin_create_ii_listing`) and, for Path B, "Release funds" + "Confirm fold" buttons.

The validation badge is the trust signal to pledgers — it should show the pinned
expected hash vs the live `canister_info` hash so a pledger can see the contract hasn't
changed since the admin pinned it. (The frontend can also do an independent
`agent.readState` re-check per id-listings §3, but the on-chain verdict is authoritative.)

## Deploy

- Backend: `cargo build --target wasm32-unknown-unknown --release -p backend`, then
  `scripts/deploy-local.sh` for local smoke (NEVER mainnet without explicit ask).
- Frontend: `npm run build` (regenerates bindings).
- **The idgeek settlement integration cannot be smoke-tested locally** — idgeek's sale
  contract lives on mainnet. Path A's `settle_ii_purchase` against the real idgeek
  contract is a **mainnet-only** integration test and is therefore deploy-gated: it
  requires the user's explicit mainnet-deploy approval *and* small real ICP for a test
  purchase. Plan it as a guarded, admin-triggered first-purchase with a throwaway listing.

## Sizing

- Validation method: ~40 lines. Ship first, standalone.
- Funding registry + pledge/reclaim + listings: ~90 lines.
- Path A settlement + fold: ~90 lines + the `call_idgeek_settle` wasm/host seam.
- Path B release/confirm: ~50 lines (reuses `create_pool_draft` for fold).
- Frontend: ~120 lines.
- Total: **MEDIUM**, dominated by the (unconfirmed) idgeek settlement integration.