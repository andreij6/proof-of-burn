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

4. **vetKeys for the API key — CONFIRMED: it does NOT do what we hoped (Q4).**
   The question was "does vetKeys let me add an API key directly to a canister
   *safely*?" **Answer: no — not in the sense of node operators being unable to
   read it.** DFINITY's own docs are explicit:
   - *"vetKeys guarantees strong confidentiality **up to the point of
     decryption**. Once the plaintext is handed off to a canister, it should no
     longer be assumed private."*
     ([vetKeys use cases](https://medium.com/dfinity/onchain-privacy-in-action-a-guide-to-vetkeys-use-cases-d733aa6f9da5))
   - *"**If you decrypt it in the canister, then it's out in the open again.**"*
     (same source; it names future **TEEs**, not vetKeys, as the eventual fix.)

   Why: to put the key in the Gemini `x-goog-api-key` header the canister must
   **decrypt it during a replicated update** — which executes on **all ~13
   replicas**, so every node sees the plaintext at use time. (The non-replicated
   outcall only changes which node *egresses* the HTTP request; it does **not**
   confine the decryption — my earlier "single-node exposure" note was wrong.)
   vetKeys' real benefit here is narrow: **encrypted at rest** (a controller state
   dump sees ciphertext, not the key). It does **not** hide the key from a node
   operator observing execution.

   **The correct framing:** *no secret placed in an outcall header is hidden from
   node operators today.* So don't try to hide it — make the node-visible
   credential **worthless to steal**. → **Decision D4: Cloud-Run proxy.** The
   canister calls our proxy with a **narrowly-scoped, budget-capped, rotatable
   bearer token**; the proxy holds the real Gemini key in its env and is the only
   thing that token can reach. A node operator who captures the token can only hit
   our rate/budget-limited proxy — not run up an unbounded Gemini bill. The real
   Gemini key **never touches the IC**. (vetKeys stays the right tool for *user*
   data, e.g. private per-user content — just not for a canister-used service key.)

---

## What ships (MVP)

- An **"AI Review"** button on each proposal card (Dashboard/voting list),
  **enabled when the signed-in user holds any supported token with a balance ≥ the
  fee** (D2); disabled/tooltipped otherwise.
- A **confirm dialog** (clone of the Explorer listing flow): pick a token, see the
  live USD-priced **$0.25** fee (D3), deposit to a per-user escrow, confirm.
- The canister charges the fee → **routes it to the treasury** → calls our
  **Cloud-Run proxy** (D4) which makes the Gemini call, seeded with the canister's
  authoritative proposal text (+ the linked PR/release URL via URL-context). The
  proxy returns a **structured response with TWO renderings** (D5): a
  **tweet-friendly** string and a **detailed** breakdown (verdict + rationale +
  IC impact). The outcall itself is **non-replicated**.
- The result is shown in-app (detailed) with a **"Share on X"** button that posts
  the **tweet-friendly** text (reuses `shareProposalOnX`). **Reviews are NOT
  stored** (D5) — the text lives only in the tweet/session.
- **Refund on failure**: a non-200/timeout/parse-failure refunds the fee
  (treasury-fronted, so also subject to the **`require_treasury_can_front` gate**).

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Decisions (locked 2026-06-19)

- **D1 — One-shot.** Strictly one-shot paid review. No conversational chat (PB-510's
  chat vision is dropped).
- **D2 — Gating.** Button enabled when the user holds **any supported token with a
  balance ≥ the fee** (check all five token balances client-side, not just ICP).
- **D3 — Fee = $0.25.** `AI_REVIEW_FEE_USD_E8S = 25_000_000`, USD-priced via XRC.
- **D4 — Cloud-Run proxy (NOT vetKeys).** Confirmed above: vetKeys can't keep a
  canister-used API key secret from node operators. The Gemini key lives in the
  proxy, off-chain; the canister→proxy bearer token is scoped + budget-capped +
  rotatable so it's worthless if a node captures it.
- **D5 — Don't store reviews.** The proxy/Gemini returns two renderings — a
  **tweet-friendly** string and a **detailed** in-app breakdown. We render and
  (optionally) tweet; nothing is persisted on-chain. (No `AI_REVIEWS` store → one
  fewer MemoryId; "View AI Review" / permalink dropped.)
- **D6 — Framing.** Every result shows an unmissable **"AI opinion — not financial
  or voting advice"** disclaimer (on-card and folded into the tweet), and a verdict
  never auto-applies to the user's vote/commitment. (Q6 was: should we worry the
  branded verdict looks like vote-steering / investment advice? → yes; the
  disclaimer + read-only-advisory stance is the mitigation.)

## MemoryId note (registry drifted)
PB-510 reserved `94/95`, but **94 is now taken** (`FEATURED_QUOTES`, shipped) and
`53` (treasury cache, shipped). Currently free: **26–33, 54–59, 73, 76, 95, 97+**.
With **D5 (no review store)** this feature only needs **two** ids — claim **95**
(`AI_REVIEW_QUOTES`) and **97** (`AI_LAST_REVIEW_AT` cooldown) and update the
registry *before* building.
