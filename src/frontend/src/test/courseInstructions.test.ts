import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  parseCourseInstructions, courseFromInstructions, validateCourseInstructions,
  decodeCourseBlob, COURSE_INSTRUCTIONS_FORMAT,
} from '../arcade/courseInstructions';
import { CELL, CellType, WALKABLE, cellAt, type HoleDef } from '../arcade/engine';
import { encodeCourseData, type CourseDataV1 } from '../arcade/courseData';

// The 3 mock courses seeded by the backend are the single source of truth —
// this test compiles them through the REAL decoder and proves each of the 27
// holes is structurally playable (valid grid, tee→cup reachable).
const COURSES_DIR = join(__dirname, '../../../backend/src/courses');

// Cells a rolling ball can traverse: engine WALKABLE (grass/slopes/rough) plus
// sand — sand is heavy friction but passable (WALKABLE is an editor concept).
const PASSABLE: number[] = [...(WALKABLE as number[]), CellType.Sand];

function bfsReachable(def: HoleDef): boolean {
  const tee = { x: Math.floor(def.tee.x / CELL), y: Math.floor(def.tee.y / CELL) };
  const cup = { x: Math.floor(def.cup.x / CELL), y: Math.floor(def.cup.y / CELL) };
  const seen = new Set([`${tee.x},${tee.y}`]);
  const queue = [tee];
  while (queue.length) {
    const c = queue.shift()!;
    if (c.x === cup.x && c.y === cup.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      const cell = cellAt(def, nx, ny);
      if (!PASSABLE.includes(cell)) continue;
      const key = `${nx},${ny}`;
      if (!seen.has(key)) { seen.add(key); queue.push({ x: nx, y: ny }); }
    }
  }
  return false;
}

describe('mock course instruction documents', () => {
  const files = readdirSync(COURSES_DIR).filter((f) => f.endsWith('.json'));

  it('exactly 3 mock courses ship with the backend', () => {
    expect(files).toHaveLength(3);
  });

  for (const file of files) {
    describe(file, () => {
      const text = readFileSync(join(COURSES_DIR, file), 'utf8');
      const doc = parseCourseInstructions(text);

      it('declares the current format and validates', () => {
        expect(doc.format).toBe(COURSE_INSTRUCTIONS_FORMAT);
        expect(validateCourseInstructions(doc)).toBeNull();
      });

      it('compiles to 9 playable holes (tee→cup reachable)', () => {
        const holes = courseFromInstructions(doc);
        expect(holes).toHaveLength(9);
        for (const h of holes) {
          expect(h.par).toBeGreaterThanOrEqual(2);
          expect(h.par).toBeLessThanOrEqual(5);
          // tee/cup rest on walkable ground
          expect((WALKABLE as number[])).toContain(cellAt(h, Math.floor(h.tee.x / CELL), Math.floor(h.tee.y / CELL)));
          expect((WALKABLE as number[])).toContain(cellAt(h, Math.floor(h.cup.x / CELL), Math.floor(h.cup.y / CELL)));
          expect(bfsReachable(h)).toBe(true);
        }
      });

      it('decodes through the Play-flow blob entry point', () => {
        const holes = decodeCourseBlob(new TextEncoder().encode(text));
        expect(holes).toHaveLength(9);
      });
    });
  }
});

describe('validateCourseInstructions error codes', () => {
  const goodText = readFileSync(join(COURSES_DIR, 'ember-fields.json'), 'utf8');

  it('rejects wrong hole counts', () => {
    const doc = parseCourseInstructions(goodText);
    expect(validateCourseInstructions({ ...doc, holes: doc.holes.slice(0, 8) })).toBe('WRONG_HOLE_COUNT');
  });

  it('rejects ragged grids', () => {
    const doc = parseCourseInstructions(goodText);
    const holes = doc.holes.map((h, i) => i === 0
      ? { ...h, layout: h.layout.map((r, y) => (y === 3 ? r + '.' : r)) }
      : h);
    expect(validateCourseInstructions({ ...doc, holes })).toBe('RAGGED_GRID');
  });

  it('rejects unknown terrain characters', () => {
    const doc = parseCourseInstructions(goodText);
    const holes = doc.holes.map((h, i) => i === 0
      ? { ...h, layout: h.layout.map((r, y) => (y === 2 ? r.replace('g', 'X') : r)) }
      : h);
    expect(validateCourseInstructions({ ...doc, holes })).toBe('UNKNOWN_CELL');
  });

  it('rejects out-of-range par', () => {
    const doc = parseCourseInstructions(goodText);
    const holes = doc.holes.map((h, i) => (i === 0 ? { ...h, par: 9 } : h));
    expect(validateCourseInstructions({ ...doc, holes })).toBe('INVALID_PAR');
  });
});

describe('decodeCourseBlob legacy CBOR fallback', () => {
  it('still decodes a CourseDataV1 CBOR blob', () => {
    const hole = {
      par: 3,
      gridW: 10,
      gridH: 10,
      tee: { x: 2, y: 8 },
      cup: { x: 7, y: 1 },
      elements: [],
    };
    const course: CourseDataV1 = {
      version: 1,
      theme: { kind: 'desert' },
      holes: Array.from({ length: 9 }, () => ({ ...hole })),
    };
    const holes = decodeCourseBlob(encodeCourseData(course));
    expect(holes).toHaveLength(9);
    expect(holes[0].w).toBe(10);
    // CBOR path compiles via courseFromData → default-grass grid
    expect(cellAt(holes[0], 2, 8)).toBe(CellType.Grass);
  });
});
