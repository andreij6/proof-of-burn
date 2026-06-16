# Neuron Sale — Adversarial Review, Round 2

> After the design docs (README + 01/02/03) were drafted, two independent red-team agents attacked the
> *written design* — one from an economic/custody-fraud angle, one from a saga/protocol-correctness
> angle — verifying claims directly against `src/backend/src/lib.rs`. This document consolidates their
> findings. **Several are corrections to errors in the original docs**; those have been patched in
> README.md and 03-implementation-plan.md, and each is flagged below with "(patched)".

The headline: the docs are strong on the *threat catalogue* (escrow, CMC, snapshotting, drop-guard
locks). The unmitigated risk is concentrated where Neuron Sale's surface **exceeds** the course-NFT saga
it clones — the live mutable neuron, the auction (many bids), the buyer's exit, and the value components
the code literally cannot read.

## P0 — Stable-memory corruption: proposed MemoryIds collide with the Faucet (patched)

The original plan proposed `88 OWNED_NEURONS, 89 NEURON_LISTINGS, 90 NEURON_BIDS, 91 NEURON_SALES`.
**Verified wrong:** a grep of every `MemoryId::new(n)` shows in-use IDs end at `…87, 90, 91, 92, 93, 96`
— **90/91/92/93/96 belong to the Faucet** (`FAUCET_REGISTRATIONS`=90 … `FAUCET_GRANTS`=96, `lib.rs:16638+`).
Mounting NEURON maps on 90/91 would alias the Faucet's stable regions → silent day-one cross-corruption,
surviving upgrades, effectively unrecoverable.

**Free high IDs:** only **88, 89, 94, 95, and 97+**. **Fix (patched into §6):** use a fresh contiguous
block **97–100** (`97 OWNED_NEURONS, 98 NEURON_LISTINGS, 99 NEURON_BIDS, 100 NEURON_SALES`) and add a
single source-of-truth MemoryId table comment + a debug-assert that IDs are unique.

## P1 (Critical) — The buyer's "exit via existing unstake" does not exist (patched)

The original docs told the buyer they realize value "via the existing unstake path." **Verified false:**
`unstake` (`lib.rs:7398`), `merge_unstake` (`7510`), and the pending-unstake sweep (`7616`) are all
**share/pool-keyed** — they require a `STAKES` row `(tier, caller)` and `gov_split` the *tier pool*
neuron. There is **no branch that takes a discrete `neuron_id`**. A buyer of `OwnedNeuron{9001}` has no
`STAKES` row and 9001 is not a pool neuron → `unstake()` returns `NO_STAKE`. **The product would sell an
asset with no realization path.**

**Fix (patched):** a discrete-neuron exit (`unstake_owned_neuron`: `gov_split` → dissolve → `gov_disburse`
to the *current* `OwnedNeuron.owner`, gated on `owner == caller`) is **net-new required scope**, not
reuse. Listing/bidding must not ship before the exit exists and is tested, or buyers are trapped.

## P1 (Critical) — The re-verify is blind to dissolve-state and age (patched)

The buyer-safety invariant rests on re-reading the neuron at settlement and aborting on drift. But the
project's `Neuron` decode struct (`lib.rs:46-67`) only carries `cached_neuron_stake_e8s`,
`maturity_e8s_equivalent`, voting power, hotkeys, followees — it does **not** decode `dissolve_state`,
`aging_since_timestamp_seconds`, or `created_timestamp_seconds`. The README sells "age bonus (the
genuinely non-recreatable value)" and "dissolve-delay lock," yet the re-verify **physically cannot see
either**.

Worked attack: list a non-dissolving, 4-yr-aged, 8-yr-delay neuron (≈2.5× multiplier); flip it to
`StartDissolving` before settlement → age resets to 1.0×, delay clock drains. Stake and maturity are
unchanged, so the re-verify **passes**; the buyer pays a 2.5× price for a 1.0× dissolving neuron. Also:
`cached_neuron_stake_e8s` is *cached* — only refreshed by `ClaimOrRefresh` — so an un-refreshed drain may
not even show reduced stake.

**Fix (patched):** extend the decode struct with `dissolve_state` + `aging_since_timestamp_seconds`;
force a `ClaimOrRefresh` before trusting stake; snapshot and compare the **full multiplier**, not just
stake+maturity. This is a prerequisite for the whole buyer-safety story.

## P1 (Critical) — The mutation-lock is app-layer only; the canister controller sits beneath it

`OwnedNeuron.status = Listed` only makes the *application's endpoints* refuse. The NNS controller is the
**canister**, and whoever controls the canister can call `manage_neuron` directly, ignoring any status
flag. The original docs filed canister-controller hardening as "open question D6 / Phase-0," not a gate.
Until the canister is genuinely blackholed/SNS/multisig, the dev controller can directly
disburse/spawn/split a *listed* neuron to themselves and let settlement complete — the exact §4.1 attack,
executed one layer below the lock.

**Fix (patched):** hardened/immutable controllership is a **blocking ship gate**, promoted out of D6.
By the docs' own invariant the feature is unsafe without it.

## P1 — Settlement ordering: README contradicted the impl-plan; README order was unsafe (patched)

The README lifecycle ordered settlement as *re-verify → pay legs → flip ownership → refund losers*; the
impl-plan (correctly, matching `run_buy_saga` at `lib.rs:15247-15381`) says **asset-transfer before
payout, funds escrowed first**. The safe, load-bearing order — now in both docs:

1. confirm the winning bid's funds are **in escrow** (they were pulled at bid time — re-confirm balance);
2. **re-verify** the neuron against the NNS (inside the lock);
3. **flip** the ownership row (in-canister, no `await`);
4. pay seller/treasury/cycles **out of escrow**, idempotently keyed on block index.

Because the price is fully escrowed *before* the flip, a post-flip trap on any payout leg cannot strand
the seller — retry resumes and pays from the same escrow. The README's old "pay then flip" order could
strand fees at the CMC with no journal leg to reclaim them.

## P1 — Losing-bid refunds inside the settlement saga wedge the winner (patched)

The course saga has exactly one buyer, so "refund losers" is brand-new surface. If refunds are saga legs,
one losing-bid refund that traps or returns `SYS_UNKNOWN` propagates `Err`, the journaled saga re-runs as
a unit, and the listing stays in `Settling` — **one griefing/unreachable bidder wedges the winner's
finalization**.

**Fix (patched):** settlement does **not** refund losers. It marks the winner `Settled` and losing bids
`Refundable`; a separate idempotent `process_pending_bid_refunds()` sweep (mirroring
`process_pending_unstakes`, `lib.rs:7616`) drains them keyed on a per-bid `refund_block`; buyers also keep
`withdraw_bid` as a pull path.

## P1 — Re-bid collides with a stale escrow subaccount (patched)

The course escrow is keyed `(buyer, token_id)` — safe because a token is bought once. For an auction a
buyer can **bid → withdraw → re-bid** on the same neuron; keying `(buyer, neuron_id)` reuses one
subaccount. If a withdraw refund traps/`SYS_UNKNOWN`, stale funds linger, and the re-bid's deposit lands
in the **same** subaccount → over/under-payment or the old refund double-spending the new bid.

**Fix (patched):** key escrow by **`bid_id`** (monotonic), never `(buyer, neuron_id)`; each bid gets a
fresh, never-reused subaccount drained to zero on withdraw. The "or `(buyer, neuron_id)`" option is
removed from the design.

## P2 — Mutation-lock must cover the timers, not just endpoints; authority = stable status (patched)

The interval timers (`lib.rs:4613` 300s, `4635` 15s) and sweeps call `gov_*` directly — they are **not
endpoints** and won't see an endpoint guard. Phase 5's planned auto-confirm/refresh timer *will* mutate
OwnedNeurons, including ones in `Settling`, re-introducing the §4.3 TOCTOU. Also: `SALE_LOCKS` (cloned
from the heap `BUY_LOCKS`, `lib.rs:14123`) is heap-only and wiped on upgrade — an upgrade mid-`Settling`
loses the heap mutex, and the first post-upgrade message could be a seller mutation before the saga
resumes.

**Fix (patched):** the lock's **authority is the stable `OwnedNeuron.status` field**, not the heap set.
Every mutating path — endpoints **and** timers/sweeps/shared `gov_*` helpers — must refuse / `continue`
when status ∈ {Listed, Settling}, read from stable storage. Heap `SALE_LOCKS` stays only as a fast
intra-message reentrancy guard. The re-verify `await` does not close TOCTOU by itself — only excluding
*all* mutators does.

## P2 (Economic) — Capital-lockup griefing + per-bid refund-fee drain (patched)

Bids escrow at bid time (good), but the original throttles only spam *count*. An attacker can max out
bids just under asking across listings to freeze price discovery, and loop bid→withdraw so the treasury
fronts a per-bid refund fee each time (a *per-bid* refund leg is unbounded in count, unlike the bounded
per-leg fronting the docs cite).

**Fix (patched):** the **bidder pays their own withdraw/refund fee out of escrow** (require
`bid_amount > 2×ledger_fee`); cap concurrent active bids **per bidder across all listings**; the treasury
never fronts per-bid refund fees.

## H/M — Economic & lifecycle findings (patched into README/impl-plan)

- **Mint-then-list sells fake "age/lock."** A freshly minted neuron has age 1.0× and a delay set seconds
  ago; marketing it as a non-recreatable aged/locked position is information-asymmetry fraud. Fix: surface
  *verifiable on-chain* age/maturity/delay in listings (needs the decode-struct fix); don't let copy
  imply value the canister can't prove.
- **Rounding: seller-absorbs-remainder inverts the cited reference** (`compute_sale_split` has *treasury*
  absorb it) and silently makes the seller eat all truncation + fees. Plus the **1% cycles leg is split
  across two canisters** — each sub-leg must independently clear CMC minimums, or the saga wedges on a
  dust top-up. Fix: decide D2 explicitly, show the seller their *net*, and set the price floor so each
  CMC sub-leg ≥ CMC_min + fee.
- **Cross-lane double-claim.** `STAKES` (pool shares) and `OWNED_NEURONS` (discrete) share no accounting
  invariant; a carve from pool→discrete that doesn't atomically decrement pool accounting creates value
  from nothing. Fix: a single source-of-truth invariant (total custodied stake = Σ pool + Σ owned),
  enforced atomically on mint/carve and asserted in the PocketIC/upgrade suite.
- **No periodic-confirmation machinery exists today.** Grep confirms no `RefreshVotingPower`,
  confirm-following timer, or `ChangeAutoStakeMaturity` anywhere in `lib.rs`. Phase 5's "ensure the
  existing timer covers it" is unbacked — it's **net-new scope**. Without it a custodied neuron held
  >7 months silently zeroes voting power and wipes followees.
- **Following-drain during listing is under-specified.** Disabling *new* seller config is insufficient:
  a followee set before listing, or an auto-stake-maturity flag (which the decode struct can't even
  read), can move maturity with no new seller action. Fix: at `list_neuron`, actively neutralize —
  clear maturity-relevant followees, force `ChangeAutoStakeMaturity(false)`, snapshot maturity
  immediately, re-verify it didn't drop at settlement.
- **`list_neuron` fee leg isn't journaled.** If `list_neuron` traps after the 2-ICP fee transfer but
  before `status=Listed` persists, the seller paid for nothing with no refund path. Fix: journal the
  listing-fee leg like any saga leg; decide D5 (non-refundable + relist cooldown recommended).
- **`checked_*` is claimed but the cloned `compute_sale_split` uses raw `*`/`-`.** Fix: actually use
  `checked_sub`/`saturating_sub` in the cloned split, enforce the price floor *before* the subtraction,
  and bound the neuron-sale price cap (neurons can be large).

## Claims the red-teams verified as SOUND (no action)

- CMC `Refunded`-clears / other-errors-keep-block, `MEMO_TOP_UP = 0x5055_5054`, `block_index: u64`
  (`settle_burn_split` 2515-2519/2545-2547, `notify_cmc_topup` 2333-2338) — design states these correctly.
- Treasury fee-fronting / escrow-shortfall top-up pattern — reuse claim sound.
- Drop-guard lock + journal-resume for the single-buyer happy path — sound as a pattern.
- Controller-can't-be-reassigned → custody is the only safe model — correct framing, matches the absence
  of any controller-change command in `call_manage_neuron`/`gov_*`.

## Net effect on readiness

After Round 2, the feature is **further from "reuse-and-ship" than the original docs implied.** Three
items are genuinely new, non-trivial scope the original plan under-counted: (1) the discrete-neuron
**exit path**, (2) the **decode-struct + full-multiplier re-verify**, and (3) the **periodic-confirmation
timer**. And two are hard gates: **immutable canister controllership** and the **MemoryId fix**. The
escrow/saga/CMC reuse story remains solid — but it covers maybe 60% of the real surface, not the ~90% the
first pass suggested.
