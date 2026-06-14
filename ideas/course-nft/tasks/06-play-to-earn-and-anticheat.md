# Play-to-Earn & Anti-Cheat — Build Spec (PB-306)

> Owns the complete play → lottery-ticket pipeline for the Course NFT feature, and
> the anti-cheat model that protects it. **Every ticket-crediting path in the
> feature routes through this spec.** Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md)
> first — it locks the decisions (esp. **D1: signed play-session + per-day caps,
> no server-side physics replay**), the MemoryId table, and the repo conventions
> this spec obeys. Source design: the "Playing a Course" sections of
> [`course-nft-design.md`](../course-nft-design.md) and [`economy-and-ux.md`](../economy-and-ux.md).

Tickets here are the same `LOTTERY_TICKETS` tickets a staker earns — they go into
the **current lottery round** and convert directly to ICP: the prize is 80% of the
lottery pot, and a holder's win probability is `count / total_tickets`
(`lottery_odds_denominator`, `lottery_draw`). **A ticket has real ICP expected
value.** Anything that lets a user mint tickets without genuine, capped play is
theft from every honest ticket-holder and from the pot. That is the threat this
spec defends.

---

## PART A — Design / Behavior

### A1. Threat model

The mini-golf physics engine runs **client-side** (`src/frontend/src/arcade/engine.ts`,
`MiniGolf.tsx`). The backend never sees the ball; it only sees the events the client
chooses to report. By D1 we do **not** replay physics server-side. So the backend
cannot prove a hole was *legitimately* sunk — only that the *claims* arrive in a
shape consistent with one real human playing one round at human speed. The defense
is therefore **structural + rate-limiting**, not simulation.

Concrete farming vectors and our stance:

| # | Vector | What the attacker does | Defense | Residual |
|---|---|---|---|---|
| V1 | **Spoofed hole-2 to pump an owner** | Owner (or a friend) scripts `record_hole_event(hole=2)` over and over to mint owner tickets on a course they own. | Hole-2 credit only fires inside a **live session** that started with `start_play_session`, requires holes 1→2 **in order**, enforces **min pacing**, and is **capped per (player, course, day)** and **per owner, day**. | Owner can still earn up to the daily cap from real-looking sessions (see V5). Accepted. |
| V2 | **Spoofed completion for self** | Player scripts a "completion" to mint themselves a player ticket. | `complete_round` requires a live session with **all 9 holes recorded in order**, each hole already pacing-gated, all under the session, deduped. Faking it costs ≥ (9 × min-pace) wall-clock per ticket and counts against the player's daily cap. | Patient bot can still earn up to the player daily cap. Accepted, bounded. |
| V3 | **Replay** | Re-submit a captured `record_hole_event` / `complete_round` call. | Per-`(session, hole)` **dedupe**; `complete_round` is **terminal** (session marked `Completed`, then ignored); session ids are **server-minted and monotonic**, never client-chosen. | None material. |
| V4 | **Idle-bot loop** | Headless loop: start session → fire 9 holes as fast as allowed → complete → repeat. | Min **inter-hole pacing** (wall-clock floor between consecutive holes) + **per-(player,course,day)** and **per-player,day** caps bound throughput hard. A bot hits the cap in a handful of rounds, then earns nothing more that day. | Bot earns up to the daily cap. This is the explicit accepted ceiling. |
| V5 | **Multi-account / self-play** | Attacker plays their *own* course from N sock-puppet principals to farm owner tickets. | **Per-owner daily cap** caps total owner tickets/day regardless of how many distinct players hit the course. **Per-(player,course,day)** stops one puppet farming one course. **Self-play rule:** when the *player principal == current owner*, hole-2 owner credit is **suppressed** (you cannot earn owner tickets off your own play). Sybil cost: each puppet must be **Tier 2+** to earn the *player* ticket and is itself daily-capped. | Sybil farms owner tickets across many distinct *real* Tier-2 principals up to the per-owner cap. Sybil resistance beyond the cap is **out of scope** (no KYC); the per-owner daily cap is the backstop. |
| V6 | **Out-of-order / partial fabrication** | Report hole 5 without 1–4 to skip pacing, or report hole 2 twice. | **Monotonic in-order** rule: `record_hole_event(hole=h)` accepted only if `h == last_hole + 1`. Dedup per `(session,hole)`. | None. |
| V7 | **Stale / cross-round / cross-owner session** | Start a session, let the NFT transfer, then complete to credit the wrong owner; or hold a session open across a lottery round boundary. | Owner is resolved **live at the hole-2 moment** via `course_nft.icrc7_owner_of` (not the start snapshot — snapshot is journal-only). Ticket credit always targets the **current lottery round**. Sessions **expire** (TTL) and are swept. | None material. |

**Explicitly accepted (by D1):** we accept that a determined attacker can earn *up
to the daily caps* with fabricated-but-well-shaped sessions, because the engine is
client-side and we do not replay physics. The caps make this economically
uninteresting relative to staking, and bound the blast radius. See A7 for cheap
future hardening that stays within these interfaces.

### A2. Signed play-session model (D1)

Three update endpoints form the pipeline. "Signed" here means **server-stamped and
server-held**: the session id and all trust-bearing fields are minted by the
backend and stored in stable memory; the client only echoes the opaque id back. No
client-side crypto signature is required (the backend *is* the trust anchor), which
matches the repo's existing session-free, principal-authenticated model.

1. **`start_play_session(token_id) -> StartSessionResult`** — called when a round
   begins (player taps **Play**). **This is a pure synchronous update — it performs
   NO `await` / inter-canister call** so the game starts instantly (review C4):
   - requires the course is **minted + listed** (delisted courses accrue nothing,
     per design; reuse `COURSE_LISTINGS` from [05](05-marketplace.md), a local read);
   - mints a monotonic `session_id` (from `NEXT_SESSION_ID`), stamps
     `player = get_caller()`, `token_id`, `issued_at = current_time()`,
     `last_hole = 0`, `status = Active`;
   - persists it to `PLAY_SESSIONS` (MemoryId 79);
   - returns the `session_id` (+ server time, for the client's pacing UX).

   > **C4 — no `raw_rand` on game start.** `raw_rand` is an async Management-canister
   > call (threshold randomness → consensus round-trips, ~2–4 s + cycles); calling it
   > every time a round starts would make play feel broken. Session integrity does **not**
   > need an unpredictable nonce: `session_id` is **server-minted and monotonic** (never
   > client-chosen) and every event is bound to `session.player == get_caller()`, so a
   > guessed id is useless to an attacker. If a journal nonce is still wanted, derive it
   > **synchronously** — e.g. `current_time() ^ (session_id.wrapping_mul(0x9E37_79B9_7F4A_7C15))`
   > — never from `raw_rand`. (The lottery's `raw_rand` use is fine: it runs per *draw*,
   > not per game start.)
   >
   > The **owner-at-start snapshot is also dropped** from this call — it required an
   > `icrc7_owner_of` cross-canister await and was journal-only. The authoritative owner
   > is resolved **live at the hole-2 moment** in `record_hole_event` anyway (that one
   > necessary `await` happens only when a ticket is actually credited, not on every start).

   **Anonymous callers may start a session** (anyone can play for free) — but an
   anonymous player earns no *player* ticket on completion (Tier gate, A3), and the
   *owner* still earns on hole 2. Anonymous self-play (player == owner) is
   impossible (owner is a real principal), so no special case.

2. **`record_hole_event(session_id, hole) -> RecordHoleResult`** — called when the
   player **sinks** each hole. Accepted only if:
   - the session exists, `status == Active`, belongs to `get_caller()`, and is not
     expired (TTL, A4);
   - `hole == session.last_hole + 1` (**monotonic, in-order**; `1..=9`);
   - **pacing:** `current_time() - session.last_hole_at >= MIN_HOLE_INTERVAL_NS`
     (for `hole == 1`, measure from `issued_at`). Too fast → `TooFast` (the client
     should not retry; it's a cheat signal or a clock issue).
   - On accept: set `last_hole = hole`, `last_hole_at = now`, persist.
   - **Dedupe:** because acceptance requires `hole == last_hole + 1`, a replayed or
     duplicated hole event is naturally rejected (`OutOfOrder`) — there is no path
     to credit the same `(session, hole)` twice.
   - **Hole-2 side effect (the owner trigger):** when `hole == 2` is accepted,
     credit the **current owner** 1 ticket — resolve the owner **right now** via
     `course_nft.icrc7_owner_of(token_id)` (live, no grace, no retro), subject to
     self-play suppression (V5) and the per-owner / per-(player,course) caps (A5).
     On a successful owner credit, increment the NFT's `play_count` and
     `tickets_distributed` via `course_nft` (A6). Cap rejection does **not** fail
     the call — the hole still advances; the credit is just skipped (return value
     reports `owner_credited: false`). A failed `icrc7_owner_of` call **does** skip
     the credit but still advances the hole (the round shouldn't die because the
     NFT canister hiccuped); we do **not** retroactively credit.

3. **`complete_round(session_id) -> CompleteRoundResult`** — called when hole 9 is
   sunk. Accepted only if:
   - session exists, belongs to caller, `status == Active`, not expired;
   - `session.last_hole == 9` (all nine recorded in order);
   - On accept: mark `status = Completed` (**terminal** — further calls return
     `AlreadyCompleted`), then credit the **player** 1 ticket **iff Tier 2+**
     (A3), subject to the per-player daily cap (A5). Tier gate failing or cap
     hitting is **not** an error — return `player_credited: false` with a reason.
   - The completed session is left in `PLAY_SESSIONS` until the TTL sweep removes
     it (keeps `complete_round` idempotent against retries).

### A3. Tier gate for the player ticket

The **player** ticket (full 9-hole completion) requires **Tier 2+** = signed-in
(authenticated, following the leader). Reuse the existing tier derivation
(`get_eligibility`: tier 0 anon, tier 1 authenticated-not-following, tier 2+
following). Concretely the gate is **`tier >= 2`** computed inline from
`USER_NEURONS` like `get_eligibility` does. Anonymous (tier 0) and tier-1 players
earn **no** player ticket; they can still play, and the owner still earns on hole 2.
The **owner** ticket has **no tier gate** (the owner is rewarded for the asset, not
for being signed in this session).

### A4. Session lifecycle, TTL & sweep

- **TTL:** `SESSION_TTL_NS = 2 hours`. A session older than `issued_at + TTL` is
  treated as expired by all three endpoints (`SessionExpired`) and is eligible for
  the sweep. Two hours comfortably covers a real 9-hole round (which is minutes)
  while bounding stable-memory growth from abandoned rounds.
- **Sweep:** piggyback on the existing staking/lottery 5-minute timer
  (`setup_timers`). A `sweep_play_sessions()` pass removes sessions where
  `status == Completed` **or** `now > issued_at + SESSION_TTL_NS`, bounded to
  `SESSION_SWEEP_BATCH = 200` removals per pass to stay under the instruction limit.
  (Pattern mirrors the staking sweep.)
- **Dropped connection:** if the client never calls `complete_round`, the session
  simply expires and is swept — no tickets minted for an unfinished round, which is
  correct (player earns nothing without completion; owner already got hole-2 credit
  if it was reached). See B4 for the frontend's resume/idempotency handling.

### A5. Per-day caps & dedupe (D1)

`COURSE_TICKET_CAPS: (Principal, u32 day) -> u32 count` (MemoryId 80). The
**`day`** is the same UTC epoch-day the lottery uses
(`now / 1e9 / SECS_PER_DAY`, as a `u32`). One row per principal per day; counts
roll to zero implicitly when the day changes (a new `(principal, day)` key).

Two distinct daily ceilings, both keyed off this map:

- **Per-player player-ticket cap:** `MAX_PLAYER_TICKETS_PER_DAY = 20`. A player
  earns at most 20 *completion* tickets per UTC day. Rationale: a genuine human
  rarely finishes 20 full 9-hole rounds/day; at ≥ 9 × min-pace per round this is a
  generous human ceiling but a hard wall for bots.
- **Per-owner owner-ticket cap:** `MAX_OWNER_TICKETS_PER_DAY = 200`. An owner earns
  at most 200 hole-2 tickets per UTC day **across all their courses combined**.
  Rationale: caps the passive-yield blast radius from a viral course or a sock-puppet
  swarm to a known, bounded number, while leaving real popular courses room to earn
  meaningfully early in the player base.

Plus a **per-(player, course, day)** anti-concentration limit to stop one player
farming one course:

- **`MAX_PER_COURSE_PER_PLAYER_PER_DAY = 5`.** A single player can trigger at most
  5 hole-2 owner credits **on the same course** per UTC day. Beyond that, the
  player can keep playing that course (and complete rounds toward their *own*
  player cap), but no further *owner* ticket is minted from that player on that
  course that day. Rationale: genuine replay value of one course in one day is low;
  this directly defeats "one puppet hammering one course."

**Key scheme** (all in the one `COURSE_TICKET_CAPS` map, distinguished by a small
synthetic principal-domain trick is *not* used — instead we key by the natural
principal and add a second narrow map only where a composite key is required):

- Per-player player cap → `COURSE_TICKET_CAPS[(player, day)]` (the player's own row,
  player-ticket counter).
- Per-owner owner cap → `COURSE_TICKET_CAPS[(owner, day)]` (the owner's own row,
  owner-ticket counter).

  Because a principal can be **both** a player and an owner on the same day, each
  row stores **two counters** (see `TicketCapEntry` in B1), not a bare `u32`. (The
  overview's table type `(Principal, day) -> u32` is refined to `-> TicketCapEntry`
  in this spec; the overview is updated in lockstep.)

- Per-(player, course, day) → a composite key `(player, token_id, day)`. To avoid a
  second MemoryId, this is folded into the **same** map by hashing
  `(player, token_id)` into a derived principal is brittle; instead we add a second
  stable map **`COURSE_PAIR_CAPS: (Principal player, u64 token_id, u32 day) -> u32`
  (MemoryId 85)** — assigned in the overview's allocation table. (Cleaner and
  upgrade-safe vs. key-packing.)

**Self-play handling (owner plays own course):** before any owner credit, if
`player == live_owner`, **suppress** the owner credit entirely (V5). The owner can
still earn a *player* ticket by completing the round (subject to the player cap) —
that's legitimate active play. They just can't pay themselves the passive owner
ticket off their own session.

**Dedupe summary:** replay/duplication is blocked at three layers — monotonic
`(session, hole)` acceptance (A2), terminal `complete_round` (A2), and the daily
caps (A5). No single fabricated event can be credited twice.

### A6. Ticket crediting — into the existing lottery round

Crediting reuses the lottery system verbatim, modeled on `dev_grant_lottery_tickets`:

```
credit_course_ticket(recipient):              // internal helper
  if is_admin_principal(recipient) { skip }   // admin-exclusion, like the lottery
  let mut state = lottery_state();
  let mut entry = LOTTERY_TICKETS[recipient]
      .unwrap_or(TicketEntry{ round: state.round, count: 0, last_claim_day: 0 });
  if entry.round != state.round {             // stale round → reset count, keep last_claim_day
      entry = TicketEntry{ round: state.round, count: 0, last_claim_day: entry.last_claim_day };
  }
  entry.count        += 1;
  state.total_tickets += 1;
  if state.next_draw_at == 0 { state.next_draw_at = next_draw_after(now); }
  LOTTERY_TICKETS.insert(recipient, entry);
  set_lottery_state(state);
```

- **Always the current round** (`lottery_state().round`) — never a snapshot round.
- **Admin-exclusion respected:** admins never hold tickets (mirrors
  `claim_daily_tickets`'s `ADMINS_EXCLUDED` and `void_current_round_tickets`). If
  the credit *recipient* is an admin, the credit is silently skipped (the play still
  succeeds; no error). This applies to *both* owner and player credits.
- Course tickets are **not** gated behind staking eligibility — they are earned by
  activity, not by holding a stake.
- **Tickets are never voided (confirmed product rule, 2026-06-13).** The *only* event
  that clears a user's tickets is **winning the lottery**: a draw increments
  `lottery_state().round`, after which every user's stale-round `TicketEntry` reads as
  `count = 0` on its next touch (the `entry.round != state.round` reset in the snippet
  above). That round rollover is the single, uniform reset for **all** ticket sources —
  staking daily-grant, course play, and NFT-holding alike. Tickets are **not** voided on
  unstake.
- **Required companion change to the existing lottery.** Today the staking `unstake`
  path calls `void_current_round_tickets` to zero a user's tickets when they drop their
  stake. To honor the rule above, that **on-unstake void must be removed** — once stake
  is gone the daily-grant simply stops accruing *new* tickets, but already-earned
  tickets (from any source) ride until the next win. Admin-exclusion (admins never
  hold/keep tickets) is a **separate** integrity rule and is **retained**. This is a
  small edit to the existing lottery/staking code, tracked in [00 §8](00-overview-and-architecture.md).
- **NFT counters:** on a *successful* owner credit only, call
  `course_nft.increment_play(token_id)` (PB-301) which bumps `play_count` by 1 and
  `tickets_distributed` by 1. This is a separate inter-canister call; if it fails we
  log and continue (the ticket is already credited — the metadata counter is
  best-effort cosmetic provenance, never a source of truth for payouts). Player-ticket
  completion does **not** touch NFT counters (the design ties `play_count` to the
  hole-2 / owner trigger, see the NFT metadata table).

### A7. Residual risk & cheap future hardening (no physics replay)

We accept (A1) that a bot can earn up to the caps. Cheap hardenings that fit these
exact interfaces, deferred:
- **Plausibility on stroke count / clock:** `complete_round` could carry per-hole
  stroke counts and reject rounds with impossible totals (e.g. all holes-in-one) —
  cheap heuristic, no physics.
- **Tighten caps adaptively** once we have real telemetry on honest play
  distributions (the caps are `const`s; promote to admin-tunable `Config` fields if
  needed).
- **Proof-of-work / captcha on `start_play_session`** to raise Sybil cost without
  KYC.
- **Lightweight signed event chain** (each hole event includes a hash of the prior
  engine state) — raises fabrication cost, still not a full replay.

These are **out of scope** for PB-306 (D1). The session + caps model is the shipped
defense.

---

## PART B — Implementation

All backend code lands in `src/backend/src/lib.rs` under a new banner
`// ===== 20. Course NFT marketplace =====` (shared with PB-304/305/307/308); this
spec owns the **Play / anti-cheat** subsection. `src/backend/backend.did` is updated
in lockstep (hand-maintained). Inter-canister calls to `course_nft` reuse the
`ic_cdk::call` pattern already used for ledgers (`call_icrc2_approve`,
`call_ledger_balance`).

### B1. Data models (stable)

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum PlaySessionStatus { Active, Completed }

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PlaySession {
    pub id: u64,
    pub player: Principal,           // get_caller() at start (may be anonymous)
    pub token_id: u64,
    pub issued_at: u64,              // ns
    pub nonce: u64,                  // C4: derived SYNCHRONOUSLY (time ^ id·k), never raw_rand; journal only
    pub last_hole: u8,               // 0..=9, monotonic
    pub last_hole_at: u64,           // ns of last accepted hole event
    pub status: PlaySessionStatus,
    #[serde(default)]
    pub owner_credited_holes: u8,    // = 1 once hole 2 credited (debug/idempotency aid)
}
impl_storable!(PlaySession);

/// Two daily counters per principal (a principal can be both player & owner today).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct TicketCapEntry {
    #[serde(default)] pub player_tickets: u32,  // completion tickets earned today
    #[serde(default)] pub owner_tickets: u32,   // hole-2 tickets earned today
}
impl_storable!(TicketCapEntry);

// Composite key for the per-(player, course) anti-concentration cap.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PairCapKey { pub player: Principal, pub token_id: u64, pub day: u32 }
impl_storable!(PairCapKey);

// (Principal, u32 day) composite key for COURSE_TICKET_CAPS.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct DayCapKey { pub who: Principal, pub day: u32 }
impl_storable!(DayCapKey);
```

> **C2 scope note.** These two cap keys are accessed **only by exact-key `get`/`insert`**
> (point lookups for "how many today?"), never by prefix `.range()`. Byte ordering is
> therefore irrelevant, so `impl_storable!` (CBOR) is correct and intentional here. The
> custom fixed-width-`Storable` requirement from review C2 applies only to keys used in
> **range scans** — `OwnerTokenKey` (PB-301, `icrc7_tokens_of`) and `RatingKey` (PB-310,
> per-course aggregation). If a future "list my caps" range scan is ever added, these
> would need the fixed-width treatment too.

```rust
thread_local! {
    static PLAY_SESSIONS: RefCell<StableBTreeMap<u64, PlaySession, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(79)))));

    static COURSE_TICKET_CAPS: RefCell<StableBTreeMap<DayCapKey, TicketCapEntry, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(80)))));

    static NEXT_SESSION_ID: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(82)), 1u64)));

    static COURSE_PAIR_CAPS: RefCell<StableBTreeMap<PairCapKey, u32, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(85)))));
}
```

**MemoryId claims (per [00 §5](00-overview-and-architecture.md)):**
79 `PLAY_SESSIONS`, 80 `COURSE_TICKET_CAPS` (value refined to `TicketCapEntry`),
82 `NEXT_SESSION_ID`, **85 `COURSE_PAIR_CAPS`**. 81 is ratings (PB-310),
83 is `MINT_SAGAS` (PB-304), 84 is `COURSE_SALES` (PB-307). No reuse.

Constants:

```rust
const MIN_HOLE_INTERVAL_NS: u64 = 3_000_000_000;          // 3 s wall-clock floor between holes
const SESSION_TTL_NS: u64       = 2 * 3_600 * 1_000_000_000; // 2 h
const SESSION_SWEEP_BATCH: usize = 200;
const MAX_PLAYER_TICKETS_PER_DAY: u32 = 20;
const MAX_OWNER_TICKETS_PER_DAY: u32  = 200;
const MAX_PER_COURSE_PER_PLAYER_PER_DAY: u32 = 5;
```

### B2. course_nft client (inter-canister)

```rust
fn course_nft_canister_id() -> Principal { /* from Config (add field) or a const per network */ }

async fn course_nft_owner_of(token_id: u64) -> Result<Option<Principal>, String> {
    // ICRC-7: icrc7_owner_of : (vec nat) -> (vec opt Account) query.
    // Call with [token_id], read element 0, map Account -> owner Principal.
    let res: Result<(Vec<Option<Icrc7Account>>,), _> =
        ic_cdk::call(course_nft_canister_id(), "icrc7_owner_of", (vec![candid::Nat::from(token_id)],)).await;
    match res {
        Ok((mut v,)) => Ok(v.drain(..).next().flatten().map(|a| a.owner)),
        Err((c, m)) => Err(format!("OWNER_OF_REJECTED ({:?}): {}", c, m)),
    }
}

async fn course_nft_increment_play(token_id: u64) -> Result<(), String> { /* PB-301 increment_play */ }
```

(`Icrc7Account { owner: Principal, subaccount: Option<Vec<u8>> }` matches the
ICRC-7 account shape defined in PB-301. The backend is the allowlisted custodian,
but `icrc7_owner_of` and `increment_play` are plain calls — no approval needed.)
Add a `#[cfg(not(target_arch = "wasm32"))]` mock seam for both so the value-moving /
ownership logic is unit-testable natively (mirrors `lottery_random_u64`,
`call_ledger_balance`): a thread-local `TEST_MOCK_OWNER: RefCell<HashMap<u64,Principal>>`
and a no-op increment.

### B3. Candid (`backend.did`)

```candid
type StartSessionResult = variant { Ok : record { session_id : nat64; server_time : nat64 }; Err : text };

type RecordHoleResult = variant {
  Ok : record { last_hole : nat8; owner_credited : bool; owner : opt principal };
  Err : text;   // SESSION_NOT_FOUND | NOT_YOUR_SESSION | SESSION_EXPIRED |
                // SESSION_COMPLETED | OUT_OF_ORDER | TOO_FAST | BAD_HOLE
};

type CompleteRoundResult = variant {
  Ok : record { player_credited : bool; reason : opt text };  // reason: ANON | TIER_TOO_LOW | DAILY_CAP | ADMIN_EXCLUDED
  Err : text;   // SESSION_NOT_FOUND | NOT_YOUR_SESSION | SESSION_EXPIRED |
                // ALREADY_COMPLETED | INCOMPLETE_ROUND
};

service : {
  // ... existing ...
  start_play_session : (nat64) -> (StartSessionResult);
  record_hole_event  : (nat64, nat8) -> (RecordHoleResult);
  complete_round     : (nat64) -> (CompleteRoundResult);
}
```

Place comment banners above each method in `backend.did` matching the existing
style (see `submit_arcade_score` / `unstake` comments). The frontend regenerates
bindings from this file (`src/bindings`, never hand-edited).

### B4. Frontend integration (`src/frontend/src/arcade/`)

The arcade mini-golf entry becomes the marketplace course-picker (PB-309); once a
course is chosen and `MiniGolf` mounts, wire the existing engine callbacks to the
three endpoints. `MiniGolf.tsx` already exposes the needed seams:
`onRoundComplete(perHole, millis)` fires when the final hole is sunk
(`g.holeIdx === HOLES_PER_ROUND - 1`), and per-hole advance is observable at
`advance()` / the `holeIdx` transitions. Add an `onHoleSunk(hole: number)` callback
to `MiniGolfProps` fired once per hole as it's sunk (1-based), and pass `token_id`.

Call sequence (wrapper component, not inside the render loop):
1. **On Play (mount):** `start_play_session(token_id)` → store `session_id` in a ref.
   On `Err`, show a non-blocking toast ("Couldn't start a scored round — playing for
   fun") and let the round proceed **unscored** (no ticket calls).
2. **On each hole sunk:** `record_hole_event(session_id, hole)`. Fire-and-await but
   **never block gameplay** — the engine continues regardless. On `TOO_FAST` /
   `OUT_OF_ORDER` (clock skew or a missed call), silently mark the session
   un-scoreable client-side and stop sending further events (the round keeps playing
   for fun). When `hole == 2` returns `owner_credited: true`, no UI is required (the
   owner, not the player, benefits).
3. **On round complete:** `complete_round(session_id)`. If
   `Ok{ player_credited: true }`, show "+1 lottery ticket" in the completion card.
   If `player_credited: false`, show the `reason` mapped to friendly copy
   (e.g. `ANON`/`TIER_TOO_LOW` → "Sign in and follow the leader to earn tickets";
   `DAILY_CAP` → "Daily ticket cap reached").
4. **Dropped connection / reload:** the `session_id` lives only in memory; a reload
   abandons the round (expected — no completion, no player ticket; the owner keeps
   any hole-2 credit already granted). The backend session expires & is swept. Do
   **not** persist `session_id` to localStorage (a resumed "session" is exactly the
   replay surface we're avoiding).

Reuse `ui.tsx` primitives for the completion card; surface ticket counts via the
existing lottery `my_tickets` (refresh `get_lottery_info` after a completion).
Anonymous decode note: `opt principal` / `opt text` come back via the `{__kind__}`
optional wrapper (see `frontend-dev` skill) — handle the empty case.

### B5. Acceptance criteria

- [ ] `start_play_session` mints a monotonic, server-stamped session for a
      minted+listed course; rejects unminted/unlisted token ids. Anonymous allowed.
- [ ] `record_hole_event` accepts holes strictly in order 1→9, one per call;
      rejects out-of-order, duplicate, wrong-hole, fast (< 3 s), expired, foreign,
      and completed sessions with the documented error strings.
- [ ] Completing **hole 2** credits **exactly 1 ticket** to the **live** owner
      resolved at that instant (not the start snapshot), increments NFT
      `play_count`/`tickets_distributed`, and is suppressed when player == owner
      (self-play) or owner is an admin.
- [ ] `complete_round` requires all 9 holes in order, is terminal/idempotent, and
      credits the player 1 ticket **iff** Tier 2+ (anon/tier-1 → `player_credited:false`).
- [ ] All credits land in the **current** `LOTTERY_TICKETS` round, bump
      `state.total_tickets`, respect admin-exclusion, and arm `next_draw_at` if 0
      (matches `dev_grant_lottery_tickets`).
- [ ] Caps enforced: ≤ 20 player tickets/principal/day, ≤ 200 owner
      tickets/owner/day, ≤ 5 owner credits per (player, course)/day. Cap hits skip
      the credit without failing the play call.
- [ ] Sessions expire after 2 h and are swept (≤ 200/pass) on the existing 5-min
      timer; completed sessions are reaped.
- [ ] `backend.did` updated with the three methods + result types; `npx tsc -b`
      passes against regenerated bindings.
- [ ] No MemoryId reuse; new structs use `#[serde(default)]` on added fields;
      `cargo build` + upgrade (pre/post) preserves sessions and cap counters.

### B6. Test plan

**Unit (`cargo test -p backend --lib`, native, using `set_mock_caller`,
`TEST_MOCK_RAND`, the new `TEST_MOCK_OWNER`, and `current_time` fixed at
1_700_000_000…):**

Anti-abuse rules (one test each):
- `record_hole_event` rejects `hole != last_hole + 1` (out-of-order: jump to 5).
- duplicate hole event for the same hole → `OUT_OF_ORDER` (dedupe).
- pacing: second hole < `MIN_HOLE_INTERVAL_NS` after the first → `TOO_FAST`;
  ≥ interval → `Ok`.
- replay of a completed-round call → `ALREADY_COMPLETED`; session is terminal.
- foreign caller on someone else's session → `NOT_YOUR_SESSION`.
- expired session (advance `current_time` past TTL via a test hook) → `SESSION_EXPIRED`.
- `complete_round` with `last_hole < 9` → `INCOMPLETE_ROUND`.

Ownership-at-hole-2:
- owner credited is the owner returned by `TEST_MOCK_OWNER` **at the hole-2 call**,
  even after changing the mock owner mid-session (start snapshot ≠ credited owner).
- `icrc7_owner_of` returning `None`/error → hole advances, no credit, no trap.

Caps & dedupe:
- 6th owner credit from the same player on the same course same day is skipped
  (`MAX_PER_COURSE_PER_PLAYER_PER_DAY`); a 6th from a *different* player still credits.
- 201st owner ticket for an owner in one day skipped; counter resets next UTC day.
- 21st player completion ticket in one day skipped; resets next day.
- self-play: player == owner → no owner credit, but player still gets completion
  ticket (until player cap).
- admin recipient (owner or player) → credit silently skipped (admin-exclusion).

Crediting integration with lottery:
- credit increments `LOTTERY_TICKETS[recipient].count` **and**
  `lottery_state().total_tickets`; stale-round entry is reset before crediting;
  `next_draw_at` armed when 0 (assert against `dev_grant_lottery_tickets` behavior).

Tier gate:
- tier-0 (anon) and tier-1 completion → `player_credited: false`; tier-2 (following
  set in `USER_NEURONS`) → `true`.

Sweep:
- a session past TTL and a `Completed` session are removed by
  `sweep_play_sessions()`; an active in-TTL session survives; batch cap honored.

**Local integration (PocketIC, via `run-tests` / `icp-local-deploy`):**
- Deploy backend + `course_nft` (extend `scripts/deploy-local.sh`). Mint a course
  (PB-304), list it, then drive `start_play_session` → 9 ordered `record_hole_event`
  (sleeping ≥ 3 s between, or using a dev time-warp) → `complete_round`; assert the
  owner's and player's `get_lottery_info().my_tickets` each increased by the right
  amount and the NFT's `play_count` incremented by 1 (hole-2 only).
- Transfer the NFT between hole 1 and hole 2 (`icrc7_transfer`); assert the **new**
  owner gets the hole-2 ticket and the old owner gets nothing.
- Hammer the same course from one principal; assert it caps at 5 owner credits/day.

**Manual local (frontend):**
- Play a listed course end-to-end signed in as Tier 2+: completion card shows
  "+1 ticket"; lottery page reflects it. Replay as anonymous: no player ticket,
  owner still earns. Reload mid-round: round abandons cleanly, no double-credit.

### B7. Out of scope

- **Server-side physics replay / stroke validation** (D1 — accepted residual risk,
  A7 lists deferred hardening).
- **Sybil / KYC defenses** beyond the per-owner daily cap.
- NFT mint, marketplace listing/random ordering, buy/sell & royalties, featured slot
  (PB-304/305/307/308) — this spec only *reads* listing state and *calls*
  `icrc7_owner_of` / `increment_play`.
- The `course_nft` canister's ICRC-7 surface itself (PB-301) and the engine/format
  extensions (PB-303).
- Leaderboard removal & arcade entry-point migration (PB-309).
- Making the caps admin-tunable (`const` now; promote later if telemetry warrants).

### B8. Dependencies

- **PB-301** — `course_nft` canister: `icrc7_owner_of` (live owner lookup) and
  `increment_play(token_id)` (bumps `play_count`/`tickets_distributed`); the backend
  must be allowlisted to call `increment_play`.
- **PB-303** — mini-golf engine/format: provides the 9-hole round and the per-hole
  "sunk" event the frontend hooks into (`HOLES_PER_ROUND`, `onRoundComplete`,
  new `onHoleSunk`).
- **PB-305** — marketplace: `COURSE_LISTINGS` (minted + listed gate for
  `start_play_session`) and the course-picker UI that launches a round.
- **PB-309** — arcade migration: the Play entry point that calls
  `start_play_session`.
- Reuses existing **lottery** (`LOTTERY_TICKETS`, `lottery_state`,
  `is_admin_principal`, `next_draw_after`), **auth/tier** (`get_caller`,
  `require_authenticated`, `USER_NEURONS` tier derivation, `inspect_message`),
  **time/rand** (`current_time`, `SECS_PER_DAY`, `raw_rand`/`lottery_random_u64`),
  `impl_storable!`, and the existing 5-minute timer (`setup_timers`).
