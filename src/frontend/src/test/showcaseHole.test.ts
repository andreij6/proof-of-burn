import { describe, it, expect } from 'vitest';
import { SHOWCASE_HOLE } from '../arcade/showcaseHole';
import {
  COURSE_INSTRUCTIONS_FORMAT,
  holeFromInstructions,
  validateCourseInstructions,
  type CourseInstructions,
} from '../arcade/courseInstructions';
import { CellType, cellAt, CELL, WALKABLE } from '../arcade/engine';

// The demo's whole point is FULL element coverage — every character a course
// designer can author. If the format ever grows a new char, this list (and the
// demo hole) must grow with it.
const ALL_CHARS = ['.', '#', 'g', 'r', 's', 'w', '^', 'v', '>', '<', 'h', 'o', 'b', '*', 'N', 'E', 'S', 'W', 'T', 'C'];

describe('SHOWCASE_HOLE (element demo)', () => {
  it('is a valid instruction hole (validates as a 9x course)', () => {
    const doc: CourseInstructions = {
      format: COURSE_INSTRUCTIONS_FORMAT,
      name: 'Showcase',
      holes: Array.from({ length: 9 }, () => SHOWCASE_HOLE),
    };
    expect(validateCourseInstructions(doc)).toBeNull();
  });

  it('contains every authorable element, including a windmill', () => {
    const all = SHOWCASE_HOLE.layout.join('');
    for (const ch of ALL_CHARS) {
      expect(all.includes(ch), `missing element '${ch}'`).toBe(true);
    }
    expect(SHOWCASE_HOLE.windmills?.length ?? 0).toBeGreaterThan(0);
  });

  it('showcases a multi-arm windmill (3 or 4 arms)', () => {
    expect(
      SHOWCASE_HOLE.windmills?.some((w) => w.arms === 3 || w.arms === 4),
    ).toBe(true);
  });

  it('showcases a pendulum and a slider, compiled into engine movers + bumpers', () => {
    expect(SHOWCASE_HOLE.pendulums?.length ?? 0).toBeGreaterThan(0);
    expect(SHOWCASE_HOLE.sliders?.length ?? 0).toBeGreaterThan(0);
    const def = holeFromInstructions(SHOWCASE_HOLE);
    expect(def.movers?.some((m) => m.kind === 'pendulum')).toBe(true);
    expect(def.movers?.some((m) => m.kind === 'sliding')).toBe(true);
    // Both 'b' cells become springy bumper statics.
    expect(def.statics?.filter((s) => s.kind === 'bumper')).toHaveLength(2);
  });

  // The demo deliberately keeps a DIRECT ground route from tee to cup (the
  // tunnel and plateau are optional attractions, not the only path), so this
  // BFS stays over ordinary walkable terrain — no tunnel/elevation traversal.
  it('compiles and the cup is reachable from the tee (BFS over walkable cells)', () => {
    const def = holeFromInstructions(SHOWCASE_HOLE);
    const walkable = new Set<number>([...WALKABLE, CellType.Sand]);
    const start = `${Math.floor(def.tee.x / CELL)},${Math.floor(def.tee.y / CELL)}`;
    const goal = `${Math.floor(def.cup.x / CELL)},${Math.floor(def.cup.y / CELL)}`;
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const [x, y] = queue.shift()!.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        const key = `${nx},${ny}`;
        if (seen.has(key) || !walkable.has(cellAt(def, nx, ny))) continue;
        seen.add(key);
        queue.push(key);
      }
    }
    expect(seen.has(goal)).toBe(true);
  });
});
