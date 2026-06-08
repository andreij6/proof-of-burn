# Cooperative Neuron Pooling (Syndicate Mode) — Implementation Plan

To protect the application's unique value and encourage larger stakeholders to cooperate rather than copy/fork it, we will introduce **Cooperative Neuron Pooling (Syndicate Mode)**.

Instead of steering only a single hardcoded "primary leader neuron", the app will allow owners of large voting power neurons to pool their voting power. The app's conviction burns will then steer the votes of **all** registered neurons in the pool in lockstep.

---

## 1. Join Pool Flow & Initiation Fee

### Requirements
* **Follow Requirement**: The powerful neuron must follow the primary leader neuron on the **Governance** topic.
* **Hotkey Requirement**: The neuron must have the backend canister principal added as a hotkey so the canister can query NNS `get_full_neuron` to verify follow status and read actual voting power.
* **Initiation Fee**: Registering a neuron in the pool requires a **125 ICP initiation fee** (configurable by the admin).
* **Fee Split**: The 125 ICP is split as follows:
  * **50% (62.5 ICP)**: Transferred to the **treasury subaccount** of the backend.
  * **25% (31.25 ICP)**: Converted to cycles to fund the **backend canister** cycles balance.
  * **25% (31.25 ICP)**: Converted to cycles to fund the **frontend canister** cycles balance.

---

## 2. Syndicate Voting & Revenue Share Split

### Voting Multi-Cast
* When a proposal threshold is met and the cutoff is reached, `process_proposal_cutoff` will:
  1. Collect the primary neuron ID and all active neuron IDs from `POOL_NEURONS`.
  2. Deduplicate the target IDs.
  3. Loop and call NNS `manage_neuron` (RegisterVote) for each.
  4. If at least one succeeds, mark the proposal `"voted"`. If all fail, mark `"failed"`.

### 25-25-25-25 Burn Split (PB-138)
When a proposal is successfully settled, the committed ICP in the Adopt and Reject pots is split:
1. **25% to Backend Canister**: Converted to cycles.
2. **25% to Frontend Canister**: Converted to cycles.
3. **25% to Treasury**: Transferred to the treasury subaccount.
4. **25% to Pool Distribution**:
   * Sort all registered pool neurons by `voting_power` in descending order.
   * Take the **top 25 neurons**.
   * Split the 25% share equally among them, transferring directly to each neuron's `registered_by` principal (minus the 0.0001 ICP ledger transfer fee).
   * **Safety Fallback**: If the pool is empty (no registered pool neurons), redirect this 25% pool share to the treasury instead.

---

## 3. Findings & Adjustments (PB-138 Fix)

During PocketIC integration testing, `settle_burn_split` fails because the CMC canister is not installed on PocketIC, causing CMC notifications to reject. To resolve this:
1. **Expose Mock Endpoint**: Add a `notify_top_up` update endpoint to the backend canister that returns dummy success when `is_local = true` (acting as a mock CMC).
2. **Derivation Updates**: Update `NotifyTopUpArgs`, `NotifyTopUpResult`, and `NotifyError` to derive both `Serialize` and `Deserialize`.
3. **Mock Deployment in Tests**: In `test_pool_rewards_distribution_integration`, deploy the backend Wasm on the hardcoded CMC canister ID (`rkp4c-7iaaa-aaaaa-aaaca-cai`) right before triggering settlement, allowing the `notify_top_up` call to succeed.

---

## 4. Pool Voting-Power Refresh & Inactivation (PB-139)

* Extend the periodic `fetch_leader_neuron_info` timer to iterate **Active** `POOL_NEURONS` and re-`get_full_neuron` each:
  * Update cached `voting_power`.
  * If the canister hotkey was removed, the neuron no longer follows the leader, or stake/VP is 0 → set `status = Inactive`.
  * Leave Drafts untouched (re-verified at finalize).
  * `recompute_pool_info()` at the end.
* To bound cycles, refresh in small batches with a simple rotating cursor if the pool is large (not required at launch volumes; document the cursor).
* Ensure refresh is resilient to a single `get_full_neuron` failure by logging and continuing.

---

## 5. Proposed Changes

### Backend Canister

#### [MODIFY] [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* Expose `notify_top_up` update endpoint for local environment mocking.
* Derive `Serialize` and `Deserialize` on all CMC topup structs.
* Implement PB-139 timer refresh loop.
* Hook `distribute_pool_rewards` to proposal settlement and sweep.

#### [MODIFY] [backend.did](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/backend.did)
* Verify all pooling update and query endpoints are correctly declared.

---

### Frontend Canister

#### [MODIFY] [App.tsx](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/frontend/src/App.tsx)
* Update Header and Tagline stats to show the **Total Syndicate Voting Power** (sum of primary leader + pool neurons).
* Add a **Syndicate Pool Sidebar** (collapsible on desktop, full-screen drawer on mobile) listing active pool neurons.
* Add a **Join Pool Wizard Modal** with intro, verify, and pay steps, including draft persistence and resume setup.
* Update revenue-split copy to reflect both the 50/25/25 and 25/25/25/25 split cases.

---

## Verification Plan

### Automated Tests
* Rust unit tests:
  * `test_pool_rewards_distribution` (math, top-25 limit, empty pool fallback).
  * `test_pool_refresh_and_inactivation` (happy path, hotkey/follow removal, error resilience).
* PocketIC Integration tests:
  * `test_pool_rewards_distribution_integration` (with mock CMC deployed to verify successful payout).
* Frontend unit tests:
  * VP sum, top-25 eligibility, and wizard step transitions.

### Manual Verification
* Deploy to local network and verify:
  1. Join pool wizard transitions, verification step, and draft creation.
  2. Finalization and fee-split distribution.
  3. Leader card "+ X Pooled Voting Power" and total syndicate VP updating.
  4. Settle proposal and verify payout of pool rewards.
  5. Cancel draft / unregister neuron.
