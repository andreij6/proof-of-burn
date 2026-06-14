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
#   3. Pre-upgrade snapshot of the BACKEND — rollback insurance against a
#      trapping post_upgrade / bad stable-memory migration. The restore command
#      is printed; the snapshot is retained until you verify health + delete it.
#   4. `icp deploy backend frontend -e production`
#      - NO ledgers (mainnet uses the real ICP/ckBTC/ckETH ledgers,
#        which are hard-pinned in the backend).
#      - NO --yes: the candid compatibility check stays ON. If it flags a
#        breaking change, stop and think before bypassing manually.
#      - On failure, prints the exact snapshot-restore rollback steps.
#   5. Core-launch feature-flag policy: set the 10 flags + verify on-chain.
#   6. Post-deploy smoke checks + operator reminders.
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

# Unit tests always gate the deploy. The PocketIC integration suite needs the
# pocket-ic server binary (POCKET_IC_BIN or `pocket-ic` on PATH); when it's
# absent we run unit tests only and WARN loudly rather than blocking the deploy.
note "Running backend unit tests…"
cargo test -p backend --lib || die "Backend unit tests failed — fix before deploying."
ok "Backend unit tests green"

if [[ -n "${POCKET_IC_BIN:-}" ]] || command -v pocket-ic >/dev/null 2>&1; then
  note "Running PocketIC integration suite…"
  cargo test -p backend --test integration || die "PocketIC integration tests failed — fix before deploying."
  ok "PocketIC integration tests green"
else
  note "⚠️  pocket-ic not found (POCKET_IC_BIN unset) — SKIPPING the integration suite."
  note "    Install pocket-ic and re-run to exercise cross-canister flows before mainnet."
  read -r -p "   Deploy to MAINNET without running integration tests? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || die "Aborted — install pocket-ic, then re-run."
fi

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

# ── 3. Pre-upgrade snapshot (rollback insurance) ────────────────────────────
# Snapshot the BACKEND's full state BEFORE the upgrade so a trapping post_upgrade
# or a bad stable-memory migration is reversible. The frontend is an asset
# canister with no critical stable state, so we snapshot the backend only.
# Reuse (--replace) the previous pre-upgrade snapshot if one exists so repeated
# deploys don't pile up snapshots (and hit the per-canister limit).
note "Taking a pre-upgrade snapshot of the backend (rollback insurance)…"
PREV_SNAP=$(icp canister snapshot list backend -e "$ENV" -q 2>/dev/null | head -1 || true)
if [[ -n "${PREV_SNAP// /}" ]]; then
  SNAP_ID=$(icp canister snapshot create backend -e "$ENV" --replace "$PREV_SNAP" -q) \
    || die "Snapshot failed — refusing to upgrade without rollback insurance."
else
  SNAP_ID=$(icp canister snapshot create backend -e "$ENV" -q) \
    || die "Snapshot failed — refusing to upgrade without rollback insurance."
fi
ok "Backend snapshot created: $SNAP_ID"
ROLLBACK_CMDS="     icp canister stop backend -e $ENV
     icp canister snapshot restore backend $SNAP_ID -e $ENV
     icp canister start backend -e $ENV"
echo -e "${YELLOW}   Rollback (if this upgrade goes wrong):${NC}"
echo "$ROLLBACK_CMDS"

# ── 4. Deploy (candid compatibility check stays ON — no --yes) ──────────────
note "Upgrading backend + frontend…"
if ! icp deploy backend frontend -e "$ENV"; then
  echo
  echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
  echo -e "${RED}  UPGRADE FAILED — the backend may be in a bad state.${NC}"
  echo -e "${RED}  Roll back to the pre-upgrade snapshot NOW:${NC}"
  echo "$ROLLBACK_CMDS"
  echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
  die "Deploy failed — roll back using snapshot $SNAP_ID (commands above)."
fi
ok "Deploy command completed"

# ── Core-launch feature-flag policy ──────────────────────────────────────────
# Features ship dark (flags default OFF) and persist across upgrades, so we
# assert the EXACT launch policy explicitly here rather than trusting prior
# state. Admin calls run as the current (already-verified mainnet) deploy
# identity, which is the backend's admins[0] — same identity used for the deploy
# above, so no separate --identity is needed. Idempotent: re-running re-asserts.
#
#   ENABLE  (true):  idea_board lossless_voting lossless_lottery dapp_explorer early_adopters
#   DISABLE (false): arcade arcade_minigolf arcade_fieldgoal crash cycles_faucet
CORE_ON=(idea_board lossless_voting lossless_lottery dapp_explorer early_adopters)
CORE_OFF=(arcade arcade_minigolf arcade_fieldgoal crash cycles_faucet)

note "Asserting core-launch feature-flag policy…"
for f in "${CORE_ON[@]}"; do
  icp canister call backend admin_set_feature_flag "(\"$f\", true)"  -e "$ENV" >/dev/null \
    || die "admin_set_feature_flag(\"$f\", true) failed."
done
for f in "${CORE_OFF[@]}"; do
  icp canister call backend admin_set_feature_flag "(\"$f\", false)" -e "$ENV" >/dev/null \
    || die "admin_set_feature_flag(\"$f\", false) failed."
done
ok "Feature flags set (5 enabled, 5 disabled)"

# Verify: read the raw flags back and FAIL LOUDLY if reality ≠ policy. We parse
# the per-flag candid record (whitespace-collapsed) and assert the raw `state`
# variant (On/Off) — not the caller-effective `enabled` field, which can read
# true for an AdminOn flag when queried by an admin.
note "Verifying feature-flag policy on-chain…"
FLAGS_RAW=$(icp canister call backend list_feature_flags '()' --query -e "$ENV" | tr -d '\n' | tr -s ' ')
flag_state() { # echo On|Off|AdminOn|MISSING for a given key
  echo "$FLAGS_RAW" | grep -oE "record \{[^}]*key = \"$1\"[^}]*\}" \
    | grep -oE 'state = variant \{ (On|Off|AdminOn) \}' | grep -oE '(On|Off|AdminOn)' | head -1
}
POLICY_OK=1
for f in "${CORE_ON[@]}"; do
  st=$(flag_state "$f"); [[ "$st" == "On" ]] || { echo -e "${RED}   ✗ $f expected On, got '${st:-MISSING}'${NC}"; POLICY_OK=0; }
done
for f in "${CORE_OFF[@]}"; do
  st=$(flag_state "$f"); [[ "$st" == "Off" ]] || { echo -e "${RED}   ✗ $f expected Off, got '${st:-MISSING}'${NC}"; POLICY_OK=0; }
done
if [[ "$POLICY_OK" != "1" ]]; then
  echo -e "${RED}Flags read back from mainnet:${NC}"
  icp canister call backend list_feature_flags '()' --query -e "$ENV" | sed 's/^/     /'
  die "Feature-flag policy verification FAILED — mainnet flags do not match the core-launch policy above."
fi
ok "Feature-flag policy verified (idea_board/lossless_voting/lossless_lottery/dapp_explorer/early_adopters ON; arcade*/crash/cycles_faucet OFF)"

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
echo "   [ ] Verify core flows read/write correctly (vote/stake/lottery)"
echo
echo "   Rollback insurance — pre-upgrade snapshot retained: $SNAP_ID"
echo "     If state looks wrong, restore it:"
echo "       icp canister stop backend -e $ENV"
echo "       icp canister snapshot restore backend $SNAP_ID -e $ENV"
echo "       icp canister start backend -e $ENV"
echo "     Once verified healthy, free the cycles it holds:"
echo "       icp canister snapshot delete backend $SNAP_ID -e $ENV"
echo "──────────────────────────────────────────────────────────"
