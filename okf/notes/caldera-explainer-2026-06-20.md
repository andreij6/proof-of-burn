---
type: note
title: "Caldera — Research & Explainer Brief"
tags: [notes]
timestamp: 2026-06-21T09:31:53-04:00
---

# Caldera — Research & Explainer Brief

> Prepared 2026-06-20 for anyone explaining Caldera to a general audience (e.g. a
> podcaster, writer, or community caller). It's a plain-English review of the whole
> app: what it is, how each piece works, the economics, the tech, what's actually
> live, the honest caveats, and ready-to-use talking points.
>
> Source of truth: the deployed mainnet canister + the codebase as of this date. It
> covers **only features that are live in production** — anything built-but-off or
> still on the drawing board is left out on purpose. Numbers are pulled from the live
> constants, not marketing copy.

---

## 0. The 30-second version

**Caldera is a community-owned governance layer on the Internet Computer (ICP) where the act of participating permanently shrinks the ICP money supply.** Instead of locking up tokens for years to gain voting power, you *burn* a small amount of ICP to push a live NNS proposal toward "adopt" or "reject." A shared community neuron then votes the way the crowd's conviction points. Around that core sit a lossless lottery, a no-loss staking program, an ICP-paid rewards track for neuron holders, a community R&D board, a dapp directory, proposal discussions, and an AI "tweet farm" — and almost every one of them routes value into a burn or the community treasury.

The one-liner: **"Proof of Burn" — turn your conviction into NNS votes, and make every action measurably deflationary for ICP.**

- **Live app:** https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/
- **Runs:** 100% on-chain on the Internet Computer (no servers, non-custodial).
- **Backend canister:** `k7dn6-qiaaa-aaaap-qutha-cai` · **Frontend:** `kyclk-5qaaa-aaaap-quthq-cai`
- **Community leader neuron:** `17802688826615984104`

---

## 1. The thesis (why it exists)

Two problems Caldera is built to attack:

1. **Governance is captured by whales.** A handful of large neurons decide most NNS proposals. Ordinary holders either lock ICP for months/years to build a neuron, or stay voiceless.
2. **"Tokenomics" is usually talk.** Lots of projects *say* they help a token; few make it provable.

Caldera's answer fuses the two: **you don't buy or rent voting power — you burn ICP behind the stance you want.** When the community's combined burns clear a proposal's threshold, the shared "leader" neuron casts the winning vote, and the committed ICP is destroyed. So *steering governance* and *tightening ICP supply* become **the same action**. That's the "burn is the point" idea the whole product is organized around.

> **Soundbite:** *"Most DAOs ask you to lock your tokens. Caldera asks you to burn a little of them — and in return your conviction actually moves an NNS vote, while the token supply gets smaller."*

---

## 2. How the core loop works — burn voting

1. You browse **live NNS proposals** inside Caldera.
2. You **commit ICP** behind **Adopt** or **Reject**. There's **no fee** to commit (the treasury even fronts the ledger fees), and the minimum is **~$1** worth of ICP. Voting is **ICP-only** — other tokens aren't accepted for votes.
3. Your ICP sits in a **canister-controlled escrow** tied to you and that proposal. You can **add more** any time before the cutoff, but commitments are **final** — you can't pull them back. (Conviction has to cost something.)
4. At the proposal's deadline the canister tallies all commitments:
   - **Threshold met →** the leader neuron votes the heavier side (adopt vs reject), and your committed ICP is **spent**: **50% to the protocol treasury, 25% burned into backend-canister cycles, 25% burned into frontend-canister cycles.** The cycle portions permanently leave the ICP supply (ICP → cycles via the Cycles Minting Canister).
   - **Threshold missed →** no vote is cast and **100% of your commitment is returned** — exactly what you put in, no fees either way.

So you only ever burn when the community actually moves a vote. Otherwise you're made whole.

> **Soundbite:** *"You're not betting against other users — you're pooling conviction. If the crowd doesn't reach the bar, everyone gets their ICP back. If it does, the vote fires and the ICP is gone for good."*

---

## 3. The surrounding features (and how each one ties back to burn or community value)

### Neuron Syndicate — *earn ICP for aligning your neuron* (LIVE)
If you already hold an NNS neuron, set it to follow Caldera's leader neuron and verify it in the app. Verified members **earn a share of protocol value, paid in ICP**, with **nothing locked away** — your neuron keeps doing its own thing. This is how Caldera grows the leader's real voting weight: more aligned neurons → a bigger voice on every proposal.

### Lossless staking + the lottery that can't lose your money (LIVE)
- **Stake** ICP in a fixed term — **6 months, 1 year, or 2 years**. It's **lossless**: you withdraw *exactly* what you put in. Staking doesn't pay interest on your principal; instead it earns **daily lottery tickets**.
- **Ticket rate:** a base of **5 tickets/day**, multiplied by term — **6-month ×1 (5/day), 1-year ×2 (10/day), 2-year ×4 (20/day)** per stake.
- **The lottery prize pool is funded entirely by neuron yield** (half of every harvest from the protocol's pooled neurons), so **no player's principal is ever at risk** — players never pay in.
- **Draw mechanics:** three drawings a week (Mon/Wed/Sat nights, US Eastern). Each drawing has a **fixed 1-in-13 chance** of crowning a winner regardless of how many tickets exist (≈ a jackpot a month). A drawing only runs once the pot holds **≥ 25 ICP**, otherwise it rolls over. Your odds = your share of all tickets.
- **On a win:** **65% to the winner, 30% rolls into the next pot, 5% is burned to cycles.** The prize lands straight in the winner's wallet — nothing to claim — and everyone's tickets reset. (Admins are excluded from holding tickets.)

> **Soundbite:** *"It's a no-loss lottery: the prize is paid out of yield the protocol earns, not out of players' pockets. You stake, you keep your principal, and you get free tickets — and even the lottery burns a slice on every win."*

### Perm tier (a.k.a. "Early Adopters") — *permanent stake, tickets forever* (LIVE)
A separate, **permanent** stake into a platform-controlled 2-year neuron. **There is no unstake — the ICP is locked permanently.** In exchange:
- It earns **40 lottery tickets per day for every whole ICP** staked — by far the strongest ticket rate.
- The neuron's harvested yield is split **50% treasury / 50% lottery pot** and is **never paid back to stakers** (tickets are the only reward).
- It's **open to everyone, forever** — no cap.
This is the "true believer" tier: you're permanently donating productive ICP to the commons in exchange for a permanent stream of lottery entries. **Explain it carefully — the lock is irreversible.**

### Roadmap & Development — the community R&D board (LIVE)
A public idea board for "what should get built / burn more ICP."
- **Posting an idea costs $0.05** (USD-priced, payable in ICP/ckBTC/ckETH). **Pay in ICP and it's 100% burned; pay in a ck-token and it's 100% to the treasury.** Anti-spam, not revenue.
- **Upvoting is free.** Each person may upvote an idea once; an idea with **no upvotes for 30 days is deleted** (every upvote resets the clock — "use it or lose it").
- Admin-curated **official projects** can be funded toward a USD goal in any supported token; that funding goes 100% to the treasury that pays for the build.

### Explorer — a curated ICP dapp directory (LIVE)
A browsable directory of Internet Computer dapps (idGeek, ICPSwap, OISY, OpenChat, nftGeek, iiname, and more), filterable by category. Anyone can **list a dapp for $1/day** (USD-priced, multi-token, to treasury). It's deliberately *ecosystem-first* — Caldera points its users at other good ICP apps rather than walling them in.

### Proposal Discussions (LIVE)
A human debate layer on top of governance. **Start a conversation** on any proposal (a paid action — ICP spent here is **burned 100%**, ck-tokens to treasury), leave comments, and **up/down-vote** the takes for free. Conversation-starters **earn lottery tickets** as their take gets upvoted, and threads are **shareable on X**. It's the human counterpart to AI proposal analysis.

### X-Farm — proof-of-burn that doubles as outreach (LIVE)
You spin up your **own personal "Farmer" canister**. It burns your ICP into a cycle budget and uses that to run **Gemini** (Google's model, via Caldera's proxy) to draft **fresh, grounded pro-ICP tweets** — each ending with **$ICP** and relevant hashtags, grounded in the day's ICP news. You review and post them yourself (Caldera never posts for you).
- **Tiers:** Sprout **$1/day** (5 drafts/day), Grow **$1.50/day** (10/day), Bloom **$2/day** (15/day). Pick a **7–30 day** lifespan (**10% off at 30 days**), priced in USD and paid in ICP.
- **Split:** ~90% of what you pay becomes the Farmer's cycle budget (which is **deliberately burned down** over the lifespan), 10% goes to the treasury.
- The cycle budget **can't be turned back into ICP** — the bulk is an intentional **compute burn**. The honesty here is the feature: it's proof-of-burn on a schedule, with a useful by-product (drafts).

> **Soundbite:** *"X-Farm is the most on-the-nose part of the project: you literally burn ICP into compute that writes pro-ICP posts. The burn is real, the outreach is the bonus."*

---

## 4. The money model at a glance

| Action | What you pay | Where it goes | Tokens |
|---|---|---|---|
| **Commit / vote** | No fee; ~$1 min (treasury fronts ledger fees) | If vote fires: 50% treasury / 25% backend cycles / 25% frontend cycles (cycles = burned). Else fully refunded. | ICP only |
| **Post an idea** | $0.05 USD | ICP → 100% burned · ck-token → 100% treasury | ICP/ckBTC/ckETH |
| **Upvote an idea** | Free | — | — |
| **Fund a project** | The amount you choose (toward a USD goal) | 100% treasury | Any supported token |
| **List a dapp** | $1/day USD | Treasury | Any supported token |
| **Start a discussion** | A paid action (~$1) | ICP → burned · ck-token → treasury | Multi-token |
| **X-Farm Farmer** | $1–$2/day × 7–30 days (USD, in ICP) | ~90% → your Farmer's burned cycle budget · 10% → treasury | ICP |
| **Stake (lossless)** | Nothing — you get principal back | — (earns lottery tickets) | ICP |
| **Perm tier** | Your ICP, permanently | Neuron yield → 50% treasury / 50% lottery (tickets only) | ICP |

**Two recurring sinks:** (1) **burns** (commit cycles, ICP fees on ideas/discussions, X-Farm cycles, the lottery's 5%) that remove ICP from supply, and (2) the **treasury**, which funds prizes, payouts, builds, and operations. Lossless staking's principal is never touched.

---

## 5. How it's built (the credibility section)

- **100% on-chain on the Internet Computer.** The backend is a single Rust canister; the frontend is served from a canister too. No traditional servers, no database, no custody of your funds — everything value-moving is auditable on-chain.
- **Non-custodial & permissionless.** Sign in with **Internet Identity**; or, for bots/agents, any self-generated key works. Queries are free and anonymous.
- **Multi-token via Chain Fusion.** ICP plus **ck-assets** (ckBTC, ckETH, ckUSDC, ckUSDT). USD prices are set live by the **XRC exchange-rate oracle**, so "$1" means $1 regardless of token.
- **Real NNS integration.** Caldera votes through a community leader neuron via the NNS governance canister when thresholds are met.
- **Agent-first.** Every user flow also ships as a **copy-paste "agent skill"** (a public instructions file) plus CLI commands, so you can hand the daily loop (claim tickets, defend ideas, vote) to an AI agent on a cron.
- **One off-chain dependency, scoped tightly:** X-Farm's tweet generation calls Google's **Gemini** through a small Cloud Run proxy, using the IC's **non-replicated HTTPS outcalls**. It's used only for **advisory content** (draft tweets) — no money ever moves on what the model says.

---

## 6. What's live

Everything described in this brief is **live on Caldera's mainnet today**: burn voting · the Neuron Syndicate · lossless staking · the lossless lottery · the Perm tier · Roadmap & Development (the idea board) · the Explorer dapp directory · Proposal Discussions · X-Farm.

The team ships new features "dark" and flips them on only when they're ready, so what you can use in the app is what's actually running — this brief intentionally covers only those live features.

---

## 7. Honest caveats & risks (a diligent host should mention these)

- **Commitments are final.** Once you commit ICP to a proposal you can't withdraw it — only add more — and it's burned if the threshold is met. Refunds happen *only* if the threshold is missed.
- **The Perm tier is permanent.** That ICP never comes back. The reward is lottery tickets, **not** ICP yield. It suits believers, not people who may need the funds.
- **Lottery odds are fixed per draw (1-in-13), not "more tickets = guaranteed sooner."** More tickets only raise *your share* if a draw does crown a winner.
- **X-Farm cycles can't be redeemed.** The point is the burn; don't frame it as an investment with a return.
- **Neuron-following is self-attested.** Caldera can't verify on-chain that you control a neuron, so the Syndicate relies on honest attestation.
- **AI drafts are suggestions; you're the publisher.** You're responsible for anything you post from X-Farm, and the Gemini proxy is an off-chain trust assumption for that one feature.
- **Aspirational language ≠ guarantees.** The vision of "a jackpot that grows as ICP hits price targets" is a *goal*, not a promise. Nothing here is financial or voting advice, and the lottery/payouts shouldn't be pitched as yield products.

---

## 8. A suggested narrative arc (for an episode/segment)

1. **Hook:** "What if participating in governance made the token *more* scarce instead of just locking it up?"
2. **The problem:** whale-dominated NNS voting + hand-wavy tokenomics.
3. **The mechanism:** burn-to-steer voting, with the refund-if-it-fails safety valve.
4. **The flywheel:** burns + treasury fund a lossless lottery, ICP-paid rewards, and community R&D — which pull in more participants and more aligned neurons.
5. **The personality:** X-Farm (burning ICP to write pro-ICP posts) and the ecosystem-first Explorer show the project's "grow the pie together" ethos.
6. **The honesty:** lossless where it should be, irreversible where it must be — and they say which is which.
7. **Close:** it's live, on-chain, non-custodial, and agent-friendly; here's how to try it.

## 9. Quick-reference fact sheet

- **Name / URL:** Caldera · https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/
- **Chain:** Internet Computer (ICP), fully on-chain, non-custodial.
- **Backend / Frontend canisters:** `k7dn6-qiaaa-aaaap-qutha-cai` / `kyclk-5qaaa-aaaap-quthq-cai`
- **Leader neuron:** `17802688826615984104`
- **Commit:** no fee, min 1 ICP; burned 50/25/25 (treasury/backend cycles/frontend cycles) on a successful vote; fully refunded otherwise.
- **Lottery:** 3 draws/week (Mon/Wed/Sat), 1-in-13 per draw, ≥25 ICP pot to run, 65% winner / 30% rollover / 5% burned; funded by staking yield.
- **Staking tickets/day:** 6-mo 5 · 1-yr 10 · 2-yr 20 · Perm tier 40 per ICP.
- **Idea post:** $0.05 (ICP burned / ck to treasury) · upvotes free · 30-day expiry.
- **Explorer listing:** $1/day. **Discussions:** paid to start (ICP burned), free votes. **X-Farm:** $1/$1.50/$2 per day × 7–30 days, ~90% burned to cycles.
- **Tokens:** ICP, ckBTC, ckETH, ckUSDC, ckUSDT; USD pricing via XRC oracle.
