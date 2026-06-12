#!/usr/bin/env bash
# =============================================================================
# deploy-local.sh — One-shot local deploy for Cycles of Influence
#
# What it does (idempotent — safe to re-run):
#   1. Verifies the local managed network is reachable (starts it if not).
#   2. Installs the four ICRC test ledgers ONCE (ledger / ckbtc-ledger /
#      cketh-ledger / ckusdc-ledger). Ledgers are NEVER upgraded: their
#      icp.yaml args are an `Init` variant and an upgrade traps
#      ("Cannot upgrade ... Init argument").
#   3. Deploys/upgrades backend + frontend (asset sync included).
#   4. Sanity-checks that the backend's configured ICP ledger id matches the
#      actual ledger canister (ids permute after a network wipe — see
#      docs/OPS.md / memory note; a mismatch breaks every balance/burn op).
#   5. Wires the backend at the local ckBTC/ckETH ledgers (admin call).
#   6. Prepopulates mock data when missing:
#        - mock proposals + 3 sample ideas  (auto-seeded by init/post_upgrade)
#        - 2 sample fundable projects       (admin_add_project as dev1)
#        - 2 active pool neurons            (dev_seed_pool_neuron as dev1+dev2)
#
# Identities (override via env):
#   DEPLOY_IDENTITY  controller of all local canisters   (default: agent-tester)
#   ADMIN_IDENTITY   backend admins[0]                   (default: dev1)
#   SEED_IDENTITY    second mock pool member             (default: dev2)
#
# Usage:
#   bash scripts/deploy-local.sh
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

ENV="local"
DEPLOY_IDENTITY="${DEPLOY_IDENTITY:-agent-tester}"
ADMIN_IDENTITY="${ADMIN_IDENTITY:-dev1}"
SEED_IDENTITY="${SEED_IDENTITY:-dev2}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅${NC} $1"; }
note() { echo -e "${YELLOW}ℹ️ ${NC} $1"; }
die()  { echo -e "${RED}❌${NC} $1"; exit 1; }

canister_exists() { icp canister status "$1" -e "$ENV" >/dev/null 2>&1; }
canister_id()     { icp canister status "$1" -e "$ENV" 2>/dev/null | awk '/Canister Id:/ {print $3}'; }

# ── 1. Network ───────────────────────────────────────────────────────────────
if ! canister_exists backend && ! icp canister status frontend -e "$ENV" >/dev/null 2>&1; then
  note "Local network unreachable or empty — starting managed network…"
  icp network start -e "$ENV" -d || true
  sleep 3
fi

# ── 2. Ledgers: install once, never upgrade ─────────────────────────────────
for L in ledger ckbtc-ledger cketh-ledger ckusdc-ledger ckusdt-ledger; do
  if canister_exists "$L"; then
    ok "$L already installed ($(canister_id "$L")) — skipping (ledgers are never upgraded)"
  else
    note "Installing $L (fresh Init)…"
    icp deploy "$L" -e "$ENV" --identity "$DEPLOY_IDENTITY" --yes
    ok "$L installed ($(canister_id "$L"))"
  fi
done

# ── 3. Backend + frontend (upgrade in place, asset sync) ────────────────────
note "Deploying backend + frontend…"
icp deploy backend frontend -e "$ENV" --identity "$DEPLOY_IDENTITY" --yes
ok "backend + frontend deployed"

BACKEND_ID=$(canister_id backend)
FRONTEND_ID=$(canister_id frontend)
LEDGER_ID=$(canister_id ledger)
CKBTC_ID=$(canister_id ckbtc-ledger)
CKETH_ID=$(canister_id cketh-ledger)
CKUSDC_ID=$(canister_id ckusdc-ledger)
CKUSDT_ID=$(canister_id ckusdt-ledger)

# ── 4. Ledger-id sanity check (catches post-wipe id permutation) ────────────
CFG_LEDGER=$(icp canister call backend get_config '()' --query -e "$ENV" \
  | sed -n 's/^[[:space:]]*ledger_canister_id = principal "\([^"]*\)".*/\1/p' | head -1)
if [[ "$CFG_LEDGER" != "$LEDGER_ID" ]]; then
  echo -e "${RED}❌ Backend config points at ledger '$CFG_LEDGER' but the actual ledger is '$LEDGER_ID'.${NC}"
  echo "   This happens after a network wipe (canister ids permute by creation order)."
  echo "   Fix: update ledger_canister_id in icp.yaml init_args to $LEDGER_ID, then:"
  echo "     icp canister install backend --mode reinstall --args '<init args from icp.yaml>' -e local --identity $DEPLOY_IDENTITY"
  die "Refusing to continue with a mis-wired ledger."
fi
ok "Backend ledger wiring verified ($LEDGER_ID)"

# ── 5. Wire local ckBTC/ckETH ledgers (idempotent admin calls) ───────────────
icp canister call backend admin_set_token_ledger "(variant { CkBTC }, principal \"$CKBTC_ID\")" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
icp canister call backend admin_set_token_ledger "(variant { CkETH }, principal \"$CKETH_ID\")" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
icp canister call backend admin_set_explorer_ledger "(variant { CkUSDC }, principal \"$CKUSDC_ID\")" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
icp canister call backend admin_set_explorer_ledger "(variant { CkUSDT }, principal \"$CKUSDT_ID\")" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
ok "Token ledgers wired (ckBTC=$CKBTC_ID, ckETH=$CKETH_ID, ckUSDC=$CKUSDC_ID, ckUSDT=$CKUSDT_ID)"

# The arcade + early adopters ship dark (flags default OFF) — on for local testing.
icp canister call backend admin_set_feature_flag '("arcade", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
icp canister call backend admin_set_feature_flag '("early_adopters", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
ok "Arcade + Early Adopters flags enabled (local)"

# ── 6. Mock data (only seeds what is missing) ────────────────────────────────
# 6a. Proposals + sample ideas auto-seed in init/post_upgrade when empty.
IDEA_COUNT=$(icp canister call backend list_ideas '()' --query -e "$ENV" | grep -c 'id = ' || true)
ok "Ideas on board: $IDEA_COUNT (3 samples auto-seed when the board is empty)"

# 6b. Sample fundable projects (admin-curated).
if icp canister call backend list_projects '()' --query -e "$ENV" | grep -q 'id = '; then
  ok "Projects already present — skipping project seed"
else
  note "Seeding 2 sample projects…"
  icp canister call backend admin_add_project \
    '("Burn Dashboard v1", "A public dashboard ranking dapps by cycles burned, updated daily on-chain.", "Pull cycle-consumption metrics per canister, normalise by subnet, surface a verifiable burn ranking.", 50_000_000_000 : nat64, 5_000_000 : nat64, 1_000_000_000_000_000_000 : nat64, true, true, true)' \
    -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
  icp canister call backend admin_add_project \
    '("ckBTC Tipping Widget", "An embeddable tip button for ICP dapps that routes a fee share to the treasury.", "ICRC-1 tips with a 2% protocol fee converted to cycles via the CMC — every tip burns ICP.", 25_000_000_000 : nat64, 2_500_000 : nat64, 0 : nat64, true, true, false)' \
    -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
  ok "Seeded 2 sample projects"
fi

# 6c. Sample active pool neurons (so the pool sidebar isn't empty).
ACTIVE_COUNT=$(icp canister call backend get_pool_info '()' --query -e "$ENV" \
  | sed -n 's/^[[:space:]]*active_count = \([0-9_]*\).*/\1/p' | head -1)
if [[ "${ACTIVE_COUNT:-0}" == "0" ]]; then
  note "Seeding 2 mock pool neurons…"
  icp canister call backend dev_seed_pool_neuron '(7777001 : nat64, 25_000_000_000 : nat64)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
  icp canister call backend dev_seed_pool_neuron '(7777002 : nat64, 12_000_000_000 : nat64)' -e "$ENV" --identity "$SEED_IDENTITY"  >/dev/null
  ok "Seeded pool neurons #7777001 (dev1), #7777002 (dev2)"
else
  ok "Pool already has $ACTIVE_COUNT active neuron(s) — skipping pool seed"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────────────────"
ok "Local deploy complete."
echo "   Frontend:      http://frontend.local.localhost:8000/  (canister $FRONTEND_ID)"
echo "   Backend:       $BACKEND_ID"
echo "   ICP ledger:    $LEDGER_ID"
echo "   ckBTC ledger:  $CKBTC_ID"
echo "   ckETH ledger:  $CKETH_ID"
echo "   ckUSDC ledger: $CKUSDC_ID"
echo "   ckUSDT ledger: $CKUSDT_ID"
echo "   Feature flags: $(icp canister call backend list_feature_flags '()' --query -e "$ENV" | tr -d '\n' | sed 's/  */ /g')"
echo "   Faucets: in-app tweak panel, or:"
echo "     icp canister call backend dev_faucet_token '(variant { ICP })' -e local --identity <id>"
echo "──────────────────────────────────────────────────────────"
