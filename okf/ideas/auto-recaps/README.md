---
type: idea
title: "Auto-Recaps — Gemini-drafted \"this week in Caldera\" posts from on-chain stats"
tags: [ideas, auto-recaps]
timestamp: 2026-06-20T07:42:46-04:00
---

# Auto-Recaps — Gemini-drafted "this week in Caldera" posts from on-chain stats

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-20.
> Companion features specced same day: [proposal-tldr](../proposal-tldr/README.md),
> [idea-pitch-coach](../idea-pitch-coach/README.md). Pairs with a `/loop` (see the
> loops brainstorm) and reuses the live X-Farm proxy.

An **internal marketing tool**: the canister hands its own on-chain stats to
**Gemini (via the Cloud Run proxy)**, which drafts a short, on-brand recap —
*"X ICP burned this week · lottery jackpot won by … · N new ideas"* — for an admin
to **review and post to X**. Turns the protocol's own proof-of-burn numbers into a
recurring growth drumbeat, with **zero auto-publishing**.

This is **not user-facing and not paid**. It's an admin/ops draft generator, the
content counterpart to the reliability `/loop`s.

---

## What ships (MVP)

- An **admin-only** `draft_recap(kind)` that gathers a stats snapshot, calls the
  proxy, and returns **2–3 ready-to-post variants** (different angles/lengths) for a
  human to pick, tweak, and post manually.
- Recap kinds: **`weekly`** (burn + lottery + board activity), **`lottery_win`**
  (fired after a jackpot — winner + pot + odds story), **`milestone`** (e.g. "100k
  ICP burned").
- Surfaced in the **Admin panel** as a "Draft recap" card → shows the variants with a
  **Copy** and **Share on X** button. The latest draft can be cached for review.
- **Never auto-posts.** Output is always a human-in-the-loop draft (respects the
  don't-auto-publish-externally rule).

---

## The stat snapshot (all already on-chain — no new tracking)

The canister assembles a compact, **factual** payload from existing reads so the model
only *phrases* numbers, never invents them:

| Field | Source |
|---|---|
| ICP burned (period + all-time) | `globalStats.total_burned_e8s` (+ a period delta) |
| Pending burn / committed | `globalStats.pending_burn_e8s`, `votes_threshold_met` |
| Latest lottery draw / winner / pot | `list_recent_winners`, `list_lottery_draws`, `get_lottery_info` |
| New ideas / top idea | `list_ideas` (count + most-upvoted this period) |
| New dapp listings | Explorer directory delta |
| Treasury balance | treasury stats |

Recommendation: add a tiny **period-delta helper** (burned-since-timestamp) so
"this week" numbers are exact rather than the model guessing a delta. → Q1.

---

## Proxy endpoint — `POST /v1/recap` (new route in `proxy/main.py`)

Same app, bearer, keyless Vertex. Grounding **optional** (mostly off — the numbers are
authoritative from the canister; `google_search` only if you want a topical hook).

- **in**: `{"kind": "weekly|lottery_win|milestone", "stats": {<snapshot>}, "variants": 1-3, "tone": "..."}`
- **out 200**:
  ```json
  { "posts": [{"text": "<=280 chars, ends with $ICP + hashtags", "kind": "weekly"}, ...] }
  ```
- **errors**: `401` bad bearer · `422` bad input · `502` generation failed.

Reuses the **exact `$ICP` + relevant-hashtags** style already proven in `/v1/tweets`
(can literally share the system-prompt fragment). `response_schema` for clean variants.

---

## Backend flow + shared foundation

```
draft_recap(kind, variants) [update, require_admin] → vec<RecapPost>
get_last_recap() [query]                            → cached drafts | null   (optional)
```
1. `require_admin()`.
2. Assemble the stat snapshot from existing getters (+ the period-delta helper).
3. **Non-replicated outcall** to `<proxy>/v1/recap`.
4. Return the variants; optionally cache the latest in a small cell for the Admin UI.

**Shared foundation:** rides the same backend Gemini-outcall helper introduced by
[proposal-tldr](../proposal-tldr/README.md#backend-flow--net-new-infra). No per-user
money path (admin-only, free).

**`/loop` pairing:** a weekly loop can call `draft_recap("weekly")` and surface the
drafts to you for review every Monday — read/draft-only, never posting. A
`lottery_win` recap can be triggered right after a draw the loop detects.

---

## Reuse map

| Need | Reuse |
|---|---|
| Tweet style ($ICP + hashtags, ≤280) | `proxy/main.py` `/v1/tweets` system prompt |
| Stats | `globalStats`, `list_recent_winners`, `get_lottery_info`, `list_ideas`, Explorer dir |
| Share on X | `shareProposalOnX` / X-Farm share button |
| Admin surface | existing Admin panel (`Admin.tsx`) |
| Outcall + proxy | shared backend helper + `proxy/main.py` (`/v1/recap`) |

---

## Decisions
- **D1 — Admin-only, free, draft-only.** No fee, no user surface, **never auto-posts**.
- **D2 — Numbers come from the canister**, not the model — the model phrases, doesn't
  compute. Prevents hallucinated stats in marketing.
- **D3 — Caching optional.** A single "last drafts" cell is enough for the Admin UI; no
  per-recap history needed for MVP.

## Risks / guardrails
- **Hallucinated numbers** = the real risk for *public* marketing. Mitigation: feed
  exact figures; instruct "use only the provided numbers verbatim"; admin reviews before
  posting (human gate).
- **Don't auto-publish.** The whole feature is draft-only by design.
- **Tone/claims:** keep recaps factual (burn totals, winners) — avoid price/return
  claims (same securities caution as elsewhere).

## MemoryIds
**None** required (admin-only, free). Optional single "last recap" heap/`StableCell`
if you want it to survive upgrades (claim from free pool 26–33, 57–59, 73, 76).

## Open questions
- **Q1 — Add a period-delta burn helper?** → yes; exact "this week" beats a guessed
  delta. Small addition.
- **Q2 — Auto-trigger `lottery_win` recap from the draw, or only on demand?** → MVP
  on-demand (admin) + optional `/loop` trigger; never auto-post regardless.
