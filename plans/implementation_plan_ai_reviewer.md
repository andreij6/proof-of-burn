# AI Proposal Reviewer — DFINITY LLM Canister, 3 ICP per Generation — Implementation Plan

## What this feature is

A paid, cached AI review for every NNS proposal shown in the app:

* A button on each proposal card. If no review exists, it reads
  **"AI review · 3 ICP"** and opens a payment dialog; the payer funds one
  generation via the DFINITY **LLM canister**, and the result is cached
  on-chain.
* If a cached review exists, the button opens it **free for everyone** —
  the first payer sponsors the review for the community (and is credited
  on it).
* Every signed-in user may vote the review 👍/👎 (one vote per principal).
  When the review goes **net-negative (downvotes > upvotes)** it is deleted
  from the cache; the next person who wants a review pays 3 ICP to
  regenerate it fresh.

This finally activates the `ai_price_e8s` config field and replaces the
mocked `aiReviews` map + `AIPanel` component that already exist in the UI.

## Research findings (June 2026)

| Fact | Value |
|---|---|
| LLM canister id (mainnet) | `w36hm-eqaaa-aaaal-qr76a-cai` (closed-source DFINITY prototype, calls routed to "AI worker" nodes) |
| Rust client | `ic-llm` crate v1.1.0 — `prompt(Model, &str)`, `chat(Model).with_messages(vec![ChatMessage::System{..}, ChatMessage::User{..}]).send()` |
| Models | `Model::Llama3_1_8B`, `Model::Qwen3_32B`, `Model::Llama4Scout` |
| Limits | ≤ 10 messages/request, ≤ 10 KiB total prompt, ≤ 1000 output tokens |
| Cost | **Free for now**; DFINITY may meter later → our 3 ICP price is nearly pure margin today and headroom for when it isn't |
| Trust model | AI workers are DFINITY-operated (not replicated consensus) — acceptable for a paid convenience feature; disclosed in the dialog footer |

## Decisions locked in (owner veto points)

1. **Model: `Llama4Scout`**, set as a code constant with the model name
   stored on every review (display + cache hygiene). Swapping models is a
   one-line redeploy; not admin-tunable in v1.
2. **Price: 3 ICP** via the existing `Config.ai_price_e8s`. Fresh-deploy
   default changes to `300_000_000`; a new `admin_set_ai_price` setter
   handles live canisters (runbook step — serde defaults can't migrate an
   existing field). Fee split is the house **50/25/25**
   (treasury / backend-CMC / frontend-CMC) — every review burns ICP.
3. **Cache & free reads.** One review per NNS proposal (current generation
   only). Cached review is readable by anyone, including anonymous —
   "3 ICP per request" is interpreted as *per generation request*; repeat
   requests for the same proposal are served from cache at no cost.
4. **Deletion rule: net-negative, not single-downvote.** The literal spec
   ("if it is downvoted delete") lets one griefer nuke a 3 ICP purchase
   and force re-payment. Implemented as: delete when
   `downvotes > upvotes`, checked after every vote, one vote per principal
   per generation. **⚠ flag for owner**: revert to literal
   single-downvote-deletes is a 2-line change if preferred.
5. **Regeneration is a fresh purchase.** Deletion clears the review and its
   votes; the `generation` counter increments so stale votes can never
   apply to new content.
6. **Feature flag `ai_reviewer`, default OFF — ships dark.** Added to
   `KNOWN_FEATURE_FLAGS`; the UI button, `request_ai_review`, and
   `vote_ai_review` are all gated. The feature goes live only when an
   admin flips it on via the existing flag panel (after the PB-185 mainnet
   smoke test), and the same switch is the instant kill switch if the
   DFINITY LLM canister — a "prototype" — changes under us.
7. **Local dev: deterministic mock.** `is_local` ⇒ the generation step
   returns a canned review embedding the proposal id (house pattern, same
   as the NNS mocks), so pay→cache→vote→delete is fully testable locally
   and in PocketIC. An ollama-backed local LLM canister is a stretch goal,
   not a dependency.
8. **Pay-then-generate with a journaled saga.** Payment settles first
   (idempotent block-guarded split, like upvotes/golf); if the LLM call
   then fails, the review record sits in `FailedGeneration` and the sweep
   retries the *generation only* — the paid ticket is always honored,
   funds are never charged twice.

## 1. Data model (`lib.rs` — memory IDs 24–25; 0–17 in use, 18–23 reserved by the Burn Putt plan)

```rust
pub enum AiReviewStatus { PendingPayment, Generating, Ready, FailedGeneration }

pub struct AiReview {                       // AI_REVIEWS: Map<u64 /*nns id*/, AiReview> (mem 24)
    pub nns_proposal_id: u64,
    pub generation: u32,                    // bumps on every regeneration
    pub status: AiReviewStatus,
    pub sponsor: Principal,                 // who paid the 3 ICP
    pub requested_at: u64,
    pub generated_at: Option<u64>,
    pub model: String,                      // "llama4-scout"
    pub prompt_version: u16,                // cache key component; bump invalidates
    pub content: String,                    // ≤ 1000 tokens ≈ ≤ 8 KiB
    pub upvotes: u32,
    pub downvotes: u32,
    // 50/25/25 fee-split saga guards (idempotent retry):
    pub treasury_block: Option<u64>,
    pub backend_cmc_block: Option<u64>,
    pub frontend_cmc_block: Option<u64>,
}

// AI_REVIEW_VOTES: Map<(u64 /*nns id*/, u32 /*generation*/, Principal), u8 /*1=up,0=down*/> (mem 25)
```

`Config`: fresh default `ai_price_e8s = 300_000_000`; new
`admin_set_ai_price(e8s)` (reject 0 and > 1000 ICP).

## 2. Backend API

* `get_ai_review(nns_proposal_id) -> opt AiReviewView` *(query, public)* —
  `Ready` reviews only; includes content, sponsor, model, votes,
  generation, and `my_vote` for the caller.
* `get_ai_review_deposit_address(nns_proposal_id) -> LedgerAccount`
  *(query)* — caller subaccount, domain `proof_of_burn_ai_review_v1`.
* `refund_ai_deposit(nns_proposal_id) -> Result` — returns any unspent
  escrow (covers the "someone else's review landed first" race).
* `request_ai_review(nns_proposal_id) -> Result<AiReviewView>` *(update)*:
  1. auth + `ai_reviewer` flag + `CallerGuard` + per-proposal lock
     (`ProposalLock` pattern) — two simultaneous payers can't double-generate;
     the loser keeps their escrow and reclaims via `refund_ai_deposit`.
  2. cache hit (`Ready`) ⇒ return it, **charge nothing**.
  3. proposal must exist in `PROPOSALS`; escrow ≥ `ai_price_e8s + 3×10_000`.
  4. journal `AiReview{PendingPayment, generation+1}` → run 50/25/25 split
     (block-guarded) → `Generating` → build prompt → `ic_llm::chat(...)`
     (mainnet) / canned mock (local) → store `content`, `Ready`.
  5. audit `ai_review_paid` (3 ICP) + `ai_review_ready`.
* `vote_ai_review(nns_proposal_id, generation: u32, up: bool) -> Result<opt AiReviewView>`
  *(update)*: auth + flag; review must be `Ready` and generation current;
  one vote per principal per generation (`ALREADY_VOTED`); sponsors may
  vote too (they paid, they're allowed an opinion). After applying:
  if `downvotes > upvotes` ⇒ **delete** the review row + its votes, audit
  `ai_review_deleted` (returns `null` so the UI flips back to pay state).
* Sweep `retry_failed_ai_reviews()`: re-run generation for
  `FailedGeneration` rows (payment already settled; no new charge); wired
  into `setup_timers` + `admin_trigger_sweep`.

## 3. Prompt construction (must fit 10 KiB total)

* `PROMPT_VERSION: u16 = 1` constant, stored on the review.
* System message (~1 KiB): "You are the governance analyst for an ICP
  conviction-voting dapp…" — required output structure: **TL;DR (2
  sentences) · Who benefits / who pays · Network & tokenomics impact ·
  Risks & red flags · Verdict (Adopt / Reject / Abstain) with confidence**.
  Plain text only (UI renders pre-wrap; no markdown dependency).
* User message: proposal id, title, category + summary **truncated to
  8 KiB** with an explicit `[summary truncated]` marker so the model knows.
* The ≤ 1000-token output cap is the LLM canister's, which conveniently
  bounds our storage per review.

## 4. Frontend (App.tsx + the existing `AIPanel`)

* Delete the mock `aiReviews` record. Fetch real reviews lazily: when
  proposals load, batch `get_ai_review` for visible proposals (or fetch on
  panel expand — implementer's choice; lazy preferred).
* **Proposal card button** (both Open and Committed tabs):
  * no cached review → `✨ AI review · 3 ICP` (price live from
    `config.ai_price_e8s`) → **PayDialog**: price, the standard two-step
    escrow flow (deposit → `request_ai_review`), disclosure footer
    ("Generated by Llama 4 Scout via DFINITY AI workers · review is cached
    and visible to all users · community can vote it out of existence"),
    then a progress state ("Consulting Llama 4 Scout — can take up to a
    minute…") since the update call awaits the LLM canister.
  * cached review → `✨ AI review` chip (with net-vote count) →
    **ReviewDialog**: content (pre-wrap), sponsor + model + generated-at
    meta line, and 👍/👎 buttons with live counts; the caller's existing
    vote renders highlighted/disabled.
* On a vote response of `null` (deleted): toast "The community voted this
  review out — it's gone from the cache", close dialog, button reverts to
  the pay state.
* Anonymous users: can read cached reviews; voting/paying prompts sign-in.
* Tier gating: none beyond sign-in — any authenticated user may pay.

## 5. Testing

* Host unit: price guard rails; cache-hit returns without charging;
  net-negative deletion boundary (1↑/2↓ deletes, 2↑/2↓ survives);
  double-vote rejected; generation bump invalidates old votes; saga retry
  after mocked LLM failure regenerates without re-charging.
* PocketIC: full pay→generate(mock)→cached-free-read→vote-to-deletion→
  re-pay flow; flag-off rejection; race (second payer gets cache + refund
  path works).
* Vitest: dialog state machine (pay → progress → review), vote UI states,
  price formatting from config.
* Mainnet smoke (post-deploy, owner-run): one real 3 ICP review against a
  live proposal; verify latency and output quality before announcing.

## 6. Rollout & ops

* `cargo add ic-llm@1.1` (backend). Bindings regenerate as usual.
* Deploy → **runbook step: `admin_set_ai_price '(300_000_000)'`** on any
  existing canister (upgrade keeps the old 0.05 ICP default otherwise).
* Update `llms-rd-*.txt` agent skills with the review request/vote flow
  (agents are likely the heaviest users — they can afford 3 ICP for
  research they'd otherwise compute themselves).
* **Enablement is deliberate:** the feature deploys with `ai_reviewer`
  OFF everywhere. Local: deploy-local.sh enables it for dev. Mainnet:
  owner runs the smoke test first, then
  `admin_set_feature_flag '("ai_reviewer", true)'`.
* Margin watch: DFINITY may start charging cycles for the LLM canister;
  `ai_price_e8s` is the lever. Kill switch: the same flag, set to false.

## 7. Risks

* **LLM canister is a closed-source prototype** — could change API,
  models, or pricing. Mitigations: flag kill switch, saga retry, version
  pinning of `ic-llm`, model name stored per review.
* **Latency** (one update call awaiting an AI worker) — UI progress state;
  agent timeout budget is fine (update calls poll for minutes).
* **Vote brigading both ways** — one principal = one vote; principals are
  free to create, so a motivated attacker can still farm votes. Acceptable
  for v1 (worst case: a 3 ICP review gets deleted and someone re-pays);
  revisit with burn-weighted votes if it becomes a problem.
* **10 KiB prompt cap** — giant proposal summaries get truncated; the
  review honestly flags it.

## Task list (Epic H — PB-180…PB-185)

| ID | Task | Depends on |
|---|---|---|
| PB-180 | Backend: config (3 ICP price + setter), flag, AiReview/vote data model, deposit + refund endpoints | — |
| PB-181 | Backend: `request_ai_review` payment saga + ic-llm integration + local mock + retry sweep | PB-180 |
| PB-182 | Backend: voting, net-negative deletion, generation bump, audit events | PB-181 |
| PB-183 | Frontend: replace AIPanel mock — button states, PayDialog, ReviewDialog, vote UX | PB-182 |
| PB-184 | Tests: host + PocketIC E2E + vitest dialog/vote suites | PB-183 |
| PB-185 | Agent skills + OPS runbook (price migration call, kill switch) + mainnet smoke checklist | PB-184 |
