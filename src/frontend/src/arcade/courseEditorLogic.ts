// ==========================================
// Course editor — pure logic (PB-302 frontend).
//
// Placement / selection / rotation / deletion / per-hole status glue, plus the
// client-side mint-gate validation breakdown. Extracted from CourseEditor so it
// is unit-testable without a canvas (frontend-dev "pure logic" rule). The
// component owns React state + canvas; this module owns the rules.
// ==========================================

import {
  type CourseDataV1, type Hole, type Element, type ElementKind, type ElementParams,
  type Theme, ElementKind as EK, LIMITS, validateCourseData,
} from './courseData';

export const DEFAULT_GRID_W = 22;
export const DEFAULT_GRID_H = 14;
export const DEFAULT_PAR = 3;

/** A fresh, empty 9-hole course (tee/cup default to opposite corners so a hole
 *  is structurally complete the instant it is created, then the user moves
 *  them). The tee/cup still need to be *placed* deliberately, so we mark holes
 *  "empty" until the user touches them — tracked separately in the component. */
export function emptyHole(): Hole {
  return {
    par: DEFAULT_PAR,
    gridW: DEFAULT_GRID_W,
    gridH: DEFAULT_GRID_H,
    tee: { x: 2, y: Math.floor(DEFAULT_GRID_H / 2) },
    cup: { x: DEFAULT_GRID_W - 3, y: Math.floor(DEFAULT_GRID_H / 2) },
    elements: [],
  };
}

export function emptyCourse(): CourseDataV1 {
  return {
    version: 1,
    theme: { kind: 'desert' },
    holes: Array.from({ length: LIMITS.HOLES }, emptyHole),
  };
}

// ── Per-hole status (Hole Panel chips) ──
export type HoleStatusKind = 'complete' | 'incomplete' | 'empty';

export interface HoleStatus {
  kind: HoleStatusKind;
  /** Human reason when incomplete/empty (rendered under the slot). */
  reason: string;
}

/**
 * A hole is "empty" when it has no placed elements AND the par/tee/cup are at
 * defaults the user hasn't touched (the component passes `touched`). A hole is
 * "complete" when tee + cup are in-grid and par ∈ 2..5. Otherwise "incomplete".
 */
export function holeStatus(h: Hole, touched: boolean): HoleStatus {
  const teeOk = inGrid(h.tee, h);
  const cupOk = inGrid(h.cup, h);
  const parOk = h.par >= LIMITS.PAR_MIN && h.par <= LIMITS.PAR_MAX;

  if (!touched && h.elements.length === 0) {
    return { kind: 'empty', reason: 'not started' };
  }
  if (!teeOk) return { kind: 'incomplete', reason: 'tee off the grid' };
  if (!cupOk) return { kind: 'incomplete', reason: 'cup off the grid' };
  if (!parOk) return { kind: 'incomplete', reason: 'set a par (2–5)' };
  return { kind: 'complete', reason: '' };
}

function inGrid(c: { x: number; y: number }, h: Hole): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < h.gridW && c.y < h.gridH;
}

// ── Validation breakdown for the Mint gate (A.5). Returns the list of unmet
//    checks; an empty array means Mint is enabled. ──
export interface MintGate {
  ok: boolean;
  /** Friendly reasons, suitable for a tooltip list. */
  reasons: string[];
  /** The stable code from validateCourseData (or null), for tests/telemetry. */
  code: string | null;
}

export function mintGate(course: CourseDataV1, name: string): MintGate {
  const reasons: string[] = [];

  const trimmed = name.trim();
  if (trimmed.length === 0) reasons.push('Course name is required');
  if (trimmed.length > 60) reasons.push('Course name must be ≤ 60 characters');

  course.holes.forEach((h, i) => {
    if (!inGrid(h.tee, h)) reasons.push(`Hole ${i + 1}: place a tee`);
    if (!inGrid(h.cup, h)) reasons.push(`Hole ${i + 1}: place a cup`);
    if (h.par < LIMITS.PAR_MIN || h.par > LIMITS.PAR_MAX) reasons.push(`Hole ${i + 1}: set a par (2–5)`);
    if (h.name !== undefined && h.name.length > LIMITS.NAME_LEN) {
      reasons.push(`Hole ${i + 1}: name must be ≤ ${LIMITS.NAME_LEN} characters`);
    }
  });

  // The structural validator (element bounds, pairs, blob size, …).
  const code = validateCourseData(course);
  if (code !== null && reasons.length === 0) {
    reasons.push(mapValidationCode(code));
  }

  return { ok: reasons.length === 0, reasons, code };
}

export function mapValidationCode(code: string): string {
  switch (code) {
    case 'INVALID_VERSION': return 'Unsupported course version';
    case 'WRONG_HOLE_COUNT': return 'A course must have exactly 9 holes';
    case 'INVALID_PAR': return 'Every hole needs a par between 2 and 5';
    case 'INVALID_GRID': return 'A hole grid is out of bounds';
    case 'NAME_TOO_LONG': return 'A hole name is too long';
    case 'OFF_GRID': return 'An element sits off the grid';
    case 'TOO_MANY_ELEMENTS': return 'Too many elements';
    case 'TOO_MANY_MOVERS': return 'Too many moving obstacles on a hole';
    case 'MULTIPLE_TEES': return 'A hole has more than one tee';
    case 'MULTIPLE_CUPS': return 'A hole has more than one cup';
    case 'UNBALANCED_TUNNELS': return 'Tunnels must be placed in entry/exit pairs';
    case 'TOO_MANY_TUNNELS': return 'Too many tunnel pairs on a hole';
    case 'UNBALANCED_RAMPS': return 'Ramps must be placed in up/down pairs';
    case 'TOO_MANY_RAMPS': return 'Too many ramp pairs on a hole';
    case 'BLOB_TOO_LARGE': return 'The course is too large — remove some elements';
    default: return code;
  }
}

export function parTotal(course: CourseDataV1): number {
  return course.holes.reduce((s, h) => s + h.par, 0);
}

// ── Placement helpers (snap, place, select, rotate, delete) ──

/** Default params for a freshly-armed palette element. Pairs/moving/tile/rock
 *  carry their structured params; everything else is `none`. */
export function defaultParams(kind: ElementKind, pairId = 0): ElementParams {
  switch (kind) {
    case EK.Rock: return { tag: 'rock', size: 1 };
    case EK.Windmill:
    case EK.Pendulum:
    case EK.RotatingPaddle:
      return { tag: 'moving', speed: 1, phase: 0 };
    case EK.SlidingBlock:
      return { tag: 'sliding', speed: 1, phase: 0, len: 3, axis: 0 };
    case EK.TunnelEntrance:
    case EK.TunnelExit:
    case EK.RampUp:
    case EK.RampDown:
      return { tag: 'pair', pairId };
    case EK.SpeedTile:
    case EK.SlowTile:
      return { tag: 'tile', strength: 1 };
    default:
      return { tag: 'none' };
  }
}

/** Index of an element placed at (x,y), or -1. */
export function elementAt(h: Hole, x: number, y: number): number {
  return h.elements.findIndex((e) => e.x === x && e.y === y);
}

/** Place (or replace) an element at the snapped cell; returns a new elements
 *  array. A new placement on an occupied cell replaces the existing element. */
export function placeElement(h: Hole, el: Element): Element[] {
  const idx = elementAt(h, el.x, el.y);
  const next = h.elements.slice();
  if (idx >= 0) next[idx] = el;
  else next.push(el);
  return next;
}

export function deleteElementAt(h: Hole, idx: number): Element[] {
  return h.elements.filter((_, i) => i !== idx);
}

/** Rotate an element 90° CW (0→1→2→3→0). */
export function rotateElement(e: Element): Element {
  return { ...e, rot: (((e.rot + 1) % 4) as 0 | 1 | 2 | 3) };
}

/** Clamp a cell to the hole grid. */
export function snapCell(x: number, y: number, h: Hole): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(h.gridW - 1, Math.round(x))),
    y: Math.max(0, Math.min(h.gridH - 1, Math.round(y))),
  };
}

// ── Theme helpers ──
export const THEME_KINDS: Theme['kind'][] = ['desert', 'ocean', 'space', 'forest', 'custom'];

export function themeDiscriminant(theme: Theme): number {
  return THEME_KINDS.indexOf(theme.kind);
}
