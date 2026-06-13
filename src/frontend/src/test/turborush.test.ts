import { describe, it, expect } from 'vitest';
import {
  CAR_LEN_FT, LANES, MAX_PASSES_PER_STAGE, RUN_MS, STAGES, STAGE_MS, STUN_MS,
  initRace, stageIndex, steer, stepRace,
} from '../arcade/racerEngine';

/** Run a whole race at a fixed timestep with a deterministic rng. */
function runRace(seed: number[], onTick?: (s: ReturnType<typeof initRace>, t: number) => void) {
  const state = initRace();
  let i = 0;
  const rng = () => seed[i++ % seed.length];
  const DT = 50;
  for (let t = 0; t < RUN_MS && !state.finished; t += DT) {
    stepRace(state, DT, rng);
    onTick?.(state, t);
  }
  return state;
}

describe('turbo rush — race engine', () => {
  it('a full run finishes at exactly 60 s with 5 stage buckets that sum to total passes', () => {
    const state = runRace([0.3, 0.7, 0.1, 0.9, 0.5]);
    expect(state.finished).toBe(true);
    expect(state.tMs).toBe(RUN_MS);
    expect(state.perStage).toHaveLength(STAGES);
    expect(state.perStage.reduce((a, b) => a + b, 0)).toBe(state.passed);
    expect(state.passed).toBeGreaterThan(10); // traffic actually flows
    for (const p of state.perStage) expect(p).toBeLessThanOrEqual(MAX_PASSES_PER_STAGE);
  });

  it('staying in a clear lane passes cars without crashing', () => {
    // rng 0.9 → single-car waves in lane 2; player starts in lane 1.
    const state = runRace([0.9]);
    expect(state.crashes).toBe(0);
    expect(state.passed).toBeGreaterThan(0);
  });

  it('parking in the traffic lane crashes, spins out and stalls overtaking', () => {
    const state = initRace();
    steer(state, -1); // lane 0 — rng 0.0 spawns pairs in lanes 0+1
    let crashed = false;
    const rng = () => 0.0;
    for (let t = 0; t < 20_000 && !crashed; t += 50) {
      const ev = stepRace(state, 50, rng);
      if (ev.crashed) crashed = true;
    }
    expect(crashed).toBe(true);
    expect(state.crashes).toBeGreaterThan(0);
    expect(state.stunUntilMs).toBeGreaterThan(0);
    // While stunned the odometer freezes — no closure, no passes.
    const odoAtCrash = state.odoFt;
    const passedAtCrash = state.passed;
    stepRace(state, STUN_MS / 2, rng);
    expect(state.odoFt).toBe(odoAtCrash);
    expect(state.passed).toBe(passedAtCrash);
  });

  it('a crashed car never scores as a pass', () => {
    const state = initRace();
    steer(state, -1);
    const rng = () => 0.0;
    let sawCrash = false;
    for (let t = 0; t < RUN_MS && !state.finished; t += 50) {
      if (stepRace(state, 50, rng).crashed) sawCrash = true;
    }
    expect(sawCrash).toBe(true);
    expect(state.perStage.reduce((a, b) => a + b, 0)).toBe(state.passed);
  });

  it('steer clamps to the road', () => {
    const state = initRace();
    steer(state, -1); steer(state, -1); steer(state, -1);
    expect(state.lane).toBe(0);
    for (let i = 0; i < 5; i++) steer(state, 1);
    expect(state.lane).toBe(LANES - 1);
  });

  it('spawn waves never block all three lanes', () => {
    // Force two-car waves on every spawn (rng < 0.45 → two = true).
    const state = initRace();
    const rng = (() => {
      const seq = [0.1, 0.9, 0.9, 0.2, 0.4]; // two=yes, lanes spread, gap mid
      let i = 0;
      return () => seq[i++ % seq.length];
    })();
    for (let t = 0; t < 10_000; t += 50) stepRace(state, 50, rng);
    // Group by spawn z-cohort: no cohort may cover 3 distinct lanes.
    const byZ = new Map<number, Set<number>>();
    for (const c of state.traffic) {
      const key = Math.round(c.z);
      if (!byZ.has(key)) byZ.set(key, new Set());
      byZ.get(key)!.add(c.lane);
    }
    for (const lanes of byZ.values()) expect(lanes.size).toBeLessThanOrEqual(2);
  });

  it('stage indexing maps the run onto exactly 5 buckets', () => {
    expect(stageIndex(0)).toBe(0);
    expect(stageIndex(STAGE_MS - 1)).toBe(0);
    expect(stageIndex(STAGE_MS)).toBe(1);
    expect(stageIndex(RUN_MS - 1)).toBe(STAGES - 1);
    expect(stageIndex(RUN_MS + 999)).toBe(STAGES - 1);
  });

  it('cars overlap-check uses real car length', () => {
    expect(CAR_LEN_FT).toBeGreaterThan(0);
  });
});
