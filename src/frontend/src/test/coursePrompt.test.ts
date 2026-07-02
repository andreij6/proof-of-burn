import { describe, it, expect } from 'vitest';
import {
  buildCoursePrompt, friendlyCourseError, EXAMPLE_HOLE, COURSE_NAME_MAX_CHARS,
} from '../arcade/coursePrompt';
import {
  COURSE_INSTRUCTIONS_FORMAT, INSTRUCTION_LIMITS, validateCourseInstructions,
  parseCourseInstructions,
} from '../arcade/courseInstructions';

const L = INSTRUCTION_LIMITS;

// Every terrain character parseCourseInstructions accepts (CHAR_TO_CELL keys).
const LEGEND_CHARS = ['.', '#', 'g', 'r', 's', 'w', '^', 'v', '>', '<', 'h', 'o', 'b', '*', 'N', 'E', 'S', 'W', 'T', 'C'];

describe('buildCoursePrompt', () => {
  const prompt = buildCoursePrompt();

  it('names the exact format string', () => {
    expect(prompt).toContain(COURSE_INSTRUCTIONS_FORMAT);
  });

  it('documents every terrain legend character', () => {
    for (const ch of LEGEND_CHARS) {
      expect(prompt, `legend for '${ch}'`).toContain(`\`${ch}\``);
    }
  });

  it('states every validator limit (drift-checked against INSTRUCTION_LIMITS)', () => {
    expect(prompt).toContain(`exactly ${L.HOLES} holes`);
    expect(prompt).toContain(`from ${L.PAR_MIN} to ${L.PAR_MAX}`);
    expect(prompt).toContain(`between ${L.GRID_MIN} and ${L.GRID_MAX}`);
    expect(prompt).toContain(`${L.WINDMILLS_PER_HOLE} windmills per hole`);
    expect(prompt).toContain(`at most ${L.NAME_LEN} characters`);
    expect(prompt).toContain(`${COURSE_NAME_MAX_CHARS} characters`);
  });

  it('documents the optional windmill arm count', () => {
    expect(prompt).toContain('"arms"');
    expect(prompt).toContain('3, or 4');
  });

  it('embeds the example hole verbatim', () => {
    expect(prompt).toContain(JSON.stringify(EXAMPLE_HOLE, null, 2));
  });

  it('the embedded example hole builds a course that passes the REAL validator', () => {
    const doc = {
      format: COURSE_INSTRUCTIONS_FORMAT,
      name: 'Example Course',
      holes: Array.from({ length: L.HOLES }, () => ({ ...EXAMPLE_HOLE })),
    };
    expect(validateCourseInstructions(doc)).toBeNull();
    // And round-trips through the parse entry point the upload box uses.
    expect(parseCourseInstructions(JSON.stringify(doc)).holes).toHaveLength(L.HOLES);
  });

  it('tells the AI to output raw JSON only', () => {
    expect(prompt).toContain('NOTHING else');
    expect(prompt.toLowerCase()).toContain('no markdown code fences');
  });
});

describe('friendlyCourseError', () => {
  const CODES = [
    'NAME_EMPTY', 'WRONG_HOLE_COUNT', 'INVALID_PAR', 'NAME_TOO_LONG',
    'INVALID_GRID', 'RAGGED_GRID', 'UNKNOWN_CELL', 'MULTIPLE_TEES',
    'MULTIPLE_CUPS', 'TOO_MANY_MOVERS', 'INVALID_WINDMILL', 'OFF_GRID',
    'INVALID_PENDULUM', 'INVALID_SLIDER',
  ];

  it('maps every validator code to a distinct human sentence (not the code)', () => {
    const messages = CODES.map((code) => friendlyCourseError(new Error(`INVALID_COURSE: ${code}`)));
    for (let i = 0; i < CODES.length; i++) {
      expect(messages[i], CODES[i]).not.toContain(CODES[i]);
      expect(messages[i], CODES[i]).not.toContain('INVALID_COURSE');
    }
    expect(new Set(messages).size).toBe(CODES.length);
  });

  it('explains a real JSON.parse failure', () => {
    let caught: unknown;
    try { JSON.parse('{not json'); } catch (e) { caught = e; }
    expect(friendlyCourseError(caught)).toBe(
      "That doesn't look like valid JSON — paste exactly what the AI returned.",
    );
  });

  it('surfaces unknown errors raw', () => {
    expect(friendlyCourseError(new Error('SOMETHING_ELSE'))).toBe('SOMETHING_ELSE');
    expect(friendlyCourseError('plain string')).toBe('plain string');
  });
});
