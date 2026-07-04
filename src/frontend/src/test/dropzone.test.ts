import { describe, it, expect } from 'vitest';
import {
  mulberry, practiceScenario, planePath, buildDecor, stepFall, landingVerdict,
  distanceToTarget, friendlyDropErr,
  MAP_M, PLANE_ALT, FALL_VY, DIVE_VY, CHUTE_VY, SAFE_DEPLOY_ALT,
  type FallState,
} from '../arcade/DropZone';

const freshFall = (): FallState => ({ x: 1000, y: PLANE_ALT, z: 1000, vx: 0, vy: 0, vz: 0, chuteAt: null });

describe('scenario & scenery', () => {
  it('practice targets stay in the central 60% of the map', () => {
    const rand = mulberry(7);
    for (let i = 0; i < 50; i++) {
      const sc = practiceScenario(rand);
      expect(sc.targetX).toBeGreaterThanOrEqual(MAP_M * 0.2);
      expect(sc.targetX).toBeLessThanOrEqual(MAP_M * 0.8);
      expect(sc.targetZ).toBeGreaterThanOrEqual(MAP_M * 0.2);
      expect(sc.targetZ).toBeLessThanOrEqual(MAP_M * 0.8);
      expect(sc.planeDir).toBeGreaterThanOrEqual(0);
      expect(sc.planeDir).toBeLessThanOrEqual(3);
    }
  });

  it('all four plane diagonals cross the full map', () => {
    for (let d = 0; d < 4; d++) {
      const p = planePath(d);
      const end = { x: p.sx + p.hx * MAP_M * Math.SQRT2, z: p.sz + p.hz * MAP_M * Math.SQRT2 };
      // Ends at the opposite corner (within rounding).
      expect(Math.abs(end.x - (MAP_M - p.sx))).toBeLessThan(1);
      expect(Math.abs(end.z - (MAP_M - p.sz))).toBeLessThan(1);
      expect(Math.hypot(p.hx, p.hz)).toBeCloseTo(1, 5);
    }
  });

  it('decor is deterministic per seed and clears the target area', () => {
    const a = buildDecor(42, 1000, 1000);
    const b = buildDecor(42, 1000, 1000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.trees.length).toBe(110);
    expect(a.houses.length).toBe(22);
    expect(a.rocks.length).toBe(30);
    expect(a.clouds.length).toBe(12);
    for (const t of a.trees) expect(Math.hypot(t.x - 1000, t.z - 1000)).toBeGreaterThan(60);
    for (const h of a.houses) expect(Math.hypot(h.x - 1000, h.z - 1000)).toBeGreaterThan(60);
    for (const r of a.rocks) expect(Math.hypot(r.x - 1000, r.z - 1000)).toBeGreaterThan(60);
    expect(JSON.stringify(buildDecor(43, 1000, 1000))).not.toBe(JSON.stringify(a));
  });
});

describe('freefall physics', () => {
  it('neutral fall settles at FALL_VY; a dive falls much faster', () => {
    const s = freshFall();
    for (let i = 0; i < 300; i++) stepFall(s, { ax: 0, az: 0, dive: false }, 1 / 60);
    expect(s.vy).toBeGreaterThan(FALL_VY * 0.95);
    expect(s.vy).toBeLessThan(FALL_VY * 1.05);
    const d = freshFall();
    for (let i = 0; i < 300; i++) stepFall(d, { ax: 0, az: 0, dive: true }, 1 / 60);
    expect(d.vy).toBeGreaterThan(DIVE_VY * 0.95);
    // The dive covered far more altitude in the same time.
    expect(d.y).toBeLessThan(s.y - 100);
  });

  it('the chute arrests the sink and steering caps by regime', () => {
    const s = freshFall();
    s.vy = FALL_VY;
    s.chuteAt = 300;
    for (let i = 0; i < 240; i++) stepFall(s, { ax: 1, az: 0, dive: false }, 1 / 60);
    expect(s.vy).toBeLessThan(CHUTE_VY * 1.1);
    expect(Math.hypot(s.vx, s.vz)).toBeLessThanOrEqual(18.5); // CHUTE_STEER + slack
    const f = freshFall();
    for (let i = 0; i < 240; i++) stepFall(f, { ax: 1, az: 0, dive: true }, 1 / 60);
    // Diving kills steering authority (DIVE_STEER + one-frame overshoot).
    expect(Math.hypot(f.vx, f.vz)).toBeLessThanOrEqual(10.5);
  });

  it('position stays inside the map', () => {
    const s = freshFall();
    s.x = 5; s.z = 5;
    for (let i = 0; i < 600; i++) stepFall(s, { ax: -1, az: -1, dive: false }, 1 / 60);
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.z).toBeGreaterThanOrEqual(0);
  });
});

describe('landing rules', () => {
  it('safe requires a canopy opened at or above the 80 m floor', () => {
    expect(landingVerdict(null)).toBe(false);
    expect(landingVerdict(SAFE_DEPLOY_ALT - 1)).toBe(false);
    expect(landingVerdict(SAFE_DEPLOY_ALT)).toBe(true);
    expect(landingVerdict(500)).toBe(true);
  });

  it('distance is the horizontal error to the target center', () => {
    const sc = { targetX: 1000, targetZ: 1000, planeDir: 0, decorSeed: 1 };
    expect(distanceToTarget(1000, 1000, sc)).toBe(0);
    expect(distanceToTarget(1003, 1004, sc)).toBeCloseTo(5, 5);
  });
});

describe('friendlyDropErr', () => {
  it('maps gate codes to actionable copy', () => {
    expect(friendlyDropErr('NOT_STAKED')).toContain('stake');
    expect(friendlyDropErr('ALREADY_PLAYED_TODAY')).toContain('00:00 UTC');
    expect(friendlyDropErr('OTHER')).toBe('OTHER');
  });
});
