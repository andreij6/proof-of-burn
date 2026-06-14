# Oisy Wallet Integration Specification Review & Scorecard (PB-500)

This document evaluates the integration specifications for **Oisy Wallet** ([`oisy-wallet-integration.md`](oisy-wallet-integration.md) and [`tasks.md`](tasks.md)). The grading is divided into **Completeness**, **Correctness** (ICP-specific mechanics and safety), and **Creativity**.

---

## 1. Executive Summary & Grading

| Dimension | Score | Verdict |
|---|---|---|
| **Completeness** | **9.5 / 10** | Very thorough frontend mapping. Tracks prop-threading across ~20 call sites, files, and line numbers accurately. |
| **Correctness** | **9.0 / 10** | Excellent identification of the query authentication challenge. A few standard compatibility nuances (ICRC-1 vs legacy ICP) should be addressed. |
| **Creativity** | **9.0 / 10** | The reframe from "in-app vs external wallet" to a "session signer choice" is highly accurate. Well-designed phasing minimizes risk. |
| **Overall Grade** | **A-** | An excellent specification that prepares the codebase for wallet-agnostic expansion. Resolving the query-signing and legacy ledger details will make it production-ready. |

---

## 2. Core Correctness & IC Compliance Issues (Critical)

### C1. The Authenticated Query Barrier & Solution (Plan §6)
* **The Issue**: Oisy Wallet operates remotely and does not share delegation keys (no ICRC-34 support). 
* **IC Compliance**: On the IC, query calls that check the caller's identity (e.g., `get_deposit_address()`) require the request to be signed by the caller's private key. If there is no delegation key locally, the query either goes through as `anonymous` or the user must approve a wallet popup *for every single read call*, causing a terrible UX.
* **Evaluation**: The spec's proposed Option (b) (adding principal-argument query variants like `get_deposit_address_for(principal)`) is the **most correct and secure solution**. Since query calls are public read-only views, exposing this endpoint anonymously with an explicit principal argument removes the need for signed queries without introducing security vulnerabilities.

### C2. Legacy ICP Transfer vs. ICRC-1 Transfer (Plan §3, Point 5)
* **The Issue**: The spec notes that the legacy Account-ID withdraw (`App.tsx:783`) uses the legacy ICP ledger `transfer` method (Account Identifiers), which Oisy does not support. It suggests moving to ICRC-1 or hiding the feature.
* **IC Compliance**: The ICP Ledger Canister has fully supported the standard `icrc1_transfer` method since 2023. 
* **Resolution**: Instead of hiding the withdraw flow for Oisy users, the withdrawal logic for **all signers** should be migrated to the standard `icrc1_transfer` (using principal/subaccount). This eliminates the legacy account-identifier code path, simplifies the codebase, and ensures full feature parity for Oisy users.

### C3. Session Restoration & Popup Blockers (Plan §3, Point 6)
* **The Issue**: Unlike Internet Identity, which uses a persistent session delegation, Oisy Wallet requires establishing an active connection channel on reload.
* **Impact**: If the user refreshes the page, the browser might block the wallet connection window as a popup.
* **Resolution**: Ensure the frontend implements an explicit **"Reconnect Wallet"** button if auto-restoring connection fails on reload, rather than triggering the connection flow automatically on mount (which browsers block as un-triggered popups).

---

## 3. Creativity & Strengths

* **The Wallet Signer Reframe**: The document correctly reframes the problem away from "adding an external wallet" to "abstracting the session signer." This prevents developers from creating duplicate UI views for balances or addresses.
* **Phase 1 Independence**: Proposing the `WalletProvider` abstraction (Phase 1) as a standalone, behaviour-identical PR is an excellent software engineering practice. It decouples the codebase refactoring from the integration of the Oisy SDK.
* **Zero Backend State Change**: Correctly keeping the backend state untouched avoids database migration risks and guarantees zero MemoryId collisions with the active Course NFT development.

---

## 4. Suggested Optimizations (For Build Spec)

### O1. ICRC-25 Batching for "Deposit-then-Notify"
* **The Issue**: Standard deposit-then-notify flows require two signed operations (the ledger transfer + the backend notify call), creating two consecutive Oisy popups.
* **Optimization**: The ICRC-25 wallet standard supports batching multiple requests. In Phase 3, explore batching the `icrc1_transfer` and the backend `settle` call into a single request payload so Oisy Wallet prompts the user only once.

### O2. IdentityKit for Multi-Wallet Future
* **Decision**: Choosing `@nfid/identitykit` over `@dfinity/oisy-wallet-signer` is highly recommended. IdentityKit not only supports Oisy but instantly opens the door to Plug, NFID, and future wallets with a unified UI modal, avoiding the need to write separate custom providers for each wallet in the future.
