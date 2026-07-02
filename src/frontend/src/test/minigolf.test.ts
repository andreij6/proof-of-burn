import { describe, it, expect } from 'vitest';
import {
  COURSE, COURSE_PAR_TOTAL, HOLES_PER_ROUND, MAX_STROKES_PER_HOLE, MAX_POWER, PLATEAU_CLIMB_SPEED,
  STEP, STOP_SPEED, CUP_CAPTURE_SPEED, CELL, GRID_W, GRID_H, CellType, WALKABLE,
  BALL_R, POST_R, MOVER_THICK,
  initHole, stepHole, strike, dragToShot, speed, cellAt, cellAtWorld, barEndpoints, barSegments,
  parseAscii, holeToBackend, holeFromBackend, mergeCourse,
  scoreLabel, fmtMillis,
  holeFromCourseData, courseFromData, moverGeometry, TUNNEL_R,
  type HoleDef, type HoleState, type Vec,
} from '../arcade/engine';
import { holeFromInstructions } from '../arcade/courseInstructions';
import { ElementKind, Speed, type CourseDataV1, type Hole as CourseHole, type Element } from '../arcade/courseData';

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
    const bar = { cx: 100, cy: 100, len: 100, speed: Math.PI, phase: 0, arms: 2 };
    const w0 = barEndpoints(bar, 0);
    const w1 = barEndpoints(bar, 1); // half a turn → endpoints swap
    expect(w0.x1).toBeCloseTo(w1.x2, 5);
    expect(w0.y1).toBeCloseTo(w1.y2, 5);
  });
});

describe('collision precision (substepped integration)', () => {
  // The ball's cardinal edge samples: none may sit inside a solid cell after
  // any stepHole return (the "ball halfway into the wall" regression guard).
  function edgeInSolid(def: HoleDef, pos: Vec): boolean {
    const r = BALL_R - 0.5;
    const pts: Vec[] = [
      pos,
      { x: pos.x + r, y: pos.y }, { x: pos.x - r, y: pos.y },
      { x: pos.x, y: pos.y + r }, { x: pos.x, y: pos.y - r },
    ];
    return pts.some(p => {
      const c = cellAtWorld(def, p);
      return c === CellType.Wall || c === CellType.Void;
    });
  }

  it('max-power shots at all 4 walls never leave the ball inside a solid cell', () => {
    const def = asciiHole();
    const dirs: Vec[] = [
      { x: MAX_POWER, y: 0 }, { x: -MAX_POWER, y: 0 },
      { x: 0, y: MAX_POWER }, { x: 0, y: -MAX_POWER },
    ];
    for (const dir of dirs) {
      const state = initHole(def);
      strike(state, dir);
      let t = 0;
      while (state.phase === 'rolling' && t < 30) {
        t += STEP;
        stepHole(state, def, t);
        expect(edgeInSolid(def, state.pos), `dir ${dir.x},${dir.y} sank into a wall at t=${t.toFixed(3)}`).toBe(false);
      }
      // Rested inside the playable box, a full ball radius clear of every wall
      // face (west x=2·CELL, east x=20·CELL, north y=2·CELL, south y=12·CELL).
      expect(state.pos.x).toBeGreaterThanOrEqual(2 * CELL + BALL_R - 1e-6);
      expect(state.pos.x).toBeLessThanOrEqual(20 * CELL - BALL_R + 1e-6);
      expect(state.pos.y).toBeGreaterThanOrEqual(2 * CELL + BALL_R - 1e-6);
      expect(state.pos.y).toBeLessThanOrEqual(12 * CELL - BALL_R + 1e-6);
    }
  });

  it('never crosses a thin wall segment at max power', () => {
    const def = asciiHole();
    const segX = 15 * CELL;
    def.walls = [{ x1: segX, y1: 2 * CELL, x2: segX, y2: 12 * CELL }];
    const state = initHole(def);
    strike(state, { x: MAX_POWER, y: 0 }); // straight east at the segment
    const limit = segX - BALL_R - MOVER_THICK + 1e-6;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      expect(state.pos.x, `crossed the segment at t=${t.toFixed(3)}`).toBeLessThanOrEqual(limit);
    }
  });

  it('a post hit at max power reflects and never overlaps it', () => {
    const rows = [
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
      '.#ggggggggTggggogggg#.',
      '.####################.',
      '......................',
    ];
    const def = asciiHole({ rows });
    const post = { x: 15.5 * CELL, y: 11.5 * CELL }; // the 'o' cell centre
    const state = initHole(def);
    strike(state, { x: MAX_POWER, y: 0 }); // head-on from the west
    let minDist = Infinity;
    let reflected = false;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      minDist = Math.min(minDist, Math.hypot(state.pos.x - post.x, state.pos.y - post.y));
      if (state.vel.x < 0) reflected = true;
    }
    expect(reflected).toBe(true);
    expect(minDist).toBeGreaterThanOrEqual(BALL_R + POST_R - 1e-6);
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

// =====================================================================
// PB-303 — CourseDataV1 loader + new element physics
// =====================================================================

function cdEl(kind: number, x: number, y: number, rot: 0 | 1 | 2 | 3, params: Element['params']): Element {
  return { kind: kind as Element['kind'], x, y, rot, params };
}

/** A roomy 16×16 open hole with tee/cup placed; caller adds elements. */
function cdHole(elements: Element[], opts: { tee?: { x: number; y: number }; cup?: { x: number; y: number } } = {}): CourseHole {
  return {
    name: 'T', par: 3, gridW: 16, gridH: 16,
    tee: opts.tee ?? { x: 1, y: 8 },
    cup: opts.cup ?? { x: 14, y: 8 },
    elements,
  };
}

/** Run until the ball settles/sinks, advancing the shared hole clock. */
function settleCd(state: HoleState, def: HoleDef): number {
  let t = 0;
  while (state.phase === 'rolling' && t < 30) {
    t += STEP;
    stepHole(state, def, t);
  }
  return t;
}

describe('CourseDataV1 loader', () => {
  it('rasterizes terrain to the right CellType and fills the rest with grass', () => {
    const def = holeFromCourseData(cdHole([
      cdEl(ElementKind.Rough, 3, 3, 0, { tag: 'none' }),
      cdEl(ElementKind.Sand, 4, 3, 0, { tag: 'none' }),
      cdEl(ElementKind.Water, 5, 3, 0, { tag: 'none' }),
      cdEl(ElementKind.OutOfBounds, 6, 3, 0, { tag: 'none' }),
    ]));
    expect(cellAt(def, 3, 3)).toBe(CellType.Rough);
    expect(cellAt(def, 4, 3)).toBe(CellType.Sand);
    expect(cellAt(def, 5, 3)).toBe(CellType.Water);
    expect(cellAt(def, 6, 3)).toBe(CellType.Void);
    expect(cellAt(def, 0, 0)).toBe(CellType.Grass);
  });

  it('populates walls/statics/movers/tunnels/ramps/tiles arrays', () => {
    const def = holeFromCourseData(cdHole([
      cdEl(ElementKind.WallStraight, 2, 2, 1, { tag: 'none' }),
      cdEl(ElementKind.Pillar, 3, 3, 0, { tag: 'none' }),
      cdEl(ElementKind.Windmill, 5, 5, 0, { tag: 'moving', speed: Speed.Med, phase: 0 }),
      cdEl(ElementKind.TunnelEntrance, 1, 1, 0, { tag: 'pair', pairId: 0 }),
      cdEl(ElementKind.TunnelExit, 10, 10, 1, { tag: 'pair', pairId: 0 }),
      cdEl(ElementKind.RampUp, 6, 6, 1, { tag: 'pair', pairId: 1 }),
      cdEl(ElementKind.RampDown, 7, 7, 3, { tag: 'pair', pairId: 1 }),
      cdEl(ElementKind.SpeedTile, 8, 8, 1, { tag: 'tile', strength: Speed.Fast }),
    ]));
    expect(def.walls!.length).toBe(1);
    expect(def.statics!.length).toBe(1);
    expect(def.movers!.length).toBe(1);
    expect(def.tunnels!.length).toBe(1);
    expect(def.ramps!.length).toBe(1);
    expect(def.tiles!.length).toBe(1);
    expect(def.tunnels![0].rotDelta).toBe(1); // exit rot 1 − entrance rot 0
  });

  it('courseFromData compiles all 9 holes', () => {
    const holes: CourseHole[] = Array.from({ length: 9 }, () => cdHole([]));
    const data: CourseDataV1 = { version: 1, theme: { kind: 'forest' }, holes };
    expect(courseFromData(data).length).toBe(9);
  });
});

describe('new element physics', () => {
  // Helper: straight horizontal putt across an open lane; returns distance travelled.
  function travelOn(elements: Element[], power = 300): number {
    const def = holeFromCourseData(cdHole(elements, { cup: { x: 99, y: 99 } }));
    const state = initHole(def);
    strike(state, { x: power, y: 0 });
    settleCd(state, def);
    return state.pos.x - def.tee.x;
  }

  it('rough slows more than green and less than sand', () => {
    const greenRow: Element[] = [];
    const roughRow: Element[] = Array.from({ length: 14 }, (_, i) => cdEl(ElementKind.Rough, i + 1, 8, 0, { tag: 'none' }));
    const sandRow: Element[] = Array.from({ length: 14 }, (_, i) => cdEl(ElementKind.Sand, i + 1, 8, 0, { tag: 'none' }));
    const g = travelOn(greenRow);
    const r = travelOn(roughRow);
    const s = travelOn(sandRow);
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(s);
  });

  it('bumper increases outbound speed vs a plain wall control', () => {
    // Fire at a bumper head-on; capture the max speed right after contact.
    function maxSpeedAfterContact(kind: number): number {
      const def = holeFromCourseData(cdHole([cdEl(kind, 6, 8, 0, { tag: 'none' })], { cup: { x: 99, y: 99 } }));
      const state = initHole(def);
      strike(state, { x: 300, y: 0 });
      let bounced = false;
      let peak = 0;
      let t = 0;
      while (state.phase === 'rolling' && t < 6) {
        t += STEP;
        const vbefore = state.vel.x;
        stepHole(state, def, t);
        if (!bounced && state.vel.x < 0 && vbefore >= 0) bounced = true;
        if (bounced) peak = Math.max(peak, speed(state.vel));
      }
      return peak;
    }
    const bumper = maxSpeedAfterContact(ElementKind.Bumper);
    const pillar = maxSpeedAfterContact(ElementKind.Pillar);
    expect(bumper).toBeGreaterThan(pillar);
  });

  it('pillar / rock keep the ball out (it reflects, never overlaps)', () => {
    const def = holeFromCourseData(cdHole([cdEl(ElementKind.Rock, 6, 8, 0, { tag: 'rock', size: 1 })], { cup: { x: 99, y: 99 } }));
    const state = initHole(def);
    strike(state, { x: 300, y: 0 });
    settleCd(state, def);
    // It bounced back west of the rock (rock left edge at 6*CELL).
    expect(state.pos.x).toBeLessThan(6 * CELL);
  });

  it('windmill/pendulum/paddle deflect a crossing ball vs a no-obstacle control', () => {
    for (const kind of [ElementKind.Windmill, ElementKind.Pendulum, ElementKind.RotatingPaddle]) {
      const withDef = holeFromCourseData(cdHole([cdEl(kind, 7, 8, 0, { tag: 'moving', speed: Speed.Med, phase: 0 })], { cup: { x: 99, y: 99 } }));
      const ctrlDef = holeFromCourseData(cdHole([], { cup: { x: 99, y: 99 } }));
      const a = initHole(withDef); strike(a, { x: 500, y: 0 }); settleCd(a, withDef);
      const b = initHole(ctrlDef); strike(b, { x: 500, y: 0 }); settleCd(b, ctrlDef);
      const dyDiff = Math.abs(a.pos.y - b.pos.y) + Math.abs(a.pos.x - b.pos.x);
      expect(dyDiff, `kind ${kind} deflected`).toBeGreaterThan(1);
    }
  });

  it('moverGeometry is a pure, periodic function of tSec', () => {
    const m = { kind: 'windmill' as const, pivot: { x: 100, y: 100 }, len: 120, baseSpeed: Math.PI, phase0: 0 };
    const g0 = moverGeometry(m, 0);
    const g0b = moverGeometry(m, 0);
    expect(g0).toEqual(g0b); // pure
    const g2 = moverGeometry(m, 2); // full turn at PI rad/s → 2s = 2*PI
    expect(g2.seg.x1).toBeCloseTo(g0.seg.x1, 5);
    expect(g2.seg.y2).toBeCloseTo(g0.seg.y2, 5);
  });

  it('sliding block blocks the lane at one phase and clears it at another', () => {
    // Block centred mid-lane, sliding along y (axis 1) so its x stays put but it
    // moves vertically in/out of the putt line.
    function blockedAtPhase(phase: number): boolean {
      const def = holeFromCourseData(cdHole([cdEl(ElementKind.SlidingBlock, 7, 8, 0, { tag: 'sliding', speed: Speed.Slow, phase, len: 4, axis: 1 })], { cup: { x: 99, y: 99 } }));
      // Freeze the obstacle by stepping with a constant clock so its phase is fixed.
      const state = initHole(def);
      strike(state, { x: 300, y: 0 });
      let t = 0;
      while (state.phase === 'rolling' && t < 8) {
        t += STEP;
        stepHole(state, def, 0); // constant clock → block frozen at phase0
      }
      return state.pos.x < 7 * CELL; // didn't pass the block column
    }
    // phase 0 → sin(0)=0 → block centred on the lane (blocks);
    // phase 25 → sin(pi/2)=1 → block translated fully off the lane (clears).
    expect(blockedAtPhase(0)).toBe(true);
    expect(blockedAtPhase(25)).toBe(false);
  });

  it('speed tile boosts speed along its facing; slow tile reduces it', () => {
    function speedThroughTile(kind: number, rot: 0 | 1 | 2 | 3): { entry: number; exit: number } {
      // Single tile cell at (6,8); fire east through it and sample speed before/after.
      const def = holeFromCourseData(cdHole([cdEl(kind, 6, 8, rot, { tag: 'tile', strength: Speed.Fast })], { cup: { x: 99, y: 99 } }));
      const state = initHole(def);
      strike(state, { x: 300, y: 0 });
      let entry = 0, exit = 0;
      let t = 0;
      const tileX = 6 * CELL;
      while (state.phase === 'rolling' && t < 8) {
        t += STEP;
        if (state.pos.x < tileX) entry = speed(state.vel);
        stepHole(state, def, t);
        if (state.pos.x >= tileX + CELL && exit === 0) exit = speed(state.vel);
      }
      return { entry, exit };
    }
    const fast = speedThroughTile(ElementKind.SpeedTile, 1); // facing east, same as motion
    expect(fast.exit).toBeGreaterThan(fast.entry);
    const slow = speedThroughTile(ElementKind.SlowTile, 1);
    expect(slow.exit).toBeLessThan(slow.entry);
  });

  it('ramp redirects the ball along its facing rot', () => {
    // Ball fired east hits a ramp facing north (rot 0) at (6,8) → should head north.
    const def = holeFromCourseData(cdHole([
      cdEl(ElementKind.RampUp, 6, 8, 0, { tag: 'pair', pairId: 0 }),
      cdEl(ElementKind.RampDown, 6, 2, 0, { tag: 'pair', pairId: 0 }),
    ], { cup: { x: 99, y: 99 } }));
    const state = initHole(def);
    strike(state, { x: 300, y: 0 });
    settleCd(state, def);
    // Ended up north of the tee row (y decreased).
    expect(state.pos.y).toBeLessThan(def.tee.y - 5);
  });

  it('tunnel teleports the ball to the paired exit with preserved speed', () => {
    const def = holeFromCourseData(cdHole([
      cdEl(ElementKind.TunnelEntrance, 5, 8, 1, { tag: 'pair', pairId: 0 }),
      cdEl(ElementKind.TunnelExit, 12, 3, 1, { tag: 'pair', pairId: 0 }),
    ], { cup: { x: 99, y: 99 } }));
    const state = initHole(def);
    strike(state, { x: 300, y: 0 });
    let teleported = false;
    let speedAtExit = 0;
    let t = 0;
    const exit = def.tunnels![0].exit;
    while (state.phase === 'rolling' && t < 8 && !teleported) {
      t += STEP;
      stepHole(state, def, t);
      if (state.event === 'tunnel') {
        teleported = true;
        const d = Math.hypot(state.pos.x - exit.x, state.pos.y - exit.y);
        expect(d).toBeLessThan(TUNNEL_R + 1); // emerged at the exit
        speedAtExit = speed(state.vel);
      }
    }
    expect(teleported).toBe(true);
    expect(speedAtExit).toBeGreaterThan(STOP_SPEED); // momentum preserved (rotDelta 0)
  });

  it('is deterministic: same strikes → identical final state', () => {
    function run(): HoleState {
      const def = holeFromCourseData(cdHole([
        cdEl(ElementKind.Windmill, 7, 8, 0, { tag: 'moving', speed: Speed.Med, phase: 10 }),
        cdEl(ElementKind.Bumper, 10, 8, 0, { tag: 'none' }),
      ], { cup: { x: 99, y: 99 } }));
      const state = initHole(def);
      strike(state, { x: 520, y: 30 });
      settleCd(state, def);
      return state;
    }
    const a = run(), b = run();
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.strokes).toBe(b.strokes);
  });
});

// =====================================================================
// Elevation ('h', sloped rim on all sides), tunnel pairs, multi-arm windmills
// =====================================================================

describe('elevation cells (sloped rim)', () => {
  function setCell(def: HoleDef, gx: number, gy: number, c: CellType) {
    def.cells[gy * def.w + gx] = c;
  }

  it('rolls a too-slow ball back down the rim (never occupies the plateau)', () => {
    const def = asciiHole();
    for (let gy = 2; gy <= 11; gy++) setCell(def, 15, gy, CellType.Elevated);
    const state = initHole(def);
    state.pos = { x: 14.5 * CELL, y: 11.5 * CELL }; // one cell west of the rim
    state.preShot = { ...state.pos };
    strike(state, { x: PLATEAU_CLIMB_SPEED - 30, y: 0 }); // too slow to climb
    let reversed = false;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      if (state.vel.x < 0) reversed = true;
      expect(cellAtWorld(def, state.pos), 'ball occupied an elevated cell').not.toBe(CellType.Elevated);
    }
    expect(reversed).toBe(true); // rolled back down, west
    expect(state.pos.x).toBeLessThan(15 * CELL);
  });

  it('climbs the rim from flat ground with enough speed, losing the climb cost', () => {
    const def = asciiHole();
    for (let gy = 2; gy <= 11; gy++) setCell(def, 15, gy, CellType.Elevated);
    const state = initHole(def);
    state.pos = { x: 14.5 * CELL, y: 11.5 * CELL };
    state.preShot = { ...state.pos };
    const v0 = 400;
    strike(state, { x: v0, y: 0 });
    let climbSpeed = 0;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      if (climbSpeed === 0 && cellAtWorld(def, state.pos) === CellType.Elevated) {
        climbSpeed = state.vel.x;
      }
    }
    expect(climbSpeed).toBeGreaterThan(0); // it got up
    // Energy model: v' ≈ √(v² − c²), well below the approach speed.
    expect(climbSpeed).toBeLessThan(Math.sqrt(v0 * v0 - PLATEAU_CLIMB_SPEED * PLATEAU_CLIMB_SPEED) + 15);
  });

  it('accelerates rolling off the rim (descent gains the climb cost)', () => {
    const def = asciiHole();
    setCell(def, 14, 11, CellType.Elevated);
    const state = initHole(def);
    state.pos = { x: 14.5 * CELL, y: 11.5 * CELL }; // on the plateau
    state.preShot = { ...state.pos };
    const v0 = 120; // below the climb cost — exiting must still be free
    strike(state, { x: v0, y: 0 });
    let exitSpeed = 0;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      if (exitSpeed === 0 && cellAtWorld(def, state.pos) !== CellType.Elevated) {
        exitSpeed = state.vel.x;
      }
    }
    expect(exitSpeed).toBeGreaterThan(PLATEAU_CLIMB_SPEED); // boosted downhill
  });

  it('is entered from a walkway pushing into it, then exits freely', () => {
    const def = asciiHole();
    setCell(def, 14, 11, CellType.SlopeE);   // walkway ramping east…
    setCell(def, 15, 11, CellType.Elevated); // …up onto the plateau
    const state = initHole(def);
    strike(state, { x: 420, y: 0 }); // east along the tee row, over the ramp
    let entered = false;
    let t = 0;
    while (state.phase === 'rolling' && t < 30) {
      t += STEP;
      stepHole(state, def, t);
      if (cellAtWorld(def, state.pos) === CellType.Elevated) entered = true;
    }
    expect(entered).toBe(true);
    // Rolled off the far edge back onto grass (exit is always free).
    expect(state.pos.x).toBeGreaterThan(16 * CELL);
    expect(cellAtWorld(def, state.pos)).not.toBe(CellType.Elevated);
  });

  it('a ball already on elevation rolls anywhere on it', () => {
    const def = asciiHole();
    setCell(def, 14, 11, CellType.Elevated);
    setCell(def, 15, 11, CellType.Elevated);
    const state = initHole(def);
    state.pos = { x: 14.5 * CELL, y: 11.5 * CELL }; // start on the plateau
    state.preShot = { ...state.pos };
    strike(state, { x: 250, y: 0 });
    settle(state, def);
    expect(state.pos.x).toBeGreaterThan(15 * CELL); // crossed the second cell
  });
});

describe('tunnel pairs (legacy CourseDataV1 portal physics)', () => {
  // The instructions format no longer authors tunnels ('u' was removed), but
  // the engine keeps TunnelPair physics for legacy CourseDataV1 courses —
  // build the pair directly on the def. Long landing run east of mouth B so
  // the ball settles on grass without wandering back into a mouth (pairs
  // legitimately re-trigger after the cooldown).
  const TUNNEL_HOLE = {
    par: 3,
    layout: [
      '########################',
      '#gggggggggggggggggggggg#',
      '#gTgggggggggggggggggggg#',
      '#gggggggggggggggggggggg#',
      '#ggggggggggggggggggggCg#',
      '#gggggggggggggggggggggg#',
      '#gggggggggggggggggggggg#',
      '########################',
    ],
  };

  it('teleports the ball to the paired mouth with momentum, once per cooldown', () => {
    const def = holeFromInstructions(TUNNEL_HOLE);
    const a = { x: 4.5 * CELL, y: 2.5 * CELL };
    const b = { x: 8.5 * CELL, y: 2.5 * CELL };
    def.tunnels = [
      { pairId: 0, entrance: a, exit: b, rotDelta: 0 },
      { pairId: 1, entrance: b, exit: a, rotDelta: 0 },
    ];
    const state = initHole(def);
    strike(state, { x: 500, y: 0 }); // east along the mouth row
    let teleports = 0;
    let t = 0;
    while (state.phase === 'rolling' && t < 10) {
      t += STEP;
      stepHole(state, def, t);
      if (state.event === 'tunnel') {
        teleports += 1;
        if (teleports === 1) {
          // Emerged at the far mouth, still heading east (rotDelta 0).
          expect(Math.hypot(state.pos.x - b.x, state.pos.y - b.y)).toBeLessThan(1);
          expect(state.vel.x).toBeGreaterThan(0);
        }
      }
    }
    expect(teleports).toBe(1); // cooldown let it clear the exit mouth
    expect(state.pos.x).toBeGreaterThan(b.x + CELL); // carried on east of mouth B
  });
});

describe('multi-arm windmill bars', () => {
  it('barSegments: 2 arms = the classic full bar; 3/4 arms = pivot-to-tip rotors', () => {
    const mk = (arms: number) => ({ cx: 100, cy: 100, len: 120, speed: 1, phase: 0, arms });
    const two = barSegments(mk(2), 0);
    expect(two).toHaveLength(1);
    expect(two[0]).toEqual(barEndpoints(mk(2), 0));
    for (const arms of [3, 4]) {
      const segs = barSegments(mk(arms), 0);
      expect(segs).toHaveLength(arms);
      for (const s of segs) {
        expect(s.x1).toBe(100); // every arm starts at the pivot
        expect(s.y1).toBe(100);
        expect(Math.hypot(s.x2 - 100, s.y2 - 100)).toBeCloseTo(60, 6); // len/2 tips
      }
    }
  });

  it('an extra arm blocks a lane the classic 2-arm bar misses', () => {
    // Frozen clock (stepHole with tSec 0): phase 0 puts the 2-arm bar flat
    // along the x-axis at y = cy. The ball travels along y = cy − 30 — clear
    // of the horizontal bar, but the 3-arm (arm at 240°) and 4-arm (arm at
    // 270°) rotors both have an arm crossing that lane north of the pivot.
    function reflected(arms: number): boolean {
      const def = asciiHole({
        bars: [{ cx: 12 * CELL, cy: 6 * CELL, len: 3 * CELL, speed: 1, phase: 0, arms }],
      });
      const state = initHole(def);
      state.pos = { x: 5 * CELL, y: 6 * CELL - 30 };
      state.preShot = { ...state.pos };
      strike(state, { x: 400, y: 0 });
      let sawReverse = false;
      let t = 0;
      while (state.phase === 'rolling' && t < 10) {
        t += STEP;
        stepHole(state, def, 0); // constant clock → bar frozen at phase 0
        if (state.vel.x < 0) sawReverse = true;
      }
      return sawReverse;
    }
    expect(reflected(2)).toBe(false); // sails past the flat bar
    expect(reflected(3)).toBe(true);
    expect(reflected(4)).toBe(true);
  });
});
