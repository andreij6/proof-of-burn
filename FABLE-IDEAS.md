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
