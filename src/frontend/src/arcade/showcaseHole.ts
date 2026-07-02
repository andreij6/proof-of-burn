// ==========================================
// Element showcase hole — a single playable hole for the create-a-course
// wizard that contains EVERY element a course designer can use, so a creator
// can see each one in action before describing their course to an AI agent:
// grass, rough, sand, water, walls, void border, posts, bumpers, boost pads,
// all four conveyor walkway directions, all four one-way gates, an elevated
// plateau (sloped on all sides — the walkway gives a run-up), spinning
// windmills (3- and 4-arm rotors), a pendulum, a sliding block, tee and cup.
//
// Kept as a build-instructions InstructionHole (the exact format designers
// author) and compiled with the same holeFromInstructions the Play flow uses,
// so what the demo shows is precisely what an uploaded course will do.
// test/showcaseHole.test.ts asserts full element coverage — if a new terrain
// char is ever added to CHAR_TO_CELL, that test fails until the demo shows it.
// ==========================================

import type { InstructionHole } from './courseInstructions';

// 28×17 open arena, zones left→right / top→bottom:
// rough and sand blocks up top (a 3-arm windmill spins in the gap between
// them), a water pool, a south-walkway strip, a north-walkway strip whose
// run-up carries the ball over the plateau's sloped rim, east/west walkway
// strips, then a gadget row (boost pads, bumpers) and a one-way-gate diamond
// (N/W/E/S), a pendulum and a patrolling slider on the open green, posts, and
// a 4-arm windmill guarding the cup.
export const SHOWCASE_HOLE: InstructionHole = {
  name: 'Element Demo',
  par: 3,
  layout: [
    '............................',
    '.##########################.',
    '.#gggggggrrrrggggssssggggg#.',
    '.#gTgggggrrrrggggssssggggg#.',
    '.#gggggggrrrrggggssssggggg#.',
    '.#gggggggggggggggggghhhhgg#.',
    '.#gwwwwggggggggggggghhhhgg#.',
    '.#gwwwwggggggggvvgggg^^ggg#.',
    '.#gggggggggggggvvgggg^^ggg#.',
    '.#gg>>>>ggg<<<<gggggggoggg#.',
    '.#gg**gggbbggggggNgggggggg#.',
    '.#ggggggggggggggWgEggggggg#.',
    '.#gggggggggggggggSgggggggg#.',
    '.#gggggggggggggggggggggggg#.',
    '.#gggogggggggggggggCgggggg#.',
    '.##########################.',
    '............................',
  ],
  windmills: [
    { x: 16, y: 13.5, lengthCells: 3, speed: 1.5, arms: 4 },
    { x: 15, y: 3, lengthCells: 2, speed: -1.2, arms: 3 },
  ],
  pendulums: [{ x: 8, y: 12.5, lengthCells: 1.5, speed: 1.6 }],
  sliders: [{ x: 12.5, y: 13.5, axis: 'x', travelCells: 4, speed: 1.5 }],
};
