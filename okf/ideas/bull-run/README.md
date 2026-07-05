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

## The game

A lone black bull charges 1.5 km through Spanish streets to the plaza de
toros. Three lanes (←/→), ↑/SPACE jumps barriers and barrel stacks — carts
are too tall, dodge them. Stumbles halve speed (rebuilds at 1.2 m/s²,
max 24 m/s); a 1.2 s post-stumble grace stops chain hits. EXACTLY 120 coins
per course (20 runs of 6; ~40% float in jump arcs). Finish is guaranteed —
ranking prices mistakes: coins desc → time asc.

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
