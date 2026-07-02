import { describe, it, expect } from 'vitest';
import {
  fitView, isoP, isoUn, ballSprite, WALL_Z, BALL_SPRITE_R,
} from '../arcade/holeRender';
import { CELL, BALL_R, CellType, type HoleDef, type Vec } from '../arcade/engine';

// ==========================================
// Pure camera/sprite math tests — no canvas. The ball-contact suite encodes
// the "ball visually sinks into the wall" bug: at PHYSICAL contact with a
// wall cube (centre BALL_R from the face), the drawn sprite circle may
// overlap the cube's projected silhouette by at most ~2.5 px.
// ==========================================

function mkDef(w: number, h: number): HoleDef {
  return {
    name: 'test', par: 3, w, h,
    cells: new Uint8Array(w * h).fill(CellType.Grass),
    tee: { x: CELL * 1.5, y: CELL * 1.5 },
    cup: { x: (w - 1.5) * CELL, y: (h - 1.5) * CELL },
    bars: [],
  };
}

// ── Point → convex-ish polygon distance (screen space) ──

function pointInPoly(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToPolyEdge(p: Vec, poly: Vec[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

/** Penetration of a circle {c, r} into a polygon silhouette (px). */
function penetration(c: Vec, r: number, poly: Vec[]): number {
  const edge = distToPolyEdge(c, poly);
  return pointInPoly(c, poly) ? r + edge : Math.max(0, r - edge);
}

/** Projected silhouette hexagon of a wall cube on cell (gx,gy). */
function cubeSilhouette(view: ReturnType<typeof fitView>, gx: number, gy: number): Vec[] {
  const x0 = gx * CELL, y0 = gy * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
  return [
    isoP(view, x0, y0, WALL_Z), // top-back corner
    isoP(view, x1, y0, WALL_Z), // top-right
    isoP(view, x1, y0, 0),      // right ground
    isoP(view, x1, y1, 0),      // bottom ground
    isoP(view, x0, y1, 0),      // left ground
    isoP(view, x0, y1, WALL_Z), // top-left
  ];
}

describe('fitView', () => {
  it.each([[8, 8], [22, 14], [40, 40]])('fits a %i×%i grid inside the canvas with margin', (w, h) => {
    const def = mkDef(w, h);
    const W = 860, H = 510, m = 24;
    const view = fitView(def, W, H, m);
    // Every extreme of the projected grid volume must respect the margin.
    const corners: Vec[] = [];
    for (const z of [0, WALL_Z + 95]) {
      corners.push(
        isoP(view, 0, 0, z), isoP(view, w * CELL, 0, z),
        isoP(view, 0, h * CELL, z), isoP(view, w * CELL, h * CELL, z),
      );
    }
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(m - 1e-6);
      expect(c.x).toBeLessThanOrEqual(W - m + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(m - 1e-6);
      expect(c.y).toBeLessThanOrEqual(H - m + 1e-6);
    }
  });

  it('keeps the classic 22×14 framing near the original 0.55 zoom', () => {
    const view = fitView(mkDef(22, 14), 860, 510);
    expect(view.scale).toBeGreaterThan(0.5);
    expect(view.scale).toBeLessThan(0.6);
  });
});

describe('isoUn ∘ isoP', () => {
  it('round-trips ground-plane points', () => {
    const view = fitView(mkDef(22, 14), 860, 510);
    for (const p of [{ x: 0, y: 0 }, { x: 313, y: 77 }, { x: 22 * CELL, y: 14 * CELL }]) {
      const s = isoP(view, p.x, p.y, 0);
      const back = isoUn(view, s.x, s.y);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe('ball sprite vs wall-cube silhouette at physical contact', () => {
  const def = mkDef(22, 14);
  const view = fitView(def, 860, 510);
  const gx = 10, gy = 6; // wall cube cell
  const x0 = gx * CELL, y0 = gy * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
  const mid = { x: x0 + CELL / 2, y: y0 + CELL / 2 };

  // Ball centre exactly BALL_R from each face (physical contact).
  // The renderer depth-sorts by world x+y: the cube's key is the far corner
  // (gx+1+gy+1)·CELL. Approaches from the south/east put the ball IN FRONT of
  // the cube (ball drawn last) — any silhouette overlap is visible
  // penetration, the reported bug. From the north/west the ball is BEHIND the
  // cube, which is drawn over it — real occlusion, so the requirement there
  // is the draw order itself.
  const cubeKey = (gx + 1 + gy + 1) * CELL;

  it('south approach (ball in front of the cube) overlaps the silhouette by ≤ 2.5 px', () => {
    // Contact toward the east end of the south face: depth key x+y exceeds
    // the cube's, so the ball is drawn ON TOP of the wall faces — the exact
    // configuration where the old oversized sprite showed "ball halfway into
    // the wall". (At face-centre the key is lower and the cube repaints the
    // sliver, like the east case below.)
    const pos = { x: x1 - 2, y: y1 + BALL_R };
    expect(pos.x + pos.y).toBeGreaterThan(cubeKey); // ball drawn after cube
    const sprite = ballSprite(view, pos);
    const hex = cubeSilhouette(view, gx, gy);
    expect(pointInPoly({ x: sprite.x, y: sprite.y }, hex)).toBe(false);
    expect(penetration({ x: sprite.x, y: sprite.y }, sprite.r, hex)).toBeLessThanOrEqual(2.5);
  });

  it('east approach sits outside the silhouette (≤ 2.5 px) and the cube clips the sliver', () => {
    const pos = { x: x1 + BALL_R, y: mid.y };
    const sprite = ballSprite(view, pos);
    const hex = cubeSilhouette(view, gx, gy);
    expect(pointInPoly({ x: sprite.x, y: sprite.y }, hex)).toBe(false);
    expect(penetration({ x: sprite.x, y: sprite.y }, sprite.r, hex)).toBeLessThanOrEqual(2.5);
    expect(pos.x + pos.y).toBeLessThan(cubeKey); // cube repaints any overlap
  });

  it.each([
    ['north', { x: mid.x, y: y0 - BALL_R }],
    ['west', { x: x0 - BALL_R, y: mid.y }],
  ] as [string, Vec][])('%s approach (ball behind) is occluded by the cube, not overlapping it', (_name, pos) => {
    // Cube drawn after the ball ⇒ the wall covers the contact — no visible
    // penetration is possible from this side.
    expect(pos.x + pos.y).toBeLessThan(cubeKey);
  });

  it('still reads as a ball at the classic fit-zoom (radius ≥ 4.5 px)', () => {
    const sprite = ballSprite(view, mid);
    expect(sprite.r).toBeGreaterThanOrEqual(4.5);
    expect(sprite.r).toBe(BALL_SPRITE_R * view.scale);
  });
});
