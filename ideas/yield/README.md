# Treasury Yield — ICPSwap & Liquidium

> **Status:** Idea / feasibility research. Not built, no implementation tasks.
> **Date:** 2026-06-16. Goal: put the app's otherwise-idle treasury assets to work — earn yield on
> ICPSwap and/or borrow/lend via Liquidium — to **create recurring value** (fund cycles, grow the lottery
> pot, top up the treasury floor, or feed a future buyback/burn) without depleting principal.

## What the app has to work with

The treasury already accumulates assets that currently earn **nothing**:
- **ICP** — 50% of every settled burn lands in `TREASURY_SUBACCOUNT`.
- **ck-tokens** — Dapp Explorer listing fees ($1/day) are taken in ICP / ckBTC / ckETH / **ckUSDC / ckUSDT**
  (ledger ids already in `Config`).
- **Staking neuron yield** — harvested maturity already splits 70% lottery / 30% treasury.
- **Lottery pot** — held as ICP in `LOTTERY_SUBACCOUNT`.
- A hard **treasury floor** (`faucet_treasury_floor_e8s`, ~15 ICP) reserved for cycle life-support; the app
  converts ICP→cycles via the CMC to run itself.

Today there is **no DEX or lending integration** (no HTTPS outcalls; only inter-canister calls to ledgers/
CMC/XRC/NNS). Any of the below is net-new integration.

## The core principle: a capped "yield sleeve," never the whole treasury

The treasury is the app's **safety reserve** (cycle life-support + refund coverage). DeFi adds
smart-contract, market, and liquidity risk. So the design rule for everything below:

> **Only deploy a capped *surplus* sleeve into yield. Keep the treasury floor + a safety buffer
> un-deployed and instantly available.** Cap the sleeve (e.g. ≤ X% of treasury), prefer instruments you
> can exit quickly, and never let a yield position threaten the cycle floor.

## Options (ranked by risk-adjusted fit)

### A. ICPSwap stablecoin LP — **recommended first step** ✅
Provide idle **ckUSDC + ckUSDT** to the ICPSwap **ckUSDC/ckUSDT stable pool** and earn a share of swap fees.
- **Why it's the best start:** a stablecoin↔stablecoin pair has **~zero impermanent loss** (both legs
  track $1), so the position can't bleed value from price divergence the way a volatile pair can — you
  just accrue trading fees. ICPSwap is a Uniswap-v3-style AMM with per-pool fee tiers (0.05%–1%).
- **Programmatic:** ICPSwap pools are **canisters**; our canister can add/remove liquidity and collect
  fees via inter-canister calls (ICRC-2 `approve` + the pool's deposit/mint/withdraw methods) — the same
  canister-native pattern the buyback-burn idea would use. **No HTTPS outcall needed.**
- **Yield source:** swap fees only (variable; depends on the stable pool's volume). Modest but low-risk.
- **Risk:** smart-contract risk (cap exposure); thin-pool/slippage on entry/exit; fees may be small.

### B. ICPSwap ICP-paired LP — higher yield, real IL risk ⚠️
Provide **ICP/ckUSDC** (or, if a project token ever exists, **ICP/<token>**) liquidity for bigger fee
share.
- **Trade-off:** ICP is volatile, so the position carries **impermanent loss** — if ICP moves, you end up
  with more of the falling asset; fees may or may not offset it. Only worth it if the pool's volume/fees
  are high relative to expected IL.
- **Strategic angle — protocol-owned liquidity:** if the app ever launches its own token (see the
  `tao-like-reward` idea), seeding **ICP/<token>** liquidity from the treasury gives the token a market
  and earns fees on its own volume. Pairs naturally with a buyback program.

### C. ICPSwap ICS staking / yield farming — lower priority
Stake the ICPSwap governance token (**ICS**) or farm LP for ICS rewards. Requires **acquiring and holding
ICS** (a speculative asset the treasury doesn't hold today), adding token-price exposure. Skip unless the
treasury deliberately wants ICS governance/upside.

### D. Liquidium **lend-to-earn** — viable later, likely manual ops 🟡
Liquidium is a cross-chain lending protocol whose backend runs **on ICP using ck-assets**; lenders supply
an asset (e.g. **stablecoins / ckBTC**) into a pool and earn a **dynamically-adjusted** yield from
over-collateralized borrowers; a liquidation engine protects lenders.
- **Pro:** lending into an over-collateralized pool is conceptually lower-risk than unsecured lending
  (borrowers post > 100% collateral; liquidations cover defaults), and stablecoin lending avoids price
  risk. Yields are often higher than passive LP fees.
- **Con / blocker:** Liquidium's public surface is **wallet/UI-driven**; no documented **canister API**
  for a contract to lend programmatically. So integration would be **off-chain/admin-operated** (a human
  or a worker manages positions), not autonomous. Treat as a later, manually-run option.
- **Risk:** protocol/smart-contract risk + reliance on its liquidation engine; manual operations risk.

### E. Liquidium **borrowing (leverage)** — not recommended ❌
Borrow over-collateralized against treasury **ckBTC** to get working capital (stablecoins/ICP) without
selling, or to lever into LP.
- **Why not (for this treasury):** it introduces **liquidation risk** (a BTC drawdown could liquidate the
  collateral) and **leverage** on a reserve whose primary job is cycle life-support. The downside
  (losing collateral) dwarfs the upside (avoiding a sale). Only consider for a deliberate, small,
  closely-watched position — not as a default treasury strategy.

## Where the yield creates value for the app

Route harvested yield to any of (admin-configurable, mirrors existing split plumbing):
- **Self-fund cycles** — convert yield → cycles via the CMC so ops don't deplete principal (makes the app
  closer to self-sustaining).
- **Grow the lottery pot** — bigger, more attractive jackpots without touching burn proceeds.
- **Top up / rebuild the treasury floor** — yield backfills the cycle-life-support reserve.
- **Feed a buyback/burn or future SNS** — recurring, activity-independent revenue (the exogenous-revenue
  anchor the `tao-like-reward` study found missing).

## Feasibility summary

| Option | Programmatic on-chain? | IL/price risk | Risk-adjusted fit |
|---|---|---|---|
| A. ICPSwap stable LP (ckUSDC/ckUSDT) | **Yes** (inter-canister) | ~none | **Best first step** |
| B. ICPSwap ICP-paired LP | Yes | Real (IL) | Strategic w/ own token / POL |
| C. ICPSwap ICS staking/farming | Yes | ICS price | Low priority |
| D. Liquidium lend-to-earn | **No public canister API** → manual | none (stables) | Later, manual |
| E. Liquidium borrow/leverage | Manual | Liquidation | Avoid for the treasury |

## Recommendation (phased, no tasks yet)

1. **Phase 0 — guardrails:** define a capped **yield sleeve** (e.g. ≤ a set % of treasury, never the
   floor), an admin pause/withdraw switch, and where yield is routed. Decide the cap with the
   risk appetite up front.
2. **Phase 1 — ICPSwap stablecoin LP (A):** deploy the sleeve's **ckUSDC/ckUSDT** into the stable pool via
   inter-canister calls; periodically collect fees (on the existing timer) and route them per above. This
   is the lowest-risk, fully-on-chain way to start earning. Net-new ICPSwap pool integration (approve →
   deposit → collect → withdraw); no HTTPS outcall required.
3. **Phase 2 — evaluate:** measure realized fee yield vs. effort/risk; only then consider ICP-paired LP
   (B) or a **manually-operated** Liquidium lending position (D). Skip leverage (E).

## Open questions / decisions

- **Sleeve cap & floor buffer:** what % of treasury is eligible, and what absolute ICP buffer stays liquid
  above the cycle floor?
- **Single-asset reality:** does the treasury actually hold *enough ckUSDC + ckUSDT* to LP meaningfully, or
  is it mostly ICP? (Explorer fees are split across 5 tokens; volumes may be small.) If it's mostly ICP,
  option A needs converting some ICP→stables first (itself a swap with slippage).
- **Custody/control:** the LP/lending positions are held by the canister — confirm the canister
  controllership is hardened before parking treasury value in external protocols.
- **Accounting:** how positions + accrued yield surface in `get_global_stats` / admin views.
- **ICPSwap pool selection & audit posture:** which exact pool canister, fee tier, and what's the
  smart-contract-risk tolerance (cap size accordingly).

## Sources

- [ICPSwap — Liquidity app](https://app.icpswap.com/liquidity) ·
  [ICPSwap Swap/Liquidity docs (fee tiers, IL guidance)](https://iloveics.gitbook.io/icpswap/products/swap-liquidity) ·
  [ICPSwap SNS DAO](https://dashboard.internetcomputer.org/sns/csyra-haaaa-aaaaq-aacva-cai) ·
  [ICPSwap TVL/volume (DefiLlama)](https://defillama.com/protocol/icpswap)
- [Liquidium — USDC lending (lend-to-earn mechanics)](https://liquidium.fi/blog/usdc-lending) ·
  [Liquidium — cross-chain lending (ICP backend, ck-assets, over-collateralized)](https://liquidium.fi/blog/cross-chain-crypto-lending) ·
  [Liquidium cross-chain launch](https://liquidium.fi/blog/liquidium-launches-cross-chain-lending-protocol-for-native-bitcoin-and-ethereum-assets) ·
  [Liquidium instant loans (DFINITY forum)](https://forum.dfinity.org/t/liquidium-wtf-instant-loans/57610)
- Impermanent-loss background: [Binance Academy](https://academy.binance.com/en/articles/impermanent-loss-explained)
