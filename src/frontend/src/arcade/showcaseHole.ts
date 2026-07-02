// ==========================================
// Element showcase hole — a single playable hole for the create-a-course
// wizard that contains EVERY element a course designer can use, so a creator
// can see each one in action before describing their course to an AI agent:
// grass, rough, sand, water, walls, void border, posts, all four conveyor
// walkway directions, a spinning windmill, tee and cup.
//
// Kept as a build-instructions InstructionHole (the exact format designers
// author) and compiled with the same holeFromInstructions the Play flow uses,
// so what the demo shows is precisely what an uploaded course will do.
// test/showcaseHole.test.ts asserts full element coverage — if a new terrain
// char is ever added to CHAR_TO_CELL, that test fails until the demo shows it.
// ==========================================

import type { InstructionHole } from './courseInstructions';

// 24×14 open arena, zones left→right / top→bottom:
// rough and sand blocks up top, a water pool, north/south conveyor strips,
// east/west conveyor strips, a post column, a windmill guarding the cup.
export const SHOWCASE_HOLE: InstructionHole = {
  name: 'Element Demo',
  par: 3,
  layout: [
    '........................',
    '.######################.',
    '.#ggggggrrrrggggssssgg#.',
    '.#gTggggrrrrggggssssgg#.',
    '.#ggggggrrrrggggssssgg#.',
    '.#gggggggggggggggggggg#.',
    '.#gwwwwggg^^ggggvvggog#.',
    '.#gwwwwggg^^ggggvvggog#.',
    '.#ggggggggggggggggggog#.',
    '.#gg>>>>ggg<<<<ggggggg#.',
    '.#gggggggggggggggggggg#.',
    '.#ggogggggggggggggCggg#.',
    '.######################.',
    '........................',
  ],
  windmills: [{ x: 16, y: 10.5, lengthCells: 3, speed: 1.5 }],
};
