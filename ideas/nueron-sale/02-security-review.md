# Neuron Sale — Adversarial Security Review

> Citation-backed threat model, prioritized by severity, with each threat mapped to the mitigation the
> design must carry. Sourced from current (2025-2026) DFINITY security guidance plus this project's own
> CMC root-cause record (`memory/feedback_cmc_topup.md`).

**Structural fact that drives everything:** the asset (a neuron the canister controls) and the payment
(ICP) live on **different ledgers/canisters**, and every cross-canister settlement step is a separate,
non-atomic message. Every "atomic split" is actually a multi-step saga that can trap, lose its response,
or interleave with another call.

## Top-priority remediation order

1. **Neuron mutation-lock for the entire listing window** (§4.1, §4.3) — without this the product is
   fundamentally unsafe; buyers can be sold hollowed-out neurons.
2. **Per-listing/per-bid state machine + locks released in `Drop`** (§1.1, §1.4, §3.2) — prevents
   double-spend, stale-accept, and permanently frozen listings.
3. **Escrow-at-bid custody + journaled, idempotent, block-index-keyed payout legs** (§2.1, §2.2, §3.1).
4. **CMC leg correctness** (§5) — TPUP memo, `nat64` block index, exact `NotifyError` handling,
   Refunded-clears / TooOld-doesn't. *This leg has already failed in this codebase's prod (PB-148).*
5. **Snapshot fee/split + bounded, fast-authenticated admin setters** (§6); reject self-dealing,
   zero/below-floor prices; remainder-to-seller rounding (§3.4, §3.6, §3.7).

## 1. Async / saga safety (the foundation)

The IC execution model: a single message is atomic; an `await` splits the call into separate messages;
a trap rolls back only the *current* message, **not** prior messages or already-dispatched calls;
interleaving calls have no reliable ordering (TOCTOU).

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 1.1 | Concurrent `accept`/`settle` on one listing interleave → neuron transferred twice or paid twice | **Critical** | Per-listing state machine (`Listed → Settling(locked) → Settled`); check-and-set the status guard **before the first `await`**; release via `Drop`. |
| 1.2 | Settlement traps mid-saga after ICP pulled but before seller paid / ownership flipped → funds or asset stranded | **Critical** | Journal each leg (escrow, treasury, cycles, seller, ownership-flip) with block indices; a sweep/retry resumes idempotently. |
| 1.3 | Response lost (`SYS_UNKNOWN`) on a ledger transfer → retry double-pays | **High** | Idempotent legs keyed by stored block index; on `SYS_UNKNOWN` query the ledger / re-notify rather than re-transfer. |
| 1.4 | Lock never released because a callback trapped → listing permanently frozen | **High** | Release locks in `Drop`/cleanup, not at the end of the happy path (mirror `BuyLock`). |

Sources: [inter-canister-calls](https://docs.internetcomputer.org/building-apps/security/inter-canister-calls) ·
[message-execution-properties](https://docs.internetcomputer.org/references/message-execution-properties) ·
[trapping](https://docs.internetcomputer.org/building-apps/canister-management/trapping) ·
[Breitner: How to audit an IC canister](https://www.joachim-breitner.de/blog/788-How_to_audit_an_Internet_Computer_canister)

## 2. Ledger / ICRC transfer pitfalls

Prefer an **escrow subaccount at bid time** over relying on a live `icrc2` allowance at accept-time: with
escrow the funds are already in the canister's custody when the bid is recorded, so accept is a pure
internal decision. The payout legs cannot be truly atomic — make them *atomic-ish*: pull into escrow
first, then journal + execute each leg idempotently.

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 2.1 | "Transfer succeeded but response lost" → double payout or double pull | **Critical** | Store block index per leg before the next; retry re-checks the index, never blindly re-transfers. |
| 2.2 | Relying on a live allowance at accept-time; buyer revokes/spends it first | **High** | Escrow-subaccount custody at bid time. |
| 2.3 | Forgetting the per-transfer fee on each of the 3–4 payout legs → escrow under-funded, last leg traps | **High** | Size escrow and the split for `fee × number_of_outbound_transfers`; charge listing fee net of fees. |
| 2.4 | Committing bid/sale to state before the transfer confirms | **High** | Mutate state only after the ledger call returns Ok. |

Sources: [ICRC-2 spec](https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-2/README.md) ·
[token_transfer_from sample](https://internetcomputer.org/docs/current/references/samples/motoko/token_transfer_from/)

## 3. Auction / bid-specific attacks

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 3.1 | Buyer's escrow drained between bid and accept (allowance model) → seller accepts an unpayable bid | **Critical** | Custodial escrow at bid time; settle from escrow, not a fresh pull. |
| 3.2 | Stale/withdrawn-bid accept race — buyer withdraws while `accept` is in flight; pre-`await` check is stale | **Critical** | Single state machine per bid; `withdraw` and `accept` compete for the same status CAS before any `await`. |
| 3.3 | Front-running the accept — seller raises price / cancels the moment a high bid lands | **High** | Atomic status transition; lock listing on accept; reject mutations once `Settling`. |
| 3.4 | Self-dealing — seller bids on own listing to wash-trade / reclaim for only the fee cost | **High** | Reject `bidder == seller`. |
| 3.5 | Griefing via many tiny / sybil bids — escrow-spam bloats state, DoSes the listing | **Med-High** | Minimum bid increment + bid floor + per-listing bid cap; the 2-ICP listing fee deters listing spam but bids need their own throttle. |
| 3.6 | Integer rounding on the 2%/1% split — truncation strands dust or sums > price | **High** | Compute treasury + cycles first; **seller = price − treasury − cycles − fees** (remainder). `checked_*`/`saturating_*`. |
| 3.7 | Fee-on-zero / tiny price — split underflows seller payout to negative | **High** | Enforce `price ≥ listing_fee + min_economic_amount`; reject zero/below-floor; `checked_sub` traps rather than wraps. |
| 3.8 | Listing-fee bypass — list/relist/cancel loops, or a path that creates a listing without charging | **Medium** | Charge the fee on the same call that creates the listing, behind a confirmed transfer; single creation entry point. |

## 4. Custodial ownership-transfer risk (the marketplace-specific hazard)

The asset is a neuron the *canister* controls; "ownership" is a map entry. The fundamental danger: the
buyer pays ICP for a row while the actual value can be silently extracted.

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 4.1 | **Seller hollows out the neuron after listing, before settlement** — disburse/spawn/split off the value; buyer gets an empty shell | **Critical** | On listing, **mutation-lock** the neuron: the canister is the sole path to neuron ops and must refuse every mutating op (disburse, spawn, split, merge, change-dissolve, disburse-maturity, configure following) for a listed neuron. |
| 4.2 | Value drift between list and settle (maturity accrues/disburses, dissolve delay decays) | **High** | Snapshot neuron attributes at accept; re-verify stake/maturity/dissolve-state against the NNS **inside the locked section** immediately before the ownership flip; abort if drifted beyond tolerance. |
| 4.3 | Buyer gets a hollowed neuron because verification happened before the seller's drain (TOCTOU) | **Critical** | 4.1 + 4.2 together: the neuron must be **mutation-locked for the whole listing**, not merely checked at accept. A check across an `await` without a lock is exploitable. |
| 4.4 | Canister upgrade / controller trust — whoever controls the canister can rewrite ownership or extract neurons; a bad upgrade can lose records | **Critical** | Document the trust assumption; put the canister under a transparent controller (blackhole/SNS/known multisig); ownership in stable structures; PocketIC upgrade tests; `pre/post_upgrade` must not trap. |
| 4.5 | Voting/reward leakage during listing — seller keeps following a leader to drain maturity to a spawn | **Med-High** | Define reward custody for the for-sale window; disable seller-configured following/auto-spawn while listed. |

**Invariant (restated):** from the moment a bid can be accepted until settlement completes, the neuron's
stake, maturity, dissolve state, and op surface must be frozen and verified by the canister, with the
seller having zero ability to mutate it. If that can't be guaranteed, the marketplace can defraud buyers.

Sources: [Neurons (learn.icp)](https://learn.internetcomputer.org/hc/en-us/articles/34084120668692-Neurons) ·
[Advanced neuron operations](https://internetcomputer.org/docs/building-apps/governing-apps/nns/using-the-nns-dapp/nns-dapp-advanced-neuron-operations)

## 5. Cycles conversion (the 1% ICP→cycles leg)

Treat the CMC call as the most fragile leg — it has a documented, already-hit failure chain in this very
project (PB-148). Use the newer `notify_top_up` flow (legacy `ledger_notify` deprecated mid-2025).

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 5.1 | Wrong memo / wrong `block_index` type → trap or permanent `Refunded`, settlement wedged | **Critical** | `MEMO_TOP_UP = 0x5055_5054` ("TPUP"); `block_index: u64` (a `nat` arg makes the CMC trap while *decoding*); a unit test that encodes the args and decodes all 5 real response variants. |
| 5.2 | `Refunded` re-notify loops forever (re-notifying a refused block returns memoized Refunded) | **High** | On `Refunded`, **clear the stored block index** so retry re-transfers; on `TransactionTooOld`, do **not** clear (funds still at CMC — clearing double-spends escrow). |
| 5.3 | Block ages past the notify window before retry → `TransactionTooOld` → manual recovery | **Medium** | Run the settlement sweep promptly; alert on `TransactionTooOld`. |

`NotifyError` real shape: `Refunded { block_index, reason }`, `InvalidTransaction`, `Processing`,
`TransactionTooOld(nat64)`, `Other`. The CMC memoizes per block (~1M-record window), so a lost response
is recoverable by **re-notifying**, not re-transferring.

Sources: [Deprecating ledger_notify for cmc_notify](https://forum.dfinity.org/t/deprecating-the-ledger-notify-flow-for-minting-cycles-in-favor-of-cmc-notify/42502) ·
[ICP stuck — memo 0 top-up failed](https://forum.dfinity.org/t/icp-stuck-in-wallet-canister-account-memo-0-top-up-failed/57201) ·
project record `memory/feedback_cmc_topup.md`.

## 6. Admin / config abuse (configurable listing fee)

| # | Threat | Severity | Mitigation |
|---|---|---|---|
| 6.1 | Fee change mid-saga — admin raises the fee/percent between a user's sign and the charge, extracting more than agreed | **High** | Snapshot fee/split into the listing/sale record at creation/accept; settlement uses the snapshot, never live config. |
| 6.2 | Unbounded fee — admin sets fee/percent to confiscatory or >100% values | **High** | Hard bounds in the setter (fee ≤ N ICP; each % ≤ small cap; treasury% + cycles% < 100); reject out-of-range with `checked` math. |
| 6.3 | Weak access control on setters — unauthenticated / late-checked admin methods | **High** | Authenticate at the top of every admin method (`require_admin`); explicit allowlist; consider `canister_inspect_message`. |

## Note to the user

The most severe, marketplace-specific risk (§4) has **no clean fix on the IC** — because a neuron's
controller can't be reassigned, you never actually "transfer" the neuron, only the canister's internal
claim. The product's integrity rests entirely on the canister being the sole, mutation-locking custodian
and on buyers trusting the canister's controller/upgrade authority. State that trust assumption
explicitly in user-facing copy and harden it (blackhole / SNS / known multisig controller).
