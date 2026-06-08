# Cooperative Neuron Pooling (Syndicate Mode) — Final Implementation Plan

Supersedes [`cooperative_neuron_pooling.md`](./cooperative_neuron_pooling.md). Incorporates the review in [`opus-coop-feedback.md`](./opus-coop-feedback.md) and the owner's decisions on the three contested points.

## What this feature is
Today the app steers one hardcoded **primary leader neuron**. Syndicate Mode lets owners of large neurons **join a pool**: they pay an initiation fee and configure their neuron to follow the leader, and in return they share in protocol revenue. Because pool neurons *follow* the leader on the Governance topic, when the leader casts the app's conviction vote, every pool neuron **auto-votes the same way** — multiplying the app's effective voting power without any extra on-chain calls. This makes the app worth cooperating with rather than forking.

## Decisions locked in (from owner review)
1. **Ownership proof = canister hotkey, period.** If the user can add the backend canister as a hotkey on the neuron *and* the canister can read the neuron via `get_full_neuron`, that is accepted as sufficient proof of ownership. No second (caller) hotkey is required. We close the only practical abuse hole with **first-come binding** (below) — not with extra UX.
2. **Voting is follow-based.** Pool neurons follow the leader on Governance. We do **not** multi-cast `RegisterVote`. Vote propagation is native NNS following. `process_proposal_cutoff` is essentially unchanged.
3. **Initiation fee is admin-configurable** (default 125 ICP), stored in `Config`.

Remaining review issues resolved with the simplest reasonable approach — noted inline.

---

## 1. Data model

### `Config` additions (`lib.rs`, candid)
```
pool_initiation_fee_e8s : nat64   // default 12_500_000_000 (125 ICP)
```
- Settable via new admin endpoint `admin_set_pool_fee(nat64)`.
- `#[serde(default)]` on the Rust field so the upgrade is state-safe (CBOR field-map pattern already in use).

### New `PoolNeuron` record — `POOL_NEURONS` stable map at `MemoryId::new(8)` (confirmed free; 0–7 in use)
Key: `neuron_id : u64`. Value:
```
neuron_id        : nat64
registered_by    : principal   // the app-scoped principal that registered & receives payouts
voting_power      : nat64       // cached from get_full_neuron, refreshed periodically
status           : PoolStatus  // Draft | Active | Inactive
created_at       : nat64       // draft created (verified)
activated_at     : opt nat64   // fee paid
// fee-split saga idempotency (mirrors Commitment block fields):
treasury_block      : opt nat64
backend_cmc_block   : opt nat64
frontend_cmc_block  : opt nat64
```

`PoolStatus = variant { Draft; Active; Inactive }`:
- **Draft** — ownership (canister hotkey) and follow verified, but the initiation fee has **not** been paid yet. The user can leave and resume later. **Not** counted in voting power or payouts.
- **Active** — fee paid. Counted in the VP sum and eligible for the top-25 payout.
- **Inactive** — was Active, then the follow/hotkey broke or stake hit 0, or the owner left. Not counted (row kept for history).

Only **Active** neurons are summed into pooled voting power and receive revenue.

### `Proposal` additions
```
pool_distributed : bool   // #[serde(default)] — guards the one-shot pool payout (idempotency)
```
`total_burned_e8s : opt nat64` already exists and is the basis for the pool share.

### Cached pool stats
`CACHED_POOL_INFO` thread-local cell holding `{ total_pool_voting_power, active_count, updated_at }` for cheap header reads.

---

## 2. Join Pool flow — verify first, pay last

The owner's requirement: the user sets everything up and **the app verifies the hotkey + follow *before* any payment**. The initiation fee is the **final** step. If they leave before paying, the neuron persists in **Draft mode** so they can resume. This is a two-phase backend flow.

### Phase 1 — `create_pool_draft(neuron_id: u64) -> Result` (no payment)
1. `require_authenticated` + `CallerGuard`.
2. **First-come binding (abuse fix for decision #1):** if `neuron_id` already exists in `POOL_NEURONS` with a *different* `registered_by`, reject `ALREADY_REGISTERED`. A Draft reserves the neuron for that caller. (Creating a Draft already requires the canister hotkey to be present, which requires controller access — so a Draft is itself ownership proof. Residual race risk — a griefer drafting someone's neuron first — is accepted: it would still require them to have controller-level access to that neuron to pass verification.)
3. **Verification** (skipped when `config.is_local`, consistent with existing F-101/F-102 gating):
   - Call NNS Governance `get_full_neuron(neuron_id)`.
   - Assert `ic_cdk::id()` (backend canister principal) ∈ `neuron.hot_keys` → ownership proof (decision #1).
   - Assert `neuron.followees[Governance]` contains the primary leader neuron id → the follow requirement that makes auto-voting work. (Governance topic id = 4 — verify against the governance candid when re-adding types.)
   - Read `neuron.cached_neuron_stake_e8s` / voting power → store as `voting_power`.
4. On success: upsert `PoolNeuron { status: Draft, registered_by: caller, voting_power, created_at: now }`. Audit-log `pool_draft`. **No funds touched.**
5. On failure: return the error; nothing is stored beyond a possible prior draft. The UI keeps the user on the setup step to fix the hotkey/follow and re-verify.

### Phase 2 — `finalize_pool_registration(neuron_id: u64) -> Result` (the final, paid step)
Precondition: the caller already funded their registration escrow.
- `get_registration_address() -> LedgerAccount` (query): subaccount from `derive_subaccount(caller, REGISTRATION_SEED)`, distinct from commit escrow. User funds it with **`fee_e8s + 30_000`** (the 30_000 reserves the three fee-split ledger fees). UI shows e.g. "send 125.0003 ICP" (+ the 0.0001 their wallet pays to send).
1. Assert the caller owns a `Draft` (or `Inactive`) `PoolNeuron` for `neuron_id`; else `NO_DRAFT`.
2. **Re-verify** hotkey + follow via `get_full_neuron` (cheap; guards against the hotkey being pulled between draft and payment). Skipped when `is_local`.
3. Assert registration escrow balance ≥ `fee_e8s + 30_000`, else `INSUFFICIENT_DEPOSIT`.
4. Run the fee-split **saga** (same idempotent shape as `settle_burn_split`, guarded by the three `*_block` fields so a retry never double-spends):
   - 50% → treasury subaccount
   - 25% → backend canister cycles (ledger→CMC transfer + `notify_top_up`, target = `ic_cdk::id()`)
   - 25% → frontend canister cycles (target = `frontend_canister_id()`)
5. Set `status = Active`, `activated_at = now`. Refresh `CACHED_POOL_INFO`. Audit-log `pool_register`.

If verification at step 2 fails, **no funds move** — the deposit stays in escrow; the neuron stays a Draft to resume or the user reclaims via `refund_registration()`. This keeps the no-auto-refund-saga property (funds only move on a fully successful finalize).

### `refund_registration() -> Result`
Sends the caller's registration-escrow balance back to their wallet (single transfer, minus 0.0001 fee). Idempotent by construction (zero balance → `NOTHING_TO_REFUND`). Used when a user abandons a Draft after funding but before finalizing.

### `cancel_pool_draft(neuron_id) -> Result`
Caller must be `registered_by` and status `Draft`. Deletes the draft (frees the neuron for re-registration) and, if escrow funded, the user reclaims via `refund_registration`.

### `unregister_leader_neuron(neuron_id) -> Result`
Caller must be the `registered_by`, status `Active`. Sets status `Inactive` (kept for history). **Initiation fee is non-refundable.** Refresh `CACHED_POOL_INFO`.

---

## 3. Voting — follow-based (decision #2)
`process_proposal_cutoff` is **unchanged**: it casts the **leader** neuron's vote only. Pool neurons follow the leader on Governance, so they auto-vote in lockstep — no `RegisterVote` loop, no per-neuron failure handling, no "already voted" errors. The pool registry's job is verification, voting-power advertising, and revenue share.

---

## 4. Revenue share — treasury-funded, proposal-level (review issue #2, simplest fix)
**The per-commitment settlement path (`settle_burn_split`) is left completely unchanged** — still 50% treasury / 25% backend cycles / 25% frontend cycles, still 3 transfers, **no reserve or `required_deposit` change, no frontend fee change.** This avoids the 25-transfers-per-commitment trap entirely.

Pool rewards are paid **once per proposal, out of the treasury** that already holds the funds:

`distribute_pool_rewards(proposal_id)` — runs after a proposal is fully settled (hooked at the end of settlement / picked up by the existing sweep timer):
1. If `proposal.pool_distributed` → return (idempotent).
2. Set `pool_distributed = true` **first**, then transfer (bias toward never double-paying; a mid-trap leaves some payouts owed → admin manual recourse, logged to audit).
3. `pool_share = total_burned_e8s / 4` (25%).
4. Collect `active` pool neurons, sort by `voting_power` desc, take **top 25**, dedup.
5. If the set is empty → do nothing (treasury keeps the full 50%; effective split stays 50/25/25). Otherwise transfer `pool_share / n` (minus 0.0001 fee) from the **treasury subaccount** to each neuron's `registered_by` principal (default ICRC account). Log each payout.

Net effect when the pool is active: **25% treasury / 25% backend / 25% frontend / 25% pool**. When empty: unchanged 50/25/25. No hot-path risk because the expensive fan-out reads from an already-funded treasury, not from per-commitment escrow.

> Payouts land in the recipient's **app-scoped principal**, withdrawable via the existing Wallet modal — not their NNS wallet. The Join Pool modal and dashboard must state this. (Keeping it simple: no separate payout-address registration.)

---

## 5. Voting-power refresh & inactivation (review: stale VP)
Extend the periodic `fetch_leader_neuron_info` timer to also iterate `Active` `POOL_NEURONS` and re-`get_full_neuron` each:
- Update cached `voting_power`.
- If the canister hotkey was removed, the neuron no longer follows the leader, or stake/VP is 0 → set `status = Inactive` (excluded from the VP sum and from payouts; row stays for history). Drafts are left alone (they're re-verified at finalize).
- Recompute `CACHED_POOL_INFO`.

(To bound cycles, refresh in small batches if the pool grows large — a simple rotating cursor; not needed at launch volumes.)

---

## 6. Backend changes

### `lib.rs`
- `Config`: add `pool_initiation_fee_e8s` (+ default).
- Re-add the NNS Governance candid types needed for `get_full_neuron`: `NeuronId`, `Followees`, `Neuron` (fields: `hot_keys`, `controller`, `followees`, `cached_neuron_stake_e8s`, voting power), and the `Result`/`Ok` wrapper it returns. (These were removed with the old register/verify flow.)
- Add `PoolNeuron` + `impl_storable!`; `POOL_NEURONS` at `MemoryId::new(8)`; `CACHED_POOL_INFO` cell.
- `Proposal`: add `pool_distributed` (`#[serde(default)]`).
- New endpoints: `get_registration_address` (query), `create_pool_draft`, `finalize_pool_registration`, `cancel_pool_draft`, `unregister_leader_neuron`, `refund_registration`, `get_pool_info` (query — Active neurons + total VP), `get_my_pool_neuron` (query — caller's own Draft/Active/Inactive entry, for resume), `admin_set_pool_fee` (admin guard).
- `distribute_pool_rewards(pid)` + hook into settlement completion; extend the info-refresh timer (§5).
- **`settle_burn_split` and `process_proposal_cutoff` unchanged.**

### `backend.did`
- Add `PoolNeuron`/`PoolInfo` records, `pool_initiation_fee_e8s` on `Config`, `pool_distributed` on `Proposal`, and the new service methods above.

---

## 7. Frontend (`App.tsx`) — leader card + pool sidebar + setup wizard

### Leader neuron card (unchanged + one line)
Keep the existing leader card exactly as it is today. Append a single line:
**`+ {fmtVP(pooledVotingPower)} Pooled Voting Power`** (sum of `Active` pool neurons, from `get_pool_info`). When the pool is empty, hide the line (or show `+ 0`). The header/tagline total syndicate VP = leader VP + pooled VP.

### Pool sidebar (new) — right side, collapsible
- **Desktop:** a right-hand sidebar (collapsible to a thin rail with a chevron; remembers collapsed state). Main content reflows to the remaining width.
- **Mobile:** the sidebar is hidden behind a toggle (e.g. a "Pool" button / FAB); opening it **expands to full screen** as an overlay with a close button.
- **Top item is always the "Follow" button** (primary CTA) that launches the setup wizard for a new neuron.
- Below the button: the user's **own entry first** if they have one —
  - *Draft* → badge "Draft" + **"Resume setup"** (re-enters the wizard at the pay step).
  - *Active* → "You" badge + VP + a **"Leave pool"** action (→ `unregister_leader_neuron`).
  - *Inactive* → muted, with "Re-verify" (→ `create_pool_draft` again) / "Finalize".
- Then the list of other **Active** pool neurons: neuron id, voting power, and rank (top-25 highlighted as payout-eligible). Note that payouts land in the app wallet (withdraw via the Wallet modal).

### Setup wizard (verify before pay; fee is the final step)
Launched by the sidebar **Follow** button. Steps:
1. **Intro** — what pooling is, the live initiation fee (from `get_config().pool_initiation_fee_e8s`), and that payment is the last step.
2. **Configure & verify (free)** — instructions: (a) add the backend canister principal as a hotkey [show + copy it], (b) set the neuron to follow leader #`<id>` on the Governance topic in the NNS dapp [link out]. Enter `neuron_id` → **[Verify]** calls `create_pool_draft`. On success the neuron becomes a **Draft** and the wizard advances. On failure, show which check failed (hotkey missing / not following) and stay on this step.
3. **Pay initiation fee (final step)** — only reachable once a Draft exists. Show the registration address (`get_registration_address`) + amount (`fee + 0.0003 ICP`). User funds it from their wallet, then **[Finalize]** calls `finalize_pool_registration` (re-verifies, then runs the fee split). On success → **Active**, wizard closes, sidebar updates.
- **Abandon-safe:** closing the wizard at any point leaves the Draft in place (loaded via `get_my_pool_neuron`); the sidebar shows "Resume setup" to jump back to step 3. A **"Discard draft"** affordance calls `cancel_pool_draft` (+ `refund_registration` if they had funded).

### Copy update (review: economic churn)
The details/help/commit copy (just reconciled to "50% treasury / 25% / 25%") must describe the pool case too — e.g. "When the pool is active, settlement is split 25% treasury / 25% backend cycles / 25% frontend cycles / 25% to pool neurons; with no pool neurons it's 50% treasury / 25% / 25%." `test_settlement_split_math` is **not** changed (split fn unchanged); add a new test for the pool-distribution math instead.

---

## 8. Verification plan

### Automated (Rust unit + PocketIC)
- `create_pool_draft` verification: mock `get_full_neuron` → canister-in-hotkeys + follows-leader → Draft created; missing hotkey fails; missing follow fails; already-registered-to-other fails. Draft is **not** counted in VP/payouts.
- `finalize_pool_registration`: requires a Draft (NO_DRAFT otherwise), re-verifies, requires funded escrow, runs the fee split → Active; fee-split saga idempotency (retry doesn't double-spend) — mirror existing saga tests.
- `cancel_pool_draft` frees the neuron for re-registration; `refund_registration` returns escrow and is idempotent.
- `distribute_pool_rewards`: top-25 selection over **Active** neurons + equal split math; empty-pool → treasury keeps it (no transfer); `pool_distributed` flag prevents re-pay.
- Inactivation: follow-broken / 0-stake Active neuron → Inactive, drops from VP sum and payouts.
- Run: `cargo test -p backend` & `npm --prefix src/frontend run test`.

### Manual (local, `--identity anonymous`)
1. Open the sidebar → **Follow** → wizard. (Local skips NNS verification.)
2. Step 2 **Verify** → `create_pool_draft` → neuron appears as **Draft** in the sidebar.
3. Close the wizard; confirm the Draft persists and **Resume setup** returns to the pay step (`get_my_pool_neuron`).
4. Fund `get_registration_address` with `fee + 0.0003 ICP`; **Finalize** → confirm 50/25/25 fee split hits treasury + backend cycles + frontend cycles; neuron flips to **Active**; leader card shows "+ X Pooled Voting Power".
5. Settle a proposal with a non-empty pool → 25% pool share paid from treasury to the registered principal; treasury nets 25%. Empty pool → treasury keeps 50%.
6. `cancel_pool_draft` + `refund_registration`, and `unregister_leader_neuron` (→ Inactive) paths.
7. Mobile width: sidebar collapses to a toggle and opens full-screen.

---

## 9. Accepted trade-offs / open items
- **Ownership = canister hotkey + first-come binding** (owner decision). Drafting is now free, but `create_pool_draft` still requires the canister hotkey to be present, which requires controller access — so a Draft reservation still requires controlling the neuron. Residual race risk deemed not worth extra UX.
- **Pool payout idempotency is flag-based single-shot** (flag set before transfers). A mid-execution trap can leave some payouts owed → admin manual recourse via audit log. Chosen over per-payout block-index tracking for simplicity; revisit if pools get large.
- **Payouts go to app-scoped principals** (withdraw via Wallet), not NNS wallets. No separate payout-address feature at launch.
- Verify the **Governance topic id** (expected 4) against the re-added governance candid before shipping.
