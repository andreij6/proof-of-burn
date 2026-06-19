# AI Proposal Review — Reuse Map

Exact existing code this feature clones/extends. Line numbers approximate
(2026-06-19); confirm before building.

## Fee, quote & escrow (the Explorer paid-listing path)
| Need | Reuse | Where |
|---|---|---|
| USD→token quote | `explorer_usd_rate_e8s`, `explorer_quote_amount` | `lib.rs` ~9687/9564 |
| Quote struct + TTL | `ExplorerQuote`, `EXPLORER_QUOTE_TTL_NANOS` (15 min) | `lib.rs` |
| Per-caller escrow subaccount | `derive_explorer_subaccount` / `derive_featured_subaccount` (clone → `derive_ai_subaccount`, new domain tag) | `lib.rs` ~9534 |
| Deposit address | `get_explorer_deposit_address` | `lib.rs` |
| Charge flow (deposit→treasury) | `submit_dapp` (escrow balance check → `call_ledger_transfer` to `TREASURY_SUBACCOUNT`) | `lib.rs` ~10474 |
| Refund-on-failure (claim-before-await) | `admin_reject_dapp` / `admin_reject_featured` | `lib.rs` ~10510 |
| Treasury-can-front gate | `require_treasury_can_front` (shipped) | `lib.rs` |
| Tokens / ledgers / fees | `ExplorerToken`, `explorer_token_ledger/_fee/_decimals` | `lib.rs` ~9499 |
| Ledger calls | `call_ledger_balance`, `call_ledger_transfer` | `lib.rs` ~1963/2090 |

## Proposal data (server-grounding)
| Need | Reuse | Where |
|---|---|---|
| Authoritative proposal text | `PROPOSALS.get(proposal_id)` → `title`, `summary`, `status`, `category`, `nns_proposal_id` | `Proposal` struct |
| NNS deep-link | `nnsProposalLink(p)` (frontend) | `App.tsx` |

## Frontend
| Need | Reuse | Where |
|---|---|---|
| Confirm dialog shell | `MODAL_OVERLAY` / `MODAL_CARD`, token-picker + live-quote | `Explorer.tsx` submit-listing modal |
| Quote/deposit/pay 2-step | `executeSubmit` (Explorer) / `executeFeature` | `Explorer.tsx` |
| Share on X | `shareProposalOnX` | `App.tsx` ~1007 |
| Wallet ICP balance (gating) | `holdings` | `App.tsx` |
| Treasury-gate flag | `globalStats.treasury_can_front_fees` | `App.tsx` |
| Chips/buttons/icons | `Chip` (tones incl. new `gold`), `Btn`, `Icon`, `Eyebrow` | `ui.tsx` |
| Dev controls | `usePageDevControls` | `ui.tsx` |
| Error impression | `useErrorImpression` | `analytics` |

## Net-new (no precedent in repo)
- **HTTPS outcalls** — there are **none** today (XRC/governance are inter-canister).
  The `ic_cdk` management-canister `http_request` (non-replicated) is brand-new
  infra here. Budget the spike (Phase 0.1).
- **vetKeys / vetKD** — none today. Only if Q4 picks the on-chain key path.
- **Gemini client** — request/response (de)serialization + `responseSchema`.
- **Structured `AiReview` store** + cooldown/cap.

## Patterns to copy wholesale
- "Ship dark behind a feature flag, default Off, enable in `deploy-prod.sh`."
- "Local-dev mock endpoint (`dev_*`) gated by `require_local_dev` for offline UI."
- "Commit + deploy to local after every change; mainnet gated per-deploy."
