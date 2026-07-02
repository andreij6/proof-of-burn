import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  parseCourseInstructions, courseFromInstructions, validateCourseInstructions,
  holeFromInstructions, decodeCourseBlob, COURSE_INSTRUCTIONS_FORMAT,
  type CourseInstructions, type InstructionHole,
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

describe("new elements: elevation 'h', tunnels 'u', windmill arms", () => {
  const BASE_LAYOUT = [
    '########',
    '#gggggg#',
    '#gTgggg#',
    '#gggggg#',
    '#gggggg#',
    '#ggggCg#',
    '#gggggg#',
    '########',
  ];

  function mkHole(layout: string[], extra: Partial<InstructionHole> = {}): InstructionHole {
    return { par: 3, layout, ...extra };
  }

  function mkDoc(hole: InstructionHole): CourseInstructions {
    return {
      format: COURSE_INSTRUCTIONS_FORMAT,
      name: 'New Elements',
      holes: Array.from({ length: 9 }, () => hole),
    };
  }

  function withRow(row: number, value: string): string[] {
    return BASE_LAYOUT.map((r, i) => (i === row ? value : r));
  }

  it("accepts 'h' and compiles it to Elevated", () => {
    const hole = mkHole(withRow(3, '#gghhgg#'));
    expect(validateCourseInstructions(mkDoc(hole))).toBeNull();
    const def = holeFromInstructions(hole);
    expect(cellAt(def, 3, 3)).toBe(CellType.Elevated);
    expect(cellAt(def, 4, 3)).toBe(CellType.Elevated);
  });

  it("rejects 'u' (tunnels were removed from the format) as UNKNOWN_CELL", () => {
    const hole = mkHole(withRow(3, '#gguggg#'));
    expect(validateCourseInstructions(mkDoc(hole))).toBe('UNKNOWN_CELL');
  });

  it('instruction holes never compile with tunnels', () => {
    expect(holeFromInstructions(mkHole(BASE_LAYOUT)).tunnels).toBeUndefined();
  });

  it("compiles bumpers ('b'), boost pads ('*') and one-way gates (N/E/S/W)", () => {
    const hole = mkHole(withRow(3, '#b*NESW#'));
    expect(validateCourseInstructions(mkDoc(hole))).toBeNull();
    const def = holeFromInstructions(hole);
    // 'b' floors as grass and adds a springy bumper static at the cell centre.
    expect(cellAt(def, 1, 3)).toBe(CellType.Grass);
    expect(def.statics).toHaveLength(1);
    expect(def.statics![0]).toMatchObject({ kind: 'bumper', shape: 'circle', cx: 1.5 * CELL, cy: 3.5 * CELL });
    expect(cellAt(def, 2, 3)).toBe(CellType.Boost);
    expect(cellAt(def, 3, 3)).toBe(CellType.GateN);
    expect(cellAt(def, 4, 3)).toBe(CellType.GateE);
    expect(cellAt(def, 5, 3)).toBe(CellType.GateS);
    expect(cellAt(def, 6, 3)).toBe(CellType.GateW);
  });

  it('validates and compiles pendulums', () => {
    const good = mkHole(BASE_LAYOUT, { pendulums: [{ x: 4, y: 2, lengthCells: 2, speed: 1.5 }] });
    expect(validateCourseInstructions(mkDoc(good))).toBeNull();
    const def = holeFromInstructions(good);
    expect(def.movers).toHaveLength(1);
    expect(def.movers![0]).toMatchObject({
      kind: 'pendulum', pivot: { x: 4 * CELL, y: 2 * CELL }, len: 2 * CELL, baseSpeed: 1.5,
    });
    // Bad arm length / off-grid pivot.
    expect(validateCourseInstructions(mkDoc(mkHole(BASE_LAYOUT, { pendulums: [{ x: 4, y: 2, lengthCells: 0, speed: 1 }] })))).toBe('INVALID_PENDULUM');
    expect(validateCourseInstructions(mkDoc(mkHole(BASE_LAYOUT, { pendulums: [{ x: 99, y: 2, lengthCells: 2, speed: 1 }] })))).toBe('OFF_GRID');
  });

  it('validates and compiles sliders (cells/s → engine phase rate)', () => {
    const good = mkHole(BASE_LAYOUT, { sliders: [{ x: 4, y: 4, axis: 'y' as const, travelCells: 3, speed: 2 }] });
    expect(validateCourseInstructions(mkDoc(good))).toBeNull();
    const def = holeFromInstructions(good);
    expect(def.movers).toHaveLength(1);
    const m = def.movers![0];
    expect(m).toMatchObject({ kind: 'sliding', axis: 1, slideLen: (3 * CELL) / 2, len: CELL });
    // Peak linear speed = baseSpeed · slideLen = authored cells/s · CELL.
    expect(m.baseSpeed * m.slideLen!).toBeCloseTo(2 * CELL, 6);
    // Bad axis / zero speed.
    expect(validateCourseInstructions(mkDoc(mkHole(BASE_LAYOUT, { sliders: [{ x: 4, y: 4, axis: 'z' as never, travelCells: 3, speed: 2 }] })))).toBe('INVALID_SLIDER');
    expect(validateCourseInstructions(mkDoc(mkHole(BASE_LAYOUT, { sliders: [{ x: 4, y: 4, axis: 'x' as const, travelCells: 3, speed: 0 }] })))).toBe('INVALID_SLIDER');
  });

  it('validates windmill arms (2/3/4 or absent; anything else INVALID_WINDMILL)', () => {
    const mill = { x: 4, y: 4, lengthCells: 2, speed: 1 };
    for (const arms of [undefined, 2, 3, 4]) {
      const hole = mkHole(BASE_LAYOUT, { windmills: [{ ...mill, ...(arms === undefined ? {} : { arms }) }] });
      expect(validateCourseInstructions(mkDoc(hole)), `arms ${arms}`).toBeNull();
    }
    for (const arms of [1, 5, 2.5]) {
      const hole = mkHole(BASE_LAYOUT, { windmills: [{ ...mill, arms }] });
      expect(validateCourseInstructions(mkDoc(hole)), `arms ${arms}`).toBe('INVALID_WINDMILL');
    }
  });

  it('threads arms through to the compiled bar (default 2)', () => {
    const mill = { x: 4, y: 4, lengthCells: 2, speed: 1 };
    expect(holeFromInstructions(mkHole(BASE_LAYOUT, { windmills: [{ ...mill, arms: 3 }] })).bars[0].arms).toBe(3);
    expect(holeFromInstructions(mkHole(BASE_LAYOUT, { windmills: [mill] })).bars[0].arms).toBe(2);
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
