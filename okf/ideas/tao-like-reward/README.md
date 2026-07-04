---
type: idea
title: "Tao-Like Reward — Feasibility Study"
tags: [ideas, tao-like-reward]
timestamp: 2026-06-16T10:12:10-04:00
---

# Tao-Like Reward — Feasibility Study

> **Status:** Idea / feasibility research. **No implementation tasks** (by request).
> **Date:** 2026-06-16. Produced via a 4-agent research fan-out (Bittensor model · ICP cycle-burn
> measurement · SNS token/tokenomics/buyback · codebase reuse) + an adversarial review.
> **Deliverables:** [`01-high-level.md`](./01-high-level.md) (how it works) and
> [`02-technical.md`](./02-technical.md) (technical design). Supporting:
> [`03-research-notes.md`](./03-research-notes.md) (citations), [`04-adversarial-review.md`](./04-adversarial-review.md).

## The idea (as asked)

A Bittensor/TAO-inspired reward network on ICP: **128 apps register as "syndicate apps"** (subnets); we
**monitor their cycle-burn rate across all their canisters**; apps are **ranked daily** and **earn a share
of a new app token**. The token is used for **SNS governance**, can **vote on-site on ICP/NNS proposals**,
and is **capped at 21,000,000**. The token isn't burned, but a **"buy back the token, then buy ICP and
burn it"** mechanism supports ICP price long-term. Goal: **create a new crypto, reward builders, and offer
governance opportunity to supporters.**

## Executive feasibility verdict

The macro design is sound and strongly ICP-native — cycle burn is an **objective, hard-to-fake** ranking
axis, which lets this avoid Bittensor's worst problems (the 41% validator-verification tax, weight-copying,
validator cartels). **But three of the literal requirements don't hold as stated and must be reframed.**
Each is feasible in a corrected form:

| Requirement | Verdict | Reframe (what's actually buildable) |
|---|---|---|
| "Monitor their cycle burn across all canisters" | ⚠️ **Not trustlessly possible** | Cycle balance is **controller-only**; no per-canister public metric; no way to enumerate an app's canisters. → Apps **opt in**: register canister IDs + add an **immutable read-only "blackhole" observer** controller; rank by **top-up-adjusted balance-delta sampling**. "Verifiable for *cooperating* apps." (Crux — [`02` §2](./02-technical.md).) |
| "128 apps as subnets, ranked daily, earn a share" | ✅ **Feasible** | Mirror Bittensor: 128 fixed slots, **escalating burn-to-enter**, **immunity period**, **EMA-based relegation** of the worst, daily emission **∝ smoothed cycle-burn share**, **zero-floor** for dead apps. |
| "New token, capped 21M, daily emission" | ✅ **Feasible, redesigned** | **Pre-mint 21M at genesis → release from a treasury/distribution canister on your own halving schedule.** Do **not** use native SNS voting-reward minting (it inflates supply + rewards stakers, not builders). |
| "Used for SNS governance" | ✅ **Feasible, standard** | Launch an SNS (1 `CreateServiceNervousSystem` proposal; ~25 ICP rejection risk, no fixed fee). |
| "Vote on-site on ICP/NNS proposals with the token" | ⚠️ **Not literally possible** | An SNS token **cannot** vote on the NNS. → A **token-weighted in-canister tally steers a canister-controlled NNS neuron's** single vote (the project's existing burn-to-influence model; WaterNeuron proves it's production-viable). Influence is bounded by the **ICP** the project stakes, not token supply. ([`02` §5](./02-technical.md).) |
| "Buy back token → buy ICP → burn ICP; support ICP price" | ✅ **Feasible & precedented** (Gold DAO) | The canonical ICP "burn" is **ICP → cycles via the CMC** (deflationary *and* useful). ICP-price support is **real but negligible in magnitude** — treat as alignment/narrative, not a price lever. ([`02` §6](./02-technical.md).) |

**Bottom line:** Build it as an **opt-in, cooperating-apps** cycle-burn league that emits a **pre-minted,
capped, halving** token; the token governs an SNS and **steers a canister-controlled NNS neuron**; protocol
revenue funds **buyback-of-token + ICP→cycles burn**. Honest copy throughout ("verifiable for participating
apps," "steer our community neuron," "modest ICP deflation").

## How it serves the three goals (after economic review)

- **Create a new crypto** ✅ — a real SNS token, capped 21M, genuine sink. But the value loop needs an
  **exogenous, recurring revenue anchor** (F3) or it can't sustain its own buyback.
- **Reward builders** ⚠️ — **as specified, it rewards *spend* and *capital*, not builders** (F2/F6): cycle
  burn favors waste over efficiency and whales over bootstrappers. Only the *rebuilt* metric (reward
  **usage/payment volume**, not burn) honestly "rewards builders."
- **Governance for supporters** ✅ — SNS governance is real; "voting on ICP proposals" is real *as steering
  the community neuron* (not direct NNS voting). ⚠️ but the governance/control value is exactly what breaks
  the anti-farm guard (F1) and raises securities flags (F8).
- **Support ICP price** ❌ — **conceded-impossible** (F7); the ICP→cycles burn is a rounding error. Drop
  this goal; reframe as alignment/sink only, and remove all "price support" language (F8 legal risk).

## Key decisions to make (no recommendation locked — this is research)

- **D1 — Burn measurement trust model:** blackhole-observer + registration (most trustless, needs app
  cooperation) vs. self-report+stake (weak) vs. cycles-ledger-routed top-ups (proxy). Recommend the
  blackhole-observer core. ([`02` §2](./02-technical.md).)
- **D2 — Is "cycle burn" the right axis at all?** It rewards *spending cycles*, which is gameable by
  burn-to-farm and rewards waste, not value. Consider net-of-top-up, rewards-capped-below-burn, and
  whether "useful work" (calls served, users) should weight it. ([`04`](./04-adversarial-review.md).)
- **D3 — SNS now or later?** An SNS is a one-way decentralization handover. Could prototype the league +
  a plain ICRC-1 token first, launch the SNS once proven.
- **D4 — Emission→revenue transition:** the 21M halving curve decays; plan to fund builder rewards from
  revenue/treasury before emissions dwindle, or the incentive evaporates.
- **D5 — Sell-pressure management:** 128 apps receiving daily tokens = persistent sell pressure; pair with
  staking/lock incentives.

## ⚠️ Adversarial economic review verdict: BROKEN as specified, marginal if rebuilt

A mechanism-design red-team ([`04-adversarial-review.md`](./04-adversarial-review.md)) found the **economic
loop — not the measurement — is the existential risk**, and three of the four stated goals contradict the
mechanism:

- **F1 (Critical):** the anti-farm guard (`rewards < cost burned`) is **mathematically wrong** — it
  collapses once token appreciation or governance-control value enters (which the token is designed to
  have). You can't be farm-proof while claiming the token appreciates.
- **F2 (Critical):** ranking by **cycle burn rewards waste**, not value — it incentivizes *more* wasteful
  compute on ICP, the opposite of the mission. "Objective+unfakeable" and "measures value" are in tension.
- **F3/F4 (Critical/High):** the value loop is **circular with no exogenous anchor** (registration revenue
  decays to ~0 at full slots), and 128 apps are **forced sellers** → structural net sell pressure →
  **death-spiral** unless buyback is funded by recurring activity revenue.
- **F6 (High):** reward ∝ burn → **capital beats merit** (whales outburn real builders) — contradicts
  "reward builders."
- **F7 (Honesty):** "support ICP price" is **conceded-impossible** (the ICP→cycles burn is a rounding
  error) — drop the goal; reframe as alignment only.
- **F8 (Legal flag):** **pay-to-join + capped supply + buyback-supports-price + appreciation** lights up
  multiple securities-like (Howey) factors — get counsel before any public doc/swap; remove price-support
  language.

**Minimal viable rebuild** (what actually holds together): (1) change the metric from raw cycle burn to
**payment/transaction volume through registered canisters** (objective, costly-to-fake, value-correlated;
burn becomes a liveness floor); (2) add **recurring activity-linked revenue** (slot rent + bps on volume)
so buyback scales; (3) **size emissions to revenue** with a per-app cap + concave curve, not the 21M vanity
number; (4) prototype as **non-transferable points / plain ICRC-1 with no price claims**, defer SNS until
counsel clears it; (5) honest copy. **Survives intact:** 128-slot scarcity, escalating entry burn,
immunity/relegation, EMA smoothing, the steered-community-neuron model, opt-in observer measurement.

## Single biggest risk (corrected)

Not the measurement — the **economics**. The measurement crux (D1) makes the league *opt-in and a lower
bound*; the **economic crux (F1–F4)** is what determines whether the thing can exist at all: the metric
rewards the wrong behavior, the anti-farm guard fails, and the value loop has no exogenous demand. Fix the
**metric** (reward usage/volume, not burn) and the **revenue model** (recurring, activity-linked) first —
everything else (SNS, token, neuron-steering, buyback-burn) is feasible and precedented.
