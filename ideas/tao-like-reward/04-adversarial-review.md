# Tao-Like Reward — Adversarial Economic Review

> A mechanism-design red-team of the incentive loop (the technical/measurement constraints are covered in
> [`02`](./02-technical.md)/[`03`](./03-research-notes.md); this attacks whether the *economics* hold).
> **Verdict: the core economic loop is BROKEN as specified, marginal if rebuilt.** The docs are honest about
> the *measurement* crux but under-weight the *economic* crux — which is the bigger one. Findings fold into
> the README's reprioritized "biggest risk."

## F1 [CRITICAL] — The anti-farm guard is mathematically wrong

`Σ rewards (ICP) < Σ cycles burned (ICP)` only holds if the farmer values the token at **spot** and sells
**immediately**. It collapses once the two things the token is *designed* to have enter: **price
appreciation** and **governance/control value**.

*Scenario:* token = $1; "FarmCo" runs a `sha256` burn loop costing $100k/yr → earns ~$99k of token ("loses
$1k", guard says fine). But if FarmCo expects 10× appreciation, that token is worth ~$990k → **farming at
~9.9× by wasting compute**. Or FarmCo wants the token's **control** over an SNS treasury worth $1M → burning
$100k to capture it is rational even with zero appreciation. The real condition is
`reward valued at the farmer's PRIVATE (spot × expected-appreciation × control-premium) < cost burned`, for
the *most optimistic* participant — **unobservable, and contradicted by the project's own "this token will
be valuable" pitch.** You cannot be farm-proof while claiming the token appreciates.

**Fix:** cap rewards in **absolute** terms (fixed daily pool, sized so even at 10× expected price it can't
exceed plausible honest burn) **and/or** reward something that can't be manufactured for free (F2). Or drop
"farm-proof" and call it a subsidy auction (pay-to-win rank) — coherent, just not "reward builders."

## F2 [CRITICAL] — The metric rewards waste; it harms the ecosystem it claims to help

Ranking by cycle burn rewards **spending/inefficiency**, not value. A bloated app that loops uselessly
outranks a lean, popular one. The equilibrium is **everyone burning maximally** — a collective-action
problem that **maximizes ICP waste**, the exact externality the project says it opposes. "Objective +
unfakeable" and "measures value" are in tension; cycle-burn bought objectivity by measuring the one thing
you don't want maximized.

**Fix (best available):** rank by **payment/transaction volume (ICRC flows) through registered canisters** —
objective, **costly to fake** (inflating real payments costs real money, the self-throttle the burn guard
*wanted*), and actually correlates with usage/value. Burn becomes a **liveness floor**, not the score. If
you keep burn, divide by a usage signal and hard-cap per-app share. If neither, rename the goal honestly:
"recognize whoever puts the most raw compute on ICP (including wasteful compute)."

## F3 [CRITICAL] — The value loop is circular with no exogenous anchor

Token value rests on (a) governance, (b) NNS-steering, (c) buyback — and (c) is funded by revenue
(registration burns) paid by apps who participate *because the token is valuable* → back to (c). (a) is only
worth something if the treasury is; (b) only to the extent real **ICP** is locked (itself from the
swap/token sale). The only exogenous inputs are the **one-time swap raise** and **registration burns** — and
with slots **capped at 128**, registration revenue **decays to ~0 at full slots** (only relegation churn
remains). **The buyback is structurally front-loaded and decays to zero while emissions still flow.** There
is no recurring, product-side demand sink.

**Fix:** add a **recurring, activity-linked revenue line** — slot *rent* (pay to stay, not just enter) and/or
**a few bps on the payment volume** flowing through registered canisters (pairs with F2). That's the
exogenous anchor the design lacks. NNS-steering value is bounded by locked ICP, not token supply — say so.

## F4 [HIGH] — Sell pressure structurally exceeds buyback → death-spiral

128 apps receive daily emissions and are **forced sellers** (their costs are cycles/ICP, their league
income is token — they must convert to pay bills). Buyback is the decaying registration revenue of F3.
Emissions are continuous + large (the point); buyback is small + shrinking. Steady state needs daily
speculative/governance demand `D ≥ E×price` with no product demand to supply it → price falls until the
emission (the whole reward) is worthless → apps relegate themselves → spiral. This is exactly Bittensor's
"~$15M revenue vs ~$328M printed/yr" critique, **without** dTAO's per-subnet markets to absorb inflow.
(Listed as "D5, 1 of 5" in the draft — it's existential.)

**Fix:** fund buyback from **recurring activity revenue** (F3) so it scales with the network; **size
emissions to plausible revenue, not to a 21M vanity number** (a cap doesn't require fast emission); locks
delay sell pressure but don't create demand — don't oversell them.

## F5 [HIGH] — Opt-in + self-selected canister set measures almost nothing

Participation *and* the canister set are self-selected, so the ranked number is **strategically chosen**,
making cross-app comparison meaningless. App B registers only its burn-hungry canister (or a dedicated burn
canister) → outranks honest App A while being a smaller business; no penalty (no reverse index to audit
against); a rival can under-register to deny relative rank or grief the auction. The league ranks
**willingness to expose/manufacture burn**, not real footprint.

**Fix:** change the unit from "app" to "registered canister(s) / declared commitment" (honest); the
payment-volume metric (F2) is far harder to manufacture and largely fixes this too. Don't promise
"all-or-none registration" — unenforceable.

## F6 [HIGH] — Capital beats merit; "reward builders" → "reward whoever burns most"

The 128 cap limits *how many* play but not *spend-to-win within a slot*. Reward ∝ burn share means a
VC-funded mediocre app outburns a brilliant bootstrapped one indefinitely. The escalating *registration*
burn is a one-time entry cost trivial for a whale; the *daily* competition is unbounded. This is the
opposite of "reward builders" — it rewards balance-sheet size.

**Fix:** **concave reward** (∝ √burn or log) so doubling spend doesn't double reward; **hard per-app share
cap** (e.g. ≤4% of daily emission); combine with the usage metric so merit enters. Else drop "reward
builders."

## F7 [MEDIUM — honesty] — "Support ICP price" is conceded-impossible; drop the goal

The docs already call the ICP→cycles burn "negligible / a rounding error / not a price lever," yet "support
ICP price growth long-term" is a stated top-line goal. Reframe to the true, alignment-flavored version:
"every cycle of league activity converts ICP into compute, contributing to ICP's deflationary sink, however
small" — **no price claim**. Never write "support price" (see F8).

## F8 [HIGH — legal flag, not legal advice] — Strong securities-like characteristics

The design lights up Howey-style factors at once: **investment of money** (apps burn ICP to join),
**common enterprise** (shared treasury/SNS/buyback), **expectation of profit** (appreciation + capped-21M
scarcity + **a buyback that "supports price"**), **from the efforts of others** (team runs ranking/buyback/
emission/steered-neuron pre-decentralization). The **buyback-supports-price + appreciation + pay-to-join**
trio is the riskiest combination, and the SNS swap is itself a public token sale. Counsel categories:
securities (Howey / MiCA classification / your jurisdiction), money-transmission (operating a buyback
market), and the swap as a public offering. **Fix:** remove all price-support/appreciation language before
any public doc or swap; frame buyback strictly as treasury/sink mechanics; consider non-transferable
locked utility points pre-decentralization to delay the "investment contract" trigger; get counsel on the
swap specifically.

## Bottom line — broken as specified, marginal if rebuilt

Three of the four stated goals are internally contradictory with the mechanism: "reward builders" vs a
metric that rewards waste/capital (F2, F6); "valuable/appreciating token" vs the anti-farm guard (F1);
"support ICP price" conceded-impossible (F7). And the value loop has **no exogenous anchor** (F3) with
**structural net sell pressure** (F4).

**Minimal viable version that holds together:**
1. **Metric → payment/transaction volume through registered canisters** (objective, costly-to-fake,
   value-correlated); raw burn becomes a liveness floor. *(fixes F1/F2/F5/F6)*
2. **Recurring, activity-linked revenue** (slot rent + bps on observed volume) so buyback scales with the
   network. *(fixes F3/F4)*
3. **Size emissions to revenue**, with a **per-app share cap** + **concave reward curve** — not to the 21M
   vanity number. *(fixes F4/F6)*
4. **Prototype as non-transferable points / plain ICRC-1, no price claims**; defer SNS + any
   appreciation/buyback-price language until counsel clears it and demand is proven. *(fixes F7/F8)*
5. **Honest copy:** "a league ranking the most economically active apps on ICP, with a governance token and
   an ICP sink" — drop "reward builders for burning," "support ICP price," "vote on the NNS."

**Survives intact:** 128-slot scarcity, escalating entry burn, immunity/relegation, EMA smoothing, the
steered-community-neuron model, and the opt-in observer measurement (with the "lower bound" caveat). The
**metric** and the **value loop** are what's broken.

**Reprioritization (important):** the draft's "single biggest risk" points at *measurement* (D1). The
bigger risk is the *economic loop* (F1–F4). Measurement honesty is a caveat; the economics is existential.
