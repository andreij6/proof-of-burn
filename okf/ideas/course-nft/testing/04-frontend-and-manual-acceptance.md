---
type: idea
title: "Course NFT — Frontend (L4 vitest) & Manual Local Acceptance (L5)"
tags: [ideas, course-nft]
timestamp: 2026-06-13T22:37:20-04:00
---

# Course NFT — Frontend (L4 vitest) & Manual Local Acceptance (L5)

> Layers **L4** (vitest pure-logic + render smokes) and **L5** (manual local QA on a
> live replica) of the pyramid in [00-testing-overview.md](00-testing-overview.md).
> Read the anchor first — this doc consumes its pyramid, the §5 end-to-end path, and
> the §6 phased gates, and does **not** duplicate backend assertions that
> [01-backend-unit-tests.md](01-backend-unit-tests.md),
> [02-integration-pocketic-e2e.md](02-integration-pocketic-e2e.md), and
> [03-security-ic-compliance-matrix.md](03-security-ic-compliance-matrix.md) own.
>
> Spec sources: [PB-302 editor](../tasks/02-course-editor.md),
> [PB-303 engine + `course_data`](../tasks/03-minigolf-engine-and-course-format.md),
> [PB-305 marketplace](../tasks/05-marketplace.md),
> [PB-306 play-to-earn & anti-cheat](../tasks/06-play-to-earn-and-anticheat.md),
> [PB-309 leaderboard removal / arcade migration](../tasks/09-leaderboard-removal-and-arcade-migration.md).

---

## 0. Tooling baseline (verified against the repo)

- **Runner:** vitest 4 (`globals: true`, `environment: 'jsdom'`,
  `setupFiles: ['./src/test/setup.ts']`), config in `src/frontend/vitest.config.ts`.
  `setup.ts` only pulls in `@testing-library/jest-dom`; render smokes use
  `@testing-library/react` (already a devDependency).
- **Scripts** (`src/frontend/package.json`): `npm test` → `vitest run`,
  `npm run test:watch` → `vitest`. The type gate is `tsc -b` (part of `npm run build`).
- **Existing tests** live in `src/frontend/src/test/`: `minigolf.test.ts`,
  `crash.test.ts`, `dashboard.test.ts`, `ideaBoard.test.ts`, `setup.ts`. They are the
  style to copy: **pure logic extracted into exported functions**, asserted directly,
  never mounting a page against a live canister (the `frontend-dev` rule).
- **Engine under test** is `src/frontend/src/arcade/engine.ts` (extended by PB-303);
  the new format mirror is `src/frontend/src/arcade/courseData.ts` (new, PB-303).
- **Bindings:** `src/frontend/src/bindings/backend.ts` exposes candid `opt T` as the
  wrapper `Option<T> = { __kind__: 'Some', value } | { __kind__: 'None' }`, and
  `nat64`/`nat` as **`bigint`**. This is the dead-button trap from the `frontend-dev`
  skill — every test touching backend data must exercise both wrapper arms.

> **The frontend-dev rule, applied throughout:** wherever a render smoke would need
> live data, extract the decision into a pure exported helper and unit-test the helper.
> The render smoke then only proves the helper is wired in (no dead button, no NaN, no
> `[object Object]`), mounting with hand-built fixtures and a stub `actor`. Keep the
> physics/format/marketplace *logic* in L4-pure; keep mounting to thin smokes.

---

## 1. L4 vitest — pure logic

### 1.1 Engine physics — one test per NEW PB-303 element (`minigolf.test.ts`)

Extend `src/frontend/src/test/minigolf.test.ts`. The existing `asciiHole` /
`settle` / `initHole` / `strike` / `stepHole(state, def, tSec)` harness is reused;
new elements that the ASCII grid can't express are built directly as `CourseDataV1`
holes and compiled with `holeFromCourseData` (PB-303 B.1). Add the new exports to the
import list: `holeFromCourseData`, `courseFromData`, `moverGeometry`, `MOVER_SPEED`,
`SLIDE_SPEED`, `FRICTION_ROUGH`, `BUMPER_GAIN`, `TILE_BOOST`, `TILE_SLOW`, `TUNNEL_R`.

Each test builds a **minimal one-element hole** (tee, cup, the element under test),
strikes the ball along a known lane, settles, and asserts the element's specified
effect (PB-303 A.3 / acceptance). Assert **relative** ordering, not exact magnitudes
(the constants are "to be tuned"; PB-303 B.3 says tests assert ordering).

**Terrain**
- `rough` — travel distance is **between** green and sand for the same strike
  (`green > rough > sand`); pin against `FRICTION_ROUGH ∈ (FRICTION_SAND, green)`.
- `sand` — already covered by the existing "sand slows" test; keep it green (regression).
- `water` — already covered (stroke +1, reset to pre-shot spot); keep green.
- `out-of-bounds` (`ElementKind.OutOfBounds = 4`) — ball contacting an OOB cell
  **resets** (treated as Void today, PB-303 A.3); assert pos returns to pre-shot /
  tee and the ball never leaves the playfield.

**Walls** (`WallStraight 10 / WallCorner 11 / WallAngled45 12 / WallCurved 13`)
- `straight` — reflect at angle of incidence (reuse existing wall-reflection assert
  shape: ball stays inside, x-velocity sign flips on a head-on hit).
- `corner` — a ball aimed into the inner corner is redirected by **two** faces (final
  direction differs from a single-face bounce; ends inside the enclosure).
- `45° angled` — a horizontal putt into a 45° reflector exits **vertically** (bank
  shot): outbound dominant axis swaps from x to y.
- `curved` — quarter-arc reflector keeps the ball inside and bends its path (final
  heading between the straight-wall and 45° cases — a smooth deflection, not a hard flip).

**Static obstacles** (`Rock 20 / Pillar 21 / Bumper 22 / Tree 23`)
- `rock` — AABB block; ball reflects and never overlaps the rock cells. Test both
  `params {tag:'rock', size:1}` and `size:2` (2×1 footprint blocks a wider lane).
- `pillar` — round (circle) bounce (reuse the existing `Post` assertion shape).
- `bumper` — **outbound speed strictly greater** than inbound along the contact normal
  (`BUMPER_GAIN > 1`), and **capped at `MAX_POWER`** (a max-power ball into a bumper
  does not exceed `MAX_POWER`).
- `tree` — identical physics to rock (assert same final pos as a rock control in the
  same lane).

**Moving obstacles** — each with speed + phase (`Windmill 30 / Pendulum 31 /
RotatingPaddle 32 / SlidingBlock 33`; `params {tag:'moving', speed, phase}`,
sliding adds `len`,`axis`):
- For each: a ball crossing the swept region at a phase where the obstacle is **in the
  lane** is deflected (final pos differs from a no-obstacle control); at a phase where
  it's **out of the lane** the ball passes (final pos ≈ control). This proves both
  speed and phase are honoured.
- `windmill` — centre-pivot segment; `moverGeometry(m, t)` is **periodic**
  (`geometry(t) ≈ geometry(t + period)`), generalising the existing
  `barEndpoints rotate over time` test.
- `pendulum` — pivot-arc segment; angle bounded within its arc (never full rotation);
  periodic.
- `rotating paddle` — end-pivot (offset) segment; its pivot endpoint stays fixed while
  the far endpoint sweeps (distinguishes it from the windmill's centre pivot).
- `sliding block` — translating AABB along `axis`; **blocks the lane at one phase,
  clears it at another** (two settles, two outcomes). `Slow < Med < Fast` sweep:
  assert `SLIDE_SPEED[0] < SLIDE_SPEED[1] < SLIDE_SPEED[2]` and that a faster block
  changes lane-occupancy timing.
- Speed-enum ordering once, shared by all movers:
  `MOVER_SPEED[0] < MOVER_SPEED[1] < MOVER_SPEED[2]`.

**Special** (`TunnelEntrance 40 / TunnelExit 41 / RampUp 42 / RampDown 43 /
SpeedTile 44 / SlowTile 45`)
- `tunnel pair` — a ball entering the entrance portal reappears **near the paired
  exit** with speed preserved (within restitution tolerance) and direction rotated by
  the exit-vs-entrance `rot` delta; the **one-step cooldown** prevents immediate
  re-entry at the exit. Build with `params {tag:'pair', pairId:0}` on both ends.
- `ramp` — on entering a ramp cell the outbound **direction matches the ramp's `rot`
  facing** (speed magnitude preserved); paired up/down both present.
- `speed tile` — exit speed **>** entry speed (impulse along its `rot` facing).
- `slow tile` — exit speed **<** entry speed.

### 1.2 `courseData` (de)serialize round-trip + validation limits (`courseData.test.ts`)

New file `src/frontend/src/test/courseData.test.ts`, importing
`encodeCourseData`, `decodeCourseData`, `validateCourseData`, `COURSE_DATA_VERSION`,
`ElementKind`, `Speed`, `type CourseDataV1` from `../arcade/courseData`.

A small builder `validCourse(over?: Partial<CourseDataV1>)` returns a known-good
9-hole course (each hole: one tee, one cup, par 3, grid 22×14) so each test mutates
one field. (Mirrors `fakeIdea`/`fakeInfo` in `ideaBoard.test.ts`.)

**Round-trip**
- Build a course using **every** `ElementKind` (terrain, all 4 walls, all 4 statics,
  all 4 movers with speed+phase, tunnel pair, ramp pair, speed/slow tile) →
  `decodeCourseData(encodeCourseData(c))` **deep-equals** `c`.
- Encoded length **< 24 KiB** (PB-303 A.4 target) for the all-elements course.
- Enum-as-integer discriminant check: the encoded bytes for a single known element
  are stable (guards the "compact tagged-union" CBOR contract PB-303 B.1 shares with
  the Rust mirror — a drift here breaks cross-language decode).

**Validation limits** — one assertion per PB-303 A.4 rule, each asserting the exact
`INVALID_*` / stable error code:
- `version != 1` → rejected (forward-compat gate).
- hole count 8 or 10 → `WRONG_HOLE_COUNT`.
- par 1 and par 6 → `INVALID_PAR`; par 2 and par 5 accepted (boundaries).
- grid_w / grid_h = 7 and = 41 → rejected; 8 and 40 accepted (boundaries).
- no tee → `NO_TEE`; two tees → multiple-tee error.
- no cup → `NO_CUP`; two cups → `MULTIPLE_CUPS`.
- 201 elements in a hole → `TOO_MANY_ELEMENTS`; 200 accepted (boundary).
- 1201 total elements across the course → total-elements error; 1200 accepted.
- 13 moving elements in a hole → moving-cap error; 12 accepted.
- **unbalanced tunnels** (3 entrances + 2 exits) → `UNBALANCED_TUNNELS`; 5 pairs →
  too-many-pairs; 4 balanced pairs accepted.
- **unbalanced ramps** (mismatched up/down) → ramp imbalance error; 4 balanced accepted.
- hole name 31 chars → name-too-long; 30 accepted.
- off-grid element (`x == grid_w`, or negative) → off-grid error.
- **blob ceiling:** a course whose encoded blob exceeds **64 KiB** → `BLOB_TOO_LARGE`;
  a ≤ 24 KiB course passes (and a course between 24–64 KiB validates but is the
  editor's "warn past target" case — assert it validates OK, the warning is UI-only).
- A fully valid 9-hole course (no edits) **passes** and returns `par_total`.

> These mirror PB-303's TS test plan and the C5 size rule. The **Rust-side** decode of
> the same bytes and the at-mint re-validation are owned by docs **01/03** (PB-304's
> `validate_course_data`); this doc only proves the TS encoder/validator. The byte-level
> cross-language equivalence is verified in **02** (real Candid / shared CBOR fixture).

### 1.3 Editor client-side validation (`courseData.test.ts` or `editorLogic.test.ts`)

PB-302 A.5 gates the Mint button on client validation. Extract the editor's gating into
a pure helper (PB-302 puts validation in `courseData.ts`) and test:
- missing tee / missing cup / duplicate tee → flips the right per-hole flag.
- par out of 2..=5 → flag.
- course name 0 chars and 61 chars → name flag; 60 accepted.
- hole name 31 chars → flag.
- blob over the editor's draft cap (32 KiB, PB-302 B.3) / over elements cap → flag.
- a fully valid 9-hole course → **all** flags clear and the Mint-enabled predicate is
  `true` (proves the button can ever enable — the inverse dead-button check).

### 1.4 Deterministic-clock (`tSec`) fairness

PB-303 A.2 / acceptance: moving-obstacle geometry is a **pure function of `tSec`** (no
RNG; same `tSec` ⇒ same geometry; resets to 0 at `initHole`). Tests:
- `moverGeometry(m, t)` is deterministic: two calls with the same `(m, t)` are equal.
- Stepping the **same hole twice with the same strikes** yields identical final
  `pos`/`vel`/`strokes` (extends the existing determinism expectation to the new
  branches — no `Math.random` leaked into walls/movers/tiles/tunnels).
- Two ball runs that **start the same hole at the same elapsed `tSec`** see the obstacle
  in the **same phase** (fairness): identical `moverGeometry` at matching `tSec`.
- `initHole` resets the hole clock so `tSec` starts at 0 (a fresh hole's obstacle phase
  depends only on `phase0`, not on wall-clock at mount).

---

## 2. L4 vitest — render / interaction smokes

These mount the reworked components with `@testing-library/react`, hand-built fixtures,
and a **stub `actor`** (plain object whose methods return resolved promises with
**wrapper-shaped** candid values). They are thin: prove the component renders without
throwing, that the candid-opt path renders correctly (no dead button), and that bigint
e8s formats. Heavy logic stays in §1 helpers.

A shared `stubActor(over)` helper returns the methods each component calls, each
yielding a wrapper-shaped result (e.g. `get_my_course_draft` → `{ __kind__: 'None' }`,
`list_marketplace_courses` → `{ courses: [...], featured_token_id: { __kind__: 'None' },
seed: 0n, total: 0n }`). Use `Principal.fromText(...)` for principal fields (as
`ideaBoard.test.ts` does).

### 2.1 The candid opt-decoding trap (explicit, every surface)

For **each** component below, include a pair of cases proving the optional decodes both
ways and never produces a dead button or `undefined` render:

- **`{ __kind__: 'None' }` / `[]`** → the "empty" branch renders (e.g. editor shows
  *Start fresh* not a crash; marketplace shows the "Feature your course (coming soon)"
  strip, not a phantom featured card; play HUD shows no owner-credit toast; mint dialog
  shows no stale price).
- **`{ __kind__: 'Some', value }` / `[value]`** → the value renders (resume chooser
  shows the draft; featured card pins; etc.).

This directly closes the project-memory "dead-button / undefined-data" class. Where a
component reads the **raw declarations layer** (`[] | [T]`), test that array form too —
match whichever layer the component file actually uses.

### 2.2 Course editor (PB-302) — `CourseNftEditor` + sub-components

- **Zones render:** mounting `CourseNftEditor` with a stub actor shows the top bar
  (name input, theme dropdown), the 9-slot Hole Panel, the canvas, and the palette
  (`HolePanel`, `HoleCanvas`, `ElementPalette` present). Use `getByRole`/`getByText`,
  not snapshot dumps.
- **Palette arm/place:** clicking a palette item **arms** it (selected state); clicking
  the armed item again **disarms** (PB-302 A.2 toggle). Extract the arm/disarm reducer
  to a pure helper and unit-test the state machine; the smoke only asserts the armed
  class toggles. A simulated canvas click while armed appends one element to the active
  hole's element list (assert via the exported reducer, not pixel math).
- **Mint gating:** with an invalid course (no cup) the **Mint** button is `disabled`
  and its tooltip names the unmet check; with a valid 9-hole fixture Mint is enabled
  (the dead-button inverse — proves it can enable).
- **Per-hole status chips:** a complete hole shows `✓` (ok), an incomplete one `⚠`
  (danger) with a reason line, an empty one `○` (muted) — drive from fixtures.
- **Resume vs Start fresh (opt trap):** `get_my_course_draft → Some` shows the chooser;
  `→ None` mounts an empty editor with no chooser (see §2.1).

### 2.3 Marketplace (PB-305) — `CourseMarketplace` + `courseCard`

- **Card renders** name, "by {creator}" (+ "· owned by {owner}" only when owner ≠
  creator), theme chip, `Par N · {difficulty}`, total plays, and price-or-"Not for
  sale". Verify difficulty label mapping (Easy ≤ 27 / Medium 28–44 / Hard ≥ 45) via a
  pure `difficultyLabel(parTotal)` helper (unit-tested) + the card smoke.
- **bigint e8s formatting:** a listing with `price_e8s = 150_000_000n` renders **"1.5
  ICP"** via the existing `fmtICP` / `fmtTokenAmount`; `price_e8s = 0n` + `listed:false`
  renders "Not for sale" (proves no `NaN` / `[object BigInt]`).
- **Filters:** the Difficulty / Theme / Listed pill groups render; clicking a pill
  updates the query args passed to `actor.list_marketplace_courses` (assert the arg
  shape via a spy) and **resets the pager to page 0 + re-rolls the seed**. Test the
  shuffle as a pure helper: `shuffle(courses, seed)` is a **permutation** (no drops/
  dupes), **stable within a seed**, **differs across seeds**, and **excludes
  `featured_token_id`** so the featured token never appears twice (PB-305 B10).
- **Featured slot (opt trap):** `featured_token_id → Some(liveTokenInPool)` pins one
  full-width card with the *Featured* badge and removes it from the pool;
  `→ None` (or a stale token) shows the disabled "Feature your course (coming soon)"
  strip (§2.1).
- **Buy/Manage gating:** Buy hidden when caller is owner ("You own this"); Manage shown
  only to the owner; in Phase 1 Buy's confirm is disabled ("Secondary market coming
  soon") — assert the disabled state, not the (unbuilt) flow.

### 2.4 Play HUD (PB-306) — the MiniGolf wrapper completion card

The wrapper component that drives `start_play_session` / `record_hole_event` /
`complete_round` around the engine view (PB-306 B4). Smoke the **completion card** with
a stub actor (do not run real physics here — that's §1):
- `complete_round → Ok{ player_credited: true }` → card shows **"+1 lottery ticket"**.
- `→ Ok{ player_credited: false, reason: Some('TIER_TOO_LOW') }` → friendly copy
  ("Sign in and follow the leader to earn tickets"); `reason: Some('DAILY_CAP')` →
  "Daily ticket cap reached". The `reason` is `opt text` — exercise `Some`/`None`
  (§2.1).
- `start_play_session → Err` → a non-blocking "playing for fun" toast renders and the
  engine view still mounts (round proceeds **unscored**; no ticket calls fire — assert
  the actor's `record_hole_event` spy is **never** called after the start error).
- Extract the result→copy mapping into a pure `completionMessage(result)` helper and
  unit-test all reason branches (`ANON`/`TIER_TOO_LOW`/`DAILY_CAP`/`ADMIN_EXCLUDED`).

### 2.5 Mint dialog (PB-304 hand-off surface)

The editor hands the serialized blob + name to PB-304's confirmation dialog (PB-302
A.8). Smoke the dialog component:
- Renders the hole-by-hole summary (hole name + par from the passed `course_data`),
  `par_total` + difficulty, and the **0.5 ICP** fee with the 50/25/25 split disclosure.
  The fee is a bigint e8s constant → assert it renders as "0.5 ICP" (bigint formatting).
- Confirm / Cancel both render; Confirm is enabled only when the passed course is valid.
- (The actual mint call, saga, and `clear_course_draft` are **PB-304** → docs 01/02.)

---

## 3. L5 — Manual local QA scripts

All scripts run against `bash scripts/deploy-local.sh` (idempotent; starts the network,
installs ledgers, upgrades backend+frontend, seeds flags + mock data). Frontend at
**http://frontend.local.localhost:8000/**. Identities: **dev1** (admin/owner, runs all
`admin_*`/`dev_*`), **dev2** (second user), **agent-tester** (controls ledgers). The
faucet grants **100 ICP per call** (`dev_faucet_token '(variant { ICP })'`); the mint
fee is **0.5 ICP**, so one faucet call covers a mint plus fees with margin. The in-app
**dev controls panel** (tweak panel) exposes the same faucets and the per-page dev
controls — prefer it for time-warp / faucet during a play session.

> **Preconditions for all scripts.** After `deploy-local.sh`, confirm the arcade is on
> and the CourseNFT canister is wired (PB-301/PB-309 add this to the script):
> ```bash
> icp canister call backend admin_set_feature_flag '("arcade_minigolf", true)' -e local --identity dev1
> icp canister call backend list_feature_flags '()' --query -e local         # arcade + arcade_minigolf = true
> icp canister call backend list_marketplace_courses \
>   '(record { difficulty = variant { Any }; theme = null; listed = variant { Any }; mine_only = false })' \
>   --query -e local                                                          # expect >=1 (the system course, PB-309 B3)
> ```
> If the marketplace is empty because the seed no-op'd, run the idempotent re-seed:
> `icp canister call backend admin_seed_system_course '()' -e local --identity dev1` (PB-309 B6).

Each step lists **action → expected → on-chain verify**.

### Phase 1 (P1) — build + mint, list, cross-play, earn, leaderboard gone

**Setup**
1. `icp canister call backend dev_faucet_token '(variant { ICP })' -e local --identity dev1`
   (and once for dev2). **Verify:** balance shows in the app wallet / via the ledger.

**Build + mint a course (dev1)**
2. Sign in as dev1 (II local). Open **Play** → arcade → **Mini Golf** tab.
   **Expected:** it opens the **Course Marketplace**, not a single fixed course
   (PB-309 A1). **Verify:** the *Create a course* button is visible; the system course
   shows in the grid.
3. Click **Create a course** → editor opens (PB-302). Build all 9 holes: place a tee +
   cup per hole, set par, and add at least one element from **every** palette group
   (terrain, wall, static, a moving obstacle with a phase/speed, a tunnel pair, a ramp
   pair, a speed/slow tile). Name it "Dev1 Loop", pick a theme (try **Custom** colors).
   **Expected:** each hole's status chip turns `✓`; the **Mint** button enables only
   once all 9 are valid; `par_total` + difficulty update live; Custom theme re-tints the
   canvas. Use **Playtest** on one hole — strokes show but nothing is recorded.
4. Wait ~60s (or click **Save**), then reload the page.
   **Expected:** a **Resume / Start fresh** chooser; **Resume** restores the exact
   course. **Verify on-chain:**
   ```bash
   icp canister call backend get_my_course_draft '()' --query -e local --identity dev1
   # returns opt CourseDraft (Some) with the saved name; decode shows the blob bytes
   ```
5. Click **Mint as NFT** → confirm the dialog (hole summary, **0.5 ICP** fee, 50/25/25
   split) → confirm. **Expected:** success routes to the new listing.
   **Verify on-chain:**
   ```bash
   # token minted to dev1
   icp canister call course_nft icrc7_owner_of '(vec { <token_id> : nat })' --query -e local
   # listing exists, listed=true, owner=dev1, cached metadata populated
   icp canister call backend get_course '(<token_id> : nat64)' --query -e local
   # the draft was cleared by the mint saga (PB-304)
   icp canister call backend get_my_course_draft '()' --query -e local --identity dev1   # None
   ```

**See it listed**
6. Back in the marketplace, clear filters. **Expected:** "Dev1 Loop" appears as a card
   with creator "by dev1", a theme chip, par/difficulty, "0 plays", and **Not for
   sale** (it is auto-listed for *play* but not priced for *sale* until P2). Apply a
   Theme / Difficulty filter that matches it and one that doesn't.
   **Expected:** the pool narrows correctly and re-shuffles; the card never appears
   twice; the pager paginates 9/page. **Verify:** `list_marketplace_courses` with a
   matching filter returns the token; with a non-matching one it does not.

**dev2 plays, both earn tickets**
7. As **dev1**, ensure the course is listed for play (it is, from mint). Record dev1's
   current tickets:
   ```bash
   icp canister call backend get_lottery_info '()' --query -e local --identity dev1   # note my_tickets
   ```
8. Sign in as **dev2** (must be **Tier 2+** to earn the *player* ticket — follow the
   leader if prompted). Note dev2's tickets the same way. Open "Dev1 Loop" → **Play**.
   Play through all 9 holes, sinking each. Pace matters: PB-306 enforces a **3 s
   minimum between holes**, so play at human speed (or use the dev panel time-warp).
   **Expected:** the round runs; the completion card shows **"+1 lottery ticket"** for
   dev2. **Verify on-chain:**
   ```bash
   icp canister call backend get_lottery_info '()' --query -e local --identity dev2   # my_tickets +1 (player)
   icp canister call backend get_lottery_info '()' --query -e local --identity dev1   # my_tickets +1 (owner, credited at hole 2)
   icp canister call backend get_course '(<token_id> : nat64)' --query -e local       # play_count +1, tickets_distributed +1
   ```
   Anti-cheat sanity: try sinking two holes faster than 3 s — the round keeps playing
   "for fun" but stops scoring (no further owner credit). Reload mid-round — the round
   abandons cleanly, **no double-credit** (re-check both `my_tickets`).
9. **Self-play check:** as **dev1**, play your own "Dev1 Loop" to completion.
   **Expected:** dev1 gets the *player* completion ticket (Tier 2+) but **no owner
   ticket** (self-play suppression, V5). **Verify:** dev1 `my_tickets` increases by
   exactly 1 (player), and `tickets_distributed` on the course does **not** increment
   from this self-play.

**Leaderboard is gone; arcade entry is the marketplace**
10. In the arcade, inspect the Mini Golf surface. **Expected:** **no** mini-golf
    leaderboard table anywhere, **no** "Your best · rank" chip; the Mini Golf tab body
    **is** the marketplace. Field Goal and Turbo Rush still show their cards + boards.
    **Verify on-chain:**
    ```bash
    icp canister call backend submit_arcade_score '("minigolf", 5 : nat32, ...)' -e local --identity dev2
    # -> Err "MINIGOLF_RETIRED" (or UNKNOWN_GAME)
    icp canister call backend get_arcade_leaderboard '("minigolf")' --query -e local   # empty vec
    icp canister call backend get_arcade_leaderboard '("fieldgoal")' --query -e local  # still works
    ```

**P1 sign-off:** see §4.

### Phase 2 (P2) — list / buy / resell with royalty visible in payouts

1. As **dev1**, open "Dev1 Loop" → **Manage** → set a price (e.g. 1 ICP) → **List for
   sale**. **Expected:** card now shows **For sale · 1 ICP** and a **Buy** button to
   non-owners. **Verify:** `get_course` shows `listed=true, price_e8s=100_000_000`.
2. Fund **dev2** (faucet ×1 → 100 ICP). As dev2, click **Buy** → approve (ICRC-2) →
   confirm `buy_course_nft`. **Expected:** ownership transfers to dev2; the card's
   owner line updates to "owned by dev2". **Verify on-chain:**
   ```bash
   icp canister call course_nft icrc7_owner_of '(vec { <token_id> : nat })' --query -e local   # dev2
   icp canister call backend get_course '(<token_id> : nat64)' --query -e local                # owner=dev2, listed=false
   ```
3. **Royalty visible in payouts:** the buy split is 75/10/10/5 (PB-307 / overview §5);
   the **creator (dev1)** receives the royalty leg. As dev1, open **Payouts** (or
   `get_payouts`/the payout history view). **Expected:** a payout entry attributable to
   the resale royalty. **Verify:** dev1's ICP balance increased by the royalty leg;
   cross-check the split arithmetic against doc **03**'s economic-invariant test (don't
   re-derive here — 03 owns the split-sum assertion).
4. **Resell:** as dev2, **Manage** → list at a new price; as dev1, buy it back.
   **Expected:** ownership returns to dev1, royalty paid to the creator (dev1) again,
   subsequent plays credit the **live** owner at hole 2.
5. **Delist warning:** dev2 (or current owner) delists. **Expected:** copy warns
   **delisted courses earn no owner tickets**; the course leaves the public browser but
   the owner can re-list free. **Verify:** `get_course` shows `listed=false`; a
   `start_play_session` on it now rejects (unlisted gate, PB-306).

> The buy/approve/royalty *backend* assertions (escrow C3, split sums, refund-from-
> escrow) are owned by docs **02/03**. P2 here is the **UX cutover** + "is the money
> visible in the right places" walk-through.

### Phase 3 (P3) — featured-slot bid/outbid in a ck-token; rate a course

1. Ensure ck-token ledgers are wired (deploy-local wires ckBTC/ckETH/ckUSDC/ckUSDT).
   Faucet a ck-token to dev1 and dev2 (`dev_faucet_token '(variant { CkBTC })'`).
2. As **dev1**, on "Dev1 Loop" use the **Feature your course** bid modal (PB-308) → bid
   in **ckBTC**. **Expected:** the course pins to the **Featured** full-width slot with
   the badge and is removed from the pool below. **Verify on-chain:**
   ```bash
   icp canister call backend list_marketplace_courses '(record { ... Any ... })' --query -e local
   # featured_token_id = Some(<token_id>); that token absent from `courses`
   ```
3. As **dev2**, place a **higher USD-valued** bid (in any ck-token). **Expected:** dev2
   displaces dev1; dev1 is refunded; the featured card switches to dev2's course.
   **Verify:** `featured_token_id` now points at dev2's token; dev1's ck-token balance
   reflects the refund (cross-ref doc **03** for the USD-valuation/refund invariant).
4. **Rate a course:** as **dev2** (a *completer* of "Dev1 Loop" from P1), open the
   course detail → submit a rating. **Expected:** the aggregate rating appears on the
   card. **Verify on-chain:**
   ```bash
   icp canister call backend rate_course '(<token_id> : nat64, 5 : nat8)' -e local --identity dev2
   icp canister call backend get_course '(<token_id> : nat64)' --query -e local   # aggregate reflects the rating
   ```
   Try rating as a principal that never completed the course → rejected (only completers
   may rate; the RatingKey C2 ordering assertion is owned by doc **03**).

---

## 4. Performance / limits manual checks

Run after P1 (need a wired CourseNFT canister + at least one mint).

1. **Large-but-valid mint near the size ceiling.** In the editor, fill holes with
   elements approaching the per-hole (200) / per-course (1200) caps and the **24 KiB
   target** (the editor warns past 24 KiB; the hard ceiling is 64 KiB).
   **Expected:** the editor warns past 24 KiB but still allows Mint up to 64 KiB; a
   course pushed over 64 KiB **cannot** mint (Mint disabled with a size reason). Mint a
   near-24 KiB course. **Expected:** mint succeeds and the course plays at a steady
   frame rate. **Verify:** `get_course_data '(<token_id>)'` returns the blob; its length
   is < 64 KiB; the mint arg and any `icrc7_token_metadata` reply stay well under the
   2 MiB message cap (C5 — owned by doc 03 at the canister boundary; here just confirm
   the call doesn't reject for size).
2. **Marketplace with many courses.** Mint ~25–30 courses (script the mints via the
   editor + faucet, or a dev helper) and browse. **Expected:** the grid paginates
   9/page smoothly, filters stay responsive, the shuffle re-rolls per load with no
   visible jank, and `list_marketplace_courses` returns within a query budget (cards
   read only cached fields — no per-card `course_data` blob fetch, per PB-305 B3 / C5).
   **Verify:** the query never batch-reads `course_data` (the only blob read is the
   single-token `get_course_data` on **Play**).
3. **Long play session.** Play a full 9-hole round at human pace and let it run several
   minutes (well within the **2 h** session TTL). **Expected:** no memory growth in the
   tab, the session completes and credits once; an abandoned session is swept by the
   5-minute timer (re-query `get_lottery_info` — no phantom credits). A session left
   open past 2 h then completed → `SESSION_EXPIRED` (use the dev panel time-warp if
   available).

---

## 5. L4 gate command & per-phase manual sign-off

### L4 gate (the per-PR command from overview §6)

```bash
cd src/frontend && npx tsc -b && npx vitest run
```
Must be green before any Course-NFT frontend PR merges. (`tsc -b` catches binding/opt
type drift; `vitest run` is L4 §1–§2.) Backend `cargo test -p backend --lib` and
`cargo test -p course_nft` are the companion per-PR gates — owned by docs **01/02**.

### Per-phase manual sign-off checklist (L5)

**P1 — MVP cutover (signs off overview §5 steps 1–3 + 5, and PB-309):**
- [ ] Editor builds a valid 9-hole course; every palette group places; status chips
      accurate; Mint enables only when all 9 valid; Playtest records nothing.
- [ ] Draft autosaves + Resume restores it; `get_my_course_draft` round-trips; draft
      cleared after a successful mint.
- [ ] Mint (0.5 ICP, 50/25/25) succeeds; `icrc7_owner_of` == dev1; `get_course` shows
      the listing with cached metadata.
- [ ] Course appears in the marketplace; filters narrow + re-shuffle; never shown twice;
      9/page pagination.
- [ ] dev2 (Tier 2+) plays to completion: dev2 +1 player ticket, dev1 +1 owner ticket
      (at hole 2), `play_count`/`tickets_distributed` +1 — all on-chain confirmed.
- [ ] Self-play: owner gets player ticket but **no** owner ticket.
- [ ] Anti-cheat sanity: too-fast holes / mid-round reload do not double-credit.
- [ ] **No** mini-golf leaderboard / "best · rank" chip anywhere; Mini Golf tab **is**
      the marketplace; `submit_arcade_score("minigolf")` rejected; Field Goal / Turbo
      Rush boards intact.

**P2 — secondary market:**
- [ ] List / update-price / delist work; only the owner can; delist copy warns tickets
      stop accruing; `start_play_session` rejects a delisted course.
- [ ] dev2 buys (ICRC-2 approve → `buy_course_nft`); ownership transfers; card owner
      line updates.
- [ ] Resale royalty is **visible in Payouts** for the creator; resell + buy-back works;
      post-resale plays credit the live owner.

**P3 — featured slot + ratings:**
- [ ] ckBTC bid pins the featured slot; the featured token is excluded from the pool.
- [ ] A higher USD-valued bid displaces it; the prior bidder is refunded.
- [ ] A completer can rate; aggregate shows on the card; non-completers are rejected.

**Performance/limits:**
- [ ] Near-ceiling course mints and plays smoothly; > 64 KiB cannot mint.
- [ ] ~25–30-course marketplace paginates/filters/shuffles without jank; no per-card
      blob reads.
- [ ] Long session completes once; abandoned sessions swept; > 2 h session expires.

> Backend correctness (sagas, splits, escrow C3, anti-cheat caps V1–V7, C1/C2/C4/C5,
> upgrade persistence) is asserted in docs **01/02/03** — this checklist signs off the
> **UX + on-chain visibility**, not the money-path internals.
