# X-Farm — Reuse Map

Line numbers approximate (2026-06-19) — verify before building.

## Money path (burn + treasury)
| Need | Reuse | Where |
|---|---|---|
| **Burn ICP → cycles** (the 90% leg, D2) | `settle_burn_split` backend-cycles leg: `call_cmc_topup_transfer` + `notify_cmc_topup` + journal `cmc_block_index` | `lib.rs:2260`, `2347`, `2481` |
| **10% → treasury** | `call_ledger_transfer(ledger, escrow_sub, TREASURY_SUBACCOUNT, …)` — same as `submit_dapp`/`submit_idea` | `lib.rs` (Explorer/Idea path) |
| Per-caller escrow subaccount | `derive_*_subaccount` family → clone `derive_xfarm_subaccount` | `lib.rs:1818`, `5456`, `9637` (dup cluster B5) |
| Charge-then-insert ordering | `submit_dapp` / `post_idea` escrow flow | `lib.rs:10481`, `5569` |
| Deposit address | `get_idea_post_deposit_address` / `get_explorer_deposit_address` | `lib.rs:5560`, `…` |

## LLM transport (the whole outcall stack)
| Need | Reuse | Where |
|---|---|---|
| **Non-replicated HTTPS outcall** design | ai-proposal-review Part D (`is_replicated:false`, `max_response_bytes` cap, cycle math) | `ideas/ai-proposal-review/02-backend-and-tasks.md` §D |
| **Cloud-Run proxy → Gemini** (key off-chain, bearer auth, budget-cap/rotate) | ai-proposal-review D4b | `ideas/ai-proposal-review/README.md` D4 |
| Gemini `generateContent` + `responseSchema` + URL/Google-Search grounding | ai-proposal-review findings #2/#3 | `ideas/ai-proposal-review/README.md` §findings |
| 2-call schema+tool reformat (if they can't coexist) | ai-proposal-review Phase 0.1 fallback | `ideas/ai-proposal-review/02-backend-and-tasks.md` §D |
| **Prompt-injection defense** (server-grounded; untrusted-data framing) | ai-proposal-review §C ("never trust a client prompt") | `ideas/ai-proposal-review/02-backend-and-tasks.md` §C |

> **Build the Cloud-Run proxy once; x-farm adds `/v1/tweets`, ai-proposal-review
> adds `/v1/review`.** The two features are mutually reinforcing — ship either
> first and the other reuses the proxy.

## Lifecycle + patterns
| Need | Reuse | Where |
|---|---|---|
| Daily autonomous trigger | IC `set_timer_interval` / existing sweep+heartbeat (`process_proposal_cutoff`, `sweep_play_sessions`) | `lib.rs:4171`, `16503` |
| Expiry purge / delete-on-end | proposal-discussions "delete on settle" pattern; `process_proposal_cutoff` hook | `ideas/proposal-discussions/02-backend-and-tasks.md` §D |
| Feature flag + dark launch | `FLAG_*` + `feature_visible`; `scripts/deploy-prod.sh` CORE_OFF | `lib.rs:4904–4918` |
| Bounded history (anti-repetition) | per-farmer bounded `Draft` store (mirror bounded audit/log patterns) | new |
| Share on X | `shareProposalOnX` `twitter.com/intent/tweet` pattern | `App.tsx:1007` |
| Compose + fee dialog shell | Explorer submit-listing modal (`MODAL_OVERLAY/CARD`, token-picker, 2-step pay) | `Explorer.tsx` |
| Audit logging | `audit(event_type, …)` once extracted (dup cluster B4) | `lib.rs` B4 |

## Frontend
| Need | Reuse | Where |
|---|---|---|
| Page skeleton + primitives | `ui.tsx` (`Btn`, `Chip`, `Eyebrow`, `Icon`, `MoreInfo`); page anatomy | `ui.tsx`, frontend-dev skill |
| Escrow 2-step pay flow | `useEscrowPay` (once extracted, dup cluster F12) or clone Explorer modal | `Explorer.tsx` |
| Ledger actor + transfer-error parsing | `mkLedgerActor` / `describeTransferError` (once extracted, F1/F3) | `ledger.ts`/`candid.ts` (to extract) |
| Number formatting | `fmtICP` (dup cluster F5) | `ui.tsx:265` |
| Dev controls | `usePageDevControls` | `ui.tsx` |

## Net-new (no precedent in the repo)
- **Factory + per-user canister lifecycle** — `create_canister` / `install_code` /
  `deposit_cycles` / `stop_canister` / `delete_canister` (cleanup of depleted
  Farmers — no cycle reclamation: cycles deplete to ~0 by design, D2/finding #7). The
  repo is a single backend; it never creates canisters. (D-arch per-user only.)
- **A second canister wasm** (the Farmer) the factory installs. (D-arch per-user.)
- **IC timers driving daily autonomous generation** — sweeps exist, but a
  per-canister daily timer firing an LLM outcall is new.
- The **persona + tweet-draft model** + bounded draft history + regenerate.

## Patterns to copy wholesale
- Ship dark behind `x_farm` (default Off), enable in `deploy-prod.sh`.
- `dev_*` seed endpoints gated by `require_local_dev` for offline UI states.
- Commit + deploy to local after every change; mainnet gated per-deploy.
- **Build on the to-be-extracted shared helpers** (`cmc_topup_leg`, `useEscrowPay`,
  `mkLedgerActor`, `audit`) rather than cloning the duplication hotspots — see
  `docs/duplication-review-2026-06-19.md`. X-Farm is a 4th consumer of the burn
  leg + escrow flow; implement it on the extracted primitives, not by cloning.