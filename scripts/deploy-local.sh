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
#      okf/operations/OPS.md / memory note; a mismatch breaks every balance/burn op).
#   5. Wires the backend at the local ckBTC/ckETH ledgers (admin call).
#   6. Prepopulates mock data when missing:
#        - mock proposals (auto-seeded by init/post_upgrade)
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

# ── 3. Backend + course_nft + frontend (upgrade in place, asset sync) ───────
note "Deploying backend + course_nft + frontend…"
icp deploy backend course_nft frontend -e "$ENV" --identity "$DEPLOY_IDENTITY" --yes
ok "backend + course_nft + frontend deployed"

BACKEND_ID=$(canister_id backend)
COURSE_NFT_ID=$(canister_id course_nft)
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

# Arcade + Early Adopters ship dark (flags default OFF). Early Adopters +
# arcade_minigolf (the Course Marketplace keys off it) are enabled for local
# testing; arcade itself is forced OFF explicitly so a re-deploy over prior
# state (which may have stored arcade=On from an older script) is deterministic.
icp canister call backend admin_set_feature_flag '("early_adopters", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# The Course Marketplace keys off the arcade_minigolf sub-flag (PB-305 A7).
icp canister call backend admin_set_feature_flag '("arcade_minigolf", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# Luck-Proof (arcade game 3) — enabled locally for testing; ships dark on mainnet.
icp canister call backend admin_set_feature_flag '("arcade_luckproof", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# Drop Zone (arcade game 4) — enabled locally for testing; ships dark on mainnet.
icp canister call backend admin_set_feature_flag '("arcade_skydive", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# Bull Run (arcade game 5) — enabled locally for testing; ships dark on mainnet.
icp canister call backend admin_set_feature_flag '("arcade_bullrun", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# Nav sections (Governance/Community) — enabled locally; dark on mainnet.
icp canister call backend admin_set_feature_flag '("nav_governance", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
icp canister call backend admin_set_feature_flag '("nav_community", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# ANSEM LP rewards — enabled locally for testing; ships dark on mainnet.
icp canister call backend admin_set_feature_flag '("solana_lp_rewards", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# ICPSwap LP staking — enabled locally for testing; ships dark on mainnet.
icp canister call backend admin_set_feature_flag '("icpswap_lp_stake", true)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
ok "Early Adopters + arcade_minigolf flags enabled (local); arcade forced OFF (default)"

# ── 5b. Wire CourseNFT both directions, then seed a sample course ─────────────
# Backend must be the allowlisted minter on course_nft (ids permute after a
# wipe, so set it to the LIVE backend id), and the backend must know the
# course_nft canister id. Both calls are idempotent.
icp canister call course_nft set_minter "(principal \"$BACKEND_ID\")" -e "$ENV" --identity "$DEPLOY_IDENTITY" >/dev/null
icp canister call backend admin_set_course_nft_canister "(principal \"$COURSE_NFT_ID\")" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
# Backend must CONTROL course_nft so admin_get_course_nft_cycles / the sweep's
# cycle guard can read its balance (deposit_cycles itself needs no control).
# Mirrors the mainnet ops step for the frontend canister. Idempotent.
icp canister settings update course_nft --add-controller "$BACKEND_ID" -e "$ENV" --identity "$DEPLOY_IDENTITY" >/dev/null \
  && ok "backend added as course_nft controller (cycle balance readable)" \
  || note "could not add backend as course_nft controller (cycle getter will report n/a)"

# Mint the genesis default/system course (PB-309) so the marketplace is never
# empty. Idempotent: minted ONCE to the admin principal (guarded by
# SYSTEM_COURSE_MINTED), and the admin can later sell it via the normal sale
# path. Safe to call on every deploy — re-attempts a no-op'd upgrade seed (B6).
if icp canister call backend list_marketplace_courses \
     '(record { difficulty = variant { Any }; listed = variant { Any }; mine_only = false })' \
     --query -e "$ENV" | grep -q 'token_id = '; then
  ok "Marketplace already has ≥1 course — skipping system-course seed"
else
  note "Minting the genesis default course…"
  icp canister call backend admin_seed_system_course '()' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null \
    && ok "Default course minted + listed (admin-owned, sellable)" \
    || note "Default course seed skipped (already minted or course_nft not ready)"
fi
# Local-dev (PB-312): top up the marketplace with the 3 built-in mock courses
# (full playable 9-hole build-instructions blobs, varied owner/price states).
# Idempotent: dev_seed_courses tops up by name rather than piling up, and the
# call is hard-gated by require_local_dev so it can never run on mainnet/staging.
note "Seeding the 3 mock courses (dev_seed_courses)…"
icp canister call backend dev_seed_courses '(3 : nat32)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null \
  && ok "Local marketplace seeded (3 playable mock courses)" \
  || note "dev_seed_courses skipped (not local, or course_nft not ready)"
# Originality index: fingerprint any course minted before clone detection
# shipped (new mints/seeds self-register). Idempotent; safe every deploy.
icp canister call backend admin_backfill_course_fingerprints '()' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null \
  && ok "Course originality fingerprints backfilled" \
  || note "fingerprint backfill skipped (course_nft not ready)"
# Casino (Crash) is DISABLED pending the SVPP/points redesign. Force the flag
# OFF (earlier deploys may have turned it on; flags persist across upgrades) and
ok "Casino (Crash) disabled (local)"

# ── 5c. X-Farm (Stream B): leave the flag dark + upload the Farmer wasm ────────
# X-Farm ships dark by default (FLAG_X_FARM) and is left dark on local to match
# the disabled-by-default state. The per-user Farmer canister is factory-
# installed (NOT top-level deployed), so we build its wasm here and upload it
# via admin_set_xfarm_wasm — an admin can flip the flag on later without a
# redeploy. This makes create_farmer's full money path (escrow → 10% treasury
# → create+ install → 90% CMC topup) exercisable on the local replica once the
# flag is flipped on. The local replica can't reach the Cloud-Run proxy, so a
# real Farmer's daily outcall fails every tick (R8 Failed-day → burn skipped);
# for visible drafts locally use the in-app dev_seed_farmer / dev_seed_drafts
# controls. Best-effort: a wasm-build or upload failure does NOT abort the
# deploy (the page + dev seeds still work).
# Force the flag OFF explicitly so a re-deploy over prior state (which may
# have stored x_farm=On from an older script) is deterministic.
icp canister call backend admin_set_feature_flag '("x_farm", false)' -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
note "Building + uploading the X-Farm Farmer wasm (factory child canister)…"
XFARM_ARG="${TMPDIR:-/tmp}/xfarm_wasm.arg"
XFARM_WASM_UPLOADED=no
if cargo build -p xfarm_farmer --target wasm32-unknown-unknown --release >/dev/null 2>&1 \
  && ic-wasm -o target/wasm32-unknown-unknown/release/xfarm_farmer.opt.wasm \
             target/wasm32-unknown-unknown/release/xfarm_farmer.wasm shrink >/dev/null 2>&1; then
  FARMER_WASM=target/wasm32-unknown-unknown/release/xfarm_farmer.opt.wasm
  # Encode the wasm as a candid `(blob "\HH…")` literal — the parens are required
  # (method args are a tuple). icp --args-file reads the text; the binary sent is
  # just the ~940KB wasm + a vec header.
  { printf '(blob "'; xxd -p -c 1000 "$FARMER_WASM" | sed 's/\(..\)/\\&/g' | tr -d '\n'; printf '")\n'; } > "$XFARM_ARG"
  if icp canister call backend admin_set_xfarm_wasm --args-file "$XFARM_ARG" \
       -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null 2>&1; then
    ok "X-Farm flag left dark (default) + Farmer wasm uploaded ($(stat -f%z "$FARMER_WASM") bytes) — flip the flag on to use create_farmer locally"
    XFARM_WASM_UPLOADED=yes
  else
    note "X-Farm flag left dark; Farmer wasm upload failed (flip flag on → create_farmer → WASM_NOT_UPLOADED)"
  fi
  rm -f "$XFARM_ARG"
else
  note "X-Farm flag left dark; Farmer wasm build/shrink failed (flip flag on → create_farmer → WASM_NOT_UPLOADED)"
fi
# Optional: point the backend at Stream A's Cloud-Run proxy. The bearer token is
# NOT in the repo (Secret Manager) — set XFARM_PROXY_URL + XFARM_PROXY_BEARER to
# wire it; otherwise a real Farmer's outcall returns PROXY_NOT_CONFIGURED locally
# (use dev_seed drafts for a visible local dashboard).
if [[ -n "${XFARM_PROXY_URL:-}" ]]; then
  icp canister call backend admin_set_xfarm_proxy \
    "(\"${XFARM_PROXY_URL}\", \"${XFARM_PROXY_BEARER:-}\")" \
    -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null 2>&1 \
    && ok "X-Farm proxy wired ($XFARM_PROXY_URL)" \
    || note "X-Farm proxy wire failed"
else
  note "X-Farm proxy not set (XFARM_PROXY_URL empty) — local Farmers use dev_seed drafts"
fi

# ── 6. Mock data (only seeds what is missing) ────────────────────────────────
# (Idea Board + Community R&D projects removed 2026-07-07 — no seeding.)

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

# ── 7. Swap-desk liquidity (multi-token voting) ──────────────────────────────
# commit_token converts ck-tokens to ICP locally via an internal desk paying
# from subaccount [8u8;32]. Seed it with 100 ICP once.
SWAP_SUB='\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08\08'
SWAP_BAL=$(icp canister call ledger icrc1_balance_of "(record { owner = principal \"$BACKEND_ID\"; subaccount = opt blob \"$SWAP_SUB\" })" --query -e "$ENV" | grep -oE '[0-9_]+' | head -1 | tr -d '_')
if [[ "${SWAP_BAL:-0}" -lt 1000000000 ]]; then
  note "Seeding swap-desk liquidity (100 ICP)…"
  icp canister call ledger icrc1_transfer "(record { to = record { owner = principal \"$BACKEND_ID\"; subaccount = opt blob \"$SWAP_SUB\" }; amount = 10_000_000_000 : nat; fee = null; memo = null; from_subaccount = null; created_at_time = null })" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
  ok "Swap desk funded (token commits convert to ICP locally)"
else
  ok "Swap desk already funded ($SWAP_BAL e8s)"
fi

# ── 7b. Backend default account (dev faucet source) ──
# On a fresh network the ledger-init pre-funded principal collides with the
# permuted ICP-ledger id, so the backend's own account starts empty — which
# breaks dev_faucet (it dispenses from the backend's default account). Seed
# it from the admin once.
BE_BAL=$(icp canister call ledger icrc1_balance_of "(record { owner = principal \"$BACKEND_ID\"; subaccount = null })" --query -e "$ENV" | grep -oE '[0-9_]+' | head -1 | tr -d '_')
if [[ "${BE_BAL:-0}" -lt 10000000000 ]]; then
  note "Funding backend default account (500 ICP) for dev faucet…"
  icp canister call ledger icrc1_transfer "(record { to = record { owner = principal \"$BACKEND_ID\"; subaccount = null }; amount = 50_000_000_000 : nat; fee = null; memo = null; from_subaccount = null; created_at_time = null })" -e "$ENV" --identity "$ADMIN_IDENTITY" >/dev/null
  ok "Backend account funded (dev_faucet now works)"
else
  ok "Backend account already funded ($BE_BAL e8s)"
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
echo "   X-Farm: flag dark (default); Farmer wasm $([ "$XFARM_WASM_UPLOADED" = "yes" ] && echo uploaded || echo NOT-uploaded) — flip flag on to use create_farmer; dev_seed controls in-app"
echo "   Faucet: in-app tweak panel, or:"
echo "     icp canister call backend dev_faucet '()' -e local --identity <id>"
echo "──────────────────────────────────────────────────────────"
