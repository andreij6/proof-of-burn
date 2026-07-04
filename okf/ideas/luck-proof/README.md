---
type: idea
title: "Luck-Proof — the EV-decision trainer (arcade game 3)"
description: "Train hold'em decision math without a poker game: ranked on EV leaked vs perfect play, never on results."
tags: [ideas, luck-proof, arcade]
timestamp: 2026-07-04T00:00:00Z
---

# Luck-Proof — the EV-decision trainer (arcade game 3)

**Status: BUILT, shipped dark behind `arcade_luckproof` (enabled on local).**

Born from a hold'em ideation session: poker is decision math under
uncertainty plus psychology. Luck-Proof isolates the deepest lesson —
*outcome-vs-decision separation* (Sklansky bucks) — as an arcade game with no
cards and no wagers.

## The game (v2 — Sklansky Trainer, 2026-07-04)

Rebuilt same-day on the Gemini reference demo the owner preferred: a LIVE
dual-track scoreboard (SKILL = Sklansky dollars, EV credited the instant a
decision is made; LUCK = actual cash), an arena showing Odds/Risk/Reward
(reward = profit; declining = exactly $0 EV), and a flowing hand log.

- **Practice mode**: endless, client-side, instant outcomes, unranked — any
  signed-in user.
- **Daily competition**: ONE attempt per UTC day, 250 decisions,
  no-loss-lottery STAKERS only. Every player faces the SAME daily deal
  (gambles derive from the day, not the player), so total EV earned ranks
  fairly: EV desc → accuracy → time. Outcomes (per-player rolls) hide until
  the end — the reveal is the lesson. Starting consumes the attempt; 1h TTL.
- Generator note: the reference demo's multiplier made ~99% of hands +EV
  (mash-TAKE wins); ours keeps its presentation but balances the mix
  (⅓ clear-take / ⅓ clear-fold / ⅓ close call) so folding discipline counts.
- Keyboard: T/→ take, D/← decline. Mobile-first fluid layout.

## Trust model

`start_luckproof_run` generates and stores the gambles + rolls server-side;
`complete_luckproof_run` rescoring is fully server-side — the only client
input is the decision vector, so scores can't be forged. A script computing
`p·payout > cost` plays perfectly; that's accepted parity with Field Goal's
bot exposure (the board is bragging rights; tickets are stakers-only and this
game grants none).

## Implementation map

- Backend: `src/backend/src/lib.rs` "Sklansky Trainer / Luck-Proof" section —
  daily deal `luckproof_generate(luckproof_day_seed(day))`, Sklansky edge
  `luckproof_edge_bp`, endpoints start/complete_luckproof_daily + board/status
  queries, MemoryIds 108 (runs) + 109 (next id) + 107 (daily board); 105/106
  abandoned (held the v1 10-round format on local nets only). Flag
  `arcade_luckproof`.
- Frontend: `src/frontend/src/arcade/LuckProof.tsx` (pure helpers exported +
  tested in `test/luckproof.test.ts`); Arcade hub tab "Luck-Proof".

## Siblings from the same ideation (not built)

Interval Duel (range reading with numbers), Tell (opponent-modeling vs
AI personalities — could ride the course-NFT mint machinery as "villain
packs"), Colonel Blotto (mixed strategies PvP), Market Maker (odds pricing on
the crash strategy marketplace), Calibration Sniper (Brier-scored probability
estimates), Survival Stakes (Kelly sizing).
