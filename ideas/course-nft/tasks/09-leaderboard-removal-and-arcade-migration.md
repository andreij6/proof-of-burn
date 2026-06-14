# Leaderboard Removal & Arcade Migration (PB-309)

> Phase 1. Executes **decision D4**: the Course Marketplace replaces the built-in
> mini-golf course, the global mini-golf leaderboard is removed, and the arcade's
> mini-golf entry point becomes the marketplace/course-picker.
>
> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md)
> first. This is a **migration/cutover** spec — it deletes and re-wires existing
> arcade code rather than adding a new data model. There are **no per-course
> leaderboards either** (the design docs are explicit: the game is about playing
> for fun and earning tickets, not rankings).
>
> **Depends on:** PB-303 (extended engine + course format the new entry point
> plays), PB-305 (the marketplace page this spec mounts as the entry point).

---

## Part A — Design / UX

### A1. What changes for the player

Today the arcade has three games (Mini Golf, Field Goal, Turbo Rush), each a tab
with a card + persona + a **leaderboard table** (`Arcade.tsx`
`LeaderboardSection`). Mini Golf plays a single admin-built 9-hole course
(`ARCADE_COURSE` overrides over frontend defaults) and submits a best-round score
to a global board.

After this migration:

- The **Mini Golf tab becomes the Course Marketplace** (PB-305). Clicking it (or
  the arcade landing's "Play the Arcade" → mini-golf) shows the marketplace grid,
  not a single fixed course. Players pick *any* listed course and play it.
- **The Mini Golf leaderboard is gone.** No "best round per player · top 100"
  table for mini golf, no per-course ranking. The Mini Golf card no longer shows
  "Your best: N strokes · rank #M".
- The **golfer persona** ($1 customization) is **kept** — it still renders in the
  marketplace (or its play view) the same way, since players still control a
  golfer. (No economic change; out of scope to remove.)
- **Field Goal and Turbo Rush are unchanged** — they keep their cards, personas,
  and leaderboards. Only mini-golf's leaderboard and built-in course are
  affected. `ARCADE_SCORES`/`submit_arcade_score`/`get_arcade_leaderboard` stay
  for those two games (A4).

### A2. Entry-point copy

The marketplace header (PB-305) replaces the Mini Golf card copy. Anywhere copy
implies "set the fastest mini-golf round" or rankings must be removed/rewritten
to the new framing: **play any course for fun, earn lottery tickets, courses are
NFTs you can create/own/sell.** This is a `ui-copy-in-sync` sweep (A6).

### A3. Retiring the built-in course `ARCADE_COURSE` — decision: seed as a system-minted course, then delete the override mechanism

Two options for the existing admin-editable 9-hole built-in
(`ARCADE_COURSE`/`admin_set_arcade_hole`/`admin_reset_arcade_hole`, MemoryId 45,
frontend defaults in `arcade/engine.ts` `COURSE`):

- **(a) Delete it outright.** Simplest, but launches the marketplace empty —
  nothing to play on day one until users mint, and minting costs 0.5 ICP, so the
  surface looks dead.
- **(b) Seed it as one (or a few) initial *system-minted* course NFT(s).**
  Preserve the hand-tuned 9 holes as real marketplace content owned by a system
  principal (the backend/treasury), listed and playable from launch.

**Decision: (b) — seed the built-in 9 holes as a system-minted course, then
remove the `ARCADE_COURSE` override mechanism.** Rationale: it gives the
marketplace non-empty, known-good content on day one (avoids a dead launch),
preserves work already done and playtested, and gives users a reference course.
The system course is owned by a system principal so its owner tickets either go
to the treasury's exclusion bucket or are simply not credited (it is admin-owned;
the lottery already excludes admins — overview §6 ticket-crediting note), which
keeps it from siphoning lottery value.

Concretely:
- The `course_data` blob format (PB-303) must be able to represent the existing
  built-in holes. A **one-time migration** (B3) converts the
  frontend-default + any on-chain `ARCADE_COURSE` overrides into a single
  `CourseDataV1` blob and mints it via the normal mint path (fee waived for the
  system mint) so it gets a real `COURSE_LISTINGS` row (PB-305) and a real
  ICRC-7 token (PB-301).
- After the system course exists, **delete** `ARCADE_COURSE` (MemoryId 45),
  `ArcadeHoleDef`/`ArcadeBarDef`/`ArcadeCourseEntry`, `validate_arcade_hole`,
  `get_arcade_course`, `admin_set_arcade_hole`, `admin_reset_arcade_hole`, and
  the frontend `COURSE`/`mergeCourse` built-in-course machinery — superseded by
  the marketplace + editor. **MemoryId 45 is retired and never reused**
  (overview §5).

### A4. Removing the global mini-golf leaderboard — scope

The mini-golf leaderboard is **not** a separate structure: it is the `"minigolf"`
partition of the shared `ARCADE_SCORES` map (MemoryId 43), written by
`submit_arcade_score("minigolf", …)` and read by
`get_arcade_leaderboard("minigolf")`. Field Goal and Turbo Rush share the same
map and endpoints. So removal is **surgical, not a drop**:

- **Stop writing mini-golf scores:** `submit_arcade_score` must **reject**
  `game == "minigolf"` (return `UNKNOWN_GAME`/`MINIGOLF_RETIRED`). The frontend
  Play flow no longer calls it for mini golf.
- **Stop serving mini-golf board:** `get_arcade_leaderboard("minigolf")` returns
  an empty vec (or the frontend simply never calls it). Keep the endpoint for
  Field Goal / Turbo Rush.
- **Purge existing mini-golf rows** from `ARCADE_SCORES` in `post_upgrade` (B2)
  so stale data doesn't linger.
- `ARCADE_SCORES` (MemoryId 43) **stays** (Field Goal + Turbo Rush still use it).
  Do **not** retire its MemoryId.

### A5. Migration order (player-visible)

1. Ship PB-301/303/302/304/305 (canister, format, editor, mint, marketplace).
2. Ship this spec: on upgrade, seed the system course (B3), purge mini-golf
   scores (B2), retire `ARCADE_COURSE` mechanism (B1), re-wire the Mini Golf tab
   to the marketplace (B4).
3. Players see the marketplace under the Mini Golf tab with at least the system
   course playable; no mini-golf leaderboard; Field Goal / Turbo Rush unchanged.

### A6. Copy & docs sweep (`ui-copy-in-sync`)

- `Arcade.tsx` Mini Golf card/leaderboard copy → removed/redirected to the
  marketplace.
- `llms-*.txt` agent docs: a grep confirms **no current `llms-*.txt` mentions the
  arcade or mini-golf leaderboard** (`llms-local`, `llms-prod`, `llms-crash-*`,
  `llms-lottery-*`, `llms-rd-*`, `llms-early_adopters-*` only). So there is **no
  stale arcade copy to fix today** — but if a course-marketplace agent doc is
  added later it must describe play-for-tickets, not rankings. Note this so a
  reviewer doesn't go hunting for arcade text that isn't there.
- Any landing-page / feature-list text that calls mini golf a "leaderboard game"
  must be updated to "create, own, and play course NFTs."

### A7. Acceptance criteria (UX)

- The arcade Mini Golf tab opens the Course Marketplace, not a fixed course.
- No mini-golf leaderboard appears anywhere; the Mini Golf "Your best · rank"
  chip is gone.
- At least one playable system course exists in the marketplace immediately after
  upgrade.
- Field Goal and Turbo Rush, their personas, and their leaderboards are
  unchanged.
- The golfer persona ($1 customization) still works.
- No copy anywhere implies mini-golf rankings.

---

## Part B — Implementation

### B1. Delete the built-in-course mechanism (`src/backend/src/lib.rs`)

Remove (under the arcade banner, course-editor sub-section ~lines 10648–10779):
- types `ArcadeBarDef`, `ArcadeHoleDef`, `ArcadeCourseEntry`;
  `impl_storable!(ArcadeHoleDef)`;
- `ARCADE_COURSE` thread-local (MemoryId 45) — **after** B3's migration has run
  at least once; see B5 for the safe ordering;
- `validate_arcade_hole`, `get_arcade_course`, `admin_set_arcade_hole`,
  `admin_reset_arcade_hole`, and related consts only used by them
  (`ARCADE_GRID_W/H`, `ARCADE_MAX_CELL`, `ARCADE_WALKABLE`, `MAX_ARCADE_BARS`,
  `MAX_ARCADE_HOLE_NAME`) — keep any const still referenced by the engine spec.
- Candid (`backend.did`): remove `ArcadeBarDef`, `ArcadeHoleDef`,
  `ArcadeCourseEntry`, `get_arcade_course`, `admin_set_arcade_hole`,
  `admin_reset_arcade_hole`.

**MemoryId 45 is permanently retired** — add a comment at the MemoryId table /
allocation site marking 45 as "retired (ex-ARCADE_COURSE, PB-309) — do not
reuse." (Overview §5: never reuse a MemoryId.)

### B2. Purge mini-golf scores + reject new ones

In `submit_arcade_score`: change the `ARCADE_GAME_MINIGOLF` match arm to return
`Err("MINIGOLF_RETIRED".to_string())` before any score write (or remove the arm
so it falls into `_ => UNKNOWN_GAME`). Keep `ARCADE_GAME_FIELDGOAL` /
`ARCADE_GAME_TURBORUSH` intact.

In `post_upgrade` (one-time, idempotent): iterate `ARCADE_SCORES`, collect keys
where `key.game == "minigolf"`, and remove them. Guard with a migration flag (a
`StableCell<bool>` or a version field in `Config`) so it runs once. Document it as
a one-shot cleanup. `get_arcade_leaderboard("minigolf")` naturally returns empty
afterward (no rows match); optionally short-circuit it to `vec![]` for clarity.

### B3. Seed the system course (one-time migration)

A `post_upgrade` migration (idempotent, runs once via the same migration flag as
B2):
1. Build a `CourseDataV1` (PB-303 schema) from the built-in 9 holes — converting
   the frontend default layout + any persisted `ARCADE_COURSE` overrides into the
   new element/terrain catalog. Because the new format is a superset (D4 extends
   the engine), the built-in cell-grid holes map cleanly to terrain/wall
   elements; PB-303 owns the exact conversion table — this spec consumes it.
2. Mint it through the normal mint path (PB-304) **with the fee waived** for the
   system mint, to a **system principal** (the backend canister principal or the
   treasury principal — decision: the **backend canister principal**, so the
   token is custodied by the controller and its owner tickets fall under the
   admin/treasury exclusion). This produces a real ICRC-7 token (PB-301) and a
   `COURSE_LISTINGS` row with `listed=true` (PB-305).
3. Mark the migration done.

If PB-301/304 are not yet deployable at the moment of this upgrade, the seed is a
**no-op that logs a warning** and re-attempts on the next upgrade once the
CourseNFT canister id is configured — so this spec never blocks the upgrade.

### B4. Re-wire the arcade Mini Golf entry point (frontend)

In `src/frontend/src/Arcade.tsx`:
- Remove the Mini Golf **leaderboard** (`get_arcade_leaderboard(GAME_MINIGOLF)`
  fetch, `board`/`myRow` state, the Mini Golf `<LeaderboardSection>` and the
  "Your best · rank" chip). Keep `LeaderboardSection` itself (Field Goal / Turbo
  Rush still use it).
- Replace the Mini Golf tab body: instead of the single-course card +
  `setView('golf')` → `<MiniGolf course={course} …>`, render
  **`<CourseMarketplace …>`** (PB-305). The marketplace's Play button opens the
  engine view with the selected course's `course_data` (PB-303 engine consumes
  the new blob). Keep the golfer persona card if product wants it adjacent, or
  move it into the play view.
- Remove `get_arcade_course()` / `mergeCourse(overrides)` usage and the built-in
  `COURSE` import for mini golf. The engine view now takes a course from the
  marketplace, not the merged built-in.
- `App.tsx`: no route change needed — the `arcade` page/flag still gates
  everything; the Mini Golf tab inside the arcade now shows the marketplace.
- `src/frontend/src/arcade/engine.ts`: remove the built-in `COURSE` default and
  `mergeCourse` (mini-golf no longer ships a fixed course) **only if** nothing
  else imports them; keep persona palettes (`HAIR_COLORS`, etc.) and
  `fmtMillis`/`HOLES_PER_ROUND` if still referenced.

### B5. Safe ordering within the upgrade

`post_upgrade` order matters (the `ARCADE_COURSE` map can only be read before its
thread-local is deleted):
1. `post_upgrade` runs B3 (read `ARCADE_COURSE` overrides → mint system course)
   **and** B2 (purge mini-golf scores) under the one-shot migration flag, in the
   **same upgrade** where the code still declares `ARCADE_COURSE`.
2. In a **subsequent** PR/upgrade (or guarded so the read happens before the
   removal), delete the `ARCADE_COURSE` thread-local + types (B1).

**Decision:** keep `ARCADE_COURSE` declared for the single upgrade that runs the
seed migration, then remove it in the immediately-following change. If preferred
as one PR: perform the seed read at the very top of `post_upgrade` (before any
structural assumption), then it's safe to delete the *endpoints* immediately
while keeping the thread-local declaration for that one upgrade. Mark MemoryId 45
retired regardless.

### B6. `scripts/deploy-local.sh` updates

- The `arcade` flag is already seeded on (line ~97). Also seed
  **`arcade_minigolf`** on explicitly (the marketplace keys off it per PB-305 A7)
  so the marketplace is visible locally:
  `admin_set_feature_flag '("arcade_minigolf", true)'`.
- After installing the new CourseNFT canister (added to `icp.yaml` per the
  overview §3 — owned by PB-301's deploy step) and wiring its id into the backend
  (`admin_set_course_nft_canister`, PB-301), the script should **verify the
  system course exists** (e.g. `list_marketplace_courses` returns ≥1) and, if the
  seed migration no-op'd because the canister wasn't wired at upgrade time,
  trigger a re-seed (an admin `admin_seed_system_course` callable, idempotent —
  decision: expose this admin re-seed so local + prod can recover a no-op seed
  without another upgrade).
- Remove any local seeding that called `admin_set_arcade_hole` (there is none in
  the current script — confirmed; note it so a future edit doesn't add one).

### B7. Candid

Remove the three deleted methods + three types from `backend.did` (B1). Add (if
B6 introduces it) `admin_seed_system_course : () -> (Result);`. No new query
types are introduced by this spec beyond what PB-305 already declares.

### B8. Acceptance criteria (impl)

- `cargo test -p backend --lib` green; tests:
  - `submit_arcade_score("minigolf", …)` returns the retirement error; Field Goal
    / Turbo Rush submissions still succeed.
  - the post-upgrade purge removes only `game=="minigolf"` rows from
    `ARCADE_SCORES`; Field Goal / Turbo Rush rows survive.
  - the seed migration is idempotent (running twice mints one system course, not
    two) and waived-fee.
  - upgrade safety: the migration flag prevents re-running.
- `cd src/frontend && npx tsc -b && npx vitest run` green (no dangling imports of
  removed `get_arcade_course`/`COURSE`/`ArcadeHoleDef`).
- `bash scripts/deploy-local.sh` succeeds and the marketplace shows the system
  course; the Mini Golf tab opens the marketplace; Field Goal / Turbo Rush boards
  still render.

### B9. Test plan

- **Unit (backend):** B8 list. Use a mock seam for the CourseNFT mint call so the
  seed migration is testable natively (overview §6).
- **Integration (PocketIC):** deploy old backend with mini-golf scores +
  `ARCADE_COURSE` overrides → upgrade to new backend → assert: mini-golf scores
  purged, Field Goal/Turbo Rush boards intact, one system course minted + listed,
  `get_arcade_course`/`admin_set_arcade_hole` no longer in the interface.
- **Frontend (vitest):** Arcade renders the marketplace under the Mini Golf tab;
  no Mini Golf leaderboard; Field Goal/Turbo Rush leaderboards present.
- **Manual local:** the deploy-local walk-through; play the system course; create
  + mint a new course (PB-302/304) and see both in the marketplace.

### B10. Rollback note

- **Code rollback:** because MemoryId 45 is *retired, not reused*, rolling the
  canister back to a build that still declares `ARCADE_COURSE` is safe — the map
  is still at MemoryId 45 and was only purged of *scores* (B2 touches
  `ARCADE_SCORES`, MemoryId 43, not 45). Mini-golf scores purged in B2 are
  **not recoverable** (they were intentionally deleted) — acceptable per D4 (the
  leaderboard is being removed permanently).
- **The system course** is a real NFT; a rollback that removes the marketplace
  leaves an orphaned token owned by the system principal — harmless (it just
  isn't displayed). Re-deploying forward re-displays it (idempotent seed via the
  migration flag / `admin_seed_system_course`).
- **Feature-flag rollback:** flip `arcade_minigolf` (or the parent `arcade`) off
  to hide the marketplace instantly without a code change — the cleanest
  emergency stop (flags persist across upgrades; deploy-local re-seeds them on).
- **NEVER deploy to mainnet** as part of this work (mainnet deploy gate —
  user-explicit only).

### B11. Out of scope

- The marketplace page itself, list/delist, the card → **PB-305**.
- The engine extensions + the `course_data` conversion table the seed consumes →
  **PB-303**.
- The CourseNFT canister + `admin_set_course_nft_canister` wiring → **PB-301**.
- The mint path the system seed reuses → **PB-304**.
- Removing Field Goal / Turbo Rush or their leaderboards (explicitly **kept**).
- Adding a course-marketplace `llms-*.txt` agent doc (none exists; future work).

### B12. Dependencies

- **PB-303** — engine + course format (the seed converts built-ins into it; the
  Play view consumes it).
- **PB-305** — the marketplace component mounted as the entry point; the
  `COURSE_LISTINGS` row the seed creates; the `arcade_minigolf` gating decision.
- **PB-301 / PB-304** — CourseNFT canister + mint path the system-course seed
  uses (with the no-op-and-retry fallback if not yet wired).
