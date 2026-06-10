#!/usr/bin/env bash
# =============================================================================
# deploy-prod.sh — Guarded IC MAINNET deploy for Cycles of Influence
#
# ⚠️  This deploys to PRODUCTION (real ICP, real users, real cycles).
#     Standing rule: mainnet deploys are explicitly owner-initiated. This
#     script enforces that with an interactive confirmation gate — it is NOT
#     suitable for CI / unattended use.
#
# What it does:
#   1. Pre-flight: identity check (refuses known local dev identities),
#      clean-ish git check, full test suites, production build.
#   2. Interactive confirmation (type the exact phrase).
#   3. `icp deploy backend frontend -e production`
#      - NO ledgers (mainnet uses the real ICP/ckBTC/ckETH ledgers,
#        which are hard-pinned in the backend).
#      - NO --yes: the candid compatibility check stays ON. If it flags a
#        breaking change, stop and think before bypassing manually.
#   4. Post-deploy smoke checks + operator reminders.
#
# Prerequisites (see docs/DEPLOY.md):
#   - Funded deploy identity selected: `icp identity use <name>`
#   - For a FIRST deploy: icp.yaml init_args `owner` updated to your
#     mainnet principal (it becomes admins[0]).
#
# Usage:
#   bash scripts/deploy-prod.sh
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

ENV="production"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅${NC} $1"; }
note() { echo -e "${YELLOW}ℹ️ ${NC} $1"; }
die()  { echo -e "${RED}❌${NC} $1"; exit 1; }

[[ -t 0 ]] || die "deploy-prod.sh must be run interactively (confirmation gate)."

# ── 1. Pre-flight ────────────────────────────────────────────────────────────
PRINCIPAL=$(icp identity principal)
note "Deploying as principal: $PRINCIPAL"

# Known LOCAL dev identities must never deploy to mainnet.
LOCAL_DEV_PRINCIPALS=(
  "gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe"  # dev1
  "p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe"  # dev2
  "i3ptn-w5i4d-zwvvn-kxgy4-zkx5d-ukatp-3jbje-vtb6d-y5zmj-kpj33-xae"  # agent-tester
)
for p in "${LOCAL_DEV_PRINCIPALS[@]}"; do
  [[ "$PRINCIPAL" == "$p" ]] && die "Identity '$PRINCIPAL' is a LOCAL dev identity. Switch: icp identity use <mainnet-deploy-identity>"
done
ok "Identity is not a local dev identity"

if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  note "Working tree has uncommitted changes:"
  git status --short --untracked-files=no | sed 's/^/     /'
  read -r -p "   Deploy uncommitted code to MAINNET anyway? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || die "Aborted — commit first."
fi

note "Running backend test suite (unit + PocketIC)…"
(cd src/backend && cargo test) || die "Backend tests failed — fix before deploying."
ok "Backend tests green"

note "Running frontend test suite…"
npm --prefix src/frontend test || die "Frontend tests failed — fix before deploying."
ok "Frontend tests green"

note "Building production artifacts…"
icp build -e "$ENV" || die "Production build failed."
ok "Production build OK"

# ── 2. Confirmation gate ─────────────────────────────────────────────────────
echo
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
echo -e "${RED}  You are about to deploy backend + frontend to IC MAINNET.${NC}"
echo -e "${RED}  Identity: $PRINCIPAL${NC}"
echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
read -r -p "Type exactly 'DEPLOY TO MAINNET' to continue: " CONFIRM
[[ "$CONFIRM" == "DEPLOY TO MAINNET" ]] || die "Confirmation phrase mismatch — aborted."

# ── 3. Deploy (candid compatibility check stays ON — no --yes) ──────────────
icp deploy backend frontend -e "$ENV"
ok "Deploy command completed"

# ── 4. Smoke checks + reminders ──────────────────────────────────────────────
BACKEND_ID=$(icp canister status backend -e "$ENV" 2>/dev/null | awk '/Canister Id:/ {print $3}')
FRONTEND_ID=$(icp canister status frontend -e "$ENV" 2>/dev/null | awk '/Canister Id:/ {print $3}')

note "Smoke: get_config (query)…"
icp canister call backend get_config '()' --query -e "$ENV" >/dev/null && ok "get_config responds"
note "Smoke: get_global_stats (query)…"
icp canister call backend get_global_stats '()' --query -e "$ENV" >/dev/null && ok "get_global_stats responds"
note "Feature flags currently:"
icp canister call backend list_feature_flags '()' --query -e "$ENV" | sed 's/^/     /'

echo
echo "──────────────────────────────────────────────────────────"
ok "Mainnet deploy finished."
echo "   Backend:  $BACKEND_ID"
echo "   Frontend: $FRONTEND_ID  →  https://$FRONTEND_ID.icp0.io/"
echo
echo "   Post-deploy checklist (docs/DEPLOY.md §4–5):"
echo "   [ ] Backup controller present:  icp canister status backend -e production"
echo "   [ ] Anonymous eligibility is tier 0 (smoke per runbook)"
echo "   [ ] Cycle balances healthy on both canisters"
echo "   [ ] Feature flags as intended (new features ship dark — enable"
echo "       deliberately via admin_set_feature_flag from an admin identity)"
echo "──────────────────────────────────────────────────────────"
