# 01 — Round engine: lifecycle, fairness, the clock, latency

## Round lifecycle (C1)

```
Intermission(5 s) → Betting(10 s) → Running(until crash) → Crashed/Settling → …
```

- One global loop, driven by `ic_cdk_timers` (a single repeating timer while
  the flag is on and not paused; **no timers scheduled when paused/off** —
  idle cost zero).
- **Betting**: `crash_bet(wager_chips, auto_target)` accepted; closes at
  T+10 s OR early when the exposure cap trips (C8).
- **Running**: starts at a recorded `run_started_at` (ns). The multiplier is
  a pure function of elapsed time (C6), so every client renders the same
  curve from the timestamp — the canister never "ticks" the multiplier; it
  only needs ONE timer set for the pre-computed crash time
  (`t_crash = ln(crash_point)/0.06`).
- **Crash**: at the timer, the round seals: auto-cashouts < crash point pay,
  everyone else loses their wager. Manual cashouts that landed before the
  crash (by block time) pay at their landing multiplier.
- **Settling**: per-bet deltas written to `CASINO_VP_DELTA`, house absorbs
  the net (doc 02), round archived, next intermission begins.

## Provably-fair crash point (C4/C5)

### Hash chain (genesis pre-commitment)

- At feature-enable, the canister draws 32 bytes from `raw_rand` as
  `chain_seed`, computes `h_N = chain_seed`, `h_{i-1} = sha256(h_i)` down to
  `h_0`, stores `h_0` (the **terminal hash**) publicly and the chain
  position counter. N = 10,000,000 rounds (~6 years at 20 s/round).
  Storage trick: we do NOT store 10M hashes — we store `chain_seed` and the
  current index, recomputing `h_i` per round (i decreasing) with a cached
  checkpoint every 100k steps so a round costs ≤ 100k hashes ≈ trivial.
- Round i uses `seed_i = h_i`; **published commitments**: `h_0` at genesis
  and each round's reveal `h_i`, which any verifier hashes forward to
  `h_{i-1}, …, h_0`. Every future crash point was fixed at genesis; the
  canister cannot steer a single round.

### Crash point from seed (integer math, no floats)

```
u  = first 8 bytes of sha256(seed_i ‖ "caldera-crash-v1") as u64
r  = u % 101            // 1/101 ≈ 0.99% instant bust
if r == 0 → crash = 100              // 1.00× (×100 fixed-point)
else:
  // crash = floor(99·2^52 / (2^52 − (u % 2^52))) with 1% edge, in basis
  // points of ×100 fixed-point; exact expression + overflow-free u128
  // implementation in PB-232; capped at 10_000 (100.00×).
```

- All arithmetic u128 fixed-point ×100; the EXACT formula with rounding
  direction is normative in PB-232 and pinned by golden vectors (doc 05).
- Verify endpoint `verify_crash_round(i)` returns seed, recomputed point,
  and the chain-link proof; the UI's "verify" recomputes client-side too.

## The multiplier clock (C6) and cashout semantics (C7)

- `m(t) = e^(0.06·t)` rendered as ×100 fixed-point via a precomputed
  per-100 ms lookup (canister) / `Math.exp` (UI display only — settlement
  always uses the canister table, so there is exactly one truth).
- **Auto-cashout (primary):** settled from pure data: pays
  `wager × target` iff `target ≤ crash_point`. Zero latency sensitivity.
- **Manual cashout (bonus):** `crash_cashout()` executes at
  `m(block_time − run_started_at)` — IF that is below both the crash point
  and the bettor's auto target. It can only IMPROVE a loss into a win when
  nerves beat the crash; it can never beat the auto target (prevents
  "manual sniping" being strictly dominant and keeps the primary path
  honest). Duplicate/late calls: first writer wins; later calls return
  `ALREADY_SETTLED` / `TOO_LATE` without mutation.
- **Latency honesty (UI + skill doc):** consensus adds 1–3 s ⇒ ~6–18% of
  multiplier; the button is real but the target is the strategy.

## Exposure cap (C8) — bounding house variance

- At bet acceptance: `potential = Σ(wager_i × target_i)` for the round.
  If `potential + new_bet_potential > 5_000 VP` (admin-tunable 100–100,000,
  rails in PB-233) the bet is rejected `ROUND_FULL` and betting closes.
- Per-bet rails: wager 10–10,000 chips; target 1.01–100.00×; one bet per
  principal per round.
- Worst case house round loss is therefore bounded and recovers via the 1%
  edge (doc 02 sizing analysis).

## Pause / upgrade behavior

- `admin_pause_crash(bool)`: current round completes and settles; no new
  betting window opens.
- Upgrade mid-round: full round state (phase, bets, run_started_at, chain
  index) is stable; `post_upgrade` re-arms the crash timer from
  `t_crash − elapsed`; if the crash time already passed during the upgrade
  the round seals immediately on first timer (auto targets unaffected;
  manual cashouts that missed their window simply ride their auto target —
  stated in the skill doc).
- Catastrophic wedge: `admin_void_crash_round` refunds every wager (delta
  0 for all, house delta 0), audit-logged.
