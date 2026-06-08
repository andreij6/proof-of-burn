# Cooperative Neuron Pooling (Syndicate Mode) — Implementation Plan

To protect the application's unique value and encourage larger stakeholders to cooperate rather than copy/fork it, we will introduce **Cooperative Neuron Pooling (Syndicate Mode)**.

Instead of steering only a single hardcoded "primary leader neuron", the app will allow owners of large voting power neurons to pool their voting power. The app's conviction burns will then steer the votes of **all** registered neurons in the pool in lockstep.

---

## 1. Join Pool Flow & Initiation Fee

### Requirements
* **Follow Requirement**: The powerful neuron must follow the primary leader neuron on the **Governance** topic.
* **Hotkey Requirement**: The neuron must have the backend canister principal added as a hotkey so the canister can query NNS `get_full_neuron` to verify follow status and read actual voting power.
* **Initiation Fee**: Registering a neuron in the pool requires a **125 ICP initiation fee**.
* **Fee Split**: The 125 ICP is split as follows:
  * **50% (62.5 ICP)**: Transferred to the **treasury subaccount** of the backend.
  * **25% (31.25 ICP)**: Converted to cycles to fund the **backend canister** cycles balance.
  * **25% (31.25 ICP)**: Converted to cycles to fund the **frontend canister** cycles balance.

-- THE INITIATION FEE SHOULD BE CONFIGURABLE BY THE ADMIN
### Implementation
1. **Escrow Address**: Expose a query `get_registration_address() -> LedgerAccount` returning a derived subaccount specific to the user's principal (using a registration seed).
2. **Registration Endpoint**: `register_leader_neuron(neuron_id: u64) -> Result<(), String>`:
   * Asserts the user has deposited 125 ICP (plus fees) to their registration escrow.
   * Calls NNS Governance `get_full_neuron(neuron_id)` (unless `is_local` is true):
     * Asserts the backend canister principal is in the neuron's `hot_keys` list.
     * Asserts the caller's principal is the neuron's `controller` or is in the `hot_keys` list.
     * Asserts the neuron follows the primary leader neuron on the **Governance** topic.
   * If verification succeeds:
     * Pulls the 125 ICP from escrow.
     * Distributes 50% to treasury, 25% to backend cycles, 25% to frontend cycles.
     * Adds the neuron to `POOL_NEURONS` table.
   * If verification fails:
     * Returns the 125 ICP to the caller's wallet (minus a 0.0001 ICP ledger fee).
     * Returns an error.

---

## 2. Syndicate Voting & Revenue Share Split

### Voting Multi-Cast
* When a proposal threshold is met and the cutoff is reached, `process_proposal_cutoff` will:
  1. Collect the primary neuron ID and all active neuron IDs from `POOL_NEURONS`.
  2. Deduplicate the target IDs.
  3. Loop and call NNS `manage_neuron` (RegisterVote) for each.
  4. If at least one succeeds, mark the proposal `"voted"`. If all fail, mark `"failed"`.

### 25-25-25-25 Burn Split
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

## Proposed Changes

### Backend Canister

#### [MODIFY] [lib.rs](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs)
* Add `PoolNeuron`, `PoolNeuronInfo`, `PoolInfo` data structures and `impl_storable!(PoolNeuron)`.
* Add `POOL_NEURONS` stable map at `MemoryId::new(8)` and `CACHED_POOL_INFO` thread-local cell.
* Expose `get_registration_address() -> LedgerAccount`.
* Implement NNS Governance `get_full_neuron` call structure.
* Implement `register_leader_neuron` and `unregister_leader_neuron`.
* Update `fetch_leader_neuron_info()` to update pool stats.
* Update `settle_burn_split` to implement the new 25-25-25-25 split and top-25 distribution.
* Update `process_proposal_cutoff` to loop over all target neurons.

#### [MODIFY] [backend.did](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/backend.did)
* Expose new Candid structures and endpoints: `get_pool_info`, `get_registration_address`, `register_leader_neuron`, `unregister_leader_neuron`.

---

### Frontend Canister

#### [MODIFY] [App.tsx](file:///Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/frontend/src/App.tsx)
* Update Header and Tagline stats to show the **Total Syndicate Voting Power** (sum of primary leader + pool neurons).
* Add a **Syndicate Pool Dashboard** list component.
* Add a **Join Pool Modal** detailing the 125 ICP fee, the hotkey setup, the follow requirement, and the registration submission inputs.
* Add "Leave Pool" capability.

---

## Verification Plan

### Automated Tests
* Add Rust unit tests for:
  * Registration verification logic (mocking NNS `get_full_neuron` responses).
  * 25-25-25-25 burn split math and top-25 payouts.
  * Empty pool fallback redirecting pool shares to treasury.
  * Multi-cast voting loop resilience.
* Run: `cargo test -p backend` & `npm --prefix src/frontend run test`

### Manual Verification
* Deploy to local network, connect, fund, and test:
  1. Derive registration address.
  2. Fund it with 125.0002 ICP.
  3. Register a neuron. Confirm the 125 ICP splits correctly (treasury + backend cycles + frontend cycles).
  4. Verify the UI dashboard shows the added neuron.
  5. Settle a proposal. Verify the 25% pool share is paid out to the registered principal.
