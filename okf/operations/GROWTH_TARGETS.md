---
type: playbook
title: "Growth Targets — $50k/Year at $20 ICP"
tags: [operations]
timestamp: 2026-06-13T22:37:20-04:00
---

# Growth Targets — $50k/Year at $20 ICP

Companion to `ECONOMICS_PLAYBOOK.md`. The playbook explains *how money flows*;
this doc sets the *numeric goals* derived from the owner's constraints, and
flags where today's hardcoded constants conflict with those constraints.

**Last updated:** June 2026. APY figures are post-Mission 70
(6-month ≈ 2.6%, 1-year ≈ 3.5%, 2-year ≈ 7–7.8%, 2-year + max age bonus ≈ 8.75%).

---

## 1. The Constraints

| Constraint | Value |
|---|---|
| Owner income goal | **$50,000/year at $20/ICP ⇒ 2,500 ICP/year (~208 ICP/month)** |
| …of which from the Early Adopters neuron | ~2/3 ⇒ **~1,667 ICP/year (~139/month)** |
| …of which from everything else (burns, fees, listings) | ~1/3 ⇒ **~833 ICP/year (~70/month, ~16/week)** |
| User return target | **~6%/year on ICP held in the app** |
| Maximum charge per vote | **≤ 2 ICP per commitment** |
| Lottery | Self-sustaining after the one-time **50 ICP seed**; minimum pot **25 ICP** (lowered from 50 — `LOTTERY_MIN_POT_E8S = 2_500_000_000`) |

Everything below is denominated in ICP — the plan holds at any USD price; $20
only matters for translating 2,500 ICP into $50k.

---

## 2. North-Star Targets (the answer, up front)

| Metric | Target | Why (section) |
|---|---|---|
| **Monthly active users** | **~500 MAU** (≈350 financially active) | §7 |
| **Votes cast per week** | **~20 commitments/week** (avg 1.75 ICP each, 2 ICP cap) | §4 |
| **Early Adopters neuron stake** | **70,000 ICP** | §3 |
| **Lossless staking TVL** | **12,000 ICP — deliberately NOT equal: 2,000 / 3,000 / 7,000** (6mo / 1y / 2y) | §5 |
| **Lottery** | Self-sustaining at that TVL: pot refills ≥ 25 ICP in < 1 month, ~monthly winners, ~20–25 ICP prizes | §6 |

**Note (see §8):** the staking-yield split shipped at **50/50** lottery/treasury
(the 80/20 rebalance was proposed but NOT shipped) — the numbers below assume
the live 50/50 split.

---

## 3. Early Adopters Neuron — 70,000 ICP

The EA neuron is the platform's annuity: a permanent 2-year non-dissolving
neuron whose age bonus matures over ~4 years (7.5% → 8.75% APY).

The owner's take and the members' 6% must both come out of the same gross
yield, so the spread defines the required size:

```
member_return = APY − (annual_treasury_cut / EA_stake)  ≥ 6%
⇒ EA_stake ≥ annual_treasury_cut / (APY − 6%)
```

With a **revised treasury cut of 150 ICP/month (1,800 ICP/year — covers the
1,667 target with margin)**:

| APY | EA stake needed for members ≥ 6% | Monthly yield | Owner gets | Members get |
|---|---|---|---|---|
| 7.5% (year 1) | 120,000 ICP | 750 | 150/mo | 7,200/yr = 6.0% |
| **8.75% (mature age bonus)** | **65,500 ICP** | 477 | 150/mo | 3,930/yr = 6.0% |

**Goal: 70,000 ICP staked.** At mature rates that pays the owner 1,800
ICP/year and members **6.2%**; in year 1 (7.5%) members see ~4.9% and grow
into 6%+ as the age bonus accrues — disclose that ramp honestly on the page.

Members needed: at a 350 ICP average seat, **~200 early adopters**. The
membership-close latch now sits at 600 ICP/month — reachable at ~85–95k ICP
staked, i.e. shortly past the goal, which keeps the scarcity pitch honest.

**Why the old constants had to change:** the original bands (restake <500,
first 1,000/month to treasury) were sized for a ~150k-ICP neuron. At the 70k
goal (~500/month yield) every month would have landed entirely in the
treasury band — owner income 6,000+ ICP/year (2.4× the whole goal from one
stream) and members earning exactly 0%, forever. Nobody rational stakes
permanently for 0%; the program could never have attracted the 70k.

---

## 4. Votes — 20 Commitments/Week at ≤ 2 ICP

Non-EA income target: ~833 ICP/year ≈ 70/month ≈ **16 ICP/week to treasury**.

Burn votes are the dependable stream. Treasury receives 50% of settled burns
(25% when pool neurons are active on the proposal — assume a mix):

```
20 votes/week × 1.75 ICP avg × ~45% effective treasury share ≈ 16 ICP/week ✓
```

- **Keep `default_threshold` at 2 ICP** so a single committed voter can carry
  a proposal — consistent with the 2 ICP per-vote ceiling (never raise the
  per-user ask; raise *participation* instead).
- 20 votes/week ≈ 3/day. At ~2 votes per active voter per month, that's
  **~43 voting users** active in any month.
- Everything else (explorer listings at $1/day = 0.05 ICP, idea-board fees and
  75% upvote shares, arcade $1 customizations, occasional 125 ICP pool
  registrations at 62.5 to treasury) is margin on top — budget it as buffer,
  not base. One pool registration covers nearly a month of the non-EA target
  by itself.

Total owner income at target: 1,800 (EA) + ~910 (burns) + buffer ≈
**2,700–2,900 ICP/year** — comfortably over 2,500 with room for refunded
proposals and pool-active splits.

---

## 5. Lossless Staking — 12,000 ICP, Skewed Long

**Goal: 2,000 / 3,000 / 7,000 ICP (6mo / 1y / 2y). Deliberately unequal.**

Equal thirds would be the wrong goal: post-Mission 70, the 6-month tier earns
2.6% — it exists as an on-ramp, not a yield engine. The 2-year tier (7.8%)
must hold the majority of TVL for both the lottery and user returns to work:

| Tier | Goal | APY | Yield/year |
|---|---|---|---|
| 6 months | 2,000 ICP | 2.6% | 52 |
| 1 year | 3,000 ICP | 3.5% | 105 |
| 2 years | 7,000 ICP | 7.8% | 546 |
| **Total** | **12,000 ICP** | blended 5.9% | **~703 ICP/year (~59/month)** |

User return math (with the live **50/50 lottery/treasury split**, and
ticket weights of 1×/2×/4× per ICP making the lottery EV stake- and
term-proportional):

- 2-year stakers: ~78% of the ticket pool → EV ≈ **3.1%/year**
- 1-year stakers: ≈ 1.6% — 6-month: ≈ 0.8%. The ladder is the pitch:
  *maximum commitment earns the most; short terms are the trial tier.*
  (A future 80/20 rebalance — see §8, not shipped — would roughly double these.)

At ~75 ICP average stake, 12,000 ICP TVL ≈ **160 stakers**.

---

## 6. Lottery Self-Sufficiency (50 ICP Seed, 25 ICP Minimum)

Pot inflow at the §5 TVL = 50% × 703/year ≈ **29 ICP/month** (a future 80/20
rebalance — §8, not shipped — would lift this to ≈47/month and stakers toward 6%).

- **Day 1:** the 50 ICP seed already clears the 25 ICP minimum — draws are
  live immediately. First win pays out 80% (≈40 ICP), leaving ~10 + rollover.
- **Steady state:** the pot refills past 25 ICP in **under a month** even
  right after a win, so the 1-in-13 dynamic odds run uninterrupted —
  ~one winner a month, ~96% chance of at least one per quarter, prizes in the
  20–40 ICP range.
- **Self-sufficiency condition:** monthly inflow ≥ ~20 ICP, i.e. staking TVL
  ≥ ~13,000 ICP under the live 50/50 split (≥ ~8,000 ICP if 80/20 is ever
  shipped). The §5 goal (12,000 ICP) is in range. Below that TVL the pot gate simply slows the cadence — the
  lottery never goes insolvent by construction; it just draws less often.

No further treasury top-ups ("sweeten the pot") are required after the seed.

---

## 7. Monthly Active Users — ~500

Bottom-up from the financial targets, with realistic overlap:

| Cohort | Count | Drives |
|---|---|---|
| Voting users (~2 votes/month each) | ~45 | 20 votes/week → burn revenue |
| Lossless stakers (avg ~75 ICP) | ~160 | 12,000 TVL → lottery + 6% ladder |
| Early adopters (avg ~350 ICP) | ~200 | 70,000 EA stake → owner income |
| Non-financial regulars (arcade, explorer, R&D browsing) | ~100–150 | conversion funnel |

Cohorts overlap (EA members usually stake and vote too). Net goal:
**~500 MAU, of whom ~350 hold ICP in the app.** Total user-held TVL ≈ 82,000
ICP earning a blended ~6% — i.e. the app pays users ~4,900 ICP/year while the
owner draws 2,500: a 2:1 user-to-owner split, which is the durable ratio to
advertise.

Milestones:

| Phase | MAU | EA stake | Staking TVL | Votes/wk | Owner run-rate |
|---|---|---|---|---|---|
| A — now → 3 mo | 50 | 2,000 | 1,500 | 5 | ~150 ICP/yr |
| B — 3 → 9 mo | 150 | 15,000 | 5,000 | 10 | ~700 ICP/yr |
| C — 9 → 18 mo | 350 | 40,000 | 9,000 | 15 | ~1,600 ICP/yr |
| **D — target** | **500** | **70,000** | **12,000** | **20** | **~2,700 ICP/yr** |

---

## 8. Required Changes for the Plan to Be Internally Consistent

Already done (June 2026):
- ✅ `LOTTERY_MIN_POT_E8S` lowered to **25 ICP** (`2_500_000_000`).
- ✅ Dynamic lottery odds (1-in-13 per drawing) + stake-weighted tickets.
- ✅ Whole-ICP staking; treasury-fronted fees (zero-haircut unstake/restake).

Constant changes (June 2026):

1. ✅ **EA bands recalibrated**: restake-below 500 → **50**, treasury cut
   1,000 → **150** (capped — overflow goes to members), membership-close
   2,000 → **600** ICP/month.
2. ⬜ **Staking-yield split 50/50 → 80/20 (lottery/treasury)** — PROPOSED, NOT
   SHIPPED. The code still splits **50/50** (`settle_yield_split`). Shipping it
   would lift 2-year stakers from ~3.1% to ~6.2% at the cost of ~140 ICP/year
   of treasury.

Operational settings (runtime, no upgrade):
- `admin_set_default_threshold(200_000_000)` — hold at 2 ICP (the per-vote cap).
- `admin_set_lottery_config(Some(5))` — base 5 tickets/ICP/day is right; the
  tier multipliers and stake-weighting do the differentiation.
- Keep ≥ 20 ICP in the treasury at all times (cycle top-up floor — see
  playbook Risk #1).

---

## 9. What to Watch (monthly)

- **EA stake vs milestone curve** — the single biggest lever on owner income.
- **Votes/week** — if it stalls under 10 for a month, the burn leg misses;
  push proposal curation before considering price changes (the 2 ICP cap is a
  product promise, not a dial).
- **2-year tier share of staking TVL** — below ~50%, advertised staker
  returns sag; promote the term ladder.
- **Lottery pot refill time** — should stay under one month; if it stretches,
  staking TVL has slipped.
