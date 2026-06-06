# Deployment Runbook — Proof of Burn

Step-by-step guide for deploying the Proof of Burn dapp to ICP mainnet (`-e production`).

## Prerequisites

| Item | Command | Notes |
|---|---|---|
| `icp` CLI installed | `icp --version` | Must be ≥ current version in icp.yaml recipes |
| Funded named identity | see below | **Never** deploy from anonymous or test identity |
| Cycles balance | see below | Backend needs ~2 T to deploy + reserve |
| ICP balance | `icp wallet balance` | For ledger init args / canister creation |

---

## 1. Identity Setup

```bash
# Create a named deployment identity (hardware wallet recommended)
icp identity new deploy-mainnet --storage-mode=hardware-wallet
# Or software key for testing:
icp identity new deploy-mainnet --storage-mode=plaintext

# Set as active
icp identity use deploy-mainnet

# Confirm principal
icp identity get-principal
# → save this; it becomes the 'owner' in init_args
```

**Critical:** The deploying principal becomes `admins[0]` in the canister config. Keep this key secure and add a backup controller immediately after deploy (see PB-081 / OPS.md).

---

## 2. Pre-deploy Checks

```bash
# Confirm balances
icp wallet balance       # cycles
icp ledger balance       # ICP

# Run all tests
cargo test -p backend
npm test --prefix src/frontend

# Confirm canister candidates build
icp build -e production
```

---

## 3. Deploy

```bash
# Deploy backend + frontend to IC mainnet
icp deploy -e production

# Expected output:
# ✅ backend:  <canister-id-1>
# ✅ frontend: <canister-id-2>
```

The `icp deploy` command reads `icp.yaml` environments → `production` → `canisters: [backend, frontend]` (ledger is local-only; mainnet uses `ryjl3-tyaaa-aaaaa-aaaba-cai`).

The backend `init_args` in `icp.yaml` uses the local dev identity principal as `owner`. **Update the `owner` field to your mainnet principal before deploying:**

```yaml
# icp.yaml — update owner before production deploy
init_args: '(record { owner = principal "<YOUR_MAINNET_PRINCIPAL>"; ... })'
```

---

## 4. Post-deploy: Add Backup Controller

```bash
# Add a second controller immediately
icp canister update-settings backend \
  --add-controller <BACKUP_PRINCIPAL> \
  -e production

# Verify
icp canister info backend -e production
# → Should show 2+ controllers
```

---

## 5. Smoke Tests

Run these checks immediately after deploy:

```bash
BACKEND_ID=$(icp canister id backend -e production)

# 1. Eligibility returns tier 0 for anonymous
icp canister call $BACKEND_ID get_eligibility --query -e production

# 2. Active proposals listing returns seeded proposals
icp canister call $BACKEND_ID list_active_proposals --query -e production

# 3. Config confirms correct primary neuron and threshold
icp canister call $BACKEND_ID get_config --query -e production

# 4. Cycle balance looks healthy (expect > 1 T)
icp canister call $BACKEND_ID get_cycle_balance --query -e production

# 5. Treasury balance (should be 0 on fresh deploy)
icp canister call $BACKEND_ID get_treasury_balance -e production

# 6. Audit log is empty on fresh deploy
icp canister call $BACKEND_ID get_audit_log '(0 : nat64, 10 : nat64)' --query -e production
```

All 6 should return without error.

---

## 6. Frontend Verification

Visit the frontend URL (printed by `icp deploy`) in a browser. Confirm:

- [ ] Page loads with correct branding and dark theme
- [ ] Neuron identity block shows "Neuron 4,821,667"
- [ ] Proposals load (3 seeded proposals visible)
- [ ] "Sign in" opens Internet Identity
- [ ] After sign-in, neuron follow prompt appears (Tier 1)

---

## 7. Upgrade Path

To upgrade canister code after changes:

```bash
# Build and upgrade (preserves all stable-memory state)
icp deploy -e production

# Verify state survived upgrade
icp canister call $BACKEND_ID list_active_proposals --query -e production
icp canister call $BACKEND_ID get_audit_log '(0 : nat64, 5 : nat64)' --query -e production
```

---

## 8. Rollback

There is no automatic rollback on ICP. To revert:

```bash
# Install a specific WASM build
icp canister install backend \
  --mode upgrade \
  --wasm target/wasm32-unknown-unknown/release/backend.wasm.gz \
  -e production
```

Always keep the previous WASM artifact. Consider versioning WASM builds by git tag.

---

## Canister IDs (fill in after first deploy)

| Canister | Mainnet ID |
|---|---|
| backend | `—` |
| frontend | `—` |

*Update this table after the initial deploy.*
