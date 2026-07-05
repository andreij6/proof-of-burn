---
type: idea
title: "ICPSwap LP — verify ICP/ckUSDC LPs and/or custody-stake positions to fund the lottery + burn"
description: "Two models: (A) verify a user's ICPSwap ICP/ckUSDC position for lottery tickets; (B) users stake their position NFT with us, we harvest the yield into the lottery pot + ICP burn. Scoped, NOT built."
tags: [ideas, icpswap-lp-stake, lottery]
timestamp: 2026-07-05T00:00:00Z
---

# ICPSwap ICP/ckUSDC LP rewards & LP staking

**Status: RESEARCHED & PLANNED, NOT built.** Owner ask (2026-07-05): do the
ANSEM-style reward for the ICPSwap ICP/USDC pair, and explore letting users
STAKE their LP with us so the app uses the yield to support the lottery pot
and token burn.

## The premise, corrected

ICPSwap LPs earn **two separate yield streams**, and neither is "ICS only":

1. **Trading fees — always, in the pool's own tokens.** 0.3% per swap;
   0.24% goes to LPs (80% of fees), accruing to each position as
   `tokensOwed0/1` — for ICP/ckUSDC that's **ICP and ckUSDC**, claimable
   any time. This is the yield stream that matters for us: it's exactly the
   assets our lottery pot (ICP) and burn (ICP→cycles) want.
2. **ICS — only from Farms.** Staking a position NFT into an ICPSwap Farm
   pays ICS, but farms are time-limited incentive programs that may or may
   not exist for a pair at any given moment. ICS would need harvesting +
   selling (ICS/ICP pool) before it's useful to us. Phase-2 material.

## Why this is EASIER transport than ANSEM (and harder custody)

ICPSwap runs **on ICP**: its SwapPool canisters are queryable and callable
directly (`getUserPositionIdsByPrincipal`, `getUserPosition(positionId)` →
liquidity/ticks/tokensOwed, `transferPosition`, fee `claim`). No chain
fusion, no RPC fanout, no signature verification of foreign curves. The
hard part flips from transport to **custody and identity**.

## Model A — verify-only (ANSEM-parity tickets)

Read the user's positions in the ICP/ckUSDC SwapPool; any live position ≥
floor → 10 tickets per drawing, claims keyed by lottery round (identical
machinery to ANSEM LP). **The catch is identity**: Internet Identity gives
users a DIFFERENT principal per dapp, so the principal that owns their
ICPSwap position is NOT the principal they use here. Ownership proofs, best
first:
1. **Global-principal wallets** (Plug, Oisy): same principal everywhere —
   if they sign into ICPSwap with one, verification is a direct lookup.
   Requires us to support that wallet's login alongside II.
2. **Approval proof**: the user calls the pool's position-approval method
   (approving OUR canister) from their ICPSwap principal; only the owner
   can approve, so an approval visible on the pool proves control — no
   custody taken. (Verify exact method name/semantics in icpswap-v3-service
   at build time.)
3. Micro-transfer memo challenges — wallet-hostile for II users; last resort.

## Model B — custody staking (the owner's main interest)

The user **transfers their position NFT to our backend canister**
(`transferPosition`), which solves identity as a side effect (the transfer
itself is the proof). While staked:
- The user earns lottery tickets every round (flat 10/round for parity, or
  liquidity-scaled later).
- OUR canister owns the position, so the sweep can periodically claim the
  accrued trading fees: **ICP goes straight to its two jobs** (X% lottery
  pot, Y% burn via the existing CMC settle machinery); **ckUSDC gets
  swapped to ICP on the same pool** (our canister can call swap) and then
  routed identically.
- **Unstake = transferPosition back**, any time, position intact (fees
  since last harvest go with it or get one final claim — decide).

### The custody risks (this is the platform's first user-fund custody)

- We hold principal user assets, not just escrow-in-flight. Needs: an
  ironclad per-user position registry (stable memory), unstake that cannot
  be blocked by feature flags or upgrades, audit-log every transfer/claim,
  and a documented recovery path. An admin-recovery endpoint is itself a
  risk (rug vector) — prefer none; owner decision needed.
- ICPSwap dependency: their SNS-controlled canisters can upgrade/pause;
  out-of-range positions accrue nothing (accept — tickets still flow, the
  pot just earns less).
- Impermanent loss stays the user's — the position returns as-is. Copy
  must say so loudly.

## Recommendation

Ship **Model B as the headline** ("Stake your ICPSwap LP, fund the pot,
earn tickets") with Model A's approval-proof as a lighter companion for
users unwilling to custody. Phase 2: farm-staking custodied positions for
ICS when a farm for the pair is live (harvest → ICS/ICP swap → same
routing).

Details: [/ideas/icpswap-lp-stake/01-research.md](/ideas/icpswap-lp-stake/01-research.md),
[/ideas/icpswap-lp-stake/02-impl.md](/ideas/icpswap-lp-stake/02-impl.md).
