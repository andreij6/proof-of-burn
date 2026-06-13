# 07 — Security, fairness, testing, rollout

## Threat model

| Threat | Mitigation |
|---|---|
| **Rigged shuffle accusations** | commit-reveal: `sha256(seed)` stored pre-deal, seed revealed post-hand; anyone replays the deck. Trust root = `raw_rand` (same as lottery). |
| **Hole-card leakage via queries** | `get_my_table_view` returns only the caller's cards; spectator query redacts all; folded cards never revealed. Query gating tested explicitly. |
| **Hole-card leakage via replica access** | Honest limitation: node providers can read canister memory. Stakes are VP (not ICP), pots are small, and the attack needs node-operator collusion. Documented in OPS + the lobby MoreInfo. Future hardening (out of scope v1): deal via threshold-encrypted cards (vetKeys). |
| **Stale/duplicate actions** | `poker_act(table, hand_no, action)` matched against current hand + acting seat; everything else rejected without mutation. |
| **Collusion / chip dumping** | Cannot be prevented (open agents), but: VP is zero-sum (dumping moves VP between colluders' own accounts — pointless), no rake, no house money at risk. Hand histories are public for community policing. Per-IP/sybil controls deliberately out of scope. |
| **VP inflation bug** | invariants I-1..I-5 (doc 01) enforced by tests + a `debug_assert` reconciliation pass after every settlement in local/PocketIC builds; an admin `get_poker_reconciliation()` query sums all deltas (must be ≤ 0 — equals −(unsettled tournament pool)). |
| **Stalling tables** | every await on agent input has a deadline timer; timeout policy always advances the hand. |
| **Reentrancy / double settle** | engine settles synchronously (no inter-canister calls inside a hand); `raw_rand` is the only await and happens before dealing with a `Dealing` phase guard. |
| **Upgrade mid-hand** | full state in stable memory, timers re-armed in `post_upgrade`, admin `void_hand` as last resort (delta 0 for all seats, audit-logged). |
| **Script bombs** | DSL has no recursion/loops; ≤ 200 rules, ≤ 8 KB, interpreter O(rules) with hard instruction budget; validated at save AND defensively at eval. |
| **Marketplace fraud** | body hidden until licensed; license snapshots the version; seller can't edit a listed script; payments via the proven quote/escrow path with journaled transfer legs. |
| **NFT avatar spoofing** | `set_agent_avatar` verifies `icrc7_owner_of == owner` at set time AND re-verifies at every sit-down/registration; image URLs sanitized (https only, length-capped) and rendered sandboxed (`<img>` only, no SVG injection); a transferred NFT silently reverts the avatar. The collection canister is untrusted — verification calls are read-only queries and a non-responsive collection just fails the set. |
| **Fake model labels** | `model` is self-declared by design; the UI labels it "declared model" and never implies verification. Charset/length validated to prevent markup injection. |
| **Admin config abuse** | `admin_set_tournament_config` / `admin_set_poker_pacing` are railed (documented min/max per field), apply only to the NEXT tournament / hand, and are audit-logged (`poker_config_change`). |

## Admin tools (PB-212)

- `admin_pause_table(id, bool)` — finishes current hand, then no new hands.
- `admin_void_hand(table_id)` — refunds `stack_before_hand` to all seats
  (delta 0), audit-logged; for engine wedges only.
- `admin_cancel_tournament()` — refund policy per doc 05.
- Feature flag `poker` = master kill switch (existing panel).
- Audit log events: `poker_settle`, `poker_bust`, `tourney_buyin`,
  `tourney_payout`, `poker_void`, `poker_script_create`, `script_sale`.

## Test plan

**Superseded in depth by [09_test_plan.md](09_test_plan.md)** — doc 09 is
the authoritative coverage plan (mechanics-first: oracles, golden corpus,
property tests, mutation checklist, soak gates). The summary below stands
as the original sketch.

**Host unit tests (largest layer, pure engine):**
- evaluator: category/kicker exhaustive boundaries + 10k random cross-check
  vs reference implementation;
- betting machine property tests: chip conservation, side-pot brute-force
  equivalence, min-raise legality fuzz, determinism, button rotation (doc 02);
- DSL: validator fixtures (valid/invalid corpus), interpreter golden
  decisions, illegal-action clamping, budget cap;
- economics: settlement writers, clamp rule, effective-VP integration with
  `cast_lossless_vote`, busted-player gates (I-1..I-5);
- stop-loss (D23): floor triggers stand-up post-hand only, sit-down/buy-in
  rejections, mid-hand all-in still settles, edit-between-hands semantics.
  (If R9 house-liquidity bots ship later, I-1 widens to "Σ deltas over users
  + platform promo account = 0" with the promo account hard-capped.)

**PocketIC integration (PB-217):**
- 4 scripted agents play 50 cash hands: Σ `POKER_VP_DELTA` = 0, hands archive
  matches settlements, seat-loss on a deliberately silent agent;
- waitlist: 11 agents → 10th table fills → FIFO promotion on a leave;
- $5 script creation + marketplace buy with real local ledgers (80/20 split
  balances verified);
- 20-agent tournament end-to-end: balancing, eliminations, blind ladder,
  payouts sum to buy-ins;
- upgrade mid-hand: install upgrade, hand resumes, no double settlement;
- flag off ⇒ every endpoint `FEATURE_DISABLED`.

**Frontend (vitest):**
- lobby row formatting (X/9, FULL, waitlist), searching-state machine,
  table-view redaction (no hole cards in public payloads), script editor
  validation parity, marketplace price math.

**Local playtest script (`scripts/poker-smoke.sh`):** seeds dev1/dev2 stakes,
claims house agents with different presets, sends both to a table, fast-runs
20 hands, prints reconciliation.

## Rollout gates

1. M1–M4 milestones green (README).
2. `scripts/coverage.sh` stays ≥ 90% line coverage (engine is pure Rust —
   should help, not hurt).
3. Ships **dark** (`poker` OFF) in the same deploy train as unrelated work.
4. Owner playtest on local → owner explicitly requests mainnet enable
   (standing deploy gate applies).
5. Week 1 on mainnet: tables capped at 10 (already), tournament announced as
   beta; watch `get_poker_reconciliation` daily via the monitor script.
