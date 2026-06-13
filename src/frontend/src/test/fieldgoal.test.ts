import { describe, it, expect } from 'vitest';
import {
  AIM_WINDOW_MS, CROSSBAR_FT, HASH_OFFSET_FT, MAX_KICK_SPEED_FTS, MAX_AZIMUTH_RAD,
  MIN_DISTANCE_YDS, MAX_DISTANCE_YDS, POST_HALF_GAP_FT, ROUNDS_PER_GAME,
  ballAt, botchedKick, dragToKick, flightTime, randomKickSpec, simulateKick, timeToPlane,
  type KickSpec,
} from '../arcade/fieldgoalEngine';

const center = (yds: number): KickSpec => ({ distanceYds: yds, hashOffsetFt: 0 });

describe('field goal — kick physics & rules', () => {
  it('a clean full-power kick from 30 down the middle is GOOD for 30 points', () => {
    const res = simulateKick(center(30), { speed: MAX_KICK_SPEED_FTS, azimuth: 0 });
    expect(res.outcome).toBe('good');
    expect(res.points).toBe(30);
    expect(res.crossYFt).toBeGreaterThan(CROSSBAR_FT);
    expect(Math.abs(res.crossXFt)).toBeLessThan(0.001);
  });

  it('every distance in the round range is makeable at full power, straight on', () => {
    for (let yds = MIN_DISTANCE_YDS; yds <= MAX_DISTANCE_YDS; yds++) {
      const res = simulateKick(center(yds), { speed: MAX_KICK_SPEED_FTS, azimuth: 0 });
      expect(res.outcome, `${yds} yds`).toBe('good');
    }
  });

  it('a weak kick comes up short', () => {
    const res = simulateKick(center(45), { speed: 0.5 * MAX_KICK_SPEED_FTS, azimuth: 0 });
    expect(res.outcome).toBe('short');
    expect(res.points).toBe(0);
  });

  it('a hard hook misses wide left; a push misses wide right', () => {
    const left = simulateKick(center(25), { speed: MAX_KICK_SPEED_FTS, azimuth: -MAX_AZIMUTH_RAD });
    expect(left.outcome).toBe('wide_left');
    const right = simulateKick(center(25), { speed: MAX_KICK_SPEED_FTS, azimuth: MAX_AZIMUTH_RAD });
    expect(right.outcome).toBe('wide_right');
  });

  it('the hash matters: a straight kick from the left hash still threads the posts', () => {
    // ±9.25 ft hash offset is inside the ±9.25 ft post gap — exactly at the
    // edge, so a dead-straight kick from the hash clips inside the upright.
    const res = simulateKick(
      { distanceYds: 35, hashOffsetFt: -HASH_OFFSET_FT },
      { speed: MAX_KICK_SPEED_FTS, azimuth: 0 },
    );
    expect(res.outcome).toBe('good');
    expect(res.crossXFt).toBeCloseTo(-POST_HALF_GAP_FT, 5);
  });

  it('a botched (clock-expired) kick NEVER scores, from any spot', () => {
    // Cycle deterministic "randomness" through all three miss modes across
    // the whole distance/hash space.
    for (let yds = MIN_DISTANCE_YDS; yds <= MAX_DISTANCE_YDS; yds += 3) {
      for (const hash of [-HASH_OFFSET_FT, 0, HASH_OFFSET_FT]) {
        for (const r of [0.0, 0.4, 0.8]) {
          const spec = { distanceYds: yds, hashOffsetFt: hash };
          const kick = botchedKick(spec, () => r);
          expect(simulateKick(spec, kick).outcome, `${yds}yds hash ${hash} r=${r}`).not.toBe('good');
        }
      }
    }
  });

  it('dragToKick: dead zone yields null; full drag yields max power; direction inverts', () => {
    expect(dragToKick({ x: 2, y: 3 })).toBeNull();
    const full = dragToKick({ x: 0, y: 400 })!; // dragged straight DOWN…
    expect(full.speed).toBeCloseTo(MAX_KICK_SPEED_FTS, 5);
    expect(full.azimuth).toBeCloseTo(0, 5);     // …kicks straight downfield
    const pulledRight = dragToKick({ x: 100, y: 100 })!;
    expect(pulledRight.azimuth).toBeLessThan(0); // pull right → ball goes left
    // Azimuth is clamped to the playable cone.
    const extreme = dragToKick({ x: 300, y: 10 })!;
    expect(Math.abs(extreme.azimuth)).toBeLessThanOrEqual(MAX_AZIMUTH_RAD + 1e-9);
  });

  it('randomKickSpec stays inside the advertised range on all rng extremes', () => {
    for (const r of [0, 0.4999, 0.9999]) {
      const spec = randomKickSpec(() => r);
      expect(spec.distanceYds).toBeGreaterThanOrEqual(MIN_DISTANCE_YDS);
      expect(spec.distanceYds).toBeLessThanOrEqual(MAX_DISTANCE_YDS);
      expect([-HASH_OFFSET_FT, 0, HASH_OFFSET_FT]).toContain(spec.hashOffsetFt);
    }
  });

  it('trajectory bookkeeping is consistent: the ball is at the plane at timeToPlane', () => {
    const spec = center(40);
    const kick = { speed: MAX_KICK_SPEED_FTS, azimuth: 0.1 };
    const t = timeToPlane(spec, kick);
    expect(t).toBeLessThan(flightTime(kick));
    const at = ballAt(spec, kick, t);
    expect(at.z).toBeCloseTo(40 * 3, 6);
  });

  it('game constants match the backend contract', () => {
    expect(ROUNDS_PER_GAME).toBe(5);          // FIELDGOAL_ROUNDS
    expect(MAX_DISTANCE_YDS).toBeLessThanOrEqual(70); // FIELDGOAL_MAX_POINTS_PER_KICK
    expect(AIM_WINDOW_MS).toBe(3000);
  });
});
