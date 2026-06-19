# Proposal Discussions — Reuse Map

The **Idea Board** is the template; the Explorer supplies USD pricing. Line
numbers approximate (2026-06-19) — verify before building.

## Posting, fees & escrow
| Need | Reuse | Where |
|---|---|---|
| Paid post (escrow flow) | `submit_idea` (escrow + `IDEA_POST_SEED` subaccount) | `lib.rs` |
| **ICP fee → burn to backend cycles (D7)** | backend-cycles leg of `settle_burn_split`: `call_cmc_topup_transfer(ledger, escrow_sub, get_canister_id(), amt−fee, fee)` + `notify_top_up`; journal the CMC block | `lib.rs:2250`, `2466` |
| **Non-ICP fee → treasury (D7)** | `call_ledger_transfer(token_ledger, escrow_sub, TREASURY_SUBACCOUNT, amt, fee)` — same as `submit_dapp` (no swap) | `lib.rs` |
| Post-fee deposit address | `get_idea_post_deposit_address` | `lib.rs:5560` |
| Per-poster escrow subaccount | `derive_idea_subaccount` (clone → `derive_thread_subaccount`) | `lib.rs:5456` |
| **$1 USD** pricing (any token) | `explorer_usd_rate_e8s` + `explorer_quote_amount` + `ExplorerQuote` | `lib.rs` (Explorer path) |
| Tokens/ledgers/fees | `ExplorerToken`/`IdeaToken`, `explorer_token_ledger/_fee` | `lib.rs` |
| Refund-on-failed-post | `submit_dapp` claim-before-await (only if a post can fail post-charge) | `lib.rs` |

## Content lifecycle & moderation
| Need | Reuse | Where |
|---|---|---|
| Text validation + caps | `validate_idea_text`, `MAX_IDEA_*` consts | `lib.rs:5468` |
| Free upvotes + per-caller `has_upvoted` | `IDEA_UPVOTES` + `Idea.has_upvoted` (computed at query) | `lib.rs:5138` |
| Admin removal | `admin_remove_idea` | `lib.rs:5434` |
| **Delete on settle** | hook the settlement path (`process_proposal_cutoff` / settle sweep) → delete this proposal's threads/comments/votes | `lib.rs` settle path |
| Per-caller dedupe key | `IdeaViewKey` / `IDEA_VIEWS` pattern | `lib.rs:5168` |
| **Lottery ticket grant (the reward)** | factor a `grant_lottery_tickets(user, n)` helper from `dev_grant_lottery_tickets` (bump `TicketEntry.count` for current round + `state.total_tickets`); `LOTTERY_TICKETS` map | `lib.rs:9187`, `8413` |
| Sybil gate for the reward | `USER_AGGREGATES.get(upvoter).proposals_joined > 0` (cheap, no outcall) | `lib.rs` |

## Frontend
| Need | Reuse | Where |
|---|---|---|
| List/compose visual precedent | `IdeaBoard.tsx` | `src/frontend/src/IdeaBoard.tsx` |
| Compose+fee dialog shell | Explorer submit-listing modal (`MODAL_OVERLAY/CARD`, token-picker, live quote, 2-step pay) | `Explorer.tsx` |
| Share on X | `shareProposalOnX` | `App.tsx:1007` |
| Proposal deep-link | `nnsProposalLink` | `App.tsx` |
| Chips/buttons/icons/dev controls | `Chip`/`Btn`/`Icon`/`usePageDevControls` | `ui.tsx` |
| Token balances (Q6 gating) | `holdings` + `tokenBalances` | `App.tsx` |

## Net-new (no precedent)
- **Comments** (`Comment` struct, `add_comment`, one-level replies, per-thread
  assembly) — the Idea Board has no second level.
- **Content keyed to `proposal_id`** + the per-proposal `get_thread_count` badge.
- **Comment upvotes** (Q5) + a per-caller comment **rate-limiter**.
- **Lock-on-settle** read-only state tied to proposal lifecycle.

## Patterns to copy wholesale
- Ship dark behind a feature flag (`discussions`), default Off, enable in `deploy-prod.sh`.
- `dev_*` seed endpoint gated by `require_local_dev` for offline UI states.
- Commit + deploy to local after every change; mainnet gated per-deploy.

## Note vs the Idea Board
The Idea Board's paid-upvote model was **retired** (upvotes are now free; the
`Idea.total_*` fields are legacy zeros, and there's a dormant 75/25 upvote-payout
saga). **Don't** copy the payout saga — discussions upvotes are free, no payout.
Copy only the *current* free-upvote dedupe path.
