# Proof of Burn — ICP Vote Delegation DAO App

**Proof of Burn** is a decentralized governance participation application built on the Internet Computer Protocol (ICP). It introduces **skin in the game** to liquid democracy by combining neuron voting delegation with a conviction-based token burning mechanism.

---

## 1. Core Concept & Mechanics

In traditional liquid democracy, users delegate their voting power to a trusted entity (the Leader Neuron) by selecting it as a followee in the Network Nervous System (NNS). However, followers have no direct way to signal conviction on specific proposals, nor can they prevent the Leader from voting without community alignment.

**Proof of Burn** solves this via a trustless canister-based escrow:
* **Follow the Leader:** Users follow the primary Leader Neuron on the NNS Dapp.
* **Commit & Vote Stance:** For any active NNS proposal, users commit a chosen amount of liquid ICP (minimum **1.0 ICP**) to be burned and select their vote stance: **ADOPT** or **REJECT**.
* **1-Hour NNS Cutoff:** The canister closes all commitments exactly **1 hour** before the proposal's official NNS deadline.
* **Weighted Tally & Threshold Execution:**
  - Votes are weighted by the amount of ICP committed to the burn ($10^8$ votes per 1.0 ICP).
  - The canister checks the combined committed ICP ($B_{\text{adopt}} + B_{\text{reject}}$) against an initial flat threshold of **250 ICP**.
  - **Case A: Threshold Met $\ge$ 250 ICP:** The Leader Neuron automatically votes with the winning community choice (majority of committed ICP). **All committed ICP in both pots (Adopt and Reject) is permanently burned**, cementing the skin-in-the-game conviction of both sides.
  - **Case B: Threshold Failed < 250 ICP:** The Leader Neuron **abstains** from voting, and **all committed ICP is refunded** to the users (minus the 0.0001 ICP refund transfer fee).
* **Self-Sustaining Transaction Fees:** Users pay a flat **0.0002 ICP** fee overhead on deposit. 0.0001 ICP covers the ledger transfer into escrow, and the remaining 0.0001 ICP is reserved in escrow to cover the outgoing ledger transfer (either burn or refund), keeping canister operating costs at zero.

---

## 2. Dynamic User Experience & Progressive Disclosure

To prevent user overwhelm, the Single-Page Application (SPA) uses **progressive disclosure** to expand the user interface in-place as the user completes authentication and authorization gates:

1. **Tier 0 — Anonymous Visitor:** Can copy the Leader Neuron ID and view the list of active proposals (titles only). All commitment inputs and vote logs are hidden behind a blurred lock overlay.
2. **Tier 1 — Authenticated User:** signs in via **Internet Identity (II)**. Unlocks detailed proposal cards showing live burn progress bars and the Leader Neuron's complete historical vote log.
3. **Tier 2 — Verified Follower:** Triggers when the canister verifies on-chain that the user follows the Leader Neuron. To simplify this onboarding, a **Guided Walkthrough Modal** guides the user through copy-pasting the Leader Neuron ID to follow in NNS, and copying/pasting the App Canister Principal as a neuron hotkey (which authorizes on-chain follow verification). This unlocks the "Commit ADOPT/REJECT" inputs.
4. **Tier 3 — Active Participant:** Triggers once the user has committed ICP to at least one proposal. Displays a sticky **Personal Dashboard Strip** showing their total committed escrow, total ICP burned to date, and active proposal status badges.

---

## 3. Project Directory Structure

* **[[specifications/Index.md|specifications/]]** — Detailed planning, systems thinking, UI maps, and research-backed technical feasibility analysis of NNS integrations.
* **[[tasks/README.md|tasks/]]** — Sorted work-breakdown structure containing all roadmap tasks separated into `/todo`, `/in-progress`, and `/completed` subfolders.
* **[[design-system/README.md|design-system/]]** — Project assets, styling rules, and UI handoffs.

---

## 4. Technical Feasibility & Architecture Highlights

* **Canister Hotkey Pattern:** Because follow configuration is private on the NNS Governance canister, our App Canister is added as a hotkey to the user's neuron. This allows our canister to securely query `get_full_neuron` to verify follow status and controller principal matches.
* **Ledger Burn Transactions:** Token burning is executed trustlessly by calling the ICP Ledger Canister's ICRC-1 `icrc1_transfer` method to transfer escrowed funds to the ledger's designated `icrc1_minting_account` (the Cycles Minting Canister).
