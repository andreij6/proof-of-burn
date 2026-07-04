---
type: idea
title: "05 — Tournaments (Phase 2 — ships DISABLED)"
tags: [ideas, poker]
timestamp: 2026-06-13T22:37:20-04:00
---

# 05 — Tournaments (Phase 2 — ships DISABLED)

> **D12/D24:** this module is fully designed and built behind
> `TournamentConfig.enabled = false`. Cash tables are the v1 product; the
> admin enables tournaments (default cadence: **weekly**) only after cash
> occupancy proves out (doc 08 gate: ≥ ~30% for 2 weeks). Everything below
> describes the module as built, not what runs on day one.

## Format — every parameter admin-configurable (D12)

All values below are **defaults** in a `TournamentConfig` stable cell,
editable at runtime via `admin_set_tournament_config` (rails in
parentheses). Changes apply from the NEXT tournament — never mid-flight.

| Property | Default (admin rails) |
|---|---|
| Schedule | **cadence daily/weekly/off — shipped OFF; weekly when first enabled**; 18:00 UTC start; registration opens 17:00 UTC (any UTC minute; reg window 10 min–12 h) |
| Buy-in | **1.0 VP** (0.1–100 VP) — `POKER_VP_DELTA -= buyin` at registration; refunded only on cancellation |
| Starting stack | **3,000 chips** (1,000–100,000) — tournament chips are play chips, NOT VP |
| Structure | freezeout, 9-max tables, late reg until end of level 2 (0–5 levels) |
| Blind ladder | 10-min levels (3–60 min): 25/50 → 50/100 → 75/150 → 100/200 → 150/300 → … (×~1.5; ladder itself admin-replaceable as a `Vec<(sb, bb)>`, ≤ 30 levels, strictly increasing) — no antes at any level |
| Prize pool | entrants × buy-in |
| Payouts | 1st 50% / 2nd 30% / 3rd 20% (admin-set `Vec<u8>` percentages summing to 100, ≤ 9 places; e8s-exact, remainders to 1st). < 5 entrants ⇒ winner-takes-all. < min entrants (default 2, rail 2–20) ⇒ cancelled + refunds |
| Disconnects | **seat and stack are kept**; silent agents auto-check/fold and blind off (the defining difference from cash, D8) |
| Pacing | same paced reveal as cash (D18) |

`get_tournament_config` is public so the lobby banner and agents render the
real numbers, never hardcoded copy.

## Opt-in (D19)

Registration is an **explicit, per-tournament, owner-only act** — the entire
point is that the human knows to have their agent online:

- `poker_register_tournament()` rejects agent-principal callers
  (`OWNER_ONLY`); the UI button lives in the Poker lobby banner and Agent
  Space.
- Registering sets `tournament_opt_in_day = day_id` on the agent record; the
  seating step at start time only seats opted-in entrants (a registration IS
  the opt-in — there is no separate toggle to forget).
- House-mode owners take the same explicit step (their agent can't go
  offline, but the buy-in is still their VP to commit).
- No standing auto-register in v1 — every day is a fresh, deliberate click.
- Un-register (full refund) allowed until start time.

## Storage

```rust
// MemoryId 61: TournamentState (singleton per day) + per-table states reuse the
// cash TableState struct with `tournament: bool`.
TournamentState {
  day_id,                    // floor(now / 86400)
  phase: Announced | Registering | Running | Settling | Done | Cancelled,
  entrants: Vec<Principal>, buyin_vp_e8s,
  tables: Vec<u8>,           // dynamic table ids 100+ (cash uses 1–10)
  level, level_started_at,
  eliminated: Vec<(Principal, place)>,   // reverse finish order
  payouts: Vec<(Principal, u64)>,        // journaled before applying (retry-safe)
}
```

## Flow

1. **Reg open (config time) — Registration.** `poker_register_tournament()`
   — **owner-only** (D19): guards flag, effective VP ≥ buy-in, one entry per
   user, agent claimed. Buy-in deducted immediately (sanctioned writer #2 of
   `POKER_VP_DELTA`). NFT avatars re-verified here (D21).
2. **18:00 — Seating.** Entrants shuffled (`raw_rand`), dealt to ⌈n/9⌉
   tables created on the fly (ids 100+). Cash tables are untouched — an
   agent CAN be seated in both a cash game and the tournament (separate
   chips), though the house agent interleaves fine and external agents are
   warned in the skill doc.
3. **Running.** Same engine as cash; the tournament driver adds:
   - blind level lookup by `level_started_at` (checked at each hand start);
   - **eliminations**: stack 0 at hand end ⇒ recorded with finish place;
   - **table balancing**: after each hand, if `max(table sizes) −
     min(table sizes) ≥ 2`, move the player who would next be BB at the big
     table to the short table's worst position (standard); tables collapse
     when total players fit in fewer tables; final table at ≤ 9.
   - Timeouts: auto check/fold; **never** unseat (blinds do the killing).
4. **Settling.** Last 3 (or 1) standing → payouts journaled, then applied to
   `POKER_VP_DELTA` (sanctioned writer #3). Lifetime tournament results are
   appended to the hand-history archive; the lobby shows yesterday's podium.
5. **Done.** Tournament tables freed; next day's instance is announced by the
   sweep.

## Invariants

- Buy-ins − refunds − payouts = 0 in VP e8s per tournament (extends I-1).
- Tournament chips never convert to VP except through the payout table.
- An eliminated player's agent returns to `Idle` (free to join cash).
- Upgrade mid-tournament: full state in stable memory; level clock and table
  timers re-armed in `post_upgrade`; if resume is impossible the admin
  cancel path refunds **remaining** players their buy-in and pays already-
  eliminated places nothing (documented, audit-logged).

## UI hooks (see doc 06)

Lobby gets a tournament banner card: countdown to registration/start,
entrant count, prize pool in VP, "Register your agent" button, blind-level
ticker while running, podium when done.
