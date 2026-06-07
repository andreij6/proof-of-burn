# Ops Runbook — Proof of Burn

Operational reference for the deployed backend canister. See `DEPLOY.md` for initial deployment steps and `SECURITY.md` for the security checklist.

## Cycles Management

### Primary source: burn-to-cycles on every settled vote

When a proposal passes its threshold and the NNS vote is cast, all committed ICP is routed through the **Cycles Minting Canister** (CMC, `rkp4c-7iaaa-aaaaa-aaaca-cai`) via `burn_to_cycles`. The CMC burns the ICP from the ledger supply and credits cycles directly to the backend canister. This is the primary funding mechanism — governance activity directly sustains the infrastructure.

The flow per settled commitment:
1. Transfer `commitment.amount_e8s` from escrow subaccount → CMC (ledger fee `10_000 e8s`).
2. Call `notify_top_up` with the resulting block index and this canister's ID.
3. CMC mints cycles and credits them to the backend canister immediately.

### Secondary source: treasury auto top-up

The backend also runs a 5-minute timer (`cycle_topup_check`) that tops up from the treasury subaccount when the cycle balance falls below **5 T cycles** — a safety net for periods with no active governance settlements:

1. Checks canister cycle balance via `ic_cdk::api::canister_balance()`.
2. If below 5 T, transfers treasury ICP → CMC (`rkp4c-7iaaa-aaaaa-aaaca-cai`) via `notify_top_up`.
3. Keeps at least 0.0001 ICP in treasury as reserve.

### Manual top-up

```bash
# Check current balance
icp canister call backend get_cycle_balance -e production

# Deposit cycles directly (if treasury is empty)
icp wallet send <backend-canister-id> <amount>
```

### Freezing threshold

Set to **90 days** (`freezing_threshold: 7776000` in `icp.yaml`). The subnet will refuse to accept calls once the canister can no longer sustain this many seconds of idle at the current burn rate — protecting state from being silently wiped.

**Alert target:** Notify ops when cycle balance drops below **10 T cycles**. See PB-102 for alerting setup.

---

## Controllers

A high-value canister **must** have at least two independent controllers. Losing the sole controller key = permanently unupgradeable canister (state preserved but code locked).

### Required controller setup (before mainnet)

```bash
# Add a backup / governance controller
icp canister update-settings backend \
  --add-controller <backup-principal> \
  -e production

# Verify controllers
icp canister info backend -e production
```

**Recommended controller set:**
| Controller | Purpose |
|---|---|
| Deployment identity (hardware key) | Primary upgrade/admin ops |
| Cold backup key | Emergency recovery |
| (Optional) SNS governance | Decentralised upgrade path |

### Rotate a controller

```bash
icp canister update-settings backend \
  --remove-controller <old-principal> \
  --add-controller <new-principal> \
  -e production
```

Never remove the last controller before the replacement is confirmed live.

---

## Audit Log

The canister maintains an append-only `StableLog<AuditLogEntry>` of all deposit, burn, and refund events.

```bash
# Query all audit events (capped at 1000 by the endpoint)
icp canister call backend get_audit_log '(0, 1000)' --query -e production
```

Each entry contains: `timestamp`, `event_type` ("deposit" | "burn" | "refund"), `proposal_id`, `user` principal, `amount_e8s`.

### Export to CSV (for off-chain analysis)

```bash
icp canister call backend get_audit_log '(0, 10000)' --query -e production \
  | python3 scripts/audit_log_to_csv.py > audit_$(date +%Y%m%d).csv
```

---

## Emergency Procedures

### If the canister is near freezing

1. Send cycles immediately: `icp wallet send <canister-id> 10_000_000_000_000`.
2. Check treasury balance via `get_treasury_balance`.
3. Trigger a manual top-up sweep: `admin_trigger_sweep`.

### If a burn settlement fails

Commitments that fail to burn or refund get `FailedBurn` / `FailedRefund` status. The 5-minute retry timer will reattempt these automatically. To force immediate retry:

```bash
icp canister call backend admin_trigger_sweep -e production
```

### If the canister needs to be stopped

```bash
icp canister stop backend -e production
# ... maintenance ...
icp canister start backend -e production
```

Stopping the canister preserves all stable-memory state. The timer will restart automatically on `start`.
