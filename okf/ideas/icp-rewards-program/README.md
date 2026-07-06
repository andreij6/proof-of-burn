---
type: idea
title: "The Rewards Program of ICP — product thesis & roadmap"
description: "North-star repositioning (owner, 2026-07-05): Cycle Burn is the loyalty program for the ICP blockchain — commitment (staking) unlocks it, using and building ICP dapps earns it, the lossless lottery pays it, and every loop burns cycles."
tags: [ideas, icp-rewards-program, strategy]
timestamp: 2026-07-05T00:00:00Z
---

# The Rewards Program of ICP

**Owner's north star (2026-07-05):** this app is the *rewards program of the
ICP blockchain* — it incentivizes commitment to ICP by rewarding people for
USING and BUILDING ICP dapps.

## Why the pieces already fit

The app has quietly become a **generalized verification-to-tickets engine**:

| Loyalty-program concept | What already exists |
|---|---|
| Membership = commitment | The stakers-only ticket gate: locking ICP into a neuron IS the commitment to the chain, and it's already the key to every reward |
| Points currency | Lottery tickets — lossless, yield-funded, source-tagged (the breakdown card is literally a points statement) |
| Earn categories | Neuron staking (5-20/ICP/day), skill games (dailies + winner sweeps), Solana LP (chain fusion), ICPSwap LP custody (40/day per $1, valued live) |
| Verification rails (the moat) | Ed25519 wallet-signature proofs, SOL RPC chain-fusion reads, native inter-canister reads, position-NFT custody with live valuation, round/day-keyed grants, reserve-first anti-sniping |
| Redemption | The lossless lottery — tickets → ICP jackpots, house burns instead of raking |
| Brand | "Cycle Burn": every reward loop routes value into cycles burn — rewarding commitment is *literally deflationary for ICP* |

## The two earn pillars to build out

### Pillar 1 — USING ICP dapps ("earn cards")

Each integration is a repeat of a proven pattern: verify the activity
trustlessly → grant tickets daily/per-round → tag the source.

- **Liquidium borrow/supply** (scoped in conversation 2026-07-05): embed
  their accountless instant-loan SDK so attribution is native — loans
  created in our UI are ours to reward; "paste your loan ref" (bearer ref,
  one-ref-one-account) retrofits existing users.
- **More DEX LPs**: the ICPSwap custody machinery generalizes to any pool;
  Sonic/KongSwap variants are candid-mirroring exercises.
- **NNS participation**: Neuron Syndicate already verifies neuron hotkeys —
  reward verified NNS voting streaks (governance participation = the
  purest "commitment to ICP").
- **The Dapp Explorer becomes the earn directory**: listed dapps can
  SPONSOR earn campaigns — they pay ICP (pot + burn), their users earn
  tickets for verified usage. This is the monetization: dapps buy user
  acquisition through the rewards program, the pot grows, ICP burns.
- **Onboarding rail**: the Fast Lane (built) is the conversion mouth of the
  funnel; chain-fusion funding (BTC/SOL deposits) is its next upgrade.

### Pillar 2 — BUILDING ICP dapps ("builder rewards")

The under-served side, and the most on-thesis: builders burn cycles.

- **Trustless builder proof exists**: a builder's controller identity can
  CALL our canister directly (dfx identities sign update calls), and the
  public `canister_info` endpoint lists a canister's controllers + its
  module-change history. `link_builder_canister(canister_id)`: caller must
  appear in the canister's controllers → proven, no signatures needed.
- **Reward shipping, not squatting**: canister_info's change history shows
  module hash changes — "shipped code this month" is verifiable. Tickets
  for active canisters; multipliers for cycles top-ups routed through us
  (measurable — we do the CMC leg).
- Lesson from okf/ideas/tao-like-reward: raw cycle BURN is not trustlessly
  measurable (opt-in blackhole only) — reward verifiable PROXIES (module
  changes, controller-proven activity, top-ups through our rail) instead.

## The systemic gate (name it once, solve it once)

**Internet Identity issues a different principal per dapp** — the recurring
enemy of every "verify their activity elsewhere" integration. The
program-level answer is a single **Link & Earn hub**: one page where a user
binds all their identities to their Cycle Burn account — Solana wallet
(built), ICPSwap custody (built, transfer-is-proof), Liquidium refs
(planned), builder/controller identities (direct-call proof), BTC/ETH
wallets (signature proofs, addable), Plug/Oisy global principals (login
support). Every future earn card plugs into the same registry.

## Sequencing (recommended)

1. **Say it out loud**: reposition landing/nav copy around "the rewards
   program of ICP" (the Stake/Play "4 Tickets" groups already read this way).
2. **Liquidium earn card** (embedded borrow + daily grant) — first partner
   integration, proves the earn-card template end to end.
3. **Builder rewards v1** (controller proof + module-change grants) — the
   "building" pillar's beachhead, cheap and unique.
4. **Explorer → sponsored earn campaigns** — turns the directory into the
   revenue engine that funds the pot.
5. **Link & Earn hub** — consolidate as the third integration lands.

## Risks

- Ticket inflation: every new source dilutes existing earners — publish the
  source breakdown prominently (done) and keep formulas value-scaled.
- Partner dependence: earn cards die when partners change interfaces —
  mirror candid from source, mock seams, per-card kill flags (house style).
- Sybil economics: keep every reward either capital-scaled (USD-valued) or
  action-cost-backed; the staking gate stays non-negotiable.
