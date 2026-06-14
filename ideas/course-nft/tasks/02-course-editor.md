# Course Editor — Build Spec (PB-302)

> User-facing 9-hole mini-golf course editor. Replaces and extends the existing
> admin-only `CourseEditor` (decision **D4**). Reads/writes the `CourseDataV1`
> format owned by [PB-303](03-minigolf-engine-and-course-format.md); minting is
> [PB-304](04-minting-flow.md). Read [00-overview-and-architecture.md](00-overview-and-architecture.md) first.

Source design: [`course-editor.md`](../course-editor.md). Decisions are locked — this spec implements them, it does not re-open them.

---

## Part A — Design / UX

### A.1 Entry point & who can use it

Today the only editor is the admin `CourseEditor` mounted inside `Admin.tsx`
(Content tab, `src/frontend/src/arcade/CourseEditor.tsx`) — it paints the single
built-in 9-hole course and writes it on-chain for everyone via
`admin_set_arcade_hole`. That is a fundamentally different tool: one global
course, cell-by-cell paint, admin guard.

The Course NFT editor is a **per-user, multi-hole, draft-backed builder** that
produces a `CourseDataV1` blob destined to become an NFT. It is reached from the
arcade marketplace surface (PB-305 / PB-309) via a **"Create Course"** button,
available to any **Tier 2+ (signed-in)** user. The admin paint editor is left in
place for the legacy built-in course but is **decoupled** from this feature — no
shared component, no shared backend method. (D4 "replaces the built-in mini-golf
course" is satisfied at the *play/marketplace* layer in PB-309; this spec only
ensures the new editor stands alone and does not depend on the admin one.)

The editor is a full page (`idea-board-container`, 1080 width) titled with the
standard anatomy: `<Eyebrow accent>ARCADE · COURSE NFT</Eyebrow>` + `gamepad`
icon + `<h4>Course Editor</h4>` + one-line subtitle + a `<MoreInfo>` explaining
the create → mint → list → earn loop and the 0.5 ICP mint fee.

### A.2 The four-zone layout

```
┌────────────────────────────────────────────────────────────────────┐
│ TOP BAR: [Course Name input] [Theme ▾] · ⏺ autosaved 12s ago        │
│                                  [Playtest] [Save] [Mint as NFT ▸]  │
├──────────────┬────────────────────────────────────┬────────────────┤
│  HOLE PANEL  │            HOLE CANVAS             │ ELEMENT PALETTE │
│  (left, 9    │      (centre, zoom/pan grid)       │  (right, by     │
│   slots)     │       + mini-map + snap grid       │   category)     │
└──────────────┴────────────────────────────────────┴────────────────┘
```

On narrow viewports (<900px) the three lower zones stack vertically: Hole Panel
as a horizontal strip of 9 chips, canvas full-width, palette as a collapsible
accordion below. The editor is desktop-first (matches the rest of the arcade).

#### Top Bar
- **Course Name** — `burn-input`, required, `maxLength={60}`. Live char counter.
- **Theme** — dropdown: Desert · Ocean · Space · Forest · Custom. Selecting
  Custom reveals two color swatches (primary / secondary) chosen from a fixed
  palette. Theme applies to the whole course and re-tints the canvas immediately.
- **Autosave indicator** — `<LiveDot>` + "autosaved Ns ago" / "saving…" / "unsaved
  changes". Reflects the Drafts system (A.7).
- **Playtest** — opens the per-hole Playtest modal (A.6) for the *active* hole.
  Always enabled (does not require all 9 holes valid).
- **Save** — manual draft save (`save_course_draft`). Always enabled.
- **Mint as NFT** — `Btn variant="primary"`. **Disabled until all client-side
  validation passes** (A.5). On click hands off to PB-304's confirmation dialog.

#### Hole Panel (left)
Vertical list of exactly **9 slots** (the course is always 9 holes — slots are
fixed, not addable/removable). Each slot shows:
- Hole number `1–9`.
- Inline-editable **hole name** (`maxLength={30}`, optional; placeholder
  `"Hole N"`).
- **Par selector**: a 4-segment control (2 / 3 / 4 / 5). Default par 3.
- **Status indicator**: `✓` complete (tee + cup + par set), `⚠` incomplete
  (missing tee or cup), `○` empty (no elements yet). Use `Chip` tones:
  `ok` / `danger` / `muted`.
- A short failing-reason line under `⚠` slots (e.g. "no cup placed").

Clicking a slot makes it the active hole; the canvas + palette retarget to it.
The active slot is highlighted with the `--burn` border treatment already used
by the admin editor's hole buttons. Holes can be edited in any order.

#### Hole Canvas (centre)
Fixed-logical-size top-down grid for the active hole (grid dims from the
`CourseDataV1` hole; PB-303 owns the exact `grid_w`/`grid_h` — mirror the
existing engine's 22×14 unless PB-303 widens it). Rendered with the **PB-303
play renderer in "editor mode"** so what you build looks like what you play
(theme tint included). Interactions:

| Interaction | Input | Behaviour |
|---|---|---|
| **Place** | left-click empty cell with a palette item armed | drop that element at the snapped cell |
| **Select** | left-click a placed element (no item armed) | select it; show its properties popover |
| **Drag** | press-drag a selected element | reposition, snapped to grid |
| **Rotate** | `R` key or on-element rotate handle | rotate 90° CW (`rot` 0→1→2→3→0) |
| **Delete** | `Delete`/`Backspace` or trash icon on the popover | remove selected element |
| **Zoom** | scroll / pinch | zoom canvas in/out (clamp 0.5×–3×) |
| **Pan** | middle-click-drag / two-finger drag / spacebar-drag | pan the viewport |

- **Snap grid**: every placement/drag snaps to a cell. A faint grid overlay is
  always shown; the active cell highlights on hover.
- **Mini-map**: small overview in a canvas corner showing the full hole + the
  current viewport rectangle when zoomed in.
- **Required-element prompts**: until a tee and a cup exist, the canvas shows a
  red-outlined banner ("Place a tee" / "Place a cup"), mirroring the design doc.
- **Moving-obstacle preview**: when a moving element is selected, overlay its
  path/sweep and a **phase slider (0–100%)** + **speed (Slow/Med/Fast)** in the
  properties popover. Sliding-block path length is set by dragging its endpoint.
- **Paired elements**: placing a tunnel entrance arms "place the exit"; the
  editor links the pair in placement order and draws a connector line. Same for
  ramp up / ramp down. A hole may contain multiple pairs.

#### Element Palette (right)
Grouped by category (matches `course-editor.md` + PB-303's element catalog).
Exactly one item is armed at a time; clicking the armed item again disarms
(returns to select mode), exactly like the design doc's toggle behaviour.

| Group | Items |
|---|---|
| **Required** | Tee, Cup (one each per hole) |
| **Terrain** | Fairway, Rough, Sand trap, Water hazard, Out of bounds |
| **Walls** | Straight, Corner, Angled 45°, Curved |
| **Obstacles** | Rock (1×1, 2×1), Pillar, Bumper, Tree |
| **Moving** | Windmill arm, Pendulum, Rotating paddle, Sliding block (each Slow/Med/Fast + phase) |
| **Special** | Tunnel entry/exit (paired), Ramp up/down (paired), Speed tile, Slow tile |

The authoritative `ElementKind` enum + per-element `params` are owned by PB-303;
the palette is a thin presentation layer over that enum. **If PB-303 has not
landed an element yet, the palette omits it** rather than inventing wire shapes.

### A.3 Par & difficulty

Each hole's par is 2–5 (default 3). `par_total` = sum of the 9 hole pars, shown
live in the Top Bar. Difficulty bucket (for marketplace parity, display-only
here): **Easy ≤ 27 · Medium 28–44 · Hard ≥ 45**.

### A.4 Theme

Whole-course `Theme` from the `CourseDataV1` enum: `Desert | Ocean | Space |
Forest | Custom { primary, secondary }`. Custom colors are picked from a fixed
swatch list (so the blob stays small and renderable). Theme re-tints the canvas
preview immediately; it never affects physics.

### A.5 Client-side validation (gates the Mint button)

| Check | Requirement | Failure surfacing |
|---|---|---|
| Hole count | exactly 9 (always true — slots are fixed) | n/a |
| Tee | each hole has **exactly one** tee | `⚠` on the hole slot |
| Cup | each hole has **exactly one** cup | `⚠` on the hole slot |
| Par set | each hole par ∈ 2..=5 | `⚠` on the hole slot |
| Course name | non-empty, ≤ **60** chars | inline under the name input |
| Hole name | each ≤ **30** chars (optional) | inline on the slot |
| Blob bounds | within PB-303's max blob size / max elements per hole | banner + Mint disabled |

> Note: the design doc's validation table lists "name ≤ 60" for the **course
> name**; per-**hole** names are ≤ 30 (A.6 of `course-editor.md`). Both enforced.

Validation runs on every change (memoized). The Mint button is disabled with a
tooltip listing the unmet checks until all pass. The backend re-runs the full
check independently at mint (PB-304) — client validation is UX, not trust.

### A.6 Per-hole Playtest modal

`Playtest` launches a modal overlay running the **active hole only** in the
PB-303 engine with real physics and the selected theme. The other 8 holes need
not be valid. Stroke count + score are shown but **recorded nowhere** (no
backend call, no ticket, no leaderboard — the global leaderboard is removed by
PB-309). `Exit Playtest` returns to the editor with zero state changes. If the
active hole has no tee/cup yet, Playtest shows "place a tee and cup first".

### A.7 Drafts (autosave + resume)

- **One draft per user**, keyed by principal in `COURSE_DRAFTS` (MemoryId 76).
- **Autosave every 60s** while there are unsaved changes (a `setInterval`
  cleared on unmount), plus **manual Save**. Both call `save_course_draft`.
  Debounce so an autosave and a manual save can't race; show "saving…" →
  "autosaved Ns ago".
- **Resume-or-fresh on entry**: on mount the editor calls `get_my_course_draft`.
  If a draft exists, show a small chooser ("Resume your draft" vs "Start fresh").
  "Start fresh" begins an empty 9-hole course in memory but does **not** delete
  the stored draft until the first save overwrites it (so an accidental "fresh"
  is recoverable until the next save).
- Drafts are private (never in the marketplace, never queryable by others).
- **Cleared after a successful mint** — PB-304 calls `clear_course_draft` as the
  final step of the mint saga (not the editor), so the draft survives a mint that
  fails mid-saga and the user can retry. The editor also clears local state and
  routes to the new listing on the PB-304 success callback.

### A.8 Mint hand-off

The editor owns validation + the enabled Mint button; **PB-304 owns the
confirmation dialog and the mint call**. On Mint click the editor passes the
serialized `course_data` blob + name to PB-304's flow. The hole-by-hole summary,
fee disclosure, par-total/difficulty, and confirm/cancel live in PB-304.

---

## Part B — Implementation

### B.1 File plan (`src/frontend/src/`)

All new files live under a new `arcade/coursenft/` folder to keep them clearly
separate from the legacy admin paint editor (`arcade/CourseEditor.tsx`, untouched).

| File | Responsibility |
|---|---|
| `arcade/coursenft/CourseNftEditor.tsx` | Page shell: 4-zone layout, top bar, draft lifecycle, validation, Mint hand-off |
| `arcade/coursenft/HolePanel.tsx` | The 9 hole slots (name/par/status) |
| `arcade/coursenft/HoleCanvas.tsx` | Canvas: place/select/drag/rotate/delete/zoom/pan, snap grid, mini-map, element popover |
| `arcade/coursenft/ElementPalette.tsx` | Category-grouped armable palette over PB-303's `ElementKind` |
| `arcade/coursenft/PlaytestModal.tsx` | Per-hole playtest overlay (wraps PB-303 engine) |
| `arcade/coursenft/courseData.ts` | TS mirror of `CourseDataV1` + CBOR encode/decode + client validation (shared with PB-303/304) |
| `arcade/coursenft/draftClient.ts` | Thin wrappers over `save_/get_my_/clear_course_draft` with the opt-decode handling |

Reuse `ui.tsx` primitives throughout: `Icon`, `Eyebrow`, `Chip`, `Btn`,
`MoreInfo`, `LiveDot`, plus `burn-input`, `card`, `col`/`row` classes and the
`--burn`/`--border`/`--fg-*` tokens (see how `arcade/CourseEditor.tsx` already
uses them — match that exact styling vocabulary). Do **not** introduce a new
design system.

`courseData.ts` is the single source of the wire shape on the frontend. PB-303
defines `CourseDataV1`; this spec consumes it. The editor never hand-edits
`src/bindings` — `save_/get_my_/clear_course_draft` bindings are regenerated from
`backend.did`.

### B.2 Candid binding trap (opt decoding)

Generated bindings decode `opt T` via the `{__kind__: 'Some'|'None', value?}`
wrapper and `nat64`/`nat` as `bigint`. `get_my_course_draft` returns
`opt CourseDraft`, so the resume check is:

```ts
const res = await actor.get_my_course_draft();      // CandidOpt<CourseDraft>
const draft = res.__kind__ === 'Some' ? res.value : null;  // NOT `res[0]`
```

This is the "dead button / undefined data" trap from `.claude/skills/frontend-dev`
— mirror how `arcade/CourseEditor.tsx` reads `res.__kind__ === 'Err'`. All
`u64`/`nat` fields (timestamps, sizes) arrive as `bigint`; convert with `Number(...)`
only where safe.

### B.3 Backend: `COURSE_DRAFTS` (MemoryId 76)

New section in `src/backend/src/lib.rs`: `// ===== 20. Course NFT marketplace =====`
(this spec adds the draft sub-part; PB-304/305 add the rest under the same banner).

```rust
// ---- Course drafts (PB-302) ----
const MAX_COURSE_DRAFT_BYTES: usize = 32 * 1024; // bound the blob; see PB-303 for the
                                                 // mint-time CourseDataV1 size cap

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CourseDraft {
    /// Opaque serialized CourseDataV1 (CBOR). The backend does NOT parse drafts —
    /// only mint (PB-304) validates. Stored verbatim so the editor round-trips.
    pub course_data: Vec<u8>,
    pub name: String,                 // working title; may be empty in a draft
    pub updated_at: u64,              // ns; drives the "autosaved Ns ago" label
    #[serde(default)]
    pub version: u8,                  // schema rev of this draft envelope (=1)
}
impl_storable!(CourseDraft);

thread_local! {
    static COURSE_DRAFTS: RefCell<StableBTreeMap<Principal, CourseDraft, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableBTreeMap::init(mm.borrow().get(MemoryId::new(76)))));
}
```

`#[serde(default)]` on any field added later (upgrade safety, per overview §6).
**MemoryId 76 is claimed by this spec** (overview §5) — do not reuse.

#### Endpoints

```rust
/// Save (create or overwrite) the caller's single draft. Tier 2+ only.
#[ic_cdk::update(guard = "require_authenticated")]
fn save_course_draft(course_data: Vec<u8>, name: String) -> Result<(), String> {
    let caller = get_caller();
    if course_data.len() > MAX_COURSE_DRAFT_BYTES { return Err("DRAFT_TOO_LARGE".into()); }
    if name.chars().count() > 60 { return Err("NAME_TOO_LONG".into()); }
    COURSE_DRAFTS.with(|m| m.borrow_mut().insert(caller, CourseDraft {
        course_data, name, updated_at: current_time(), version: 1,
    }));
    Ok(())
}

#[ic_cdk::query(guard = "require_authenticated")]
fn get_my_course_draft() -> Option<CourseDraft> {
    COURSE_DRAFTS.with(|m| m.borrow().get(&get_caller()))
}

/// Delete the caller's draft. Idempotent (Ok even if none existed). Called by
/// the editor on explicit discard, and by mint (PB-304) after a successful mint.
#[ic_cdk::update(guard = "require_authenticated")]
fn clear_course_draft() -> Result<(), String> {
    COURSE_DRAFTS.with(|m| m.borrow_mut().remove(&get_caller()));
    Ok(())
}
```

Notes:
- The backend treats `course_data` as **opaque bytes** for drafts — it does not
  decode CBOR until mint. This keeps drafts cheap and forward-compatible while
  PB-303's element catalog is still evolving.
- `require_authenticated` (overview §6) is the only guard — drafts are
  per-principal and not admin-gated. No `require_local_dev`.
- Size cap (`MAX_COURSE_DRAFT_BYTES`) protects against oversized update payloads;
  PB-303/PB-304 own the stricter at-mint `CourseDataV1` size bound.

### B.4 `backend.did` (hand-maintained, lockstep)

Add to the hand-written `src/backend/backend.did`:

```candid
type CourseDraft = record {
  course_data : blob;
  name        : text;
  updated_at  : nat64;
  version     : nat8;
};

service : {
  // ... existing ...
  save_course_draft  : (blob, text) -> (Result);            // Result = variant { Ok; Err : text }
  get_my_course_draft: () -> (opt CourseDraft) query;
  clear_course_draft : () -> (Result);
}
```

`Result` (`variant { Ok; Err : text }`) already exists in the `.did` (line ~770)
— reuse it; do not mint a new variant. Regenerate frontend bindings after the
`.did` change (never hand-edit `src/bindings`).

### B.5 Wiring

- Add a **"Create Course"** entry to the arcade marketplace surface (PB-305 owns
  the marketplace page; until it lands, mount the editor behind the existing
  `FLAG_ARCADE_MINIGOLF` flag from a temporary route so it is testable). Gate the
  button on Tier 2+; anonymous users see a sign-in prompt.
- The editor checks the feature flag via the existing `feature_visible` plumbing
  (no new flag required for the editor itself; the feature ships under the
  Course NFT rollout flag introduced by PB-305).

---

## Acceptance criteria

1. A Tier 2+ user can open the editor, build all 9 holes (place tee + cup, set
   par, add elements from every palette group that PB-303 supports), name the
   course and pick a theme (incl. Custom colors).
2. The Hole Panel shows accurate per-hole status (`✓`/`⚠`/`○`) and the Mint
   button is disabled until **every** A.5 check passes, with a tooltip naming the
   unmet checks.
3. Playtest runs the active hole with real physics in a modal and records nothing.
4. A draft autosaves at most every 60s and on manual Save; reloading the page
   offers Resume vs Start Fresh and Resume restores the exact course.
5. `save_course_draft` enforces the 32 KiB and 60-char caps and overwrites the
   caller's single draft; `get_my_course_draft` returns it (opt-decoded correctly);
   `clear_course_draft` is idempotent.
6. Clicking Mint hands the serialized `course_data` + name to PB-304 (no mint
   logic lives in this spec's code).
7. `cargo build -p backend` + `npx tsc -b` clean; `backend.did` and bindings in
   sync.

## Test plan

**Backend unit (`cargo test -p backend --lib`)**
- `save_course_draft` then `get_my_course_draft` round-trips bytes + name; a
  second save overwrites (one draft/user).
- `DRAFT_TOO_LARGE` when `course_data.len() > MAX_COURSE_DRAFT_BYTES`;
  `NAME_TOO_LONG` at 61 chars.
- `clear_course_draft` removes it and is Ok when none exists.
- Anonymous caller is rejected by `require_authenticated` on all three.
- Upgrade safety: insert a draft, run the pre/post-upgrade hooks (or the existing
  upgrade test harness), assert the draft survives and a new `#[serde(default)]`
  field decodes.

**Frontend (`cd src/frontend && npx tsc -b && npx vitest run`)**
- `courseData.ts` validation unit tests: missing tee/cup, duplicate tee, par out
  of range, course name 0/61 chars, hole name 31 chars → each flips the right
  flag; a fully valid 9-hole course passes.
- CBOR encode→decode round-trips a course unchanged.
- `get_my_course_draft` opt-decode helper returns `null` for `None` and the
  value for `Some` (guards the dead-button trap).

**Local integration (`.claude/skills/icp-local-deploy`)**
- `bash scripts/deploy-local.sh`, then with `--identity dev1`:
  `dfx canister call backend save_course_draft '(blob "...", "My Course")'`,
  `get_my_course_draft`, `clear_course_draft`; confirm one-draft-per-user and
  idempotent clear.

**Manual**
- Open the editor signed in; build a 9-hole course; verify status indicators,
  zoom/pan/rotate/delete, mini-map, paired tunnel/ramp linking, moving-obstacle
  phase preview, Custom theme tint.
- Trigger autosave (wait 60s), reload, choose Resume, confirm the course returns.
- Confirm Mint stays disabled until validation passes, then enables and opens
  PB-304's dialog.

## Out of scope
- The mint confirmation dialog, fee collection, the mint call, and post-mint
  draft cleanup → **PB-304**.
- The `CourseDataV1` schema, element catalog, physics, and the play renderer →
  **PB-303**.
- The marketplace page / "Create Course" surface and the rollout feature flag →
  **PB-305** (this spec mounts behind a temporary route until then).
- Removing/redirecting the legacy global mini-golf course & leaderboard →
  **PB-309**.
- The admin paint editor (`arcade/CourseEditor.tsx`) is left untouched.

## Dependencies
- **PB-303** (hard): `CourseDataV1` shape, `ElementKind`, physics, play renderer
  used by the canvas + Playtest.
- **PB-304** (hand-off): receives the validated blob + name on Mint; owns
  `clear_course_draft` at mint success.
- **PB-305** (soft): final entry-point surface + rollout flag.
- **PB-309** (soft): arcade migration / leaderboard removal.
