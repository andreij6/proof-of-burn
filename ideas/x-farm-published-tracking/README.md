# X-Farm — Published-tweet tracking + amplification leaderboard

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-20.
> **Parent feature:** [X-Farm](../../src/frontend/src/XFarm.tsx) — **BUILT & deployed
> to Cloud Run proxy; backend + farmer wasm built; dark behind `x_farm` flag** (not
> on mainnet). This is an additive enhancement — no change to the burn model.

## The gap

X-Farm's "Share on X" button fires a `twitter.com/intent/tweet` and the system
learns **nothing** about whether the draft was actually posted, or whether the burn
produced any reach. There is no closed loop:

```
burn ICP → cycles → drafts → [user posts on X] → ??? (signal lost)
```

The whole pitch is *"grow the ICP voice"* — but today we can't show a single number
that proves a farm amplified anything. Owners get no feedback, the community sees no
social proof, and the treasury has no measurable return signal for the 90% burn leg.

## What this adds (the closed loop)

1. **Optional "I posted it" log.** After sharing a draft on X, the owner can paste
   the tweet URL back; the backend records it against that draft + farm.
2. **Per-farm amplification stats.** Each `FarmerCard` shows
   `published / drafted` for the last 30 days — a real "did this farm produce
   content people actually shipped" number.
3. **A public amplification leaderboard.** `get_xfarm_leaderboard(limit)` ranks
   farms/owners by published-tweet count (last 30 days) — visible social proof that
   the burns are turning into reach, and a soft competitive nudge to post more.

**Non-financial by design.** Publishing earns **no ICP, no tickets, no payout** —
only a place on a leaderboard. This is deliberate: any reward re-opens the sybil /
astroturf / securities questions X-Farm already worked through. The leaderboard is
"for fun + signal," never a yield.

## Why this is mostly reuse

- **Share-on-X flow** already exists (`shareDraftOnX` in `XFarm.tsx`) — we just add
  a "posted? log it" affordance after the intent opens.
- **Owner-scoped endpoint + escrow-free write** mirrors `list_my_farmers` /
  `post_idea`-style authenticated writes (no money path here).
- **Feature flag + dark launch** is the standard `FLAG_XFARM` + `feature_visible`
  pattern; this rides the same flag.
- **Audit logging** (`audit(event_type, …)`) for the self-attested log.
- **Frontend primitives** (`Btn`, `Chip`, `Eyebrow`, `Skeleton`) + page anatomy
  from the frontend-dev skill — the leaderboard is a card grid like the persona
  gallery already on the page.

**Net-new:** (1) one backend stable map for the published log (MemoryId **57** —
free, see `03-risks-gates.md`); (2) 3 endpoints (`log_published`,
`get_my_published`, `get_xfarm_leaderboard`); (3) leaderboard UI + "log posted"
inline UI on each `DraftRow`. **No new canister, no proxy change, no money-path
change, no change to the burn timer.**

## Docs

- [01-design-and-ux.md](01-design-and-ux.md) — the loop, data model, leaderboard
  ranking, UX flow.
- [02-impl.md](02-impl.md) — backend structs/endpoints, frontend touches, reuse
  map, MemoryId, candid sync.
- [03-risks-gates.md](03-risks-gates.md) — sybil/astroturf, trustlessness limits,
  content-permanence, build gates, open questions.

## Sizing

Low–medium. Backend is one stable map + 3 endpoints (no money path, no timers);
frontend is an inline "log posted" control + a leaderboard section. The hard part
is the **policy** (what counts, how to cap gaming), not the code — see
`03-risks-gates.md`.