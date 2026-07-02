// ==========================================
// Course build instructions — the JSON document stored in a course NFT's
// `course_data` blob. Instead of pre-compiled geometry, the NFT carries
// human/AI-readable *instructions* (ASCII hole layouts + par + windmills)
// that the app compiles into playable holes at load time. Courses are
// authored by an AI course builder (with the user's input), not hand-drawn
// in an editor, so this format is optimized for being easy to generate and
// audit: one character per terrain cell, one string per row.
//
// `decodeCourseBlob` is the single entry point the Play flow uses: it tries
// this JSON format first and falls back to the legacy CBOR CourseDataV1
// blobs (PB-303) so previously minted courses keep loading.
// ==========================================

import { CELL, CellType, courseFromData, type HoleDef, type MovingBar, type Vec } from './engine';
import { decodeCourseData } from './courseData';

export const COURSE_INSTRUCTIONS_FORMAT = 'proof-of-burn/minigolf-course@1';

export interface InstructionWindmill {
  /** Pivot in cell units (fractions allowed). */
  x: number;
  y: number;
  /** Full arm length in cells. */
  lengthCells: number;
  /** Angular velocity, rad/s (negative = counter-clockwise). */
  speed: number;
}

export interface InstructionHole {
  name?: string;
  par: number; // 2..=5
  /** ASCII terrain grid — equal-length rows, exactly one 'T' and one 'C'. */
  layout: string[];
  windmills?: InstructionWindmill[];
}

export interface CourseInstructions {
  format: string;
  name: string;
  description?: string;
  /** Free-form authoring guidance (legend etc.) — carried in the NFT, not executed. */
  instructions?: unknown;
  holes: InstructionHole[]; // exactly 9
}

// One character per terrain cell. 'T'/'C' sit on green; posts sit on green too.
const CHAR_TO_CELL: Record<string, CellType> = {
  '.': CellType.Void,
  '#': CellType.Wall,
  g: CellType.Grass,
  r: CellType.Rough,
  s: CellType.Sand,
  w: CellType.Water,
  '^': CellType.SlopeN,
  v: CellType.SlopeS,
  '>': CellType.SlopeE,
  '<': CellType.SlopeW,
  o: CellType.Post,
  T: CellType.Grass,
  C: CellType.Grass,
};

export const INSTRUCTION_LIMITS = {
  HOLES: 9,
  GRID_MIN: 8,
  GRID_MAX: 40,
  PAR_MIN: 2,
  PAR_MAX: 5,
  NAME_LEN: 30,
  WINDMILLS_PER_HOLE: 4,
} as const;

/**
 * Validate a parsed instructions document. Returns null when valid, otherwise
 * a stable error code (mirrors the CourseDataV1 validator's style).
 */
export function validateCourseInstructions(doc: CourseInstructions): string | null {
  if (typeof doc.name !== 'string' || doc.name.length === 0) return 'NAME_EMPTY';
  if (!Array.isArray(doc.holes) || doc.holes.length !== INSTRUCTION_LIMITS.HOLES) return 'WRONG_HOLE_COUNT';
  for (const h of doc.holes) {
    if (!Number.isInteger(h.par) || h.par < INSTRUCTION_LIMITS.PAR_MIN || h.par > INSTRUCTION_LIMITS.PAR_MAX) return 'INVALID_PAR';
    if (h.name !== undefined && h.name.length > INSTRUCTION_LIMITS.NAME_LEN) return 'NAME_TOO_LONG';
    if (!Array.isArray(h.layout)) return 'INVALID_GRID';
    const height = h.layout.length;
    const width = height > 0 ? h.layout[0].length : 0;
    if (height < INSTRUCTION_LIMITS.GRID_MIN || height > INSTRUCTION_LIMITS.GRID_MAX) return 'INVALID_GRID';
    if (width < INSTRUCTION_LIMITS.GRID_MIN || width > INSTRUCTION_LIMITS.GRID_MAX) return 'INVALID_GRID';
    let tees = 0;
    let cups = 0;
    for (const row of h.layout) {
      if (typeof row !== 'string' || row.length !== width) return 'RAGGED_GRID';
      for (const ch of row) {
        if (CHAR_TO_CELL[ch] === undefined) return 'UNKNOWN_CELL';
        if (ch === 'T') tees++;
        else if (ch === 'C') cups++;
      }
    }
    if (tees !== 1) return 'MULTIPLE_TEES';
    if (cups !== 1) return 'MULTIPLE_CUPS';
    const mills = h.windmills ?? [];
    if (!Array.isArray(mills) || mills.length > INSTRUCTION_LIMITS.WINDMILLS_PER_HOLE) return 'TOO_MANY_MOVERS';
    for (const m of mills) {
      if (![m.x, m.y, m.lengthCells, m.speed].every((n) => typeof n === 'number' && Number.isFinite(n))) return 'INVALID_WINDMILL';
      if (m.x < 0 || m.x > width || m.y < 0 || m.y > height) return 'OFF_GRID';
      if (m.lengthCells <= 0 || m.lengthCells > Math.max(width, height)) return 'INVALID_WINDMILL';
    }
  }
  return null;
}

/** Parse + validate a JSON instructions document. Throws on any problem. */
export function parseCourseInstructions(text: string): CourseInstructions {
  const doc = JSON.parse(text) as CourseInstructions;
  const err = validateCourseInstructions(doc);
  if (err) throw new Error(`INVALID_COURSE: ${err}`);
  return doc;
}

/** Compile one instruction hole into a runtime, world-px HoleDef. */
export function holeFromInstructions(h: InstructionHole): HoleDef {
  const height = h.layout.length;
  const width = h.layout[0].length;
  const cells = new Uint8Array(width * height);
  let tee: Vec | null = null;
  let cup: Vec | null = null;
  h.layout.forEach((row, gy) => {
    for (let gx = 0; gx < width; gx++) {
      const ch = row[gx];
      cells[gy * width + gx] = CHAR_TO_CELL[ch];
      if (ch === 'T') tee = { x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL };
      if (ch === 'C') cup = { x: (gx + 0.5) * CELL, y: (gy + 0.5) * CELL };
    }
  });
  if (!tee || !cup) throw new Error('INVALID_COURSE: MISSING_TEE_OR_CUP');
  const bars: MovingBar[] = (h.windmills ?? []).map((m) => ({
    cx: m.x * CELL,
    cy: m.y * CELL,
    len: m.lengthCells * CELL,
    speed: m.speed,
    phase: 0,
  }));
  return { name: h.name ?? '', par: h.par, w: width, h: height, cells, tee, cup, bars };
}

/** Compile a full validated instructions document into runtime HoleDefs. */
export function courseFromInstructions(doc: CourseInstructions): HoleDef[] {
  return doc.holes.map(holeFromInstructions);
}

/**
 * Decode a course NFT `course_data` blob into playable holes.
 * JSON instructions first (the current format); legacy CBOR CourseDataV1 as
 * fallback so old mints keep working.
 */
export function decodeCourseBlob(blob: Uint8Array): HoleDef[] {
  // A JSON doc starts with optional whitespace then '{'.
  let i = 0;
  while (i < blob.length && (blob[i] === 0x20 || blob[i] === 0x09 || blob[i] === 0x0a || blob[i] === 0x0d)) i++;
  if (i < blob.length && blob[i] === 0x7b /* '{' */) {
    const text = new TextDecoder().decode(blob);
    return courseFromInstructions(parseCourseInstructions(text));
  }
  return courseFromData(decodeCourseData(blob));
}
