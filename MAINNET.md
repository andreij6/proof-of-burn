# Mainnet Go-Live Runbook — Proof of Burn

The authoritative, end-to-end checklist for taking Proof of Burn live on the IC.
Work top to bottom. Nothing here is optional unless marked so.

> Companion docs: [`DEPLOY.md`](DEPLOY.md) (generic deploy steps), [`OPS.md`](OPS.md)
> (ongoing operations), [`SECURITY.md`](SECURITY.md) (security checklist).

---

## 0. Production constants (fill these in)

| Constant | Value |
|---|---|
| **Primary (leader) neuron ID** | `17802688826615984104` |
| Mainnet owner / admin principal | `__FILL_IN__` (your hardware-wallet principal) |
| Backup controller principal | `__FILL_IN__` |
| Default threshold (e8s) | `50000000000` (= 500 ICP) — adjust to taste |
| AI price (e8s) | `5000000` (= 0.05 ICP) |
| Backend canister ID | _(filled after first deploy)_ |
| Frontend canister ID | _(filled after first deploy)_ |

The ICP ledger (`ryjl3-tyaaa-aaaaa-aaaba-cai`), CMC (`rkp4c-7iaaa-aaaaa-aaaca-cai`),
and NNS Governance (`rrkah-fqaaa-aaaaa-aaaaq-cai`) are hard-coded and need no config.

---

## ⚠️ Pre-flight blockers — do these BEFORE the first production deploy

These will silently break mainnet if skipped.

### B1 — Set the production `init_args` in `icp.yaml`

`init_args` is **shared across all environments** (local, staging, production) in
`icp.yaml`. The committed value is the *local dev* config. The backend's `init`
derives its environment from the `owner` principal:

```rust
let is_local = payload.owner.to_text() == "gwrne-...(dev1)...";   // lib.rs init()
let ledger_id = if is_local { <local ledger> } else { ryjl3-...(mainnet) };
```

So if you deploy to mainnet **without changing `owner`**, `is_local` stays `true`,
the canister points at a local ledger that doesn't exist on mainnet, and the NNS
mock fallbacks (PB-110) stay enabled. **You must swap `init_args` to production
values for the production deploy:**

```yaml
# icp.yaml — backend canister, production init_args
init_args: '(record {
  owner = principal "__YOUR_MAINNET_PRINCIPAL__";
  primary_neuron_id = (17802688826615984104 : nat64);
  default_threshold_e8s = (50000000000 : nat64);
  ai_price_e8s = (5000000 : nat64)
})'
```

After deploy, confirm `get_config` shows `is_local = false`,
`ledger_canister_id = ryjl3-tyaaa-aaaaa-aaaba-cai`, and
`primary_neuron_id = 17_802_688_826_615_984_104`.

> Tip: keep the local `init_args` in git and swap only at deploy time, or maintain
> a `icp.prod.yaml`. Do not commit the dev owner as the production owner.

### B2 — Point the frontend at the real neuron

The SPA currently **hard-codes neuron `4821667`** in `src/frontend/src/App.tsx`:
- `register_neuron(4821667n)` (the Follow button registers this neuron)
- `clipboard.writeText("4821667")` (copy button)
- display strings `Neuron 4.821.667` / `VP 4,821,667`

If not fixed, users will be told to follow — and the canister will register — the
**wrong** neuron, while the backend votes with `17802688826615984104`. They must
match. Preferred fix: read `primary_neuron_id` from `get_config()` and render it
everywhere instead of the literal. Minimum fix: replace all three literals with
`17802688826615984104`. (Tracked separately — see "Known gaps" below.)

### B3 — Authorize the canister on the neuron (hotkey)

For the canister to read the neuron and cast votes, the **backend canister
principal must be a hotkey on neuron `17802688826615984104`** (or its controller).
Done after deploy in step 4 — but you must control that neuron to do it. Confirm
now that you hold the neuron's controller key.

### B4 — Decide threshold & confirm fee math

Default threshold is per-proposal flat (`default_threshold_e8s`). Minimum commit is
1 ICP; protocol fee 0.005 ICP + ledger fees. Confirm these are the economics you
want before going live — the threshold cannot be changed per-proposal without an
admin call, and `primary_neuron_id` cannot be changed at all without a code change
(see "Known gaps").

---

## 1. Identity & funding

```bash
# Use a hardware-wallet-backed identity for the owner/controller
icp identity new pob-mainnet --storage-mode=hardware-wallet
icp identity use pob-mainnet
icp identity principal          # → this is your owner/admin principal (B1)

# Fund it: you need ICP (to mint cycles) and/or cycles in a cycles wallet
icp wallet balance
icp ledger balance              # ICP for cycle minting + canister creation
```

Budget: ~2–3 T cycles to create + install both canisters, plus an operating buffer.
The backend self-funds from burns over time, but seed it generously.

---

## 2. Pre-deploy verification

```bash
cargo test -p backend                 # backend unit tests (20+)
npm test --prefix src/frontend        # frontend tests
icp build -e production               # confirms both canisters build
```

Security gate — confirm these are resolved (see `tasks/todo/`):
- [ ] **PB-110** NNS mock fallback gated to local only (no mainnet eligibility/vote bypass)
- [ ] **PB-111** `burn_to_cycles` idempotent (no fund stranding on retry)
- [ ] **PB-112** integration tests green
- [ ] **PB-115** votes use `nns_proposal_id`, not the internal key

Do **not** go live with real funds until PB-110, PB-111, and PB-112 are done.

---

## 3. Deploy

```bash
# After swapping init_args (B1)
icp deploy -e production

# Record the IDs into section 0 of this file
icp canister id backend  -e production
icp canister id frontend -e production
```

Immediately verify environment:

```bash
icp canister call backend get_config --query -e production
# Expect: is_local = false
#         ledger_canister_id = ryjl3-tyaaa-aaaaa-aaaba-cai
#         primary_neuron_id  = 17_802_688_826_615_984_104
#         admins = [ your mainnet principal ]
```

If `is_local = true` or the ledger is the local one, **stop** — your `init_args`
owner was wrong (B1). Since `init` only runs once, you must reinstall (wipes
state — fine pre-launch): `icp canister install backend --mode reinstall -e production`.

---

## 4. Authorize the canister on the leader neuron (hotkey)

```bash
BACKEND=$(icp canister id backend -e production)
echo "Add this principal as a hotkey on neuron 17802688826615984104: $BACKEND"
```

In the NNS dapp (or via `manage_neuron` → `AddHotKey`) on neuron
`17802688826615984104`, add `$BACKEND` as a **hotkey**. Without this:
- `cast_nns_vote` → NNS rejects → proposals go `"failed"` → ICP refunded (no vote lands)
- `check_nns_follow` → cannot read the neuron → follow verification fails

Verify by checking the neuron's hotkeys in the NNS dapp.

---

## 5. Controllers & freezing threshold

```bash
# Two controllers minimum — never single-key control of a value-holding canister
icp canister update-settings backend  --add-controller __BACKUP_PRINCIPAL__ -e production
icp canister update-settings frontend --add-controller __BACKUP_PRINCIPAL__ -e production
icp canister info backend -e production     # confirm ≥2 controllers
```

Freezing threshold is set to 90 days in `icp.yaml` (`freezing_threshold: 7776000`).
Confirm it applied: `icp canister status backend -e production`.

---

## 6. Smoke tests

```bash
BACKEND=$(icp canister id backend -e production)

icp canister call $BACKEND get_eligibility       --query -e production   # tier 0 anon
icp canister call $BACKEND list_active_proposals  --query -e production
icp canister call $BACKEND get_config             --query -e production
icp canister call $BACKEND get_cycle_balance      --query -e production
icp canister call $BACKEND get_treasury_balance           -e production  # 0 fresh
icp canister call $BACKEND get_audit_log '(0:nat64,10:nat64)' --query -e production
icp canister call $BACKEND get_global_stats       --query -e production
```

Frontend (open the printed `frontend` URL):
- [ ] Page loads, dark theme, tagline renders
- [ ] Neuron block shows **17802688826615984104** (not 4821667 — see B2)
- [ ] Proposals load
- [ ] Sign in via Internet Identity (mainnet II `identity.ic0.app`) works
- [ ] Simulator / dev faucet sidebar is **absent** (hidden off-localhost)
- [ ] After follow-verify, ADOPT/REJECT unlocks (Tier 2)

End-to-end with a small real amount (recommended before announcing):
- [ ] Follow the neuron, verify, commit ~1 ICP ADOPT on a live proposal
- [ ] Confirm escrow debit, commitment appears under "Committed"
- [ ] After the cutoff, confirm vote cast + ICP burned (or refunded if threshold missed)

---

## 7. Monitoring (see OPS.md for detail)

```bash
BACKEND_CANISTER_ID=$(icp canister id backend -e production) ENV=production \
  bash scripts/monitor.sh
```

Set a cron (every 15 min) and alert on low cycles / burn anomalies. The backend
also auto-tops-up cycles from burns (`cycle_topup_check`) and the 90-day freezing
threshold is a safety net — but monitor proactively.

---

## 8. Custom domain (optional)

`public/.well-known/ic-domains` already lists `proofofburn.app`. To activate: set
DNS (CNAME → `<frontend-id>.icp0.io`, TXT `_canister-id` → frontend id), then
register via the boundary-node API. See PB-101.

---

## Known gaps to close before/around launch

| Gap | Impact | Tracking |
|---|---|---|
| NNS mock fallback bypass | **Critical** — eligibility/vote bypass on mainnet | PB-110 |
| `burn_to_cycles` not idempotent | **Critical** — can strand committed ICP | PB-111 |
| No real integration tests | **High** — burn saga unverified | PB-112 |
| Votes use internal key not `nns_proposal_id` | Mis-vote once live proposals ingested | PB-115 |
| Frontend hard-codes neuron 4821667 | Users follow wrong neuron | B2 (file a task) |
| Proposals are seeded mocks, not live NNS | Stale/fake proposals | PB-031 v2 |
| `primary_neuron_id` not changeable post-deploy | Can't rotate neuron without reinstall | needs `set_primary_neuron` admin setter |

---

## Rollback / upgrade

- **Upgrade** (preserves stable state): `icp deploy -e production`, then re-run smoke tests.
- **Rollback**: reinstall a previously archived WASM with `--mode upgrade`. Keep every
  released WASM tagged by git SHA. Note: `reinstall` wipes state — never use it once
  funds are live.
