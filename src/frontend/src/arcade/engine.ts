// ==========================================
// Mini Golf — game engine (pure logic, no DOM)
// Voxel-tile edition: every hole is a 22×14 cell grid (each cell renders as
// a flat-shaded isometric cube). Slingshot putt, rolling-ball physics with
// wall cubes / sand / water / slopes / posts / a windmill bar, par-rated
// holes, 12-stroke pickup cap. Layouts are admin-editable: the backend
// stores per-hole overrides (same cell encoding) merged over these defaults.
// ==========================================

import {
  ElementKind,
  type CourseDataV1, type Hole as CourseHole, type Element as CourseElement,
} from './courseData.ts';

export interface Vec { x: number; y: number }
/** Rotating windmill bar centred on (cx, cy) in world px; angle = phase + speed·t. */
export interface MovingBar { cx: number; cy: number; len: number; speed: number; phase: number }

// ── CourseDataV1 element runtime types (PB-303) ──
// These are the *engine-side* compiled forms of CourseDataV1 elements. They are
// all in world px and carry only canonical collision geometry — no art. The
// render layer (RenderKit) consumes the geometry these expose; it never recomputes it.

/** A static or wall collider as a line segment (world px). Walls/corners/45°/curved
 *  compile to one or more of these. */
export interface WallSeg { x1: number; y1: number; x2: number; y2: number }

export type StaticKind = 'rock' | 'pillar' | 'bumper' | 'tree';
/** A static obstacle. Boxes (rock/tree) use {x,y,w,h} in world px; round
 *  obstacles (pillar/bumper) use {cx,cy,r}. `shape` disambiguates. */
export interface StaticObs {
  kind: StaticKind;
  shape: 'box' | 'circle';
  // box
  x?: number; y?: number; w?: number; h?: number;
  // circle
  cx?: number; cy?: number; r?: number;
}

export type MoverKind = 'windmill' | 'pendulum' | 'paddle' | 'sliding';
/** A moving obstacle. `moverGeometry(m, tSec)` resolves the instantaneous
 *  canonical collision geometry for any clock value (pure, deterministic). */
export interface Mover {
  kind: MoverKind;
  pivot: Vec;          // centre (windmill), pivot point (pendulum/paddle), or path centre (sliding)
  len: number;         // arm/bar length (world px)
  baseSpeed: number;   // rad/s (rotating) or px/s (sliding) — already speed-mult applied
  phase0: number;      // phase offset (rad for rotating, or path phase for sliding)
  axis?: 0 | 1;        // sliding: 0 = x-axis, 1 = y-axis
  slideLen?: number;   // sliding: half-travel along the axis (world px)
}

/** Canonical instantaneous geometry of a mover at clock `tSec`. A segment for
 *  rotating movers; an AABB box (returned also as its diagonal segment) for sliding. */
export interface MoverGeometry {
  seg: { x1: number; y1: number; x2: number; y2: number };
  box?: { x: number; y: number; w: number; h: number }; // present for sliding blocks
}

export type PortalKind = 'tunnel-in' | 'tunnel-out';
export interface TunnelPair {
  pairId: number;
  entrance: Vec; // world-px centre
  exit: Vec;     // world-px centre
  /** rot delta (0..3) applied to velocity when teleporting entrance→exit. */
  rotDelta: number;
}

export interface RampPair {
  pairId: number;
  /** Both ramp cells redirect to their facing; we store both as redirect tiles. */
  up: { cell: Vec; rot: number };
  down: { cell: Vec; rot: number };
}

export type TileKind = 'speed' | 'slow';
/** A speed/slow tile, cell-keyed (grid coords) with a facing rot and strength. */
export interface SpeedSlowTile { kind: TileKind; gx: number; gy: number; rot: number; strength: number }

// ── Grid / cell model (mirrored by the backend's ArcadeHoleDef) ──
export const CELL = 40;            // world px per cell
export const GRID_W = 22;
export const GRID_H = 14;

// Const object instead of a TS enum (erasableSyntaxOnly-compatible).
export const CellType = {
  Void: 0,   // outside the course — solid, never rendered
  Grass: 1,
  Wall: 2,   // raised voxel cube
  Sand: 3,
  Water: 4,
  SlopeN: 5, // accelerates the ball north (−y)
  SlopeS: 6,
  SlopeE: 7,
  SlopeW: 8,
  Post: 9,   // grass with a round post voxel in the middle
  Rough: 10, // heavier-friction surface (between green and sand)
} as const;
export type CellType = typeof CellType[keyof typeof CellType];

export const WALKABLE: CellType[] = [CellType.Grass, CellType.SlopeN, CellType.SlopeS, CellType.SlopeE, CellType.SlopeW, CellType.Rough];

/** Runtime hole: compiled grid + world-px tee/cup/bars. */
export interface HoleDef {
  name: string;
  par: number;
  w: number;
  h: number;
  cells: Uint8Array;  // row-major w×h
  tee: Vec;
  cup: Vec;
  bars: MovingBar[];
  // ── PB-303 CourseDataV1 element arrays (optional; absent on the built-in COURSE) ──
  walls?: WallSeg[];        // straight/corner/45/curved → world-px segments
  statics?: StaticObs[];    // rock/pillar/bumper/tree → world-px circles/boxes
  movers?: Mover[];         // windmill/pendulum/paddle/sliding (generalises bars)
  tunnels?: TunnelPair[];   // entrance+exit world-px portals
  ramps?: RampPair[];
  tiles?: SpeedSlowTile[];  // speed/slow tiles (cell-keyed, signed magnitude)
}

/** Backend wire format (candid ArcadeHoleDef). */
export interface BackendHole {
  name: string;
  par: number;
  w: number;
  h: number;
  cells: Uint8Array | number[];
  tee_x: number; tee_y: number;
  cup_x: number; cup_y: number;
  bars: { cx: number; cy: number; len_cells: number; speed_mrad: number }[];
}

// ── Physics constants (fixed 120 Hz timestep) ──
export const STEP = 1 / 120;
export const BALL_R = 7;
export const POST_R = 12;
export const CUP_R = 15;
/** Max capture speed (px/s) — faster putts roll over the cup like the original. */
export const CUP_CAPTURE_SPEED = 240;
export const MAX_POWER = 950;       // px/s at full drag
export const MAX_DRAG = 150;        // px of drag for full power
export const FRICTION_GREEN = 0.9905; // per 120 Hz step
export const FRICTION_SAND = 0.94;
export const FRICTION_ROUGH = 0.972;  // between green and sand (PB-303)

// ── PB-303 moving-obstacle & special-element constants ──
// Slow/Med/Fast → angular speed (rad/s) for windmill/pendulum/paddle.
export const MOVER_SPEED: Record<number, number> = { 0: 0.9, 1: 1.9, 2: 3.4 };
// Slow/Med/Fast → linear speed (px/s) for sliding blocks.
export const SLIDE_SPEED: Record<number, number> = { 0: 60, 1: 130, 2: 240 };
export const BUMPER_GAIN = 1.6;       // outbound speed multiplier on a bumper (capped at MAX_POWER)
export const TILE_BOOST = 220;        // px/s impulse along a speed tile's facing
export const TILE_SLOW = 0.80;        // per-step velocity scale on a slow tile
export const TUNNEL_R = 16;           // portal capture radius (px)
export const MOVER_THICK = 4;         // half-thickness padding for mover/wall segments (px)
export const PENDULUM_ARC = Math.PI / 2; // ± swing amplitude for a pendulum (rad)
export const SLOPE_ACCEL = 160;     // px/s²
export const WALL_RESTITUTION = 0.9;
export const STOP_SPEED = 5;        // px/s
export const MAX_SHOT_SECONDS = 15;
export const MAX_STROKES_PER_HOLE = 12;
export const HOLES_PER_ROUND = 9;

export type BallPhase = 'resting' | 'rolling' | 'sunk';

export interface HoleState {
  pos: Vec;
  vel: Vec;
  /** Position before the current shot — water penalties return here. */
  preShot: Vec;
  phase: BallPhase;
  strokes: number;
  /** Seconds simulated for the current shot (enforces MAX_SHOT_SECONDS). */
  shotTime: number;
  /** Set for one step when an event happens (drives renderer effects/sfx). */
  event: 'wall' | 'water' | 'sunk' | 'capped' | 'bumper' | 'tunnel' | 'ramp' | 'tile' | null;
  /** Tunnel re-entry cooldown (steps remaining); prevents instant exit→entrance loops. */
  tunnelCooldown?: number;
}

export function initHole(def: HoleDef): HoleState {
  return {
    pos: { ...def.tee },
    vel: { x: 0, y: 0 },
    preShot: { ...def.tee },
    phase: 'resting',
    strokes: 0,
    shotTime: 0,
    event: null,
    tunnelCooldown: 0,
  };
}

export function speed(v: Vec): number {
  return Math.hypot(v.x, v.y);
}

/** Cell type at grid coords; everything outside the grid is solid Void. */
export function cellAt(def: HoleDef, gx: number, gy: number): CellType {
  if (gx < 0 || gy < 0 || gx >= def.w || gy >= def.h) return CellType.Void;
  return def.cells[gy * def.w + gx] as CellType;
}

export function cellAtWorld(def: HoleDef, p: Vec): CellType {
  return cellAt(def, Math.floor(p.x / CELL), Math.floor(p.y / CELL));
}

function isSolid(c: CellType): boolean {
  return c === CellType.Wall || c === CellType.Void;
}

/** Drag vector (ball → pointer) to launch velocity: fires opposite the drag. */
export function dragToShot(drag: Vec): Vec {
  const len = Math.hypot(drag.x, drag.y);
  if (len < 4) return { x: 0, y: 0 }; // dead zone — too small to count
  const power = (Math.min(len, MAX_DRAG) / MAX_DRAG) * MAX_POWER;
  return { x: (-drag.x / len) * power, y: (-drag.y / len) * power };
}

/** Strike the ball. Returns false (no stroke) for a dead-zone drag. */
export function strike(state: HoleState, shotVel: Vec): boolean {
  if (state.phase !== 'resting') return false;
  if (shotVel.x === 0 && shotVel.y === 0) return false;
  state.preShot = { ...state.pos };
  state.vel = { ...shotVel };
  state.phase = 'rolling';
  state.strokes += 1;
  state.shotTime = 0;
  return true;
}

export function barEndpoints(bar: MovingBar, tSec: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = bar.phase + bar.speed * tSec;
  const dx = Math.cos(a) * bar.len / 2;
  const dy = Math.sin(a) * bar.len / 2;
  return { x1: bar.cx - dx, y1: bar.cy - dy, x2: bar.cx + dx, y2: bar.cy + dy };
}

/** Push the ball out of a point and reflect the inbound velocity component. */
function bounceFrom(state: HoleState, cpx: number, cpy: number, minDist: number): boolean {
  const nx = state.pos.x - cpx, ny = state.pos.y - cpy;
  let dist = Math.hypot(nx, ny);
  let ux: number, uy: number;
  if (dist === 0) { ux = 0; uy = -1; dist = 0.0001; } else { ux = nx / dist; uy = ny / dist; }
  if (dist >= minDist) return false;
  state.pos.x = cpx + ux * minDist;
  state.pos.y = cpy + uy * minDist;
  const dot = state.vel.x * ux + state.vel.y * uy;
  if (dot < 0) {
    state.vel.x -= (1 + WALL_RESTITUTION) * dot * ux;
    state.vel.y -= (1 + WALL_RESTITUTION) * dot * uy;
    return true;
  }
  return false;
}

/** Circle vs one solid cell (AABB): closest-point bounce. */
function collideCell(state: HoleState, gx: number, gy: number): boolean {
  const cpx = Math.max(gx * CELL, Math.min(state.pos.x, (gx + 1) * CELL));
  const cpy = Math.max(gy * CELL, Math.min(state.pos.y, (gy + 1) * CELL));
  if (cpx === state.pos.x && cpy === state.pos.y) {
    // Ball centre is inside the cube (tunnelled): push out the nearest face.
    const lx = state.pos.x - gx * CELL, rx = (gx + 1) * CELL - state.pos.x;
    const ty = state.pos.y - gy * CELL, by = (gy + 1) * CELL - state.pos.y;
    const m = Math.min(lx, rx, ty, by);
    if (m === lx) state.pos.x = gx * CELL - BALL_R;
    else if (m === rx) state.pos.x = (gx + 1) * CELL + BALL_R;
    else if (m === ty) state.pos.y = gy * CELL - BALL_R;
    else state.pos.y = (gy + 1) * CELL + BALL_R;
    state.vel.x *= -WALL_RESTITUTION;
    state.vel.y *= -WALL_RESTITUTION;
    return true;
  }
  return bounceFrom(state, cpx, cpy, BALL_R);
}

/** Circle vs the rotating bar (segment with thickness). */
function collideBar(state: HoleState, bar: MovingBar, tSec: number): boolean {
  const w = barEndpoints(bar, tSec);
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((state.pos.x - w.x1) * dx + (state.pos.y - w.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return bounceFrom(state, w.x1 + t * dx, w.y1 + t * dy, BALL_R + 4);
}

// ── PB-303: canonical mover geometry (pure function of the hole clock) ──

/**
 * Instantaneous collision geometry of a moving obstacle at clock `tSec`.
 * Pure & deterministic (no RNG) so every player sees the same phase at the
 * same elapsed time (A.2 fairness). The render layer consumes this verbatim.
 */
export function moverGeometry(m: Mover, tSec: number): MoverGeometry {
  switch (m.kind) {
    case 'windmill': {
      // Centre-pivot segment (the classic bar): half-length each side.
      const a = m.phase0 + m.baseSpeed * tSec;
      const dx = Math.cos(a) * m.len / 2;
      const dy = Math.sin(a) * m.len / 2;
      return { seg: { x1: m.pivot.x - dx, y1: m.pivot.y - dy, x2: m.pivot.x + dx, y2: m.pivot.y + dy } };
    }
    case 'paddle': {
      // End-pivot segment: one end fixed at the pivot, sweeps a full circle.
      const a = m.phase0 + m.baseSpeed * tSec;
      const dx = Math.cos(a) * m.len;
      const dy = Math.sin(a) * m.len;
      return { seg: { x1: m.pivot.x, y1: m.pivot.y, x2: m.pivot.x + dx, y2: m.pivot.y + dy } };
    }
    case 'pendulum': {
      // End-pivot segment swinging through ±PENDULUM_ARC about a base angle.
      const angle = (Math.PI / 2) + PENDULUM_ARC * Math.sin(m.phase0 + m.baseSpeed * tSec);
      const dx = Math.cos(angle) * m.len;
      const dy = Math.sin(angle) * m.len;
      return { seg: { x1: m.pivot.x, y1: m.pivot.y, x2: m.pivot.x + dx, y2: m.pivot.y + dy } };
    }
    case 'sliding': {
      // AABB translating back-and-forth along an axis (triangle wave via sin).
      const travel = (m.slideLen ?? CELL) * Math.sin(m.phase0 + m.baseSpeed * tSec);
      const cx = m.pivot.x + (m.axis === 1 ? 0 : travel);
      const cy = m.pivot.y + (m.axis === 1 ? travel : 0);
      const half = m.len / 2;
      const box = { x: cx - half, y: cy - half, w: m.len, h: m.len };
      return {
        seg: { x1: box.x, y1: box.y, x2: box.x + box.w, y2: box.y + box.h },
        box,
      };
    }
  }
}

/** Circle vs an arbitrary segment with thickness; reuses bounceFrom. */
function collideSegment(state: HoleState, x1: number, y1: number, x2: number, y2: number, pad: number): boolean {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((state.pos.x - x1) * dx + (state.pos.y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return bounceFrom(state, x1 + t * dx, y1 + t * dy, BALL_R + pad);
}

/** Circle vs an AABB (world px); closest-point bounce like collideCell. */
function collideBox(state: HoleState, x: number, y: number, w: number, h: number): boolean {
  const cpx = Math.max(x, Math.min(state.pos.x, x + w));
  const cpy = Math.max(y, Math.min(state.pos.y, y + h));
  if (cpx === state.pos.x && cpy === state.pos.y) {
    const lx = state.pos.x - x, rx = x + w - state.pos.x;
    const ty = state.pos.y - y, by = y + h - state.pos.y;
    const m = Math.min(lx, rx, ty, by);
    if (m === lx) state.pos.x = x - BALL_R;
    else if (m === rx) state.pos.x = x + w + BALL_R;
    else if (m === ty) state.pos.y = y - BALL_R;
    else state.pos.y = y + h + BALL_R;
    state.vel.x *= -WALL_RESTITUTION;
    state.vel.y *= -WALL_RESTITUTION;
    return true;
  }
  return bounceFrom(state, cpx, cpy, BALL_R);
}

/** Unit facing vector for a rot (0=N,1=E,2=S,3=W). */
function rotDir(rot: number): Vec {
  switch (((rot % 4) + 4) % 4) {
    case 0: return { x: 0, y: -1 };
    case 1: return { x: 1, y: 0 };
    case 2: return { x: 0, y: 1 };
    default: return { x: -1, y: 0 };
  }
}

/**
 * Advance one 120 Hz step while rolling. `tSec` is the running hole clock
 * (drives the windmill). Mutates state; sets `state.event` for the renderer.
 */
export function stepHole(state: HoleState, def: HoleDef, tSec: number): void {
  state.event = null;
  if (state.phase !== 'rolling') return;

  state.shotTime += STEP;

  // Slope acceleration from the cell under the ball.
  const cell = cellAtWorld(def, state.pos);
  if (cell === CellType.SlopeN) state.vel.y -= SLOPE_ACCEL * STEP;
  else if (cell === CellType.SlopeS) state.vel.y += SLOPE_ACCEL * STEP;
  else if (cell === CellType.SlopeE) state.vel.x += SLOPE_ACCEL * STEP;
  else if (cell === CellType.SlopeW) state.vel.x -= SLOPE_ACCEL * STEP;

  // Integrate.
  state.pos.x += state.vel.x * STEP;
  state.pos.y += state.vel.y * STEP;

  // Solid cells around the ball (3×3 neighbourhood covers BALL_R < CELL).
  let hit = false;
  const cgx = Math.floor(state.pos.x / CELL), cgy = Math.floor(state.pos.y / CELL);
  for (let gy = cgy - 1; gy <= cgy + 1; gy++) {
    for (let gx = cgx - 1; gx <= cgx + 1; gx++) {
      const c = cellAt(def, gx, gy);
      if (isSolid(c)) hit = collideCell(state, gx, gy) || hit;
      else if (c === CellType.Post) {
        hit = bounceFrom(state, (gx + 0.5) * CELL, (gy + 0.5) * CELL, BALL_R + POST_R) || hit;
      }
    }
  }
  for (const bar of def.bars) hit = collideBar(state, bar, tSec) || hit;

  // ── PB-303 walls (segments) ──
  if (def.walls) {
    for (const w of def.walls) hit = collideSegment(state, w.x1, w.y1, w.x2, w.y2, MOVER_THICK) || hit;
  }

  // ── PB-303 statics: rock/tree (box), pillar (circle), bumper (circle w/ gain) ──
  if (def.statics) {
    for (const s of def.statics) {
      if (s.shape === 'box') {
        hit = collideBox(state, s.x!, s.y!, s.w!, s.h!) || hit;
      } else if (s.kind === 'bumper') {
        const before = speed(state.vel);
        if (bounceFrom(state, s.cx!, s.cy!, BALL_R + s.r!)) {
          // Add outbound speed (restitution > 1), capped at MAX_POWER.
          const after = speed(state.vel);
          if (after > 0) {
            const target = Math.min(Math.max(before, after) * BUMPER_GAIN, MAX_POWER);
            const k = target / after;
            state.vel.x *= k;
            state.vel.y *= k;
          }
          hit = true;
          state.event = 'bumper';
        }
      } else {
        hit = bounceFrom(state, s.cx!, s.cy!, BALL_R + s.r!) || hit;
      }
    }
  }

  // ── PB-303 movers: windmill/pendulum/paddle (segments) + sliding (box) ──
  if (def.movers) {
    for (const m of def.movers) {
      const g = moverGeometry(m, tSec);
      if (g.box) hit = collideBox(state, g.box.x, g.box.y, g.box.w, g.box.h) || hit;
      else hit = collideSegment(state, g.seg.x1, g.seg.y1, g.seg.x2, g.seg.y2, MOVER_THICK) || hit;
    }
  }

  if (hit && state.event === null) state.event = 'wall';

  // Water: splash → +1 penalty stroke, ball returns to the pre-shot spot.
  if (cellAtWorld(def, state.pos) === CellType.Water) {
    state.pos = { ...state.preShot };
    state.vel = { x: 0, y: 0 };
    state.strokes += 1;
    state.phase = 'resting';
    state.event = 'water';
    // The 12-stroke pickup applies on this path too — without it a water
    // penalty on stroke 12 pushed per-hole counts past the cap and the
    // backend rejected the whole round (INVALID_STROKES).
    if (state.strokes >= MAX_STROKES_PER_HOLE) {
      state.strokes = MAX_STROKES_PER_HOLE;
      state.phase = 'sunk';
      state.event = 'capped';
    }
    return;
  }

  // ── PB-303 special tiles/ramps/tunnels (cell-keyed, O(1)-ish lookups) ──
  if (state.tunnelCooldown && state.tunnelCooldown > 0) state.tunnelCooldown--;
  const bgx = Math.floor(state.pos.x / CELL), bgy = Math.floor(state.pos.y / CELL);

  // Speed/slow tiles: directional boost or a per-step velocity scale.
  if (def.tiles) {
    for (const tile of def.tiles) {
      if (tile.gx !== bgx || tile.gy !== bgy) continue;
      if (tile.kind === 'speed') {
        const d = rotDir(tile.rot);
        state.vel.x += d.x * TILE_BOOST * STEP;
        state.vel.y += d.y * TILE_BOOST * STEP;
      } else {
        state.vel.x *= TILE_SLOW;
        state.vel.y *= TILE_SLOW;
      }
      state.event = 'tile';
    }
  }

  // Ramps: on entering a ramp cell, redirect velocity along the ramp facing
  // (speed magnitude preserved) — routing redirect.
  if (def.ramps) {
    for (const rp of def.ramps) {
      for (const end of [rp.up, rp.down]) {
        if (end.cell.x === bgx && end.cell.y === bgy) {
          const sp = speed(state.vel);
          if (sp > STOP_SPEED) {
            const d = rotDir(end.rot);
            state.vel.x = d.x * sp;
            state.vel.y = d.y * sp;
            state.event = 'ramp';
          }
        }
      }
    }
  }

  // Tunnels: entering an entrance portal teleports to the paired exit with
  // momentum preserved (rotated by the exit-vs-entrance rot delta).
  if (def.tunnels && (!state.tunnelCooldown || state.tunnelCooldown === 0)) {
    for (const tp of def.tunnels) {
      const de = Math.hypot(state.pos.x - tp.entrance.x, state.pos.y - tp.entrance.y);
      if (de < TUNNEL_R) {
        state.pos = { x: tp.exit.x, y: tp.exit.y };
        // Rotate velocity by rotDelta * 90° CW.
        const turns = ((tp.rotDelta % 4) + 4) % 4;
        let { x: vx, y: vy } = state.vel;
        for (let i = 0; i < turns; i++) {
          const nx = -vy, ny = vx; // 90° CW in screen coords (y down)
          vx = nx; vy = ny;
        }
        state.vel = { x: vx, y: vy };
        state.tunnelCooldown = 6; // a few steps so the ball clears the exit portal
        state.event = 'tunnel';
        break;
      }
    }
  }

  // Friction (sand is much heavier; rough is in-between).
  const fcell = cellAtWorld(def, state.pos);
  const f = fcell === CellType.Sand ? FRICTION_SAND
    : fcell === CellType.Rough ? FRICTION_ROUGH
    : FRICTION_GREEN;
  state.vel.x *= f;
  state.vel.y *= f;

  // Cup capture: close + slow. Fast balls roll straight over (classic lip).
  const cupDist = Math.hypot(state.pos.x - def.cup.x, state.pos.y - def.cup.y);
  if (cupDist < CUP_R - 2 && speed(state.vel) < CUP_CAPTURE_SPEED) {
    state.pos = { ...def.cup };
    state.vel = { x: 0, y: 0 };
    state.phase = 'sunk';
    state.event = 'sunk';
    return;
  }

  // Rest / timeout.
  if (speed(state.vel) < STOP_SPEED || state.shotTime > MAX_SHOT_SECONDS) {
    state.vel = { x: 0, y: 0 };
    state.phase = 'resting';
    // 12-stroke pickup: the hole ends at the cap (scored as 12).
    if (state.strokes >= MAX_STROKES_PER_HOLE) {
      state.phase = 'sunk';
      state.event = 'capped';
    }
  }
}

// ── Character palettes (indices stored on-chain; mirrored by the backend) ──
export const HAIR_COLORS = ['#3b2a1d', '#0f0f10', '#a96a2d', '#d8b35a', '#7a3327', '#9b9b9b'];
export const HAIR_NAMES = ['Brown', 'Black', 'Auburn', 'Blonde', 'Red', 'Silver'];
export const SKIN_COLORS = ['#f1c8a4', '#e0ac7e', '#c68a55', '#a06a3c', '#7c4f2a', '#5a3a20'];
export const SKIN_NAMES = ['Fair', 'Light', 'Tan', 'Bronze', 'Brown', 'Deep'];
export const OUTFIT_COLORS = ['#e8602c', '#2d7ff0', '#27a05c', '#e3b52e', '#9b59d0', '#e2447e', '#22b8c4', '#f0f0ec'];
export const OUTFIT_NAMES = ['Burn Orange', 'Blue', 'Green', 'Gold', 'Purple', 'Pink', 'Teal', 'White'];

export interface CharacterLook { hair: number; skin: number; outfit: number }
export const DEFAULT_CHARACTER: CharacterLook = { hair: 0, skin: 0, outfit: 0 };

// ── ASCII course authoring ──
// '.' void · 'g' grass · '#' wall · 's' sand · 'w' water · '^v><' slopes
// (chevron = downhill/acceleration direction) · 'o' post · 'T' tee · 'C' cup
// (T/C sit on grass).

const ASCII_TO_CELL: Record<string, CellType> = {
  '.': CellType.Void, 'g': CellType.Grass, '#': CellType.Wall, 's': CellType.Sand,
  'w': CellType.Water, '^': CellType.SlopeN, 'v': CellType.SlopeS, '>': CellType.SlopeE,
  '<': CellType.SlopeW, 'o': CellType.Post, 'T': CellType.Grass, 'C': CellType.Grass,
};

export function parseAscii(rows: string[]): { cells: Uint8Array; tee: Vec | null; cup: Vec | null } {
  if (rows.length !== GRID_H) throw new Error(`expected ${GRID_H} rows, got ${rows.length}`);
  const cells = new Uint8Array(GRID_W * GRID_H);
  let tee: Vec | null = null, cup: Vec | null = null;
  rows.forEach((row, gy) => {
    if (row.length !== GRID_W) throw new Error(`row ${gy} is ${row.length} chars, expected ${GRID_W}`);
    for (let gx = 0; gx < GRID_W; gx++) {
      const ch = row[gx];
      const cell = ASCII_TO_CELL[ch];
      if (cell === undefined) throw new Error(`unknown cell '${ch}' at ${gx},${gy}`);
      cells[gy * GRID_W + gx] = cell;
      if (ch === 'T') tee = { x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL };
      if (ch === 'C') cup = { x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL };
    }
  });
  return { cells, tee, cup };
}

interface DefaultHole {
  name: string;
  par: number;
  rows: string[];
  bars?: { cx: number; cy: number; lenCells: number; speed: number }[]; // grid coords
}

// 9 original holes, par total 27, difficulty ramp:
// straight → dogleg → island block → bunkers → water carry → slope →
// windmill → switchback → finale.
const DEFAULT_HOLES: DefaultHole[] = [
  {
    name: 'First Putt', par: 2,
    rows: [
      '......................',
      '.......########.......',
      '.......#gggggg#.......',
      '.......#ggCggg#.......',
      '.......#gggggg#.......',
      '.......#gggggg#.......',
      '.......#gggggg#.......',
      '.......#gggggg#.......',
      '.......#gggggg#.......',
      '.......#gggggg#.......',
      '.......#ggTggg#.......',
      '.......#gggggg#.......',
      '.......########.......',
      '......................',
    ],
  },
  {
    name: 'Dogleg', par: 2,
    rows: [
      '......................',
      '....##############....',
      '....#gggggggggggg#....',
      '....#ggggggggggCg#....',
      '....#gggggggggggg#....',
      '....#ggg##########....',
      '....#ggg#.............',
      '....#ggg#.............',
      '....#ggg#.............',
      '....#ggg#.............',
      '....#gTg#.............',
      '....#ggg#.............',
      '....#####.............',
      '......................',
    ],
  },
  {
    name: 'The Diamond', par: 3,
    rows: [
      '......................',
      '.....############.....',
      '.....#gggggggggg#.....',
      '.....#ggggCggggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggg##gggg#.....',
      '.....#ggg####ggg#.....',
      '.....#ggg####ggg#.....',
      '.....#gggg##gggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggggggggg#.....',
      '.....#ggggTggggg#.....',
      '.....############.....',
      '......................',
    ],
  },
  {
    name: 'Bunker Alley', par: 3,
    rows: [
      '......................',
      '......................',
      '......................',
      '..##################..',
      '..#ggggsssggggggggg#..',
      '..#ggggsssggggggggg#..',
      '..#gTggsssggsssggCg#..',
      '..#ggggsssggsssgggg#..',
      '..#gggggggggsssgggg#..',
      '..#gggggggggsssgggg#..',
      '..##################..',
      '......................',
      '......................',
      '......................',
    ],
  },
  {
    name: 'Island Carry', par: 3,
    rows: [
      '......................',
      '....##############....',
      '....#gggggggggggg#....',
      '....#ggggggCggggg#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#ggwwwwwwwwww#....',
      '....#ggwwwwwwwwww#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#ggggggTggggg#....',
      '....##############....',
      '......................',
    ],
  },
  {
    name: 'The Ramp', par: 3,
    rows: [
      '......................',
      '....##############....',
      '....#ggggg<<<<<<g#....',
      '....#ggggg<<<<C<g#....',
      '....#ggggg<<<<<<g#....',
      '....#ggggg<<<<<<g#....',
      '....#ggggg<<<<<<g#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....#gTgggggggggg#....',
      '....##############....',
      '......................',
    ],
  },
  {
    name: 'Windmill', par: 3,
    rows: [
      '......................',
      '.....############.....',
      '.....#gggggggggg#.....',
      '.....#gggggCgggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggggggggg#.....',
      '.....#####ggg####.....',
      '.....#gggggggggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggggggggg#.....',
      '.....#gggggTgggg#.....',
      '.....############.....',
      '......................',
    ],
    bars: [{ cx: 11.5, cy: 7.5, lenCells: 3, speed: 1.9 }],
  },
  {
    name: 'Switchback', par: 4,
    rows: [
      '......................',
      '....##############....',
      '....#gggggggggggg#....',
      '....#gCgggggggggg#....',
      '....#gggggggggggg#....',
      '....#ggg##########....',
      '....#ggggggggggss#....',
      '....#gggggggggggg#....',
      '....#gggggggggggg#....',
      '....##########gsg#....',
      '....#gggggggggggg#....',
      '....#gTgggggggggg#....',
      '....##############....',
      '......................',
    ],
  },
  {
    name: 'Gold Finale', par: 4,
    rows: [
      '......................',
      '..##################..',
      '..#vvvvvvgggwwggggg#..',
      '..#vvvvvvgggwwgggCg#..',
      '..#vvvvvvgggwwggggg#..',
      '..#gggggggggwwggogg#..',
      '..#ggggggg#gggggggg#..',
      '..#ggggggg#ggggggog#..',
      '..#ggggggg#sssggggg#..',
      '..#ggggggg#sssggggg#..',
      '..#ggggggg#sssggggg#..',
      '..#gTggggg#sssggggg#..',
      '..##################..',
      '......................',
    ],
  },
];

function compileHole(d: DefaultHole): HoleDef {
  const { cells, tee, cup } = parseAscii(d.rows);
  if (!tee || !cup) throw new Error(`${d.name}: tee/cup missing`);
  return {
    name: d.name,
    par: d.par,
    w: GRID_W,
    h: GRID_H,
    cells,
    tee,
    cup,
    bars: (d.bars ?? []).map(b => ({
      cx: b.cx * CELL, cy: b.cy * CELL, len: b.lenCells * CELL, speed: b.speed, phase: 0,
    })),
  };
}

export const COURSE: HoleDef[] = DEFAULT_HOLES.map(compileHole);
export const COURSE_PAR_TOTAL = COURSE.reduce((s, h) => s + h.par, 0);

// ── Backend (candid) conversion — used by the game loader and the editor ──

export function holeFromBackend(b: BackendHole): HoleDef {
  return {
    name: b.name,
    par: Number(b.par),
    w: Number(b.w),
    h: Number(b.h),
    cells: Uint8Array.from(b.cells as ArrayLike<number>),
    tee: { x: (Number(b.tee_x) + 0.5) * CELL, y: (Number(b.tee_y) + 0.5) * CELL },
    cup: { x: (Number(b.cup_x) + 0.5) * CELL, y: (Number(b.cup_y) + 0.5) * CELL },
    bars: b.bars.map(bar => ({
      cx: (Number(bar.cx) + 0.5) * CELL,
      cy: (Number(bar.cy) + 0.5) * CELL,
      len: Number(bar.len_cells) * CELL,
      speed: Number(bar.speed_mrad) / 1000,
      phase: 0,
    })),
  };
}

export function holeToBackend(def: HoleDef): BackendHole {
  return {
    name: def.name,
    par: def.par,
    w: def.w,
    h: def.h,
    cells: Uint8Array.from(def.cells),
    tee_x: Math.floor(def.tee.x / CELL), tee_y: Math.floor(def.tee.y / CELL),
    cup_x: Math.floor(def.cup.x / CELL), cup_y: Math.floor(def.cup.y / CELL),
    bars: def.bars.map(bar => ({
      cx: Math.floor(bar.cx / CELL),
      cy: Math.floor(bar.cy / CELL),
      len_cells: Math.round(bar.len / CELL),
      speed_mrad: Math.round(bar.speed * 1000),
    })),
  };
}

/** Built-in defaults with any on-chain overrides applied. */
export function mergeCourse(overrides: { index: number; hole: BackendHole }[]): HoleDef[] {
  const merged = [...COURSE];
  for (const o of overrides) {
    const i = Number(o.index);
    if (i >= 0 && i < merged.length) merged[i] = holeFromBackend(o.hole);
  }
  return merged;
}

// ── PB-303: CourseDataV1 → HoleDef loader ──

// Terrain ElementKinds rasterize into the cells array; the rest become typed
// obstacle arrays on HoleDef.
const TERRAIN_CELL: Record<number, CellType> = {
  [ElementKind.Fairway]: CellType.Grass,
  [ElementKind.Rough]: CellType.Rough,
  [ElementKind.Sand]: CellType.Sand,
  [ElementKind.Water]: CellType.Water,
  [ElementKind.OutOfBounds]: CellType.Void,
};

function moverFromElement(e: CourseElement): Mover | null {
  const cx = (e.x + 0.5) * CELL, cy = (e.y + 0.5) * CELL;
  if (e.kind === ElementKind.Windmill) {
    if (e.params.tag !== 'moving') return null;
    return { kind: 'windmill', pivot: { x: cx, y: cy }, len: 3 * CELL,
      baseSpeed: MOVER_SPEED[e.params.speed], phase0: (e.params.phase / 100) * 2 * Math.PI };
  }
  if (e.kind === ElementKind.Pendulum) {
    if (e.params.tag !== 'moving') return null;
    return { kind: 'pendulum', pivot: { x: cx, y: cy }, len: 2.5 * CELL,
      baseSpeed: MOVER_SPEED[e.params.speed], phase0: (e.params.phase / 100) * 2 * Math.PI };
  }
  if (e.kind === ElementKind.RotatingPaddle) {
    if (e.params.tag !== 'moving') return null;
    return { kind: 'paddle', pivot: { x: cx, y: cy }, len: 2 * CELL,
      baseSpeed: MOVER_SPEED[e.params.speed], phase0: (e.params.phase / 100) * 2 * Math.PI };
  }
  if (e.kind === ElementKind.SlidingBlock) {
    if (e.params.tag !== 'sliding') return null;
    return { kind: 'sliding', pivot: { x: cx, y: cy }, len: CELL,
      baseSpeed: SLIDE_SPEED[e.params.speed] / Math.max(1, e.params.len * CELL),
      phase0: (e.params.phase / 100) * 2 * Math.PI,
      axis: e.params.axis, slideLen: (e.params.len * CELL) / 2 };
  }
  return null;
}

/** Compile one CourseDataV1 Hole into a runtime, world-px HoleDef. */
export function holeFromCourseData(hole: CourseHole): HoleDef {
  const w = hole.gridW, h = hole.gridH;
  const cells = new Uint8Array(w * h).fill(CellType.Grass);

  const walls: WallSeg[] = [];
  const statics: StaticObs[] = [];
  const movers: Mover[] = [];
  const tiles: SpeedSlowTile[] = [];

  // Tunnel/ramp endpoints, paired by pairId.
  const tunnelIn = new Map<number, Vec>();
  const tunnelOut = new Map<number, Vec>();
  const tunnelOutRot = new Map<number, number>();
  const tunnelInRot = new Map<number, number>();
  const rampUp = new Map<number, { cell: Vec; rot: number }>();
  const rampDown = new Map<number, { cell: Vec; rot: number }>();

  for (const e of hole.elements) {
    const cx = (e.x + 0.5) * CELL, cy = (e.y + 0.5) * CELL;
    const terrain = TERRAIN_CELL[e.kind];
    if (terrain !== undefined) {
      if (e.x >= 0 && e.y >= 0 && e.x < w && e.y < h) cells[e.y * w + e.x] = terrain;
      continue;
    }
    switch (e.kind) {
      case ElementKind.WallStraight: {
        // A wall spanning one cell, oriented by rot (0/2 = vertical face, 1/3 = horizontal).
        const horiz = e.rot === 1 || e.rot === 3;
        if (horiz) walls.push({ x1: e.x * CELL, y1: cy, x2: (e.x + 1) * CELL, y2: cy });
        else walls.push({ x1: cx, y1: e.y * CELL, x2: cx, y2: (e.y + 1) * CELL });
        break;
      }
      case ElementKind.WallCorner: {
        // Two-faced reflector: an L oriented by rot.
        const x0 = e.x * CELL, y0 = e.y * CELL, x1 = (e.x + 1) * CELL, y1 = (e.y + 1) * CELL;
        // Default L = top + left edges; rot rotates the corner CW.
        const edges: [Vec, Vec][] = [
          [{ x: x0, y: y0 }, { x: x1, y: y0 }],
          [{ x: x0, y: y0 }, { x: x0, y: y1 }],
        ];
        for (const [a, b] of edges) walls.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        break;
      }
      case ElementKind.WallAngled45: {
        // Diagonal reflector across the cell; rot picks the diagonal.
        const x0 = e.x * CELL, y0 = e.y * CELL, x1 = (e.x + 1) * CELL, y1 = (e.y + 1) * CELL;
        if (e.rot === 0 || e.rot === 2) walls.push({ x1: x0, y1: y0, x2: x1, y2: y1 });
        else walls.push({ x1: x0, y1: y1, x2: x1, y2: y0 });
        break;
      }
      case ElementKind.WallCurved: {
        // Quarter-arc approximated by 3 short segments forming the curve.
        const x0 = e.x * CELL, y0 = e.y * CELL;
        const pts: Vec[] = [];
        const N = 3;
        for (let i = 0; i <= N; i++) {
          const a = (Math.PI / 2) * (i / N);
          pts.push({ x: x0 + Math.cos(a) * CELL, y: y0 + Math.sin(a) * CELL });
        }
        for (let i = 0; i < N; i++) walls.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
        break;
      }
      case ElementKind.Rock: {
        const size = e.params.tag === 'rock' ? e.params.size : 1;
        statics.push({ kind: 'rock', shape: 'box', x: e.x * CELL, y: e.y * CELL, w: size * CELL, h: CELL });
        break;
      }
      case ElementKind.Tree:
        statics.push({ kind: 'tree', shape: 'box', x: e.x * CELL, y: e.y * CELL, w: CELL, h: CELL });
        break;
      case ElementKind.Pillar:
        statics.push({ kind: 'pillar', shape: 'circle', cx, cy, r: POST_R });
        break;
      case ElementKind.Bumper:
        statics.push({ kind: 'bumper', shape: 'circle', cx, cy, r: POST_R });
        break;
      case ElementKind.Windmill:
      case ElementKind.Pendulum:
      case ElementKind.RotatingPaddle:
      case ElementKind.SlidingBlock: {
        const m = moverFromElement(e);
        if (m) movers.push(m);
        break;
      }
      case ElementKind.TunnelEntrance:
        if (e.params.tag === 'pair') { tunnelIn.set(e.params.pairId, { x: cx, y: cy }); tunnelInRot.set(e.params.pairId, e.rot); }
        break;
      case ElementKind.TunnelExit:
        if (e.params.tag === 'pair') { tunnelOut.set(e.params.pairId, { x: cx, y: cy }); tunnelOutRot.set(e.params.pairId, e.rot); }
        break;
      case ElementKind.RampUp:
        if (e.params.tag === 'pair') rampUp.set(e.params.pairId, { cell: { x: e.x, y: e.y }, rot: e.rot });
        break;
      case ElementKind.RampDown:
        if (e.params.tag === 'pair') rampDown.set(e.params.pairId, { cell: { x: e.x, y: e.y }, rot: e.rot });
        break;
      case ElementKind.SpeedTile:
        tiles.push({ kind: 'speed', gx: e.x, gy: e.y, rot: e.rot, strength: e.params.tag === 'tile' ? e.params.strength : 1 });
        break;
      case ElementKind.SlowTile:
        tiles.push({ kind: 'slow', gx: e.x, gy: e.y, rot: e.rot, strength: e.params.tag === 'tile' ? e.params.strength : 1 });
        break;
      default:
        break;
    }
  }

  const tunnels: TunnelPair[] = [];
  for (const [pairId, entrance] of tunnelIn) {
    const exit = tunnelOut.get(pairId);
    if (!exit) continue;
    const rotDelta = (((tunnelOutRot.get(pairId) ?? 0) - (tunnelInRot.get(pairId) ?? 0)) % 4 + 4) % 4;
    tunnels.push({ pairId, entrance, exit, rotDelta });
  }

  const ramps: RampPair[] = [];
  for (const [pairId, up] of rampUp) {
    const down = rampDown.get(pairId);
    if (!down) continue;
    ramps.push({ pairId, up, down });
  }

  return {
    name: hole.name ?? '',
    par: hole.par,
    w,
    h,
    cells,
    tee: { x: (hole.tee.x + 0.5) * CELL, y: (hole.tee.y + 0.5) * CELL },
    cup: { x: (hole.cup.x + 0.5) * CELL, y: (hole.cup.y + 0.5) * CELL },
    bars: [],
    walls,
    statics,
    movers,
    tunnels,
    ramps,
    tiles,
  };
}

/** Compile a full 9-hole CourseDataV1 into runtime HoleDefs. */
export function courseFromData(data: CourseDataV1): HoleDef[] {
  return data.holes.map(holeFromCourseData);
}

/** Par-relative label for a hole score ("Birdie", "+2", …). */
export function scoreLabel(strokes: number, par: number): string {
  if (strokes === 1) return 'Hole-in-one!';
  const d = strokes - par;
  if (d <= -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double bogey';
  return `+${d}`;
}

export function fmtMillis(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
