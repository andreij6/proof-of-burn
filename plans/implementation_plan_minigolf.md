# Burn Putt — Pay-to-Play Mini Golf with Weekly/Monthly Leaderboards — Implementation Plan

## What this feature is

A browser mini-golf game in the style of the classic Miniclip *Mini Golf*
flash game (reference: https://www.youtube.com/watch?v=89pJOKpmbmE):

* **Top-down 2D course view.** The player sees the whole hole: tee, fairway,
  walls, hazards, and the cup.
* **Slingshot input.** Click/touch-drag away from the ball to aim (the shot
  fires opposite the drag, like pulling back a putter) — drag distance sets
  power, with an aim line + power meter rendered while dragging.
* **Rolling-ball physics.** The ball rolls with friction, banks off walls
  with near-elastic bounces, slows in sand, drops (penalty) in water, and is
  captured by the cup when it crosses it slowly enough.
* **Stroke-play scoring.** Each hole has a par; a round is a fixed course of
  9 holes; lowest total strokes wins. A per-hole stroke cap prevents
  infinite play.

Ours differs from the reference in three ways:

1. **Pay-to-play.** Starting a round costs an entry fee (default **0.25
   ICP**, admin-tunable), charged through the house escrow-subaccount
   pattern and split **50% treasury / 25% backend cycles / 25% frontend
   cycles** — the same split as proposal settlement, so *every round
   permanently burns ICP*. This is the GOALS.md "burn-to-cycles capture"
   pillar applied to entertainment, and exactly the kind of feature the
   Community R&D board solicits.
2. **Weekly + monthly leaderboards.** Best round per player per period,
   ranked by total strokes (earliest submission breaks ties).
3. **On-chain integrity.** Rounds are started on-chain (the fee is the
   ticket), scores are submitted with the full shot log, and physics is
   **deterministic fixed-point** so the canister can replay and verify
   submitted rounds.

**IP note:** game *mechanics* are not protectable and the genre is generic
(mini golf), but we ship **zero Miniclip assets, level layouts, names, or
branding** — original art (design-system palette), original 9-hole course,
original name ("Burn Putt", working title).

## Decisions locked in (owner to veto in review)

1. **Feature-flagged from day 1.** New flag key `mini_golf` in
   `KNOWN_FEATURE_FLAGS`, **default OFF** (ships dark; admin flips it on via
   the existing kill-switch panel). All update methods are gated like the
   R&D board's.
2. **ICP-only entry fee for v1.** The multi-token machinery (ckBTC/ckETH)
   exists, but a game ticket is an impulse buy — one token keeps the flow
   one screen. Multi-token entry is a fast-follow if wanted.
3. **Fee split 50/25/25** (treasury / backend CMC / frontend CMC), reusing
   `settle_burn_split`-style code. Burn is the product.
4. **Anti-cheat in two phases.**
   * *Phase 1 (launch):* on-chain round tickets, server-side sanity
     validation (stroke bounds, hole count, course-version match, wall-clock
     bounds, one active round per principal), and the **full shot log stored
     on-chain** with every submission.
   * *Phase 2 (fast-follow, before any prize money is ever attached):*
     canister-side **deterministic replay validation** of leaderboard-top
     entries on the sweep timer; mismatch ⇒ score voided + audit log entry.
   Phase 1 is honest about its trust model: a skilled cheater can submit a
   fabricated shot log that we don't yet replay. Acceptable while the only
   stake is bragging rights; Phase 2 closes it.
5. **Determinism is non-negotiable from the first line of physics code.**
   Integer/fixed-point math only (1 unit = 1/1024 px), fixed 120 Hz
   timestep, shot = `(angle_milliradians: u16-range i32, power: 0..=1000)`.
   No floats anywhere in simulation (rendering may interpolate with floats).
   A shared golden-vector test suite keeps the TypeScript client and the
   Rust validator in lockstep.
6. **Course is data, pinned by hash.** Holes are JSON (walls, sand, water,
   tee, cup, par). The backend stores the active `course_version`
   (SHA-256 of the canonical course pack). Scores reference the version they
   were played on; changing the course starts fresh comparisons (leaderboard
   entries keep their version tag).
7. **Leaderboard periods in UTC.** `week_id = epoch_days / 7` (epoch day 0
   was a Thursday — fine; the boundary is consistent and documented in the
   UI as "resets Thursdays 00:00 UTC") and `month_id = year * 12 + month0`
   via civil-date conversion. Top 100 returned per query; periods older
   than 12 months pruned by the sweep.
8. **No prizes in v1.** Leaderboard glory only. Prize escrow from the
   treasury is a separate, later decision (it raises the anti-cheat bar to
   "Phase 2 mandatory" and adds payout/abuse design).

## 1. Data model (`lib.rs` — memory IDs 26–31; 0–25 in use (18 = IDEA_VIEWS, 19–25 = lossless staking, shipped 2026-06-10))

### `Config` additions
```rust
#[serde(default)] pub golf_entry_fee_e8s: Option<u64>,   // None → 25_000_000 (0.25 ICP)
#[serde(default)] pub golf_course_version: Option<[u8; 32]>, // active course pack hash
```
Admin setters: `admin_set_golf_fee(e8s)` (reject 0), 
`admin_set_golf_course(version_hash, holes_count, par_total)`.

### `GolfRound` — `GOLF_ROUNDS: StableBTreeMap<u64, GolfRound>` (mem 26) + `NEXT_ROUND_ID` cell (mem 27)
```rust
pub struct GolfRound {
    pub id: u64,
    pub player: Principal,
    pub started_at: u64,
    pub course_version: [u8; 32],
    pub status: RoundStatus,          // Paid | Submitted | Expired | Voided
    pub entry_fee_e8s: u64,
    // fee-split saga block guards (idempotent retry, house pattern)
    pub treasury_block: Option<u64>,
    pub backend_cmc_block: Option<u64>,
    pub frontend_cmc_block: Option<u64>,
    // filled at submission:
    pub total_strokes: Option<u32>,
    pub per_hole_strokes: Vec<u8>,
    pub submitted_at: Option<u64>,
    pub validated: bool,              // Phase 2 replay check passed
}
```

### `GolfShot` log — `GOLF_SHOTS: StableBTreeMap<(u64 /*round*/, u32 /*seq*/), GolfShot>` (mem 28)
```rust
pub struct GolfShot { pub hole: u8, pub angle_mrad: i32, pub power: u16 }
```
Bounded: ≤ 9 holes × 12 strokes = 108 shots/round.

### Leaderboards — `GOLF_BEST: StableBTreeMap<LeaderKey, BestScore>` (mem 29)
```rust
pub struct LeaderKey { pub kind: u8 /*0=weekly,1=monthly*/, pub period_id: u32, pub player: Principal }
pub struct BestScore { pub total_strokes: u32, pub submitted_at: u64, pub round_id: u64, pub course_version: [u8; 32] }
```
Insert-if-better on submission. Range scans by `(kind, period_id)` prefix;
sort + truncate to 100 in the query. Mem 22–23 reserved (validation queue /
future prize escrow).

## 2. Round lifecycle — pay first, play, submit

### `get_golf_deposit_address() -> LedgerAccount` (query)
Caller-bound subaccount, domain `proof_of_burn_golf_v1` (same derivation
style as idea/project escrows).

### `start_golf_round() -> Result<u64, String>` (update)
1. auth + `mini_golf` flag + `CallerGuard`.
2. Reject if the caller already has a `Paid` round younger than the 2 h
   expiry (`ROUND_TTL_NANOS`); auto-expire stale ones lazily.
3. Escrow balance ≥ `fee + 3×10_000` (three split transfers).
4. Create `GolfRound{status: Paid}` **before** moving funds (journal-first,
   like upvotes), then run the 50/25/25 split with per-step block guards +
   CMC notify (reuse `call_cmc_topup_transfer`/`notify_cmc_topup`; local
   no-op caveat per PB-148 applies and is acceptable).
5. Audit `golf_round_start`. Returns `round_id`.
Sweep `retry_failed_golf_fees()` resumes interrupted splits (house pattern).

### `submit_golf_score(round_id, per_hole_strokes: Vec<u8>, shots: Vec<(u8, i32, u16)>) -> Result` (update)
Sanity validation (Phase 1):
* round exists, owned by caller, `Paid`, not expired; course version matches.
* `per_hole_strokes.len() == holes_count`; each in `1..=12`;
  `sum == total`; `shots.len() == total`; shot holes monotonic and
  consistent with per-hole counts; `power ≤ 1000`.
* `submitted_at - started_at` within `[60 s, 2 h]` (nobody finishes 9 holes
  in under a minute; nobody holds a round open past TTL).
Stores strokes + shot log, flips `Submitted`, upserts both leaderboard
entries, audit `golf_score`.

### Queries
* `get_golf_info()` — flag, fee, course version, holes, par, TTL, current
  week/month period ids (one query bootstraps the page, mirroring
  `get_idea_board_info`).
* `get_my_golf_round()` — active/last round for resume-after-refresh.
* `get_golf_leaderboard(kind: u8, period_id: opt u32) -> Vec<LeaderboardRow>`
  — top 100 of the requested (default current) period, plus the caller's
  own rank/row even when outside the top 100.

## 3. Deterministic physics spec (shared TS ↔ Rust)

* Fixed point: positions/velocities in **1/1024 px** integers; course
  bounded 1024×768 px.
* Timestep: 120 Hz; max 30 s simulated per shot (3600 steps) then forced
  stop — bounds both client CPU and Phase-2 canister cycles
  (≤ 108 shots × 3600 steps ≈ 0.4 M steps/round worst case; integer math
  keeps this comfortably affordable, and validation only replays top-N).
* Ball: radius 6 px. Friction: per-step velocity scale 1023/1024 on green,
  1015/1024 in sand. Stop threshold: |v| < 4 units/step.
* Walls: axis-aligned and 45° segments only (v1) — reflection swaps/negates
  velocity components exactly; restitution 31/32. No trig at runtime: the
  shot's `(angle_mrad, power)` converts to a velocity vector via a shared
  1024-entry sine lookup table baked into both implementations.
* Cup: capture iff center within 10 px of the ball **and** |v| below the
  capture threshold; otherwise lip-out (velocity deflected).
* Water: ball returns to pre-shot position, +1 stroke. Sand: friction only.
* **Golden vectors:** ≥ 25 canonical cases (`course hole + shot → final
  position/strokes/events`) checked by both vitest and `cargo test`. Any
  divergence is a release blocker.

## 4. Frontend

* New page component `src/GolfGame.tsx` (+ `src/golf/physics.ts`,
  `src/golf/course.ts`), reached via a third nav pill ("Burn Putt", flame
  icon), gated on the `mini_golf` flag exactly like Community R&D.
* Canvas renderer (no new runtime deps): design-system palette (char
  surfaces, burn accent for aim line, sprout for the green), drag-to-aim
  with aim line + power bar, ball trail, hole intro card (hole #, par),
  running scorecard strip, par-relative coloring.
* Flow: **Play (0.25 ICP)** button → deposit + `start_golf_round` (two-step
  modal, house tx pattern) → 9 holes → scorecard → `submit_golf_score` →
  leaderboard with the player's row highlighted.
* Leaderboard view: Weekly / Monthly tabs, period navigation (current ±
  history), countdown to period reset, "my best" chip.
* Resume: on load, `get_my_golf_round` — an unsubmitted `Paid` round
  restores at the next unplayed hole (shot log replays locally to
  reconstruct state — determinism pays off immediately).
* Mobile: pointer events; the canvas scales to viewport width (min 320 px).

## 5. Course pack (original content)

9 holes, difficulty ramp: 2 straight/par-2, 3 bank-shot/par-3, 2
sand-heavy/par-3, 1 water-carry/par-4, 1 finale combining all/par-4
(par total ~27). JSON schema versioned; canonical serialization hashed
(SHA-256) → `course_version`. Stored in `src/frontend/src/golf/courses/v1.json`
and mirrored as a test fixture for the Rust validator.

## 6. Anti-cheat Phase 2 — canister replay validation (fast-follow)

* Port `physics.ts` to `golf_physics.rs` (same fixed-point spec; golden
  vectors enforce parity).
* Sweep task `validate_golf_scores()`: for each leaderboard top-10 row not
  yet `validated`, replay its shot log against the pinned course; mismatch
  ⇒ `Voided`, removed from leaderboards, audit `golf_score_voided`.
* Per-sweep budget: ≤ 2 rounds validated per tick to bound cycles.

## 7. Testing & rollout

* Unit (host): period-id math, sanity-validation rejections, fee-split
  journal/retry, leaderboard insert-if-better, prune.
* PocketIC: pay → start → submit → leaderboard; double-start rejected;
  expiry; flag-off rejection.
* Vitest: physics golden vectors, input→shot quantization, scorecard math.
* Local verification runbook: faucet → play a 3-hole dev course → verify
  treasury +50%, leaderboard row.
* Rollout: deploy dark (`mini_golf` off) → enable locally → owner playtest
  → enable in prod via the admin flag panel. The kill switch is already the
  flag system.

## 8. Risks / open questions

* **Cheating before Phase 2** — accepted (no prizes; logs stored so Phase 2
  can retro-validate and void).
* **PB-148** (local CMC no-op) means the 25/25 cycle legs only truly mint
  on mainnet — same as every other split in the app today.
* **Physics parity drift** TS↔Rust — mitigated by golden vectors in both
  CI suites; any new mechanic requires new vectors first.
* **Open:** entry fee final price; whether weekly resets should align to
  Monday (UTC civil-week math) instead of the epoch-day/7 Thursday boundary;
  prize pools (explicitly out of scope for v1).

## Task list (Epic G — PB-160…PB-171)

| ID | Task | Depends on |
|---|---|---|
| PB-160 | Deterministic physics spec + golden vectors | — |
| PB-161 | Backend: config, flag, fee escrow + 50/25/25 split saga | PB-160 |
| PB-162 | Backend: round lifecycle + score submission + sanity validation | PB-161 |
| PB-163 | Backend: weekly/monthly leaderboards + queries + pruning | PB-162 |
| PB-164 | Frontend: fixed-point physics engine (TS) + golden tests | PB-160 |
| PB-165 | Frontend: canvas renderer + slingshot input + HUD | PB-164 |
| PB-166 | Course pack v1: 9 original holes + schema + hash pinning | PB-160 |
| PB-167 | Frontend: page integration (flag-gated nav, pay flow, scorecard, submit, resume) | PB-162, PB-165, PB-166 |
| PB-168 | Frontend: leaderboard UI (weekly/monthly, countdown, my rank) | PB-163, PB-167 |
| PB-169 | Anti-cheat Phase 2: Rust replay validator + voiding sweep | PB-163, PB-166 |
| PB-170 | Tests: PocketIC E2E + vitest determinism suite | PB-167, PB-168 |
| PB-171 | Agent skill (llms-golf-*.txt), docs, local verification runbook | PB-170 |
