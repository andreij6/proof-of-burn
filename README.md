# Caldera

**Caldera** is a governance dapp on the Internet Computer (ICP) that brings
**skin in the game** to NNS voting. You follow a Leader Neuron, commit ICP to
signal conviction on a proposal (ADOPT or REJECT), and if the community clears
the threshold the Leader votes the winning side and the committed ICP is burned
to cycles that fund the app. If the threshold isn't met, your ICP is refunded.

### 🔥 Live app: **https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/**

Runs fully on-chain. Sign in with Internet Identity to participate.

---

## Features

- **Burn voting** — Commit ICP behind ADOPT or REJECT on any active NNS
  proposal. Votes are weighted by ICP committed; clearing the threshold makes
  the Leader Neuron vote the winning side and burns the committed ICP to
  cycles. Miss the threshold and everyone is refunded.
- **Progressive onboarding** — The UI unlocks in tiers: browse anonymously →
  sign in with Internet Identity → follow the Leader Neuron (guided walkthrough
  adds the canister as a hotkey to verify the follow on-chain) → commit and get
  a personal dashboard.
- **Multi-token commits** — Commit with ckBTC, ckETH, ckUSDC or ckUSDT; an
  internal swap desk converts to ICP for the vote.
- **Pooled staking** — Join a shared neuron pool to participate without giving
  up custody, with proportional yield.
- **Lossless lottery & payouts** — Stake-funded prize draws where principal is
  preserved, plus on-chain payout history.
- **Idea Board** — Community R&D: post, browse and signal on ideas for what to
  build next.
- **Dapp Explorer** — Paid daily dapp listings priced in USD via the XRC oracle.
- **Early Adopters** — Opt into a permanent 2-year neuron stake that shares
  yield proportionally (deliberately no unstake).
- **Arcade & Casino** — Mini Golf (with a course editor) and Field Goal, plus
  the Crash casino game (ships dark behind a feature flag).
- **Self-sustaining** — Burned commitments mint cycles that fund the canister,
  so the app runs longer the more it's used.

---

## Run it locally

### Prerequisites

- [ICP SDK](https://internetcomputer.org/docs/building-apps/getting-started/install)
  (`icp` CLI) — `icp --version`
- Rust with the wasm target — `rustup target add wasm32-unknown-unknown`
- Node.js (for the frontend) — `node --version`

### Setup

```bash
# 1. Install JS deps for the frontend
npm install --prefix src/frontend

# 2. Create the local identities the deploy script expects
icp identity new agent-tester --storage-mode=plaintext   # controller of local canisters
icp identity new dev1 --storage-mode=plaintext            # backend admin
icp identity new dev2 --storage-mode=plaintext            # second pool member

# 3. One-shot local deploy (starts the network, installs ledgers,
#    deploys backend + frontend, seeds mock data — idempotent, re-runnable)
bash scripts/deploy-local.sh
```

When it finishes it prints the local URLs, e.g.:

```
Frontend:  http://frontend.local.localhost:8000/
Backend:   <canister id>
```

Open the frontend URL and sign in with the local Internet Identity to use the
app. Grab test tokens from the in-app tweak panel, or:

```bash
icp canister call backend dev_faucet_token '(variant { ICP })' -e local --identity dev1
```

### Develop

```bash
npm run dev --prefix src/frontend                       # frontend with hot reload
cargo test -p backend --lib                             # backend unit tests
npm test --prefix src/frontend                          # frontend tests
```

---

## Project layout

- `src/backend/` — Rust canister (governance, escrow, staking, lottery, games).
- `src/frontend/` — React + Vite single-page app.
- `scripts/` — local/prod deploy and helper scripts.
- `docs/` — deployment, mainnet, operations, economics and security runbooks.

> Deploying to mainnet is a separate, gated process — see `docs/DEPLOY.md`.
