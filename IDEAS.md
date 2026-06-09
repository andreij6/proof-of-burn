# Creative Use Cases for ckBTC in Cycles of Influence

This document outlines creative integration paths for **ckBTC** (Chain-key Bitcoin) within the **Cycles of Influence** (Proof of Burn) application. By utilizing the Internet Computer's native integration with Bitcoin, these ideas leverage ckBTC as hard money, a collateral asset, and a cross-chain incentive layer.

---

## 1. "Lossless" Voting Power via ckBTC Yield Collateral
Instead of permanently burning assets to rent voting power, users lock ckBTC in a smart contract as collateral.

* **Mechanism:** The locked ckBTC is supplied to an IC-native lending protocol (e.g., LEND or similar DeFi pools) to generate yield. The generated yield is automatically converted to ICP and burned on behalf of the user to rent voting power.
* **Benefit:** Users get "lossless" governance influence. They keep their principal ckBTC intact and can withdraw it at any time, using only the time-value of their Bitcoin to steer NNS decisions.

---

## 2. Hyper-Conviction Multipliers (Hard Money Burn)
Burning ICP represents sacrificing a utility token, but burning ckBTC represents sacrificing a globally recognized, hard-capped store of value (Bitcoin).

* **Mechanism:** The protocol allows users to burn ckBTC directly to rent voting power. Because ckBTC represents "hard money," the protocol awards a **conviction multiplier** (e.g., $1.5\times$ or $2\times$ voting power per USD value burned compared to ICP).
* **Benefit:** Creates an elite tier of voting where users can show absolute, irreversible conviction on critical NNS updates.

---

## 3. Hedging & ckBTC Governance Bounties
External Web3 projects or Bitcoin-focused DAOs often have a vested interest in NNS proposals—especially those modifying the Bitcoin canister, threshold ECDSA signatures, or ckBTC/ckETH integrations.

* **Mechanism:** A project or sponsor creates a **ckBTC Bounty Pool** for a specific proposal (e.g., *"If Proposal #12345 is Adopted/Rejected, distribute 0.5 ckBTC to everyone who committed burning power to that stance"*).
* **Benefit:** Uses Bitcoin as a universal, cross-chain incentive layer to coordinate voting behavior on the Internet Computer.

---

## 4. Cross-Chain Bitcoin Governance Sponsorship
Bitcoin holders who want to steer the direction of the Internet Computer (due to its role as a Bitcoin L2/smart contract layer) but do not want to hold or expose themselves to ICP price volatility can participate directly.

* **Mechanism:** Users use ckBTC directly to rent NNS voting power. Under the hood, the protocol wraps the swap/burn of ICP seamlessly, allowing the end-user to interact entirely with ckBTC.
* **Benefit:** Lowers the barrier to entry for Bitcoin purists to participate in NNS governance.

---

## 5. Pool Neuron Revenue Share in ckBTC
For users participating in the **Pool Neurons** (syndicate voting):

* **Mechanism:** Instead of distributing rewards or payouts in ICP, the syndicate treasury automatically swaps accrued NNS voting rewards into ckBTC.
* **Benefit:** Participants "burn ICP to vote" but "earn ckBTC in return" for keeping the syndicate active. This acts as a decentralized dollar-cost averaging (DCA) tool into Bitcoin powered by governance participation.
