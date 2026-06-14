# 08 — Systems analysis: the bust→restake flywheel

## The loop poker actually powers

Poker never moves ICP. So where does platform value come from? From what
players do AFTER variance does its work:

```
play hands (zero-sum VP churn)
   └─► some players bust / hit stop-loss
          └─► to play again (and to vote again) they STAKE MORE ICP
                 └─► platform tier-neurons grow
                        ├─► more NNS maturity yield (80% lottery / 20% treasury)
                        ├─► more NNS voting power following the primary neuron
                        └─► bigger lottery pot → staking is more attractive
                               └─► more players with VP to wager → more hands
```

Cash tables run this loop continuously at near-zero marginal cost (timers
only fire on occupied tables). A tournament adds scheduling, balancing and
support burden while *bunching* the same VP churn into one daily event —
that's why it is Phase 2 and dark by default (D12/D24). The honest framing:
**poker is a VP velocity machine whose exhaust is staking demand.**

Two structural facts keep it user-safe and regulator-friendly:
- the user's ICP principal is NEVER at risk (the no-loss invariant, doc 01);
- the platform takes **no rake** — VP redistribution is player-to-player.
  Platform revenue is (a) staking growth driven by the loop above and
  (b) hard-dollar fees on the periphery (scripts, marketplace, cosmetics).

## Stop-loss (D23) — and why it HELPS the flywheel

A full wipeout feels terrible and silences the user's governance voice —
wiped players churn out of the whole dapp, not just poker. The default-on
stop-loss (floor = 25% of staking weight) converts "I lost everything" into
"I lost my risk budget", which:
- keeps the player voting (retains the governance product),
- keeps them seated in the staking system (retains yield),
- and still leaves the restake nudge intact — rebuilding from 25% to a
  comfortable bankroll is the same staking event, just less resentful.

Mechanics live in doc 01/03; the settlement check is one comparison per
hand; the UI treats a stop-loss exit as a first-class state with a
one-click path to restake or lower the floor (eyes open).

## KPIs (wire into the monitor script from day one)

| KPI | Definition | Why |
|---|---|---|
| **Restake-after-bust conversion** | % of bust/stop-loss events followed by a `stake()` within 7 days | THE metric (D24) |
| ICP staked attributable | Σ stake increases within 7 d of a poker exit event | revenue proxy |
| VP velocity | Σ |hand deltas| / day | engagement |
| Table occupancy | seated-agent-hours / (10×9×24) | liquidity health |
| Script economy | $ creations + 20% marketplace cut / week | direct revenue |
| VP concentration | top-10 share of poker-won VP | governance risk (R11) |

## Recommendations (R1–R12)

**Adopted into scope (D26): R3 → PB-213 copy, R4 → PB-221, R5 → PB-222,
R6 → PB-219, R7 → PB-223, R8 → PB-210.** R1/R2 were already locked
(D12/D23/D24). R9–R12 remain recommended follow-ups — each becomes its own
PB task if picked up. None of them ever puts user ICP at risk.

- **R1 (locked → D12/D24): Cash-first; tournament dark, weekly when enabled.**
  Bunched events are cost without new revenue until tables are liquid.
- **R2 (locked → D23): Stop-loss default ON.** Retention beats extraction;
  the restake event happens either way.
- **R3 (locked, copy-level): "0% rake, forever" as a headline.** We
  deliberately take no cut of pots — unheard-of in poker, free marketing,
  and true because our revenue is upstream (staking) and sideways (fees).
- **R4: Cosmetics economy.** Card backs, table felts, win animations,
  chip-set skins — $1–$5 via the existing oracle quote flow, 100% treasury,
  zero gameplay impact. Highest-margin revenue in the epic; reuses the
  arcade customization machinery nearly verbatim.
- **R5: Weekly leaderboard seasons.** Free-to-run tables ranked by VP won +
  hands played; prizes are cosmetics/badges (R4 inventory), not VP — drives
  volume without inflating anything.
- **R6: The restake nudge.** On bust/stop-loss, a one-click
  "Stake & get back in the game" deep-link into Earn with a suggested amount
  (e.g. restore-to-previous-bankroll). This is the single highest-leverage
  UI element in the epic — it is the conversion step of the whole flywheel.
  Track it as its own funnel.
- **R7: Spectator acquisition.** Featured table card on the Dashboard,
  shareable hand replays (X-share like proposals: "AA cracked by 72o on
  Caldera Hold'em"), rail counter. Watching is free; watching sells claiming
  an agent.
- **R8: Script economy as the skill meta.** Public script leaderboard
  (lifetime VP won while active) → famous scripts sell → 20% treasury cut
  scales with fame; $5 creations scale with experimentation. The marketplace
  is where poker mints dollars, not VP.
- **R9: House liquidity bots (bounded promo budget).** Cold-start problem:
  empty tables attract nobody. Platform-owned house agents with simple
  styles seed 2–3 tables. Their bankroll is a **capped promo allowance**
  (e.g. 100 VP/month) accounted as a platform principal inside the zero-sum
  ledger (Σ deltas over users+platform = 0 still holds). Sharks farming the
  house is then a *marketing cost with a hard cap* — "win VP from the
  house" is itself a draw. Auto-retire bots as real occupancy rises.
- **R10: Daily poker quest → lottery tickets.** "Play 10 hands today: +5
  lottery tickets." Costs the platform nothing (tickets dilute other
  players' odds, not the pot), cross-pollinates the two loops, and gives
  low-VP players a reason to keep playing small.
- **R11: Governance concentration guard.** Poker concentrates VP in winners
  by design. Monitor top-10 poker-won VP share; if it threatens governance
  legitimacy, the prepared lever is a cap: *poker-won VP counts toward
  voting up to 3× your own staked weight* (excess still works as poker
  bankroll). Don't ship the cap in v1 — ship the measurement.
- **R12: "Rebuild" badge path.** Players who bust to floor and restake get a
  visible badge season ("Phoenix"); small, human, and it celebrates exactly
  the behavior the platform monetizes — honestly framed, since their ICP
  was never at risk.

## What we deliberately do NOT do

- No rake, no VP fees on pots (kills the differentiator, complicates I-1).
- No buying VP with ICP/tokens directly (VP must stay earned-by-staking —
  otherwise poker becomes gambling with money and the no-loss story dies).
- No platform-favored bots beyond the capped R9 promo budget.
- No tournament until cash tables sustain ≥ ~30% occupancy for 2 weeks.
