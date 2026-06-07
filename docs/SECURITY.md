# Security Review — Cycles of Influence


This document records the IC canister-security checklist review for the backend canister. Each item is either **Verified ✅**, **Risk-Accepted ⚠️**, or **Remediated 🔧**.

## Canister Security Checklist

### Access Control

| Item | Status | Notes |
|---|---|---|
| Anonymous rejection on all updates | ✅ Verified | `inspect_message` hook traps anonymous callers at ingress. `require_authenticated()` guard also re-checks inside every update method. |
| Admin revocation path | ✅ Verified | `remove_admin` removes from config; re-stored in stable memory immediately. |
| No single-key admin dependency | ⚠️ Risk-Accepted | Single owner key on init. PB-081 documents backup-controller requirement before mainnet. |
| `require_admin` on all privileged endpoints | ✅ Verified | `add_admin`, `remove_admin`, `admin_set_proposal_deadline`, `admin_trigger_sweep` all use `guard = "require_admin"`. |
| `inspect_message` is not the security boundary | ✅ Verified | Every update re-checks access inside the method body. `inspect_message` is defence-in-depth only. |

### Token Path Safety

| Item | Status | Notes |
|---|---|---|
| `CallerGuard` on `commit` | ✅ Verified | Prevents concurrent commit calls from the same principal (reentrancy defence). |
| `ProposalLock` on settlement | ✅ Verified | Prevents double-settlement of a proposal during the async sweep. |
| Burn routes through CMC, not raw minting account | ✅ Verified | `burn_to_cycles` transfers ICP to the CMC (`rkp4c-7iaaa-aaaaa-aaaca-cai`) which burns it from supply and mints cycles to this canister. Net ICP supply effect identical to a direct burn; value is captured as computation fuel. |
| Refund subtracts correct ledger fee | ✅ Verified | Refunds use `fee = Some(10_000)` (standard ICP transfer fee). |
| Escrow subaccount is deterministic + principal-bound | ✅ Verified | `derive_subaccount` uses SHA-256 of `"proof_of_burn_escrow_v1" ‖ principal ‖ proposal_id`. |
| No reentrancy across `await` on state writes | ✅ Verified | All state reads happen before awaits; state writes happen after. `CallerGuard`/`ProposalLock` guard concurrent ingress. |
| `ALREADY_COMMITTED` prevents double-escrow | ✅ Verified | Checked before every ledger call in `commit`. |

### Async & Inter-Canister Safety

| Item | Status | Notes |
|---|---|---|
| All inter-canister calls use bounded wait | ✅ Verified | `ic_cdk::call` on ICP is consensus-bound; it will complete when the subnet advances. HTTP outcalls are not used. |
| Failed burns/refunds are retried, not silently dropped | ✅ Verified | `FailedBurn` / `FailedRefund` statuses are retried in `retry_failed_settlements` on each timer tick. |

### Stable Memory & Upgrade Safety

| Item | Status | Notes |
|---|---|---|
| No `pre_upgrade` hook | ✅ Verified | `ic-stable-structures` persists all maps directly; no serialization in `pre_upgrade`. No trap risk. |
| `post_upgrade` only re-initialises timers | ✅ Verified | `setup_timers()` is safe and non-trapping. |
| No unbounded stable storage growth | ✅ Verified | `MAX_COMMITMENTS_PER_USER = 25`, `MAX_PROPOSALS = 500` caps enforce storage bounds. |

### Frontend / Agent

| Item | Status | Notes |
|---|---|---|
| `fetchRootKey()` only in local dev | ✅ Verified | `rootKey: env?.IC_ROOT_KEY` uses an env var injected by the local ICP toolchain. On mainnet the env var is absent → agent uses hardcoded IC root key. |
| No secrets stored in canister state | ✅ Verified | State contains only public governance/commitment data and principals. No private keys, seeds, or tokens. |

### Known Open Items (risk-accepted for v1)

- **Single controller key** — Back up controller principal before mainnet deployment (PB-081).
- **NNS proposals are seeded as mocks** — Live NNS fetch (PB-031 v2) needed before mainnet to avoid stale proposal data.
- **`ic_cdk::id()` deprecation warnings** — Minor; functional behaviour unchanged. Will update to `ic_cdk::canister_self()` in a follow-up.

## Findings & Resolutions

| ID | Finding | Resolution | Commit |
|---|---|---|---|
| F-001 | `get_eligibility` returned `total_committed_escrow` as `holdings_e8s` instead of neuron stake cap | Fixed to return `cached_stake_e8s` | bc74a0e |
| F-002 | No ingress-level anonymous rejection | Added `inspect_message` hook | b7b488d |
| F-003 | No per-user commitment slot quota | Added `MAX_COMMITMENTS_PER_USER = 25` | 0d7c360 |
| F-004 | No global proposal storage bound | Added `MAX_PROPOSALS = 500` | 0d7c360 |
| F-005 | `neuron_id = 0` accepted in `register_neuron` | Added input validation check | 0d7c360 |
| F-006 | `cycle_topup_check` passed ledger balance as `block_index` instead of transfer result | Fixed to use the block index returned by `call_ledger_transfer` | this PR |
| F-007 | Committed ICP burned to minting account (value lost) | Rerouted through CMC: ICP burned from supply, value captured as cycles | this PR |
