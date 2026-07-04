---
type: idea
title: "Proposal TL;DR — grounded one-line + impact summary on every proposal"
tags: [ideas, proposal-tldr]
timestamp: 2026-06-20T07:42:46-04:00
---

# Proposal TL;DR — grounded one-line + impact summary on every proposal

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-20.
> Companion features specced same day: [idea-pitch-coach](../idea-pitch-coach/README.md),
> [auto-recaps](../auto-recaps/README.md). Sibling (heavier, paid): [ai-proposal-review](../ai-proposal-review/README.md).

A **free "TL;DR" panel** on every NNS proposal card: a plain-English summary,
"who this helps / hurts," and the key change — generated **once per proposal** by
**Gemini (via the Cloud Run proxy)**, **cached on-chain**, and served to everyone.
It upgrades the exact screen where users decide *how to burn*.

This is deliberately the **light, free, cached** counterpart to the paid, per-user,
not-stored **AI Proposal Review**. They coexist: TL;DR helps you read the proposal;
AI Review gives a paid opinionated verdict.

---

## Why cached-per-proposal (the key design choice)

A proposal summary is **identical for every user**, so we generate it **once** and
cache it keyed by `proposal_id`. Consequences:

- **One Gemini call amortized across all viewers** → cost is bounded by the number
  of proposals (hundreds), not users × proposals. Cheap enough to be **free**.
- **No per-user fee, no escrow, no quote** — none of the money plumbing the paid
  features need.
- **Deterministic-enough caching:** the first read triggers generation; the result
  is frozen on-chain. Re-generation only on explicit admin refresh (D4).

This makes TL;DR the cheapest possible Gemini feature to ship and the highest-traffic
(every proposal viewer sees it).

---

## What ships (MVP)

- A **collapsible "TL;DR" panel** on each proposal card (Open / Committed / Past),
  above the Adopt/Reject actions. States: `Generating…` → summary, or a one-tap
  **"Summarize this proposal"** button if not yet generated (lazy trigger).
- The summary card (from a Gemini `response_schema`):
  - **One-line TL;DR** (≤200 chars).
  - **Impact**: 2–4 bullets — what changes, who benefits, who's hurt.
  - **A "good/neutral/concern for the IC" lean** chip (advisory; *not* a vote rec).
  - **Grounded**: `url_context` on the proposal's linked URL (forum/PR) +
    `google_search`; a `sources[]` list of cited URLs.
- **Cached on-chain** per `proposal_id` (`PROPOSAL_SUMMARIES`, MemoryId from the
  free pool). Subsequent viewers read it instantly, free.
- An **"AI summary — not voting advice"** disclaimer on the panel.

---

## Proxy endpoint — `POST /v1/summary` (new route in `proxy/main.py`)

Same FastAPI app, same bearer (`_check_auth`), same keyless Vertex client, same
grounding pattern as `/v1/tweets`.

- **in**: `{"proposal_id": int, "title": str, "summary_text": str, "url": str|null}`
  (the canister sends its **authoritative** proposal text — never let the model
  fetch the proposal body itself; only `url_context` the *linked* artifact).
- **out 200**:
  ```json
  {
    "tldr": "<=200 chars",
    "impact": ["bullet", "..."],
    "lean": "good|neutral|concern",
    "sources": ["https://...", "..."]
  }
  ```
- **errors**: `401` bad bearer · `422` bad input · `502` generation failed (canister
  does NOT cache a failure; the button stays retryable).

`response_mime_type=application/json` + `response_schema=<Pydantic Summary>`; Gemini 3
grounding + schema coexist in one call (already proven for `/v1/tweets`).

---

## Backend flow + net-new infra

```
get_proposal_summary(proposal_id)  [query]   → cached Summary | null
request_proposal_summary(proposal_id) [update] → generate if absent, cache, return
admin_refresh_proposal_summary(proposal_id)    → force re-gen (require_admin)
```

`request_proposal_summary`:
1. `require_authenticated()` + `CallerGuard` + a light per-caller cooldown (D3) to
   bound abuse of the *generation* trigger (reads are free + cached).
2. If `PROPOSAL_SUMMARIES` already has it → return cached.
3. Load the canister's authoritative proposal text; **non-replicated outcall** to
   `<proxy>/v1/summary`; on 200, store `Summary { tldr, impact, lean, sources,
   generated_at, model }` in `PROPOSAL_SUMMARIES`; return it.
4. On failure → return `Err`, cache nothing.

**Net-new shared foundation (also needed by pitch-coach & recaps):** the live Gemini
outcall lives only in the **Farmer wasm** (`src/xfarm_farmer`). The **backend** has
no HTTPS-outcall helper yet. Port the Farmer's non-replicated pattern into the
backend: custom `HttpReqArg { is_replicated: Some(false), .. }`,
`Call::bounded_wait(mgmt, "http_request").with_arg(arg).with_cycles(100_000_000_000)
.change_timeout(180).await.candid::<HttpResponse>()`, reusing the **existing proxy
URL + bearer** already stored in `XFARM_CONFIG` (consider renaming to a shared
`PROXY_CONFIG` / `admin_set_proxy`). Build this once; all three features ride it.

---

## Reuse map

| Need | Reuse |
|---|---|
| Proxy URL + bearer | `XFARM_CONFIG` / `admin_set_xfarm_proxy` (lib.rs ~19535) — generalize to a shared proxy |
| Outcall shape | Lift from `src/xfarm_farmer/src/lib.rs` `generate_drafts` (HttpReqArg + bounded_wait, is_replicated false, 180s) |
| Proxy app | `proxy/main.py` — add `/v1/summary` beside `/v1/tweets` |
| Card placement | `App.tsx` proposal cards (~2864 / ~3027), next to Share / AI Review |
| Disclaimer + share | reuse the AI-Review disclaimer pattern + `shareProposalOnX` (optional "Share TL;DR") |

---

## Decisions

- **D1 — Free, cached per proposal.** No fee, no escrow. One call amortized.
- **D2 — Stored on-chain.** `PROPOSAL_SUMMARIES: StableBTreeMap<u64, Summary>` (claim
  **MemoryId 57** — verify free at build). Persisting is the whole point (serve-once).
- **D3 — Trigger throttle.** Lazy generation on first request, guarded by a per-caller
  cooldown so the *generation* path can't be spammed (reads are free regardless).
- **D4 — Refresh is admin-only.** Summaries are frozen once generated; only
  `admin_refresh_proposal_summary` re-runs (proposals are largely static post-ingest).
- **D5 — Advisory framing.** `lean` is a soft signal with an unmissable "not voting
  advice" disclaimer; it never auto-applies to a commitment.

## Risks / guardrails
- **Prompt injection via `url_context`** on the linked (untrusted) forum/PR URL —
  the system prompt must treat fetched content as data, never instructions; output is
  schema-constrained. Top risk, shared with AI Review.
- **Off-chain trust:** the proxy/LLM is an advisory; never gate money or a vote on it.
- **Staleness:** if a proposal's linked artifact changes, the cached TL;DR can lag →
  show `generated_at`; admin refresh covers it.
- **Cost ceiling:** bounded by proposal count; add a global daily generation cap as
  belt-and-suspenders.

## MemoryIds
One new map → **57** (`PROPOSAL_SUMMARIES`). Free pool at spec time: 26–33, 57–59,
73, 76. Claim + update the registry before building.

## Open questions
- **Q1 — Eager vs lazy generation?** Lazy (first viewer triggers) is cheapest; a
  timer that pre-summarizes new proposals gives instant UX at higher cost. MVP = lazy.
- **Q2 — Show TL;DR to anonymous users?** Reads are free + cached; allowing anon reads
  (but auth-only *generation*) maximizes reach. Recommend yes.
