# Proof of Burn — High-Level Goals

This document outlines the high-level goals and architectural pillars of the **Proof of Burn** platform. These principles serve as the north star for all future design, development, and governance decisions, remaining stable across minor layout changes and implementation details.

---

## 1. Conviction-Based Governance (Skin in the Game)
* **Goal:** Introduce real economic trade-offs to Web3 governance.
* **Principles:**
  * **Economic Commitment:** Traditional voting is costless and prone to noise. By requiring users to commit liquid tokens (ICP) that are permanently burned upon successful voting, the platform ensures that only participants with high conviction steer decision-making.
  * **No Hedging:** In successful community decisions, both opposing pots (Adopt and Reject) must be burned. This prevents risk-free hedging and ensures that both sides carry genuine risk.
  * **Abstaining on Low Interest:** If a proposal fails to reach the minimum collective commitment threshold, the Leader Neuron abstains, and users are refunded. This keeps the Leader focused only on decisions the community actively cares about.

---

## 2. Self-Sustaining & Funded Infrastructure
* **Goal:** Design a DAO app that can run indefinitely without external subsidies.
* **Principles:**
  * **Burn-to-Cycles Capture:** The tokens burned from successful votes should be partially or fully routed to top up the canisters (both backend and frontend) with cycles, converting community conviction into computational fuel.
  * **Self-Funding Protocol Fees:** Charge a small, predictable fee on user actions (like commitments) to build a treasury reserve that automatically refills canister cycle balances.
  * **Low-Maintenance Automation:** Rely on deterministic on-chain timers to manage syncing, voting, and settlements without requiring manual developer triggers.

---

## 3. Progressive Disclosure & Accessible UX
* **Goal:** Simplify complex Web3 concepts into a step-by-step user journey.
* **Principles:**
  * **Gated Tier Progression:** Organize the app experience around user tiers (e.g., from anonymous browsing to verified followers and active participants). Disclose features and interfaces only when the user is ready to use them.
  * **Intuitive Onboarding:** Assist users with clear instructions and modal flows when they need to configure their identity or follow settings.
  * **High-Contrast Progress Tracking:** Make the voting power, threshold status, and balance of power highly visible so the "why" and "how" of each proposal are clear at first glance.

---

## 4. Trustless & Verifiable Execution
* **Goal:** Ensure all escrow, voting tallies, and token distributions are secure and immutable.
* **Principles:**
  * **Deterministic Escrow Isolation:** Use principal-bound, proposal-bound subaccounts to isolate each participant's funds, making transactions auditable on the public ledger.
  * **Safety Over Speed:** Use reentrancy guards, lock patterns, and idempotent retry loops (e.g., duplicate transfer handling) to guarantee that user funds are never trapped or double-spent during settlement.
  * **Decentralized Control:** Maintain a transparent administration layer (such as multi-signature, multi-controller setup) to govern parameter updates (like defaults) while planning for long-term decentralized upgrade paths.
