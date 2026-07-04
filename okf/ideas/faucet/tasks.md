---
type: idea
title: "Cycles Faucet — Tasks (Phase 1)"
tags: [ideas, faucet]
timestamp: 2026-06-14T01:44:26-04:00
---

# Cycles Faucet — Tasks (Phase 1)

## Backend (`src/backend/src/lib.rs`, `// ===== 21. Cycles Faucet =====`)
- [x] T1. `Config` params + defaults (`faucet_grant_usd_e8s`, `faucet_canister_lifetime_cap`, `faucet_claim_window_ns`, `faucet_vote_window_ns`, `faucet_treasury_floor_e8s`), `#[serde(default)]` for upgrade safety.
- [x] T2. `cycles_faucet` feature flag → `KNOWN_FEATURE_FLAGS` + default OFF in `feature_default`.
- [x] T3. Structs: `FaucetRegistration`, `FaucetCanisterUsage`, `FaucetStats`, `FaucetGate` enum, `FaucetStatus`; `impl_storable!` each.
- [x] T4. Stable maps at MemoryIds 90/91/92 + stats cell 93.
- [x] T5. `usd_e8s_to_icp_e8s` helper (cached XRC rate).
- [x] T6. `register_faucet_canister` — proof-of-control (`caller == canister`, reject anon/self/non-opaque).
- [x] T7. `faucet_eligibility` helper → `FaucetGate` (G1–G6, admin bypass on G2/G3).
- [x] T8. `claim_faucet_cycles` saga — CallerGuard, reserve-before-spend, CMC top-up, refund handling, record + audit + stats.
- [x] T9. `get_faucet_status` query.
- [x] T10. Admin setters for the 5 params.
- [x] T11. Mirror all of the above in `backend.did`.

## Tests (host, off-wasm)
- [x] eligibility accept
- [x] reject non-member (G2)
- [x] reject no recent burn (G3)
- [x] weekly cooldown — dev (G4) + canister (G4)
- [x] lifetime cap (G5)
- [x] treasury-floor circuit-breaker blocks grant (G6)
- [x] idempotent CMC top-up (retry safe)
- [x] flag-gating (OFF rejects)

## Frontend
- [x] `src/frontend/src/Faucet.tsx` — register, status/cooldown/grant, claim, Result/error handling.
- [x] `App.tsx` — route + nav gated behind `cycles_faucet` flag.

## Verify
- [x] `cargo test -p backend --lib`
- [x] `cd src/frontend && npm run typecheck && npx vitest run`
</content>
