---
type: idea
title: "Neuron Sale — Feature Exploration"
tags: [ideas, nueron-sale]
timestamp: 2026-06-16T05:25:50-04:00
---

# Neuron Sale — Feature Exploration

> **Status:** Exploration / design proposal. Not built. Not scheduled.
> **Date:** 2026-06-15
> **Author:** drafted with a research + adversarial-review agent fan-out (see [`01-icp-research.md`](./01-icp-research.md), [`02-security-review.md`](./02-security-review.md), [`03-implementation-plan.md`](./03-implementation-plan.md)).
>
> **⚠️ Read [`04-adversarial-review-round2.md`](./04-adversarial-review-round2.md) too.** A second red-team
> pass found code-verified errors in the first draft (a MemoryId collision, a non-existent buyer exit
> path, a re-verify that's blind to the value being sold, an app-layer-only mutation-lock). Those are
> corrected below and detailed there. After Round 2 this is **further from "reuse-and-ship" than the
> sections below originally implied** — three items (buyer exit, full-multiplier re-verify,
> periodic-confirmation timer) are genuinely new scope.

## What was asked

> "Add the ability for users to sell their neuron safely to a buyer. Users can make bids
> below the asking price and the seller can choose to sell at the lower price if needed.
> The seller can post a neuron for a 2 ICP fee (configurable by the admin). Settled sales
> also incur a 2% fee to the treasury & a 1% fee to cycles for canisters. Make sure it is secure."

## TL;DR — the one fact that shapes everything

**You cannot transfer an NNS neuron.** A neuron's `controller` principal is set at creation and there
is **no `manage_neuron` command or `Configure` operation that changes it** — confirmed against the live
`governance.did` (full enum list in [`01-icp-research.md`](./01-icp-research.md) §1). The only on-chain
way to literally "hand over" a key-controlled neuron is to give the buyer the Internet Identity / seed
that *is* the controller — which is the **canonical neuron-sale scam vector** (the seller keeps a copy
and can re-take control and disburse after payment). DFINITY itself cites this as the reason native
neuron transfer doesn't exist.

**Therefore the only safe architecture is custody (the WaterNeuron pattern):**

- A **canister is the permanent controller** of every sellable neuron.
- "Ownership" is an **internal ledger entry** inside the canister, not an NNS controller.
- A "sale" is an **internal reassignment of that entry** + an escrowed ICP payout — the neuron's NNS
  controller never changes.

This project is already built exactly for this: the canister already custodies neurons
(`call_manage_neuron` with the canister as controller) and already runs an **escrow-based sale saga
with treasury + cycles fee legs** (`buy_course_nft` / `run_buy_saga`). Neuron Sale is that saga with
the asset-transfer step swapped from "move an NFT row" to "reassign a neuron-ownership row," plus a
hard **mutation-lock** on the neuron for the entire listing window.

## The core security problem (and the invariant that solves it)

Because the buyer is paying ICP for **a database row that points at a neuron the canister still
controls**, the worst attack is the seller (or anyone able to drive neuron ops) **hollowing out the
neuron after listing but before settlement** — `disburse`, `spawn` maturity to themselves, or `split`
off the stake — leaving the buyer with an empty shell.

> **Buyer-safety invariant (non-negotiable):**
> From the moment a listing is created until settlement completes (or the listing is cancelled), the
> neuron's stake, maturity, dissolve state, and *every* mutating operation must be **frozen by the
> canister, with the seller having zero ability to mutate it**, and its economic state must be
> **re-verified against the NNS inside the locked settlement section** immediately before ownership
> flips. A check across an `await` without a lock is exploitable (TOCTOU).

If that invariant cannot be guaranteed, the product can defraud buyers — do not ship it.

Three Round-2 findings make this invariant *harder* than the first draft assumed:

- **The lock's authority must be the stable `OwnedNeuron.status` field, not a heap lock**, and it must
  gate **the interval timers and shared `gov_*` helpers too** — not only the public endpoints. An
  endpoint-only guard misses the 300s/15s timers and is wiped on upgrade mid-`Settling`
  ([Round 2 P2](./04-adversarial-review-round2.md)).
- **The re-verify is currently blind to two of the four value components.** The project's `Neuron`
  decode struct does not decode `dissolve_state` or `aging_since_timestamp_seconds`, so a seller flipping
  the neuron to dissolving (resetting the age bonus) passes the stake+maturity re-check undetected. The
  decode struct must be extended and the **full voting-power multiplier** compared, not just stake+maturity
  ([Round 2 P1](./04-adversarial-review-round2.md)).
- **The app-layer lock does not bind the canister controller.** Whoever controls the canister can call
  `manage_neuron` directly beneath the status flag. So **immutable/hardened canister controllership
  (blackhole / SNS / multisig) is a hard ship gate, not the optional D6** it was first filed as
  ([Round 2 P1](./04-adversarial-review-round2.md)).

## What is actually for sale

A **discrete, canister-custodied neuron** with a single beneficial owner tracked in-canister. The unit
of trade is the **beneficial-ownership record**, which conveys claim to the neuron's:

- **stake** (the locked ICP),
- **accrued maturity** (unrealized voting rewards),
- **age bonus** (up to 1.25×, 4-year cap — the genuinely non-recreatable value),
- **dissolve-delay lock** (up to 2× — already-committed, buyer skips the wait).

> **Design decision (D1):** Neuron Sale operates on **discrete custodied neurons**, not on the existing
> share-based tier-staking positions (`STAKES`). The tier pools aggregate many users into one pool
> neuron, so there is no discrete neuron to hand over. Selling a tier position is **out of scope** for
> v1 (it would be a "transfer my shares" feature, not a neuron sale). See
> [`03-implementation-plan.md`](./03-implementation-plan.md) for how custodied neurons are minted into
> the sellable lane.

## Lifecycle

```
                 list_neuron (charge 2 ICP fee, mutation-lock neuron)
   [owned] ─────────────────────────────────────────────────────────▶ [Listed]
                                                                          │
                          place_bid (buyer escrows bid ICP)              │
   [Listed] ◀──────────────────────────────────────────────────────────┤
       │   buyer can withdraw_bid (refund escrow) any time pre-accept    │
       │                                                                 │
       │  accept_bid(bid_id)  — seller accepts asking-price OR a lower    │
       │  bid; atomic status CAS Listed→Settling before any await        │
       ▼                                                                 │
   [Settling] ── run_neuron_sale_saga (journaled, idempotent) ──┐        │
       │   1. confirm winning bid's funds are in escrow          │        │
       │      (pulled at bid time — re-confirm balance)          │        │
       │   2. re-verify neuron vs snapshot incl. dissolve-state  │        │
       │      & age (NNS read, inside the lock); abort on drift   │        │
       │   3. flip ownership record to buyer (in-canister, NO     │        │
       │      await) — only AFTER funds confirmed in escrow       │        │
       │   4. pay OUT OF ESCROW, idempotent per block index:      │        │
       │        2% → treasury subaccount                          │        │
       │        1% → cycles (CMC: backend + frontend sub-legs)    │        │
       │        seller = price − 2% − 1% − ledger fees (remainder)│        │
       │   5. mark Settled; mark losing bids Refundable           │        │
       ▼                                                          │        │
   [Settled] ◀────────────────────────────────────────────────── ┘        │
       │   losing bids drained by a SEPARATE idempotent sweep,             │
       │   process_pending_bid_refunds() — NOT a saga leg (a failed        │
       │   refund must never wedge the winner's settlement)                │
                                                                           │
   cancel_listing (seller, only while no accept in flight) ────────────────┘
       └─ marks all bids Refundable (swept), unlocks neuron, listing fee
          is NOT refunded
```

State machine, locks, and the journal mirror the existing `buy_course_nft` saga (mapped in
[`03-implementation-plan.md`](./03-implementation-plan.md) §1).

## Fee model

| Fee | Amount | When | Destination |
|---|---|---|---|
| **Listing fee** | **2 ICP**, admin-configurable (bounded) | charged at `list_neuron`, behind a confirmed transfer | treasury (non-refundable, deters spam) |
| **Treasury fee** | **2%** of settled price | at settlement | `TREASURY_SUBACCOUNT` (held as ICP) |
| **Cycles fee** | **1%** of settled price | at settlement | converted to cycles via CMC (backend + frontend canisters) |
| **Seller payout** | `price − 2% − 1% − ledger fees` (**remainder**) | at settlement | seller's account |

**Rounding rule (anti-dust / anti-overflow):** compute the treasury and cycles legs first, then
**give the seller the remainder** (`seller = price − treasury − cycles − fees`). Never compute the
seller leg independently — that's how rounding either strands dust or sums to more than the price. All
arithmetic uses `checked_*` / `saturating_*`. This matches `compute_sale_split`'s "treasury absorbs the
remainder" approach, inverted so the seller (not treasury) absorbs it here. (Decision **D2** — confirm
who absorbs rounding; see Open Questions.)

**Snapshotting:** the listing fee and the 2%/1% split percentages are **snapshotted into the listing
record at creation/accept** and settlement uses the snapshot, never the live config — so an admin fee
change can never extract more than the user agreed to (a TOCTOU-on-config hazard, §6 of the security
review).

**Price floor:** `price ≥ listing_fee + min_economic_amount` so the split can't underflow the seller to
a negative payout (`checked_sub` traps rather than wraps). Zero / below-floor prices and bids are
rejected.

## Bids below asking

- A listing has an **asking price**. Buyers may place bids **at or below** asking.
- Each bid **escrows the buyer's ICP** into a backend-controlled per-bid subaccount keyed by a
  monotonic **`bid_id`** (never `(buyer, neuron_id)` — that collides across withdraw→re-bid; see
  [Round 2 P1](./04-adversarial-review-round2.md)) **at bid time** (custodial escrow), so accept is a
  pure internal decision — not a fresh pull that could fail because the buyer revoked an allowance or
  spent the funds (§3.1 of the security review).
- The seller may `accept_bid` on **any** bid (including one below asking) — this is the "sell at a lower
  price if needed" requirement.
- Losing bids are **not** refunded inside the settlement saga (one failed refund would wedge the
  winner). Settlement marks them `Refundable`; a separate idempotent `process_pending_bid_refunds()`
  sweep drains them, and a buyer may `withdraw_bid` any time before their bid is accepted. **The bidder
  pays their own withdraw/refund ledger fee out of escrow** (`bid_amount > 2×fee`) — the treasury never
  fronts per-bid refund fees ([Round 2 P2](./04-adversarial-review-round2.md)).
- **Minimum bid increment + minimum bid floor + per-listing bid cap + a per-bidder cap across all
  listings** throttle griefing/sybil/capital-lockup spam.
- **Self-dealing rejected:** `bidder == seller` is refused (no wash-trading the neuron back to yourself
  for only the fee cost).

## Trust assumptions (state these to users explicitly)

The buyer is trusting **the canister and whoever controls it**, not just the seller:

1. The canister is the sole, mutation-locking custodian of the neuron (enforced in code).
2. Whoever controls the *canister* could, in principle, rewrite the ownership map or extract custodied
   neurons. This should be hardened — **blackhole / SNS / known multisig controller** — and stated in
   user-facing copy. (§4.4 of the security review.)
3. The custody canister must **auto-confirm following every ≤6 months** for every custodied neuron, or
   periodic-confirmation decay silently zeroes its voting power and wipes its followees at month 7
   ([`01-icp-research.md`](./01-icp-research.md) §6). This is an ongoing liveness obligation the timer
   must cover.

## How a buyer eventually exits custody

> **Round-2 correction:** there is **no existing unstake path** that works for a bought discrete neuron.
> `unstake`/`merge_unstake`/the pending-unstake sweep are all **share/pool-keyed** (`STAKES` `(tier,
> caller)` → split the *tier pool* neuron); none accepts a discrete `neuron_id`. A buyer of a discrete
> `OwnedNeuron` has no `STAKES` row, so `unstake()` returns `NO_STAKE`. **The exit is net-new required
> scope, not reuse** ([Round 2 P1](./04-adversarial-review-round2.md)).

Buying the ownership record does not require the buyer to ever leave custody — they can hold and accrue
rewards while the canister keeps controlling the neuron. To **realize value**, v1 must add a new
`unstake_owned_neuron(neuron_id, amount)` endpoint: gated on `OwnedNeuron.owner == caller` and
`status == Owned`, it `gov_split`s a child → dissolves → `gov_disburse`s to the **current beneficial
owner**. A true "take my neuron off-platform" exit (`Split` + `DisburseToNeuron { new_controller =
buyer }`) resets the child's dissolve delay to a fresh lock and its age to zero (research §4) — treat as
a later option. **Listing/bidding must not ship before the exit exists and is tested, or buyers are
trapped.**

## Open questions / decisions for the user

- **D2 — rounding beneficiary:** seller absorbs the remainder (proposed) vs treasury absorbs it.
- **D3 — what feeds the sellable lane:** do we let any existing custodied position become a discrete
  sellable neuron, or only neurons minted through a new "stake-to-own-a-neuron" deposit? (See
  [`03-implementation-plan.md`](./03-implementation-plan.md) §2.)
- **D4 — voting/rewards during the for-sale window:** who gets maturity accrued while listed — seller
  until settlement, or escrowed to the buyer? (Recommend: seller until settlement, and disable
  seller-configured following/auto-spawn while listed so it can't be used to drain maturity.)
- **D5 — listing fee on cancel:** non-refundable (proposed, deters list/relist spam) vs refunded on
  honest cancel.
- **D6 — canister controller hardening (now a HARD GATE, not just a question):** the app-layer
  mutation-lock does not bind the canister controller, so the feature is unsafe until the backend
  canister is under a blackhole/SNS/multisig controller. Confirm current controller status and treat
  hardening as a blocking prerequisite ([Round 2 P1](./04-adversarial-review-round2.md)).

## Files in this folder

- [`01-icp-research.md`](./01-icp-research.md) — NNS neuron mechanics, controller immutability, hotkeys,
  custody model, value components, periodic-confirmation decay, precedent & scams. Citation-backed.
- [`02-security-review.md`](./02-security-review.md) — adversarial threat model, prioritized, with
  mitigations mapped to the design.
- [`03-implementation-plan.md`](./03-implementation-plan.md) — concrete reuse map against the existing
  codebase (functions, structs, line numbers), phased build plan, and test plan. **(Corrected after
  Round 2 — MemoryIds, exit path, refund sweep, decode struct, liveness timer.)**
- [`04-adversarial-review-round2.md`](./04-adversarial-review-round2.md) — the two red-team passes against
  the written design, code-verified against `lib.rs`. **Read this before trusting the reuse estimates.**
