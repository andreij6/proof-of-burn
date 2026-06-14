# Mini-Golf Course Editor — Design Document

## Overview

The course editor is a browser-based tool where users design 9-hole mini-golf
courses that can be minted as NFTs and listed in the Course Marketplace. Each
hole is designed independently on a 2D top-down canvas. The editor covers the
full creation lifecycle: building holes, setting par, choosing a theme, playtesting
individual holes, saving drafts, and minting.

A course is not mintable until all 9 holes pass validation. Each hole must have
exactly one tee (start) and one cup (end) placed, and the backend confirms the
hole count is exactly 9 before accepting a mint request.

---

## Editor Layout

The editor is divided into four zones:

```
┌────────────────────────────────────────────────────────────┐
│  Top Bar: Course Name · Theme · [Playtest] [Save] [Mint]   │
├──────────┬─────────────────────────────────┬───────────────┤
│          │                                 │               │
│  Hole    │         Hole Canvas             │   Element     │
│  Panel   │       (design area)             │   Palette     │
│  (left)  │                                 │   (right)     │
│          │                                 │               │
└──────────┴─────────────────────────────────┴───────────────┘
```

### Top Bar

- **Course Name** — editable text field, required before minting.
- **Theme** — dropdown selector (Desert / Ocean / Space / Forest / Custom).
  Applies to the whole course, not individual holes.
- **Playtest** — launches a test round of the current hole in a modal. Does
  not require all 9 holes to be complete.
- **Save** — saves the current draft to the canister (see Drafts section).
- **Mint** — triggers validation and, if passed, opens the mint confirmation
  dialog. Disabled until all 9 holes are valid.

### Hole Panel (Left)

A vertical list of 9 hole slots. Each slot shows:
- Hole number (1–9)
- Optional hole name (editable inline)
- Par value for that hole (2 / 3 / 4 / 5)
- Status indicator: ✓ complete, ⚠ incomplete (missing tee or cup), ○ empty

Clicking a slot switches the canvas to that hole. The active hole is highlighted.
Users can jump between holes in any order.

### Hole Canvas (Centre)

A fixed-size 2D top-down grid representing one hole. The grid provides snap
alignment for all elements. Users interact with the canvas by:

- **Click** — places the selected element from the palette at that grid cell.
- **Click a placed element** — selects it, showing its properties panel.
- **Drag a selected element** — repositions it on the grid.
- **R key (or rotate handle)** — rotates the selected element 90° clockwise.
- **Delete key (or trash icon)** — removes the selected element.
- **Scroll / pinch** — zooms the canvas in or out.
- **Middle-click drag (or two-finger drag)** — pans the canvas.

A mini-map in the canvas corner shows the full hole at a glance when zoomed in.

### Element Palette (Right)

Groups of elements available for placement. Only one element is "active" at a
time — clicking a palette item arms the cursor for placement, clicking the canvas
places it. Clicking the active palette item again dearms it (returns to select mode).

---

## Elements

### Required (one of each per hole)

| Element | Description |
|---|---|
| **Tee** | The ball starting point. Every hole must have exactly one. |
| **Cup** | The hole / flag. Every hole must have exactly one. |

The canvas highlights missing required elements with a red outline on the
relevant zone until they are placed.

### Terrain

| Element | Description |
|---|---|
| **Fairway** | Standard playable surface. Ball rolls normally. |
| **Rough** | Slows the ball. Ball loses speed when rolling through. |
| **Sand trap** | Significantly slows the ball. Hard to escape at low power. |
| **Water hazard** | Ball resets to the last played position (penalty stroke added). |
| **Out of bounds** | Edge of the canvas. Ball resets on contact. |

### Boundaries & Walls

| Element | Description |
|---|---|
| **Straight wall** | A flat wall segment. Ball bounces off at the angle of incidence. |
| **Corner wall** | An inside or outside corner piece for building enclosed fairways. |
| **Angled wall (45°)** | A diagonal wall. Redirects the ball at 45°. Useful for bank shots. |
| **Curved wall** | A quarter-circle arc wall for smooth curves in the fairway boundary. |

Walls can be placed on any grid edge. Rotating lets them face any of the four
cardinal directions.

### Static Obstacles

| Element | Description |
|---|---|
| **Rock** | Solid immovable block. Ball bounces off. Various sizes (1×1, 2×1). |
| **Pillar** | A single-cell circular obstacle. Ball bounces off the curved surface. |
| **Bumper** | A circular obstacle that repels the ball with extra force on contact. |
| **Tree** | Decorative + solid. Identical physics to a rock. |

### Moving Obstacles

Moving obstacles have configurable speed and starting phase. A path preview
overlay shows the full movement range while the element is selected.

| Element | Speed options | Description |
|---|---|---|
| **Windmill arm** | Slow / Medium / Fast | Rotates around a fixed centre point. |
| **Pendulum** | Slow / Medium / Fast | Swings left–right or up–down across the fairway. |
| **Rotating paddle** | Slow / Medium / Fast | A flat paddle that spins around one end. |
| **Sliding block** | Slow / Medium / Fast | Moves back and forth along a defined path. Path length is set by dragging. |

**Phase setting:** each moving obstacle has a phase slider (0–100%) that sets
where in its movement cycle it starts. This lets creators offset multiple moving
obstacles so they aren't all synchronised.

### Special Elements

| Element | Description |
|---|---|
| **Tunnel entrance / exit** | Paired elements. Ball enters the entrance and exits at the paired exit with momentum preserved. Place one entrance, then one exit — the editor links them automatically in placement order. A course can have multiple tunnel pairs per hole. |
| **Ramp** | Redirects the ball's path. Placed in pairs (ramp up + ramp down). Ball follows the ramp direction on contact. Useful for routing the ball around obstacles. |
| **Speed tile** | A surface tile that boosts the ball's speed in a set direction. Useful for conveyor-style effects. |
| **Slow tile** | A surface tile that sharply reduces ball speed. Useful for precision sections. |

---

## Par Setting

Each hole has an independent par value of 2, 3, 4, or 5. Par is set in the
Hole Panel by clicking the current par value and choosing a new one.

| Par | Intended hole length / complexity |
|---|---|
| 2 | Very short — a single shot is typically achievable |
| 3 | Standard length — one or two obstacles, straightforward path |
| 4 | Longer or more technical — requires navigation around obstacles or banks |
| 5 | Complex — moving obstacles, tunnels, or tight routing required |

The sum of all 9 hole pars becomes the course `par_total` shown on the
marketplace card. Par total also determines the difficulty filter bucket:
Easy (≤ 27), Medium (28–44), Hard (≥ 45).

---

## Theme

The theme applies to the whole course and controls the visual style — colours,
textures, ambient decorations — without affecting gameplay physics.

| Theme | Visual style |
|---|---|
| Desert | Sand tones, cacti, rock formations |
| Ocean | Blue fairways, coral, driftwood, seabed textures |
| Space | Dark backgrounds, craters, glowing elements, low-gravity aesthetic |
| Forest | Green tones, logs, mushrooms, leaf litter |
| Custom | Creator picks a primary and secondary colour from a palette |

Theme is selected in the Top Bar dropdown and previewed immediately on the canvas.

---

## Hole Names

Each hole can be given an optional name (e.g. "The Windmill", "Dead Man's Curve",
"The Abyss"). Names are entered inline in the Hole Panel. They appear as a brief
title card when that hole starts during a round. Maximum 30 characters. Entirely
optional — unnamed holes show "Hole 1", "Hole 2", etc.

---

## Playtest Mode

Any individual hole can be playtested at any time directly in the editor. The
other 8 holes do not need to be complete.

- Tap **Playtest** in the Top Bar to launch a test round of the currently active hole.
- The test runs in a modal overlay with the same physics as a real round.
- Stroke count and score are shown but not recorded anywhere.
- Tap **Exit Playtest** to return to the editor with no changes.

Playtest is the primary tool for tuning obstacle timing, ramp angles, and
par difficulty before committing.

---

## Drafts

A course draft is automatically saved to the canister every 60 seconds while
editing, and also when the user taps **Save** manually. The draft is associated
with the creator's principal.

- One active draft per user. Starting a new course overwrites the previous draft.
- Drafts are not visible to anyone else and do not appear in the marketplace.
- On returning to the editor, the user is offered the option to resume their
  draft or start fresh.
- Drafts are permanently deleted after a successful mint.

---

## Validation

Before minting is allowed, the editor runs client-side validation and shows
an error state for any failing hole in the Hole Panel:

| Check | Requirement |
|---|---|
| Hole count | Exactly 9 holes must exist |
| Tee placed | Every hole has exactly one tee |
| Cup placed | Every hole has exactly one cup |
| Par set | Every hole has a par value of 2–5 |
| Course name | Non-empty, maximum 60 characters |

The **Mint** button in the Top Bar is disabled until all checks pass. Each
failing hole is marked ⚠ in the Hole Panel with a short description of what
is missing.

The backend performs the same 9-hole check independently when the mint request
arrives, rejecting invalid course data even if the frontend validation was
bypassed.

---

## Mint Flow

1. All 9 holes pass validation — the **Mint** button becomes active.
2. User taps **Mint**. A confirmation dialog appears showing:
   - Course name and theme
   - Par total and difficulty rating
   - Hole-by-hole summary (hole name, par)
3. User confirms.
4. On success, the editor closes and the user is taken to their new course listing
   in the marketplace. The draft is cleared.
5. On failure, the dialog shows the error and returns the user to the editor.

For minting fees and how the payment is split, see [Economy & UX](economy-and-ux.md).
