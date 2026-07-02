// ==========================================
// Mini Golf — isometric voxel scene renderer (extracted from MiniGolf.tsx).
//
// Draws one hole (ground, cup, walls/posts/windmill bars depth-sorted, flag,
// optional ball + golfer) through an explicit camera (`IsoView`), so the same
// scene code serves the game canvas, the course-overview thumbnails, and the
// pan/zoom spectate mode. `fitView` frames ANY grid size — user-built courses
// go up to 40×40 cells, which the old fixed K/OX/OY framing overflowed.
//
// All z heights are WORLD units (scaled by the view), unlike the old renderer
// where z was raw screen px. The ball sprite is sized to its PHYSICAL
// footprint (see BALL_SPRITE_R below) so it no longer visually buries itself
// in wall cubes at contact.
// ==========================================

import {
  CELL, CUP_R, POST_R, cellAt, cellAtWorld, barSegments, CellType,
  HAIR_COLORS, SKIN_COLORS, OUTFIT_COLORS,
  type CharacterLook, type HoleDef, type MovingBar, type Vec,
} from './engine';

/** Camera: screen = isoBase(world) · scale + (ox, oy). */
export interface IsoView { scale: number; ox: number; oy: number }

/** Wall cube height (world units — ≈10 screen px at the classic 0.55 zoom). */
export const WALL_Z = 18;
/** Elevated-plateau height (world units) — clearly lower than a wall cube, so
 *  walls still read as impassable while plateaus read as high ground. */
export const ELEV_Z = 8;
/** Flag pole top (world units — ≈52 screen px at the classic zoom). */
export const FLAG_Z = 95;
/**
 * Ball sprite: drawn radius (world units) and z-lift. Physics radius is
 * BALL_R=7 but a screen circle of 7 px is ~2–4× the projected footprint of a
 * 7-world-px offset, which made the ball visually sink halfway into wall
 * cubes at contact. 9 world units at z=0 keeps the silhouette overlap at a
 * wall face ≤ ~2 px from every approach while still reading as a ball
 * (holeRender.test.ts asserts both bounds).
 */
export const BALL_SPRITE_R = 9;
export const BALL_SPRITE_Z = 0;

/** The zoom the classic fixed-camera renderer used — sprite work (golfer,
 *  line widths) is authored at this scale and scaled by view.scale/REF_SCALE. */
const REF_SCALE = 0.55;

// Flat-shaded voxel palette (saturated, vector-style).
const PAL = {
  grassA: '#3ec46a', grassB: '#36b860',
  belt: '#2da455', beltStripe: 'rgba(255,255,255,0.32)', beltRail: 'rgba(10,25,14,0.25)',
  sand: '#efd98a', sandDot: '#c9ad55',
  water: '#3f9bee', waterHi: '#7fc0f6',
  wallTop: '#e0b667', wallL: '#b58a45', wallR: '#8a672e',
  postTop: '#d9a85b', postSide: '#9a743a',
  // Elevated plateau: sunnier grass top, earthy cut-away side faces.
  elevA: '#5fd489', elevB: '#55ca7f', elevL: '#37905c', elevR: '#2a7449',
  // Tunnel mouth: deep-indigo void with a violet rim + swirl.
  tunnelRim: '#6d4fc4', tunnelVoid: '#140b28', tunnelSwirl: '167, 139, 250',
  shadow: 'rgba(10, 25, 14, 0.22)',
};

/** Rotor blade accents keyed by arm count, so 2/3/4-arm mills are readable at
 *  a glance: 2 = the classic rust bar, 3 = teal tri-rotor, 4 = violet cross. */
export const ROTOR_PALETTES: Record<number, { top: string; left: string; right: string; tip: string }> = {
  2: { top: '#d77b45', left: '#a3522a', right: '#7e3d1d', tip: '#f2b27a' },
  3: { top: '#3fb8af', left: '#2a8b84', right: '#1e6b66', tip: '#8fe3dc' },
  4: { top: '#9b6fe0', left: '#7448b8', right: '#573391', tip: '#c9aef2' },
};
export function rotorPalette(arms: number): (typeof ROTOR_PALETTES)[number] {
  return ROTOR_PALETTES[arms] ?? ROTOR_PALETTES[2];
}

/** Blade cross-section vs normalized distance from the hub (0 = hub, 1 = tip):
 *  blades taper in width AND height so each arm reads as a real rotor blade. */
export function bladeProfile(dn: number): { half: number; zTop: number } {
  return { half: 8.5 - 3.5 * dn, zTop: 20 - 4 * dn };
}

// Conveyor (slope) belt animation: stripe spacing (world px) and travel speed
// (world px/s) in the push direction.
const BELT_SPACING = 10;
const BELT_SPEED = 55;

/** World → screen. z is in world units (scaled like x/y). */
export function isoP(view: IsoView, x: number, y: number, z: number): Vec {
  return {
    x: (x - y) * view.scale + view.ox,
    y: ((x + y) * 0.5 - z) * view.scale + view.oy,
  };
}

/** Screen → world on the z=0 ground plane. */
export function isoUn(view: IsoView, sx: number, sy: number): Vec {
  const a = (sx - view.ox) / view.scale;       // x − y
  const b = ((sy - view.oy) / view.scale) * 2; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Fit the whole hole (grid + wall/flag headroom) centered in width×height. */
export function fitView(def: HoleDef, width: number, height: number, margin = 24): IsoView {
  const wx = def.w * CELL, wy = def.h * CELL;
  const zTop = WALL_Z + FLAG_Z;
  // Unscaled projected bounding box of the grid volume.
  const bxMin = -wy, bxMax = wx;
  const byMin = -zTop, byMax = (wx + wy) * 0.5;
  const scale = Math.min(
    (width - 2 * margin) / (bxMax - bxMin),
    (height - 2 * margin) / (byMax - byMin),
  );
  return {
    scale,
    ox: width / 2 - ((bxMin + bxMax) / 2) * scale,
    oy: height / 2 - ((byMin + byMax) / 2) * scale,
  };
}

/** Screen circle the ball is drawn as (also consumed by the contact tests).
 *  `lift` raises the sprite in world units — ELEV_Z when riding a plateau. */
export function ballSprite(view: IsoView, pos: Vec, lift = 0): { x: number; y: number; r: number } {
  const p = isoP(view, pos.x, pos.y, BALL_SPRITE_Z + lift);
  return { x: p.x, y: p.y, r: BALL_SPRITE_R * view.scale };
}

export interface SceneOpts {
  tSec: number;                                   // animates windmills/water/conveyors
  ball?: Vec | null;                              // null/undefined = no ball (spectate/thumbnail)
  golfer?: { stand: Vec; look: CharacterLook; aiming: boolean } | null;
  backdrop?: boolean;                             // default true: gradient bg fill
}

export function renderHoleScene(ctx: CanvasRenderingContext2D, def: HoleDef, view: IsoView, opts: SceneOpts): void {
  const { tSec } = opts;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (opts.backdrop !== false) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#15201a');
    bg.addColorStop(1, '#0c120e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Ground pass (painter's order: diagonals of gx+gy) ──
  for (let s = 0; s <= def.w + def.h - 2; s++) {
    for (let gx = Math.max(0, s - def.h + 1); gx <= Math.min(def.w - 1, s); gx++) {
      drawGroundCell(ctx, def, view, gx, s - gx, tSec);
    }
  }

  drawCup(ctx, def, view);

  // Tunnel mouths: flat on the ground (under the ball), one per endpoint —
  // the pair is bidirectional so both mouths look identical.
  if (def.tunnels) {
    for (const tp of def.tunnels) {
      drawTunnelMouth(ctx, view, tp.entrance, tSec);
      drawTunnelMouth(ctx, view, tp.exit, tSec);
    }
  }

  // ── Raised pass: everything with height, depth-sorted by world x+y ──
  const items: { key: number; draw: () => void }[] = [];
  for (let gy = 0; gy < def.h; gy++) {
    for (let gx = 0; gx < def.w; gx++) {
      const c = cellAt(def, gx, gy);
      if (c === CellType.Wall) {
        items.push({ key: (gx + 1 + gy + 1) * CELL, draw: () => drawCube(ctx, view, gx, gy, WALL_Z, PAL.wallTop, PAL.wallL, PAL.wallR) });
      } else if (c === CellType.Post) {
        const px = (gx + 0.5) * CELL, py = (gy + 0.5) * CELL;
        items.push({ key: px + py, draw: () => drawPrism(ctx, view, px, py, POST_R, 0, WALL_Z + 2, PAL.postTop, PAL.postSide, PAL.postSide) });
      } else if (c === CellType.Elevated) {
        items.push({ key: (gx + 1 + gy + 1) * CELL, draw: () => drawPlateau(ctx, view, def, gx, gy) });
      }
    }
  }
  // Windmill rotors: voxel hub + tapered blades built from barSegments.
  for (const bar of def.bars) {
    pushRotor(items, ctx, view, bar, tSec);
  }
  items.push({ key: def.cup.x + def.cup.y, draw: () => drawFlag(ctx, def, view, tSec) });
  const ball = opts.ball;
  if (ball) {
    // On a plateau the ball rides the top (lifted sprite + shadow) and must
    // sort after its own plateau block (whose key is the cell's far corner).
    const lifted = cellAtWorld(def, ball) === CellType.Elevated;
    items.push({
      key: ball.x + ball.y + (lifted ? 2 * CELL : 0),
      draw: () => drawBall(ctx, view, ball, lifted ? ELEV_Z : 0),
    });
  }
  const golfer = opts.golfer;
  if (golfer) {
    const gLifted = cellAtWorld(def, golfer.stand) === CellType.Elevated;
    items.push({
      key: golfer.stand.x + golfer.stand.y + (gLifted ? 2 * CELL : 0),
      draw: () => drawGolfer(ctx, view, golfer.stand, golfer.look, tSec, golfer.aiming, gLifted ? ELEV_Z : 0),
    });
  }
  items.sort((a, b) => a.key - b.key);
  for (const it of items) it.draw();
}

// ── Primitives ──

function poly(ctx: CanvasRenderingContext2D, pts: Vec[], fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
}

/** The four iso ground corners of one cell: [top, right, bottom, left]. */
function cellCorners(view: IsoView, gx: number, gy: number, z = 0): Vec[] {
  const x0 = gx * CELL, y0 = gy * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
  return [isoP(view, x0, y0, z), isoP(view, x1, y0, z), isoP(view, x1, y1, z), isoP(view, x0, y1, z)];
}

/** Flat-shaded voxel cube on cell (gx,gy): top + the two camera-facing sides. */
function drawCube(ctx: CanvasRenderingContext2D, view: IsoView, gx: number, gy: number, z: number, top: string, left: string, right: string) {
  const g = cellCorners(view, gx, gy, 0);
  const t = cellCorners(view, gx, gy, z);
  poly(ctx, [t[3], t[2], g[2], g[3]], left);   // SW face
  poly(ctx, [t[1], t[2], g[2], g[1]], right);  // SE face
  poly(ctx, t, top);
}

/** Small free-standing prism (windmill segment, post body). */
function drawPrism(ctx: CanvasRenderingContext2D, view: IsoView, cx: number, cy: number, half: number, z0: number, z1: number, top: string, left: string, right: string) {
  const c = (z: number) => [
    isoP(view, cx - half, cy - half, z), isoP(view, cx + half, cy - half, z),
    isoP(view, cx + half, cy + half, z), isoP(view, cx - half, cy + half, z),
  ];
  const g = c(z0), t = c(z1);
  poly(ctx, [t[3], t[2], g[2], g[3]], left);
  poly(ctx, [t[1], t[2], g[2], g[1]], right);
  poly(ctx, t, top);
}

/** Push direction (unit, world) of a conveyor cell, or null for other cells. */
function beltDir(c: CellType): Vec | null {
  switch (c) {
    case CellType.SlopeN: return { x: 0, y: -1 };
    case CellType.SlopeS: return { x: 0, y: 1 };
    case CellType.SlopeE: return { x: 1, y: 0 };
    case CellType.SlopeW: return { x: -1, y: 0 };
    default: return null;
  }
}

/** Raised blocks (wall cubes / elevated plateaus) cast the baked NW shadow. */
function castsShadow(c: CellType): boolean {
  return c === CellType.Wall || c === CellType.Elevated;
}

function drawGroundCell(ctx: CanvasRenderingContext2D, def: HoleDef, view: IsoView, gx: number, gy: number, tSec: number) {
  const c = cellAt(def, gx, gy);
  // Walls + plateaus are drawn as raised blocks in the raised pass.
  if (c === CellType.Void || c === CellType.Wall || c === CellType.Elevated) return;
  const corners = cellCorners(view, gx, gy, 0);
  const k = view.scale / REF_SCALE; // line-width / detail scale
  const belt = beltDir(c);

  let fill: string;
  switch (c) {
    case CellType.Sand: fill = PAL.sand; break;
    case CellType.Water: fill = PAL.water; break;
    default: fill = belt ? PAL.belt : (gx + gy) % 2 === 0 ? PAL.grassA : PAL.grassB;
  }
  poly(ctx, corners, fill);

  // Sharp baked shadows: light from the NW casts onto cells whose N or W
  // neighbour is a raised block (wall cube or elevated plateau).
  const center = isoP(view, (gx + 0.5) * CELL, (gy + 0.5) * CELL, 0);
  if (castsShadow(cellAt(def, gx, gy - 1))) {
    poly(ctx, [corners[0], corners[1], center], PAL.shadow);
  }
  if (castsShadow(cellAt(def, gx - 1, gy))) {
    poly(ctx, [corners[0], corners[3], center], PAL.shadow);
  }

  // Per-type detail.
  if (c === CellType.Sand) {
    ctx.fillStyle = PAL.sandDot;
    for (let i = 0; i < 3; i++) {
      const dx = ((gx * 7 + gy * 13 + i * 11) % 10) / 10;
      const dy = ((gx * 17 + gy * 5 + i * 7) % 10) / 10;
      const p = isoP(view, (gx + 0.2 + dx * 0.6) * CELL, (gy + 0.2 + dy * 0.6) * CELL, 0);
      ctx.fillRect(p.x, p.y, 2.4 * k, 1.4 * k);
    }
  } else if (c === CellType.Water) {
    // Animated highlight stripe.
    const shift = (Math.sin(tSec * 1.6 + gx * 0.9 + gy * 0.7) + 1) / 2;
    const p1 = isoP(view, (gx + 0.15 + shift * 0.2) * CELL, (gy + 0.5) * CELL, 0);
    const p2 = isoP(view, (gx + 0.55 + shift * 0.2) * CELL, (gy + 0.5) * CELL, 0);
    ctx.strokeStyle = PAL.waterHi;
    ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  } else if (belt) {
    drawBeltCell(ctx, view, gx, gy, belt, tSec, k);
  }
}

/**
 * Conveyor cell: transverse stripes (perpendicular to the push direction)
 * translating along it — a flat moving walkway. Stripe positions come from a
 * GLOBAL world grid (`dot(p, dir) ≡ phase (mod spacing)`), so adjacent cells
 * pushing the same way read as one continuous belt with no seams.
 */
function drawBeltCell(ctx: CanvasRenderingContext2D, view: IsoView, gx: number, gy: number, dir: Vec, tSec: number, k: number) {
  const x0 = gx * CELL, y0 = gy * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
  const phase = ((tSec * BELT_SPEED) % BELT_SPACING + BELT_SPACING) % BELT_SPACING;

  // The cell's range of u = dot(p, dir) (dir is axis-aligned).
  const uA = x0 * dir.x + y0 * dir.y;
  const uB = x1 * dir.x + y1 * dir.y;
  const u0 = Math.min(uA, uB), u1 = Math.max(uA, uB);

  ctx.strokeStyle = PAL.beltStripe;
  ctx.lineWidth = 2 * k;
  for (let u = Math.ceil((u0 - phase) / BELT_SPACING) * BELT_SPACING + phase; u <= u1; u += BELT_SPACING) {
    // Points with dot(p,dir)=u, spanning the cell perpendicular to dir.
    let a: Vec, b: Vec;
    if (dir.x === 0) {
      const y = u * dir.y; // dir.y = ±1
      a = { x: x0, y }; b = { x: x1, y };
    } else {
      const x = u * dir.x;
      a = { x, y: y0 }; b = { x, y: y1 };
    }
    const pa = isoP(view, a.x, a.y, 0.5), pb = isoP(view, b.x, b.y, 0.5);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  // Side rails along the direction of travel, for the treadmill read.
  ctx.strokeStyle = PAL.beltRail;
  ctx.lineWidth = 2 * k;
  const rails: [Vec, Vec][] = dir.x === 0
    ? [[{ x: x0 + 2, y: y0 }, { x: x0 + 2, y: y1 }], [{ x: x1 - 2, y: y0 }, { x: x1 - 2, y: y1 }]]
    : [[{ x: x0, y: y0 + 2 }, { x: x1, y: y0 + 2 }], [{ x: x0, y: y1 - 2 }, { x: x1, y: y1 - 2 }]];
  for (const [a, b] of rails) {
    const pa = isoP(view, a.x, a.y, 0.5), pb = isoP(view, b.x, b.y, 0.5);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }
}

/**
 * Elevated plateau block: sunny grass top at ELEV_Z with cut-away side faces.
 * Side faces are drawn only on edges whose neighbour is NOT elevated, so a
 * run of elevated cells reads as ONE plateau with no internal seams.
 */
function drawPlateau(ctx: CanvasRenderingContext2D, view: IsoView, def: HoleDef, gx: number, gy: number) {
  const g = cellCorners(view, gx, gy, 0);
  const t = cellCorners(view, gx, gy, ELEV_Z);
  if (cellAt(def, gx, gy + 1) !== CellType.Elevated) {
    poly(ctx, [t[3], t[2], g[2], g[3]], PAL.elevL); // south face
  }
  if (cellAt(def, gx + 1, gy) !== CellType.Elevated) {
    poly(ctx, [t[1], t[2], g[2], g[1]], PAL.elevR); // east face
  }
  poly(ctx, t, (gx + gy) % 2 === 0 ? PAL.elevA : PAL.elevB);
}

/**
 * Tunnel mouth: a deep-indigo void with a violet rim, a slow rotating swirl
 * and a breathing glow — unmistakably "a hole that takes you somewhere", never
 * confusable with the cup (which is white-ringed black). Flat on the ground.
 */
function drawTunnelMouth(ctx: CanvasRenderingContext2D, view: IsoView, pos: Vec, tSec: number) {
  const p = isoP(view, pos.x, pos.y, 0);
  const s = view.scale;
  const k = view.scale / REF_SCALE;
  const R = 16; // world units ≈ the engine's TUNNEL_R capture radius
  const pulse = 0.5 + 0.5 * Math.sin(tSec * 2.4 + (pos.x + pos.y) * 0.01);

  // Violet rim (glow breathes), then the void.
  ctx.fillStyle = PAL.tunnelRim;
  ctx.globalAlpha = 0.75 + 0.25 * pulse;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, R * s * 1.8, R * s * 1.0, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = PAL.tunnelVoid;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, R * s * 1.45, R * s * 0.8, 0, 0, Math.PI * 2); ctx.fill();

  // Slow swirl: two opposed arcs spiralling inward, driven by tSec.
  ctx.strokeStyle = `rgba(${PAL.tunnelSwirl}, ${0.35 + 0.4 * pulse})`;
  ctx.lineWidth = 1.6 * k;
  for (let i = 0; i < 2; i++) {
    const a0 = tSec * 1.5 + i * Math.PI;
    const rr = 0.95 - i * 0.35;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, R * s * rr, R * s * rr * 0.55, 0, a0, a0 + 1.8);
    ctx.stroke();
  }
}

/**
 * Windmill rotor: a steel voxel hub with a colored cap, and per barSegments
 * segment a tapered blade of stacked mini-prisms with a lighter tip block —
 * plus a soft swept shadow on the ground beneath each blade sample. Blade
 * accents come from rotorPalette(arms) so arm count is readable at a glance.
 */
function pushRotor(
  items: { key: number; draw: () => void }[],
  ctx: CanvasRenderingContext2D,
  view: IsoView,
  bar: MovingBar,
  tSec: number,
) {
  const arms = bar.arms ?? 2;
  const pal = rotorPalette(arms);
  const fullBar = arms <= 2;

  items.push({
    key: bar.cx + bar.cy,
    draw: () => {
      drawPrism(ctx, view, bar.cx, bar.cy, 7, 0, 24, '#4a4038', '#332b25', '#241e1a');
      drawPrism(ctx, view, bar.cx, bar.cy, 3.5, 24, 27, pal.tip, pal.left, pal.right); // colored cap
    },
  });

  for (const seg of barSegments(bar, tSec)) {
    const n = fullBar ? 6 : 4; // samples per segment (full bar spans tip-to-tip)
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n; // sample centres, so blades never bury the hub
      const x = seg.x1 + (seg.x2 - seg.x1) * t;
      const y = seg.y1 + (seg.y2 - seg.y1) * t;
      const dn = fullBar ? Math.abs(t - 0.5) * 2 : t; // 0 at hub → 1 at tip
      const { half, zTop } = bladeProfile(dn);
      const isTip = dn >= 0.7;
      items.push({
        key: x + y,
        draw: () => {
          const sp = isoP(view, x, y, 0);
          ctx.fillStyle = 'rgba(10, 25, 14, 0.10)';
          ctx.beginPath();
          ctx.ellipse(sp.x, sp.y, half * 1.9 * view.scale, half * 0.95 * view.scale, 0, 0, Math.PI * 2);
          ctx.fill();
          drawPrism(ctx, view, x, y, half, 3, zTop, isTip ? pal.tip : pal.top, pal.left, pal.right);
        },
      });
    }
  }
}

function drawCup(ctx: CanvasRenderingContext2D, def: HoleDef, view: IsoView) {
  const p = isoP(view, def.cup.x, def.cup.y, 0);
  const s = view.scale;
  ctx.fillStyle = '#f2efe6';
  ctx.beginPath(); ctx.ellipse(p.x, p.y, CUP_R * s * 1.7, CUP_R * s * 0.95, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0c0a08';
  ctx.beginPath(); ctx.ellipse(p.x, p.y, CUP_R * s * 1.45, CUP_R * s * 0.78, 0, 0, Math.PI * 2); ctx.fill();
}

function drawFlag(ctx: CanvasRenderingContext2D, def: HoleDef, view: IsoView, tSec: number) {
  const k = view.scale / REF_SCALE;
  const base = isoP(view, def.cup.x, def.cup.y, 0);
  const top = isoP(view, def.cup.x, def.cup.y, FLAG_Z);
  ctx.strokeStyle = '#e8e4dc';
  ctx.lineWidth = 2 * k;
  ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
  const wave = Math.sin(tSec * 3) * 2 * k;
  ctx.fillStyle = '#e8602c';
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(top.x + 24 * k, top.y + 6 * k + wave);
  ctx.lineTo(top.x, top.y + 13 * k);
  ctx.closePath();
  ctx.fill();
}

function drawBall(ctx: CanvasRenderingContext2D, view: IsoView, pos: Vec, lift = 0) {
  const { x, y, r } = ballSprite(view, pos, lift);
  // Contact shadow sits on whatever the ball rides — the plateau top when lifted.
  const sh = isoP(view, pos.x, pos.y, lift);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(sh.x, sh.y + r * 0.35, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.45, r * 0.15, x, y, r + 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#b9b4a8');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/** Voxel mini-figure: stacked flat-shaded blocks, customizable palette.
 *  Authored at REF_SCALE screen pixels; scaled to the view via a transform. */
function drawGolfer(ctx: CanvasRenderingContext2D, view: IsoView, stand: Vec, look: CharacterLook, tSec: number, aiming: boolean, lift = 0) {
  const skin = SKIN_COLORS[look.skin] ?? SKIN_COLORS[0];
  const hair = HAIR_COLORS[look.hair] ?? HAIR_COLORS[0];
  const outfit = OUTFIT_COLORS[look.outfit] ?? OUTFIT_COLORS[0];
  const pants = shade(outfit, -60);
  const outfitDark = shade(outfit, -28);

  const base = isoP(view, stand.x, stand.y, lift);
  const bob = aiming ? 0 : Math.sin(tSec * 2.2) * 1.2;

  ctx.save();
  ctx.translate(base.x, base.y);
  const k = view.scale / REF_SCALE;
  ctx.scale(k, k);

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(0, 0, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();

  const x = 0, y0 = bob;
  // Legs (two voxel columns).
  ctx.fillStyle = pants;
  ctx.fillRect(x - 6, y0 - 14, 5, 14);
  ctx.fillRect(x + 1, y0 - 14, 5, 14);
  ctx.fillStyle = '#26211c';
  ctx.fillRect(x - 7, y0 - 2.6, 6.5, 3);
  ctx.fillRect(x + 0.5, y0 - 2.6, 6.5, 3);
  // Torso block: front face + a darker side sliver for the voxel read.
  ctx.fillStyle = outfit;
  ctx.fillRect(x - 8, y0 - 32, 14, 18);
  ctx.fillStyle = outfitDark;
  ctx.fillRect(x + 6, y0 - 32, 3, 18);
  // Arms + putter.
  ctx.strokeStyle = skin;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - 6, y0 - 27); ctx.lineTo(x + 9, y0 - 18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 5, y0 - 27); ctx.lineTo(x + 9, y0 - 18); ctx.stroke();
  ctx.strokeStyle = '#9b9b9b';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 9, y0 - 18); ctx.lineTo(x + 14, y0 - 1); ctx.stroke();
  ctx.fillStyle = '#6f6f6f';
  ctx.fillRect(x + 12, y0 - 2, 6, 3.4);
  // Head block + hair slab.
  ctx.fillStyle = skin;
  ctx.fillRect(x - 6, y0 - 45, 12, 12);
  ctx.fillStyle = shade(skin, -26);
  ctx.fillRect(x + 4, y0 - 45, 2, 12);
  ctx.fillStyle = hair;
  ctx.fillRect(x - 7, y0 - 48, 14, 5);
  ctx.fillRect(x - 7, y0 - 45, 3, 6);

  ctx.restore();
}

function shade(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + delta));
  const gr = Math.max(0, Math.min(255, ((n >> 8) & 255) + delta));
  const b = Math.max(0, Math.min(255, (n & 255) + delta));
  return `#${((r << 16) | (gr << 8) | b).toString(16).padStart(6, '0')}`;
}
