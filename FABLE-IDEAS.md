# FABLE-IDEAS.md — 15 Burn-Engine & Revenue Ideas for Cycles of Influence

Ideas that fit the existing machinery (escrow subaccounts, 75/25 splits,
treasury→CMC burns, feature flags, leaderboards, agent skill files) and lean
on things only ICP can do (reverse gas / cycles, chain-key BTC/ETH, vetKeys,
t-ECDSA, `raw_rand`, HTTPS outcalls, timers, Internet Identity, fully
on-chain frontends). Each is a candidate for the Community R&D board.

9 - 4 - 11 - 12

---

1. **The Eternal Flame Wall** — Pay any amount of ICP (100% burned via the CMC) to inscribe a permanent message on an on-chain memorial wall, ranked forever by burn size. The Million Dollar Homepage, except the money provably ceases to exist.

2. **Burn Billboard Auction** — Auction the app's hero banner weekly: highest burner gets their message/logo displayed to every visitor until the next reset, enforced by a canister timer. Recurring revenue with zero inventory cost, and the ad spend itself is the burn.

3. **Proof-of-Conviction Notary** — Hash any document, burn a small fee, and receive a t-ECDSA-signed, timestamped attestation served from the canister — a notary that can't lose its records. Charge per attestation; sell bulk credits to agents via the llms.txt skill.

4. **vetKeys Time Capsules** — Users encrypt a message with vetKeys, pay a burn-priced fee per year of lock-up, and a canister timer releases the decryption key at the chosen date (wills, predictions, confessions, dead-man's switches). Longer locks = bigger burns.

5. **Rivalry Pots** — Two-sided meme battles (e.g. "ckBTC vs ckETH maxis") where both pots burn at the deadline and the winning side earns a permanent trophy page plus leaderboard flair. Reuses the adopt/reject pot code almost verbatim.

6. **Agent Seat Licenses** — Sell registered "verified agent" seats: AI agents burn a monthly ICP fee for priority query endpoints, higher rate limits, and a public agent leaderboard of governance participation. You already ship agent skill files — this turns them into a subscription product.

7. **Burn Streaks** — Daily micro-burn check-ins (0.01 ICP) with streak multipliers, streak-freeze purchases, and a monthly karma leaderboard. Duolingo's retention loop, except every check-in shrinks ICP supply.

8. **Milestone Pledge Pools** — Users pledge ICP that auto-burns only when an HTTPS-outcall oracle confirms a real-world milestone ("ICP flips X", "100k II anchors created this month"). Protocol takes a 5% fee on every triggered pool.

9. **Paid AI Proposal Analyst** — Activate the dormant `ai_price_e8s` config: burn 0.05 ICP to unlock a deep AI review of any NNS proposal (the UI panel already exists as a mock). Per-query revenue that scales with governance activity, not your headcount.

10. **ckBTC/ckETH Incinerator Swaps** — One-click "donate to the burn": chain-key tokens are swapped to ICP via a DEX canister and torched, with the donor's total shown on a cross-token burner leaderboard. Skim 2.5% to the treasury; Bitcoin and Ethereum holders get to deflate ICP without bridges.

11. **Neuron Name Service** — Pay-to-claim human-readable names for neurons and principals ("burnlord.icp"), shown across leaderboards, the pool sidebar, and rivalry pages; renewals burn annually. Vanity is the most reliable revenue in crypto.

12. **Burn Putt Duels & Tournaments** — Head-to-head wagered matches and weekend tournaments on the planned mini-golf game using `raw_rand` for fair hole/bracket seeding, with entry fees split prize/treasury/burn. The Phase-2 replay validator makes wagers defensible.

13. **Cycle Furnace Clans** — Idle-game layer where clans shovel ICP into a shared furnace that visibly converts to cycles powering the app; weekly clan war leaderboards with badge drops for top stokers. Social pressure does the marketing.

14. **Governance Insurance Pools** — Businesses pre-fund a standing "defense pot" that auto-commits (and burns) against any NNS proposal matching their watchlist keywords, monitored by the existing sweep timers. Charge a management fee on idle balances — recurring B2B revenue.

15. **The Burn Census** — A live, canister-rendered dashboard ranking every burner, idea, project, clan, and agent by lifetime ICP destroyed, with embeddable per-user "burn cards" for social sharing. Free to view, paid to customize — and every share is an ad for the whole machine.

---

# Big Ideas — 2026-06-11 batch (burn more ICP · engagement · cross-chain users)

Premise: ICP's user base is small; Bitcoin, Ethereum, Solana and stablecoin
users are 100× bigger. Chain Fusion (ckBTC/ckETH/ckUSDC/ckUSDT already wired
into Caldera, t-ECDSA/t-Schnorr, HTTPS outcalls) means we can serve those
users WITHOUT bridges and without them ever holding ICP first. Every idea
below routes external value through the existing escrow→treasury→CMC pipeline
so growth mechanically becomes burn.

## Acquisition (get users + liquidity from bigger chains)

**B1. Sign in with MetaMask / Phantom / Xverse — the chain-key passport.**
Internet Identity is our biggest funnel leak: nobody outside ICP has it.
Add SIWE/SIWS/SIWB adapters (ic-siwe et al.) that map an external wallet
signature to a derived principal. An Ethereum user lands on Caldera, signs
one message with the wallet they already have, and they're Tier-1. This is
the prerequisite that multiplies every other idea's reach.

**B2. The Lossless Bitcoin Lottery — PoolTogether for BTC hodlers.**
We already run a lossless lottery; today it's fed by ICP staking yield.
Open a ckBTC vault: deposit BTC (native, via ckBTC minter), principal
withdrawable anytime, pooled yield (lent on an IC money market or converted
to NNS-staked ICP) funds jackpots. "Never lose your Bitcoin, maybe win the
pot" is a proven product with the largest hodler base on earth — and every
rake/fee leg swaps to ICP and burns. Reuses: lottery draws, payout sagas,
PoolTogether-style copy on the existing Lottery page.

**B3. Native-deposit incinerator routes — burn ICP from a Coinbase withdrawal.**
t-ECDSA/t-Schnorr give every principal a derived native BTC/ETH (later SOL)
address. Flow: send native coin → canister mints ck-token → DEX-swaps to ICP
→ routes to whatever the user chose (commit-to-vote, stake, lottery,
Early Adopters, or pure burn). The user never installs an ICP wallet, never
touches an exchange listing. Cross-token burner leaderboard gives BTC/ETH
maxis a flag to plant.

**B4. Proof-of-burn passport — attestations Ethereum can verify.**
The canister t-ECDSA-signs an EAS attestation of a user's cumulative
burn/stake/governance record; Ethereum protocols can token-gate on
"burned ≥ X" credentials. Pulls credential-farmers IN from the biggest
ecosystem, and the thing they farm is our burn meter. Zero bridge risk —
it's just a signature.

**B5. Conviction-voting as a service (DAO embassy).**
White-label the burn-vote engine for SNS DAOs first (same NNS plumbing),
then off-ICP DAOs via snapshot/HTTPS-outcall resolution. DAOs pay setup +
per-proposal fees in ckUSDC; fees swap to ICP and burn. Caldera stops being
one community's tool and becomes governance infrastructure.

## Engagement (reasons to come back daily)

**B6. Ash — the soulbound burn-receipt economy.**
Every e8 burned (vote pots, explorer fees, arcade fees, customizations)
mints non-transferable "ash" to the burner. Ash is pure status + utility:
leaderboard titles, arcade cosmetics, explorer listing discounts, lottery
ticket multipliers, profile flair. One currency unifies every product into a
single loop, and the only faucet is burning. (Soulbound = no securities/DEX
surface area.)

**B7. NNS prediction pots — "Will this proposal pass?"**
Parimutuel ckUSDC pots on proposal outcomes, resolved trustlessly by the
canister reading governance state (the oracle is the chain itself — no
UMA/reporter drama). Polymarket proved the audience; we have the only
venue where settlement is native. Rake swaps to ICP and burns. Reuses the
adopt/reject pot + settlement saga code nearly verbatim, and it makes every
NNS proposal a spectator event on our dashboard.

**B8. Arcade majors — wagered weekend tournaments.**
Mini Golf becomes a venue: scheduled weekend tournaments, entry in any
supported ck-token, raw_rand-seeded brackets, prize split 70 winners /
20 treasury / 10 burn. The planned replay validator (PB-169) makes wagers
defensible. Weekly cadence = appointment viewing; spectator pages + X share
cards do the marketing.

**B9. The Caldera Flame — burn telemetry as a marketing surface.**
A live volcano visualization that grows with cumulative burn, per-user flame
profile cards, an embeddable widget for other dapps, and an X bot (HTTPS
outcalls, we already store handles) that auto-posts every settlement:
"🔥 214 ICP just ceased to exist — proposal #14802." Burning is our most
photogenic primitive; right now it's invisible. Make supply destruction a
spectator sport.

**B10. Quest seasons + on-chain referral graph.**
90-day seasons with a quest log (vote, stake, putt a birdie, share a
proposal, recruit a friend) paying ash + ticket multipliers; referral codes
tracked on-chain, referrer earns 10% of referee fees for 90 days. Retention
loop for B1's new arrivals — acquisition without retention is a leaky
bucket.

## Sequencing note

B1 (wallet sign-in) unlocks everything. B2 (lossless BTC lottery) is the
flagship external draw. B6+B9 (ash + flame) are cheap, pure-engagement layers on
machinery that already exists. B7 (prediction pots) is the biggest
burn-per-engineering-hour. B4/B5 are the long-game infrastructure plays.
