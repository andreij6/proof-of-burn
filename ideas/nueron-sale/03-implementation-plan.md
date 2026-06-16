# Neuron Sale — Implementation Plan & Codebase Reuse Map

> Concrete mapping against `src/backend/src/lib.rs` (line numbers as of 2026-06-15). The existing
> course-NFT secondary market is a complete, working reference implementation of an escrow sale saga
> with treasury + cycles fee legs — Neuron Sale reuses that *escrow/saga/CMC* core, but a Round-2
> red-team pass (see [`04-adversarial-review-round2.md`](./04-adversarial-review-round2.md)) showed the
> reuse covers only **~60%** of the real surface: the buyer **exit path**, the **full-multiplier
> re-verify** (the decode struct can't currently see age/dissolve state), and the
> **periodic-confirmation timer** are all **net-new scope**. Corrections from that pass are folded in
> below and flagged "(R2)".

## 1. The reference saga to clone: course-NFT secondary market

| Piece | Identifier | Location | Reuse |
|---|---|---|---|
| Entry point | `buy_course_nft` | `lib.rs:15130` | Clone as `accept_bid`/`settle_sale` shape |
| Saga engine | `run_buy_saga` | `lib.rs:15224` | Clone as `run_neuron_sale_saga` |
| Fee split | `compute_sale_split` / `SaleSplit` | `lib.rs:15088` / `15080` | Adapt to seller / treasury(2%) / cycles(1%) legs |
| Escrow subaccount | `sale_escrow_subaccount` | `lib.rs:15072` (`derive_subaccount(buyer, SALE_ESCROW_TAG ^ token_id)`) | New `NEURON_SALE_ESCROW_TAG`, **key by monotonic `bid_id` only** — NOT `(buyer, neuron_id)`, which collides across withdraw→re-bid (R2) |
| Journal struct | `CourseSale` | `lib.rs:14130` | New `NeuronSale` with the same `*_block: Option<u64>` legs |
| Journal map | `COURSE_SALES` (MemoryId 84) | `lib.rs:14105` | New `NEURON_SALES`, MemoryId **97+** (NOT 88-91 — see §6, R2) |
| Listing map | `COURSE_LISTINGS` (MemoryId 77) | `lib.rs:14085` | New `NEURON_LISTINGS` |
| Reentrancy lock | `BUY_LOCKS` + `BuyLock` (Drop-guard) | `lib.rs:14123` / `15116` | Clone as `SALE_LOCKS` + `SaleLock` |
| Refund path | `refund_escrow_to_buyer` | `lib.rs:15390` | Clone for losing-bid + failed-settlement refunds |
| Fee split BPS | `COURSE_SALE_*_BPS` | `lib.rs:13960-13963` | New `NEURON_SALE_TREASURY_BPS=200`, `NEURON_SALE_CYCLES_BPS=100` |

**Saga ordering to preserve** (from `run_buy_saga`): (1) confirm the winning bid's funds are in escrow
(pulled at bid time — re-confirm the balance); (2) **re-verify** the neuron against the NNS inside the
lock (see §3) then **flip the ownership row** (in-canister, no `await`) — the flip happens *after* funds
are confirmed in escrow, so a post-flip trap cannot strand the seller; (3) pay each leg **out of escrow**
idempotently keyed on its block index; persist the journal after every step so a trap/retry resumes.
**Losing-bid refunds are NOT a saga leg** — settlement marks them `Refundable`; a separate idempotent
`process_pending_bid_refunds()` sweep (mirror `process_pending_unstakes`, `lib.rs:7616`) drains them
keyed on a per-bid `refund_block` (R2 — one failed refund must never wedge the winner).

## 2. What feeds the sellable lane (decision D3)

The existing custody is **share-based tier staking** (`STAKES` MemoryId 20, `STAKING_POOLS` MemoryId 19),
which aggregates users into per-tier **pool neurons** — there is no discrete neuron to hand to a buyer.
So Neuron Sale needs a **discrete-custody lane**:

- **`OwnedNeuron`** record: `{ neuron_id, owner: Principal, minted_at, snapshot: NeuronSnapshot, status }`
  in a new `OWNED_NEURONS` StableBTreeMap (MemoryId 88+), keyed by `neuron_id`.
- A new deposit method (`mint_owned_neuron`) stakes ICP into a **discrete** canister-controlled neuron
  via the existing primitives:
  - `neuron_staking_subaccount(canister, nonce)` (`lib.rs:6697`) for the governance staking address,
  - `call_ledger_transfer` (`lib.rs:2080`) to fund it,
  - `gov_claim_or_refresh` (`lib.rs:6789`) to claim it controller=canister,
  - `gov_increase_dissolve_delay` (`lib.rs:6823`) + `gov_set_visibility` (`lib.rs:6846`).
- The owner is the beneficial owner; the canister is the NNS controller forever.

Alternative (out of scope v1): let an existing tier position be carved into a discrete neuron via
`gov_split`. More complex (share accounting) — defer.

**Cross-lane accounting invariant (R2).** `STAKES` (pool shares) and `OWNED_NEURONS` (discrete) share no
invariant today, so a desync can create value from nothing (e.g. a pool→discrete carve that doesn't
atomically decrement pool accounting). Enforce a single source of truth — *total custodied stake = Σ pool
neuron stakes + Σ `OwnedNeuron` stakes* — move stake atomically on mint/carve, and assert the invariant
in the PocketIC + upgrade test suite.

## 3. Neuron transfer = internal flip + NNS re-verify (NOT disburse)

The asset transfer is **not** `gov_disburse` — disburse requires full dissolution and destroys the
lock/age value being sold (research §4). Instead:

1. **Mutation-lock** (set on `list_neuron`): mark `OwnedNeuron.status = Listed`. The **authority is the
   stable `status` field**, not a heap lock (R2) — so it survives upgrades. Every mutating path must
   **refuse** when status is `Listed`/`Settling`: not only public endpoints (`unstake_owned_neuron`,
   disburse, spawn, split, configure-following) but **the interval timers and shared `gov_*` helpers**
   (`lib.rs:4613` 300s, `4635` 15s, sweeps) must `continue`/skip locked neurons. An endpoint-only guard
   misses the timers — the §4.1/§4.3 + R2-P2 fix.
2. **Extend the `Neuron` decode struct first (R2).** It currently (`lib.rs:46-67`) does **not** decode
   `dissolve_state` or `aging_since_timestamp_seconds`, so a seller flipping the neuron to dissolving
   (resetting the age bonus) passes a stake+maturity re-check undetected. Add those fields and snapshot
   the **full voting-power multiplier** (stake × dissolve-bonus × age-bonus) at `list_neuron` and on the
   accepted bid — not just stake+maturity.
3. At settlement, inside the locked section, **force a `ClaimOrRefresh`** (stake is *cached*), then
   **re-read** via `get_full_neuron` (`lib.rs:96`) + `neuron_voting_power` (`lib.rs:78`) and **abort if
   the full multiplier drifted** beyond tolerance.
4. **Flip** `OwnedNeuron.owner = buyer` (in-canister, atomic, no `await`).

> **NOTE — this is NOT `gov_disburse`.** Disburse requires full dissolution and destroys the lock/age
> value being sold (research §4). The transfer is the in-canister ownership flip above.

Reuse the neuron-read/verify helpers and the `set_mock_neuron` / `set_mock_neuron_for_id` /
`MOCK_GOV` test scaffolding (`lib.rs:120,127,6561`).

**Buyer exit is net-new scope (R2).** No existing endpoint withdraws a discrete custodied neuron —
`unstake`/`merge_unstake`/the sweep are all `STAKES`/pool-keyed (`lib.rs:7398,7510,7616`). Add
`unstake_owned_neuron(neuron_id, amount)`: gate on `OwnedNeuron.owner == caller` && `status == Owned`,
then `gov_split` → dissolve → `gov_disburse` to the **current owner**. Ship the exit before listing/bids.

## 4. Fee plumbing reuse

| Need | Reuse | Location |
|---|---|---|
| Treasury leg (2%) | move to `TREASURY_SUBACCOUNT` | `lib.rs:1705`; pattern in `settle_burn_split` `lib.rs:2450` |
| Cycles leg (1%) | `call_cmc_topup_transfer` + `notify_cmc_topup` for backend + `frontend_canister_id()` | `lib.rs:2229`, `2316` |
| Ledger transfer | `call_ledger_transfer` (handles mainnet/test) | `lib.rs:2080` |
| Treasury fronts bounded per-leg fees | `settle_burn_split` shortfall pattern | `lib.rs:2466-2486` |
| CMC correctness (PB-148) | `MEMO_TOP_UP=0x5055_5054`, `block_index:u64`, real `NotifyError`, Refunded-clears | `lib.rs:2217` + `memory/feedback_cmc_topup.md` |

`settle_burn_split` already does a 50/25/25 treasury/backend-cycles/frontend-cycles split with
idempotent block indices and treasury fee-fronting — the 2%/1% legs are a direct adaptation. Split the
1% cycles leg across backend + frontend canisters (mirror the existing two-CMC pattern).

**Rounding & floor (R2).** The cited `compute_sale_split` uses raw `*`/`-` and lets **treasury** absorb
the remainder; the README proposes the seller absorbing it (decision D2). Whichever is chosen: use
`checked_sub`/`saturating_sub` in the cloned split (the reference does **not** provide checked math),
enforce `price ≥ listing_fee_floor + Σ payout fees` **before** the subtraction, and bound the
neuron-sale price cap (neurons can be large). Because the 1% cycles leg is split across **two** CMC
sub-legs, the price floor must guarantee **each sub-leg ≥ CMC minimum + fee**, or the saga wedges on a
dust top-up. Unit-test the floor boundary.

## 5. Admin config (the configurable 2 ICP listing fee)

Follow the `admin_set_pool_fee` pattern (`lib.rs:1334`) and the `Config` struct (`lib.rs:403`,
StableCell MemoryId 0):

- Add `neuron_sale_listing_fee_e8s: u64` (default 2 ICP via a `default_*` fn + `#[serde(default = ...)]`).
- Add `neuron_sale_treasury_bps` / `neuron_sale_cycles_bps` (defaults 200 / 100, bounded).
- `admin_set_neuron_sale_fees(...)` with `require_admin` (`lib.rs:809`) + **hard bounds** (§6.2):
  fee ≤ cap, each bps ≤ cap, `treasury_bps + cycles_bps < 10_000`.
- **Snapshot** fee + bps into the listing at creation; settlement reads the snapshot (§6.1).

## 6. Persistence / upgrade safety

- `impl_storable!(NeuronSale)` / `impl_storable!(OwnedNeuron)` / `impl_storable!(NeuronListing)` /
  `impl_storable!(NeuronBid)` (macro at `lib.rs:608`).
- **MemoryId allocation (R2 — CORRECTED).** The first draft's 88-91 was wrong: a grep of every
  `MemoryId::new(n)` shows in-use IDs `…87, 90, 91, 92, 93, 96` — **90/91/92/93/96 belong to the Faucet**
  (`FAUCET_REGISTRATIONS`=90 … `FAUCET_GRANTS`=96, `lib.rs:16638+`). Reusing 90/91 would alias live
  stable memory → silent, upgrade-surviving corruption. **Free high IDs: only 88, 89, 94, 95, 97+.**
  Allocate a fresh contiguous block: **97 `OWNED_NEURONS`, 98 `NEURON_LISTINGS`, 99 `NEURON_BIDS`,
  100 `NEURON_SALES`.** Add a single source-of-truth MemoryId table comment and a debug-assert that IDs
  are unique.
- All future-extension fields `Option<T>` or `#[serde(default)]` for upgrade safety.
- `pre/post_upgrade` must not trap (it would brick ownership records — §4.4).

## 7. Phased build

- **Phase 0 — prerequisite (D6):** confirm/establish a hardened canister controller (blackhole / SNS /
  multisig). Without it the custody trust story is weak. Gate the feature behind a flag
  (`FEATURE_FLAGS`, `lib.rs:5039`) until then.
- **Phase 1 — discrete custody lane:** `OwnedNeuron` + `mint_owned_neuron` + `get_my_owned_neurons`.
  Wire the **mutation-lock** into every existing neuron-mutating endpoint.
- **Phase 2 — listing + fee:** `list_neuron` (charge snapshotted listing fee behind a confirmed
  transfer, set `Listed`, snapshot neuron), `cancel_listing` (decision D5 on fee refund).
- **Phase 3 — bids:** `place_bid` (escrow at bid time), `withdraw_bid` (refund), bid floor / increment /
  per-listing cap, reject `bidder == seller`.
- **Phase 4 — settlement saga:** `accept_bid` → state CAS `Listed→Settling` pre-`await` → `SaleLock`
  Drop-guard → `run_neuron_sale_saga` (re-verify, pay legs, flip owner, refund losers) → `Settled`.
- **Phase 5 — liveness (NET-NEW scope, R2):** there is **no** `RefreshVotingPower`, confirm-following
  timer, or `ChangeAutoStakeMaturity` anywhere in `lib.rs` today (grep-confirmed) — "the existing timer"
  does not do this. Build a confirm/refresh timer that keeps every `OwnedNeuron` alive every ≤6 months
  (research §6) or each silently decays to zero voting power and loses its followees at month 7. This is
  also a latent gap for the existing tier pool neurons. At `list_neuron`, also actively neutralize
  maturity drains: clear maturity-relevant followees and force `ChangeAutoStakeMaturity(false)`
  (the decode struct can't currently even read that flag).
- **Phase 6 — frontend:** new page following the established page anatomy (see `frontend-dev` skill);
  user-facing copy must state the custody/trust model honestly (see `ui-copy-in-sync` skill).

## 8. Test plan

Reuse the existing mock scaffolding:

- **Host unit tests** (`#[cfg(not(target_arch = "wasm32"))]`): `set_mock_neuron` / `set_mock_neuron_for_id`
  (`lib.rs:120,127`), `set_mock_manage_neuron` (`lib.rs:6769`), `MOCK_GOV` (`lib.rs:6561`),
  `set_mock_time` (`lib.rs:233`), mock ledger (`TEST_ACCT_ENABLED` / `acct_move`). Cover:
  saga idempotency (re-run after each leg, assert no double-spend), refund-on-abort, rounding
  (remainder-to-seller), self-deal rejection, price-floor underflow, fee snapshot vs config change,
  **mutation-lock blocks unstake/disburse on a listed neuron** (and that a **timer sweep skips** a
  `Listed`/`Settling` neuron — R2), **drift-abort when the neuron is flipped to dissolving** (requires
  the extended decode struct — R2), buyer-exit via `unstake_owned_neuron` for the *new* owner (R2),
  re-bid does not collide with a withdrawn bid's escrow (bid_id keying — R2), losing-bid refund failure
  does not wedge the winner (separate sweep — R2), bidder pays own refund fee, cross-lane stake invariant.
- **PocketIC integration** (`src/backend/tests/integration.rs`): full sale cycle with the real ledger +
  CMC `notify_top_up`, plus an **upgrade test** that asserts ownership records survive
  `pre/post_upgrade` (§4.4).
- Run via the `run-tests` skill before claiming anything works.

## 9. Candid / build

- Mirror new types + methods into `backend.did` (see `backend-canister-dev` skill for `.did` sync and
  upgrade-safety rules).
- Frontend candid bindings regenerate after the `.did` change.
