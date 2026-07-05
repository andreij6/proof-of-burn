import { describe, it, expect } from 'vitest';
import {
  buildCourse, freshBull, stepBull, obstacleClearY, friendlyBullErr,
  COURSE_M, COINS_TOTAL, LANE_X, BASE_SPEED, MAX_SPEED, BARRIER_CLEAR, JUMP_VY, GRAVITY,
} from '../arcade/BullRun';

describe('course generation', () => {
  it('is deterministic per seed with EXACTLY the backend coin bound', () => {
    const a = buildCourse(42);
    const b = buildCourse(42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.coins.length).toBe(COINS_TOTAL);
    expect(JSON.stringify(buildCourse(43))).not.toBe(JSON.stringify(a));
  });

  it('never blocks all three lanes at one z-slot', () => {
    for (const seed of [1, 7, 42, 999]) {
      const c = buildCourse(seed);
      const byZ = new Map<number, Set<number>>();
      for (const o of c.obstacles) {
        if (!byZ.has(o.z)) byZ.set(o.z, new Set());
        byZ.get(o.z)!.add(o.lane);
      }
      for (const lanes of byZ.values()) expect(lanes.size).toBeLessThanOrEqual(2);
    }
  });

  it('keeps everything inside the course and the lanes', () => {
    const c = buildCourse(7);
    for (const o of c.obstacles) {
      expect(o.z).toBeGreaterThan(0);
      expect(o.z).toBeLessThan(COURSE_M);
      expect(o.lane).toBeGreaterThanOrEqual(0);
      expect(o.lane).toBeLessThanOrEqual(2);
    }
    for (const coin of c.coins) {
      expect(coin.lane).toBeGreaterThanOrEqual(0);
      expect(coin.lane).toBeLessThanOrEqual(2);
      expect(coin.y).toBeGreaterThan(0);
    }
    expect(c.buildings.some((bd) => bd.side === -1)).toBe(true);
    expect(c.buildings.some((bd) => bd.side === 1)).toBe(true);
  });
});

describe('bull physics', () => {
  it('accelerates toward MAX_SPEED and advances down the street', () => {
    const c = buildCourse(1);
    c.obstacles = []; // clean track
    const b = freshBull();
    for (let i = 0; i < 60 * 30; i++) stepBull(b, c, 1 / 60);
    expect(b.speed).toBeGreaterThan(BASE_SPEED);
    expect(b.speed).toBeLessThanOrEqual(MAX_SPEED);
    expect(b.z).toBeGreaterThan(BASE_SPEED * 30 * 0.9);
  });

  it('a jump clears a barrier; staying grounded stumbles and halves speed', () => {
    const c = buildCourse(1);
    c.coins = [];
    c.obstacles = [{ z: 20, lane: 1, kind: 'barrier' }];
    // Grounded → stumble.
    const b = freshBull();
    const v0 = b.speed;
    for (let i = 0; i < 60 * 4; i++) stepBull(b, c, 1 / 60);
    expect(b.stumbles).toBe(1);
    expect(b.speed).toBeLessThan(v0 + 1); // knocked back, still recovering
    // Airborne over it → clean.
    const c2 = buildCourse(1);
    c2.coins = [];
    c2.obstacles = [{ z: 20, lane: 1, kind: 'barrier' }];
    const b2 = freshBull();
    for (let i = 0; i < 60 * 4; i++) {
      // Jump just before the barrier.
      if (b2.y === 0 && b2.z > 20 - b2.speed * 0.45 && b2.z < 20) { b2.vy = JUMP_VY; b2.y = 0.01; }
      stepBull(b2, c2, 1 / 60);
    }
    expect(b2.stumbles).toBe(0);
  });

  it('carts cannot be cleared by jumping', () => {
    expect(obstacleClearY('barrier')).toBe(BARRIER_CLEAR);
    expect(obstacleClearY('barrels')).toBe(BARRIER_CLEAR);
    // Max jump height = v²/2g — far under a cart's clearance.
    const apex = (JUMP_VY * JUMP_VY) / (2 * GRAVITY);
    expect(apex).toBeLessThan(obstacleClearY('cart'));
  });

  it('collects a ground coin in-lane and leaves other lanes alone', () => {
    const c = buildCourse(1);
    c.obstacles = [];
    c.coins = [
      { z: 15, lane: 1, y: 0.55 },
      { z: 15, lane: 0, y: 0.55 },
    ];
    const b = freshBull(); // lane 1
    for (let i = 0; i < 60 * 3; i++) stepBull(b, c, 1 / 60);
    expect(b.coins).toBe(1);
    expect(c.coins[0].taken).toBe(true);
    expect(c.coins[1].taken).toBeUndefined();
  });

  it('lane changes lerp x toward the lane positions', () => {
    const c = buildCourse(1);
    c.obstacles = []; c.coins = [];
    const b = freshBull();
    b.lane = 2;
    for (let i = 0; i < 120; i++) stepBull(b, c, 1 / 60);
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
