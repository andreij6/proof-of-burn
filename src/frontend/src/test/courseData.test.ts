import { describe, it, expect } from 'vitest';
import {
  COURSE_DATA_VERSION, ElementKind, Speed, LIMITS,
  encodeCourseData, decodeCourseData, validateCourseData,
  type CourseDataV1, type Hole, type Element,
} from '../arcade/courseData';

// ── Builders ──

function el(kind: number, x: number, y: number, rot: 0 | 1 | 2 | 3, params: Element['params']): Element {
  return { kind: kind as Element['kind'], x, y, rot, params };
}

/** A minimal valid hole (tee + cup, no extra elements). */
function plainHole(name?: string): Hole {
  return {
    name,
    par: 3,
    gridW: 12,
    gridH: 12,
    tee: { x: 2, y: 2 },
    cup: { x: 9, y: 9 },
    elements: [],
  };
}

/** One hole exercising EVERY ElementKind (balanced tunnels + ramps). */
function allElementsHole(): Hole {
  const elements: Element[] = [
    // terrain
    el(ElementKind.Fairway, 1, 1, 0, { tag: 'none' }),
    el(ElementKind.Rough, 2, 1, 0, { tag: 'none' }),
    el(ElementKind.Sand, 3, 1, 0, { tag: 'none' }),
    el(ElementKind.Water, 4, 1, 0, { tag: 'none' }),
    el(ElementKind.OutOfBounds, 5, 1, 0, { tag: 'none' }),
    // walls
    el(ElementKind.WallStraight, 1, 3, 1, { tag: 'none' }),
    el(ElementKind.WallCorner, 2, 3, 2, { tag: 'none' }),
    el(ElementKind.WallAngled45, 3, 3, 0, { tag: 'none' }),
    el(ElementKind.WallCurved, 4, 3, 3, { tag: 'none' }),
    // static
    el(ElementKind.Rock, 1, 5, 0, { tag: 'rock', size: 2 }),
    el(ElementKind.Pillar, 4, 5, 0, { tag: 'none' }),
    el(ElementKind.Bumper, 5, 5, 0, { tag: 'none' }),
    el(ElementKind.Tree, 6, 5, 0, { tag: 'none' }),
    // moving
    el(ElementKind.Windmill, 8, 5, 0, { tag: 'moving', speed: Speed.Med, phase: 25 }),
    el(ElementKind.Pendulum, 9, 5, 0, { tag: 'moving', speed: Speed.Slow, phase: 0 }),
    el(ElementKind.RotatingPaddle, 10, 5, 0, { tag: 'moving', speed: Speed.Fast, phase: 50 }),
    el(ElementKind.SlidingBlock, 7, 7, 0, { tag: 'sliding', speed: Speed.Med, phase: 0, len: 3, axis: 0 }),
    // special (balanced pairs)
    el(ElementKind.TunnelEntrance, 1, 8, 0, { tag: 'pair', pairId: 0 }),
    el(ElementKind.TunnelExit, 10, 8, 1, { tag: 'pair', pairId: 0 }),
    el(ElementKind.RampUp, 2, 9, 1, { tag: 'pair', pairId: 1 }),
    el(ElementKind.RampDown, 8, 9, 3, { tag: 'pair', pairId: 1 }),
    el(ElementKind.SpeedTile, 3, 10, 1, { tag: 'tile', strength: Speed.Fast }),
    el(ElementKind.SlowTile, 5, 10, 2, { tag: 'tile', strength: Speed.Slow }),
  ];
  return { name: 'Everything', par: 4, gridW: 14, gridH: 14, tee: { x: 0, y: 0 }, cup: { x: 13, y: 13 }, elements };
}

function validCourse(): CourseDataV1 {
  const holes: Hole[] = [allElementsHole()];
  for (let i = 1; i < 9; i++) holes.push(plainHole(`Hole ${i + 1}`));
  return { version: COURSE_DATA_VERSION, theme: { kind: 'desert' }, holes };
}

// ── CBOR round-trip ──

describe('CourseDataV1 CBOR', () => {
  it('round-trips a full all-elements course deep-equal, under 24 KiB', () => {
    const c = validCourse();
    const blob = encodeCourseData(c);
    const back = decodeCourseData(blob);
    expect(back).toEqual(c);
    expect(blob.length).toBeLessThan(LIMITS.BLOB_TARGET);
  });

  it('round-trips every theme variant', () => {
    for (const theme of [
      { kind: 'desert' } as const,
      { kind: 'ocean' } as const,
      { kind: 'space' } as const,
      { kind: 'forest' } as const,
      { kind: 'custom', primary: '#aabbcc', secondary: '#112233' } as const,
    ]) {
      const c: CourseDataV1 = { ...validCourse(), theme };
      expect(decodeCourseData(encodeCourseData(c)).theme).toEqual(theme);
    }
  });

  it('round-trips every params variant', () => {
    const variants: Element['params'][] = [
      { tag: 'none' },
      { tag: 'rock', size: 1 },
      { tag: 'rock', size: 2 },
      { tag: 'moving', speed: Speed.Slow, phase: 0 },
      { tag: 'moving', speed: Speed.Fast, phase: 100 },
      { tag: 'sliding', speed: Speed.Med, phase: 33, len: 4, axis: 1 },
      { tag: 'pair', pairId: 3 },
      { tag: 'tile', strength: Speed.Med },
    ];
    for (const p of variants) {
      const c = validCourse();
      c.holes[0].elements = [el(ElementKind.Rock, 1, 1, 0, p)];
      const back = decodeCourseData(encodeCourseData(c));
      expect(back.holes[0].elements[0].params).toEqual(p);
    }
  });

  it('omits/restores the optional hole name (Option<String>)', () => {
    const c = validCourse();
    delete c.holes[1].name;
    const back = decodeCourseData(encodeCourseData(c));
    expect(back.holes[1].name).toBeUndefined();
    expect(back.holes[2].name).toBe('Hole 3');
  });

  it('encodes integer discriminants (compact, no float bytes)', () => {
    const blob = encodeCourseData(validCourse());
    // CBOR float headers are 0xf9/0xfa/0xfb — must never appear.
    for (const b of blob) expect(b === 0xf9 || b === 0xfa || b === 0xfb).toBe(false);
  });
});

// ── Validation limits (one per A.4 rule) ──

describe('validateCourseData', () => {
  it('accepts a valid 9-hole course', () => {
    expect(validateCourseData(validCourse())).toBeNull();
  });

  it('rejects wrong version', () => {
    const c = validCourse();
    (c as { version: number }).version = 2;
    expect(validateCourseData(c)).toBe('INVALID_VERSION');
  });

  it('rejects wrong hole count', () => {
    const c = validCourse();
    c.holes = c.holes.slice(0, 8);
    expect(validateCourseData(c)).toBe('WRONG_HOLE_COUNT');
  });

  it('rejects par 1 and par 6', () => {
    const lo = validCourse(); lo.holes[3].par = 1;
    expect(validateCourseData(lo)).toBe('INVALID_PAR');
    const hi = validCourse(); hi.holes[3].par = 6;
    expect(validateCourseData(hi)).toBe('INVALID_PAR');
  });

  it('rejects an off-grid grid size', () => {
    const small = validCourse(); small.holes[2].gridW = 7;
    expect(validateCourseData(small)).toBe('INVALID_GRID');
    const big = validCourse(); big.holes[2].gridH = 41;
    expect(validateCourseData(big)).toBe('INVALID_GRID');
  });

  it('rejects an over-long hole name', () => {
    const c = validCourse();
    c.holes[1].name = 'x'.repeat(LIMITS.NAME_LEN + 1);
    expect(validateCourseData(c)).toBe('NAME_TOO_LONG');
  });

  it('rejects > 200 elements in a hole', () => {
    const c = validCourse();
    c.holes[1].elements = Array.from({ length: 201 }, () => el(ElementKind.Pillar, 1, 1, 0, { tag: 'none' }));
    expect(validateCourseData(c)).toBe('TOO_MANY_ELEMENTS');
  });

  it('rejects > 12 movers in a hole', () => {
    const c = validCourse();
    c.holes[1].elements = Array.from({ length: 13 }, () =>
      el(ElementKind.Windmill, 1, 1, 0, { tag: 'moving', speed: Speed.Med, phase: 0 }));
    expect(validateCourseData(c)).toBe('TOO_MANY_MOVERS');
  });

  it('rejects unbalanced tunnels (3 entrances, 2 exits)', () => {
    const c = validCourse();
    c.holes[1].elements = [
      el(ElementKind.TunnelEntrance, 1, 1, 0, { tag: 'pair', pairId: 0 }),
      el(ElementKind.TunnelEntrance, 2, 1, 0, { tag: 'pair', pairId: 1 }),
      el(ElementKind.TunnelEntrance, 3, 1, 0, { tag: 'pair', pairId: 2 }),
      el(ElementKind.TunnelExit, 4, 1, 0, { tag: 'pair', pairId: 0 }),
      el(ElementKind.TunnelExit, 5, 1, 0, { tag: 'pair', pairId: 1 }),
    ];
    expect(validateCourseData(c)).toBe('UNBALANCED_TUNNELS');
  });

  it('rejects unbalanced ramps', () => {
    const c = validCourse();
    c.holes[1].elements = [
      el(ElementKind.RampUp, 1, 1, 0, { tag: 'pair', pairId: 0 }),
      el(ElementKind.RampUp, 2, 1, 0, { tag: 'pair', pairId: 1 }),
      el(ElementKind.RampDown, 3, 1, 0, { tag: 'pair', pairId: 0 }),
    ];
    expect(validateCourseData(c)).toBe('UNBALANCED_RAMPS');
  });

  it('rejects an off-grid element', () => {
    const c = validCourse();
    c.holes[1].elements = [el(ElementKind.Pillar, 99, 1, 0, { tag: 'none' })];
    expect(validateCourseData(c)).toBe('OFF_GRID');
  });

  it('rejects an oversize blob (> 64 KiB) → BLOB_TOO_LARGE', () => {
    // All count-limits pass, but a pathologically large custom-theme payload
    // (the one unbounded field) pushes the serialized blob past the 64 KiB
    // ceiling — exercising the backstop the canister relies on (PB-301 A.5).
    const c: CourseDataV1 = {
      ...validCourse(),
      theme: { kind: 'custom', primary: '#aabbcc', secondary: 'x'.repeat(70 * 1024) },
    };
    expect(validateCourseData(c)).toBe('BLOB_TOO_LARGE');
  });
});
