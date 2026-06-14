# Configurations

This document lists every important setting that affects the Cycles of Influence
canister and frontend — what it does, where it lives, and what changing it
breaks. Use it as a reference when deploying, debugging, or proposing a
parameter change.

Source-of-truth locations:

- **Backend constants** — `src/backend/src/lib.rs` (top of file, `init()`,
  timer / treasury helpers, admin setters)
- **Backend init args** — `icp.yaml` (`init_args` for each canister)
- **Workspace build profile** — `Cargo.toml`
- **Frontend CSS variables** — `src/frontend/src/index.css`
- **Frontend runtime constants** — `src/frontend/src/App.tsx`,
  `src/frontend/src/test/utils.test.ts`

---

## 1. Primary neuron (the one users follow)

**Setting:** `Config.primary_neuron_id: u64`
**Default value:** `4821667` (local dev)
**Mainnet override:** `17_802_688_826_615_984_104`
**Where it's set:**

- `icp.yaml` → backend `init_args` → `primary_neuron_id`
- `lib.rs:21` — `MAINNET_PRIMARY_NEURON_ID` constant (auto-applied on
  mainnet, see [is_local flag](#8-is_local-flag))
- `lib.rs:347` — `init()` calls `resolve_primary_neuron_id(is_local, ...)`
  to choose between the `init_args` value and the mainnet constant

**What it controls:** The neuron ID that `register_neuron` /
`verify_follow` checks each user's neuron against. Users must follow this
neuron on the NNS to register (Tier 2 → Tier 3 eligible).

**Why two values exist:** Local dev uses a test neuron; mainnet uses a real
NNS neuron (the project's chosen "leader" neuron). On mainnet the
`init_args` value is **ignored** — the constant is authoritative. On local,
the value from `icp.yaml` is used so the same wasm can be redeployed
without touching code.

**How to change it on mainnet:**

- Edit the `MAINNET_PRIMARY_NEURON_ID` constant in `lib.rs` and rebuild,
  **or**
- Add an `admin_set_primary_neuron` update method (no such setter exists
  today — would need a code change)

---

## 2. Threshold (default ICP per proposal)

**Setting:** `Config.default_threshold: u64` (e8s)
**Initial value:** `200_000_000` (2 ICP) — set in `icp.yaml`, applied to live NNS
proposals ingested by `fetch_live_proposals`. The in-code `CONFIG` default mirrors
it but is overwritten by `init()`.
**Where it's set:**

- `icp.yaml` → `default_threshold_e8s` (initial value at install)
- `lib.rs` — in-code `CONFIG` default (mirror; overwritten at init)
- **`admin_set_default_threshold(e8s)`** — admin update method to change it at
  runtime (no redeploy)

**What it controls:** The default ICP threshold a proposal must reach before the
canister votes. Applied to all future proposals and (on each admin change)
re-applied to every currently open/met proposal with their status recomputed.

**How to change it — no redeploy needed:**

```bash
# Set the threshold to 2 ICP (owner/admin identity only)
icp canister call backend admin_set_default_threshold '(200_000_000 : nat64)'
```

Validations: rejects values below `MIN_COMMIT_E8S` (1 ICP) or above
`MAX_COMMIT_E8S`. Terminal proposals (voted/settled/abstained/failed) are not
touched. The initial value still comes from `icp.yaml` at first install.

---

## 3. AI price (per-AI-review cost)

**Setting:** `Config.ai_price_e8s: u64`
**Default value:** `5_000_000` (0.05 ICP)
**Where it's set:** `icp.yaml` → `ai_price_e8s`, `lib.rs:265`

**What it controls:** The cost in ICP (e8s) the canister charges for an
AI-generated proposal review. Charged as part of the commit flow.

**Note:** This field exists in config but the AI review feature itself
may not be wired up. Check the current commit flow before relying on
this number.

---

## 4. Admins (who can call admin methods)

**Setting:** `Config.admins: Vec<Principal>`
**Default value:** `[]` (empty in `MEMORY_MANAGER` default),
seeded to `[payload.owner]` in `init()`
**Where it's set:**

- `icp.yaml` → `init_args.owner`
- `lib.rs:341-355` — `add_admin`, `remove_admin` update methods (gated by
  `require_admin`)
- `lib.rs:362` — last-admin guard (`if config.admins.len() <= 1`)

**What it controls:** Who can:

- Set proposal deadlines (`admin_set_proposal_deadline`)
- Trigger sweeps (`admin_trigger_sweep`)
- Add / remove other admins
- Read the treasury balance (`get_treasury_balance`, gated since F-107)

**How to change it:**

```bash
# Add a second admin
icp canister call backend add_admin '(principal "...")'

# Remove an admin (cannot remove the last one)
icp canister call backend remove_admin '(principal "...")'
```

**Critical:** The deploying principal (`owner` in `init_args`) becomes
`admins[0]`. Keep this key secure and add a backup admin immediately
after deploy. See `DEPLOY.md` §4.

---

## 5. Ledger canister ID

**Setting:** `Config.ledger_canister_id: Principal`
**Default values:**

- Local dev: `a5dhi-k7777-77775-aaabq-cai` (local ICRC-1 ledger from
  `icp.yaml`'s `ledger` canister)
- Mainnet: `ryjl3-tyaaa-aaaaa-aaaba-cai` (the canonical ICP ledger)
**Where it's set:**

- `lib.rs:347-355` — chosen at `init()` based on the `is_local` flag
- `icp.yaml` → `init_args.ledger_canister_id` (optional override)

**What it controls:** Where ICP is moved during commits, refunds, and
treasury top-ups. **Never** point this at a non-ICP ledger.

**How to change it:** Override via `init_args.ledger_canister_id` at
deploy time, or by code change to the `is_local` decision in `init()`.

---

## 6. Min / max commit amounts

**Settings (compile-time constants):**

| Constant | Value | Where |
|---|---|---|
| `MIN_COMMIT_E8S` | `100_000_000` (1 ICP) | `lib.rs:15` |
| `MAX_COMMIT_E8S` | `100_000_000_000_000` (1,000,000 ICP) | `lib.rs:16` |

**What they control:** The `[1 ICP, 1,000,000 ICP]` window a user can
commit to a single proposal. Below the minimum or above the maximum
returns `BELOW_MINIMUM` / `EXCEEDS_GLOBAL_CAP` from `commit()`.

**How to change them:** Edit the constants and rebuild. No admin setter.

---

## 7. Storage quotas

**Settings (compile-time constants):**

| Constant | Value | Where |
|---|---|---|
| `MAX_COMMITMENTS_PER_USER` | `25` | `lib.rs:13` |
| `MAX_PROPOSALS` | `500` | `lib.rs:14` |
| `MAX_NEURON_ID` | `u64::MAX / 2` | `lib.rs:17` |

**What they control:**

- `MAX_COMMITMENTS_PER_USER` — how many *pending* commitments one user
  can have open at once. Returns `TOO_MANY_COMMITMENTS` past the cap.
- `MAX_PROPOSALS` — total proposals in stable storage. `seed_mock_proposals`
  refuses to seed if at quota.
- `MAX_NEURON_ID` — upper sentinel for `register_neuron` input validation
  (rejects 0 and values > `MAX_NEURON_ID`).

**How to change them:** Edit the constants and rebuild. Consider
upgrade-time migration if you raise `MAX_PROPOSALS` past a previously-
written keyspace boundary.

---

## 8. `is_local` flag

**Setting:** `Config.is_local: bool`
**Default value:** `false`
**Where it's set:** `lib.rs:347` — derived at `init()` from whether the
deploying owner's principal matches the local dev identity
(`gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe`).

**What it controls:** Gates F-101 / F-102 NNS mock fallbacks. When
`is_local = true`, a rejected `get_full_neuron` or `manage_neuron` call
returns a dev-friendly fallback (so local dev works without a real NNS
canister). When `false` (mainnet), the same rejection returns `Err` —
required for mainnet safety.

**How to change it:** Set the correct deploying principal in `init_args`
on mainnet, or override `resolve_primary_neuron_id` and the
`is_local` detection in `init()`.

**Critical:** This flag persists in `Config` so the gate survives
upgrades. It is **not** re-derived per call (re-deriving per call would
re-introduce the F-101 / F-102 mainnet bypass).

---

## 9. Cycle top-up (treasury → CMC)

**Settings (compile-time constants and balances):**

| Setting | Value | Where |
|---|---|---|
| Cycle floor for top-up | `5_000_000_000_000` (5 T cycles) | `lib.rs:1726` |
| Min treasury balance to top-up | `1_000_000_000` (10 ICP) | `lib.rs:1749` |
| Treasury subaccount | `[1u8; 32]` | `lib.rs:733` |
| Treasury → CMC transfer fee | `10_000` e8s | `lib.rs:1759` |

**What it controls:** When the canister's cycle balance falls below
5 T, `cycle_topup_check` sweeps the treasury subaccount to the CMC and
calls `notify_top_up`. The treasury is funded by the 50% burn share of
settled proposals (commits themselves are zero-fee) and other protocol inflows.

**How to change it:** Edit the constants and rebuild. No admin setter
for the thresholds.

---

## 10. Sweep / retry timer

**Setting:** `set_timer_interval` period
**Default value:** `300` seconds (5 minutes)
**Where it's set:** `lib.rs:1792` — `setup_timers()`

**What it controls:** How often the canister runs:

- `proposal_sync_sweep` — close proposals past their deadline
- `retry_failed_settlements` — retry `FailedBurn` / `FailedRefund`
  commitments with persisted `cmc_block_index`
- `cycle_topup_check` — top up cycles from treasury if below floor

**How to change it:** Edit the `Duration::from_secs(...)` and rebuild.

---

## 11. Deadline cutoff

**Setting:** `CUTOFF_NANOS`
**Default value:** `3_600_000_000_000` (1 hour in nanoseconds)
**Where it's set:** `lib.rs:435`

**What it controls:** The 1-hour buffer between "deadline" and "actual
close." A deadline inside this window would underflow the
`deadline - cutoff` subtraction in `commit()` and `proposal_sync_sweep()`,
wrapping to a huge value and leaving the proposal permanently open.
`admin_set_proposal_deadline` rejects any deadline at-or-below
`now + cutoff` with `DEADLINE_BELOW_CUTOFF`.

**How to change it:** Edit the constant and rebuild. If you change it,
verify the cutoff constant in tests still matches (`test_cutoff_constant_matches_commit_check`).

---

## 12. Ledger transfer fee

**Setting:** Hard-coded `10_000` e8s (0.0001 ICP) per transfer
**Where it's set:** Multiple call sites in `lib.rs` — every
`call_ledger_transfer(... Some(10_000))` invocation.

**What it controls:** The fee paid to the ledger on every `icrc1_transfer`
call (commit/deposit transfer, burn transfer, refund, treasury top-up). Must match
the ICRC-1 ledger's `transfer_fee`.

**How to change it:** Find-and-replace `10_000` and rebuild. There is
no single constant; if you change it, grep all call sites.

---

## 13. Freezing threshold (cycles)

**Setting:** `freezing_threshold: 7776000` (90 days in seconds)
**Where it's set:** `icp.yaml` → backend `settings`

**What it controls:** The canister freezes if its cycle balance can't
sustain 90 days of idle. The on-chain `cycle_topup_check` timer refills
from the treasury before this is hit. The comment in `icp.yaml` warns:
**never set below 30 days** for a value-holding canister.

**How to change it:** Edit `freezing_threshold` in `icp.yaml` and
redeploy.

---

## 14. Frontend: local II URL detection

**Setting:** `identityProviderUrl` resolution
**Where it's set:** `src/frontend/src/App.tsx:300-302`

```ts
const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
const identityProviderUrl = isLocal
  ? "http://id.ai.localhost:8000"
  : "https://identity.ic0.app";
```

**What it controls:** Where the "Sign in" button redirects. Local dev
sends users to a local Internet Identity; mainnet sends them to the
canonical `identity.ic0.app`.

**How to change it:** Edit the strings in `App.tsx`. No rebuild needed
for the Vite dev server; rebuild + redeploy asset canister for
production.

---

## 15. Frontend: theme CSS variables

**Where they live:** `src/frontend/src/index.css` (lines 23-50)

| Variable | Value (dark) | Role |
|---|---|---|
| `--burn` | `#FF6A1F` | Primary accent (orange flame) |
| `--burn-950` | `#2A1409` | Deep ember background tint |
| `--char-950` | `#0E0E10` | Page background |
| `--fg` | (light) | Primary text |
| `--fg-2` / `--fg-3` | (lighter) | Secondary / tertiary text |
| `--border` | (subtle) | Default border |
| `--nav-h` | `56px` | Header height |

**What they control:** All colors, border radius, and layout dimensions
across the app. Changing `--burn` propagates to every flame icon, the
header logo border, the Tier 3 strip, and the global stats strip.

**How to change them:** Edit the variables in `index.css`. No rebuild
needed for the Vite dev server; rebuild + redeploy asset canister for
production.

---

## 16. Brand strings

| Setting | Value | Where |
|---|---|---|
| Page title (browser tab) | `Cycles of Influence - Alpha` | `src/frontend/index.html:10` |
| Header brand text | `Cycles of Influence - Alpha` | `src/frontend/src/App.tsx:782` |

**How to change them:** Edit both files. The header text is in the JSX;
the page title is in the HTML head.

---

## 17. Deployer principal (init args `owner`)

**Setting:** `InitPayload.owner: Principal`
**Default value (in `icp.yaml`):** `gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe` (the local dev identity)
**Where it's set:** `icp.yaml` → backend `init_args.owner`

**What it controls:**

- Becomes `admins[0]` at init time
- Drives the `is_local` detection (matches the local dev principal)
- Critical to update before mainnet deploy — see `DEPLOY.md` §3

**How to change it:** Edit `icp.yaml` before deploying. The deploying
identity's principal should be the value used.

---

## Summary table

| # | Setting | Where | Change method |
|---|---|---|---|
| 1 | Primary neuron ID | `icp.yaml` + `lib.rs:21` | Edit yaml or constant |
| 2 | Default threshold (100 ICP) | `icp.yaml` + `lib.rs:265` | Edit yaml |
| 3 | AI price | `icp.yaml` + `lib.rs:265` | Edit yaml |
| 4 | Admins | `icp.yaml.owner` + `add_admin` | Edit yaml or admin call |
| 5 | Ledger ID | `lib.rs:347-355` | Code change (auto by env) |
| 6 | Min/max commit | `lib.rs:15-16` | Code change + rebuild |
| 7 | Storage quotas | `lib.rs:13-14, 17` | Code change + rebuild |
| 8 | `is_local` flag | `lib.rs:347` | Auto from owner principal |
| 9 | Cycle top-up | `lib.rs:733, 1726, 1749` | Code change + rebuild |
| 10 | Sweep timer | `lib.rs:1792` | Code change + rebuild |
| 11 | Deadline cutoff | `lib.rs:435` | Code change + rebuild |
| 12 | Ledger fee | many call sites | Find-replace + rebuild |
| 13 | Freezing threshold | `icp.yaml` | Edit yaml |
| 14 | II URL | `App.tsx:303-307` | Code change + rebuild |
| 15 | Theme CSS | `index.css` | Code change + rebuild |
| 16 | Brand strings | `index.html` + `App.tsx` | Code change + rebuild |
| 17 | Deployer principal | `icp.yaml.owner` | Edit yaml |
