# Log

## 2026-07-10 — Stake Vouchers built (all 3 phases, LOCAL)

2-fork fanout (b0dc01f): voucher_nft ICRC-7 canister + backend registry/
wrap/unwrap + 15% balance-gated house buyback (burn + immediate dissolve,
spread 1/3/1/3/1/3) + ICP marketplace (escrow saga, 2.5% fee) + promo
campaign engine (5,000 cap, 500/day drip, 60d expiry, 1 ticket/day,
paste-principal claims) + Vouchers page + standalone #/claim Golden
Ticket page + dev docs/llms.txt sections. 290+3+356 tests; full live
loop smoked on local incl. exact 85% buyback and fee-third-to-fund.
Dark on mainnet; mainnet activation needs voucher_nft creation + wiring
+ flag + fund seed.

## 2026-07-10 night — Mainnet deploy 66c54a1 (server-side tickets + dev docs)

Daily stake tickets now land SERVER-SIDE every UTC day (sweep leg
auto_grant_daily_stake_tickets — no visit required; forced first sweep
post-deploy granted the day's tickets, round total 65). New Developer
Docs page #/dev-docs (embed the No-Loss Lottery via direct canister
calls: candid + idlFactory + 3 flows + caller-keyed trust rule) with an
AI-agent handoff: /llms.txt served verbatim (verified on prod) + a
"Copy docs for your AI agent" one-prompt button. Snapshot rotation: …27
deleted, …29 created (575 MiB; …28 retained).

## 2026-07-10 pm — Mainnet deploy 1fd90ee (lottery-first nav + mobile chrome)

Governance (Voting + Neuron Syndicate) and Community (Explorer + X-Farm)
nav groups now behind nav_governance/nav_community flags, BOTH OFF on
prod — the nav is lottery-first (verified Off post-deploy); the app's
universal fallback page is now the lottery (was voting). Mobile: no app
name/logo (hamburger-only top bar, drawer header is just the ✕). Neuron
Stake page decluttered to the lottery pattern (one title row + one
how-it-works pill; embedded Staking header removed). Snapshot rotation:
…26 deleted, …28 created (575 MiB; …27 retained).

## 2026-07-10 — Mainnet deploy 819f0a7 (No-Loss Lottery redesign)

Frontend: lottery page rebuilt Lumina-style — giant glowing pot,
DD/HH/MM/SS countdown blocks, one adaptive pill CTA ("Get tickets" /
"Stake more · earn more tickets"), single how-it-works pill in the
header (thresholds named: ≥25 ICP + 25 unique players), "No-Loss
Lottery" branding everywhere, Last-jackpot banner below the tickets
card; OpenChat community link in footer + sidebar; landing scale-hiding
already live. (A money-ball graphic was built and removed same-day —
recoverable at 175d73a.) Backend: cofounders stale flag row purged by
post_upgrade (flags = 11 exactly). Snapshot rotation: …25 deleted, …27
created (575 MiB; …26 retained).

## 2026-07-07 — Mainnet deploy 7b4a89d (feature removals + cycles overhaul)

The big cut: idea_board/Community R&D, discussions, casino/crash,
cycles_faucet, Arcade hub, Field Goal, dashboard, mission_statement
permanently removed (74 endpoints; flags 19→11 after post_upgrade purge);
mini golf rehomed to #/mini-golf with #/arcade/... link aliases. Cycles:
get_lottery_info now a QUERY (pot cache, MemoryId 127), sweep throttled
(proposals 15m; maturity/balances hourly), 1-day game retention, plus the
draw-keyed EA settlement and Bull Run ink restyle from earlier commits.
Rollback snapshot …26 (528 MiB; …25 retained, …24 rotated out per the max-2
policy). Post-deploy: forced sweep DRAINED the EA inbox — 0.97 ICP routed,
pot 47.7 ICP; removed endpoints reject; minigolf answers. Discovery:
"cofounders" existed on mainnet only as a stale stable flag row from a
pre-git era — set Off + queued for the retired purge next deploy.

## 2026-07-06 — Mainnet deploy ba0b1e1 (mobile playability + 50-hand daily)

Shipped since 4b39efa: Drop Zone mobile control fix (overlay was
ref-driven — DIVE/CHUTE never appeared after jumping; now state-mirror
synced); Mini Golf fullscreen shell on mobile; quit-✕ overlap fixes
(Drop Zone ALT plate + Bull Run coins plate shift right of the button;
altimeter clamped clear of minimap and CHUTE thumb); Luck-Proof daily
competition 250 → 50 decisions (min-time bound scaled 60s → 12s).
Rollback snapshot …25 (528 MiB); prod smoke: daily status reports 50
decisions, frontend 200.

## 2026-07-06 — Mainnet deploy 4b39efa (mobile + admin custody card)

Shipped since 8d3ba8e: mobile fullscreen shells + thumb controls for Drop
Zone and Bull Run (Drop Zone was unplayable on phones — unreadable HUD,
steering/button conflict); nav sections renamed "Stake 4 Tickets" / "Play
4 Tickets"; Admin → Staking & Lottery "ICP LP staked per pool" card
(admin_get_icp_lp_pool_stats live valuation; smoked on prod — 5 pool
rows). Fast Lane was built and removed same-day, never reached mainnet.
Housekeeping: pruned the five oldest backend snapshots (June 25 – Jul 4,
~2 GiB) after snapshot creation failed on memory-grow cycles; kept …21/
…22/…23 and took new rollback snapshot …24 (528 MiB). Also committed the
straggler OKF-migration deletions (audit/, plans/, tasks/).

## 2026-07-05 — Mainnet deploy 8d3ba8e (value-scaled LP tickets + Stake to Earn)

Shipped since 23860b4: ICP LP tickets now 40/day per $1 of staked LP value
(valued live from pool tick-math × XRC rates, once per UTC day); the
"Stake to Earn" nav section (Neuron Stake page split out of the Lottery
hub, ICP LP + ANSEM LP moved in; all Stake-ICP CTAs re-routed;
#/lottery/staking deep link redirects); rich gist-card "How it works"
modals on all five reward/game pages. Backend rollback snapshot …23
(520 MiB). All commits on GitHub.

## 2026-07-05 — Mainnet deploy 23860b4 (ICP LP custody staking live)

Shipped ICP LP (Model B custody staking of ICPSwap positions) with the
reserve-first anti-sniping flow; flag `icpswap_lp_stake` ON. All five pools
configured after resolving them from the SwapFactory and verifying each
pool's token pair against its own on-chain metadata: ICP/ckUSDC
`mohjv-bqaaa-aaaag-qjyia-cai`, ckUSDT/ICP `hkstf-6iaaa-aaaag-qkcoq-cai`,
ckBTC/ICP `xmiu5-jqaaa-aaaag-qbz7q-cai`, ICP/ckETH
`angxa-baaaa-aaaag-qcvnq-cai`, ckBTC/ckETH `akhru-myaaa-aaaag-qcvna-cai`
(all fee 3000, token0/token1 order as the pools report). Backend rollback
snapshot …22 (480 MiB).

## 2026-07-05 — Mainnet deploy a4772c5 (Drop Zone, Bull Run, ANSEM LP)

Shipped everything since 45ff7af and flipped three flags ON:
`arcade_skydive` (Drop Zone), `arcade_bullrun` (Bull Run), and
`solana_lp_rewards` (ANSEM LP — pool configured with the on-chain-verified
PumpSwap ANSEM/SOL LP mint `CevNeicTXqL1oAjqZ3FNmexftzKD4ozqev5DgX2sAgFq`,
Token-2022, derived as PDA ["pool_lp_mint", FnzKY6x7…L3CC] and confirmed
against mainnet Solana). Also includes the Play to Earn nav group,
Luck-Proof practice sessions + pot-odds realism + two daily winners, and
the lottery ticket-source breakdown refinements. Backend rollback snapshot
…210000000001f0a4ce0101 (439 MiB). All commits pushed to GitHub.

## 2026-07-04 — Mainnet deploy 45ff7af (Sklansky Trainer + economy rework)

Shipped 18 commits (d5bb288 → 45ff7af): Luck-Proof/Sklansky Trainer live
(flag `arcade_luckproof` ON — practice + daily 250-decision competition,
two winners paid player-count tickets each), economy rework (mint 2 ICP,
customize 0.5 ICP flat, 50/25/25 splits, stakers-only tickets, play
ungated for signed-in), lottery ticket-source breakdown, OKF docs bundle.
Backend snapshot ...200000000001f0a4ce0101 retained for rollback.

## 2026-07-04 — Luck-Proof idea captured (built)

Added [/ideas/luck-proof/README.md](/ideas/luck-proof/README.md) — arcade
game 3, the hold'em EV-decision trainer, built and shipped dark the same day.

## 2026-07-04 — bundle created

Migrated the repository's `docs/` (14 documents → `/operations` + `/notes`)
and `ideas/` (114 documents → `/ideas`, directory structure preserved) into
this OKF v0.1 bundle. Every concept gained YAML frontmatter (`type`, `title`,
`tags`, `timestamp` = last git commit date at migration time); bodies are
unchanged. Repository references to the old paths were updated in the same
commit.
