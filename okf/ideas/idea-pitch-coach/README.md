---
type: idea
title: "Idea Pitch Coach — Gemini feedback before you post to the R&D board"
tags: [ideas, idea-pitch-coach]
timestamp: 2026-06-20T07:42:46-04:00
---

# Idea Pitch Coach — Gemini feedback before you post to the R&D board

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-20.
> Companion features specced same day: [proposal-tldr](../proposal-tldr/README.md),
> [auto-recaps](../auto-recaps/README.md). Builds directly on the live Idea Board
> ($0.05 post) and its quote→deposit→post flow.

A **"Coach my pitch"** action in the Idea Board post composer: before paying the
$0.05 to post, the author gets **Gemini feedback** scoring the pitch against the
board's own rubric — *name where ICP leaves circulation, show the economic loop,
keep it buildable on ICP* (the exact guidance already in `llms-rd-prod.txt`) — plus
a punchier title, suggested categories, and a 0–100 readiness score. Better pitches →
a higher-signal board → more posts convert.

---

## What ships (MVP)

- In the **post composer** (`IdeaBoard.tsx`), a secondary **"Coach my pitch"** button
  beside Post. Runs on the *draft* title/description/detail **before** posting.
- A feedback panel (from a Gemini `response_schema`):
  - **Readiness score** 0–100 + one-line verdict.
  - **Rubric checklist**: ICP-burn mechanism ✓/✗ · economic loop ✓/✗ · buildable-on-ICP
    ✓/✗ · clarity ✓/✗ — each with a one-line "why / how to fix."
  - **Suggested title** (≤80 chars) and **suggested categories** (from the board's tag
    set) the author can one-tap apply.
  - **Rewrite hint**: 1–2 sentences the author can fold into the description.
- The author edits, then posts through the **unchanged** $0.05 flow. The coach is a
  pre-flight helper — it never posts and nothing it returns is stored on-chain.

---

## Money model (the decision that matters)

Two options; **recommend D-A (free, rate-limited)**:

- **D-A — Free, rate-limited (recommended).** The coach is a free perk that improves
  the paid post it precedes. Cap at **N runs/principal/UTC-day** (e.g. 5) via a heap
  cooldown to bound Gemini cost/abuse. Rationale: it lifts board quality and *increases*
  $0.05 conversions; gating it behind another fee adds friction to the funnel.
- **D-B — Paid add-on.** A small fee (e.g. +$0.03 USD) per coaching run, reusing the
  idea-post quote/fee path. Use only if D-A's free calls get abused despite the cap.

Either way the **post fee is untouched** ($0.05 USD, ICP burned / others to treasury).

---

## Proxy endpoint — `POST /v1/pitch` (new route in `proxy/main.py`)

Same app, bearer, keyless Vertex. **No grounding needed** (it judges the author's own
text against a fixed rubric) → cheaper + no injection surface from external URLs.

- **in**: `{"title": str, "description": str, "detail": str}`
- **out 200**:
  ```json
  {
    "score": 0-100,
    "verdict": "<=120 chars",
    "rubric": [{"name":"icp_burn","pass":true,"note":"..."}, ...],
    "suggested_title": "<=80 chars",
    "suggested_categories": ["DeFi","Infra", "..."],
    "rewrite_hint": "1-2 sentences"
  }
  ```
- **errors**: `401` bad bearer · `422` bad input · `502` generation failed (surfaced as
  "Coach unavailable — post anyway"; never blocks posting).

`response_mime_type=application/json` + `response_schema=<Pydantic PitchReview>`.
System prompt carries the board rubric verbatim; **fetched/author text is data, not
instructions**.

---

## Backend flow + shared foundation

```
coach_idea_pitch(title, description, detail) [update] → PitchReview
```
1. `require_authenticated()` + `CallerGuard` + per-caller daily cap (D-A) **or**
   quote/deposit/charge (D-B, reusing `get_idea_post_quote` + `collect_discussion_fee`).
2. **Non-replicated outcall** to `<proxy>/v1/pitch` with the draft text.
3. Return the structured `PitchReview`. **Nothing persisted** (no new stable map under
   D-A; D-B adds only a heap quote).

**Shared foundation:** uses the same backend Gemini-outcall helper introduced by
[proposal-tldr](../proposal-tldr/README.md#backend-flow--net-new-infra) (the live
outcall today lives only in the Farmer wasm). Build that once; this rides it.

---

## Reuse map

| Need | Reuse |
|---|---|
| Rubric text | `src/frontend/public/llms-rd-prod.txt` "What makes a strong pitch" — single source of truth |
| Composer UI | `IdeaBoard.tsx` post modal + token picker |
| Fee path (D-B only) | `get_idea_post_quote` + `collect_discussion_fee` (lib.rs ~5614 / ~5823) |
| Outcall + proxy | shared backend helper + `proxy/main.py` (`/v1/pitch`) |
| Categories | the board's existing category tag set |

---

## Decisions
- **D1 — Pre-post, advisory.** Runs on the draft; never auto-posts, never edits without
  a one-tap apply. Post flow unchanged.
- **D2 — Money: free + rate-limited** (D-A) unless abused → paid add-on (D-B).
- **D3 — No grounding.** Judges author text only → cheaper, no external-URL injection.
- **D4 — Not stored.** No new persistent MemoryId (D-A); heap quote only (D-B).

## Risks / guardrails
- **Lowest-risk of the three** — no external URLs to ground on, no money path under D-A.
- **Abuse/cost:** the per-day cap is the control; add a global daily cap too.
- **Quality drift:** keep the rubric in the system prompt in sync with the public skill
  doc (cite the file, don't fork the wording).
- **Don't gate posting on it** — coach failure must always fall through to "post anyway."

## MemoryIds
**None** under D-A (recommended). D-B adds only a heap quote map (no stable MemoryId).

## Open questions
- **Q1 — Free or paid?** → recommend free + rate-limited (D-A); revisit if abused.
- **Q2 — Auto-apply suggestions or one-tap?** → one-tap apply (author stays in control).
