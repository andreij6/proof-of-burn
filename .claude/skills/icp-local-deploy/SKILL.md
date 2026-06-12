---
name: icp-local-deploy
description: Deploy, run, and seed the Cycles of Influence dapp on the local ICP network. Use when deploying canisters, starting the local network, calling canister methods, funding test identities, toggling feature flags, or debugging "ledger mismatch" / dead-button / empty-data issues locally.
---

# Local deploy & canister operations

This project uses the **`icp` CLI** (not `dfx`). Environments come from `icp.yaml`:
`local` (managed network), `staging` and `production` (IC mainnet).

## HARD RULE: never touch mainnet

**NEVER run any command with `-e production` or `-e staging` unless the user
explicitly asked for a mainnet deploy in the current conversation.** Fixing a
bug does not mean shipping it. All routine work targets `-e local`.

## One-shot local deploy

```bash
bash scripts/deploy-local.sh
```

Idempotent — safe to re-run after any backend/frontend change. It starts the
network if needed, installs ledgers once, upgrades backend+frontend, verifies
ledger wiring, wires ckBTC/ckETH/ckUSDC/ckUSDT ledgers, enables the `arcade`
and `early_adopters` feature flags (they ship dark, default OFF), and seeds mock
proposals/ideas/projects/pool-neurons. Prefer this script over hand-rolled
`icp deploy` sequences.

Frontend after deploy: http://frontend.local.localhost:8000/

## Identities (who runs what)

| Identity | Role |
|---|---|
| `agent-tester` | Controller of all local canisters — use for `icp deploy` / `icp canister install` of the **ledger** canisters |
| `dev1` | Backend `admins[0]` (owner) — use for all `admin_*` and `dev_*` calls, and for `icp canister install backend` |
| `dev2` | Second test user (pool member seeding) |
| `alice` / `bob` | Created by `scripts/e2e_burn_flow.sh` for burn-flow tests |

Always pass `--identity <name>` explicitly; relying on the active identity
causes confusing permission errors.

## Calling canister methods

```bash
# Update call (state-changing)
icp canister call backend <method> '(<candid args>)' -e local --identity dev1

# Query call — add --query or it costs an update round-trip
icp canister call backend get_config '()' --query -e local
```

Candid arg syntax examples used in this repo:
`'(variant { CkBTC }, principal "aaaaa-aa")'`, `'(7777001 : nat64, 25_000_000_000 : nat64)'`,
`'("arcade", true)'`, `'(opt principal "...")'`.

## Funding test users

```bash
icp canister call backend dev_faucet_token '(variant { ICP })' -e local --identity dev2
```

Faucet grants 100 ICP per call. **The pool-neuron join fee is 125 ICP, so a
fresh identity must call the faucet twice** before joining a pool. The in-app
tweak panel exposes the same faucets.

## Known traps

- **Ledgers are never upgraded.** Their `icp.yaml` args are an `Init` variant;
  an upgrade traps with "Cannot upgrade ... Init argument". Only install them
  fresh. `deploy-local.sh` already skips existing ledgers.
- **Canister IDs permute after a network wipe** (creation order). The backend's
  baked-in `ledger_canister_id` then points at the wrong canister and every
  balance/burn op fails. Fix: update `ledger_canister_id` in `icp.yaml`
  init_args to the actual ledger id, then
  `icp canister install backend --mode reinstall --args '<init args>' -e local --identity agent-tester`.
  `deploy-local.sh` step 4 detects this and prints the exact fix.
- **PB-148 (open):** local ledger's `icrc1_transfer` records the wrong block
  type for CMC `notify_top_up`, so burn-to-cycles notify can fail locally even
  when the code is correct. Don't "fix" backend code to work around it.
- Mock data only seeds when missing — to re-seed, the relevant store must be
  empty, not just stale.
