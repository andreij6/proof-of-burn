// ==========================================
// CourseDataV1 — shared, versioned mini-golf course format (PB-303).
//
// The editor (PB-302) writes this, the engine (engine.ts) reads it, the
// course_nft canister (PB-301) stores the CBOR blob verbatim, and the mint
// flow (PB-304) re-validates the same blob in Rust. This file is the schema
// authority on the TS side; the Rust mirror in PB-304 must serialize the SAME
// CBOR via `ciborium`.
//
// CBOR-lib decision: we hand-implement a tiny *canonical* CBOR subset here
// (small/large uints, definite-length text strings, definite-length arrays,
// and definite-length maps with text-string keys) rather than pull in a
// dependency. Reasons:
//   * The blob is intentionally a narrow shape: small ints, two hex strings,
//     and the documented `[discriminant, ...]` tagged-union arrays. No floats,
//     no tags, no maps-with-non-text-keys, no indefinite lengths.
//   * `ciborium` (Rust) serializes serde structs as CBOR maps keyed by the
//     field NAME (text string), Vec/tuple as arrays, Option<T> as the value or
//     `null`, and integers with the smallest major-0 encoding. We mirror that
//     exactly so a blob written here decodes into the Rust `CourseDataV1` and
//     vice-versa, byte-for-byte for the canonical form.
//   * Avoids adding a network/install dependency to a tiny, frozen format.
//
// CANONICAL TUPLE LAYOUT (shared by the Rust mirror — keep in lockstep):
//   theme  := desert  -> [0]
//             ocean   -> [1]
//             space   -> [2]
//             forest  -> [3]
//             custom  -> [4, primary:tstr, secondary:tstr]
//   params := none    -> [0]
//             rock    -> [1, size:u8(1|2)]
//             moving  -> [2, speed:u8(0|1|2), phase:u8(0..=100)]
//             sliding -> [3, speed:u8, phase:u8, len:u8, axis:u8(0|1)]
//             pair    -> [4, pairId:u8]
//             tile    -> [5, strength:u8(0|1|2)]
// Structs (CourseDataV1/Hole/Cell/Element) are CBOR maps keyed by field name.
// ==========================================

export const COURSE_DATA_VERSION = 1;

// ── Types ──

export type Theme =
  | { kind: 'desert' }
  | { kind: 'ocean' }
  | { kind: 'space' }
  | { kind: 'forest' }
  | { kind: 'custom'; primary: string; secondary: string }; // hex colours

export interface CourseDataV1 {
  version: 1;
  theme: Theme;
  holes: Hole[]; // exactly 9
}

export interface Hole {
  name?: string; // <= 30 chars
  par: number; // 2..=5
  gridW: number; // 8..=40
  gridH: number; // 8..=40
  tee: Cell; // exactly one
  cup: Cell; // exactly one
  elements: Element[];
}

export interface Cell {
  x: number;
  y: number;
}

export interface Element {
  kind: ElementKind;
  x: number;
  y: number; // grid coords (anchor cell)
  rot: 0 | 1 | 2 | 3; // 90° CW steps
  params: ElementParams;
}

export const ElementKind = {
  // terrain
  Fairway: 0,
  Rough: 1,
  Sand: 2,
  Water: 3,
  OutOfBounds: 4,
  // walls
  WallStraight: 10,
  WallCorner: 11,
  WallAngled45: 12,
  WallCurved: 13,
  // static
  Rock: 20,
  Pillar: 21,
  Bumper: 22,
  Tree: 23,
  // moving
  Windmill: 30,
  Pendulum: 31,
  RotatingPaddle: 32,
  SlidingBlock: 33,
  // special
  TunnelEntrance: 40,
  TunnelExit: 41,
  RampUp: 42,
  RampDown: 43,
  SpeedTile: 44,
  SlowTile: 45,
} as const;
export type ElementKind = (typeof ElementKind)[keyof typeof ElementKind];

export const Speed = { Slow: 0, Med: 1, Fast: 2 } as const;
export type Speed = (typeof Speed)[keyof typeof Speed];

export type ElementParams =
  | { tag: 'none' }
  | { tag: 'rock'; size: 1 | 2 }
  | { tag: 'moving'; speed: Speed; phase: number } // 30..33; phase 0..100 (%)
  | { tag: 'sliding'; speed: Speed; phase: number; len: number; axis: 0 | 1 }
  | { tag: 'pair'; pairId: number } // tunnels (40/41), ramps (42/43)
  | { tag: 'tile'; strength: Speed }; // speed/slow tile magnitude

// ── Validation limits (A.4) ──

export const LIMITS = {
  VERSION: 1,
  HOLES: 9,
  GRID_MIN: 8,
  GRID_MAX: 40,
  PAR_MIN: 2,
  PAR_MAX: 5,
  ELEMENTS_PER_HOLE: 200,
  ELEMENTS_PER_COURSE: 1200,
  MOVERS_PER_HOLE: 12,
  TUNNEL_PAIRS: 4,
  RAMP_PAIRS: 4,
  NAME_LEN: 30,
  BLOB_TARGET: 24 * 1024,
  BLOB_CEILING: 64 * 1024,
} as const;

// =====================================================================
// Minimal canonical CBOR codec (the narrow subset described above).
// =====================================================================

class CborWriter {
  private parts: number[] = [];

  private head(major: number, value: number): void {
    const mt = major << 5;
    if (value < 24) {
      this.parts.push(mt | value);
    } else if (value < 0x100) {
      this.parts.push(mt | 24, value);
    } else if (value < 0x10000) {
      this.parts.push(mt | 25, (value >> 8) & 0xff, value & 0xff);
    } else if (value < 0x100000000) {
      this.parts.push(
        mt | 26,
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      );
    } else {
      // 64-bit length — not expected for this format, but encode correctly.
      const hi = Math.floor(value / 0x100000000);
      const lo = value >>> 0;
      this.parts.push(
        mt | 27,
        (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
        (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
      );
    }
  }

  uint(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`CBOR uint expects a non-negative integer, got ${value}`);
    }
    this.head(0, value);
  }

  text(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.head(3, bytes.length);
    for (const b of bytes) this.parts.push(b);
  }

  arrayHeader(n: number): void {
    this.head(4, n);
  }

  mapHeader(n: number): void {
    this.head(5, n);
  }

  nullValue(): void {
    this.parts.push(0xf6); // major 7, simple 22 (null)
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

class CborReader {
  private i = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  private byte(): number {
    if (this.i >= this.buf.length) throw new Error('CBOR: unexpected end of input');
    return this.buf[this.i++];
  }

  private readHead(): { major: number; value: number } {
    const ib = this.byte();
    const major = ib >> 5;
    const ai = ib & 0x1f;
    let value: number;
    if (ai < 24) value = ai;
    else if (ai === 24) value = this.byte();
    else if (ai === 25) value = (this.byte() << 8) | this.byte();
    else if (ai === 26)
      value = ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
    else if (ai === 27) {
      const hi =
        ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
      const lo =
        ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
      value = hi * 0x100000000 + lo;
    } else throw new Error(`CBOR: unsupported additional info ${ai}`);
    return { major, value };
  }

  uint(): number {
    const { major, value } = this.readHead();
    if (major !== 0) throw new Error(`CBOR: expected uint (major 0), got major ${major}`);
    return value;
  }

  text(): string {
    const { major, value } = this.readHead();
    if (major !== 3) throw new Error(`CBOR: expected text (major 3), got major ${major}`);
    const slice = this.buf.subarray(this.i, this.i + value);
    this.i += value;
    return new TextDecoder().decode(slice);
  }

  arrayHeader(): number {
    const { major, value } = this.readHead();
    if (major !== 4) throw new Error(`CBOR: expected array (major 4), got major ${major}`);
    return value;
  }

  mapHeader(): number {
    const { major, value } = this.readHead();
    if (major !== 5) throw new Error(`CBOR: expected map (major 5), got major ${major}`);
    return value;
  }

  /** Reads a value that is either text or null (Option<String>). */
  textOrNull(): string | null {
    if (this.buf[this.i] === 0xf6) {
      this.i++;
      return null;
    }
    return this.text();
  }

  done(): boolean {
    return this.i >= this.buf.length;
  }
}

// ── theme / params tuple codecs ──

function writeTheme(w: CborWriter, theme: Theme): void {
  switch (theme.kind) {
    case 'desert':
      w.arrayHeader(1);
      w.uint(0);
      return;
    case 'ocean':
      w.arrayHeader(1);
      w.uint(1);
      return;
    case 'space':
      w.arrayHeader(1);
      w.uint(2);
      return;
    case 'forest':
      w.arrayHeader(1);
      w.uint(3);
      return;
    case 'custom':
      w.arrayHeader(3);
      w.uint(4);
      w.text(theme.primary);
      w.text(theme.secondary);
      return;
  }
}

function readTheme(r: CborReader): Theme {
  const n = r.arrayHeader();
  const disc = r.uint();
  switch (disc) {
    case 0:
      return { kind: 'desert' };
    case 1:
      return { kind: 'ocean' };
    case 2:
      return { kind: 'space' };
    case 3:
      return { kind: 'forest' };
    case 4: {
      if (n !== 3) throw new Error(`CBOR: custom theme expects 3 elements, got ${n}`);
      const primary = r.text();
      const secondary = r.text();
      return { kind: 'custom', primary, secondary };
    }
    default:
      throw new Error(`CBOR: unknown theme discriminant ${disc}`);
  }
}

function writeParams(w: CborWriter, p: ElementParams): void {
  switch (p.tag) {
    case 'none':
      w.arrayHeader(1);
      w.uint(0);
      return;
    case 'rock':
      w.arrayHeader(2);
      w.uint(1);
      w.uint(p.size);
      return;
    case 'moving':
      w.arrayHeader(3);
      w.uint(2);
      w.uint(p.speed);
      w.uint(p.phase);
      return;
    case 'sliding':
      w.arrayHeader(5);
      w.uint(3);
      w.uint(p.speed);
      w.uint(p.phase);
      w.uint(p.len);
      w.uint(p.axis);
      return;
    case 'pair':
      w.arrayHeader(2);
      w.uint(4);
      w.uint(p.pairId);
      return;
    case 'tile':
      w.arrayHeader(2);
      w.uint(5);
      w.uint(p.strength);
      return;
  }
}

function readParams(r: CborReader): ElementParams {
  const n = r.arrayHeader();
  const disc = r.uint();
  switch (disc) {
    case 0:
      return { tag: 'none' };
    case 1:
      return { tag: 'rock', size: r.uint() as 1 | 2 };
    case 2:
      return { tag: 'moving', speed: r.uint() as Speed, phase: r.uint() };
    case 3:
      return {
        tag: 'sliding',
        speed: r.uint() as Speed,
        phase: r.uint(),
        len: r.uint(),
        axis: r.uint() as 0 | 1,
      };
    case 4:
      return { tag: 'pair', pairId: r.uint() };
    case 5:
      return { tag: 'tile', strength: r.uint() as Speed };
    default:
      throw new Error(`CBOR: unknown params discriminant ${disc} (len ${n})`);
  }
}

// ── struct codecs (maps keyed by field name) ──

function writeCell(w: CborWriter, c: Cell): void {
  w.mapHeader(2);
  w.text('x');
  w.uint(c.x);
  w.text('y');
  w.uint(c.y);
}

function readCell(r: CborReader): Cell {
  const n = r.mapHeader();
  let x = 0;
  let y = 0;
  for (let k = 0; k < n; k++) {
    const key = r.text();
    if (key === 'x') x = r.uint();
    else if (key === 'y') y = r.uint();
    else throw new Error(`CBOR: unexpected Cell key '${key}'`);
  }
  return { x, y };
}

function writeElement(w: CborWriter, e: Element): void {
  w.mapHeader(5);
  w.text('kind');
  w.uint(e.kind);
  w.text('x');
  w.uint(e.x);
  w.text('y');
  w.uint(e.y);
  w.text('rot');
  w.uint(e.rot);
  w.text('params');
  writeParams(w, e.params);
}

function readElement(r: CborReader): Element {
  const n = r.mapHeader();
  let kind = 0 as ElementKind;
  let x = 0;
  let y = 0;
  let rot = 0 as 0 | 1 | 2 | 3;
  let params: ElementParams = { tag: 'none' };
  for (let k = 0; k < n; k++) {
    const key = r.text();
    if (key === 'kind') kind = r.uint() as ElementKind;
    else if (key === 'x') x = r.uint();
    else if (key === 'y') y = r.uint();
    else if (key === 'rot') rot = r.uint() as 0 | 1 | 2 | 3;
    else if (key === 'params') params = readParams(r);
    else throw new Error(`CBOR: unexpected Element key '${key}'`);
  }
  return { kind, x, y, rot, params };
}

function writeHole(w: CborWriter, h: Hole): void {
  // Always emit all 7 fields (name as text or null) — matches a Rust struct
  // map with `Option<String>` serialized as value-or-null.
  w.mapHeader(7);
  w.text('name');
  if (h.name === undefined || h.name === null) w.nullValue();
  else w.text(h.name);
  w.text('par');
  w.uint(h.par);
  w.text('grid_w');
  w.uint(h.gridW);
  w.text('grid_h');
  w.uint(h.gridH);
  w.text('tee');
  writeCell(w, h.tee);
  w.text('cup');
  writeCell(w, h.cup);
  w.text('elements');
  w.arrayHeader(h.elements.length);
  for (const e of h.elements) writeElement(w, e);
}

function readHole(r: CborReader): Hole {
  const n = r.mapHeader();
  let name: string | undefined;
  let par = 0;
  let gridW = 0;
  let gridH = 0;
  let tee: Cell = { x: 0, y: 0 };
  let cup: Cell = { x: 0, y: 0 };
  let elements: Element[] = [];
  for (let k = 0; k < n; k++) {
    const key = r.text();
    switch (key) {
      case 'name': {
        const v = r.textOrNull();
        name = v === null ? undefined : v;
        break;
      }
      case 'par':
        par = r.uint();
        break;
      case 'grid_w':
        gridW = r.uint();
        break;
      case 'grid_h':
        gridH = r.uint();
        break;
      case 'tee':
        tee = readCell(r);
        break;
      case 'cup':
        cup = readCell(r);
        break;
      case 'elements': {
        const en = r.arrayHeader();
        elements = [];
        for (let j = 0; j < en; j++) elements.push(readElement(r));
        break;
      }
      default:
        throw new Error(`CBOR: unexpected Hole key '${key}'`);
    }
  }
  const hole: Hole = { par, gridW, gridH, tee, cup, elements };
  if (name !== undefined) hole.name = name;
  return hole;
}

// ── public API ──

export function encodeCourseData(c: CourseDataV1): Uint8Array {
  const w = new CborWriter();
  w.mapHeader(3);
  w.text('version');
  w.uint(c.version);
  w.text('theme');
  writeTheme(w, c.theme);
  w.text('holes');
  w.arrayHeader(c.holes.length);
  for (const h of c.holes) writeHole(w, h);
  return w.bytes();
}

export function decodeCourseData(blob: Uint8Array): CourseDataV1 {
  const r = new CborReader(blob);
  const n = r.mapHeader();
  let version = 0;
  let theme: Theme = { kind: 'desert' };
  let holes: Hole[] = [];
  for (let k = 0; k < n; k++) {
    const key = r.text();
    switch (key) {
      case 'version':
        version = r.uint();
        break;
      case 'theme':
        theme = readTheme(r);
        break;
      case 'holes': {
        const hn = r.arrayHeader();
        holes = [];
        for (let j = 0; j < hn; j++) holes.push(readHole(r));
        break;
      }
      default:
        throw new Error(`CBOR: unexpected CourseDataV1 key '${key}'`);
    }
  }
  return { version: version as 1, theme, holes };
}

// =====================================================================
// Validation (A.4) — returns null when valid, or a stable INVALID_* code.
// =====================================================================

const MOVING_KINDS = new Set<number>([
  ElementKind.Windmill,
  ElementKind.Pendulum,
  ElementKind.RotatingPaddle,
  ElementKind.SlidingBlock,
]);

/**
 * Validate a CourseDataV1. Returns null if valid, otherwise a stable string
 * error code mirroring the backend's `validate_arcade_hole` style.
 */
export function validateCourseData(c: CourseDataV1): string | null {
  if (c.version !== LIMITS.VERSION) return 'INVALID_VERSION';
  if (!Array.isArray(c.holes) || c.holes.length !== LIMITS.HOLES) return 'WRONG_HOLE_COUNT';

  let totalElements = 0;
  for (const h of c.holes) {
    if (h.par < LIMITS.PAR_MIN || h.par > LIMITS.PAR_MAX) return 'INVALID_PAR';
    if (h.gridW < LIMITS.GRID_MIN || h.gridW > LIMITS.GRID_MAX) return 'INVALID_GRID';
    if (h.gridH < LIMITS.GRID_MIN || h.gridH > LIMITS.GRID_MAX) return 'INVALID_GRID';
    if (h.name !== undefined && h.name.length > LIMITS.NAME_LEN) return 'NAME_TOO_LONG';

    if (!inGrid(h.tee, h)) return 'OFF_GRID';
    if (!inGrid(h.cup, h)) return 'OFF_GRID';

    if (h.elements.length > LIMITS.ELEMENTS_PER_HOLE) return 'TOO_MANY_ELEMENTS';
    totalElements += h.elements.length;
    if (totalElements > LIMITS.ELEMENTS_PER_COURSE) return 'TOO_MANY_ELEMENTS';

    let movers = 0;
    let tunnelEntr = 0;
    let tunnelExit = 0;
    let rampUp = 0;
    let rampDown = 0;
    for (const e of h.elements) {
      if (!inGrid(e, h)) return 'OFF_GRID';
      if (e.rot < 0 || e.rot > 3) return 'INVALID_ROT';
      if (MOVING_KINDS.has(e.kind)) movers++;
      if (e.kind === ElementKind.TunnelEntrance) tunnelEntr++;
      else if (e.kind === ElementKind.TunnelExit) tunnelExit++;
      else if (e.kind === ElementKind.RampUp) rampUp++;
      else if (e.kind === ElementKind.RampDown) rampDown++;
    }
    if (movers > LIMITS.MOVERS_PER_HOLE) return 'TOO_MANY_MOVERS';

    // Exactly one tee + one cup per hole (the tee/cup live on the Hole, but a
    // misauthored course may also place them as elements — guard both).
    const teeEls = h.elements.filter((e) => (e.kind as number) === TEE_ELEMENT_KIND).length;
    const cupEls = h.elements.filter((e) => (e.kind as number) === CUP_ELEMENT_KIND).length;
    // The canonical tee/cup are the Hole.tee/Hole.cup fields. We require them
    // present (they always are, structurally) and reject extra placed ones.
    if (teeEls > 0) return 'MULTIPLE_TEES';
    if (cupEls > 0) return 'MULTIPLE_CUPS';

    if (tunnelEntr !== tunnelExit) return 'UNBALANCED_TUNNELS';
    if (tunnelEntr > LIMITS.TUNNEL_PAIRS) return 'TOO_MANY_TUNNELS';
    if (rampUp !== rampDown) return 'UNBALANCED_RAMPS';
    if (rampUp > LIMITS.RAMP_PAIRS) return 'TOO_MANY_RAMPS';
  }

  // Blob-size ceiling (the hard backstop). Editor warns past BLOB_TARGET but
  // only the ceiling is a hard reject here (mirrors PB-301 A.5).
  const blob = encodeCourseData(c);
  if (blob.length > LIMITS.BLOB_CEILING) return 'BLOB_TOO_LARGE';

  return null;
}

// Tee/Cup are not ElementKinds in this schema (they live on Hole), but we
// reserve sentinel ids so a future editor that *also* emits them as elements
// is caught by validation. These are intentionally outside the catalog above.
const TEE_ELEMENT_KIND = 60;
const CUP_ELEMENT_KIND = 61;

function inGrid(c: Cell, h: Hole): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < h.gridW && c.y < h.gridH;
}
