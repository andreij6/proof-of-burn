// ==========================================
// Mini Golf — game engine (pure logic, no DOM)
// Voxel-tile edition: every hole is a 22×14 cell grid (each cell renders as
// a flat-shaded isometric cube). Slingshot putt, rolling-ball physics with
// wall cubes / sand / water / slopes / posts / a windmill bar, par-rated
// holes, 12-stroke pickup cap. Layouts are admin-editable: the backend
// stores per-hole overrides (same cell encoding) merged over these defaults.
// ==========================================

export interface Vec { x: number; y: number }
/** Rotating windmill bar centred on (cx, cy) in world px; angle = phase + speed·t. */
export interface MovingBar { cx: number; cy: number; len: number; speed: number; phase: number }

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
} as const;
export type CellType = typeof CellType[keyof typeof CellType];

export const WALKABLE: CellType[] = [CellType.Grass, CellType.SlopeN, CellType.SlopeS, CellType.SlopeE, CellType.SlopeW];

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
  event: 'wall' | 'water' | 'sunk' | 'capped' | null;
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
  if (hit) state.event = 'wall';

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

  // Friction (sand is much heavier).
  const f = cellAtWorld(def, state.pos) === CellType.Sand ? FRICTION_SAND : FRICTION_GREEN;
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
