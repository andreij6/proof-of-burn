// ==========================================
// Turbo Rush — pure game logic (no canvas, no React) so the rules engine is
// unit-testable. An original homage to Atari-era pseudo-3D lane racers:
// one 60-second run on a 3-lane highway, full throttle the whole way. Slower
// traffic streams toward you; steer lanes to thread through it. Every car
// you pass scores a point (bucketed into 5 stages of 12 s for the
// leaderboard's per_hole vector); clipping a car spins you out for 1.5 s of
// lost overtaking. Distances are "closure space" feet — the road moves, the
// player doesn't.
// ==========================================

import { OUTFIT_COLORS } from './engine';

// ── Car persona (customizable for $1, stored on-chain) ──
export interface CarLook { body: number; wheels: number; stripe: number }
export const DEFAULT_CAR: CarLook = { body: 0, wheels: 0, stripe: 0 };
// Body + stripe share the outfit palette; wheels get their own finishes.
export const BODY_COLORS = OUTFIT_COLORS;
export const STRIPE_COLORS = OUTFIT_COLORS;
export const WHEEL_COLORS = ['#26211c', '#5a5a5a', '#9a9a9a', '#d8d8d8', '#caa84a', '#b04a3a'];
export const WHEEL_NAMES = ['Coal', 'Slate', 'Steel', 'Chrome', 'Gold', 'Rust'];

// ── Run shape (mirrors the backend contract) ──
export const RUN_MS = 60_000;
export const STAGES = 5;
export const STAGE_MS = RUN_MS / STAGES;          // 12 s per stage
export const MAX_PASSES_PER_STAGE = 60;           // TURBORUSH_MAX_POINTS_PER_STAGE

// ── Road model (feet) ──
export const LANES = 3;
export const LANE_WIDTH_FT = 12;
export const CAR_LEN_FT = 14;
/** How fast you reel traffic in (your speed minus theirs). */
export const CLOSURE_FTS = 75;
/** Traffic appears this far ahead. */
export const SPAWN_Z_FT = 520;
/** Average closure-space distance between traffic waves. */
export const SPAWN_GAP_FT = 120;
/** Spin-out after a collision: no overtaking while stunned. */
export const STUN_MS = 1_500;
/** Lane-change slide rate, lanes per second (render smoothing + collision). */
export const LANE_SLIDE_PER_S = 6;

export interface TrafficCar {
  lane: number;       // 0 left, 1 middle, 2 right
  z: number;          // ft ahead of the player (negative = behind)
  passed: boolean;
  palette: number;    // traffic paint job index (render-only)
}

export interface RaceState {
  tMs: number;
  finished: boolean;
  lane: number;       // player's target lane
  laneX: number;      // smooth lane position (lane units, render + collision)
  traffic: TrafficCar[];
  passed: number;
  perStage: number[]; // length STAGES — the submit payload
  crashes: number;
  stunUntilMs: number;
  odoFt: number;      // closure-space odometer
  nextSpawnAtFt: number;
}

export function initRace(): RaceState {
  return {
    tMs: 0,
    finished: false,
    lane: 1,
    laneX: 1,
    traffic: [],
    passed: 0,
    perStage: Array.from({ length: STAGES }, () => 0),
    crashes: 0,
    stunUntilMs: 0,
    odoFt: 0,
    nextSpawnAtFt: 150, // first wave shortly after the green light
  };
}

export function stageIndex(tMs: number): number {
  return Math.min(STAGES - 1, Math.floor(tMs / STAGE_MS));
}

/** Steer one lane left (-1) or right (+1); clamped to the road. */
export function steer(state: RaceState, dir: -1 | 1): void {
  state.lane = Math.max(0, Math.min(LANES - 1, state.lane + dir));
}

export interface StepEvents {
  passedNow: number;
  crashed: boolean;
}

/**
 * Advance the race by dtMs. `rng` drives traffic spawns (injectable for
 * tests). Spawning never blocks all three lanes at once — there is always
 * a gap to thread.
 */
export function stepRace(state: RaceState, dtMs: number, rng: () => number = Math.random): StepEvents {
  const ev: StepEvents = { passedNow: 0, crashed: false };
  if (state.finished) return ev;

  const dt = dtMs / 1000;
  state.tMs += dtMs;
  if (state.tMs >= RUN_MS) {
    state.tMs = RUN_MS;
    state.finished = true;
  }

  // Slide the rendered lane position toward the target lane.
  const dx = state.lane - state.laneX;
  const maxSlide = LANE_SLIDE_PER_S * dt;
  state.laneX += Math.abs(dx) <= maxSlide ? dx : Math.sign(dx) * maxSlide;

  // Spun out? You match traffic speed — nothing closes, nothing passes.
  const stunned = state.tMs < state.stunUntilMs;
  const closure = stunned ? 0 : CLOSURE_FTS;
  state.odoFt += closure * dt;

  // Traffic waves: 1–2 cars in distinct lanes, never all three.
  while (state.odoFt >= state.nextSpawnAtFt) {
    const two = rng() < 0.45;
    const first = Math.floor(rng() * LANES) % LANES;
    state.traffic.push({ lane: first, z: SPAWN_Z_FT, passed: false, palette: Math.floor(rng() * 4) });
    if (two) {
      const offset = 1 + Math.floor(rng() * (LANES - 1)); // 1 or 2 → distinct
      const second = (first + offset) % LANES;
      state.traffic.push({ lane: second, z: SPAWN_Z_FT, passed: false, palette: Math.floor(rng() * 4) });
    }
    state.nextSpawnAtFt += SPAWN_GAP_FT * (0.8 + rng() * 0.6);
  }

  const stage = stageIndex(Math.min(state.tMs, RUN_MS - 1));
  for (const car of state.traffic) {
    car.z -= closure * dt;

    // Collision: same lane (within half a lane of the slide) and overlapping.
    if (!car.passed && Math.abs(car.lane - state.laneX) < 0.5 && Math.abs(car.z) < CAR_LEN_FT) {
      car.passed = true; // consumed by the crash — it never scores
      car.z = -1_000;    // clear it off the road
      state.crashes += 1;
      state.stunUntilMs = state.tMs + STUN_MS;
      ev.crashed = true;
      continue;
    }

    // Clean pass: the car has fully dropped behind.
    if (!car.passed && car.z < -CAR_LEN_FT) {
      car.passed = true;
      if (state.perStage[stage] < MAX_PASSES_PER_STAGE) {
        state.perStage[stage] += 1;
        state.passed += 1;
        ev.passedNow += 1;
      }
    }
  }

  // Cull what's far behind.
  state.traffic = state.traffic.filter(c => c.z > -200);

  return ev;
}
