---
type: review
title: "Escrow trapped-fund fixes — reviewer doc (2026-06-20)"
tags: [notes]
timestamp: 2026-06-20T04:38:29-04:00
---

# Escrow trapped-fund fixes — reviewer doc (2026-06-20)

Two fixes from the 2026-06-20 escrow audit (`/notes/duplication-review-2026-06-19.md`
adjacent; the audit identified 6 pay-first escrows with no reclaim path + a CMC
stranding bug in `renew_farmer`). Both are **backend-only**, behind no new feature
flag (reclaim is deliberately un-gated — stranded funds must stay recoverable after
a kill switch), and add **no new stable-structure maps or MemoryIds** (upgrade-safe).
X-Farm is still dark on mainnet; these are not deployed.

> Reviewer: focus on (1) the subaccount-derivation matches in Fix #1, (2) the
> in-flight guards in Fix #1, (3) the journal-before-notify ordering in Fix #2,
> and (4) the known limitation in Fix #2. Test names below are greppable.

---

## Fix #1 — generalize `reclaim_escrow` to all pay-first escrows

### What changed

`EscrowKind` gained 6 variants; `reclaim_escrow` gained a 3rd arg `key: Option<u64>`.

```rust
pub enum EscrowKind {
    Explorer, Arcade, EarlyAdopter,        // existing
    Featured, IdeaPost, Discussion, Stake, // new — per-principal (key ignored)
    Commitment, Project,                  // new — keyed (proposal_id / project_id)
}

#[ic_cdk::update]
async fn reclaim_escrow(
    kind: EscrowKind, token: ExplorerToken, key: Option<u64>,
) -> Result<u64, String>
```

### The mapping (review this — each reclaim derivation MUST equal the consume derivation)

| Kind | Reclaim derives | Consume method derives the escrow with | Match? |
|---|---|---|---|
| Explorer | `derive_explorer_subaccount(&caller)` | `apply_dapp` / `submit_dapp` (lib.rs:10366) | ✅ |
| Arcade | `derive_arcade_subaccount(&caller)` | `customize_character` (lib.rs:12228) | ✅ |
| EarlyAdopter | `derive_early_adopter_subaccount(&caller)` | `early_adopter_stake` (lib.rs:12897) | ✅ |
| Featured | `derive_featured_subaccount(&caller)` | `apply_featured` (lib.rs:11452, used 11547/11617) | ✅ |
| IdeaPost | `derive_idea_subaccount(&caller, IDEA_POST_SEED)` | `post_idea` (lib.rs:5585 uses `IDEA_POST_SEED`) | ✅ |
| Discussion | `derive_discussion_subaccount(&caller)` | `start_thread` (lib.rs:5857) | ✅ |
| Stake | `derive_subaccount(&caller, STAKE_SEED)` | `stake` (lib.rs:7989/8023) | ✅ |
| Commitment | `derive_subaccount(&caller, proposal_id)` | commit flow (lib.rs:2588/3085) | ✅ |
| Project | `derive_project_subaccount(&caller, project_id)` | `fund_project` (lib.rs:6733/6791) | ✅ |

If a derivation mismatches, reclaim would read the wrong subaccount and either
find nothing (`NOTHING_TO_RECLAIM`) or — worse — sweep a stranger's deposit. The
table above is the load-bearing claim; re-verify each line against the consume
method before shipping.

### In-flight guards (Commitment + Project only)

Reclaiming a Commitment or Project escrow while a non-terminal record still owns it
would claw back committed/staked principal or steal a pending funding. Two guards:

- `commitment_in_flight(caller, proposal_id)` — true if a `Commitment` row exists
  with status ≠ `Burned` and ≠ `Returned` (i.e. Pending / ThresholdMet / FailedBurn /
  FailedRefund / StuckFunds). Reclaim returns `COMMITMENT_IN_FLIGHT`.
- `project_funding_in_flight(caller, project_id)` — true if a `ProjectFunding` row
  exists for `(funder, project_id)` with status `FailedPayout`. `FailedPayout` means
  `fund_project` journaled the funding BEFORE its escrow→treasury transfer (the
  retryable pattern) and the sweep will still draw `amount` from the escrow; a
  `Settled` row already drew its amount (escrow holds only overpay). Reclaim returns
  `PROJECT_FUNDING_IN_FLIGHT`.

Once the record is terminal (`Burned`/`Returned`, or no record at all), only overpay
dust remains and is reclaimable. `key` is required for these two (`KEY_REQUIRED` if
`None`); the per-principal kinds ignore it.

### Why this is safe without touching the consume methods

Every consume method (`post_idea`, `start_thread`, `add_comment`, `fund_project`,
`stake`, `apply_featured`, the commit paths, `create_farmer`) already takes
`CallerGuard`. `reclaim_escrow` also takes `CallerGuard`. The guard is a
per-principal mutex, so reclaim is mutually exclusive with every consume — a user
can't reclaim mid-consume and a consume can't race a reclaim. **No consume method
was modified.**

### Signature change — backward compat

The frontend does not call `reclaim_escrow` (only the generated bindings reference
it), so adding the 3rd arg only required updating `backend.did` + regenerating
bindings. `EscrowKind` is a Candid variant — adding variants is Candid-compatible
(old clients sending the 3 old variants still decode). The generated
`reclaim_escrow(arg0, arg1, arg2)` now takes `bigint | null` for the key; any future
UI caller passes `null` for the per-principal kinds.

### Tests (lib.rs `mod tests`)

- `test_reclaim_escrow_returns_stranded_deposits` — **updated** for the 3-arg
  signature; still covers Explorer/Arcade/EarlyAdopter refund-minus-fee + the
  `NOTHING_TO_RECLAIM` empty case.
- `test_reclaim_escrow_new_kinds` — Featured/IdeaPost/Discussion refund-minus-fee
  + empty case; Stake ICP-only rejection (`STAKE_ICP_ONLY`) + a Stake refund;
  Commitment/Project `KEY_REQUIRED` on missing key; both refund an orphan deposit
  when no in-flight record exists.
- `test_reclaim_escrow_in_flight_guards` — a Pending commitment blocks reclaim
  (`COMMITMENT_IN_FLIGHT`); flipping it to `Burned` makes the overpay reclaimable;
  a `FailedPayout` ProjectFunding blocks reclaim (`PROJECT_FUNDING_IN_FLIGHT`).

---

## Fix #2 — `renew_farmer`: journal the CMC block before notify (+ auto-refund)

### The bug (C2 from the audit)

`renew_farmer` did the CMC topup + notify as a fire-and-forget pair with no
journaling:

```rust
// OLD (buggy):
let block = call_cmc_topup_transfer(...).await?;   // 90% ICP leaves escrow → CMC
notify_cmc_topup(..., block, ...).await?;           // if this fails, `block` is a local var
```

If `notify_cmc_topup` failed (transient CMC rejection), the 90% ICP had already
left the escrow for the CMC but no cycle minting happened and **nothing in stable
state recorded the block**. `xfarm_sweep` (lib.rs:19454) re-notifies farmers where
`burn_block_index.is_some() && !cmc_notified` — but the old renew never set
`burn_block_index`, so the sweep had nothing to re-notify. The ICP was stranded at
the CMC forever (recoverable only via manual CMC refund / `CMC_REFUNDED`).

### The fix

Mirror `create_farmer`'s CMC leg (lib.rs:19198-19213): journal the block + clear
`cmc_notified` BEFORE the notify, handle `CMC_REFUNDED` by dropping the block, and
mark `cmc_notified = true` only on notify success. Plus the `create_farmer`
auto-refund wrapper around the whole body so a pre-money failure refunds the
escrow instead of stranding it.

```rust
// NEW (fixed):
let block = call_cmc_topup_transfer(...).await.map_err(...)?;
farmer.burn_block_index = Some(block);   // ← journal BEFORE notify (the C2 fix)
farmer.cmc_notified = false;
xfarm_put_farmer(&farmer);                // persisted: sweep can now recover this
if let Err(e) = notify_cmc_topup(..., block, false).await {
    if e.starts_with("CMC_REFUNDED") {
        farmer.burn_block_index = None;   // CMC sent ICP back to escrow; drop block
        xfarm_put_farmer(&farmer);        //   (sweep must NOT re-notify a refunded one)
    }
    return Err(format!("RENEW_CMC_NOTIFY: {}", e));
}
farmer.cmc_notified = true;
xfarm_put_farmer(&farmer);
```

Now a notify failure leaves `burn_block_index = Some(..)` + `cmc_notified = false`,
which is exactly the sweep's re-notify predicate — `xfarm_sweep` recovers the
stranded leg as cycles on the next tick. The 10% treasury leg runs first
(unconditional, as before) and is journaled via `treasury_block`.

The whole body is wrapped in `let result = async move { … }.await; if result.is_err()
{ xfarm_refund_escrow(caller).await }` — exactly `create_farmer`'s pattern. Pre-money
failures (bad days, expired/missing/mismatched quote, insufficient deposit) refund
the full deposit; post-money failures find the escrow drained → refund no-ops (the
CMC leg is journaled, so the sweep recovers those funds as cycles rather than
stranding them).

### New helper: `xfarm_extend_farmer`

The `extend` inter-canister call (`ic_cdk::call(farmer_cid, "extend", …)`) was
inlined in `renew_farmer`. It panicked on host (`call_new should only be called
inside canisters`) because — unlike `xfarm_create_canister` / `xfarm_install_code` /
`xfarm_stop_canister` / `xfarm_delete_canister` — it had no host stub. Extracted into
`xfarm_extend_farmer(cid, add_budget: u64, add_days: u32) -> Result<(), String>`
with a wasm version (the real `ic_cdk::call`, unwrapping both the rejection layer
and the Farmer's inner `Result<(), String>`) and a host no-op stub. The Farmer
canister's `extend : (nat64, nat32) -> (Result)` (`src/xfarm_farmer/xfarm_farmer.did:54`)
takes `u64`, matching.

### Test seams added (host-only, `#[cfg(not(target_arch = "wasm32"))]`)

- `TEST_CMC_NOTIFY_FAIL` + `set_mock_cmc_notify_fail(Option<String>)` — the host
  `notify_cmc_topup` mock returns the set Err instead of Ok. Lets a test simulate a
  transient CMC notify failure (the C2 scenario) and a `CMC_REFUNDED`.
- `TEST_XFARM_EXTEND_FAIL` + `set_mock_xfarm_extend_fail(Option<String>)` — the host
  `xfarm_extend_farmer` mock returns the set Err. Lets a test simulate a Farmer
  `extend` failure (post-money error path).

Both default to `None` → existing tests are unaffected (the CMC notify mock stays a
no-op Ok; extend stays a no-op Ok).

### Tests

- `test_xfarm_renew_farmer_happy_path` — fresh renew resets the create blocks, runs
  10% treasury + 90% CMC, journals `treasury_block`/`burn_block_index`, marks
  `cmc_notified`, bumps `budget_cycles` by `burn_amt − fee` and
  `expected_depleted_at` by `days × DAY_NS`, consumes the quote.
- `test_xfarm_renew_notify_failure_journals_and_sweep_recovers` — **the C2 fix**:
  renew's treasury + CMC topup succeed, notify fails (transient) → assert
  `burn_block_index.is_some()` + `cmc_notified == false` (journaled, recoverable);
  clear the fail, run `xfarm_sweep` → assert `cmc_notified == true` (sweep recovered
  it). Then the `CMC_REFUNDED` path: assert `burn_block_index == None` (block
  dropped so the sweep won't re-notify a refunded one) + `RENEW_CMC_NOTIFY` surfaced.
- `test_xfarm_renew_premoney_failure_auto_refunds` — a `BAD_DAYS` renew fails before
  any money moves; the farmer stays Active, the prior renew's CMC leg is intact, and
  the quote is NOT consumed (owner can re-lock and retry).
- `test_xfarm_renew_extend_failure_is_idempotent_retry` — money legs succeed,
  `extend` fails → `EXTEND_FAILED` surfaces, `budget_cycles`/`expected_depleted_at`
  NOT bumped (extend never ran), money legs journaled (`cmc_notified == true`); a
  retry (fresh quote + re-funded escrow + cleared extend fail) completes the extend
  and bumps budget/duration.

### ⚠️ Known limitation (documented, not fixed here)

The money legs in `renew_farmer` are **not guarded** the way `create_farmer`'s are.
The `Farmer` struct has a single `treasury_block` / `burn_block_index` /
`cmc_notified` triple shared between create and renew; cleanly distinguishing
"this renew's block" from "create's historical block" needs a per-renew epoch field
(not added — scope). So a renew always re-runs the treasury + CMC transfers
(overwriting the historical blocks). This matches the pre-fix behavior; the only
change is the journaling that lets the sweep recover a notify failure.

**Consequence:** a renew that fails at `extend` (after notify succeeded) leaves
`cmc_notified == true` with the money legs done. A retry re-runs the money legs
(overwriting blocks) → the user pays twice for one extension (the first attempt's
cycles are already in the Farmer canister and will burn faster). This is rare (the
Farmer canister is controller-owned by the backend and `extend` is a local
inter-canister call), and the auto-refund + sweep mean no funds are *lost* — only
potentially over-burned. The proper fix is a `renew_epoch: u32` (`#[serde(default)]`)
on `Farmer` that gates the money-leg guards per renew; deferred. Flagged here so a
reviewer doesn't miss it.

---

## Upgrade safety

- **No new MemoryIds.** Fix #1 reuses existing per-feature subaccount derivations +
  the existing `EscrowKind` enum (a Candid variant — adding variants is
  backward-compatible). Fix #2 reuses the existing `Farmer` fields
  (`treasury_block`, `burn_block_index`, `cmc_notified`) — no struct change.
- The `EscrowKind` enum and `reclaim_escrow` signature are Candid-compatible
  additions (new enum variants + a new trailing arg). Old clients still decode.
- No `init` / `post_upgrade` changes needed (nothing new seeded).

## Build / test status (2026-06-20)

- `cargo test -p backend --lib` — **295 passed, 0 failed** (6 new tests added; the
  existing `test_reclaim_escrow_returns_stranded_deposits` updated for the 3-arg
  signature).
- `cargo build --target wasm32-unknown-unknown --release -p backend` — **clean**
  (the `cfg(target_arch = "wasm32")` paths, incl. the new `xfarm_extend_farmer` wasm
  version, compile).
- `npm run typecheck` (regenerates bindings + `tsc -b`) — **clean**.
- `cargo clippy -p backend --target wasm32-unknown-unknown` — 1 pre-existing error
  (`lib.rs:14432`, casino `absurd_extreme_comparisons`, unrelated to these fixes,
  present on `main` before this branch) + pre-existing warnings. No new clippy
  errors introduced; the new code matches existing repo patterns (`ic_cdk::call`,
  `days < MIN || days > MAX`) for consistency.

## Files touched

- `src/backend/src/lib.rs` — `EscrowKind` enum, `commitment_in_flight`,
  `project_funding_in_flight`, `reclaim_escrow`, `renew_farmer`,
  `xfarm_extend_farmer` (wasm + host), `notify_cmc_topup` host mock (fail seam),
  2 test-seam cells + setters, 6 new/updated tests.
- `src/backend/backend.did` — `EscrowKind` type (9 variants) + `reclaim_escrow`
  3-arg signature.
- `src/frontend/src/bindings/*` — regenerated (auto).

Not deployed (X-Farm dark on mainnet; reclaim is un-gated by design). Per the
mainnet-deploy gate, no deploy unless explicitly asked.