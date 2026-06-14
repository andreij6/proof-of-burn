# 09 — Test plan: proving the game mechanics

**Priority order: (1) the rules of poker are exactly right, (2) the money
(VP) is exactly right, (3) everything else.** A subtle betting-engine bug is
worse than a crash — it silently moves voting power. So the engine is built
as a pure module (PB-203) and attacked with four independent strategies
before any table goes live, and the test infrastructure itself is a task
(PB-224) built BEFORE the engine it tests.

## Layer 0 — Test infrastructure (PB-224, precedes PB-202/203)

| Piece | What it is |
|---|---|
| **Reference evaluator** | A dead-simple, obviously-correct 7-card evaluator (enumerate all 21 five-card combos, rank each by explicit rules). Slow is fine — it exists to disagree with the fast one. |
| **Per-chip pot oracle** | Distributes a finished hand's committed chips one chip at a time (each chip goes to the best eligible live hand among those who covered it). Side pots, odd chips and dead money fall out of first principles — the engine's pot logic must match it exactly. |
| **Legal-action generator** | Random-walk generator that only emits actions from `legal_actions` (plus a hostile twin that emits ILLEGAL actions to prove rejection). Drives all property tests. |
| **Scenario DSL for golden tests** | Tiny builder: `table().seats(&[1000, 250, 80]).button(0).act("p1 raise 150")…assert_stacks(&[...])` so every golden case reads like a hand history. |
| **Soak harness** | Host-side loop: N seats, mixed preset scripts, M hands, fixed seed list → reproducible. Used by unit tests (10k hands in CI) and a manual million-hand run before M2. |

## Layer 1 — Hand evaluation (PB-202)

- **Differential:** 100k random 7-card boards (seeded) — fast evaluator vs
  reference, zero disagreements. CI runs 10k; the 100k run is a
  pre-milestone gate.
- **Golden corpus** (table-driven, each with the expected category AND
  kicker ordering): wheel A-2-3-4-5; broadway; steel wheel (straight flush
  wheel); flush beats straight; full house vs flush; quads kicker; two
  trips on board → best full house; board plays (all 5 community) → split;
  identical hands different suits → exact tie; kicker chains 2–5 deep;
  three pair → best two count; A-high vs K-high no pair.
- **Total order:** strength values are antisymmetric and transitive over
  the random corpus (sort stability check).

## Layer 2 — Betting mechanics (PB-203) — the heart of it

### Golden scenario corpus (every case = exact expected stacks/pots)

Blinds & button:
1. Heads-up: button posts SB, acts FIRST preflop, LAST postflop.
2. 3-handed → seat busts → heads-up transition keeps blinds fair (no one
   posts BB twice in a row / skips it).
3. Dead button: BB busts → button placement next hand; SB dead.
4. New player `waiting_for_bb` is not dealt until BB reaches them.
5. Walk: everyone folds to BB → BB wins SB without cards shown; hand
   settles SB-sized deltas only.

Raising rules:
6. Min-raise basics: open 150 over BB 50 → min re-raise to 250.
7. **Incomplete all-in raise does NOT reopen action:** P1 bets 100, P2
   all-in 150, P3 calls 150, back to P1 → P1 may call 50 or fold, NOT
   raise. (The classic engine-killer.)
8. All-in below call amount (call for less) — no raise implications.
9. Two consecutive all-in incomplete raises — still no reopen.
10. Bet of exactly remaining stack counts as all-in even if < min bet.
11. Check-raise allowed; raise after own check same street allowed only via
    intervening bet.
12. Postflop min bet = 50 (1 BB); 1-chip "bets" rejected.

Pots & awards:
13. 3-way all-in with stacks 1000/400/100 → main + 2 sides; per-chip
    oracle equivalence; eligibility exact.
14. Folded player's dead money sits in the right pot layer.
15. Split pot odd chip → first eligible seat left of the button.
16. Split main, sole winner of side (board plays for two, third has pair).
17. Everyone all-in preflop → board runs out fully, no further action
    requested from anyone.
18. All fold to one player mid-street → instant award, NO showdown, hole
    cards never revealed.
19. Showdown order: last aggressor first; checked-through river → first
    left of button.

Settlement:
20. Every golden case asserts per-seat chip deltas AND that Σ deltas = 0.

### Property tests (legal-action generator, 10k random hands in CI)

- **P-1 Chip conservation:** Σ(stacks) + Σ(pots) constant at every step;
  post-settlement Σ(deltas) = 0.
- **P-2 Pot-oracle equivalence:** final awards == per-chip oracle, every
  hand.
- **P-3 Illegal actions never mutate:** hostile generator's rejects leave
  state hash unchanged.
- **P-4 Termination:** every generated hand reaches `Settled` within a
  bounded number of actions (no livelock for any fold/call/raise pattern).
- **P-5 Determinism:** (seed, action list) → identical event stream and
  final state hash, run twice.
- **P-6 Blind fairness:** 500-hand sit/leave churn — every always-seated
  player posts BB exactly once per orbit ± documented dead-button cases.
- **P-7 Turn legality:** the acting seat is always live, never folded /
  all-in / waiting-for-BB.

### Mutation checklist (manual review gate for PB-203 PR)

Deliberately flip each of these locally and confirm a test fails — proves
the suite actually guards the rule: min-raise `>=` → `>`; reopen-action
flag inverted; odd-chip recipient direction; side-pot eligibility off by
one seat; button advance skipping one seat; SB/BB amounts swapped;
settlement sign flip.

## Layer 3 — Economics (PB-200/204/219, invariants I-1…I-5 + D23/D25)

- Zero-sum across every hand and across the full `POKER_VP_DELTA` map
  (`get_poker_reconciliation` == 0 in cash-only states).
- Effective-VP clamp: delta can zero VP, never negative; stack-clamp at
  hand start after mid-session unstake; busted ⇒ unseat ⇒ re-seat blocked.
- Stop-loss: trigger at exactly `== floor` post-hand; sit-down/registration
  guards; an all-in loss still settles in full; edits apply next hand.
- EA weight (D25): 6× math, included in vote weight + bankroll, excluded
  from lottery tickets (explicit regression test on ticket math).
- Writer discipline: a test-build counter asserts only sanctioned sites
  touched the delta during any simulated session.

## Layer 4 — Timing, pacing, agents (PB-204–207)

- Deadline: no action by T ⇒ auto check/fold exactly once (no double-fire
  when timer and late action race — the stale `hand_no` guard wins).
- Pacing (D18): buffered action applies at reveal time, not call time;
  event timestamps monotonically spaced ≥ pacing minimums; a hand's wall
  time ≥ ~10 s in simulation.
- Cash seat loss: 2 timeouts in-hand / 3 hands running ⇒ unseat; house
  agents exempt; waitlist head promoted.
- House agent: plays 50 unattended hands; decisions replay deterministically
  from seeds; never produces an illegal action (clamp).
- Hole-card redaction: serialized public payloads byte-scanned for hole-card
  values across 1k random hands (not just spot checks).

## Layer 5 — Integration (PocketIC, PB-217) & frontend

As specified in doc 07 (cash session, waitlist, marketplace splits,
tournament E2E, mid-hand upgrade, flag lockout) plus: **archive replay
audit** — re-derive every archived deck from revealed seeds for a whole
session and re-simulate to identical settlements. Frontend vitest: lobby
formatting, searching-state machine, DOM redaction, replay rendering,
script-editor validation parity with the canister validator (shared
fixture corpus).

## Coverage targets & gates

| Area | Target |
|---|---|
| `poker_engine` module (evaluator + betting) | **≥ 98% line, 100% of the golden corpus + mutation checklist** |
| economics writers / stop-loss | 100% branch on the settlement paths |
| repo overall (`scripts/coverage.sh`) | existing ≥ 90% gate holds |
| pre-M2 gate | 1,000,000-hand soak: zero invariant violations, zero panics |
| pre-mainnet gate | full PocketIC suite + archive replay audit green |

## What we deliberately do NOT test-automate

- Poker strategy quality (scripts can be bad — that's the game).
- Statistical shuffle randomness beyond `raw_rand`'s guarantees (we audit
  determinism-from-seed, not entropy; that trust root is the IC's).
- Node-provider hole-card confidentiality (documented limitation, doc 07).
