---
type: idea
title: "AI Reviewer Agent — Build Spec (PB-510)"
tags: [ideas, ai-reviewer]
timestamp: 2026-06-14T06:50:51-04:00
---

# AI Reviewer Agent — Build Spec (PB-510)

> Implements the AI Reviewer agent feature. Users can launch a chatbot modal from any
> proposal card to analyze proposals and converse with an AI. Each query turn charges
> the user **$0.05 USD equivalent in ICP**, deducted from their canister-managed prepaid
> credit balance. The canister forwards queries to an LLM wrapper hosted on Google Cloud
> Run using ICP Canister HTTPS Outcalls.
>
> **PB renumbered PB-500 → PB-510** (PB-500 collided with the Oisy spec; the task
> list already used PB-510). **Review-pass revisions are summarized in [§E](#part-e--review-revisions).**

---

## Part A — Design / UX / Behavior

### A1. The User Flow & Chatbot UI

1. **Trigger**: A **"Review with AI"** button is added to every proposal card in the `Explorer` or `Dashboard` views (e.g., `Explorer.tsx`, `Dashboard.tsx`). It is visible to all authenticated users.
2. **Chatbot Modal**: Clicking the button opens a slide-over or center modal.
   * **Seeding the Context**: On open, the chatbot automatically initializes the conversation by formatting the target proposal's ID, title, summary, and current voting status into a system prompt. It sends this initial text to the AI (charging the first 5 cents) and displays the AI's initial summary:
     * *Summary*: 3 bullet points of what the proposal does.
     * *Ecosystem Impact*: Pros & cons for the Internet Computer ecosystem.
   * **Chat Interface**: A standard chat log (bubbles for user/AI) with a message input bar at the bottom.
   * **Diagnostic Info**: Below the input, a status line shows:
     * The cost per turn: `Cost: 0.0053 ICP (~$0.05)` (updated via XRC).
     * The user's prepaid balance: `Balance: 0.1200 ICP`.
     * A **"Deposit ICP"** top-up action if the balance is low.
3. **Turn-by-Turn Conversational Chat**: Users can type questions about the proposal. Each message sent charges the user's balance and executes an HTTP outcall. The input is disabled during the outcall, displaying a stepper:
   * `"Deducting $0.05 ICP..."` $\rightarrow$ `"Querying AI Agent..."` $\rightarrow$ `"Received."`

### A2. Pricing Model (XRC USD Conversion)

* The cost is exactly **$0.05 USD per message turn**.
* **Reuse the existing pricing path — do not reinvent it.** The codebase already
  prices USD→ICP via `explorer_usd_rate_e8s` + `explorer_quote_amount`
  (`lib.rs:9045`), the same helpers the Explorer ($1/day) and Arcade ($1) flows
  use. Price $0.05 as `usd_e8s = 5_000_000` (since $1 = 100_000_000 USD-e8s, per
  `ARCADE_CUSTOMIZE_FEE_USD_E8S`) and convert with those helpers.
* **Unit caution:** the original `cost_e8s = 0.05·1e8 / ICP_USD_RATE` is unit-
  ambiguous and off by 1e8 if `ICP_USD_RATE` is itself in e8s (which
  `explorer_usd_rate_e8s` is). Use the shared helper rather than a raw formula so
  the units match the rest of the app.
* **Cache:** reuse the **existing** rate cache (`refresh_icp_rate`, `lib.rs:3833`,
  already warmed on a timer in `post_upgrade` and before sync valuations) — do
  **not** add a second bespoke 1-hour cache. A turn reads the cached rate
  synchronously; no XRC call on the hot path.

### A3. Escrow Prepaid Credit System (Decision & Justification)

* **Decision**: We implement a **prepaid credit balance** on the backend canister (`AI_USER_CREDITS`), rather than charging directly from the user's ledger account on every message.
* **Justification**:
  1. **Latency**: A ledger transaction (`icrc2_transfer_from`) takes 2–3 seconds. Compounding this with the LLM API's latency (2–4 seconds) would result in a sluggish 6-second delay per message. A local credit deduction takes milliseconds.
  2. **Ledger Fees**: Every ICP transfer costs a flat 10,000 e8s fee. If a message costs 5 cents (~0.005 ICP), the ledger fee represents a 2% overhead on every turn. Using a prepaid model means ledger fees are only paid once during deposit or withdrawal.
* **Flow**:
  * Users deposit ICP to a derived subaccount on the backend (`get_ai_credit_deposit_address()`). The backend canister tracks `AI_USER_CREDITS` and sweeps the subaccount when they call `deposit_ai_credits()`.
  * Users can withdraw their remaining credit balance at any time (`withdraw_ai_credits()`).

### A4. Stateless Canister Design (Optimization)

* **Decision**: The backend canister does **not** store the chat message history in stable memory.
* **Justification**: Storing text logs in stable structures would bloat the canister's database, increase upgrade serialization costs, and burn storage cycles.
* **Flow**: The chat history is maintained entirely **client-side** (in React state). On each message turn, the frontend sends the *entire chat history array* to the backend canister, which forwards it to the Cloud Run LLM wrapper. The canister behaves as a stateless, fee-charging proxy.
* **Caveat — flat fee vs. growing context.** Sending the whole history every turn means **both the outcall size/cycles and the LLM token cost grow with conversation length**, while the fee stays flat at $0.05. Two mitigations: (a) **cap context** — clamp the forwarded history to the last *N* turns or a max byte budget (also protects `max_response_bytes`/the 2 MB ceiling); (b) treat $0.05 as covering a bounded turn and reject oversized histories with a clear error. Verify $0.05 > (LLM token cost + outcall cycles + margin) at the cap — comfortable under Option 1 (non-replicated), tight under Option 2.
* **Caveat — server-authoritative proposal grounding.** `query_ai_reviewer` takes a `proposal_id`, so the canister should inject the **authoritative proposal text from its own state** (it already holds proposals) into the system context, rather than trusting the client-supplied seed. Otherwise a client can omit/forge the proposal and the feature is just a general-purpose $0.05 LLM proxy (a product decision — but if it's meant to be *proposal* review, ground it server-side). Forwarding the rest of the chat history verbatim is fine (it's the user's own paid turn).

---

## Part B — Implementation

### B1. Google Cloud Run LLM Hosting

The LLM is wrapped in a containerized web service deployed on Google Cloud Run (written in Node.js or Python).
* **Endpoints**: Exposes `POST /v1/review` which accepts:
  ```json
  {
    "history": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ]
  }
  ```
* **AI Provider**: Uses Google Vertex AI (Gemini 1.5 Flash) or OpenAI GPT-4o-mini via API keys.
* **Authentication**: a pre-shared key in the `Authorization: Bearer <API_KEY>` header, stored in `CONFIG` (admin-set), never exposed to the **frontend**.
  * **Security caveat (important):** canister state is **not secret from the subnet's node providers** — they execute the canister and can inspect its memory, and under a **replicated** outcall the header is sent from every node. So treat this key as *semi-public*: scope it to **only** the Cloud Run wrapper, **rate-limit and budget-cap** it provider-side, rotate it regularly, and keep its blast radius small (it must not be a key that can run up an unbounded Vertex/OpenAI bill). Prefer Option 1 (non-replicated) so the key leaves only one node per call. Do not reuse a high-privilege cloud key here.

### B2.0 Response determinism — the core IC constraint (MUST READ)

**This is the make-or-break of the feature, and the original draft missed it.**
A *replicated* HTTPS outcall goes through **consensus**: all ~13 subnet replicas
independently call the endpoint and must agree on the (transformed) response, or
the call fails with a consensus error ([IC docs](https://internetcomputer.org/docs/references/https-outcalls-how-it-works),
[Security best practices](https://internetcomputer.org/docs/current/developer-docs/security/security-best-practices/https-outcalls)).
**LLM responses are non-deterministic** — 13 parallel calls to the same model
return 13 different texts — so the original "13 nodes, forward verbatim" design
**fails consensus on every turn.** Two viable designs:

- **Option 1 (recommended): non-replicated HTTPS outcall** — set `is_replicated:
  false` so a **single** replica makes the call. This *eliminates* the
  consensus/determinism problem, **removes the need for a transform function, and
  costs ~100× less** than replicated (per IC docs). Trust tradeoff: one node sees
  and relays the response and could in principle tamper — acceptable here because
  the output is a **non-financial advisory summary** (no value moves on its
  content). Best fit; make this the default.
- **Option 2: replicated outcall + idempotency + server-side cache + transform** —
  only if a replicated guarantee is wanted. The Cloud Run wrapper must return
  **byte-identical** responses to all 13 replica calls of one turn: the canister
  generates a per-turn **`Idempotency-Key`** header; the wrapper calls the LLM
  **once** per key, caches the result, and returns the cached bytes to every
  replica. Plus a **transform function** to strip non-deterministic response bits
  (e.g. `Date`). Costs ~13× Option 1 and depends on the wrapper being a correct
  dedupe cache.

> Idempotency keys are also recommended for **any** POST outcall because a POST
> may legitimately be sent multiple times — so include `Idempotency-Key` even
> under Option 1, so a retried turn doesn't double-bill the LLM.

### B2. Canister HTTP Outcalls

To call the Cloud Run service, the backend canister uses the Management Canister's `http_request` interface (via `ic_cdk`'s HTTPS-outcall API), per the determinism design in B2.0:

* **Replication**: default to **non-replicated** (`is_replicated: false`, Option 1). The original "13-node = cheapest" note was backwards — non-replicated is the cheap path (~100× less); replicated 13-node is the *expensive* one and needs the idempotency+transform machinery.
* **Request Shape**:
  * **Method**: `POST`
  * **URL**: Google Cloud Run HTTPS URL (from `CONFIG`).
  * **Headers**: `Content-Type: application/json`, `Authorization: Bearer <API_KEY>`, `Idempotency-Key: <per-turn key>` (see B2.0).
  * **Body**: JSON-serialized messages array.
  * **`max_response_bytes`**: set an explicit, tight cap (e.g. 8–16 KB). HTTPS-outcall **cycles cost is charged on the *reserved* `max_response_bytes`, not the actual size**, so an unset/huge cap massively overcharges; the cap also defends the 2 MB response ceiling.
* **Transform function**: required under Option 2 (replicated) to canonicalize responses (strip `Date`/non-deterministic headers, keep only the body). Not needed under Option 1 (non-replicated).
* **Cycles Allocation**: attach cycles via the `ic_cdk` HTTPS-outcall API (the management-canister `http_request` with a cycles amount). Cost ≈ base + request_bytes·c_req + `max_response_bytes`·c_resp, multiplied by replication factor (1 for non-replicated, ~13 for replicated). Compute and attach the exact amount; refund of unused cycles is automatic.
* **Response Parsing**: the callback treats **HTTP 200 with a parseable body** as success; anything else (non-200, unparseable, timeout) is a failure that triggers the credit refund (Part D). Deserialize the JSON `body` and return the assistant text to the caller.

### B3. Stable Structures & Memory Allocations

* **MemoryId 94**: `AI_USER_CREDITS: StableBTreeMap<Principal, u64, Memory>` (User principal $\rightarrow$ prepaid credit balance in e8s).
* **MemoryId 95**: Reserved for future AI audit logs or state.
* **Allocation pinned (collision resolved).** Ids `94–95` are reserved for this
  spec in the **canonical cross-feature registry**
  (`/ideas/course-nft/tasks/00-overview-and-architecture.md §5`), where course-nft
  owns 76–89 and the cycles-faucet owns 90–93. No overlap. Never reuse a
  MemoryId; `AI_USER_CREDITS` is a plain `u64` so it's upgrade-trivial, but the
  *id* must stay unique — add any new structure to the registry first.

---

## Part C — Candid & API Specifications

### C1. Backend Candid Interface (`backend.did`)

```candid
type ChatMessage = record {
  role    : text; // "user" or "assistant"
  content : text;
};

type AiReviewResult = variant {
  Ok  : text; // The AI response
  Err : text; // INSUFFICIENT_CREDIT | RATE_LIMIT | OUT_CALL_FAILED
};

type AiCreditSummary = record {
  balance_e8s   : nat64;
  cost_per_turn : nat64; // Dynamic e8s equivalent of $0.05
};

service : {
  get_ai_credit_deposit_address : () -> (LedgerAccount) query;
  deposit_ai_credits            : () -> (variant { Ok : nat64; Err : text }); // Sweeps deposit subaccount
  withdraw_ai_credits           : (nat64) -> (variant { Ok; Err : text });
  get_ai_credit_summary         : () -> (AiCreditSummary) query;
  
  query_ai_reviewer             : (nat64, vec ChatMessage) -> (AiReviewResult); // proposal_id, history
}
```

---

## Part D — Acceptance Criteria

1. **Prepaid Billing**:
   * Users cannot call `query_ai_reviewer` unless their `AI_USER_CREDITS` balance $\ge$ the current 5-cent ICP equivalent.
   * The balance is deducted **immediately before** the outcall (this also prevents a double-spend from a concurrent turn).
   * The fee is refunded **only on definitive failure** (non-200, unparseable body, or timeout); a successful 200 turn keeps the charge. Deduct/refund is idempotent.
2. **Outcall determinism (B2.0)**:
   * A turn completes **without a consensus error** — i.e. it uses a non-replicated outcall (Option 1), or a replicated outcall whose idempotency-key + server cache + transform yield byte-identical responses (Option 2). *This is the criterion the original draft would have failed.*
3. **Reentrancy / safety**:
   * Concurrent in-flight turns from one user cannot double-spend or interleave (`CallerGuard` + deduct-first).
   * `RATE_LIMIT` is enforced with a defined policy (e.g. max 1 in-flight turn per principal + a short per-principal cooldown) — the candid already exposes the error.
4. **XRC Rate Mapping**:
   * Cost in ICP shifts dynamically as the ICP/USD rate changes, via the shared `explorer_usd_rate_e8s`/`explorer_quote_amount` path.
   * Reads the **existing** `refresh_icp_rate` cache; no new cache, no XRC call on the hot path.
5. **Canister HTTP Outcall**:
   * Authenticated with the `CONFIG` key; key is scoped/rate-limited provider-side (B1 caveat).
   * `max_response_bytes` is set tightly; payloads encode/decode correctly.
6. **Chatbot UI**:
   * Modal renders from any proposal card; auto-triggers the initial summary on open (using the **server-grounded** proposal context).
   * Restricts input during outcalls; shows the **canister-returned** `cost_per_turn`/balance and a deposit CTA when credits are low.

---

## Part E — Review revisions

Changes applied in this review pass (correctness-first):

| # | Issue | Severity | Fix |
|---|---|---|---|
| R1 | **LLM responses are non-deterministic → a replicated 13-node outcall fails consensus every turn.** The original "13 nodes, forward verbatim" design doesn't work on the IC. | **Critical** | New **§B2.0**: default to **non-replicated** outcall (`is_replicated:false`, ~100× cheaper, no transform); alternative replicated path needs idempotency-key + server cache + transform. Rewrote B2; fixed the backwards "13-node = cheapest" claim. |
| R2 | Pricing formula unit-ambiguous (off by 1e8 vs `explorer_usd_rate_e8s`); bespoke 1-hour cache duplicates existing infra | High | A2 now reuses `explorer_usd_rate_e8s`/`explorer_quote_amount` + the existing `refresh_icp_rate` cache. |
| R3 | Flat $0.05 vs context that grows every turn (cost + 2 MB limits); client-controlled "proposal" seed | Med | A4: cap context; verify fee covers cost at the cap; **server-ground** the proposal from canister state via `proposal_id`. |
| R4 | API key in `CONFIG` is visible to node providers (esp. replicated) | Med | B1: treat as semi-public — scope, budget-cap, rotate; prefer non-replicated. |
| R5 | MemoryId 92/93 may collide with the faucet's "90+" claim | Med | B3: pin a non-overlapping block in a shared registry before building. |
| R6 | Missing: consensus, reentrancy, rate-limit, refund-success definition; `http_request_with_cycles` naming; `max_response_bytes` | Med | Acceptance criteria 1–6 expanded; B2 corrected. |
| R7 | PB-500 collided with the Oisy spec; spec header disagreed with its own task list (PB-510) | Low | Renumbered to **PB-510**. |
