# Log

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
