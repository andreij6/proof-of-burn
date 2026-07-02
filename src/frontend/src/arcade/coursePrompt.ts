// ==========================================
// Course-designer prompt (create-with-AI flow) — pure logic.
//
// `buildCoursePrompt()` is the text the "Copy instructions" button puts on the
// user's clipboard. The user pastes it into ANY external AI agent (ChatGPT,
// Claude, …), designs a course with it, and pastes the agent's JSON back into
// the app's upload box. The prompt is therefore fully self-contained: it
// restates the `proof-of-burn/minigolf-course@1` format that
// `courseInstructions.ts` validates/compiles, and every numeric limit is
// interpolated from INSTRUCTION_LIMITS so the two can't drift apart.
//
// `friendlyCourseError()` turns the errors thrown while parsing the pasted
// JSON (`INVALID_COURSE: <CODE>` from parseCourseInstructions, or a raw JSON
// SyntaxError) into one human sentence for the upload box.
// ==========================================

import {
  COURSE_INSTRUCTIONS_FORMAT,
  INSTRUCTION_LIMITS,
  type InstructionHole,
} from './courseInstructions';

/** On-chain mint limit for the course `name` (backend MAX_COURSE_NAME_CHARS). */
export const COURSE_NAME_MAX_CHARS = 60;

/**
 * A complete, valid example hole embedded verbatim (JSON.stringify) in the
 * prompt so the AI sees the exact shape. Exported so tests can prove it
 * passes the real validator.
 */
export const EXAMPLE_HOLE: InstructionHole = {
  name: 'Sandy Turn',
  par: 3,
  layout: [
    '##########',
    '#gggggggg#',
    '#gTgggggg#',
    '#gggossgg#',
    '#ggggssgg#',
    '#ggggggCg#',
    '#gggggggg#',
    '##########',
  ],
  windmills: [{ x: 5, y: 4, lengthCells: 3, speed: 1.2 }],
};

const L = INSTRUCTION_LIMITS;

export function buildCoursePrompt(): string {
  return `You are an expert mini-golf course designer. Help me design a 9-hole course for a top-down 2D mini-golf game, then output it as one JSON "build instructions" document the game compiles into playable holes.

HOW TO WORK WITH ME
1. Ask me about the theme, mood, and difficulty I want (a couple of questions, then propose).
2. Sketch the ${L.HOLES} holes in words and iterate until I approve.
3. Only after I approve, output the final JSON (see FINAL OUTPUT below).

THE JSON DOCUMENT
A single object:
{
  "format": "${COURSE_INSTRUCTIONS_FORMAT}",
  "name": "<course name>",
  "description": "<optional one-liner>",
  "holes": [ <exactly ${L.HOLES} holes> ]
}

Each hole is:
{
  "name": "<optional, at most ${L.NAME_LEN} characters>",
  "par": <integer>,
  "layout": [ "<row string>", ... ],
  "windmills": [ { "x": <num>, "y": <num>, "lengthCells": <num>, "speed": <num>, "arms": <2, 3 or 4 — optional, default 2> }, ... ],  // optional
  "pendulums": [ { "x": <num>, "y": <num>, "lengthCells": <num>, "speed": <num> }, ... ],  // optional — arm hangs below the pivot and swings
  "sliders": [ { "x": <num>, "y": <num>, "axis": "x" | "y", "travelCells": <num>, "speed": <num> }, ... ]  // optional — a solid block patrolling back and forth
}

HARD CONSTRAINTS (the app rejects the document if ANY is violated)
1. "holes" contains exactly ${L.HOLES} holes.
2. Every "par" is a whole number from ${L.PAR_MIN} to ${L.PAR_MAX}.
3. Hole "name" is at most ${L.NAME_LEN} characters; course "name" is non-empty and at most ${COURSE_NAME_MAX_CHARS} characters.
4. "layout" is an array of strings. All rows have the SAME length. Width and height are each between ${L.GRID_MIN} and ${L.GRID_MAX} cells.
5. Every character in every row comes from the TERRAIN LEGEND below — nothing else.
6. Each hole has exactly one 'T' (tee) and exactly one 'C' (cup).
7. At most ${L.WINDMILLS_PER_HOLE} windmills per hole. A windmill's pivot (x, y) is in cell units and must lie inside the grid (fractions allowed); "lengthCells" is the full arm length, greater than 0 and no larger than the grid's bigger dimension; "speed" is in radians/second (negative spins counter-clockwise; 0.8–2.0 is a sensible range); "arms" is optional and must be 2 (the classic full bar — the default), 3, or 4 (evenly spaced half-arm rotors).
8. At most ${L.WINDMILLS_PER_HOLE} pendulums per hole. A pendulum's (x, y) pivot is in cell units inside the grid; its arm ("lengthCells" > 0, no larger than the grid's bigger dimension) hangs BELOW the pivot and swings side to side; "speed" is the swing rate in radians/second (0.8–2.5 sensible).
9. At most ${L.WINDMILLS_PER_HOLE} sliders per hole. A slider is a solid one-cell block patrolling through its (x, y) path centre along "axis" ("x" or "y"), covering "travelCells" total cells (> 0, within the grid) at "speed" cells/second (> 0; 0.5–4 sensible). Keep its path clear of walls.

TERRAIN LEGEND (one character per cell)
\`.\` void — out of bounds, no floor. The ball must never need to cross it.
\`#\` wall — solid, the ball bounces off.
\`g\` grass — normal fairway.
\`r\` rough — slow.
\`s\` sand — very slow.
\`w\` water — hazard: the ball resets with a penalty.
\`^\` moving walkway (conveyor) carrying the ball North (up).
\`v\` moving walkway (conveyor) carrying the ball South (down).
\`>\` moving walkway (conveyor) carrying the ball East (right).
\`<\` moving walkway (conveyor) carrying the ball West (left).
\`h\` elevated plateau — raised ground with a sloped rim on ALL sides. The ball climbs the slope from any direction if it has enough speed (a slow ball rolls back down), rolls normally on top, and speeds up rolling off any edge. A moving walkway pointed at the rim gives a reliable run-up.
\`o\` post — a round obstacle the ball ricochets off (no speed change).
\`b\` bumper — a springy round post: the ball rebounds FASTER than it arrived (pinball kicker).
\`*\` boost pad — accelerates the ball hard in whatever direction it is ALREADY moving (unlike a walkway, which pushes a fixed direction).
\`N\` one-way gate — the ball can enter only while moving North (up); from any other heading it bounces off like a wall.
\`E\` one-way gate, passable only moving East (right).
\`S\` one-way gate, passable only moving South (down).
\`W\` one-way gate, passable only moving West (left).
\`T\` tee — where the ball starts (rests on grass).
\`C\` cup — the hole (rests on grass).

DESIGN GUIDANCE
- Surround each hole's playable area with \`#\` walls so the ball can't escape into void.
- Guarantee a real path: the ball must be able to travel from T to C over passable ground (grass/rough/sand/walkways) without crossing void or being fully blocked by walls/water.
- Elevation: an \`h\` plateau demands pace — a firm putt (or a walkway run-up) climbs the sloped rim, a timid one rolls back down. Use plateaus for raised greens, guarded shortcuts, and risky drop-offs; remember the ball accelerates coming off the edge.
- Bumpers (\`b\`) add chaos and speed — line a corridor with them for a pinball alley, but never crowd the cup with them.
- One-way gates (\`N\`/\`E\`/\`S\`/\`W\`) enforce routing: a shortcut the ball can drop into but not back out of, or a loop the player must commit to. Point the gate the way you want play to flow.
- Boost pads (\`*\`) reward a good line — place them on long straights, before a plateau rim, or before water for a risky carry. The boost follows the ball's current direction.
- Pendulums and sliders are TIMING hazards: a pendulum guards the mouth of a passage from above it; a slider blocks a corridor on a rhythm. Give each a clear passing window and keep slider paths free of walls.
- Ramp difficulty across the ${L.HOLES} holes: open early holes, tighter fairways / hazards / windmills later.
- Total par sets the course's marketplace difficulty: Easy is 27 or less, Medium 28–44, Hard 45 or more. Pick pars to land the difficulty I asked for.
- BE ORIGINAL. Every course is minted as an NFT, and the game fingerprints each hole's layout at mint time: if 3 or more holes match holes from ANY already-minted course — mirrored, rotated, or shifted copies count as matches — the mint is REJECTED. Do not copy the example hole below into the course; invent your own layouts.

EXAMPLE HOLE (exact shape to imitate)
${JSON.stringify(EXAMPLE_HOLE, null, 2)}

FINAL OUTPUT
When I approve the design, reply with ONE complete JSON document and NOTHING else — no markdown code fences, no commentary before or after — so I can paste it directly into the app's upload box.`;
}

// ── Upload-box error copy ─────────────────────────────────────────────────────

const ERROR_COPY: Record<string, string> = {
  NAME_EMPTY: 'The course is missing a name — ask the AI to include a non-empty "name".',
  WRONG_HOLE_COUNT: `A course needs exactly ${L.HOLES} holes.`,
  INVALID_PAR: `Every hole's par must be a whole number from ${L.PAR_MIN} to ${L.PAR_MAX}.`,
  NAME_TOO_LONG: `A hole's name is longer than ${L.NAME_LEN} characters.`,
  INVALID_GRID: `A hole's layout must be between ${L.GRID_MIN}×${L.GRID_MIN} and ${L.GRID_MAX}×${L.GRID_MAX} cells.`,
  RAGGED_GRID: "Every row in a hole's layout must be the same length.",
  UNKNOWN_CELL: "A hole's layout uses a character that isn't in the terrain legend.",
  MULTIPLE_TEES: "Each hole needs exactly one tee ('T').",
  MULTIPLE_CUPS: "Each hole needs exactly one cup ('C').",
  TOO_MANY_MOVERS: `A hole has more than ${L.WINDMILLS_PER_HOLE} of one mover type (windmills, pendulums, or sliders).`,
  INVALID_WINDMILL: 'A windmill has an invalid arm length, speed, or arm count (2, 3, or 4).',
  INVALID_PENDULUM: 'A pendulum has an invalid arm length or swing speed.',
  INVALID_SLIDER: 'A slider needs axis "x" or "y", a positive travel within the grid, and a positive speed.',
  OFF_GRID: "A mover's pivot sits outside its hole's grid.",
};

/**
 * One human sentence for an upload/validation failure: a JSON SyntaxError, an
 * `INVALID_COURSE: <CODE>` from parseCourseInstructions, or anything else
 * (surfaced raw).
 */
export function friendlyCourseError(e: unknown): string {
  if (e instanceof SyntaxError) {
    return "That doesn't look like valid JSON — paste exactly what the AI returned.";
  }
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/^INVALID_COURSE: (\w+)$/);
  if (m && ERROR_COPY[m[1]]) return ERROR_COPY[m[1]];
  return msg;
}
