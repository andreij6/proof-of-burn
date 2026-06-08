# Review: Cooperative Neuron Pooling (Syndicate Mode)

Review of [`cooperative_neuron_pooling.md`](./cooperative_neuron_pooling.md), checked against the current backend code.

## Verdict
The concept is sound as a moat — pooling large neurons and steering them in lockstep is a real differentiator. But the plan has **one architectural contradiction**, **one critical accounting bug**, and **one redundancy** that need to be resolved before implementation. As written it would not work correctly.

---

## 🔴 Critical issues

### 1. Ownership binding is unsolved — and contradicts the Option C decision
The plan says (§1) the neuron need only add the **backend canister** as a hotkey, but then asserts "the caller's principal is the neuron's `controller` or in `hot_keys`." These don't connect:

- The **caller** is the user's *per-dapp Internet Identity principal* — the exact same problem that drove us to Option C. It will **never** be the neuron's controller (that's their NNS wallet principal) and won't be in `hot_keys` unless they explicitly add it.
- The canister-as-hotkey lets the canister *read* `get_full_neuron`, but proves nothing about **who is registering**. As written, anyone could register someone else's neuron (any neuron that has added the canister hotkey) and redirect its 25% pool payout to *their own* principal — a revenue-hijack vector.

**Fix:** require a **dual hotkey** — the canister principal (so we can read the neuron) **and** the caller's app-principal (so membership in `hot_keys` proves the registrant controls the neuron, since only the controller can add hotkeys). The plan must state this explicitly; "add the backend canister as a hotkey" alone is insecure. Note this is heavier UX than Option C — worth confirming you want to take that on for the high-value pool tier (it's defensible here because these are sophisticated whale users, unlike retail voters).

-- IF THE USER CAN ADD HOTKEY TO THE NUERON AND THE APP CAN READ FROM IT THAT SHOULD BE PROOF ENOUGH THAT THE USER OWNS THE NUERON.

### 2. The 25-way payout breaks the settlement fee/reserve math
Settlement is **per-commitment** (`lib.rs:1763` loops every commitment and calls `settle_burn_split` on each). Splitting 25% across the **top-25 neurons inside `settle_burn_split`** means **up to 25 ledger transfers per commitment**, every settlement:

- Today's deposit reserve is `target + 540_000` — it budgets **3** settlement transfers (30 000 e8s). Twenty-five-plus transfers need ~280 000 e8s of reserve. The escrow will be **underfunded and the saga will trap** mid-distribution.
- For small commits the fee overhead is absurd (a 0.1 ICP commit doing 25 transfers).

**Fix:** do the pool distribution **once per proposal in aggregate**, not per-commitment. Sum each proposal's total pool share after all commitments settle, then run a single top-25 payout. This keeps `settle_burn_split` doing only treasury+2×CMC (3 transfers, existing reserve holds) and isolates the 25-way fan-out to one proposal-level step. The plan currently folds it into `settle_burn_split` (§"Proposed Changes") — that's the bug.

### 3. Follow requirement makes multi-cast voting redundant (on Governance)
§1 requires each pool neuron to **follow the primary leader on the Governance topic**. But following on a topic means the neuron **auto-votes when the leader votes** — so the explicit `RegisterVote` multi-cast loop (§2) is redundant for Governance proposals and will often fail with "already voted." Pick one model:

- **Follow-based** (simplest): pool neurons follow the leader; you cast only the leader's vote and propagation is automatic. No multi-cast loop, no per-neuron failure handling. But only works for topics they follow.
- **Multi-cast** (explicit): drop the follow requirement, RegisterVote each neuron directly — works on any topic, but you lose the "follow" verification signal.

You can't cleanly have both. I'd lean follow-based for Governance with multi-cast as a fallback only for non-followed topics.

-- YES LETS GO WITH FOLLOW BASED

---

## 🟡 Medium

- **Economic-model copy churn.** This changes the split from 50/25/25 → **25/25/25/25** (with empty-pool fallback → treasury, so still effectively 50% treasury when empty). The UI copy was just reconciled to "50% treasury / 25% / 25%." If you adopt this plan, that copy and the `test_settlement_split_math` unit test change again. Worth sequencing so we don't churn twice.
- **Payouts land in app-scoped principals.** "Transfer to each neuron's `registered_by` principal" pays the *per-dapp* principal, withdrawable only via the Wallet modal — not their NNS wallet. Fine, but make the UI say so, or let them register a payout address.
- **NNS candid was removed.** The `Neuron`/`Followees`/`Result_2` types were deleted earlier. `get_full_neuron` needs them re-added — non-trivial; `get_full_neuron` returns a large structure.
- **Stale voting power.** Top-25 ranking uses VP cached at registration; a neuron can register high then dissolve. `fetch_leader_neuron_info` refresh (mentioned) must actually re-rank, and a dissolved/0-VP neuron should drop out of payouts.
- **Refund saga.** The failed-verification 125-ICP refund needs the same idempotent, persisted-block-index saga as settlement (recall the RefCell-borrow trap that broke all settlement). The plan doesn't call this out.

## 🟢 Minor / confirmed-OK
- `MemoryId::new(8)` is **free** (0–7 in use). ✓
- `is_local` verification bypass is consistent with the existing pattern. ✓
- 125 ICP barrier as an anti-fork moat and unbounded-`POOL_NEURONS` natural rate-limit: reasonable. ✓

---

## Recommendation
Three plan edits before any code:

1. Specify **dual-hotkey** binding in §1.
2. Move the top-25 distribution to a single **proposal-level** step, out of `settle_burn_split`, and recompute the deposit reserve.
3. Resolve **follow-vs-multicast** to one primary path.
