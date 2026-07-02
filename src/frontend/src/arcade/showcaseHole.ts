// ==========================================
// Element showcase hole — a single playable hole for the create-a-course
// wizard that contains EVERY element a course designer can use, so a creator
// can see each one in action before describing their course to an AI agent:
// grass, rough, sand, water, walls, void border, posts, all four conveyor
// walkway directions, an elevated plateau (ramped by a walkway), a tunnel
// pair, spinning windmills (3- and 4-arm rotors), tee and cup.
//
// Kept as a build-instructions InstructionHole (the exact format designers
// author) and compiled with the same holeFromInstructions the Play flow uses,
// so what the demo shows is precisely what an uploaded course will do.
// test/showcaseHole.test.ts asserts full element coverage — if a new terrain
// char is ever added to CHAR_TO_CELL, that test fails until the demo shows it.
// ==========================================

import type { InstructionHole } from './courseInstructions';

// 28×14 open arena, zones left→right / top→bottom:
// rough and sand blocks up top (a 3-arm windmill spins in the gap between
// them), a tunnel mouth just below the tee, a water pool, a south-walkway
// strip, a north-walkway strip that ramps onto the elevated plateau beside
// it, east/west walkway strips, posts, and a 4-arm windmill guarding the
// cup — with the tunnel's other mouth right past it.
export const SHOWCASE_HOLE: InstructionHole = {
  name: 'Element Demo',
  par: 3,
  layout: [
    '............................',
    '.##########################.',
    '.#gggggggrrrrggggssssggggg#.',
    '.#gTgggggrrrrggggssssggggg#.',
    '.#gggugggrrrrggggssssggggg#.',
    '.#gggggggggggggggggghhhhgg#.',
    '.#gwwwwggggggggggggghhhhgg#.',
    '.#gwwwwggggggggvvgggg^^ggg#.',
    '.#gggggggggggggvvgggg^^ggg#.',
    '.#gg>>>>ggg<<<<gggggggoggg#.',
    '.#gggggggggggggggggggggggg#.',
    '.#gggogggggggggggggCgguggg#.',
    '.##########################.',
    '............................',
  ],
  windmills: [
    { x: 16, y: 10.5, lengthCells: 3, speed: 1.5, arms: 4 },
    { x: 15, y: 3, lengthCells: 2, speed: -1.2, arms: 3 },
  ],
};
