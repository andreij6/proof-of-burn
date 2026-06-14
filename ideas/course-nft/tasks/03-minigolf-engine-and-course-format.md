# PB-303 — Mini-golf engine & shared `course_data` format

> The shared, versioned `course_data` serialization format (CBOR `CourseDataV1`)
> **and** the physics-engine extension that plays it. Read
> [`00-overview-and-architecture.md`](00-overview-and-architecture.md) first — this
> spec expands the `CourseDataV1` skeleton from §4 and inherits decisions **D1/D4**.

Decision **D4**: the marketplace replaces the built-in course; the existing engine
in `src/frontend/src/arcade/engine.ts` is **extended** (not rewritten) to support
the full element catalog from [`course-editor.md`](../course-editor.md).
Decision **D1**: anti-cheat is a signed play-session + per-day caps (PB-306), **not**
server-side physics replay — so the engine stays **entirely client-side** and never
needs to be ported to Rust or run deterministically on-chain.

This is the format authority: the editor (PB-302) writes `CourseDataV1`, the engine
(this spec) reads it, the `course_nft` canister (PB-301) stores the CBOR verbatim,
and the mint flow (PB-304) re-validates the hard limits below.

---

## Part A — Design / behaviour

### A.1 What "the format" must encode

One `CourseDataV1` = a full 9-hole course: a theme + 9 holes, each a grid with a
tee, a cup, a par, and a list of placed elements. Every element from the editor's
catalog must be representable losslessly:

- **Terrain** (cell fills): fairway, rough, sand, water, out-of-bounds.
- **Walls**: straight, corner, 45° (angled), curved.
- **Static**: rock (1×1 and 2×1), pillar, bumper, tree.
- **Moving**: windmill arm, pendulum, rotating paddle, sliding block — each with
  Slow/Med/Fast speed and a 0–100% start phase.
- **Special**: tunnel entrance/exit pairs, ramp up/down pairs, speed tile, slow tile.

The existing on-chain `ArcadeHoleDef` (a flat 22×14 `Vec<u8>` cell array + up to 2
windmill bars) is **superseded** by this richer element-list format. The two
coexist only transitionally — see A.5 and PB-309.

### A.2 Coordinate & timing model (carry over from the live engine)

- Grid coords are integer `(x, y)`, origin top-left, `x` right / `y` down — same as
  the live `cellAt`/`parseAscii` convention in `engine.ts`.
- World px = `cell * CELL` (`CELL = 40`, unchanged). The engine compiles grid coords
  to world px on load, exactly as `holeFromBackend` does today.
- `rot: 0..3` = 90° clockwise steps (0=up/north, 1=east, 2=south, 3=west), matching
  the editor's R-key rotate.
- Physics stay on the **fixed 120 Hz step** (`STEP = 1/120`) the engine already uses.
  Moving obstacles are a pure function of an absolute hole clock `tSec` (already
  threaded through `stepHole(state, def, tSec)` and `barEndpoints`), so timing is
  reproducible within a session and "fair" (every player who starts a hole sees the
  obstacle in the same phase at the same elapsed time). This is *fairness*, not
  *anti-cheat* — D1 keeps verification on the signed session, not on replaying physics.

### A.3 Element gameplay semantics

| Element | Physics behaviour (engine) |
|---|---|
| Fairway | normal rolling surface (`FRICTION_GREEN`). |
| Rough | heavier friction (between green and sand) — slows the ball. |
| Sand | heavy friction (`FRICTION_SAND`) — hard to escape at low power. |
| Water | splash → ball returns to pre-shot spot, +1 penalty stroke (existing path). |
| Out-of-bounds | solid edge; ball resets on contact (treat as Void today). |
| Straight wall | reflect at angle of incidence (existing cube/segment bounce). |
| Corner wall | two-faced reflector for enclosed fairways (oriented by `rot`). |
| Angled wall (45°) | diagonal reflector — redirects at 45° (bank shots). |
| Curved wall | quarter-arc reflector — smooth boundary curve. |
| Rock | solid block bounce; size from params (1×1 or 2×1). |
| Pillar | round solid (existing `Post` circle bounce). |
| Bumper | round solid that **adds** outbound speed on contact (restitution > 1, capped). |
| Tree | identical physics to rock (decorative + solid). |
| Windmill arm | rotating segment about a centre (existing `MovingBar`, generalised). |
| Pendulum | segment swinging through an arc about a pivot; angle = `f(phase, speed, t)`. |
| Rotating paddle | segment spinning about **one end** (offset pivot vs windmill's centre). |
| Sliding block | solid block translating back-and-forth along an axis path. |
| Tunnel pair | ball entering entrance teleports to the paired exit, momentum preserved (direction rotated to the exit's `rot`). |
| Ramp pair | on contact the ball is redirected along the ramp's facing (`rot`); paired up/down for routing. |
| Speed tile | boosts ball speed in the tile's facing direction (conveyor). |
| Slow tile | sharply reduces ball speed (precision sections). |

Determinism note for moving obstacles: the hole clock `tSec` resets to 0 at the
start of each hole (`initHole`), and each moving element's instantaneous geometry is
`g(centre, len, baseSpeed*speedMult, phase0, tSec)`. No RNG anywhere in the engine.

### A.4 Hard validation limits (concrete numbers)

Enforced client-side by the editor (PB-302) **and** independently re-validated by
the backend at mint (PB-304) by CBOR-decoding the blob:

| Limit | Value | Why |
|---|---|---|
| `version` | must == 1 | forward-compat gate. |
| holes per course | **exactly 9** | design rule; mint rejects otherwise. |
| grid_w, grid_h | each **8..=40** | keeps a hole renderable + blob small. |
| par per hole | **2..=5** | design rule (par_total 18..=45). |
| tee per hole | **exactly 1** | required element. |
| cup per hole | **exactly 1** | required element. |
| elements per hole | **<= 200** | bounds blob + render cost. |
| total elements per course | **<= 1200** | bounds blob across 9 holes. |
| moving elements per hole | **<= 12** | bounds per-step collision cost. |
| tunnel entrances == tunnel exits (per hole) | **balanced**, <= 4 pairs | unpaired tunnel is unplayable. |
| ramp up == ramp down (per hole) | **balanced**, <= 4 pairs | unpaired ramp is unplayable. |
| hole name | `Option`, **<= 30 chars** | design rule. |
| element x,y | within `[0, grid_w) × [0, grid_h)` | no off-grid elements. |
| **serialized blob (whole course)** | **<= 24 KiB** target / **64 KiB** hard ceiling | mint arg + `icrc7_token_metadata` reply stay well under the 2 MiB message cap. The 64 KiB ceiling is the canister backstop (PB-301 A.5); the editor targets <= 24 KiB and warns past it. |

Validation returns a stable string error code (the `INVALID_*` style the backend
already uses for `validate_arcade_hole`, e.g. `WRONG_HOLE_COUNT`, `INVALID_PAR`,
`NO_TEE`, `MULTIPLE_CUPS`, `UNBALANCED_TUNNELS`, `TOO_MANY_ELEMENTS`, `BLOB_TOO_LARGE`).

### A.5 Coexistence with the existing `ArcadeHoleDef`

`ArcadeHoleDef` / `ARCADE_COURSE` / `validate_arcade_hole` / `get_arcade_course` /
`admin_set_arcade_hole` (backend `lib.rs` §17, MemoryId 45) and the built-in
`COURSE`/`DEFAULT_HOLES` in `engine.ts` describe the *single built-in* course. They
are **replaced** by the marketplace + `CourseDataV1` and removed by **PB-309**
(leaderboard removal & arcade migration). This spec does **not** delete them; it adds
the new format + engine paths alongside so PB-302/304/305 can build against the new
format while the old built-in still runs until PB-309 cuts it over. New code must not
extend `ArcadeHoleDef`.

### A.6 Visual rendering layer — designed for upgrade (art is swappable)

The first-pass art for several elements (sand traps, walls, the windmill, …) is
intentionally low-fidelity. The design **must** let visuals be upgraded later — to
richer sprites, vector art, themed art packs, or even a different canvas/WebGL
backend — **without** touching the data format, the physics, already-minted NFTs, or
a course's playability. This is an explicit invariant of the feature.

**Separation contract (hard rule):**

| Layer | Owns | Must NOT contain |
|---|---|---|
| `course_data` (on-chain, B.1) | logical elements only: `ElementKind`, grid transform (`x,y,rot`), gameplay `params` (speed/phase/path) | any pixels, colours, px sizes, sprites, or art references |
| Engine (`engine.ts`) | physics + **canonical collision geometry** (`HoleDef`, `moverGeometry`) + gameplay events | drawing / art |
| **Render layer** (`MiniGolf.tsx` + a new `RenderKit`) | all visuals: how each `(ElementKind, Theme)` is drawn/animated, sprites, palettes, FX | gameplay rules or collision geometry |

Because art lives only in the render layer (shipped with the frontend), an art
upgrade is a **pure client-side change**: no `CourseDataV1` version bump, no re-mint,
no physics edit. Every existing course — including minted NFTs — renders with the new
art automatically on next load (art is *not* stored on-chain; only logical kinds are).

**Pluggable `RenderKit`.** Drawing is routed through a kit interface keyed by element
kind so a better kit drops in behind the same contract:

```ts
// The engine hands the render layer canonical geometry; the kit only decides looks.
export interface RenderKit {
  id: string;                 // 'primitive-v1' (today) | 'sprite-v2' | …
  drawTerrain(ctx: Renderer, hole: HoleDef, theme: Theme): void;
  drawElement(ctx: Renderer, el: PlacedElement, view: ElementView, theme: Theme, tSec: number): void;
  drawBall(ctx: Renderer, ball: BallView, theme: Theme): void;
}
```

- `ElementView` / `BallView` are derived from the engine's canonical state (position,
  rotation, and for movers the `moverGeometry(m, tSec)` segment). The kit **consumes**
  geometry; it never recomputes physics.
- Today's primitive shapes become **`RenderKit` `primitive-v1`**. A future `sprite-v2`
  (or a per-`Theme` art pack) is selected at render time behind a single swap point
  (config / feature flag); kits may even be chosen per `Theme`.
- The editor palette/canvas (PB-302) and the play view (PB-309) **render through the
  same `RenderKit`**, so they always match and upgrade together.

**Visual vs. collision geometry.** The engine's hitbox (the windmill-arm segment from
`moverGeometry`, a wall segment, a sand-cell mask) is canonical and **frozen by
gameplay**. A `RenderKit` may draw something far more detailed or animated on top (a
textured spinning windmill, beveled walls, granular sand) as long as it visually tracks
that same geometry. So "make the windmill look good" is a render-only task that cannot
change how it plays — or a course's `par` / difficulty bucket.

**Theme as a render concern.** `Theme` already has no physics effect; the render layer
resolves `(ElementKind, Theme, RenderKit)` → art, so adding a theme or art pack needs
no schema or engine change. New themes beyond the current five are additive at the
render layer; the `course_data` `Theme` enum gains a variant (`#[serde(default)]`-safe),
old courses unaffected.

---

## Part B — Implementation

### B.1 `CourseDataV1` CBOR schema (the authority)

Defined twice in lockstep: **Rust** (in PB-304's backend section, for mint
re-validation) and **TypeScript** (here, for editor + engine). Both serialize the
**same CBOR** via `ciborium` (Rust) / a CBOR lib (TS) so a blob written by the editor
decodes identically in the backend and is stored verbatim by `course_nft` (PB-301).

TypeScript shape (new file `src/frontend/src/arcade/courseData.ts`):

```ts
export const COURSE_DATA_VERSION = 1;

export type Theme =
  | { kind: 'desert' } | { kind: 'ocean' } | { kind: 'space' } | { kind: 'forest' }
  | { kind: 'custom'; primary: string; secondary: string }; // hex colours

export interface CourseDataV1 {
  version: 1;
  theme: Theme;
  holes: Hole[];            // exactly 9
}

export interface Hole {
  name?: string;            // <= 30 chars
  par: number;              // 2..=5
  gridW: number;            // 8..=40
  gridH: number;            // 8..=40
  tee: Cell;                // exactly one
  cup: Cell;                // exactly one
  elements: Element[];      // terrain, walls, static, moving, special
}

export interface Cell { x: number; y: number }   // integer grid coords

export interface Element {
  kind: ElementKind;
  x: number; y: number;     // grid coords (anchor cell)
  rot: 0 | 1 | 2 | 3;       // 90° CW steps
  params: ElementParams;
}

export const ElementKind = {
  // terrain
  Fairway: 0, Rough: 1, Sand: 2, Water: 3, OutOfBounds: 4,
  // walls
  WallStraight: 10, WallCorner: 11, WallAngled45: 12, WallCurved: 13,
  // static
  Rock: 20, Pillar: 21, Bumper: 22, Tree: 23,
  // moving
  Windmill: 30, Pendulum: 31, RotatingPaddle: 32, SlidingBlock: 33,
  // special
  TunnelEntrance: 40, TunnelExit: 41, RampUp: 42, RampDown: 43,
  SpeedTile: 44, SlowTile: 45,
} as const;
export type ElementKind = typeof ElementKind[keyof typeof ElementKind];

export const Speed = { Slow: 0, Med: 1, Fast: 2 } as const;
export type Speed = typeof Speed[keyof typeof Speed];

// params is a tagged union keyed off kind — only the fields that kind needs:
export type ElementParams =
  | { tag: 'none' }                                    // most terrain/walls/static
  | { tag: 'rock'; size: 1 | 2 }                       // Rock (1x1 | 2x1)
  | { tag: 'moving'; speed: Speed; phase: number }     // 30..33; phase 0..100 (%)
  | { tag: 'sliding'; speed: Speed; phase: number; len: number; axis: 0 | 1 } // + path
  | { tag: 'pair'; pairId: number }                    // tunnels (40/41), ramps (42/43)
  | { tag: 'tile'; strength: Speed };                  // speed/slow tile magnitude
```

CBOR encoding rules (so Rust and TS agree byte-for-byte):
- Encode enums as their **integer discriminant** (the numbers above), not as
  strings — keeps the blob small and language-agnostic.
- `theme` and `params` are CBOR **arrays** `[discriminant, ...payload]` (a compact
  tagged-union encoding both `ciborium` and TS CBOR can emit/read deterministically).
  Document the exact tuple per variant in a comment block shared by both definitions.
- `phase` stored as `u8` (0..=100). `len` (sliding-block path length) in cells, `u8`.
- No floats in the blob — everything is small ints + the two theme hex strings.

Matching Rust (lives in PB-304's backend `// 20. Course NFT marketplace` section,
re-validated at mint):

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CourseDataV1 {
    pub version: u8,                 // == 1
    pub theme: Theme,
    pub holes: Vec<Hole>,           // len == 9
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hole {
    #[serde(default)] pub name: Option<String>,
    pub par: u8,
    pub grid_w: u16, pub grid_h: u16,
    pub tee: Cell, pub cup: Cell,
    pub elements: Vec<Element>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Cell { pub x: u16, pub y: u16 }
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Element { pub kind: u8, pub x: u16, pub y: u16, pub rot: u8, pub params: ElementParams }
```

`#[serde(default)]` on every optional/added field (upgrade safety). The backend
`validate_course_data(blob) -> Result<u16 /*par_total*/, String>` decodes and checks
every A.4 limit; PB-304 calls it before forwarding to `course_nft::mint`.

### B.2 Engine extension (`src/frontend/src/arcade/engine.ts`)

Extend, don't rewrite. The current engine already gives us: the 120 Hz `stepHole`,
the `tSec` hole clock, circle-vs-cell AABB bounce (`collideCell`), circle-vs-segment
bounce (`collideBar`/`bounceFrom`), slope acceleration, water penalty, friction
(green/sand), cup capture, and the 12-stroke cap. The extension adds:

1. **Loader** `holeFromCourseData(hole: Hole): HoleDef` — compile `CourseDataV1`
   grid coords to the existing world-px `HoleDef` (mirror `holeFromBackend`). It
   rasterizes terrain elements into the `cells` array (fairway/rough/sand/water/OOB
   → cell types) and collects non-cell elements (walls, static, moving, special)
   into new typed arrays on `HoleDef`. Add a sibling `courseFromData(data:
   CourseDataV1): HoleDef[]` returning all 9.

2. **`HoleDef` additions** (new optional arrays; existing fields unchanged so the
   built-in `COURSE` keeps working until PB-309):
   ```ts
   interface HoleDef {
     // …existing: name, par, w, h, cells, tee, cup, bars…
     walls?: WallSeg[];        // straight/corner/45/curved → world-px segments
     statics?: StaticObs[];    // rock/pillar/bumper/tree → world-px circles/boxes
     movers?: Mover[];         // windmill/pendulum/paddle/sliding (generalises bars)
     tunnels?: TunnelPair[];   // entrance+exit world-px portals
     ramps?: RampPair[];
     tiles?: SpeedSlowTile[];  // speed/slow tiles (cell-keyed, signed magnitude)
   }
   ```
   `bars` is retained for the old built-in; new courses populate `movers` (a
   superset). A `Mover` carries `{ kind, pivot, len, baseSpeed, phase0, axis?, slideLen? }`
   and exposes a `moverGeometry(m, tSec)` returning the segment/box for that step —
   generalising `barEndpoints`.

3. **`CELL_FRICTION`** — add a `Rough` friction constant
   (`FRICTION_ROUGH` between green and sand) and route it in `stepHole`'s friction
   pick alongside the existing sand branch.

4. **Collision additions in `stepHole`** (called each 120 Hz step, after the existing
   cell/bar passes, all using the existing `bounceFrom` primitive so behaviour is
   consistent):
   - **walls**: segment bounce per `WallSeg` (straight/45°/curved approximated as one
     or a few segments; corner as two). Reuse `collideBar`'s segment math.
   - **statics**: rock/tree as AABB (`collideCell`-style), pillar as circle
     (`bounceFrom` with `POST_R`), bumper as circle with a **speed add** on contact
     (`vel *= BUMPER_GAIN`, capped at `MAX_POWER`).
   - **movers**: compute geometry at `tSec`, then segment/box bounce. Windmill =
     centre-pivot segment (today's bar); pendulum = pivot-arc segment; paddle =
     end-pivot segment; sliding block = translating AABB. Speed multiplier from the
     Slow/Med/Fast enum (`{slow,med,fast}` rad/s or px/s constants); `phase0 =
     phasePct/100 * cycle`.
   - **tiles**: on the cell under the ball, add a directional impulse
     (`SpeedTile`, `+TILE_BOOST` along `rot`) or scale velocity down (`SlowTile`,
     `*TILE_SLOW`). Cheap O(1) cell lookup like the slope branch.
   - **ramps**: on entering a ramp cell, set velocity direction to the ramp's `rot`
     facing (preserve speed magnitude) — routing redirect.
   - **tunnels**: when the ball centre enters an entrance portal radius, teleport
     `pos` to the paired exit, rotate `vel` by the exit-vs-entrance `rot` delta
     (momentum preserved), and apply a one-step cooldown so the ball doesn't
     immediately re-enter the exit (which is itself the paired entrance's mate).

5. **Events**: extend `HoleState.event` union with `'bumper' | 'tunnel' | 'ramp' |
   'tile'` for render-layer SFX/FX. The active `RenderKit` (A.6) consumes these; the
   engine only **emits** them and never draws. Render work is PB-302/PB-309's surface.

No change to the public putt API (`dragToShot`, `strike`, cup capture, stroke cap,
water) — new courses play with the same controls.

### B.3 Speed/phase constants

```ts
export const MOVER_SPEED = { 0: 0.9, 1: 1.9, 2: 3.4 };  // rad/s (windmill/pendulum/paddle)
export const SLIDE_SPEED  = { 0: 60,  1: 130, 2: 240 };  // px/s (sliding block)
export const FRICTION_ROUGH = 0.972;                     // between green .9905 and sand .94
export const BUMPER_GAIN = 1.6;                          // outbound speed multiplier (capped at MAX_POWER)
export const TILE_BOOST = 220;                           // px/s impulse along a speed tile
export const TILE_SLOW = 0.80;                           // per-step velocity scale on a slow tile
export const TUNNEL_R = 16;                              // portal capture radius (px)
```

(Numbers are starting points to be tuned in playtest — they live as named constants
so the editor's Slow/Med/Fast labels map cleanly and tests assert relative ordering,
not exact magnitudes.)

### B.4 Files touched

- `src/frontend/src/arcade/courseData.ts` — **new**: `CourseDataV1` types + CBOR
  encode/decode (`encodeCourseData`/`decodeCourseData`) + client-side
  `validateCourseData` (returns `INVALID_*` codes from A.4).
- `src/frontend/src/arcade/engine.ts` — **extended**: `HoleDef` fields, loader
  (`holeFromCourseData`/`courseFromData`), new constants, new collision branches in
  `stepHole`, `moverGeometry`, extended `event` union.
- `src/frontend/src/test/minigolf.test.ts` — **extended** (see Test plan).
- Rust `CourseDataV1` + `validate_course_data` land in **PB-304**'s backend section
  (this spec is the schema authority; PB-304 implements the Rust mirror + mint
  re-validation). They are listed here so both sides cite one schema.

---

## Acceptance criteria

- `CourseDataV1` round-trips: `decodeCourseData(encodeCourseData(c))` deep-equals `c`
  for a course exercising every `ElementKind` (TS), and the same bytes decode into
  the equivalent Rust `CourseDataV1` (asserted in PB-304's Rust tests).
- `validateCourseData` accepts a valid 9-hole course and rejects, with the right
  `INVALID_*` code, each of: wrong hole count, par out of 2–5, missing/duplicate
  tee, missing/duplicate cup, > 200 elements/hole, unbalanced tunnels, unbalanced
  ramps, off-grid element, > 64 KiB blob.
- `holeFromCourseData` compiles a hole so the engine plays it; terrain rasterizes to
  the right cell types; every non-cell element appears in the matching `HoleDef`
  array.
- Each new element produces its specified physics effect in `stepHole`:
  rough slows more than green and less than sand; bumper increases outbound speed;
  speed tile increases speed along its facing; slow tile reduces it; a ball entering a
  tunnel entrance emerges at the paired exit with preserved momentum; a windmill/
  pendulum/paddle/sliding-block deflects a ball that crosses it; ramp redirects.
- Moving-obstacle geometry is a pure function of `tSec` (same `tSec` ⇒ same geometry;
  no RNG) — fairness per A.2.
- The existing built-in `COURSE` and all current `minigolf.test.ts` cases still pass
  (extension is additive; `bars` path untouched).

## Test plan

Extend `src/frontend/src/test/minigolf.test.ts` (vitest), plus add
`courseData.test.ts`:

- **Serialize round-trip**: build a `CourseDataV1` using every `ElementKind`;
  `decode(encode(c))` deep-equals; assert encoded length < 24 KiB.
- **Validation limits** — one test per A.4 rule, asserting the exact error code:
  wrong hole count, par 1 / par 6, no tee, two tees, no cup, two cups, 201 elements,
  3 tunnel entrances + 2 exits (unbalanced), ramp imbalance, off-grid element,
  oversize blob (> 64 KiB) → `BLOB_TOO_LARGE`.
- **Loader**: `holeFromCourseData` rasterizes terrain (sample cells equal expected
  `CellType`) and populates `walls`/`statics`/`movers`/`tunnels`/`ramps`/`tiles`.
- **Per-element physics** (build a tiny hole with the one element, settle the ball):
  - rough: travel distance between green and sand (`green > rough > sand`).
  - bumper: post-contact speed > pre-contact along the normal.
  - pillar/rock/tree: ball stays out, reflects (reuse the existing wall assertions).
  - windmill/pendulum/paddle: a ball crossing the swept region is deflected
    (position differs vs no-obstacle control), and `moverGeometry(m, t)` is periodic.
  - sliding block: blocks the lane at one phase, clears it at another.
  - speed tile: exit speed > entry speed; slow tile: exit speed < entry.
  - ramp: outbound direction matches the ramp `rot`.
  - tunnel: ball entering entrance reappears near the paired exit with speed
    preserved (within restitution tolerance); cooldown prevents immediate re-entry.
- **Determinism**: stepping the same hole twice with the same strikes yields
  identical final `pos`/`vel`/`strokes` (no RNG in the new branches).
- **Regression**: the full existing `minigolf.test.ts` suite stays green.

Run: `cd src/frontend && npx tsc -b && npx vitest run`.

## Out of scope

- Editor UI (palette, canvas, drag/rotate, drafts, playtest) — **PB-302**.
- Backend `validate_course_data` Rust mirror + mint re-validation — **PB-304**
  (this spec defines the schema both sides implement).
- Renderer *art content* for the new elements (higher-fidelity sprites/themes, e.g.
  upgrading the low-quality sand/walls/windmill) — later work. The first cut ships
  `RenderKit primitive-v1`. The **upgradable render-layer architecture this content must
  use is specified in A.6** and is in scope; only the art content itself is deferred.
- On-chain / Rust port of the physics engine — explicitly **not needed** (D1:
  anti-cheat is the signed session in PB-306, not physics replay).
- Removal of the old built-in `COURSE` / `ArcadeHoleDef` — **PB-309**.

## Dependencies

- **Blocks**: PB-302 (editor writes `CourseDataV1` + plays via the engine),
  PB-304 (mint re-validates the same schema), PB-305/PB-306 (play sessions load
  courses via this engine), PB-309 (arcade migration cuts over to this format).
- **Depends on**: PB-301 only as the verbatim store of the CBOR bytes (opaque there).
