---
type: idea
title: "03 — Risks, gates & open questions"
tags: [ideas, ii-purchase]
timestamp: 2026-06-24T01:48:50-04:00
---

# 03 — Risks, gates & open questions

## The load-bearing gate (resolve before building)

**G0 — Does idgeek's sale contract settle by transferring/spawning the neuron with
`new_controller = <buyer principal>`?**

- If **YES** → Path A (fully programmatic). The canister is the buyer; idgeek hands it a
  neuron it controls; the canister folds it. This is the flow the user asked for.
- If **NO** (idgeek only hands over the II anchor credential to a human) → Path B
  (semi-manual operator). The canister crowdfunds, validates, escrows, and on-chain
  asserts the fold, but a human operator must take custody of the II anchor and run the
  two `Configure` ops (add hotkey + follow). The canister can't be an II principal.

**Why this is a gate and not a detail:** NNS controller immutability (R1) means there is
**no on-chain workaround**. No canister code can make idgeek hand a neuron to the canister
if idgeek's settlement model is "give the buyer the II anchor." The entire programmatic
ask collapses to this one external fact.

**Why it's unconfirmed:** idgeek's backend is a JS-rendered SPA with no published Candid
interface (candidate `cocmv-eiaaa-aaaah-qdbxq-cai`, UNCONFIRMED — same finding as
`/ideas/id-listings/01-idgeek-research.md`). It cannot be resolved by reading code.

**How to resolve it:** (a) ask the idgeek operator (Usergeek / geekfactory team) directly,
or (b) perform a small real-ICP test purchase on mainnet and inspect the settlement — does
the buyer receive a `created_neuron_id` with the buyer principal as controller, or does
the seller's II anchor get re-keyed to the buyer? Both are mainnet actions requiring the
user's explicit approval. **Do not build Path A on assumption.**

## R1 — NNS controller immutability (the wall behind the gate)

A neuron's controller is set at creation and never reassigned (confirmed against
`governance.did`; full enum list in `/ideas/nueron-sale/01-icp-research.md` §1). The canister
can become a controller only at neuron creation (`ClaimOrRefresh` `MemoAndController`, or
`Spawn`/`DisburseToNeuron` with `new_controller`). Implications:

- The app cannot take over an existing human-controlled neuron. Full stop.
- The syndicate fold works around this by *not* requiring controller change — it requires
  the controller to run `Configure` (hotkey + follow). So the syndicate fold needs the
  controller's cooperation (Path A: canister is the controller, trivial; Path B: operator
  is the controller, manual).
- The lottery fold **requires** the canister to be the controller (to
  `gov_disburse_maturity`). Path B cannot fold to lottery — only to syndicate.

**Mitigation:** none at the NNS layer. This is a protocol fact; the architecture is shaped
around it, not worked around.

## R2 — Discount/scam validation (the user's explicit requirement)

idgeek's value prop is "validate the contract is real, not a scam." The user wants this
leveraged. We implement the robust ICP-native equivalent (the "geekfactory method,"
`/ideas/id-listings/02-validation-method.md`): on-chain `canister_info` returns the sale
contract's certified `module_hash` + `controllers`, compared to admin-pinned expected
values. Severity if skipped: the canister escrows real ICP toward a malicious/changed
contract. Mitigations:

- **Validate before every pledge AND re-validate inside the locked settlement section**
  (TOCTOU — a listing could be swapped between validation and purchase).
- **Admin-pinned hashes are the trust root.** If idgeek upgrades its sale contract, the
  admin must re-pin or pledges route to a stale-validated listing. Surface "contract
  changed since validation" in the UI (`CONTROLLERS_MISMATCH` / `MODULE_HASH_MISMATCH`).
- **`canister_info` is any-canister-callable and returns certified data** — the verdict is
  canister-computed, not a trusted off-chain claim. This is stronger than idgeek's own
  UI-only validation.

**Residual:** module-hash + controller match proves *the contract is the one the admin
vetted*, not that the *listing* is fairly priced or the *neuron* is as described. A
legitimate contract can still list a low-value neuron at a high price. The "discount"
assessment is a human/admin judgment, not a trustless check — document it as admin
responsibility (the admin curates listings via `admin_create_ii_listing`).

## R3 — Path B operator custody risk (the neuron-sale buyer-safety problem,复发)

In Path B, after funds are released to the operator, the operator is the controller of the
acquired neuron until they `Configure` it toward the syndicate. During that window the
operator can hollow the neuron out — `disburse` / `spawn` maturity to themselves, or
`split` off the stake — leaving the syndicate with an empty shell. This is exactly the
buyer-safety problem `/ideas/nueron-sale/` spends its adversarial review on, and here it's
*worse*: in neuron-sale the canister is the permanent controller (safe custody); in Path
B the canister explicitly is **not** the controller during the custody window.

Mitigations (all imperfect):

- **Minimal custody window:** the operator must report the neuron_id + run `Configure`
  immediately; the canister asserts `HOTKEY_MISSING`/`NOT_FOLLOWING` at fold time. A
  dishonest operator is caught *if* they haven't disbursed first — but disbursement before
  fold is undetectable from the fold check alone.
- **Re-verify the neuron's stake + maturity inside the locked fold section** before
  accepting it — mirror neuron-sale's "re-verify economic state against the NNS
  immediately before ownership flips" (`/ideas/nueron-sale/README.md`). A neuron with zero
  maturity / reduced stake is rejected at fold.
- **Bond the operator:** the operator posts an ICP bond (or is a trusted admin) large
  enough to cover a worst-case hollow-out. The bond is slashed on a failed/rejected fold.
  This is the only mitigation that actually aligns incentives; it adds escrow surface.
- **Prefer Path A.** Path A eliminates R3 entirely (canister is the controller from
  creation; no custody window). This is the strongest argument for resolving G0 before
  building.

## R4 — Crowdfunding + refund

Pledges are escrowed per (caller, listing). If a listing is cancelled, never reaches its
price, or fails validation, pledges must be refundable. The 2026-06-20 generalized
`reclaim_escrow(EscrowKind::IIPurchase, key: Some(listing_id))` already provides this (the
CallerGuard mutex comes free; the subaccount derivation must match `pledge`). Risks:

- **Stranded pledges** if the canister is upgraded mid-escrow — the reclaim path is
  deliberately un-gated (same rationale as every other escrow kind) so recovery survives a
  kill switch. Verified by the escrow-fix test suite (295/0).
- **Over-funding:** if `raised > price`, the excess must be refunded (pro-rata) or rolled
  to the next listing. Default: pro-rata refund at settlement. Decide in `admin_cancel`
  vs `settle` semantics.

## R5 — Settlement TOCTOU + failed-settlement recovery

The idgeek settlement call is an inter-canister await with real ICP in flight. Between
"transfer ICP to idgeek" and "receive created_neuron_id" anything can fail (idgeek rejects,
network, canister trap). The saga must journal the ICP transfer block **before** the await
so a transient failure is recoverable — exactly the `renew_farmer` C2 fix pattern
(2026-06-20 escrow fix): journal `burn_block_index` before notify, let a sweep retry.
Without it, a failed settlement strands the purchase ICP at idgeek.

Mitigations:

- **Journal-before-await** on the idgeek transfer; a `ii_settlement_sweep` re-tries
  Settling listings (mirrors `xfarm_sweep`).
- **Idempotent settlement:** idgeek's purchase endpoint must be idempotent on retry (or
  the sweep must dedup on a nonce) — otherwise a retried settlement buys twice. This is
  an idgeek-contract-behavior question; if idgeek isn't idempotent, the sweep must
  *not* auto-retry — flag for manual admin resolution instead.
- **`TEST_IDGEEK_SETTLE_FAIL` seam** so the saga is unit-testable on host (same pattern as
  `TEST_XFARM_EXTEND_FAIL`).

## R6 — Securities / custody of II anchors (Path B)

In Path B the operator takes custody of an II anchor (a human login credential). Holding
II anchors that bundle NNS neurons on behalf of a crowdfunded pool is adjacent to
securities/custody concerns — the same flags raised in `/ideas/id-listings/` ("amplifies a
de-sanctioned neuron market; badge/prices = liability"). Path A avoids this (the canister
receives a neuron, not an anchor). Mitigations:

- Prefer Path A; if Path B, keep the operator to a small set of named admins (not open),
  document the custody role, and bond them (R3).
- The funding page must not look like a securities offering (no yield promises to
  pledgers; pledges are donations toward acquiring a neuron for the lottery/syndicate, not
  claims on the neuron). Copy review matters here — same lesson as the discussions-reward
  copy softening (recent commit `f7643af`).

## R7 — MemoryId conflict with FCM idea

Both this idea and `/ideas/lottery-fcm-reminder/` claim MemoryId 103. First built takes 103;
the other renumbers to 104. This is benign (both are dark/unbuilt) but must be reconciled at
build time — never silently reuse a live MemoryId. Mitigation: when the first of the two
ships, update the other's doc + the memory index.

## Build gates (must be true before shipping)

- [ ] **G0 resolved.** idgeek's sale-contract settlement model confirmed (Path A vs B) by a
      real probe or operator answer — not by assumption.
- [ ] `backend.did` regenerated + `bindings/` updated; `tsc -b` clean.
- [ ] `validate_idgeek_contract` runs on-chain via `canister_info`, compares to
      admin-pinned `expected_module_hash` + `expected_controllers`, and is re-run inside
      the locked settlement section (TOCTOU).
- [ ] `EscrowKind::IIPurchase` added; its `reclaim_escrow` subaccount derivation
      **byte-identical** to `pledge_ii_purchase`'s derivation (verified by a test that
      pledges then reclaims and checks the recovered amount == pledged − fee).
- [ ] `pledge_ii_purchase` rejects when `FLAG_II_PURCHASE` is off; `reclaim_ii_pledge`
      is un-gated (stranded-funds recovery, same as every other kind).
- [ ] Path A: `settle_ii_purchase` journals the ICP-transfer block before the idgeek await;
      `ii_settlement_sweep` retries Settling listings; `TEST_IDGEEK_SETTLE_FAIL` seam
      tested (failure → sweep recovers, no stranded funds).
- [ ] Path A: idgeek settlement idempotency confirmed OR sweep does not auto-retry
      (manual-admin path on non-idempotent contracts).
- [ ] Path B: operator bonded; `admin_confirm_syndicate_fold` re-verifies stake + maturity
      before accepting; failed/rejected fold slashes the bond.
- [ ] Frontend shows the validation badge (live `canister_info` hash vs pinned) per listing.
- [ ] Mainnet first-purchase is an explicit, user-approved, guarded admin action with
      throwaway ICP — never an auto-trigger.

## Open questions

### Q1 — Auto-settle vs admin-triggered settle

When `raised ≥ price`, should `settle_ii_purchase` auto-fire, or require an admin trigger?
Auto-fire is more "programmatic" (the user's ask) but commits real ICP to an external
contract without a human eye on the current idgeek state. **Recommendation: admin-triggered
for v1** (the admin has pinned the listing and watches validation; auto-settle is a v1.1
once the idgeek contract behavior is proven stable). The funding/pledge side is still fully
programmatic either way.

### Q2 — Fold target per listing, or global policy

Should each listing declare `fold_target: Lottery|Syndicate`, or should the app have a
global policy? **Recommendation: per-listing** — Path A can fold to lottery (canister is
controller), Path B cannot (must be syndicate); the admin setting it per listing keeps the
gate visible in the data. A listing pinned as `Lottery` under Path B is a config error the
admin_confirm step should reject.

### Q3 — Excess pledges: pro-rata refund vs roll-forward

When `raised > price`, refund the excess pro-rata, or roll it to the next listing?
**Recommendation: pro-rata refund at settlement** — simpler, no "next listing" assumption,
and pledgers get exact change back. Roll-forward is a v1.1 if pledgers prefer it.

### Q4 — Treasury contribution

Does the treasury auto-top-up listings short of their price, or only users pledge?
**Recommendation: treasury matches or tops-up only via an explicit admin action** (not
automatic) — automatic treasury spend on an external idgeek contract is too much
unattended risk for v1. The funding page can show "treasury has pledged X" as a normal
pledge row.

### Q5 — Build the validation method standalone first?

`validate_idgeek_contract` is ~40 lines and valuable independent of the purchase flow
(it's the "is this idgeek listing real" check the user asked for). **Recommendation: ship
it as a standalone "validate an idgeek listing" admin query first**, behind the flag, with
no money movement — a low-risk first increment that also de-risks the idgeek-contract
interface question (calling `canister_info` on the candidate idgeek canister is itself a
probe that informs G0).