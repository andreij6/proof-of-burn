---
type: idea
title: "ANSEM LP Reward — Solana liquidity providers earn lottery tickets"
description: "Verify Solana wallet ownership + live $ANSEM LP positions via the SOL RPC canister; 10 tickets per drawing, re-confirmed each round. Scoped, NOT built."
tags: [ideas, ansem-lp-reward, lottery, chain-fusion]
timestamp: 2026-07-04T00:00:00Z
---

# ANSEM LP Reward — Solana LPs earn lottery tickets

**Status: BUILT (2026-07-04), shipped dark behind `solana_lp_rewards` (enabled on local; pools + mainnet flag pending owner).** Owner ask (2026-07-04): reward
users providing liquidity for $ANSEM/SOL or $ANSEM/USDC on Solana with **10
lottery tickets per drawing**, wallet-ownership proven, **re-confirmed every
round**.

## The one-paragraph design

The user links their Solana wallet once by signing a challenge message in
Phantom/Solflare (`signMessage` — plain Ed25519 over bytes; the canister
verifies the signature itself, no chain call needed). Then, once per lottery
round, they hit "Confirm LP" — the backend derives the wallet's associated
token account for each admin-configured LP mint and reads its live balance
through the NNS-controlled **SOL RPC canister** (3-provider consensus). Any
balance ≥ the configured floor → `grant_lottery_tickets(caller, 10,
"solana_lp")`. Claims are keyed by lottery round, so when the drawing fires
and the round increments, the button re-arms — that IS the re-confirmation.

## Gates — RESOLVED by owner (2026-07-04)

1. **Token confirmed**: $ANSEM mint =
   `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump` — a pump.fun token, so the
   canonical ANSEM/SOL liquidity lives on **PumpSwap** (pump.fun's AMM).
   Excellent for the MVP: PumpSwap LP positions are **fungible Token-2022 LP
   tokens**, and the LP mint is a PDA derivable from the pool address
   (`["pool_lp_mint", pool]`) — the ATA-balance check works, and admin
   config can store just pool addresses. Pools stay admin config regardless
   (an ANSEM/USDC pool can be added if/when one exists).
2. **Pool mechanisms**: PumpSwap = fungible Token-2022 LP tokens (MVP path
   ✓). **Meteora is DIFFERENT and NOT MVP**: DLMM positions are
   non-transferable program accounts (no token at all); DAMM v2 positions
   are NFTs. Either would need jsonRequest + position-account decoding
   (~2× scope) — deferred until an ANSEM pool actually lives there.
3. **Staking required: DECIDED YES.** The existing stakers-only gate in
   grant_lottery_tickets stands — zero code change; UI copy: "stake any
   amount of ICP to activate LP rewards".
4. **Sybil floor: owner accepts the risk** — 10 tickets/round per principal
   is the cap and that's fine. Keep a dust-level min_amount in pool config
   (filters zero-balance ATAs), default minimal.

## What was researched

See [/ideas/ansem-lp-reward/01-research.md](/ideas/ansem-lp-reward/01-research.md)
for the SOL RPC canister facts (canister id, methods, providers, cost model)
and the wallet-proof mechanics. Implementation sketch, storage, and reuse map
in [/ideas/ansem-lp-reward/02-impl.md](/ideas/ansem-lp-reward/02-impl.md).

## Top risks

- **Memecoin lifecycle**: both candidate pools are small; LP can migrate or
  drain overnight. Admin pool config + per-round re-checks limit blast
  radius; a dead pool simply stops paying.
- **Cycles cost**: each claim = 1-2 SOL RPC reads ≈ ~2-4B cycles (fractions
  of a cent) — negligible per claim, but claims are user-triggered updates:
  rate-limit to once per round per principal (the claim map does this).
- **Wallet-link abuse**: one Solana wallet must link to at most ONE
  principal (reverse-unique map), else one LP position farms tickets across
  principals.
- **Custodial-wallet users** (CEX withdrawals, etc.) can't sign messages —
  they simply can't participate; acceptable.
