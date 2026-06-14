# AI Reviewer Agent — Task List (PB-510)

Companion to [`ai-reviewer-spec.md`](ai-reviewer-spec.md). Tasks are grouped by phase; each notes **dependencies**, **acceptance**, and **effort** (S < 0.5d, M ~1–2d, L ~3–5d).

---

## Phase 0 — Google Cloud Run Setup (Off-chain)

- [ ] **0.1** Containerize and deploy the LLM wrapper service to Google Cloud Run.
  * *Acc*: Can query `POST https://<cloud-run-url>/v1/review` with a JSON payload and receive the AI completion.
  * *Effort*: S.
- [ ] **0.1b** **Idempotency cache in the wrapper** (only if the replicated-outcall path / Option 2 is chosen — see spec §B2.0): on a repeated `Idempotency-Key`, return the **byte-identical** cached completion instead of re-calling the LLM. Skip if using non-replicated outcalls (Option 1).
  * *Acc*: two requests with the same `Idempotency-Key` return identical bytes and bill the LLM once.
  * *Effort*: S. *Dep*: 0.1.
- [ ] **0.2** Setup Google Vertex AI (Gemini 1.5 Flash) API keys and bearer token authorization on Cloud Run.
  * *Acc*: Unauthorized requests return 401; requests with the correct `Authorization: Bearer <Key>` header succeed.
  * *Effort*: S.

---

## Phase 1 — Canister HTTP Outcall & Configuration

- [ ] **1.1** Add `ai_reviewer_url` and `ai_reviewer_key` to backend `Config` and admin config setters.
  * *Acc*: Admins can set and read config settings; key is hidden from non-admin queries.
  * *Effort*: S.
- [ ] **1.2** Implement the `query_ai_reviewer` update method and HTTP outcall logic **per spec §B2.0**: default to a **non-replicated** outcall (`is_replicated:false`); set a tight `max_response_bytes`; send an `Idempotency-Key`. (If replicated/Option 2 is chosen instead, add a transform function.) **Server-ground** the proposal: inject the proposal text from canister state via `proposal_id` rather than trusting the client seed.
  * *Acc*: a turn completes **without a consensus error**; cycles attached match `max_response_bytes`; the model receives the canister's authoritative proposal context.
  * *Effort*: M (L if Option 2). *Dep*: 1.1, (0.1b if Option 2).
- [ ] **1.3** Price $0.05 via the **existing** `explorer_usd_rate_e8s` + `explorer_quote_amount` helpers, reading the **existing** `refresh_icp_rate` cache (do not add a new cache or a raw formula).
  * *Acc*: cost e8s tracks the XRC rate via the shared path; no XRC call on the hot turn path.
  * *Effort*: S. *Dep*: 1.2.
- [ ] **1.4** Unit tests for HTTP outcall cycles calculations and payload serialization.
  * *Acc*: `cargo test -p backend --lib` passes; mock HTTPS client behaves as expected.
  * *Effort*: S. *Dep*: 1.2.

---

## Phase 2 — Prepaid Credit Balance (Escrow)

- [ ] **2.1** Allocate `AI_USER_CREDITS` at **MemoryId 94** (95 reserved) — pinned in the canonical registry (`00-overview-and-architecture.md §5`: course-nft 76–89, faucet 90–93, AI reviewer 94–95). Confirm the registry is still accurate at build time before claiming.
  * *Acc*: map uses id 94; registry unchanged/consistent; compiles.
  * *Effort*: S.
- [ ] **2.2** Implement deposit endpoints: `get_ai_credit_deposit_address` and `deposit_ai_credits` (escrow sweep).
  * *Acc*: Users can get a derived subaccount address, deposit ICP, call deposit, and see their local `AI_USER_CREDITS` increment.
  * *Effort*: M. *Dep*: 2.1.
- [ ] **2.3** Implement withdrawals: `withdraw_ai_credits` (refund prepaid balance).
  * *Acc*: Users can withdraw their credit balance back to their principal wallet, decrementing `AI_USER_CREDITS` and transferring ICP.
  * *Effort*: M. *Dep*: 2.2.
- [ ] **2.4** Wire billing into `query_ai_reviewer`: **deduct-first** (prevents double-spend), refund **only on definitive failure** (non-200/unparseable/timeout); make deduct/refund idempotent. Add a `CallerGuard` + a `RATE_LIMIT` policy (≤1 in-flight turn per principal + short cooldown).
  * *Acc*: underfunded → `INSUFFICIENT_CREDIT`; failed turns refund exactly once; a successful 200 keeps the charge; concurrent turns from one principal can't double-spend or race.
  * *Effort*: M. *Dep*: 1.2, 2.2.
- [ ] **2.5** Unit tests for prepaid deposits, withdrawals, underfunded blocks, and outcall refund loops.
  * *Acc*: `cargo test` coverage ensures the billing flow cannot lose funds or get bypassed.
  * *Effort*: M. *Dep*: 2.4.

---

## Phase 3 — Chatbot Frontend UI

- [ ] **3.1** Add **"Review with AI"** trigger button to proposal cards.
  * *Acc*: Button visible to signed-in users on Explorer and Dashboard views.
  * *Effort*: S.
- [ ] **3.2** Implement `AiReviewerModal` chatbot UI with local chat state management.
  * *Acc*: Renders message history; automatically sends initial proposal context on load; displays responses.
  * *Effort*: M. *Dep*: 3.1.
- [ ] **3.3** Add deposit, balance display, and loading stepper status panels in the chatbot view.
  * *Acc*: Shows current ICP balance/turn cost; input disabled during outcall; step labels render sequentially.
  * *Effort*: M. *Dep*: 3.2.

---

## Phase 4 — E2E & Rollout

- [ ] **4.1** PocketIC integration tests driving deposit $\rightarrow$ XRC mock rate conversion $\rightarrow$ outcall simulation $\rightarrow$ balance deduction.
  * *Acc*: End-to-end flow executes cleanly in testing harness.
  * *Effort*: M. *Dep*: Phase 2.
- [ ] **4.2** Add a feature flag (`ai_reviewer`, default OFF) and dark-launch the feature.
  * *Acc*: Flipped ON locally for verification; disabled on production until manual QA approves.
  * *Effort*: S. *Dep*: 3.3.
