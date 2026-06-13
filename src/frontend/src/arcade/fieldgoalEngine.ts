// ==========================================
// Field Goal — pure game logic (no canvas, no React) so the whole rules
// engine is unit-testable. World units are FEET in a right-handed frame
// anchored at the ball spot: x lateral (+ = kicker's right), y up,
// z downfield toward the uprights.
//
// A round is 5 kicks. Each kick spots the ball at a random distance
// (20–58 yds, the real spot-to-posts distance) on a random hash (left /
// middle / right). The player has 3 seconds from the snap to aim and
// release — drag back from the ball exactly like the golf game; the drag
// length is power, the drag direction steers the kick. A clock expiry
// boots a botched kick that always misses (wide left / wide right / short).
// Points: the kick distance in yards on a make, 0 on a miss.
// ==========================================

import { OUTFIT_COLORS } from './engine';

export interface Vec2 { x: number; y: number }

// ── Kicker persona (customizable for $1, stored on-chain) ──
export interface KickerLook { helmet: number; skin: number; jersey: number }
export const DEFAULT_KICKER: KickerLook = { helmet: 0, skin: 0, jersey: 0 };
// Helmet + jersey share the outfit palette; skin shares the golfer's tones.
export const HELMET_COLORS = OUTFIT_COLORS;
export const JERSEY_COLORS = OUTFIT_COLORS;

// ── Field geometry (NFL dimensions, in feet) ──
export const CROSSBAR_FT = 10;
export const POST_HALF_GAP_FT = 9.25;   // uprights are 18.5 ft apart
export const UPRIGHT_TOP_FT = 45;       // rendered upright height
export const HASH_OFFSET_FT = 9.25;     // hash marks sit ±9.25 ft of center

// ── Kick model ──
export const ELEVATION_RAD = (38 * Math.PI) / 180; // fixed launch loft
export const GRAVITY_FTS2 = 32.2;
export const MAX_KICK_SPEED_FTS = 90;   // ~61 mph — a 58-yarder needs ~88%
export const MAX_AZIMUTH_RAD = (20 * Math.PI) / 180;
export const MAX_DRAG_PX = 150;         // same feel as the golf game
export const AIM_WINDOW_MS = 3_000;     // the pressure clock
export const NEXT_KICK_COUNTDOWN_MS = 3_000; // auto-advance between kicks

export const ROUNDS_PER_GAME = 5;
export const MIN_DISTANCE_YDS = 20;
export const MAX_DISTANCE_YDS = 58;

export type KickOutcome = 'good' | 'wide_left' | 'wide_right' | 'short';

export interface KickSpec {
  /** Spot-to-uprights distance — also the points value of a make. */
  distanceYds: number;
  /** Ball's lateral offset (ft): -HASH (left hash), 0 (middle), +HASH. */
  hashOffsetFt: number;
}

export interface Kick {
  /** Initial speed, ft/s. */
  speed: number;
  /** Lateral aim, radians; 0 = straight downfield, + = right. */
  azimuth: number;
}

export interface KickResult {
  outcome: KickOutcome;
  points: number;
  /** Ball state when it crosses the upright plane (for the replay text). */
  crossXFt: number;
  crossYFt: number;
}

/** A new random kick situation. `rng` defaults to Math.random (injectable). */
export function randomKickSpec(rng: () => number = Math.random): KickSpec {
  const distanceYds = MIN_DISTANCE_YDS + Math.floor(rng() * (MAX_DISTANCE_YDS - MIN_DISTANCE_YDS + 1));
  const hash = Math.floor(rng() * 3); // 0 left, 1 middle, 2 right
  return {
    distanceYds,
    hashOffsetFt: (hash - 1) * HASH_OFFSET_FT,
  };
}

/**
 * Drag → kick, golf-style: pull back from the ball and release. The kick
 * fires opposite the drag (drag down-and-left → ball flies up-and-right).
 * Returns null inside the dead zone (too small to count as an attempt).
 */
export function dragToKick(drag: Vec2): Kick | null {
  const len = Math.hypot(drag.x, drag.y);
  if (len < 8) return null;
  const power = Math.min(len, MAX_DRAG_PX) / MAX_DRAG_PX;
  // Release direction is -drag. In screen coords y grows DOWNWARD, so a
  // downward drag (+y) releases up-screen = downfield: lateral = -drag.x,
  // downfield = +drag.y.
  const azimuth = Math.max(-MAX_AZIMUTH_RAD, Math.min(MAX_AZIMUTH_RAD, Math.atan2(-drag.x, drag.y)));
  return { speed: power * MAX_KICK_SPEED_FTS, azimuth };
}

/** Ball position at time t (seconds) for a kick from `spec`. */
export function ballAt(spec: KickSpec, kick: Kick, t: number): { x: number; y: number; z: number } {
  const vGround = kick.speed * Math.cos(ELEVATION_RAD);
  const vUp = kick.speed * Math.sin(ELEVATION_RAD);
  return {
    x: spec.hashOffsetFt + vGround * Math.sin(kick.azimuth) * t,
    y: Math.max(0, vUp * t - 0.5 * GRAVITY_FTS2 * t * t),
    z: vGround * Math.cos(kick.azimuth) * t,
  };
}

/** Seconds until the ball crosses the upright plane (Infinity if it can't). */
export function timeToPlane(spec: KickSpec, kick: Kick): number {
  const vz = kick.speed * Math.cos(ELEVATION_RAD) * Math.cos(kick.azimuth);
  if (vz <= 0) return Infinity;
  return (spec.distanceYds * 3) / vz;
}

/** Seconds until the ball returns to the ground. */
export function flightTime(kick: Kick): number {
  return (2 * kick.speed * Math.sin(ELEVATION_RAD)) / GRAVITY_FTS2;
}

/** Judge a kick: where is the ball when it reaches the upright plane? */
export function simulateKick(spec: KickSpec, kick: Kick): KickResult {
  const tPlane = timeToPlane(spec, kick);
  const tDown = flightTime(kick);
  // Ball lands before the plane → short, wherever it was heading.
  if (tPlane > tDown) {
    const at = ballAt(spec, kick, tDown);
    return { outcome: 'short', points: 0, crossXFt: at.x, crossYFt: 0 };
  }
  const at = ballAt(spec, kick, tPlane);
  if (at.x < -POST_HALF_GAP_FT) {
    return { outcome: 'wide_left', points: 0, crossXFt: at.x, crossYFt: at.y };
  }
  if (at.x > POST_HALF_GAP_FT) {
    return { outcome: 'wide_right', points: 0, crossXFt: at.x, crossYFt: at.y };
  }
  if (at.y < CROSSBAR_FT) {
    return { outcome: 'short', points: 0, crossXFt: at.x, crossYFt: at.y };
  }
  return { outcome: 'good', points: spec.distanceYds, crossXFt: at.x, crossYFt: at.y };
}

/**
 * The clock hit zero: the kicker rushes it and shanks. Produces a kick that
 * is GUARANTEED to miss — wide left, wide right, or short at random.
 */
export function botchedKick(spec: KickSpec, rng: () => number = Math.random): Kick {
  const mode = Math.floor(rng() * 3);
  if (mode === 0 || mode === 1) {
    // Shank: full leg, hooked way outside a post. Aim past the worst-case
    // post edge so even a friendly hash can't save it.
    const sign = mode === 0 ? -1 : 1;
    const az = sign * MAX_AZIMUTH_RAD;
    const kick = { speed: MAX_KICK_SPEED_FTS, azimuth: az };
    // Verify; if geometry ever saves it (it shouldn't), fall through to short.
    if (simulateKick(spec, kick).outcome !== 'good') return kick;
  }
  // Chunked it: plenty of direction, no leg.
  return { speed: 0.45 * MAX_KICK_SPEED_FTS, azimuth: (rng() - 0.5) * 0.2 };
}

export function outcomeLabel(o: KickOutcome): string {
  switch (o) {
    case 'good': return 'IT’S GOOD!';
    case 'wide_left': return 'WIDE LEFT';
    case 'wide_right': return 'WIDE RIGHT';
    case 'short': return 'SHORT';
  }
}

export function hashLabel(hashOffsetFt: number): string {
  if (hashOffsetFt < 0) return 'left hash';
  if (hashOffsetFt > 0) return 'right hash';
  return 'middle';
}
