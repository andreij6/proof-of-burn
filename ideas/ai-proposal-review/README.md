# AI Proposal Review ("AI Review" / Chat with Proposal)

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-19.

A pay-per-use **"AI Review"** button on every proposal. A signed-in user who holds
ICP confirms a small crypto fee, the canister asks **Gemini** to review the
proposal — *is this good or bad for the Internet Computer, and why* — optionally
pulling in the linked GitHub PR/release, and returns a structured verdict the
user can **share on X**.

---

## Relationship to the existing `ideas/ai-reviewer/` (PB-510)

This is a **re-scope of the same feature space**, not a fresh one. The prior
`ai-reviewer` spec (PB-510, 2026-06-14) designed a **prepaid-credit, per-turn
chatbot** ($0.05/turn, ICP-only credits, LLM behind a **Google Cloud Run
wrapper**). The user's new framing changes five things:

| Dimension | PB-510 (`ai-reviewer`) | This scope (user's ask) |
|---|---|---|
| Payment | Prepaid credit balance, $0.05 **per chat turn** | **One-shot pay-per-review**, fee **confirm dialog** |
| Tokens | ICP-only credits | **Any supported crypto** (ICP/ckBTC/ckETH/ckUSDC/ckUSDT) |
| Button gating | All authenticated users | **Users who hold ICP** in their wallet |
| LLM transport | Cloud Run wrapper holds the key | **Direct Gemini API**; key stored on-chain via **vetKeys** |
| Output | Chat bubbles | A **shareable-on-X** positive/negative verdict; GitHub-PR aware |

**Recommendation:** supersede PB-510 with this. Keep PB-510's two genuinely
valuable, still-correct findings (they're reused verbatim below):
1. **Non-replicated HTTPS outcalls** are the make-or-break for LLM calls.
2. **Canister state is not secret from node providers** — the key-secrecy
   caveat, which directly shapes the vetKeys decision here.

The user's title says "AI **Chat** with Proposal" but the body describes a
**one-shot review on fee-confirm**. This scope treats the **one-shot paid review
as the MVP** and folds the conversational follow-up chat (PB-510's vision) into
an optional **Phase 2**. → *Open question Q1.*

---

## The core technical findings (researched 2026-06-19)

1. **LLM + HTTPS outcalls = determinism problem, SOLVED by non-replicated calls.**
   A *replicated* outcall runs on ~13 replicas that must agree on the response;
   an LLM returns 13 different texts → consensus fails. **Non-replicated outcalls
   are now LIVE** (`is_replicated: false`): a single replica makes the call, **no
   transform function needed, ~100× cheaper**. Trade-off: one node sees/relays
   the response and could tamper — acceptable because the output is a
   **non-financial advisory** (no value moves on its content). This is the design.
   ([forum: non-replicated live](https://forum.dfinity.org/t/announcing-two-major-upgrades-for-https-outcalls-ipv4-support-non-replicated-calls-are-now-live/54580),
   [outcalls how-it-works](https://internetcomputer.org/docs/references/https-outcalls-how-it-works))

2. **Gemini is a direct REST call.** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
   with header `x-goog-api-key: <KEY>`, JSON body. Supports **structured output**
   (`responseSchema`) → we get a clean `{verdict, rationale[], ic_impact}` instead
   of parsing prose. ([Gemini API ref](https://ai.google.dev/api),
   [API keys](https://ai.google.dev/gemini-api/docs/api-key))

3. **GitHub PRs via Gemini's URL context tool (GA).** Gemini can fetch up to 20
   **public** URLs and ground its answer in them — point it at the PR/release
   URL extracted from the proposal. No separate GitHub API integration required
   for public repos (dfinity/ic etc. are public). Caveat: URL-context can't be
   combined with function calling, and the URL must be public.
   ([URL context GA](https://developers.googleblog.com/url-context-tool-for-gemini-api-now-generally-available/),
   [docs](https://ai.google.dev/gemini-api/docs/url-context))

4. **vetKeys for the API key — honest assessment.** vetKeys (vetKD threshold key
   derivation) lets the canister **encrypt the Gemini key at rest** and decrypt it
   on demand without any single node holding a master key.
   ([vetKeys intro](https://internetcomputer.org/docs/building-apps/network-features/vetkeys/introduction))
   **But** the canister must hold the *plaintext* key in memory at the instant it
   builds the outcall header — and replicated execution means every node sees it.
   The mitigation that makes vetKeys worthwhile here is **pairing it with the
   non-replicated outcall**: the key is encrypted at rest *and* only the **single
   executing replica** ever sees plaintext, per call. Net: "encrypted at rest +
   minimal per-call exposure," **not** "zero exposure." → *Open question Q4 weighs
   this against the simpler Cloud-Run-proxy approach, where the key never touches
   the chain at all.*

---

## What ships (MVP)

- An **"AI Review"** button on each proposal card (Dashboard/voting list),
  **enabled when the signed-in user holds ICP**, disabled/tooltipped otherwise.
- A **confirm dialog** (clone of the Explorer listing flow): pick a token, see the
  live USD-priced fee, deposit to a per-user escrow, confirm.
- The canister charges the fee → **routes it to the treasury** → makes a
  **non-replicated Gemini outcall** seeded with the canister's authoritative
  proposal text (+ the linked PR/release URL via URL-context) → stores and returns
  a structured **verdict** (positive / negative / mixed + rationale + IC impact).
- A **"Share on X"** button on the result (reuses `shareProposalOnX`).
- **Refund on failure**: a non-200/timeout/parse-failure refunds the fee
  (treasury-fronted fee, like every other refund here — which means it's also
  subject to the new **`require_treasury_can_front` gate**).

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Open questions (need owner input)

- **Q1 — One-shot vs chat.** MVP = one-shot paid review. Add the PB-510
  conversational follow-up as Phase 2, or keep it strictly one-shot? *(Title says
  "chat"; body says one-shot.)*
- **Q2 — Button gating.** Literal ask is "users who hold ICP." But the fee is
  payable in **any** token. Gate on *has ICP > 0*, or *has any supported-token
  balance ≥ the fee*, or just *signed in*? Recommend: **signed-in + holds ICP**
  (matches the ask; cheap to check client-side via `holdings`).
- **Q3 — Fee.** One full review (Gemini Flash + URL fetch + ~structured output)
  is heavier than a $0.05 chat turn. Suggest **$0.25–$1.00 per review**, USD-priced
  via XRC. Pick the number.
- **Q4 — Key custody.** **vetKeys on-chain** (the user's instinct; encrypted at
  rest, single-node exposure per call) **vs Cloud-Run proxy** (key fully
  off-chain, never on the IC; the PB-510 approach). Recommend starting with the
  **proxy for the MVP** (lowest risk, key never on-chain) and treating vetKeys as
  a **"pure-ICP" hardening follow-up** — unless on-chain custody is a hard
  product requirement. See [04](04-adversarial-review.md) R4.
- **Q5 — Result permanence / shareability.** Store each review on-chain (keyed by
  id) so the X post can deep-link to a public review page, or share text-only?
  Storing enables a verifiable permalink + caching (re-share without re-paying).
- **Q6 — Prompt-injection stance.** Proposal summaries and PR contents are
  **attacker-controlled**. The review must be hardened against "ignore previous
  instructions" payloads and must visibly frame output as **AI opinion, not
  financial advice** (it's shared publicly under our brand). See [04](04-adversarial-review.md) R1.

## MemoryId note (registry drifted)
PB-510 reserved `94/95`, but **94 is now taken** (`FEATURED_QUOTES`, shipped) and
`53` (treasury cache, shipped). Currently free: **26–33, 54–59, 73, 76, 95, 97+**.
This feature should claim **95 + 97/98** and update the registry *before* building.
