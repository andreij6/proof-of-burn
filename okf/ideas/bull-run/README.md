---
type: idea
title: "Bull Run — the encierro lane-runner (arcade game 5)"
description: "A black bull charges Spanish streets to the bullring: 3 lanes, jumps, unjumpable carts, exactly 120 coins; daily same-street competition ranked coins then time."
tags: [ideas, bull-run, arcade]
timestamp: 2026-07-04T00:00:00Z
---

# Bull Run — the encierro lane-runner (arcade game 5)

**Status: BUILT, shipped dark behind `arcade_bullrun` (enabled on local).**
Dedicated page `#/bull-run`, nav in Play to Earn (bull icon).

## The game (v2 — ENDLESS, 2026-07-04)

A lone black bull — rendered from BEHIND per the Pamplona press-photo
reference (rump + shoulders + white horns sweeping up) — charges an endless
Spanish street. Three lanes (←/→), ↑/SPACE jumps barriers/barrels; carts
are too tall, dodge. **Ten hits end the run.** Progressive difficulty, all
pure functions of distance: the bull's speed cap climbs 16 → 34 m/s,
obstacle spacing shrinks 26 → 10 m, and the CROWD (runners in white with
red scarves, who bolt for the walls as the bull nears) thickens 14 → 4.5 m
apart — eventually genuinely occluding obstacles behind them (painter-order
occlusion is the difficulty mechanic). Ranked coins desc → time asc; coin
plausibility is rate-capped server-side (≤ 8/s + 20).

The street STREAMS from independent per-subsystem PRNGs (obstacles, coins,
buildings, crowd), so any chunking builds the identical street — the
daily-fairness invariant is unit-tested.

- **Practice**: random street each run, client-side.
- **Daily**: mirrors Luck-Proof/Drop Zone — once per UTC day (local replays
  free), stakers-only, SAME day-seeded street for everyone; completion
  bounds-validated (coins ≤ fixed total, time window). No winner prize wired
  (same open question as Drop Zone).

## Look

The Drop Zone ink language in Spanish-town warmth: whitewash/cream/ochre
walls with terracotta roof strips and punched windows, red-and-yellow
bunting catenaries across the street, cobble arc bands, warm sky + sun, the
bullring growing at the end of the street, gold spinning coins, striped
barriers/barrels/wooden carts, and the bull itself — a black charging mass
with white horns, galloping legs, tail whip, dust puffs, stumble flash.

## Implementation map

- Backend `src/backend/src/lib.rs` "Bull Run (arcade game 5)": BULLRUN_COINS
  = 120 (the validation bound), day seed `bullrun_day_seed`, endpoints
  start/complete_bullrun_daily + board/status, MemoryIds 115/116/117, flag
  `arcade_bullrun`.
- Frontend `src/frontend/src/arcade/BullRun.tsx` (buildCourse/stepBull etc.
  exported + tested in `test/bullrun.test.ts`), `BullRunPage.tsx`, `bull`
  icon in ui.tsx.
