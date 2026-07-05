# Log

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
