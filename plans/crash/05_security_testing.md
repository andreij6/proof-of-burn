# 05 — Security & the mechanics-first test plan

## Threat model

| Threat | Mitigation |
|---|---|
| **Rigged crash points** | Genesis hash-chain pre-commitment (C5): every round's seed was fixed before the first bet ever; per-round reveal verifies back to the published terminal hash; `verify_crash_round` + client-side recomputation (C14). The canister cannot steer outcomes without breaking the chain publicly. |
| **Result-aware betting** | Betting closes BEFORE `run_started_at`; the seed index for round N is bound at round open; a bet update arriving after the window is rejected by phase guard. The crash timer carries the round id (stale timers no-op). |
| **Manual-cashout races** | First-writer-wins per bet; `ALREADY_SETTLED`/`TOO_LATE` rejections mutate nothing; settlement is a single atomic pass at crash. Manual can never exceed the bettor's own auto target (C7) — removes any oracle advantage from watching the chain. |
| **House drained (variance)** | Exposure cap per round (C8) bounds worst-case; house may go negative but bounded + recovers at 1% edge; cap admin-tunable downward live; `get_casino_stats` exposes house balance + lifetime burn for monitoring. |
| **VP inflation bug** | I-1c/I-6/I-7 (doc 02): users + house + burned = 0 forever; per-round zero-sum debug assertion; `get_casino_reconciliation`. |
| **Double-spend across games** | shared `reserved_chips` helper: chips reserved by a live crash bet are invisible to poker sit-downs and vice versa; tested cross-game. |
| **Auto-pilot runaways** | stop block REQUIRED at validation (no infinite martingale); casino-wide stop-loss floor checked per bet regardless of strategy; per-round pilot cap. |
| **Chat abuse** | rate limit 1/5 s, 200 chars, plain-text rendering (no markup/links), admin mute/delete, ring buffer caps storage. Injection surface: charset validation + text-only rendering, fixture-tested. |
| **Upgrade mid-round** | full round state stable; timer re-arm computes remaining time; passed-crash-time path seals immediately; `admin_void_crash_round` refunds all (delta 0) as last resort. |
| **Flag off mid-round** | current round settles, loop stops, endpoints `FEATURE_DISABLED` — tested. |

## Test plan (mechanics first — extends poker doc 09 discipline)

### Layer 0 — infrastructure (PB-239, before the engine)

- **Distribution oracle:** closed-form CDF of the crash distribution
  (P[crash ≥ x] = 99/(100·x) for x ≥ 1.01, 1% mass at 1.00, cap mass at
  100×) coded independently of the engine.
- **Payout oracle:** brute-force per-bet settle (pure recomputation from
  round data) the engine must match exactly.
- **Round-sim soak harness:** N synthetic bettors × strategies × M rounds,
  seeded; prints reconciliation, house trajectory, burn events.

### Layer 1 — fairness math (PB-232)

- **Golden vectors:** 50 hand-pinned (seed → u → crash point) cases incl.
  boundaries: r==0 instant bust, U near 0 and near 2^52−1, exact cap hit,
  rounding direction at x.005.
- **Histogram χ² test:** 1M simulated rounds against the closed-form CDF
  buckets (1.00, 1.01–1.5, –2, –3, –5, –10, –50, –100) — p-value sane in CI
  (10k rounds) and at the J-M1 gate (1M).
- **Edge proof:** Monte-Carlo E[payout] for targets {1.01, 2, 10, 99}
  converges to 0.99·wager ± tolerance.
- **Chain integrity:** reveal(i) hashes forward to terminal h_0 for random
  i; checkpoint recomputation equals naive recomputation.

### Layer 2 — round engine (PB-233)

Golden scenarios (exact expected deltas): instant bust loses everyone;
auto target == crash point exactly (pays — `target ≤ crash` is normative);
manual before auto target; manual after crash rejected; bet at window edge;
exposure cap closes betting mid-window; one-bet-per-round; reservation
blocks poker sit-down mid-round; stop-loss floor rejection; void-round
refunds. Property tests over random rounds: **I-7 per-round zero-sum,
payout-oracle equivalence, phase-guard immutability on illegal calls,
termination of every round, determinism from (seed, bet list).**

### Layer 3 — economics (PB-230/233)

Σ users + house = 0 between burns; burn zeroes house and increments
lifetime burned; reconciliation always 0; negative house carries (no mint);
house excluded from voting weight; stop-loss casino-wide (crash bet AND
poker sit-down both rejected at the floor).

### Layer 4 — auto-pilot & strategies (PB-236)

Validator corpus (each rule violated once); golden progressions: martingale
sequence over a pinned round result list (bet sizes exact), Paroli, skip-
rounds pattern; every stop trigger fires exactly once at its boundary;
pilot cap fairness (FIFO); flag-off stops pilots cleanly.

### Layer 5 — integration (PocketIC, PB-240) & frontend

Full rounds with real timers (humans + agents + 3 pilots); upgrade
mid-round resume; burn over a simulated week; marketplace kind-filtering +
crash license grants auto-pilot; chat rate-limit + mute; flag lockout.
Frontend vitest: curve math parity with the canister table (shared fixture),
verify-dialog recomputation, bet-panel state machine, history bar
formatting, chat rendering is text-only (injection fixtures), no-loss
banner present on every casino route (snapshot test — C16 is enforced by
CI, not memory).

### Gates

| Gate | Bar |
|---|---|
| J-M1 | 1M-round histogram χ² + chain verify + golden vectors green |
| J-M2 | soak: 100k rounds, mixed strategies — reconciliation exactly 0, house trajectory within modeled bounds |
| pre-mainnet | PocketIC suite + repo ≥ 90% coverage gate + owner playtest; ships dark behind `crash` (standing mainnet-enable rule) |
