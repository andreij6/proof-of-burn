import { describe, it, expect } from 'vitest';
import {
  COURSE, COURSE_PAR_TOTAL, HOLES_PER_ROUND, MAX_STROKES_PER_HOLE, MAX_POWER,
  STEP, STOP_SPEED, CUP_CAPTURE_SPEED, CELL, GRID_W, GRID_H, CellType, WALKABLE,
  initHole, stepHole, strike, dragToShot, speed, cellAt, cellAtWorld, barEndpoints,
  parseAscii, holeToBackend, holeFromBackend, mergeCourse,
  scoreLabel, fmtMillis,
  type HoleDef, type HoleState,
} from '../arcade/engine';

// Tiny test hole built from ASCII: a walled 22×14 field with optional
// hazard rows spliced in by the caller.
function asciiHole(opts: { rows?: string[]; par?: number; bars?: HoleDef['bars'] } = {}): HoleDef {
  const rows = opts.rows ?? [
    '......................',
    '.####################.',
    '.#gggggggggggggggggg#.',
    '.#ggggggggCggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#gggggggggggggggggg#.',
    '.#ggggggggTggggggggg#.',
    '.####################.',
    '......................',
  ];
  const { cells, tee, cup } = parseAscii(rows);
  return {
    name: 'Test', par: opts.par ?? 2, w: GRID_W, h: GRID_H, cells,
    tee: tee!, cup: cup!, bars: opts.bars ?? [],
  };
}

/** Run until the ball stops, sinks, or 30 simulated seconds pass. */
function settle(state: HoleState, def: HoleDef): number {
  let t = 0;
  while (state.phase === 'rolling' && t < 30) {
    t += STEP;
    stepHole(state, def, t);
  }
  return t;
}

describe('minigolf physics (voxel tiles)', () => {
  it('drag converts to an opposite-direction shot, capped at MAX_POWER', () => {
    const shot = dragToShot({ x: 0, y: 100 }); // drag down → fire up
    expect(shot.y).toBeLessThan(0);
    expect(shot.x).toBeCloseTo(0, 9);
    const maxed = dragToShot({ x: 0, y: 10_000 });
    expect(speed(maxed)).toBeCloseTo(MAX_POWER, 3);
    // Dead zone: tiny drags don't fire (no accidental tap-strokes).
    expect(dragToShot({ x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
  });

  it('friction stops a rolling ball and ends the shot', () => {
    const def = asciiHole();
    const state = initHole(def);
    strike(state, { x: 120, y: 0 });
    expect(state.phase).toBe('rolling');
    expect(state.strokes).toBe(1);
    settle(state, def);
    expect(state.phase).toBe('resting');
    expect(speed(state.vel)).toBe(0);
    expect(state.pos.x).toBeGreaterThan(def.tee.x); // it travelled
  });

  it('a straight putt at the cup sinks when slow enough', () => {
    const def = asciiHole();
    const state = initHole(def);
    strike(state, { x: 0, y: -480 }); // 8 cells up the lane
    settle(state, def);
    expect(state.phase).toBe('sunk');
    expect(state.pos).toEqual(def.cup);
  });

  it('a firm putt rolls straight over the cup (classic lip-out)', () => {
    const def = asciiHole();
    const state = initHole(def);
    strike(state, { x: 0, y: -MAX_POWER }); // way too hot
    let t = 0;
    let passedCup = false;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      if (state.pos.y < def.cup.y) passedCup = true;
    }
    expect(passedCup).toBe(true);
    expect(state.phase).not.toBe('sunk');
  });

  it('wall cubes reflect the ball and keep it on the course', () => {
    const def = asciiHole();
    const state = initHole(def);
    strike(state, { x: -900, y: 0 }); // straight at the west wall
    settle(state, def);
    // Never escaped the walled area (cells 1..20 horizontally).
    expect(state.pos.x).toBeGreaterThan(2 * CELL - 1);
    expect(state.pos.x).toBeLessThan(20 * CELL + 1);
  });

  it('water costs a stroke and resets to the pre-shot spot', () => {
    const rows = [
      '......................',
      '.####################.',
      '.#gggggggggggggggggg#.',
      '.#ggggggggCggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#wwwwwwwwwwwwwwwwww#.',
      '.#wwwwwwwwwwwwwwwwww#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#ggggggggTggggggggg#.',
      '.####################.',
      '......................',
    ];
    const def = asciiHole({ rows });
    const state = initHole(def);
    strike(state, { x: 0, y: -400 }); // into the moat
    settle(state, def);
    expect(state.phase).toBe('resting');
    expect(state.strokes).toBe(2); // 1 shot + 1 penalty
    expect(state.pos).toEqual(def.tee);
  });

  it('sand slows the ball far more than green', () => {
    const sandyRows = [
      '......................',
      '.####################.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssCsssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssssssssssss#.',
      '.#ssssssssTsssssssss#.',
      '.####################.',
      '......................',
    ];
    const green = asciiHole();
    const sandy = asciiHole({ rows: sandyRows });
    const a = initHole(green); strike(a, { x: 250, y: 0 }); settle(a, green);
    const b = initHole(sandy); strike(b, { x: 250, y: 0 }); settle(b, sandy);
    const greenDist = a.pos.x - green.tee.x;
    const sandDist = b.pos.x - sandy.tee.x;
    expect(sandDist).toBeLessThan(greenDist / 3);
  });

  it('slope cells push the ball (downhill drift)', () => {
    const rows = [
      '......................',
      '.####################.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>C>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#>>>>>>>>>>>>>>>>>>#.',
      '.#ggggggggTggggggggg#.',
      '.####################.',
      '......................',
    ];
    const def = asciiHole({ rows });
    const state = initHole(def);
    strike(state, { x: 0, y: -260 }); // putt north into the east-slope field
    settle(state, def);
    expect(state.pos.x).toBeGreaterThan(def.tee.x + 5);
  });

  it('a water penalty on the final allowed stroke caps at 12 (never 13+)', () => {
    const rows = [
      '......................',
      '.####################.',
      '.#gggggggggggggggggg#.',
      '.#ggggggggCggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#wwwwwwwwwwwwwwwwww#.',
      '.#wwwwwwwwwwwwwwwwww#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#gggggggggggggggggg#.',
      '.#ggggggggTggggggggg#.',
      '.####################.',
      '......................',
    ];
    const def = asciiHole({ rows });
    const state = initHole(def);
    // Burn 10 strokes with tiny sideways putts, then put stroke 11 in the
    // water: the +1 penalty must cap the hole at exactly 12, not 13.
    for (let i = 0; i < 10; i++) {
      strike(state, { x: 40, y: 0 });
      settle(state, def);
    }
    expect(state.strokes).toBe(10);
    strike(state, { x: 0, y: -400 }); // 11th stroke, into the moat (+1 = 12)
    settle(state, def);
    expect(state.strokes).toBe(MAX_STROKES_PER_HOLE);
    expect(state.phase).toBe('sunk'); // capped — backend accepts ≤12
  });

  it('the 12-stroke cap ends the hole as a pickup', () => {
    const def = asciiHole();
    const state = initHole(def);
    for (let i = 0; i < MAX_STROKES_PER_HOLE; i++) {
      strike(state, { x: 40, y: 0 });
      settle(state, def);
    }
    expect(state.strokes).toBe(MAX_STROKES_PER_HOLE);
    expect(state.phase).toBe('sunk'); // capped → hole over
  });

  it('windmill bar endpoints rotate over time', () => {
    const bar = { cx: 100, cy: 100, len: 100, speed: Math.PI, phase: 0 };
    const w0 = barEndpoints(bar, 0);
    const w1 = barEndpoints(bar, 1); // half a turn → endpoints swap
    expect(w0.x1).toBeCloseTo(w1.x2, 5);
    expect(w0.y1).toBeCloseTo(w1.y2, 5);
  });
});

describe('course pack', () => {
  it('has 9 holes, par total 27, valid grids, walkable tees/cups', () => {
    expect(COURSE.length).toBe(HOLES_PER_ROUND);
    expect(COURSE_PAR_TOTAL).toBe(27);
    for (const h of COURSE) {
      expect(h.w).toBe(GRID_W);
      expect(h.h).toBe(GRID_H);
      expect(h.cells.length).toBe(GRID_W * GRID_H);
      for (const p of [h.tee, h.cup]) {
        expect(WALKABLE.includes(cellAtWorld(h, p)), `${h.name} tee/cup walkable`).toBe(true);
      }
      expect(h.par).toBeGreaterThanOrEqual(2);
      expect(h.par).toBeLessThanOrEqual(4);
      // The grid is sealed: every walkable cell's neighbourhood never
      // touches the grid edge directly (a wall or void ring surrounds play).
      for (let gx = 0; gx < GRID_W; gx++) {
        expect(cellAt(h, gx, 0)).not.toBe(CellType.Grass);
        expect(cellAt(h, gx, GRID_H - 1)).not.toBe(CellType.Grass);
      }
    }
  });

  it('hole 1 is winnable with a single straight putt', () => {
    const def = COURSE[0];
    const state = initHole(def);
    const dx = def.cup.x - def.tee.x, dy = def.cup.y - def.tee.y;
    const dist = Math.hypot(dx, dy);
    strike(state, { x: (dx / dist) * 430, y: (dy / dist) * 430 });
    settle(state, def);
    expect(state.phase).toBe('sunk');
    expect(state.strokes).toBe(1);
  });

  it('the windmill hole has a moving bar', () => {
    const windmill = COURSE.find(h => h.name === 'Windmill')!;
    expect(windmill.bars.length).toBe(1);
    expect(windmill.bars[0].speed).toBeGreaterThan(0);
  });
});

describe('backend course conversion', () => {
  it('round-trips a hole through the candid wire format', () => {
    const original = COURSE[6]; // Windmill — exercises bars too
    const wire = holeToBackend(original);
    expect(wire.w).toBe(GRID_W);
    expect(wire.cells).toHaveLength(GRID_W * GRID_H);
    expect(wire.bars).toHaveLength(1);
    const back = holeFromBackend(wire);
    expect(back.name).toBe(original.name);
    expect(back.par).toBe(original.par);
    expect(Array.from(back.cells)).toEqual(Array.from(original.cells));
    expect(back.tee).toEqual(original.tee);
    expect(back.cup).toEqual(original.cup);
    expect(back.bars[0].len).toBe(original.bars[0].len);
    expect(back.bars[0].speed).toBeCloseTo(original.bars[0].speed, 3);
  });

  it('mergeCourse overlays on-chain overrides onto the defaults', () => {
    const replacement = holeToBackend({ ...COURSE[0], name: 'Edited Hole', par: 4 });
    const merged = mergeCourse([{ index: 2, hole: replacement }]);
    expect(merged[2].name).toBe('Edited Hole');
    expect(merged[2].par).toBe(4);
    expect(merged[0].name).toBe(COURSE[0].name); // others untouched
    expect(merged).toHaveLength(HOLES_PER_ROUND);
  });
});

describe('scoring helpers', () => {
  it('labels par-relative scores like a scorecard', () => {
    expect(scoreLabel(1, 3)).toBe('Hole-in-one!');
    expect(scoreLabel(2, 4)).toBe('Eagle');
    expect(scoreLabel(2, 3)).toBe('Birdie');
    expect(scoreLabel(3, 3)).toBe('Par');
    expect(scoreLabel(4, 3)).toBe('Bogey');
    expect(scoreLabel(5, 3)).toBe('Double bogey');
    expect(scoreLabel(7, 3)).toBe('+4');
  });

  it('formats milliseconds as m:ss', () => {
    expect(fmtMillis(0)).toBe('0:00');
    expect(fmtMillis(61_000)).toBe('1:01');
    expect(fmtMillis(605_400)).toBe('10:05');
  });

  it('stop threshold and capture speed are coherent', () => {
    expect(STOP_SPEED).toBeLessThan(CUP_CAPTURE_SPEED);
  });
});
