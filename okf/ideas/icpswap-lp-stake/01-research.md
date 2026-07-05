---
type: note
title: "ICPSwap LP — research notes (V3 pools, positions, yield mechanics)"
tags: [ideas, icpswap-lp-stake, research]
timestamp: 2026-07-05T00:00:00Z
---

# Research notes (2026-07-05)

## ICPSwap architecture (V3 / concentrated liquidity)

- Uniswap-V3-style: a **SwapFactory** creates per-pair **SwapPool
  canisters**; each position is a tick-range entry owned by a principal,
  represented as a position (NFT-like, transferable).
- Key SwapPool methods (from ICPSwap-Labs docs + v3 service repo):
  - `getUserPositionIdsByPrincipal(principal)` → position ids.
  - `getUserPosition(positionId)` → { tickLower, tickUpper, liquidity,
    tokensOwed0, tokensOwed1, feeGrowthInside… } — everything needed to
    verify a live position and see unclaimed fees.
  - `transferPosition(from, to, positionId)` — position custody moves;
    also registrable as an SNS GenericNervousSystemFunction (i.e., DAOs
    custody positions this way too — precedent for canister custody).
  - Fee `claim` → collects tokensOwed0/1 to the owner.
  - Deposit/withdraw sub-flows for moving tokens pool↔ledger.
- The ICP/ckUSDC pool exists (docs use it as their worked example. Pool
  canister id: resolve at build time via SwapFactory `getPool` — admin
  config, never hardcoded).

## Yield mechanics — the "ICS only" belief is wrong

- **Swap fees**: 0.3% per trade; **0.24% to LPs** (80%), 0.06% to ICS
  buyback/burn. Fees accrue PER POSITION in the pool's two tokens (ICP +
  ckUSDC for our pair) as tokensOwed0/1, claimed on demand. Out-of-range
  positions earn nothing while out of range.
- **ICS rewards**: separate, opt-in — stake the position NFT into an
  ICPSwap **Farm** (time-limited incentive programs). Harvesting ICS and
  converting it (ICS/ICP pool) is possible but adds two more canister
  integrations; the fee stream alone already pays in exactly the assets we
  want (ICP for pot/burn, ckUSDC swappable to ICP in the same pool).

## Identity: the II per-dapp principal problem

Internet Identity derives a DIFFERENT principal per dapp origin — the
principal owning positions on icpswap.com is not the caller principal on
our dapp. Plug/Oisy-style wallets use one global principal. Consequences
for Model A verification documented in the README; Model B (custody
transfer) sidesteps it entirely: transferring the position TO us proves
control and hands us the yield in one act.

## Sources

[ICPSwap docs repo](https://github.com/ICPSwap-Labs/docs) (SwapPool
liquidity/position methods), [icpswap-v3-service](https://github.com/ICPSwap-Labs/icpswap-v3-service),
[ICPSwap FAQ/GitBook](https://iloveics.gitbook.io/icpswap/products/faq)
(fee split, farms, position NFTs), [ICPSwap Medium](https://icpswap.medium.com/swap-and-token-pools-are-now-available-earn-10-000-of-wicp-icp-rewards-f6e4d5133cb6).
