---
type: idea
title: "Drop Zone — the target-skydive game (arcade game 4)"
description: "PUBG/Warzone-style plane drop to a bullseye: hand-drawn ink 3D, daily same-scenario competition for stakers, ranked distance then time, crashes never rank."
tags: [ideas, drop-zone, arcade]
timestamp: 2026-07-04T00:00:00Z
---

# Drop Zone — the target-skydive game (arcade game 4)

**Status: BUILT, shipped dark behind `arcade_skydive` (enabled on local).**
Dedicated page `#/drop-zone`, nav below Luck-Proof.

## Reference research (owner-requested)

- PUBG: neutral freefall ~126 km/h, full dive ~234 km/h (speed trades away
  steering); canopy ~18–27 km/h; glide covers distance
  ([PUBG parachute system](https://support.pubg.com/hc/en-us/articles/115004171393-Parachute-System),
  [PUBG wiki](https://pubg.wiki.gg/wiki/Parachute)).
- Warzone: point-down for max speed; manual deploy risk/reward — "deploy a
  bit higher than you think"; cut/redeploy tech
  ([Warzone parachute techniques](https://blog.activision.com/call-of-duty/2020-05/Warzone-Parachute-Techniques),
  [land faster guide](https://dotesports.com/call-of-duty/news/how-to-land-faster-in-call-of-duty-warzone)).

## The game

Plane crosses the 2 km map on one of 4 diagonals at 1 000 m / 110 m/s.
**J** jumps (timing = positioning), arrows steer, **SHIFT** dives (92 vs
55 m/s sink, steering authority 10 vs 30 m/s — the PUBG trade), **SPACE**
deploys the canopy (7 m/s sink, 18 m/s glide — pop early to cover distance,
ride late to save time). Deploying under **80 m** = crash (attempt consumed,
never ranks). Graded distance-to-bullseye asc, then jump→touchdown time.

- **Practice**: random target every match, fully client-side.
- **Daily drop**: mirrors Luck-Proof — one attempt/UTC day, stakers-only,
  SAME day-seeded scenario for everyone (target, plane diagonal, scenery all
  derive from the day), board distance→time, crashes trail last.
- Trust: physics is continuous/client-side (not rescorable like Luck-Proof's
  decisions) → bounds-validated completion, Field-Goal parity.

## Look

Black-ink-on-paper anime: hand-rolled 3-D perspective on canvas 2D (painter's
sort), boiling outlines (~5 Hz vertex jitter), hatched roofs/fields, bumpy
ink clouds, radial speed lines in a dive, chase camera that pitches down as
you fall. Minimap (plane arrow / player dot / target ×), altimeter with the
80 m floor tick. Mobile: touch-drag steering + JUMP/DIVE/CHUTE buttons.

## Implementation map

- Backend `src/backend/src/lib.rs` "Drop Zone (arcade game 4)": scenario
  `skydive_scenario(day)` (target in central 60%), endpoints
  start/complete_skydive_daily + board/status queries, MemoryIds 112 (runs) /
  113 (next id) / 114 (daily entries), flag `arcade_skydive`.
- Frontend `src/frontend/src/arcade/DropZone.tsx` (physics + renderer +
  game; pure helpers tested in `test/dropzone.test.ts`), `DropZonePage.tsx`,
  `parachute` icon.
- No winner prize wired (Luck-Proof pays tickets; open question here).
