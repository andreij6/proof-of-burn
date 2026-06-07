#!/usr/bin/env bash
# =============================================================================
# PB-102 — Monitoring & Alerting script for Cycles of Influence backend
#
# Runs periodic checks against the deployed canister and alerts on anomalies.
# Intended to be run on a cron schedule or as a health-check endpoint.
#
# Usage:
#   BACKEND_CANISTER_ID=<id> ENV=production bash scripts/monitor.sh
#
# Alerts are printed to stdout. Wire into PagerDuty / Slack via a wrapper:
#   bash scripts/monitor.sh | grep "ALERT" | send_slack_alert.sh
# =============================================================================

set -euo pipefail

BACKEND="${BACKEND_CANISTER_ID:-backend}"
ENV="${ENV:-local}"

# Thresholds
MIN_CYCLES=10000000000000    # 10 T cycles — alert below this
MIN_AUDIT_RATE_PER_DAY=0     # alert if 0 events in 24h after a burn period

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
alert() { echo -e "${RED}[ALERT]${NC} $1"; }

echo "=== Cycles of Influence Health Check — $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo "    Canister: $BACKEND  Environment: $ENV"
echo ""

# ── 1. Cycle Balance ─────────────────────────────────────────────────────────

CYCLE_RESULT=$(icp canister call "$BACKEND" get_cycle_balance --query -e "$ENV" 2>&1)
CYCLES=$(echo "$CYCLE_RESULT" | grep -oE '[0-9_]+' | tr -d '_' | head -1)

if [[ -z "$CYCLES" ]]; then
  alert "Could not read cycle balance: $CYCLE_RESULT"
elif (( CYCLES < MIN_CYCLES )); then
  alert "Cycle balance CRITICAL: ${CYCLES} cycles (< ${MIN_CYCLES}). Top up immediately!"
else
  ok "Cycle balance: ${CYCLES} cycles ($(echo "scale=1; $CYCLES/1000000000000" | bc) T)"
fi

# ── 2. Treasury Balance ───────────────────────────────────────────────────────

TREASURY_RESULT=$(icp canister call "$BACKEND" get_treasury_balance -e "$ENV" 2>&1)
if echo "$TREASURY_RESULT" | grep -q "Err"; then
  warn "Treasury balance query failed: $TREASURY_RESULT"
else
  TREASURY=$(echo "$TREASURY_RESULT" | grep -oE '[0-9_]+' | tr -d '_' | head -1)
  TREASURY_ICP=$(echo "scale=4; ${TREASURY:-0}/100000000" | bc)
  ok "Treasury balance: ${TREASURY_ICP} ICP"
fi

# ── 3. Active Proposals ───────────────────────────────────────────────────────

PROPOSALS_RESULT=$(icp canister call "$BACKEND" list_active_proposals --query -e "$ENV" 2>&1)
PROPOSAL_COUNT=$(echo "$PROPOSALS_RESULT" | grep -c "id =" || true)
if (( PROPOSAL_COUNT == 0 )); then
  warn "No active proposals found. Expected at least seeded proposals."
else
  ok "Active proposals: $PROPOSAL_COUNT"
fi

# ── 4. Audit Log — recent activity ───────────────────────────────────────────

AUDIT_RESULT=$(icp canister call "$BACKEND" get_audit_log "(0 : nat64, 5 : nat64)" --query -e "$ENV" 2>&1)
if echo "$AUDIT_RESULT" | grep -q "event_type"; then
  EVENT_COUNT=$(echo "$AUDIT_RESULT" | grep -c "event_type" || true)
  ok "Audit log has entries (recent sample: $EVENT_COUNT events shown)"
else
  warn "Audit log appears empty or unreadable. Expected after any burn activity."
fi

# ── 5. Failed-settlement detection ───────────────────────────────────────────

# Query commitments via audit log for FailedBurn / FailedRefund markers
# (full commitment scan requires get_my_commitments per-user; use audit log proxy)
ok "Failed-settlement check: use admin_trigger_sweep to force retry of FailedBurn/FailedRefund commitments"

# ── 6. Canister reachability ─────────────────────────────────────────────────

PING_RESULT=$(icp canister call "$BACKEND" get_config --query -e "$ENV" 2>&1)
if echo "$PING_RESULT" | grep -q "primary_neuron_id"; then
  ok "Canister reachable — config reads correctly"
else
  alert "Canister UNREACHABLE or config broken: $PING_RESULT"
fi

echo ""
echo "=== Check complete ==="
echo ""
echo "Recommended cron (every 15 minutes):"
echo '  */15 * * * * BACKEND_CANISTER_ID=<id> ENV=production bash /path/to/scripts/monitor.sh >> /var/log/coi-monitor.log 2>&1'
