---
type: idea
title: "Cycles Faucet — Build Spec (PB-400, Phase 1)"
tags: [ideas, faucet]
timestamp: 2026-06-14T01:44:26-04:00
---

# Cycles Faucet — Build Spec (PB-400, Phase 1)

Distilled from [`cycles-faucet.md`](cycles-faucet.md) (vision) and
[`cycles-faucet-specs-review.md`](cycles-faucet-specs-review.md). This is the
implementation-ready spec for the dark-shipped Phase-1 faucet. It deliberately
reuses the canister's existing CMC / treasury / pool / vote machinery — the new
surface is *eligibility + rate-limit + circuit-breaker*.

Ships behind the `cycles_faucet` feature flag, **default OFF**.

---

## 1. What a claim does

A faucet claim is a narrower cousin of `settle_burn_split`: it prices a fixed
**$2 USD** grant into ICP via the cached XRC oracle, then tops up the
*developer's* registered canister with cycles through the existing CMC pipeline
(`call_cmc_topup_transfer` → `notify_cmc_topup`, idempotent on `block_index`).
The treasury fronts the grant ICP + the 10,000 e8s ledger fee, exactly like
every burn settlement.

```
register_faucet_canister(canister_id)   // proof-of-control: caller == canister
        │
        ▼
claim_faucet_cycles(canister_id)
  G1 registered?  G2 active pool neuron?  G3 burn-vote in last 30d?
  G4 dev + canister under weekly cooldown?  G5 canister under 25 lifetime claims?
  G6 treasury above floor (incl. this grant's ICP)?   ── all yes ──▶
        price $2 → ICP → CMC mints cycles into the dev's canister
        │
        ▼
  stamp dev_last_claim + canister usage (last_claim, count++); audit-log; stats++
```

## 2. Eligibility (the security-critical part)

All gates must hold for the **calling principal** at claim time:

| # | Gate | Implementation |
|---|---|---|
| G1 | Registered target canister | `FAUCET_REGISTRATIONS.get(canister)` exists and was registered by the caller |
| G2 | Active pool neuron | `get_my_pool_neuron()` returns `Some` with `status == Active` (admins bypass, like `arcade_access`) |
| G3 | Burn-vote within `faucet_vote_window` (30d) | scan `COMMITMENTS` (`created_at`) + `LOSSLESS_VOTES` (`cast_at`) for caller `≥ now − window` — the exact `arcade_access` pattern |
| G4 | Weekly cooldown | `now − FAUCET_DEV_LAST_CLAIM[dev] ≥ 7d` **and** `now − FAUCET_CANISTER_USAGE[canister].last_claim_ns ≥ 7d` |
| G5 | Canister lifetime cap | `FAUCET_CANISTER_USAGE[canister].count < faucet_canister_lifetime_cap` (25) |
| G6 | Treasury floor circuit-breaker | `treasury_balance − (grant_icp + fee) ≥ faucet_treasury_floor_e8s` |

G2 + G3 are the sybil wall (stake **and** burn per fake identity). G4 bounds any
one canister/dev per week; G5 caps a canister at 25 × $2 = **$50 lifetime**.

**Proof-of-control registration (review C1).** `register_faucet_canister` must
be called *by the target canister itself* — `msg_caller == canister_id` is
cryptographic proof of control (IC authenticates every message's caller). This
blocks the griefing vector where someone registers a popular ecosystem canister
and burns its weekly slot. A non-existent canister cannot make an inbound call,
so a successful registration also proves existence at registration time
(subsumes review C2's existence check). We also cheaply reject non-opaque /
self / anonymous principals with no network call. The registrant of record is
`msg_caller`'s *caller* is not available, so the **registrant = the canister**
and the **claimant = whoever later calls `claim_faucet_cycles` after passing
G2/G3** — i.e. registration binds the canister; eligibility binds the human.

## 3. Treasury circuit-breaker (review C3)

The floor is the hard solvency guard. A claim re-uses the same
`treasury_floor_check`-shaped logic the rest of the canister uses (live ledger
balance read; the faucet is a discretionary spend so the marginal async read is
acceptable — a claim already makes 2+ inter-canister calls). It must
**fail closed**: any error reading the balance, or `balance − outflow < floor`,
rejects the claim with `TREASURY_LOW`. No upward-drifting cache is used in
Phase 1 (the vision's cached-balance optimization is Phase 2; a stale cache that
reads high would breach the floor, so it's deferred rather than done wrong).

The `cycles_faucet` flag is the owner kill switch (instant hard-stop regardless
of balances). Hysteresis / weekly global budget are Phase 2.

## 4. Mechanism — reuse, don't reinvent

1. **Price $2 → ICP.** `grant_icp_e8s = faucet_grant_usd_e8s * 1e8 / cached_icp_usd_rate`
   (helper `usd_e8s_to_icp_e8s`, same cached XRC rate as the Explorer/arcade $1
   path; `refresh_icp_rate` warms it on mainnet first).
2. `call_cmc_topup_transfer(ledger, TREASURY_SUBACCOUNT, dev_canister, grant_icp, fee)`
   — moves ICP from the treasury subaccount to the CMC subaccount **for the
   dev's canister** (already parameterized by target).
3. `notify_cmc_topup(cmc, dev_canister, block_index, …)` — CMC mints cycles into
   the dev's canister. Idempotent on `block_index`.
4. Record: stamp `FAUCET_DEV_LAST_CLAIM[dev]`, bump `FAUCET_CANISTER_USAGE`
   (`last_claim_ns`, `count++`), append `AuditLogEntry { event_type:
   "cycles_faucet_grant" }`, bump `FAUCET_STATS`.

**Idempotent saga.** The reserve-slot-before-spend + block-index journal mirrors
`settle_burn_split`. The block index is held on the `Registration` so a retry
re-notifies the same block (never double-mints). On `CMC_REFUNDED` (dev canister
deleted after registration) we drop the stored block index — the ICP is refunded
to the backend by the CMC, not lost (corrects review C2). A `CallerGuard` blocks
reentrancy mid-await.

## 5. Parameters (all in `Config`, admin-settable)

| Param | Default | Setter |
|---|---|---|
| `faucet_grant_usd_e8s` | `200_000_000` ($2.00) | `admin_set_faucet_grant_usd` |
| `faucet_canister_lifetime_cap` | `25` | `admin_set_faucet_lifetime_cap` |
| `faucet_claim_window_ns` | 7 days | `admin_set_faucet_claim_window_days` |
| `faucet_vote_window_ns` | 30 days | `admin_set_faucet_vote_window_days` |
| `faucet_treasury_floor_e8s` | `1_500_000_000` (15 ICP) | `admin_set_faucet_treasury_floor` |
| `cycles_faucet` flag | OFF | `admin_set_feature_flag[_state]` |

All defaulted on decode (`#[serde(default = "...")]`) for upgrade safety.

## 6. Stable structures (MemoryIds 90–93, pinned)

| Id | Name | Key → Value |
|---|---|---|
| 90 | `FAUCET_REGISTRATIONS` | `Principal(canister)` → `FaucetRegistration { registered_at, pending_block }` |
| 91 | `FAUCET_DEV_LAST_CLAIM` | `Principal(dev)` → `u64` ns |
| 92 | `FAUCET_CANISTER_USAGE` | `Principal(canister)` → `FaucetCanisterUsage { last_claim_ns, count }` |
| 93 | `FAUCET_STATS` (cell) | `FaucetStats { total_cycles_grants, total_claims, last_grant_at }` |

## 7. Endpoints

- `register_faucet_canister(canister_id) -> Result` — update, proof-of-control.
- `claim_faucet_cycles(canister_id) -> Result` — update, the saga.
- `get_faucet_status(canister_id: opt) -> FaucetStatus` — query: per-caller gate
  enum, next-eligible-at, claims remaining, params, open/closed + reason.
- admin setters above; mirrored in `backend.did`.

## 8. Test seams & coverage

Off-wasm, `notify_cmc_topup` is a no-op success and `call_cmc_topup_transfer`
honors `TEST_MOCK_LEDGER_TRANSFER`; the treasury balance honors
`TEST_MOCK_LEDGER_BALANCE`. Tests cover: eligibility accept; reject non-member
(G2); reject no-recent-burn (G3); weekly cooldown (G4, dev + canister); lifetime
cap (G5); treasury-floor circuit-breaker blocks the grant (G6); idempotent CMC
top-up (retry doesn't double-stamp); flag-gating (OFF rejects).

## 9. Out of scope (Phase 2/3)

Cached treasury balance + hysteresis, weekly global budget, `llms-faucet-*.txt`
agent skill, tiered grants by tenure. Mainnet behaviour only (PB-148 makes
end-to-end local claims unreliable; never deploy to mainnet unless asked).
</content>
</invoke>
