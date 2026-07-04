---
type: overview
title: "Cycles of Influence (Proof of Burn)"
description: "ICP canister dapp: burn ICP to vote on NNS governance proposals, with staking, a lottery, a Dapp Explorer, and an arcade whose mini-golf courses are AI-built NFTs."
resource: "https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/"
tags: [overview]
timestamp: 2026-07-04T00:00:00Z
---

# Cycles of Influence (Proof of Burn)

An Internet Computer dapp where users burn ICP to take positions on NNS
governance proposals. Burns split 50% to the protocol treasury and 50% into
cycles that keep the canisters running — participation literally powers the
platform.

## Surfaces

- **Vote (burn-only)** — commit ICP to a tracked NNS proposal; if the
  threshold passes, the commitment burns via the 50/25/25 split and the
  community leader neuron casts the vote.
- **Staking & lottery** — term-tier neuron staking earns lottery tickets;
  only stakers earn tickets anywhere in the app.
- **Arcade / Mini Golf** — courses are AI-designed NFTs
  (build-instructions JSON) that anyone signed-in can mint, play, buy, sell
  and share; a Field Goal game shares the arcade.
- **Dapp Explorer** — paid ($1/day) curated dapp directory with an XRC
  price oracle.
- **Early Adopters** — a permanent 2-year-neuron stake with a proportional
  yield split.

## Canisters (mainnet)

| Canister | Id |
|---|---|
| backend | `k7dn6-qiaaa-aaaap-qutha-cai` |
| frontend | `kyclk-5qaaa-aaaap-quthq-cai` |
| course_nft | `itpnn-xiaaa-aaaap-quuwq-cai` |

## Where knowledge lives

- Operating the system: [/operations](/index.md) runbooks (deploys,
  mainnet ops, security, economics).
- Point-in-time analyses: [/notes](/index.md).
- Feature explorations (built and unbuilt): [/ideas/index.md](/ideas/index.md).
- Code is the source of truth for behavior — the backend is a single
  documented Rust canister (`src/backend/src/lib.rs`), the frontend a React
  SPA (`src/frontend`).
