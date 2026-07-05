---
type: note
title: "ANSEM LP Reward — implementation sketch, storage, reuse map"
tags: [ideas, ansem-lp-reward, impl]
timestamp: 2026-07-04T00:00:00Z
---

# Implementation sketch (NOT built)

## Backend (new §, flag `solana_lp_rewards`, ships dark)

Endpoints:
- `get_lp_reward_info()` query → { pools (name/lp_mint/min), my_wallet?,
  claimed_this_round, round, tickets_per_claim: 10 }.
- `link_solana_wallet(pubkey: blob, signature: blob, nonce: u64)` update →
  verifies Ed25519 over the canonical challenge (binds caller principal +
  current round + nonce + expiry), enforces wallet-uniqueness both ways.
  Unlink: `unlink_solana_wallet()`.
- `claim_lp_reward()` async update → gates: flag, authenticated, wallet
  linked, NOT claimed this lottery round; for each configured pool: derive
  ATA(wallet, lp_mint) → SOL RPC `getTokenAccountBalance` (Equality, 3
  providers, finalized, cycles attached); if any balance ≥ pool.min →
  `grant_lottery_tickets(caller, 10, "solana_lp")` (subject to the
  stakers-only gate — see README gate 3) + record claim.
- `admin_set_lp_pools(vec { name; pool_address; min_amount })` — the
  PumpSwap LP mint derives in-canister from the pool address
  (PDA ["pool_lp_mint", pool]); ATAs derive with the TOKEN_2022 program id.

Storage (next free MemoryIds — check at build time; 118+ as of 2026-07-04):
- 118 `SOLANA_WALLETS`: principal → { pubkey, linked_at }.
- 119 `SOLANA_WALLET_OWNERS`: pubkey → principal (reverse uniqueness).
- 120 `LP_CLAIMS`: (round, principal) → { wallet, pool, amount, at }.
- 121 `LP_POOLS`: StableCell<Vec<PoolCfg>>.

Deps: `ed25519-dalek` (sig verify), `sol_rpc_client`/`sol_rpc_types` OR a
thin hand-rolled call to `tghme-zyaaa-aaaar-qarca-cai` (fewer deps — the
candid surface used is small). ATA derivation: ~40 lines (sha256 PDA loop).

Mock seam (repo convention): native mock for the SOL RPC call + a
`dev_set_mock_lp_balance` style test hook so `cargo test` covers the full
claim flow; local replica can also deploy the real SOL RPC canister
(supported by its repo) — optional.

## Frontend

- Lottery page card "Solana LP rewards" (behind flag): connect Phantom via
  `window.solana` (feature-detect — NO new npm dependency), `signMessage`,
  link, then a per-round "Confirm LP → +10 tickets" button; after the
  drawing, the round bumps and the button re-arms (re-confirmation).
- Ticket breakdown label: `solana_lp` → "Solana LP rewards" in
  TICKET_SOURCE_LABELS (one line).

## Reuse map

- `grant_lottery_tickets(user, n, source)` + TICKET_SOURCES breakdown —
  already round-scoped; a claim source lands in the existing UI for free.
- Round semantics: lottery `state.round` is the re-confirmation clock; the
  claim map key (round, principal) is exactly the once-per-drawing rule.
- Admin config pattern: mirrors admin_set_token_ledger / explorer ledgers.
- Feature-flag plumbing: same as arcade_* flags.

## Cost & limits

- Per claim: 1-2 `getTokenAccountBalance` calls ≈ ~1-2B cycles each with
  3-provider Equality (≈ $0.003-0.01 per claim including headroom).
  User-triggered, once per round per principal — no timers, no sweeps.
- Challenge nonces: short-lived (10 min expiry) — store last nonce per
  principal in the wallet-link record; no extra map.

## Testing

- Ed25519 verify: known-answer vectors + a rejected tampered message.
- ATA derivation: known (wallet, mint) → ATA vectors from mainnet.
- Claim flow (mocked RPC): below-floor rejected, at-floor granted 10 via
  "solana_lp", double-claim same round rejected, round bump re-arms,
  unstaked principal gets 0 (if gate (a) chosen), wallet uniqueness.

## Decisions locked (owner, 2026-07-04)

- Token mint `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`; MVP =
  PumpSwap pools only (fungible Token-2022 LP). Meteora (DLMM position
  accounts / DAMM v2 NFTs) deferred.
- Staking REQUIRED — the grant_lottery_tickets gate stands unchanged.
- Sybil floor: accepted risk; min_amount is just a dust filter.

## Estimate

Backend ~500 lines + deps, frontend ~250, tests ~250. Meteora support
(position-account decoding via jsonRequest) would roughly double it.
