# Tao-Like Reward — How It Works (High Level)

> The non-technical "what it is and why" doc. Technical mechanics in [`02-technical.md`](./02-technical.md);
> feasibility caveats are summarized in the [README](./README.md) and detailed in
> [`04-adversarial-review.md`](./04-adversarial-review.md).

## The pitch

A **builder league for the Internet Computer**, modeled on Bittensor (TAO). Up to **128 apps** ("syndicate
apps") compete by **putting real compute on ICP** — measured as **cycle burn**. Every day they're **ranked**
and **share a new token**. The token gives holders **governance** over the league's SNS DAO and lets them
**steer how the league's NNS neuron votes** on ICP governance. Protocol revenue continuously **buys back the
token and burns ICP** (by converting it to cycles), aligning the project with long-term ICP health.

It turns "which apps actually use the Internet Computer the most" into a transparent, rewarded, governable
competition — and mints a new crypto whose value is tied to real on-chain activity, not just speculation.

## The Bittensor analogy (and where it diverges)

| Bittensor | This design |
|---|---|
| 128 subnets | 128 syndicate apps |
| Miners do work; **validators score it** (subjective, gamed by weight-copying) | **Cycle burn is the score** — objective, on-chain, no validator layer needed |
| Pay TAO to register; worst subnet relegated | Pay (burn) to register; worst app relegated; newcomers get an immunity period |
| 21M cap, ~4-yr halving | 21M cap, milestone halving |
| Emissions ∝ staked inflow (market/price) | Emissions ∝ **smoothed cycle-burn share** (real cost, harder to fake) |
| TAO governs via Senate/root | Token governs via SNS + steers a community NNS neuron |

**The key ICP-native advantage:** Bittensor spends ~41% of all emissions just paying validators to verify
work, and still fights weight-copying and validator cartels. Cycle burn is **already an objective on-chain
fact**, so this design needs **no validator/verification layer for ranking** — sidestepping Bittensor's
biggest costs and attacks. (The catch: measuring another app's cycle burn isn't trustless — see "The honest
caveats.")

## The lifecycle of a syndicate app

1. **Register (burn to enter).** An app claims one of 128 slots by paying a registration cost — ideally an
   **escalating, demand-responsive burn** (doubles with recent registrations, decays over time) so slots
   stay scarce and spam is uneconomic. The app **registers its canister IDs** and grants the league a
   **read-only observer** so its cycle burn can be verified.
2. **Immunity period.** New apps get a grace window (Bittensor uses ~4 months) before they can be relegated,
   so they can ramp up.
3. **Daily ranking.** Each day the league samples every registered app's cycle burn (top-up-adjusted),
   smooths it with an exponential moving average (EMA), and ranks all 128.
4. **Earn a share.** The day's token emission is split across apps **proportional to their EMA cycle-burn
   share**, with apps below a floor earning **zero** (so dead apps don't drain the pool).
5. **Relegation.** When all 128 slots are full and a new app registers, the **lowest-ranked non-immune app**
   is dropped — slots are permanently contested.

## The token

- **Capped at 21,000,000**, the entire supply **minted once at genesis** and parked in a treasury, then
  **released on a halving schedule** to fund daily emissions. (Bittensor and Bitcoin both use 21M + halving;
  this mirrors that, but the supply is pre-minted and released rather than minted per block — see
  [`02` §4](./02-technical.md) for why.)
- **Three sources of value:** (1) **governance** rights over the SNS DAO and treasury; (2) **steering** the
  league's NNS neuron on ICP proposals; (3) **buyback demand** from protocol revenue.
- **Three honest pressures:** daily emission to 128 apps creates **persistent sell pressure** (recipients
  may sell); the **halving** means the builder subsidy shrinks over time; and the token only has lasting
  value if **real revenue** eventually outweighs emissions.

## Governance & "voting on ICP proposals"

- **SNS governance** is standard: token-holders stake into SNS neurons and vote on proposals that control
  the league's dapp, treasury, and parameters.
- **"Vote on ICP proposals"** works through a **community-neuron model** (which this project already does
  with ICP burns): the league holds an **NNS neuron**, token-holders cast an **in-canister tally**, and the
  league's neuron votes the way the tally decided. Important honesty: the token doesn't vote on the NNS
  directly — it **steers one ICP-staked neuron**, whose actual NNS weight depends on how much **ICP** the
  league locks, not on token supply.

## Buyback-and-burn (supporting ICP)

Protocol revenue funds a continuous loop:
1. **Buy back the token** on an ICP DEX (ICPSwap/KongSwap) — supports the token price, returns supply to the
   treasury.
2. **Burn ICP** — the canonical ICP "burn" on the IC is **converting ICP to cycles** via the Cycles Minting
   Canister. This both removes ICP from supply *and* yields cycles the league can use to run itself.

This is real and precedented (**Gold DAO** runs automated buyback-and-burn from neuron revenue). Be honest
about magnitude: one app's ICP→cycles burn is a **rounding error** on ICP's total supply — it's a credible
**alignment signal and small structural buyer of ICP**, not a price-moving force. The part that actually
moves *our* token's price is the **token buyback**.

## The honest caveats (read before believing the pitch)

1. **We can't trustlessly measure another app's cycle burn.** A canister's cycle balance is private to its
   controllers; there's no public per-canister metric and no way to list an app's canisters. So this is an
   **opt-in league**: apps prove their burn by registering canisters and granting a read-only observer.
   Apps can always run **unregistered** canisters, so the ranking is "burn among registered canisters," not
   "true total app burn." (Full analysis: [`02` §2](./02-technical.md).)
2. **Cycle burn rewards *spending*, not *value*.** An app that wastefully burns cycles ranks higher than a
   lean, efficient, popular one. And an app can **burn-to-farm** — waste cycles purely to win tokens. Guard:
   keep rewards **strictly below the cost burned** (no profitable self-burn loop), and consider weighting by
   useful signals (calls served, users) rather than raw burn.
3. **"Vote on the NNS with the token" is not literally true** — it's steering a canister-controlled neuron
   (see above).
4. **An SNS is a one-way handover** — after launch the DAO (not the team) controls the dapp, token, and
   treasury. Worth prototyping with a plain token first.
5. **Emissions are a subsidy that decays.** Plan the transition from emission-funded to revenue-funded
   builder rewards before the halving curve runs down.
6. **The economics — not the measurement — is the existential risk** (economic review,
   [`04`](./04-adversarial-review.md)): the value loop is **circular with no exogenous demand anchor** and
   128 apps are **forced sellers**, so without a recurring activity-linked revenue line the token
   death-spirals; the anti-farm guard **fails** once appreciation/governance value enters; and ranking by
   burn **rewards capital and waste, not builders**. The fix is to **reward usage/payment-volume rather than
   raw burn** and fund the buyback from recurring revenue.
7. **Securities-like characteristics** ([`04` F8](./04-adversarial-review.md)): pay-to-join + capped supply
   + a buyback that "supports price" + appreciation is a high-risk combination. **Get legal counsel before
   any public doc or token swap, and remove all "price support / appreciation" language.** Consider
   launching as non-transferable utility points first.

## Why it's still compelling

Despite the caveats, the core is strong and uniquely ICP-native: **a transparent, governed competition that
rewards the apps doing the most real work on the Internet Computer, mints a capped crypto with a genuine
sink, gives supporters governance, and continuously converts revenue into ICP deflation.** No other chain
has "cycle burn" as a clean, objective activity metric to build a Bittensor-style league on — that's the
opportunity. The work is making the measurement honest (opt-in + observer) and the metric meaningful
(net-of-top-up, rewards-below-burn, maybe value-weighted).
