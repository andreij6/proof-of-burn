// ==========================================
// RenderKit — swappable mini-golf art layer (PB-303 A.6).
//
// Hard rule (A.6 separation contract): this module owns *visuals only*. It
// consumes the engine's canonical collision geometry (HoleDef + moverGeometry)
// and decides how things LOOK; it never recomputes physics or collision
// geometry, and the on-chain course_data never carries pixels/colours.
//
// Because art lives only here (shipped with the frontend), upgrading visuals is
// a pure client-side change: no CourseDataV1 version bump, no re-mint, no
// physics edit. `primitive-v1` is the first cut; a future `sprite-v2` (or a
// per-Theme art pack) drops in behind the same interface at a single swap point.
//
// Pure module: NO React, NO direct CanvasRenderingContext2D dependency. Drawing
// is routed through a tiny `Renderer` abstraction so a future kit could target a
// different backend (WebGL, an offscreen rasteriser, an SVG exporter for NFT
// thumbnails, …). MiniGolf.tsx (PB-309) adapts a real 2D context to `Renderer`
// and consumes this; this file does NOT import or wire into MiniGolf.tsx.
// ==========================================

import {
  CELL, BALL_R, CUP_R, POST_R, CellType,
  moverGeometry,
  type HoleDef, type Mover, type StaticObs, type WallSeg, type Vec,
} from './engine.ts';
import { ElementKind, type Theme } from './courseData.ts';

// ── Backend-agnostic drawing surface ──
// The minimal primitive set every kit needs. A real 2D context adapts to this
// in a few lines; a WebGL kit would implement the same calls differently.
export interface Renderer {
  save(): void;
  restore(): void;
  setFill(color: string): void;
  setStroke(color: string, width: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillCircle(cx: number, cy: number, r: number): void;
  strokeCircle(cx: number, cy: number, r: number): void;
  /** Stroke a polyline through the given world-px points. */
  strokeLine(points: Vec[]): void;
  /** Fill a convex polygon. */
  fillPoly(points: Vec[]): void;
}

// ── Views: derived from canonical engine state; the kit never recomputes them ──

/** What the kit needs to draw a single placed element. */
export interface ElementView {
  kind: ElementKind;
  /** Anchor cell centre in world px. */
  center: Vec;
  rot: 0 | 1 | 2 | 3;
  /** Wall segments (walls), present for WallStraight/Corner/Angled45/Curved. */
  walls?: WallSeg[];
  /** Static collider, present for Rock/Pillar/Bumper/Tree. */
  static?: StaticObs;
  /** Mover, present for Windmill/Pendulum/RotatingPaddle/SlidingBlock. */
  mover?: Mover;
}

export interface BallView {
  pos: Vec;
  /** Current speed (px/s) — kits may scale a motion trail by it. */
  speed: number;
}

// The kit interface from A.6.
export interface RenderKit {
  id: string;
  drawTerrain(ctx: Renderer, hole: HoleDef, theme: Theme): void;
  drawElement(ctx: Renderer, view: ElementView, theme: Theme, tSec: number): void;
  drawBall(ctx: Renderer, ball: BallView, theme: Theme): void;
}

// ── Theme → palette (a render concern only; no physics effect) ──

interface Palette {
  fairway: string;
  rough: string;
  sand: string;
  water: string;
  wall: string;
  accent: string;
}

const THEME_PALETTES: Record<string, Palette> = {
  desert: { fairway: '#7cae54', rough: '#5f8a40', sand: '#e6cf8b', water: '#3aa6d8', wall: '#8a6a44', accent: '#e8602c' },
  ocean: { fairway: '#4fae8c', rough: '#3a8a6c', sand: '#dcc98a', water: '#2d7ff0', wall: '#3f5a6a', accent: '#22b8c4' },
  space: { fairway: '#6a6f9b', rough: '#4a4f7b', sand: '#9b8fbf', water: '#7a3fd0', wall: '#2a2a3a', accent: '#9b59d0' },
  forest: { fairway: '#5fa54a', rough: '#3f7a30', sand: '#cdb87a', water: '#2d8fd0', wall: '#4a3a24', accent: '#27a05c' },
};

export function paletteFor(theme: Theme): Palette {
  if (theme.kind === 'custom') {
    return {
      fairway: theme.primary, rough: shade(theme.primary, -0.18), sand: '#e6cf8b',
      water: '#3aa6d8', wall: theme.secondary, accent: theme.secondary,
    };
  }
  return THEME_PALETTES[theme.kind] ?? THEME_PALETTES.forest;
}

/** Darken/lighten a #rrggbb hex by `amt` (−1..1). Pure helper, no DOM. */
function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 0xff) * (1 + amt));
  const g = clamp(((n >> 8) & 0xff) * (1 + amt));
  const b = clamp((n & 0xff) * (1 + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ── primitive-v1 — first-pass flat shapes drawn from canonical geometry ──

export const primitiveRenderKit: RenderKit = {
  id: 'primitive-v1',

  drawTerrain(ctx, hole, theme) {
    const pal = paletteFor(theme);
    ctx.save();
    for (let gy = 0; gy < hole.h; gy++) {
      for (let gx = 0; gx < hole.w; gx++) {
        const c = hole.cells[gy * hole.w + gx] as CellType;
        const color = terrainColor(c, pal);
        if (color === null) continue; // Void: not drawn
        ctx.setFill(color);
        ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
      }
    }
    // Cup + tee markers.
    ctx.setFill('#1a1a1a');
    ctx.fillCircle(hole.cup.x, hole.cup.y, CUP_R);
    ctx.setStroke(pal.accent, 2);
    ctx.strokeCircle(hole.tee.x, hole.tee.y, BALL_R + 3);
    ctx.restore();
  },

  drawElement(ctx, view, theme, tSec) {
    const pal = paletteFor(theme);
    ctx.save();
    if (view.walls) {
      ctx.setStroke(pal.wall, 6);
      for (const w of view.walls) ctx.strokeLine([{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]);
    }
    if (view.static) drawStatic(ctx, view.static, pal);
    if (view.mover) drawMover(ctx, view.mover, pal, tSec);
    drawSpecialMarker(ctx, view, pal);
    ctx.restore();
  },

  drawBall(ctx, ball) {
    ctx.save();
    ctx.setFill('#ffffff');
    ctx.fillCircle(ball.pos.x, ball.pos.y, BALL_R);
    ctx.setStroke('#cccccc', 1);
    ctx.strokeCircle(ball.pos.x, ball.pos.y, BALL_R);
    ctx.restore();
  },
};

function terrainColor(c: CellType, pal: Palette): string | null {
  switch (c) {
    case CellType.Void: return null;
    case CellType.Grass:
    case CellType.SlopeN:
    case CellType.SlopeS:
    case CellType.SlopeE:
    case CellType.SlopeW:
    case CellType.Post:
      return pal.fairway;
    case CellType.Rough: return pal.rough;
    case CellType.Sand: return pal.sand;
    case CellType.Water: return pal.water;
    case CellType.Wall: return pal.wall;
    default: return pal.fairway;
  }
}

function drawStatic(ctx: Renderer, s: StaticObs, pal: Palette): void {
  if (s.shape === 'box') {
    ctx.setFill(s.kind === 'tree' ? '#3f7a30' : '#7a7a7a');
    ctx.fillRect(s.x!, s.y!, s.w!, s.h!);
  } else if (s.kind === 'bumper') {
    ctx.setFill(pal.accent);
    ctx.fillCircle(s.cx!, s.cy!, s.r ?? POST_R);
  } else {
    // pillar
    ctx.setFill('#9a9a9a');
    ctx.fillCircle(s.cx!, s.cy!, s.r ?? POST_R);
  }
}

function drawMover(ctx: Renderer, m: Mover, pal: Palette, tSec: number): void {
  const g = moverGeometry(m, tSec); // canonical geometry — never recomputed here
  if (g.box) {
    ctx.setFill(pal.wall);
    ctx.fillRect(g.box.x, g.box.y, g.box.w, g.box.h);
  } else {
    ctx.setStroke(pal.wall, 8);
    ctx.strokeLine([{ x: g.seg.x1, y: g.seg.y1 }, { x: g.seg.x2, y: g.seg.y2 }]);
    // Pivot hub for rotating movers.
    ctx.setFill('#4a4a4a');
    ctx.fillCircle(m.pivot.x, m.pivot.y, 4);
  }
}

function drawSpecialMarker(ctx: Renderer, view: ElementView, pal: Palette): void {
  const { center, kind } = view;
  const r = CELL * 0.3;
  switch (kind) {
    case ElementKind.TunnelEntrance:
    case ElementKind.TunnelExit:
      ctx.setStroke(kind === ElementKind.TunnelEntrance ? '#2d7ff0' : '#e3b52e', 3);
      ctx.strokeCircle(center.x, center.y, r);
      break;
    case ElementKind.RampUp:
    case ElementKind.RampDown:
    case ElementKind.SpeedTile:
    case ElementKind.SlowTile:
      ctx.setFill(kind === ElementKind.SlowTile ? '#9b59d0' : pal.accent);
      ctx.fillPoly(arrowPoly(center, view.rot, r));
      break;
    default:
      break;
  }
}

/** A small arrow polygon pointing along `rot` (0=N,1=E,2=S,3=W). */
function arrowPoly(center: Vec, rot: number, r: number): Vec[] {
  const dirs: Vec[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
  const d = dirs[((rot % 4) + 4) % 4];
  const perp = { x: -d.y, y: d.x };
  const tip = { x: center.x + d.x * r, y: center.y + d.y * r };
  const baseL = { x: center.x - d.x * r + perp.x * r * 0.6, y: center.y - d.y * r + perp.y * r * 0.6 };
  const baseR = { x: center.x - d.x * r - perp.x * r * 0.6, y: center.y - d.y * r - perp.y * r * 0.6 };
  return [tip, baseL, baseR];
}

// ── Single swap point: which kit the play view / editor renders through ──
// A future sprite kit or per-Theme art pack is selected here (or via a feature
// flag) without touching data, physics, or already-minted NFTs.
export function activeRenderKit(_theme?: Theme): RenderKit {
  return primitiveRenderKit;
}
