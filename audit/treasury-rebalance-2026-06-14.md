# Treasury Rebalancing Advisory — Proof of Burn / Caldera

**Date:** 2026-06-14 (automated daily run)
**Scope:** Review current treasury allocation (predominantly ICP) and recommend a rebalance across BTC, ETH, ICP, USDC for long-term growth and app sustainability.
**Author:** Automated trading advisor. Not financial advice — this is a recommendation for the team to review and execute manually.

---

## TL;DR

The treasury is over-concentrated in a single, high-volatility small-cap (ICP) during a market-wide drawdown. That is the wrong risk posture for an app whose survival depends on always being able to pay its cycle bills. Recommendation: keep enough ICP for operations + conviction, build a real USDC runway, and add BTC/ETH as higher-quality long-term ballast — **phased in over ~8–12 weeks via DCA**, not in one trade at today's lows.

**Target allocation:** BTC 30% · ICP 28% · USDC 27% · ETH 15%

---

## 1. Market snapshot (as of 2026-06-14)

| Asset | Price | Short-term technical read | Trend context |
|-------|-------|---------------------------|---------------|
| BTC | ~$63,900 | Neutral-to-bearish; trading below 50-day (~$61.5k) and near 200-day (~$62k) MAs, RSI ~32 (neutral, near oversold) | Consolidating after a pullback from the >$70k area |
| ETH | ~$1,664 | Mixed / weak; sitting right on its 50- & 200-day MAs (~$1,663), oversold readings on some timeframes; downside risk cited toward $1,400 | Weakest of the three; ETF outflows + macro risk |
| ICP | ~$2.47 | Neutral with downside bias; prolonged accumulation, repeatedly defending $2.60–2.70 (now slipping below) | Small-cap, highest volatility; stabilizing but no confirmed reversal |

**Regime:** broad risk-off / corrective phase across crypto. This favors capital preservation and disciplined accumulation over aggressive positioning. It also means **this is a poor moment to dump ICP** — it's near accumulation-zone lows.

---

## 2. The core problem

The treasury holds **mostly ICP**, but the app's economics are already ICP-denominated:

- Cold-start operating cost is ~8.8 ICP/month even at zero users; treasury income arrives in ICP (50% of every burn).
- The treasury floor bug means canisters go dark if the treasury drops to ≤10 ICP — so a hard operational ICP buffer is non-negotiable.
- Treasury income, costs, *and* reserves are all in ICP. That is triple exposure to the single most volatile asset in the set.

If ICP falls 50% (well within its historical range), the treasury's USD value, its runway, and the buffer guarding the floor bug all shrink at the same time. Concentration is the single biggest risk to **app sustainability**, which is an explicit project goal (GOALS.md §2). Diversification here is risk management, not speculation.

---

## 3. Recommended target allocation

Think of the treasury in two buckets:

### Operational reserve (~40%) — protects the app
- **USDC 27%** — predictable runway. Sized to cover **12–18 months of operating costs** independent of any crypto price move. This is what guarantees the canisters stay funded through a bear market. Also serves as dry powder to accumulate BTC/ETH/ICP on further weakness.
- **ICP (operational slice, ~13% of the 28%)** — working balance for cycle top-ups and the floor-bug buffer. Keep a hard minimum of **≥20 ICP** in the treasury subaccount at all times (per ECONOMICS_PLAYBOOK risk note), well above the 10 ICP danger line.

### Growth reserve (~60%) — preserves and grows USD value
- **BTC 30%** — highest-quality, deepest-liquidity crypto asset; the anchor. Most defensible long-term store of value of the three.
- **ICP (conviction slice, ~15%)** — skin in the game in the app's own ecosystem. Retain meaningful exposure, but no longer the dominant holding.
- **ETH 15%** — smart-contract platform beta. Underweighted vs. BTC given current technical weakness and ETF outflows; smaller position until it reclaims its moving averages.

**Summary target:** BTC 30% · ICP 28% (≈13% operational + 15% conviction) · USDC 27% · ETH 15%

This takes ICP from "most of the treasury" down to ~28% — still the second-largest position and still the largest *conviction* bet, but no longer an existential single point of failure.

---

## 4. How to get there — phased execution

Do **not** rebalance in one transaction. Today's prices are corrective lows, especially for ICP; selling the bulk of the ICP stack here would lock in the drawdown.

1. **Stand up the USDC runway first.** Convert ICP to USDC until 12–18 months of operating costs are covered. This is the highest-priority move and is price-insensitive — it's insurance, not a trade.
2. **DCA into BTC and ETH over 8–12 weeks** (e.g., weekly tranches) rather than a lump sum, to average through the volatility. Weight purchases ~2:1 toward BTC over ETH.
3. **Trim ICP gradually**, ideally into strength (rallies toward/through the $2.60–2.70 resistance), not into the current weakness.
4. **Redirect incoming burn revenue.** Since new treasury income arrives in ICP, route a standing share of it into USDC/BTC/ETH automatically. This rebalances over time without having to sell the existing ICP base — the cleanest path given the team's ICP-denominated income.
5. **Always preserve the operational floor.** Never let scheduled rebalancing pull the treasury ICP balance below the ≥20 ICP buffer.

---

## 5. Triggers to revisit before the next scheduled run

- **ICP reclaims $2.70 on a multi-day close** → window to trim the conviction slice into strength.
- **BTC loses the 200-day MA (~$62k) decisively** → slow BTC DCA, lean on USDC; macro deteriorating.
- **ETH closes below ~$1,400 support** → pause ETH adds; reassess whether the 15% sleeve is warranted.
- **Treasury ICP balance approaches 20 ICP** → halt all rebalancing, top up the buffer first (floor-bug protection overrides allocation targets).
- **Runway falls below 12 months** → rebuild USDC before any further BTC/ETH accumulation.

---

## 6. Caveats

- Exact current holdings (USD value, ICP count) were not available in the repo; allocations are expressed as target percentages. Plug in live treasury figures via `get_treasury_balance()` to convert these into concrete trade sizes.
- Crypto is volatile and these are point-in-time technicals; this advisory is decision support, not a guarantee. The team executes all trades manually — no automated trading is performed by this task.

---

## Sources
- [Bitcoin/Ethereum prices today — Yahoo Finance](https://finance.yahoo.com/personal-finance/investing/article/bitcoin-and-ethereum-prices-today-june-10-2026-btc-eth-open-lower-and-falling-further-114713805.html)
- [Internet Computer price & chart — CoinGecko](https://www.coingecko.com/en/coins/internet-computer)
- [Bitcoin price prediction June 2026 — Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/bitcoin-price-prediction-june-2026-070000962.html)
- [Ethereum price forecast June 2026 — SpotedCrypto](https://www.spotedcrypto.com/ethereum-price-forecast-june-2026-1400-support/)
- [Internet Computer price prediction & TA June 2026 — Blockspot](https://blockspot.io/coin/internet-computer/price-prediction/)
- TradingView technicals: [BTCUSD](https://www.tradingview.com/symbols/BTCUSD/technicals/?exchange=CRYPTO) · [ETHUSD](https://www.tradingview.com/symbols/ETHUSD/technicals/?exchange=CRYPTO) · [ICPUSD](https://www.tradingview.com/symbols/ICPUSD/technicals/?exchange=CRYPTO)
