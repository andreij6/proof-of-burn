import { describe, it, expect } from 'vitest';
import { ElementKind as EK, type Hole, type Element } from '../arcade/courseData';
import {
  emptyCourse, emptyHole, holeStatus, mintGate, parTotal, defaultParams,
  elementAt, placeElement, deleteElementAt, rotateElement, snapCell,
} from '../arcade/courseEditorLogic';

function el(kind: number, x: number, y: number): Element {
  return { kind: kind as Element['kind'], x, y, rot: 0, params: defaultParams(kind as Element['kind']) };
}

describe('emptyCourse', () => {
  it('is a 9-hole desert course with default pars', () => {
    const c = emptyCourse();
    expect(c.holes).toHaveLength(9);
    expect(c.theme.kind).toBe('desert');
    expect(parTotal(c)).toBe(27);
  });
});

describe('holeStatus', () => {
  it('is empty for an untouched, element-free hole', () => {
    expect(holeStatus(emptyHole(), false).kind).toBe('empty');
  });

  it('is complete for a touched hole with in-grid tee/cup and valid par', () => {
    expect(holeStatus(emptyHole(), true).kind).toBe('complete');
  });

  it('flags an off-grid tee as incomplete', () => {
    const h: Hole = { ...emptyHole(), tee: { x: 999, y: 0 } };
    const st = holeStatus(h, true);
    expect(st.kind).toBe('incomplete');
    expect(st.reason).toMatch(/tee/);
  });

  it('flags an out-of-range par as incomplete', () => {
    const h: Hole = { ...emptyHole(), par: 7 };
    expect(holeStatus(h, true).kind).toBe('incomplete');
  });
});

describe('mintGate', () => {
  it('passes a valid named course', () => {
    const g = mintGate(emptyCourse(), 'My Course');
    expect(g.ok).toBe(true);
    expect(g.reasons).toHaveLength(0);
    expect(g.code).toBeNull();
  });

  it('requires a non-empty course name', () => {
    const g = mintGate(emptyCourse(), '   ');
    expect(g.ok).toBe(false);
    expect(g.reasons.some((r) => /name is required/.test(r))).toBe(true);
  });

  it('rejects a 61-char course name', () => {
    const g = mintGate(emptyCourse(), 'x'.repeat(61));
    expect(g.ok).toBe(false);
    expect(g.reasons.some((r) => /≤ 60/.test(r))).toBe(true);
  });

  it('flags an off-grid cup on a specific hole', () => {
    const c = emptyCourse();
    c.holes[3] = { ...c.holes[3], cup: { x: -1, y: 0 } };
    const g = mintGate(c, 'Name');
    expect(g.ok).toBe(false);
    expect(g.reasons.some((r) => /Hole 4: place a cup/.test(r))).toBe(true);
  });

  it('surfaces a structural validator code (unbalanced tunnels)', () => {
    const c = emptyCourse();
    c.holes[0] = { ...c.holes[0], elements: [el(EK.TunnelEntrance, 4, 4)] };
    const g = mintGate(c, 'Name');
    expect(g.ok).toBe(false);
    expect(g.code).toBe('UNBALANCED_TUNNELS');
  });
});

describe('placement helpers', () => {
  it('elementAt finds a placed element or returns -1', () => {
    const h: Hole = { ...emptyHole(), elements: [el(EK.Rock, 5, 5)] };
    expect(elementAt(h, 5, 5)).toBe(0);
    expect(elementAt(h, 6, 6)).toBe(-1);
  });

  it('placeElement adds a new element', () => {
    const h = emptyHole();
    const next = placeElement(h, el(EK.Sand, 3, 3));
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe(EK.Sand);
  });

  it('placeElement replaces on an occupied cell (no duplicate cell)', () => {
    const h: Hole = { ...emptyHole(), elements: [el(EK.Sand, 3, 3)] };
    const next = placeElement(h, el(EK.Water, 3, 3));
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe(EK.Water);
  });

  it('deleteElementAt removes the given index', () => {
    const h: Hole = { ...emptyHole(), elements: [el(EK.Sand, 1, 1), el(EK.Water, 2, 2)] };
    const next = deleteElementAt(h, 0);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe(EK.Water);
  });

  it('rotateElement cycles rot 0→1→2→3→0', () => {
    let e = el(EK.WallStraight, 0, 0);
    e = rotateElement(e); expect(e.rot).toBe(1);
    e = rotateElement(e); expect(e.rot).toBe(2);
    e = rotateElement(e); expect(e.rot).toBe(3);
    e = rotateElement(e); expect(e.rot).toBe(0);
  });

  it('snapCell clamps to the grid', () => {
    const h = emptyHole();
    expect(snapCell(-5, -5, h)).toEqual({ x: 0, y: 0 });
    expect(snapCell(999, 999, h)).toEqual({ x: h.gridW - 1, y: h.gridH - 1 });
    expect(snapCell(3.4, 5.6, h)).toEqual({ x: 3, y: 6 });
  });
});

describe('defaultParams', () => {
  it('gives structured params for pairs/moving/tile/rock and none otherwise', () => {
    expect(defaultParams(EK.Rock).tag).toBe('rock');
    expect(defaultParams(EK.Windmill).tag).toBe('moving');
    expect(defaultParams(EK.SlidingBlock).tag).toBe('sliding');
    expect(defaultParams(EK.TunnelEntrance, 2)).toEqual({ tag: 'pair', pairId: 2 });
    expect(defaultParams(EK.SpeedTile).tag).toBe('tile');
    expect(defaultParams(EK.Fairway).tag).toBe('none');
  });
});
