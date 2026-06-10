# Ops Runbook — Cycles of Influence


Operational reference for the deployed backend canister. See `DEPLOY.md` for initial deployment steps and `SECURITY.md` for the security checklist.

## Cycles Management

### Primary source: burn-to-cycles on every settled vote

When a proposal passes its threshold and the NNS vote is cast, all committed ICP is routed through the **Cycles Minting Canister** (CMC, `rkp4c-7iaaa-aaaaa-aaaca-cai`) via `burn_to_cycles`. The CMC burns the ICP from the ledger supply and credits cycles directly to the backend canister. This is the primary funding mechanism — governance activity directly sustains the infrastructure.

The flow per settled commitment:
1. Transfer `commitment.amount_e8s` from escrow subaccount → CMC (ledger fee `10_000 e8s`).
2. Call `notify_top_up` with the resulting block index and this canister's ID.
3. CMC mints cycles and credits them to the backend canister immediately.

### Secondary source: treasury auto top-up

The backend also runs a 5-minute timer (`cycle_topup_check`) that tops up from the treasury subaccount when the cycle balance falls below **5 T cycles** — a safety net for periods with no active governance settlements:

1. Checks canister cycle balance via `ic_cdk::api::canister_balance()`.
2. If below 5 T, transfers treasury ICP → CMC (`rkp4c-7iaaa-aaaaa-aaaca-cai`) via `notify_top_up`.
3. Keeps at least 0.0001 ICP in treasury as reserve.

### Manual top-up

```bash
# Check current balance
icp canister call backend get_cycle_balance -e production

# Deposit cycles directly (if treasury is empty)
icp wallet send <backend-canister-id> <amount>
```

### Freezing threshold

Set to **90 days** (`freezing_threshold: 7776000` in `icp.yaml`). The subnet will refuse to accept calls once the canister can no longer sustain this many seconds of idle at the current burn rate — protecting state from being silently wiped.

**Alert target:** Notify ops when cycle balance drops below **10 T cycles**. See PB-102 for alerting setup.

---

## Controllers

A high-value canister **must** have at least two independent controllers. Losing the sole controller key = permanently unupgradeable canister (state preserved but code locked).

### Required controller setup (before mainnet)

```bash
# Add a backup / governance controller
icp canister update-settings backend \
  --add-controller <backup-principal> \
  -e production

# Verify controllers
icp canister info backend -e production
```

**Recommended controller set:**
| Controller | Purpose |
|---|---|
| Deployment identity (hardware key) | Primary upgrade/admin ops |
| Cold backup key | Emergency recovery |
| (Optional) SNS governance | Decentralised upgrade path |

### Rotate a controller

```bash
icp canister update-settings backend \
  --remove-controller <old-principal> \
  --add-controller <new-principal> \
  -e production
```

Never remove the last controller before the replacement is confirmed live.

---

## Lossless Staking (3 fixed-term pooled NNS neurons)

The backend controls THREE pooled NNS neurons, one per fixed term:

| Tier | Dissolve delay | Voting-power multiplier | Lottery tickets/day |
|------|----------------|-------------------------|---------------------|
| SixMonths | 15,778,800 s (6 months) | 1× | 5 |
| OneYear | 31,557,600 s (1 year) | 2× | 10 |
| TwoYears | 63,115,200 s (2 years) | 4× | 20 |

Users stake ICP into a tier (`stake(amount, tier)`); platform voting power =
Σ stake × multiplier across tiers (proportional to the term). Unstaking
(`unstake(amount, tier)`) splits the tier's neuron and dissolves for the
tier's FULL term. **Zero-loss fee model:** the user deposits EXACTLY the
stake amount; the treasury fronts the escrow→neuron transfer fee at stake
time (`TREASURY_FEE_COVER` error if the treasury can't — keep it funded)
and reimburses all three cycle fees (0.0003 ICP, `fee_refund_block` on the
PendingUnstake, retried by the sweep) with the disbursement. Staking is also the lossless-lottery eligibility gate (the
daily ticket grant = base 5 × multiplier per staked tier). Maturity from all
three neurons is harvested on the 5-minute sweep into the shared yield inbox
(`[2u8;32]`) and split **50% lottery prize pot (`[3u8;32]`) / 50% treasury**.

Tier dissolve delays are FIXED in code; `admin_set_staking_config` only tunes
`(min_stake_e8s, min_unstake_e8s, maturity_threshold_e8s)` (null = keep).

### Mainnet notes

- The 6-month minimum tier matches the NNS minimum dissolve delay for voting
  eligibility — **no Mission 70 dependency** (the old 2-week pool is gone).
- Bootstrap makes each neuron **public on the NNS** (`SetVisibility = 2`,
  part of the DelaySet→Ready step, sweep-retried) — auditability is part of
  the product promise; the UI links each tier to its dashboard page.
- Kill switch: `admin_set_feature_flag '("lossless_voting", false)'`.
- The backend canister is each neuron's **sole controller** — losing the
  canister loses the neurons. Controller hygiene (above) is critical.
- ManageNeuron candid types were verified against `dfinity/ic` governance.did
  (June 2026); PocketIC/local tests exercise a mock, so do a **tiny-amount
  canary stake per tier** on mainnet before announcing the feature.
- `DisburseMaturity` mints ICP ~7 days after harvest; the distribution sweep
  triggers off the yield-inbox (`[2u8;32]`) balance, so the delay needs no
  special handling.
- Audit events: `stake` (ref = tier idx), `unstake_split`, `unstake_disbursed`,
  `lossless_vote`, `yield_harvest`, `yield_distribution`.

---

## Lossless Lottery (Powerball-style, stakers only)

Staking is the eligibility gate: stakers collect tickets daily — base 5
(admin-tunable) × the tier multiplier, summed over staked tiers (5 / 10 / 20
for 6mo / 1y / 2y; `NOT_STAKED` otherwise). Drawings copy the American
Powerball: jackpot odds **1 in 292,201,338 per ticket**, three drawings a
week (Mon/Wed/Sat nights US Eastern — implemented as Tue/Thu/Sun 03:00 UTC,
checked by the 5-minute timer). Tickets accumulate until someone wins; the
winner takes **80%** of the lottery pot (`[3u8;32]`, fed by 50% of every
yield harvest across all three neurons), 20% seeds the next round, and all
tickets reset. Prize payouts use a journal-first saga (`LotteryDraw`)
retried by the timer, and randomness comes from the management canister's
`raw_rand`.

### Flag — ships dark

`lossless_lottery` defaults **OFF**. Enable / kill:

```bash
icp canister call backend admin_set_feature_flag '("lossless_lottery", true)' -e local --identity dev1
icp canister call backend admin_set_feature_flag '("lossless_lottery", false)' -e production   # kill switch
```

### Admin & dev

```bash
# Tune the daily ticket grant (1..=10,000)
icp canister call backend admin_set_lottery_config '(opt 10)' -e local --identity dev1

# Local-dev: hold a drawing now; true = rig ticket #0 to win (exercises the
# full 80/20 payout path). Needs at least one claimed ticket to force a win.
icp canister call backend dev_run_lottery_draw '(true)' -e local --identity dev2

# State / history
icp canister call backend get_lottery_info -e local
icp canister call backend list_lottery_draws --query -e local
icp canister call backend get_my_payouts --query -e local --identity dev2
```

Notes:
- **Eligibility is live:** fully unstaking (all tiers) voids the user's
  current-round tickets immediately (`void_current_round_tickets`), as does
  promotion to admin — no future drawing can select them. The daily-claim
  clock survives, so re-staking the same day can't double-claim.
- A drawing with a hit ticket but a pot too small to cover one ledger fee
  records **no winner** (rolls over) — nobody's tickets are burned for a
  zero prize.
- The win is final once the draw record persists: the round restarts
  immediately even if the prize transfer needs retries (`PayoutPending`).
- Memory IDs 34–39; audit event: `lottery_win`.
- Payout history (`get_my_payouts`) also records `unstake_disbursed`
  amounts, idea-upvote poster shares, and commitment refunds from the
  moment this code is deployed (no backfill).

---

## Testing & Coverage

Every value-moving path (commits, burns, refunds, sagas, pool rewards,
staking, lottery payouts, yield splits) has native unit-test coverage against
the mocked ledger/governance seams. Coverage gate: **≥ 90% line coverage** on
the backend lib.

```bash
cargo test -p backend            # full suite: unit + PocketIC integration
./scripts/coverage.sh            # line-coverage summary (cargo-llvm-cov)
./scripts/coverage.sh --html     # browsable per-line report
```

Notes:
- Rebuild the wasm before integration tests after backend changes:
  `cargo build --target wasm32-unknown-unknown --release -p backend` — the
  PocketIC tests load that artifact, and a stale one fails candid decoding.
- Coverage counts native unit tests only; wasm-only plumbing (live NNS
  fetches, init timers, cycles receive) is exercised by PocketIC/local smoke
  instead.
- Frontend: `npm --prefix src/frontend run test` (vitest).

---

## Audit Log

The canister maintains an append-only `StableLog<AuditLogEntry>` of all deposit, burn, and refund events.

```bash
# Query all audit events (capped at 1000 by the endpoint)
icp canister call backend get_audit_log '(0, 1000)' --query -e production
```

Each entry contains: `timestamp`, `event_type` ("deposit" | "burn" | "refund"), `proposal_id`, `user` principal, `amount_e8s`.

### Export to CSV (for off-chain analysis)

```bash
icp canister call backend get_audit_log '(0, 10000)' --query -e production \
  | python3 scripts/audit_log_to_csv.py > audit_$(date +%Y%m%d).csv
```

---

## Emergency Procedures

### If the canister is near freezing

1. Send cycles immediately: `icp wallet send <canister-id> 10_000_000_000_000`.
2. Check treasury balance via `get_treasury_balance`.
3. Trigger a manual top-up sweep: `admin_trigger_sweep`.

### If a burn settlement fails

Commitments that fail to burn or refund get `FailedBurn` / `FailedRefund` status. The 5-minute retry timer will reattempt these automatically. To force immediate retry:

```bash
icp canister call backend admin_trigger_sweep -e production
```

### If the canister needs to be stopped

```bash
icp canister stop backend -e production
# ... maintenance ...
icp canister start backend -e production
```

Stopping the canister preserves all stable-memory state. The timer will restart automatically on `start`.
