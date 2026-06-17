# AI Course Builder — agent-built mini-golf courses

> **Status:** Idea / design proposal. Not built, no implementation tasks yet.
> **Date:** 2026-06-17. Inline research (no fan-out).

## Concept

Replace the manual mini-golf **Course Editor** with an **agent-driven** flow: a user works with their
**own** agent (Claude, etc.) to design a full 9-hole course, the agent emits a **single text file**
describing the course, the user **uploads** it into our app, **previews/playtests** it, and **mints** the
NFT — name and all supplied by the agent. The course-design know-how is packaged as a **skill** the agent
follows, which both defines the text format and **advises what makes a good course**.

The app never calls an LLM — the *user's* agent does the work and hands over a text file. We just parse,
validate, preview, and mint. (So no Anthropic-API integration in the canister.)

## Goals

- **Lower the barrier:** building a fun 9-hole course by hand is tedious; an agent can do it in one shot.
- **Quality by guidance:** the skill teaches good course design (par balance, difficulty ramp, fairness,
  variety) so agent-built courses are *good*, not random.
- **One-shot upload:** a whole course as a text file → preview → mint. No per-hole hand-editing.
- **Retire the manual editor:** if this ships, the in-app `CourseEditor` is no longer needed (see below).

## How it works (end-to-end)

1. **Get the skill.** The app publishes course-builder instructions as a fetchable file (matching the
   existing `public/llms-*.txt` agent-skill pattern). The user copies a one-liner — *"Fetch
   `https://…/llms-course-builder.txt` and follow it to design a mini-golf course for me"* — into their
   agent (mirrors the Lottery page's `copyAgentSkill`).
2. **Agent designs the course.** Following the skill, the agent produces **one text file**: a course name,
   a theme, and **exactly 9 holes** (grids + obstacles), applying the design principles below.
3. **Upload + parse.** In the app, the user uploads the `.txt`. The app parses it into a `CourseDataV1`
   (the existing course struct) and runs `validateCourseData` + a **playability check** (below).
4. **Preview / playtest.** The decoded course renders in the existing engine — the user can **play it**
   (reuse `courseFromData` → `MiniGolf`) before committing.
5. **Mint.** On approve, encode to CBOR (`encodeCourseData`) and call `mint_course_nft(blob, name)` —
   **0.5 ICP**, auto-listed in the marketplace, exactly as today. The **name comes from the file**.

## The text format (proposal)

The course data model is already well-defined (`src/frontend/src/arcade/courseData.ts`):
`CourseDataV1 { version, theme, holes[9] }`; each `Hole { name, par 2–5, gridW/gridH 8–40, tee, cup,
elements[] }`; `ElementKind` covers terrain (fairway/rough/sand/water/out-of-bounds), walls, static
(rock/pillar/bumper/tree), moving (windmill/pendulum/paddle/sliding-block), and special (tunnel in/out,
ramp up/down, speed/slow tile). The engine's built-in courses are already authored as **ASCII grids**
(`rows: string[]`), which is the natural agent-friendly representation.

**Proposed format** = an ASCII grid per hole (terrain + tee + cup + static obstacles) plus a small metadata
header and an `obstacles:` list for anything needing rotation/params:

```
course: "Caldera Classic"
theme: volcanic

# Hole 1 — "First Putt"  par=2
......................
.......########.......
.......#gggggg#.......
.......#ggCggg#.......      legend: . out-of-bounds  # wall  g fairway
.......#gggggg#.......               r rough  s sand  w water
.......#ggTggg#.......               T tee (one)  C cup (one)
.......########.......               o rock  | pillar  b bumper  ^ tree

# Hole 2 — "Island Carry"  par=4
...(grid)...
obstacles:
  windmill 10,6 rot=1 speed=2
  tunnel-in 4,4 -> tunnel-out 18,10
  ramp-up 12,8 rot=0
```

- One char = one grid cell; tee `T` and cup `C` appear exactly once per hole.
- Static obstacles can be drawn inline (single chars); **moving/special** elements (rotation/params) are
  listed under `obstacles:` by coordinate so the format stays unambiguous.
- A **net-new parser** converts this text → `CourseDataV1`; everything downstream (validate, encode,
  render, mint) is reuse.

> **Open decision — format:** ASCII-grid (above, most agent-/human-readable, "draw the course") vs. a
> strict JSON/TOML mapping of `CourseDataV1` (precise, trivially parsed, less visual). **Recommend the
> ASCII-grid hybrid** — it's how the engine already authors courses and it's the most natural thing for an
> agent to generate and a human to eyeball. JSON is the easy fallback if parsing the grid proves fiddly.

## The skill — "what makes a good course"

The published instructions teach the agent both the format **and** design principles, e.g.:

- **Exactly 9 holes**, par **2–5** each, total par around **27** (the original course's balance).
- **Difficulty ramp:** start easy (straight putts), build to harder holes (carries, moving obstacles,
  switchbacks) by hole 9 — like the built-in course's "straight → dogleg → island → bunkers → water →
  slope → windmill → switchback → finale."
- **Fairness first:** every hole must be **completable** — a clear, reachable path from tee to cup; never
  trap the ball with no route. (Enforced by the playability check, but the agent should design for it.)
- **Reward skill, not luck:** place obstacles to create interesting lines, not coin-flips.
- **Variety without overload:** mix terrain and obstacle types across the course, but keep each hole
  readable — don't cram every gadget into one grid.
- **Sizing & spacing:** grids 8–40; on easy holes keep tee and cup apart enough to require a real putt.
- **Theme consistency** and a **catchy, golf-coursey name** (e.g. "Caldera Ridge").

## Reuse vs. build-new

| Piece | Reuse / new |
|---|---|
| Course data model + `validateCourseData` + `encode/decodeCourseData` | **Reuse** (`courseData.ts`) |
| Render + playtest preview (`courseFromData` → `MiniGolf`) | **Reuse** (`engine.ts`, `MiniGolf.tsx`, `CoursePlay.tsx`) |
| Mint saga (`mint_course_nft(blob, name)`, 0.5 ICP, auto-list) | **Reuse** (backend ~14592) |
| Agent-skill publishing (`public/llms-*.txt` + copy-prompt button) | **Reuse pattern** → add `llms-course-builder-*.txt` |
| **Text → CourseDataV1 parser** | **Build-new** (the core new module) |
| **Playability / solvability check** (tee→cup reachable) | **Build-new** (see risks) |
| **Upload + preview + mint page** (replaces the manual editor UI) | **Build-new** (reuses render + mint) |

## What gets retired

The manual `CourseEditor` (grid-painting UI) becomes redundant — the upload-from-agent flow replaces it.
Keep the **renderer/playtest** and the **mint** path; remove (or hide behind a flag) the editing canvas.
Note the `CourseEditor` also currently hosts the "Create → mint" and "Course rules" dialogs and the mint
button + gate — those move to the new upload page. (Don't delete the engine or `courseData.ts`.)

## Validation, safety & risks

- **`validateCourseData` covers structure** (9 holes, par 2–5, grid 8–40, one tee/cup, element bounds) —
  reuse it as the first gate. It does **not** check *playability*.
- **Playability check (net-new, important):** before allowing a mint, verify each hole has a **reachable
  path from tee to cup** (a flood-fill over walkable cells, accounting for walls/water/out-of-bounds).
  Without this, an agent could produce an unsolvable hole that passes structural validation. This is the
  one genuinely new piece of logic the feature needs.
- **Untrusted text parsing:** bound everything (9 holes, grid ≤ 40×40, element-count caps) so a huge/
  malicious file can't DoS the parser — the existing `LIMITS` already define the bounds; enforce them in
  the parser, reject anything over.
- **Quality / cheese courses:** the agent could make trivial or ugly courses. Defenses already exist:
  the **human preview/playtest** before mint, and **moderation** (admin hide/burn) for anything live.
- **Garbage-in clarity:** parse/validation errors should map to clear, agent-readable messages (so the
  user can paste the error back to their agent to fix) — e.g. "Hole 4: no path from tee to cup",
  "Hole 7: par must be 2–5".

## Open questions

- **Format:** ASCII-grid hybrid vs. JSON (recommend ASCII; see above).
- **Edit-after-upload:** allow tweaking an uploaded course in a minimal editor, or strictly
  upload-or-nothing (and re-ask the agent to fix)? Recommend strict upload + clear errors for v1.
- **Skill distribution:** a fetchable `llms-course-builder.txt` (matches today's pattern) — and/or a formal
  Agent-SDK/Claude-Code skill package? The fetchable file is the low-friction default.
- **Retire vs. keep the manual editor:** fully remove, or keep it behind an "advanced" toggle as a
  fallback? The user wants it gone; recommend hiding it behind a flag first, removing once the upload flow
  proves out.
- **Versioning:** the format carries `version` (`COURSE_DATA_VERSION = 1`); the text format should declare
  its version too so the parser can evolve.

## Key references

- Format/validate/codec: `src/frontend/src/arcade/courseData.ts` (`CourseDataV1`, `ElementKind`, `LIMITS`,
  `validateCourseData`, `encodeCourseData`, `decodeCourseData`).
- Engine ASCII authoring + loader: `src/frontend/src/arcade/engine.ts` (`DEFAULT_HOLES` rows, `courseFromData`).
- Preview/playtest: `src/frontend/src/arcade/MiniGolf.tsx`, `src/frontend/src/CoursePlay.tsx`.
- Mint: `mint_course_nft` (backend `src/backend/src/lib.rs` ~14592), `MINT_FEE_E8S` 0.5 ICP; current
  editor `src/frontend/src/CourseEditor.tsx`.
- Agent-skill pattern: `src/frontend/public/llms-*.txt` + `copyAgentSkill` in `src/frontend/src/Lottery.tsx`.
