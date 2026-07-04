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

## The game

A run is 10 server-generated gambles ("risk `cost` chips for a `p` chance at
`payout`") under an 8-second shot clock, presented in three framings the
player must convert in their head: **percent**, **bookmaker odds against**,
and **outs of unseen cards**. Take or pass.

- **Ranked metric: EV leaked** vs perfect play (chip-basis-points; 0 =
  perfect, LOWER ranks higher — golf-style ordering on the shared arcade
  leaderboard, game key `luckproof`). Close calls cost almost nothing by
  construction; blunders cost their full edge.
- **The luck track**: chip outcomes resolve from rolls pre-committed at run
  issue, revealed only at completion — and deliberately never ranked. The end
  screen contrasts the two ("you lost chips playing perfectly — that's
  variance, not error").
- Instant decision feedback during play (the client can compute the edge);
  outcomes stay hidden so the lesson lands at the end.

## Trust model

`start_luckproof_run` generates and stores the gambles + rolls server-side;
`complete_luckproof_run` rescoring is fully server-side — the only client
input is the decision vector, so scores can't be forged. A script computing
`p·payout > cost` plays perfectly; that's accepted parity with Field Goal's
bot exposure (the board is bragging rights; tickets are stakers-only and this
game grants none).

## Implementation map

- Backend: `src/backend/src/lib.rs` "Luck-Proof (arcade game 3)" section —
  generation (`luckproof_generate`, seed = hash(time‖caller‖id)), scoring
  (`luckproof_edge_bp` / `luckproof_ev_leaked_bp`), endpoints, MemoryIds
  105 (runs) + 106 (next id), flag `arcade_luckproof`.
- Frontend: `src/frontend/src/arcade/LuckProof.tsx` (pure helpers exported +
  tested in `test/luckproof.test.ts`); Arcade hub tab "Luck-Proof".

## Siblings from the same ideation (not built)

Interval Duel (range reading with numbers), Tell (opponent-modeling vs
AI personalities — could ride the course-NFT mint machinery as "villain
packs"), Colonel Blotto (mixed strategies PvP), Market Maker (odds pricing on
the crash strategy marketplace), Calibration Sniper (Brier-scored probability
estimates), Survival Stakes (Kelly sizing).
