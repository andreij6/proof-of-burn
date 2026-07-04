---
type: idea
title: "Tao-Like Reward — Technical Design"
tags: [ideas, tao-like-reward]
timestamp: 2026-06-16T10:12:10-04:00
---

# Tao-Like Reward — Technical Design

> Technical-level design. Citations in [`03-research-notes.md`](./03-research-notes.md); feasibility
> verdicts in the [README](./README.md). **No implementation tasks** (by request) — this is the "how it
> would be built" architecture, not a work plan.

## 0. Component map

| Component | What | New / reuse |
|---|---|---|
| **Syndicate registry** | the 128-slot app registry + canister IDs | build-new; extend the Dapp Explorer pattern (`DappListing`, `DAPPS`, `submit_dapp` — lib.rs ~9201/9271/10174). DappListing stores only a `url`, not canister IDs → needs a `canister_ids` field / parallel struct. |
| **Observer canister** | immutable read-only "blackhole" that apps add as controller | build-new (ic-blackhole pattern) |
| **Burn sampler** | daily `canister_status` reads → top-up-adjusted deltas | build-new; reuses the controller-read primitive (`admin_get_frontend_cycles` → `canister_status`, lib.rs ~3432) and the timer (`setup_timers` ~4612) |
| **Ranking engine** | EMA per app, daily rank, relegation | build-new; distribution cadence precedent = lottery/staking sweep (lib.rs ~8485 / ~7602) |
| **Token + distribution** | SNS ICRC-1 token; pre-mint 21M; halving release | build-new (SNS is net-new — no in-app token today) |
| **Community NNS neuron + tally** | token-weighted tally steers a canister-controlled neuron | reuse pool-neuron + `call_manage_neuron`/`cast_nns_vote` (lib.rs ~6730/3968) + commit-tally model (~2987) |
| **Buyback-burn** | DEX buy token + CMC ICP→cycles | reuse CMC path (`call_cmc_topup_transfer`/`notify_cmc_topup` ~2229); DEX integration is net-new (no HTTPS-outcall/DEX infra today) |

Free MemoryIds (grep-confirmed): **26–33, 53–59, 73, 76, 88–89, 94–95, 97–127**. A contiguous block (e.g.
26–33) covers the syndicate maps.

## 1. The hard problem first: there is no trustless cross-app burn measurement

A canister's cycle balance is **controller-only private data**:
- `canister_status` (management canister) returns `cycles` + `idle_cycles_burned_per_day` but is
  **controller-only** (a non-controller call is rejected). This is deliberate — a low balance reveals
  freezing-proximity, an attack surface.
- `canister_info` is callable more broadly but returns **no cycles** (only module_hash/controllers/history).
- There is **no "total cycles burned" counter** anywhere, and **no per-canister public metric** (the public
  dashboard/metrics-api only goes down to *subnet* granularity).
- There is **no protocol way to enumerate "all canisters owned by principal X"** — no reverse index.

**Consequence:** "we monitor their cycle burn across all their canisters" is **impossible without the app's
cooperation**. The design must be **opt-in**.

## 2. Burn measurement — the opt-in observer model (the crux)

**Registration with proof-of-control + observer:**
1. App owner registers their **canister IDs** with the league and adds an **immutable, read-only "blackhole"
   observer canister** as a *controller* of each (the ic-blackhole pattern: the observer can read
   `canister_status` but cannot stop/upgrade/delete — so apps grant visibility without ceding control).
2. The league verifies control via `canister_info.controllers` (it *does* return controllers) — confirm the
   observer (or the registrant) is a controller before counting a canister.

**Sampling burn (no burn counter exists → derive it):**
- On a daily timer, read each registered canister's `cycles` via the observer.
- `burn(t0→t1) ≈ (cycles[t0] − cycles[t1]) + top_ups_in_interval − cycle_transfers_received + cycles_sent_out`.
- **Top-ups are the main distortion** (anyone can top up any canister). Require apps to fund **through an
  observable path** — the **cycles ledger** (ICRC-3 mint/burn blocks encode the target canister in the memo)
  or observed CMC `notify_top_up` — so top-ups can be subtracted. Otherwise the delta is unreliable.
- `idle_cycles_burned_per_day` is **idle-only** (excludes execution burn) — usable as a sanity floor, not as
  the metric.
- Smooth with an **EMA** so a single top-up/spike can't swing a slot.

**Unavoidable caveats (state them in product copy):**
- Apps can run **unregistered** canisters → the ranking is "burn among registered canisters," a lower bound.
- Granting visibility **leaks freezing-proximity** — a real disincentive that may suppress participation.
- The metric is **"trustless for cooperating apps,"** not against an adversary who under/over-registers.

**Alternatives considered (weaker):** bare self-report (trivially gamed — no on-chain truth to slash
against); public-dashboard oracle (no per-app data — can only normalize against subnet totals);
cycles-ledger top-ups as a *proxy* for burn (measures funding, not consumption; only binds if apps fund
solely through it). → The observer model is the only one that yields ground-truth, and only for opt-in apps.

## 3. Ranking, slots, relegation

- **128 fixed slots.** Registration costs an **escalating burn** (doubles with recent registrations, decays
  over time) — uneconomic to spam, demand-responsive. The burn itself can be ICP→cycles (an ICP sink that
  reinforces the buyback-burn narrative).
- **Immunity period** (~weeks–months) for newcomers before they can be relegated.
- **Daily EMA rank** by top-up-adjusted cycle burn. **Zero-floor:** apps below a minimum burn earn nothing
  (Bittensor clips negative-flow subnets to zero) so dead apps don't drain the pool.
- **Relegation:** when 128 slots are full and a new app registers, drop the **lowest-EMA non-immune** app.
- The **ranking metric is the relegation metric** — the bottom slot is always the least-active.

## 4. The token — pre-mint 21M, halving *release* (not native SNS minting)

**Why not native SNS minting:** the SNS governance canister *can* mint tokens, but (a) it mints **new
supply** as **voting rewards to stakers** — inflationary and aimed at the wrong recipients (stakers, not
builders), and (b) recent governance trends raise the bar on minting. So:

- **Mint the full 21,000,000 at genesis** in the `CreateServiceNervousSystem` proposal; allocate a large
  **emission treasury bucket** (plus dev/swap buckets).
- A **distribution canister** (pre-funded from / authorized over the emission bucket) releases the daily
  builder emission on **your own halving schedule** (milestone-based: halve when cumulative released hits
  supply milestones, so burns/locks stretch the curve — like Bittensor/Bitcoin).
- This decouples "capped 21M" from the SNS reward engine and lets emission go to **ranked apps**, not
  stakers.

**Emission split (daily):** `app_share_i = emission_today × (ema_burn_i / Σ ema_burn_j)` over apps above the
floor.

> **⚠️ Corrected by economic review ([`04` F1](./04-adversarial-review.md)):** the proposed anti-burn-to-farm
> invariant `Σ rewards (ICP) < Σ cycles burned (ICP)` is **insufficient** — it only holds if the farmer
> values the token at spot and sells immediately. Once **appreciation expectations** or **governance/control
> value** enter (which the token is designed to have), wasting cycles to farm tokens becomes profitable. The
> real guard would have to bound rewards below the *most optimistic participant's private valuation*, which
> is unobservable and contradicts the "this token is valuable" pitch. **Mitigations that actually work:**
> cap rewards in **absolute** terms (fixed pool sized so even at 10× price it can't exceed honest burn),
> add a **concave reward curve** + **per-app share cap** ([`04` F6](./04-adversarial-review.md)), and —
> most importantly — **reward usage/payment-volume rather than raw burn** ([`04` F2](./04-adversarial-review.md)),
> since burn is something a farmer can manufacture for free while real ICRC payment volume is not.

> **⚠️ Metric reframe (the central recommendation, [`04` F2/F3](./04-adversarial-review.md)):** raw cycle
> burn rewards *waste*, not value, and the value loop has no exogenous demand anchor. The minimal viable
> redesign ranks apps by **payment/transaction volume (ICRC flows) through their registered canisters** —
> objective, costly-to-fake, value-correlated — with raw burn demoted to a **liveness floor**, and adds a
> **recurring activity-linked revenue line** (slot rent + a few bps on observed volume) so the buyback
> scales with the network instead of decaying to zero. See [`04`](./04-adversarial-review.md) bottom line.

## 5. Governance + "voting on ICP proposals"

- **SNS governance:** standard. Launch via one `CreateServiceNervousSystem` NNS proposal (no fixed fee; ~25
  ICP rejection risk). Token-holders stake SNS neurons and vote on proposals controlling the league's dapp,
  treasury, parameters, and the emission/buyback canisters.
- **NNS voting — the constraint:** an SNS/app token **cannot vote on the NNS** (NNS voting power = ICP staked
  in NNS neurons only). The buildable model:
  1. The league holds a **canister-controlled NNS neuron** (ICP-staked; ≥10 ICP + ≥6-month delay to
     *submit*, any neuron to *vote*). This project already controls NNS neurons (`call_manage_neuron`,
     `gov_*`, pool neurons), and WaterNeuron proves canister-controlled neurons are production-viable.
  2. Token-holders cast an **in-canister tally** weighted by holdings/stake (mirrors the existing commit/
     burn-to-vote tally, lib.rs ~2987).
  3. The canister calls `manage_neuron` `RegisterVote` to cast the **neuron's single vote** per the tally
     (mirrors `cast_nns_vote`, lib.rs ~3968).
  - **Honesty:** the token *steers one ICP-funded neuron*; its NNS weight is bounded by the **ICP** locked,
    dissolve delay, and age — not by token supply. Copy must say "steer our community neuron," never "vote
    on the NNS with the token."

## 6. Buyback-and-burn-ICP

Revenue → two legs, both runnable as autonomous inter-canister calls from an SNS-root-controlled canister:
1. **Buy back the token** on **ICPSwap/KongSwap** (ICRC-2 approve+swap; KongSwap routes/aggregates). Use
   conservative slippage bounds, per-tx caps, and TWAP-style/randomized execution — AMM trades are
   front-runnable/sandwichable, and a new token's pools are thin (a real buyback moves price).
2. **Burn ICP = convert ICP → cycles via the CMC** (`call_cmc_topup_transfer` + `notify_cmc_topup`, reused
   from the existing burn-split plumbing, lib.rs ~2229). This is the protocol-native ICP sink — removes ICP
   from supply *and* produces cycles the league uses to run itself (strictly better than a black-hole burn).
   - **Note:** if revenue is already ICP, you don't "buy ICP" — collapse to *revenue → buy back token AND
     convert revenue-ICP → cycles*. The "buy ICP" leg only applies if revenue arrives as token/stablecoin.

**Precedent:** Gold DAO (GOLDAO) — fixed cap, automated buyback-and-burn from neuron ICP rewards + stablecoin
revenue. This design is the same pattern.

**Magnitude honesty:** ICP→cycles from one app is negligible vs ICP's supply/network burn — an alignment
signal and small structural ICP buyer, not a price lever. The token buyback is what affects the token price.

## 7. Sybil / gaming resistance

- **Burn-to-farm** (waste cycles to win tokens): the §4 invariant (rewards < cost burned) makes it
  unprofitable; also cap per-app share and net out top-ups.
- **Sybil slot capture:** 128 fixed slots + escalating registration burn make flooding identities
  uneconomic; influence is weighted by **real burned cost**, not identity count.
- **Under/over-registration:** an app could register only low-burn (or only high-burn) canisters → mitigate
  with proof-of-control on all registered canisters + spot audits + requiring funding through the observable
  path; accept the residual "lower-bound" caveat.
- **If any subjective scoring is ever added** (e.g. a quality vote on top of burn): use **commit-reveal**
  (hash then reveal) to stop weight-copying, and **κ-clipping + bonds** (Bittensor's Yuma defenses) so a
  minority cartel can't inflate favorites. The current design deliberately avoids subjective scoring by
  using cycle burn as the sole objective axis — keep it that way unless forced.

## 8. Architecture (canisters)

```
                ┌────────────────────────────────────────────────┐
   apps ───────▶│  Observer (blackhole, immutable, read-only)     │◀── added as controller of each app canister
                └───────────────┬────────────────────────────────┘
                                │ canister_status (cycles)
   ┌─────────────────────────────────────────────────────────────┐
   │  League canister (this app / its backend)                    │
   │   • Syndicate registry (128 slots, canister IDs, immunity)   │
   │   • Daily burn sampler + EMA ranking + relegation (timer)    │
   │   • Token distribution (from emission treasury, halving)     │
   │   • In-canister NNS-vote tally → manage_neuron               │
   │   • Buyback-burn driver (DEX swap + CMC ICP→cycles)          │
   └───────┬─────────────────────────┬───────────────┬───────────┘
           │                         │               │
      SNS (root/gov/ledger)   NNS neuron (ICP)   ICPSwap/KongSwap + CMC
   token + DAO governance     steered by tally    buyback + ICP→cycles burn
```

The SNS **root** should control the league/emission/buyback canisters so the loop is verifiably
DAO-governed, not key-controlled.

## 9. Open technical questions

- **Q1 — top-up accounting:** can apps be *required* to fund via the cycles ledger / a known CMC path so
  deltas are clean? If not, burn measurement is noisy. (Crux dependency.)
- **Q2 — observer trust:** is an immutable read-only observer enough for apps to accept, or will they refuse
  to add any external controller? Participation hinges on this.
- **Q3 — metric design:** raw cycle burn vs. net-of-top-up vs. value-weighted (calls/users). Raw burn
  rewards waste. (D2 in README.)
- **Q4 — DEX integration:** ICPSwap vs KongSwap, slippage/MEV guards, thin-liquidity sizing; needs net-new
  inter-canister/DEX code (no such infra today).
- **Q5 — SNS timing:** prototype with a plain ICRC-1 token + the league first, launch the SNS once proven?
  (One-way handover.)
- **Q6 — neuron weight:** how much ICP does the league lock to give its steered NNS neuron meaningful
  weight, and where does that ICP come from (treasury/swap)?
- **Q7 — emission→revenue transition:** the schedule to shift builder rewards from emission to revenue
  before the halving curve decays.
