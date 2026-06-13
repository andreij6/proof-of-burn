#!/usr/bin/env bash
# =============================================================================
# PB-240/241 — Crash / Casino smoke test (local network)
#
# Drives the live crash loop on a locally deployed canister: confirms the flag
# is on and the genesis chain is built, watches the round phase advance, reads
# history, and verifies a finished round's provably-fair crash point. Then, if
# the calling identity holds chips (i.e. has staked), it places a bet.
#
# A fresh agent should be able to follow this script and complete a bet round.
#
# Prerequisites:
#   - `icp` CLI on PATH, local replica running, canisters deployed:
#       bash scripts/deploy-local.sh   (enables `crash` + runs admin_init_crash)
#
# Usage:
#   bash scripts/crash-smoke.sh
# =============================================================================

set -euo pipefail

BACKEND="backend"
ENV="local"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
note() { echo -e "${YELLOW}…${NC} $*"; }

call()  { icp canister call "$BACKEND" "$1" "${2:-()}" -e "$ENV"; }
query() { icp canister call "$BACKEND" "$1" "${2:-()}" --query -e "$ENV"; }

echo "== Crash smoke =="

note "casino stats"
STATS=$(query get_casino_stats)
echo "$STATS"
echo "$STATS" | grep -q 'crash_enabled = true' || { echo "crash flag is OFF — run deploy-local.sh"; exit 1; }
echo "$STATS" | grep -q 'chain_initialized = true' || { echo "genesis not built — call admin_init_crash"; exit 1; }
ok "crash live + genesis chain built"

note "watching the round phase advance (~30 s)"
for _ in $(seq 1 30); do
  PHASE=$(query get_crash_round | grep -oE 'phase = "[a-z]+"' | head -1)
  echo "  $PHASE"
  sleep 1
done

note "round history (newest first)"
query 'get_crash_history' '(10)'

RID=$(query 'get_crash_history' '(1)' | grep -oE 'id = [0-9]+' | head -1 | grep -oE '[0-9]+' || true)
if [ -n "${RID:-}" ]; then
  note "verifying round #$RID (provably fair)"
  V=$(query verify_crash_round "($RID)")
  echo "$V"
  echo "$V" | grep -q 'chain_verified = true' && ok "round $RID verifies to the genesis terminal" || echo "verify did not confirm (round may be too fresh)"
fi

note "your casino chips"
ME=$(query get_my_casino)
echo "$ME"
CHIPS=$(echo "$ME" | grep -oE 'available_chips = [0-9_]+' | grep -oE '[0-9_]+' | tr -d '_' || echo 0)
if [ "${CHIPS:-0}" -ge 10 ]; then
  note "you hold $CHIPS chips — waiting for a betting window to place 10 @ 2.00x"
  for _ in $(seq 1 25); do
    if query get_crash_round | grep -q 'phase = "betting"'; then
      call crash_bet '(10, 200)' && ok "bet placed" || echo "bet rejected (round may have just closed)"
      break
    fi
    sleep 1
  done
else
  note "no chips (stake ICP first to mint chips) — skipping the bet"
fi

ok "crash smoke complete"
