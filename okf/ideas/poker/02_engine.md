---
type: idea
title: "02 — NLHE rules engine"
tags: [ideas, poker]
timestamp: 2026-06-13T22:37:20-04:00
---

# 02 — NLHE rules engine

A **pure, deterministic state machine** (`poker_engine` module in lib.rs, no
ic_cdk calls) so the whole game is unit/property-testable on the host. The
canister layer feeds it actions + RNG and persists snapshots.

## Cards, shuffle, fairness

- 52-card deck, `u8` encoding `0..52` (rank*4+suit).
- Shuffle: Fisher-Yates seeded by a per-hand 32-byte seed from `raw_rand`
  (fetched once per hand by the table driver, before dealing).
- **Commit-reveal audit:** the hand record stores `seed_hash = sha256(seed)`
  *before* any card is acted on; the seed itself is stored (revealed) when
  the hand completes. Anyone can re-derive the deck and verify every deal.
  (Same trust root as the lottery's `raw_rand` use.)

## Hand evaluator

- 7-card → best-5 evaluator returning a totally ordered `u32` strength
  (category ⨉ kickers packed). Implemented from first principles (no external
  crate needed): straights/flushes via rank masks, the rest via rank counts.
- Exhaustive-ish tests: category boundaries (wheel straight A-5, steel wheel
  flush, board-plays ties, kicker ordering), plus a 10k-hand random
  cross-check against a slow-but-obviously-correct reference evaluator kept
  in the test module.

## Betting rules (No-Limit, 25/50, no antes)

- **Streets:** preflop → flop → turn → river → showdown.
- **Blinds:** SB 25, BB 50. Heads-up: button posts SB and acts first preflop,
  last postflop (standard).
- **New/returning players:** to keep v1 simple there are **no dead-blind
  posts**: a newly seated player waits until the BB reaches them (flag
  `waiting_for_bb`); exception — if the table was below 2 active players the
  hand starts fresh with normal blind assignment.
- **Button movement:** standard "dead button" rule: the button moves to the
  next seat that was dealt in last hand; SB can be dead (no post) when the
  player busted/left; BB is always live on a seated player.
- **Min-raise:** a raise must be ≥ the size of the largest prior bet/raise of
  the street; an all-in below min-raise does not reopen action for players
  who already acted (classic incomplete-raise rule).
- **Bet sizing:** integer chips, min bet = 1 BB (50) postflop; all-in always
  legal.
- **Side pots:** built incrementally at each all-in; each pot tracks its
  eligible seat set; awards resolve pot-by-pot from the last side pot to the
  main pot. Odd chips go to the first eligible seat left of the button
  (standard).
- **Showdown order:** last aggressor shows first (or first left of button if
  the river checked through); engine reveals all called hands in the hand
  history (no mucking secrets — simplifies audit; folded hole cards stay
  hidden forever).
- **Run-it-once** only. No rabbit hunts, no straddles, no chops menus.

## Engine state machine

```
HandPhase: Dealing → Betting(street) → StreetDone → Showdown → Settled
TableState {
  table_id, hand_no, button_seat,
  seats: [Option<SeatState>; 9],
  deck: Vec<u8>, board: Vec<u8>,
  phase, acting_seat, current_bet, min_raise, pots: Vec<Pot>,
  action_deadline_ns,            // canister layer enforces
}
SeatState {
  user, agent, stack, committed_this_street, total_committed,
  hole: [u8;2], status: Active | Folded | AllIn | SittingOut | WaitingForBB,
}
Action: Fold | Check | Call | Bet(u64) | Raise(u64)   // amounts = TOTAL committed this street
```

`apply_action(state, seat, action) -> Result<Vec<EngineEvent>, EngineError>`
validates legality (turn order, amounts, min-raise) and advances the machine,
emitting events (`PostedBlind`, `Dealt`, `ActionTaken`, `StreetComplete`,
`PotAwarded{seat, amount, pot_idx}`, `HandSettled{deltas}`) the canister layer
persists and the UI/agents consume.

**Legal-action helper:** `legal_actions(state, seat) -> {can_check, call_amount,
min_raise_to, max_raise_to}` — served verbatim to agents so they never have to
re-derive rules.

## Property tests (host, PB-203 — must pass before any table code)

1. **Chip conservation:** for any random action sequence, Σ stacks + Σ pots
   is constant; after settlement Σ stack deltas = 0.
2. **Side-pot exactness:** randomized all-in stacks → awards equal a brute-
   force per-chip simulation.
3. **Min-raise legality:** generator never produces an accepted illegal
   raise; fuzzer confirms rejections don't mutate state.
4. **Determinism:** same seed + same action list ⇒ identical event stream.
5. **Button/blind rotation:** simulated 500 hands with random sit/leave keeps
   blinds fair (every active seat posts BB exactly once per orbit ± dead-button
   allowances).

## Table driver (canister layer, PB-204)

- 10 static cash tables (ids 1–10) in `POKER_TABLES` (MemoryId 54); hands
  archived to `POKER_HANDS` ring buffer (MemoryId 55, cap ~2,000 hands,
  oldest evicted).
- **Hand loop:** starts when ≥ 2 seated, non-sitting-out agents are present.
  Driver: fetch `raw_rand` → commit seed hash → deal → set action deadline →
  wait. Progress is **action-driven** (each `poker_act` advances the engine);
  a per-table `ic_cdk_timers::set_timer` fires at the deadline to apply the
  timeout policy (auto check/fold), so a silent agent can never stall a table.
- **Timeout policy (cash):** check if legal else fold; 2 timeouts in one hand
  or 3 consecutive auto-folded hands ⇒ stand up (seat lost — the "offline =
  lose your seat" rule), waitlist head is seated next hand.
- **Pacing engine (D18 — tables must be watchable):** the driver, not the
  agents, controls tempo. Every action passes through a paced reveal:
  - an agent's `poker_act` (or a house-agent decision) is **buffered** and
    applied on a per-action pacing timer of **2–4 s** (seeded from the hand
    RNG stream, so replays match) — an instant bot cannot rush the table and
    a slow one is cut off by the 30 s deadline as before;
  - **1.5 s street pause** after each betting round before the next cards;
  - **showdown reveals one seat at a time** (1 s apart, last aggressor
    first) so spectators can follow the story;
  - **5 s inter-hand pause** with the result pinned.
  Net minimum ≈ 10 s even for a blind steal; a typical multi-street hand
  plays out over 30–90 s. All pacing constants live in one
  `PokerPacing` config struct (admin-tunable via `admin_set_poker_pacing`
  within sane rails: action delay 1–10 s, inter-hand 2–30 s).
- Empty table (≤ 1 player): hand loop stops; table idles at zero cost (no
  timers scheduled).
- **Upgrade safety:** an in-flight hand serializes fully into stable memory;
  `post_upgrade` re-arms each active table's deadline timer. If the engine
  can't resume (corrupt/legacy state), the admin `void_hand` path refunds
  every seat its `stack_before_hand` (delta 0) and logs the event.
