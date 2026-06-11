# Testing Opportunities

This document outlines key areas in the backend canister where testing coverage can be expanded to improve reliability, upgrade safety, and error handling.

---

### 1. Canister Upgrade & State Persistence Integration Tests
* **Target File**: [integration.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/tests/integration.rs)
* **Target Code**: [post_upgrade](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L745) hook and stable data structures (e.g. `StableBTreeMap`, `StableCell`).
* **Test Description**: Using PocketIC, deploy the canister, modify its state (e.g., create active proposals, commitments, user stakes, active pool neurons, lottery tickets), execute `pic.upgrade_canister()`, and verify that:
  1. All state maps successfully deserialize and retain data without corruption or default-value resets.
  2. New fields (e.g., added configuration variables) default gracefully on older serialized structures.
* **Rationale**: Ensures upgrades do not corrupt stable storage or fail to deserialize.

### 2. Auto-Topup Resiliency / Upgrade Loss Test
* **Target File**: [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* **Target Code**: [cycle_topup_check](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L3444) and [LAST_TOPUP_BLOCK](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L1451).
* **Test Description**: 
  1. Trigger cycles top-up check under low cycle conditions.
  2. Let Phase A (ICP transfer to the CMC ledger account) succeed, producing a block index saved in [LAST_TOPUP_BLOCK](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L1451).
  3. Upgrade the canister *before* Phase B (CMC notification) executes.
  4. Assert that the canister is still capable of finalizing the top-up using the original block index instead of leaking the transferred funds.
* **Rationale**: [LAST_TOPUP_BLOCK](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L1451) is a heap-allocated, transient variable. A canister upgrade between Phase A and Phase B will wipe it, causing the canister to permanently lose track of the CMC block index and leak the transferred ICP.

### 3. Loop-Failure & Retries in Reward Distributions
* **Target File**: [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* **Target Code**: [distribute_pool_rewards](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L836).
* **Test Description**: Mock the ledger canister to reject or fail (e.g., due to `TemporarilyUnavailable`) during a specific iteration of the transfer loop in [distribute_pool_rewards](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L836) (e.g. fail on the second out of five active pool neurons). Verify if:
  1. The distribution is retried in a future sweep for the failed targets.
  2. Setting `proposal.pool_distributed = true` at the beginning of the function doesn't permanently block retries for unpaid neurons.
* **Rationale**: Since `pool_distributed` is set to `true` eagerly, a ledger failure inside the transfer loop leaves the remaining recipients unpaid with no retry mechanism.

### 4. Happy-Path Cycles Burn & CMC Integration
* **Target File**: [integration.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/tests/integration.rs)
* **Target Code**: CMC top-up notification success in integration tests.
* **Test Description**: Add a stubbed CMC canister mock in the PocketIC environment that returns `Ok(cycles)` on `notify_top_up`. Commit ICP above the threshold on a proposal, run the sweep, and assert that:
  1. The commitment status changes to `Burned` (rather than failing and reverting to `FailedBurn`).
  2. Global statistics (`total_burned_e8s`) and user aggregate stats are correctly updated.
* **Rationale**: Verifies the end-to-end happy-path cycles conversion ledger flow.

### 5. Lottery Randomness Failures & Draw Rollovers
* **Target File**: [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* **Target Code**: [lottery_draw_check](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs#L6957) and `raw_rand` failures.
* **Test Description**: Mock the management canister's `raw_rand` call to return a rejection or timeout during a scheduled drawing. Assert that:
  1. The lottery draws gracefully skip the current interval without crashing the timer loop.
  2. User tickets are preserved and carried forward rather than being voided or dropped.
* **Rationale**: Guarantees that transient IC system failures (like `raw_rand` timeouts) do not lead to ticket loss or system lockups.

### 6. High Concurrency Race Conditions (Stress Testing)
* **Target File**: [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* **Target Code**: Reentrancy protections (`CallerGuard`, `ProposalLock`).
* **Test Description**: Interleave multiple concurrent calls from different principals targeting `commit`, `unstake`, or `disburse` within the same execution block/tick.
* **Rationale**: Ensures reentrancy guards behave correctly under load.
