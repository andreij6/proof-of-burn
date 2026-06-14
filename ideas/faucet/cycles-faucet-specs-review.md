# Cycles Faucet Specification Review & Scorecard (PB-400)

This document evaluates the design document for the **Cycles Faucet** ([`cycles-faucet.md`](cycles-faucet.md)). The grading is divided into **Completeness**, **Correctness** (ICP-specific mechanics and safety), and **Creativity**.

---

## 1. Executive Summary & Grading

| Dimension | Score | Verdict |
|---|---|---|
| **Completeness** | **9.0 / 10** | High-level vision is thorough. Clear phasing, parameters, and threat mitigations are well-documented. |
| **Correctness** | **7.5 / 10** | Several IC-specific correctness concerns exist regarding canister verification, stuck ICP risks on deleted canisters, and async balance call overhead. |
| **Creativity** | **9.5 / 10** | Excellent alignment of incentives. Leveraging pool neurons and active voting history provides robust Sybil resistance without external KYC. |
| **Overall Grade** | **B+** | A strong foundation that can be elevated to production-grade by resolving the correctness issues detailed below. |

---

## 2. Core Correctness & IC Compliance Issues (Critical)

### C1. Canister Griefing & Lockout Risk (Section 3)
* **The Issue**: Option (a) ("Don't verify controllership") is recommended. 
* **The Risk**: If anyone can register any canister principal to claim grants, a malicious user could front-run registrations of popular ecosystem canisters. Since the weekly rate limits (G4) apply per-canister, this locks the actual developers out of claiming cycles for their own canisters.
* **Resolution**: Introduce a low-friction **Proof-of-Control** registration flow:
  * The registration must be initiated by an inter-canister call originating *from* the target canister itself (e.g., `target_canister` calling `faucet_canister.register_canister()`).
  * On the IC, a caller's principal is cryptographically verified. If the call originates from the target canister principal, it constitutes mathematical proof of control.

### C2. Stuck ICP Risk on Non-Existent or Deleted Canisters (Section 5)
* **The Issue**: If a user registers an invalid or deleted canister principal, the backend will still execute the ICP transfer to the CMC subaccount (`call_cmc_topup_transfer`).
* **IC Compliance**: Once ICP is transferred to the CMC for a target canister, it cannot be refunded. If `notify_cmc_topup` subsequently fails because the destination canister does not exist, that ICP is trapped in the CMC forever.
* **Resolution**: Perform a validation check on the target canister's existence *before* transferring funds. The faucet should execute a lightweight, zero-value query call or ping to the target canister. If it returns `RejectCode::DestinationInvalid`, block the registration/claim immediately.

### C3. Async Ledger Call Performance Overhead (Section 4)
* **The Issue**: Checking the treasury balance (`get_treasury_balance()`) at every claim time requires an asynchronous inter-canister call to the ICP ledger.
* **Impact**: Adds an unnecessary consensus round-trip (2s latency) and cycles cost to the `claim_cycles` update call.
* **Resolution**: Cache the treasury balance locally on the backend canister. Update it periodically (e.g., every 10 minutes via a heartbeat/timer) or hook into ledger transfer receipts to maintain a near-realtime local tracking of the treasury pool.

### C4. Simplified Weekly Cap Tracking (Section 3 / Section 9)
* **The Issue**: The spec proposes `FAUCET_CLAIMS` with a composite key to track rolling 7-day limits for both developers and canisters.
* **Impact**: Querying and maintaining composite range keys is complex and slower in stable storage.
* **Resolution**: Store limits in two simple flat maps:
  1. `DEV_LAST_CLAIM: Principal -> u64` (developer principal to last claim timestamp in nanoseconds).
  2. `CANISTER_LAST_CLAIM: Principal -> u64` (canister principal to last claim timestamp in nanoseconds).
  Checks resolve to simple \(O(1)\) lookups: `now - last_claim >= 7 days`.

---

## 3. Creativity & Strengths

* **Sybil Resistance Flywheel**: Linking faucet eligibility to pool neurons and active voting is a brilliant mechanic. It requires attackers to lock up ICP (stake) and burn ICP (vote), making Sybil attacks financially negative.
* **ICP-Denominated Grants**: Budgeting grants in ICP rather than cycles is highly creative. It keeps treasury accounting deterministic and immune to fluctuations in the ICP/cycles conversion rate.
* **Local replica warning (PB-148)**: Acknowledging local replica ledger block-type issues prevents developer frustration during local testing.

---

## 4. Suggested Optimizations (For Build Spec)

* **Tiered Grants (Phase 3)**: Consider scaling the weekly grant size based on the user's staked pool neurons' age or size. This rewards long-term ecosystem alignment.
* **Standard-Shaped Status Query**: Design the `get_my_faucet_status` query to return a structured enum detailing exactly which gate is currently blocking the user (e.g., `GateFailed::VotedInLast30Days`). This enables developers to integrate clear diagnostic messaging into their terminal scripts or frontends.
