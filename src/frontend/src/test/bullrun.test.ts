import { describe, it, expect } from 'vitest';
import {
  makeStreet, ensureStreet, pruneStreet, stepCrowd, freshBull, stepBull,
  obstacleClearY, difficultyAt, friendlyBullErr,
  MAX_HITS, LANE_X, BASE_SPEED, BARRIER_CLEAR, JUMP_VY, GRAVITY, STREET_HALF_W,
} from '../arcade/BullRun';

describe('endless street generation', () => {
  it('is deterministic regardless of chunk sizes (the daily-fairness invariant)', () => {
    const a = makeStreet(42);
    ensureStreet(a, 3_000);
    const b = makeStreet(42);
    for (let z = 400; z <= 3_000; z += 137) ensureStreet(b, z);
    ensureStreet(b, 3_000);
    expect(JSON.stringify(a.obstacles)).toBe(JSON.stringify(b.obstacles));
    expect(JSON.stringify(a.coins)).toBe(JSON.stringify(b.coins));
    expect(JSON.stringify(a.crowd)).toBe(JSON.stringify(b.crowd));
    expect(JSON.stringify(makeStreet(43).obstacles)).not.toBe(JSON.stringify(makeStreet(42).obstacles));
  });

  it('never blocks all three lanes at one z-slot', () => {
    for (const seed of [1, 7, 42]) {
      const st = makeStreet(seed);
      ensureStreet(st, 5_000);
      const byZ = new Map<number, Set<number>>();
      for (const o of st.obstacles) {
        if (!byZ.has(o.z)) byZ.set(o.z, new Set());
        byZ.get(o.z)!.add(o.lane);
      }
      for (const lanes of byZ.values()) expect(lanes.size).toBeLessThanOrEqual(2);
    }
  });

  it('gets progressively harder: denser obstacles, thicker crowd, faster bull', () => {
    const st = makeStreet(7);
    ensureStreet(st, 5_000);
    const count = (arr: { z: number }[], lo: number, hi: number) => arr.filter((e) => e.z >= lo && e.z < hi).length;
    expect(count(st.obstacles, 4_000, 5_000)).toBeGreaterThan(count(st.obstacles, 0, 1_000));
    expect(count(st.crowd, 4_000, 5_000)).toBeGreaterThan(count(st.crowd, 0, 1_000) * 1.5);
    expect(difficultyAt(4_000).maxSpeed).toBeGreaterThan(difficultyAt(0).maxSpeed);
    expect(difficultyAt(4_000).spacing).toBeLessThan(difficultyAt(0).spacing);
  });

  it('prunes passed geometry without touching what is ahead', () => {
    const st = makeStreet(3);
    ensureStreet(st, 2_000);
    const ahead = st.obstacles.filter((o) => o.z > 500).length;
    pruneStreet(st, 500);
    expect(st.obstacles.length).toBe(ahead);
    expect(st.obstacles.every((o) => o.z > 500)).toBe(true);
  });
});

describe('the crowd', () => {
  it('runners in the bull\'s path bolt for the nearest wall', () => {
    const st = makeStreet(1);
    st.crowd = [{ z: 110, x: 0.4, wallX: STREET_HALF_W - 0.35, dodge: false, phase: 0 }];
    // Bull far away: nobody moves.
    stepCrowd(st, 0, 20, 1 / 60);
    expect(st.crowd[0].dodge).toBe(false);
    // Bull bearing down in their lane: they dodge toward the wall.
    stepCrowd(st, 0.2, 100, 1 / 60);
    expect(st.crowd[0].dodge).toBe(true);
    const x0 = st.crowd[0].x;
    for (let i = 0; i < 120; i++) stepCrowd(st, 0.2, 100, 1 / 60);
    expect(st.crowd[0].x).toBeGreaterThan(x0);
    expect(st.crowd[0].x).toBeLessThanOrEqual(STREET_HALF_W);
  });
});

describe('bull physics (endless)', () => {
  it('the run ends at MAX_HITS = 10 (backend hits_limit twin)', () => {
    expect(MAX_HITS).toBe(10);
  });

  it('speed climbs toward the distance-scaled cap', () => {
    const st = makeStreet(1);
    st.obstacles = []; st.coins = [];
    const b = freshBull();
    for (let i = 0; i < 60 * 60; i++) {
      ensureStreet(st, b.z + 100);
      st.obstacles = []; // keep the track clean as it streams
      stepBull(b, st, 1 / 60);
    }
    expect(b.speed).toBeGreaterThan(BASE_SPEED + 3);
    expect(b.speed).toBeLessThanOrEqual(difficultyAt(b.z).maxSpeed + 0.01);
  });

  it('a jump clears a barrier; grounded contact stumbles and halves speed', () => {
    const st = makeStreet(1);
    st.coins = [];
    st.obstacles = [{ z: 20, lane: 1, kind: 'barrier' }];
    const b = freshBull();
    for (let i = 0; i < 60 * 4; i++) stepBull(b, st, 1 / 60);
    expect(b.stumbles).toBe(1);
    const st2 = makeStreet(1);
    st2.coins = [];
    st2.obstacles = [{ z: 20, lane: 1, kind: 'barrier' }];
    const b2 = freshBull();
    for (let i = 0; i < 60 * 4; i++) {
      if (b2.y === 0 && b2.z > 20 - b2.speed * 0.45 && b2.z < 20) { b2.vy = JUMP_VY; b2.y = 0.01; }
      stepBull(b2, st2, 1 / 60);
    }
    expect(b2.stumbles).toBe(0);
  });

  it('carts cannot be cleared by jumping', () => {
    expect(obstacleClearY('barrier')).toBe(BARRIER_CLEAR);
    expect(obstacleClearY('barrels')).toBe(BARRIER_CLEAR);
    const apex = (JUMP_VY * JUMP_VY) / (2 * GRAVITY);
    expect(apex).toBeLessThan(obstacleClearY('cart'));
  });

  it('collects a ground coin in-lane only', () => {
    const st = makeStreet(1);
    st.obstacles = [];
    st.coins = [
      { z: 15, lane: 1, y: 0.55 },
      { z: 15, lane: 0, y: 0.55 },
    ];
    const b = freshBull();
    for (let i = 0; i < 60 * 3; i++) stepBull(b, st, 1 / 60);
    expect(b.coins).toBe(1);
    expect(st.coins[0].taken).toBe(true);
    expect(st.coins[1].taken).toBeUndefined();
  });

  it('lane changes lerp x toward the lane positions', () => {
    const st = makeStreet(1);
    st.obstacles = []; st.coins = [];
    const b = freshBull();
    b.lane = 2;
    for (let i = 0; i < 120; i++) stepBull(b, st, 1 / 60);
    expect(Math.abs(b.x - LANE_X[2])).toBeLessThan(0.05);
  });
});

describe('friendlyBullErr', () => {
  it('maps gate codes to actionable copy', () => {
    expect(friendlyBullErr('NOT_STAKED')).toContain('stake');
    expect(friendlyBullErr('ALREADY_PLAYED_TODAY')).toContain('00:00 UTC');
    expect(friendlyBullErr('OTHER')).toBe('OTHER');
  });
});
