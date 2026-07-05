---
type: idea
title: "ANSEM LP Reward — Solana liquidity providers earn lottery tickets"
description: "Verify Solana wallet ownership + live $ANSEM LP positions via the SOL RPC canister; 10 tickets per drawing, re-confirmed each round. Scoped, NOT built."
tags: [ideas, ansem-lp-reward, lottery, chain-fusion]
timestamp: 2026-07-04T00:00:00Z
---

# ANSEM LP Reward — Solana LPs earn lottery tickets

**Status: RESEARCHED & PLANNED, NOT built.** Owner ask (2026-07-04): reward
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

## Load-bearing gates (answer before building)

1. **WHICH $ANSEM?** At least two Solana tokens use the ticker (an "Official
   Ansem Coin" pool at ~$2.5k TVL and a "SoylanaManletCaptainZ" pool at
   ~$25k TVL, both ANSEM/SOL on Raydium; NO ANSEM/USDC pool surfaced in
   research). The owner must supply the canonical token mint + exact pool(s).
   Design consequence: pools are **admin config** (name, LP mint, min
   amount), never hardcoded.
2. **Pool program type.** The ATA-balance check works for pools whose LP is
   a plain SPL token (Raydium AMM v4 / CPMM). If the canonical pool is a
   Raydium **CLMM** (concentrated liquidity: positions are NFTs + PDAs), the
   MVP check doesn't apply — that variant needs `jsonRequest` +
   position-account decoding, roughly 3× the work. Verify the pool's program
   before committing to scope.
3. **Stakers-only collision.** Owner rule (2026-07-04): `grant_lottery_tickets`
   NO-OPS for principals without an active stake. Either (a) LP rewards
   require a stake too — zero code change, consistent, recommended (UI copy:
   "stake any amount to activate LP rewards") — or (b) carve an exemption,
   weakening the rule everywhere. **Decision needed.**
4. **Ticket size vs sybil.** 10 tickets is flat per principal+wallet. LP can
   be split across N wallets for N×10 tickets at near-zero cost → the
   min-LP floor is the real sybil price. Suggest a floor worth ≥ ~$25 of LP,
   admin-tunable per pool.

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
