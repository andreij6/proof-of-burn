# Proposal Discussions — Backend & Tasks

Companion to [README](README.md) / [01-ux-spec](01-ux-spec.md). All in
`src/backend/src/lib.rs`. The **Idea Board** is the template — clone its
post/upvote/escrow/expiry/moderation shape, keyed to a `proposal_id`, with a
second level (comments).

## A. Data model

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum VoteDir { Up, Down }

#[derive(CandidType, Serialize, Deserialize, Clone)]
pub struct Thread {
    pub id: u64,
    pub proposal_id: u64,
    pub author: Principal,
    pub title: String,            // ≤ 100
    pub body: String,             // the opening take, ≤ 1000
    pub created_at: u64,
    pub last_activity_at: u64,    // bumped on new comment; drives "Active" sort
    pub comment_count: u64,
    pub upvote_count: u64,        // for the reward + score
    pub downvote_count: u64,      // D5
    pub tickets_awarded: u64,     // lottery tickets minted to author so far (cap, D-reward)
    #[serde(default)] pub my_vote: Option<VoteDir>, // per-caller at query time (NOT stored)
}

#[derive(CandidType, Serialize, Deserialize, Clone)]
pub struct Comment {
    pub id: u64,
    pub thread_id: u64,
    pub parent_id: Option<u64>,   // None = top-level; Some = a one-level reply (D2)
    pub author: Principal,
    pub body: String,             // ≤ 1000
    pub created_at: u64,
    pub upvote_count: u64,
    pub downvote_count: u64,      // D5
    #[serde(default)] pub my_vote: Option<VoteDir>, // per-caller at query time
}
impl_storable!(Thread); impl_storable!(Comment);
```

Stores (claim fresh ids — **94 taken**; verify registry):
- `THREADS: StableBTreeMap<u64, Thread>` + `NEXT_THREAD_ID: StableCell<u64>`
- `COMMENTS: StableBTreeMap<u64, Comment>` + `NEXT_COMMENT_ID: StableCell<u64>`
- `DISCUSSION_VOTES: StableBTreeMap<(u8 kind, u64 item_id, Principal), VoteDir>` —
  one map covers thread (kind=0) + comment (kind=1) votes; dedupe + toggle +
  up↔down switch. Fills `my_vote` at query time.
- *(comment trees: query-time assembly by filtering `COMMENTS` on `thread_id`; cap
  comments/thread so this stays cheap. Optionally index `proposal_id → [thread_id]`
  for fast delete-on-settle + the card count.)*

## B. Fee & escrow (reuse Idea + Explorer USD pricing)

- `THREAD_START_FEE_USD_E8S = 100_000_000` (= **$1**). Unlike `IDEA_POST_FEE_E8S`
  (flat 1 ICP), price it **in USD via XRC** so it's $1 in any token — reuse
  `explorer_usd_rate_e8s` + `explorer_quote_amount`.
- `get_thread_quote(token) -> ExplorerQuote` + `get_thread_deposit_address()` (new
  `derive_thread_subaccount(user)`), mirroring the Idea post-fee escrow
  (`IDEA_POST_SEED` subaccount) / Explorer deposit flow.
- `start_thread(proposal_id, title, body, token)`: `require_authenticated` +
  `_guard` + flag + proposal exists & **not settled**; validate (clone
  `validate_idea_text` caps); `$1` quote match/fresh; escrow funded?; **burn the fee
  to backend-canister cycles (D7)**; insert `Thread`; return it.
- `add_comment(thread_id, parent_id: opt, token)`: same shape, **$0.25 fee burned**
  (D1/D7); thread exists & proposal not settled; one-level (`parent_id` must be a
  top-level comment in this thread, D2); per-caller **rate-limit**; bumps
  `comment_count` + `last_activity_at`.
- **Burn = 100% to backend cycles (D7):** reuse the backend-cycles leg of
  `settle_burn_split` — `call_cmc_topup_transfer(ledger, escrow_sub,
  get_canister_id(), amount − fee, fee)` then `notify_top_up` (target = this
  canister). The single CMC ledger fee nets out of the amount; everything else
  mints into the backend's cycle balance. **Non-ICP fees** swap to ICP first (reuse
  the commit-token settlement swap) before the CMC top-up, OR — simpler for MVP —
  **accept the fee in ICP only** and revisit multi-token burn later (→ note).
- **No treasury involvement ⇒ no `require_treasury_can_front` gate, no
  refund-fronting.** Clone `submit_dapp` ordering so a charge can't succeed with a
  failed insert (and journal the CMC block like `settle_burn_split` for retry-safety).

## C. Votes (up/down) + the lottery reward

- `vote_thread(thread_id, dir)` / `vote_comment(comment_id, dir)` (D5): **free**;
  `DISCUSSION_VOTES[(kind,id,caller)]` toggles — same dir again = clear; opposite =
  switch; adjust the item's up/down counts accordingly. Idempotent.
- **Reward (D-reward):** when a thread gains a **new upvote** (None/Down → Up),
  award the **thread author 1 lottery ticket** — *iff* all hold:
  - the upvoter is **not the author**, AND
  - the upvoter has **participation history** (`USER_AGGREGATES.get(upvoter)` with
    `proposals_joined > 0` — cheap, no outcall; raises sybil cost since each sybil
    must have committed real ICP), AND
  - `thread.tickets_awarded < TICKETS_PER_THREAD_CAP` (e.g. 50).
  Grant via a factored `grant_lottery_tickets(author, 1)` helper (extract from
  `dev_grant_lottery_tickets`: bump `TicketEntry.count` for the current round +
  `state.total_tickets`). **Downvotes never subtract tickets; switching away from Up
  does not claw back** (tickets are earned). **Comment upvotes award nothing.**
- Queries: `list_threads(proposal_id, sort)`, `get_thread`, `list_comments(thread_id)`,
  `get_thread_count(proposal_id)` (card badge), `list_my_threads`; fill `my_vote`
  per-caller at query time. Sort by **score = up − down** / new / active.

## D. Lifecycle, admin, limits

- **Delete on settle (D3):** in the existing settlement path / sweep, when a
  proposal becomes settled/voted/abstained, **delete all its threads, their
  comments, and the related `DISCUSSION_VOTES`**. (Use the `proposal_id → thread_id`
  index to do this without a full scan.) Earned lottery tickets are already in
  `LOTTERY_TICKETS` and are **not** touched.
- **Admin delete (D4):** `admin_remove_thread(id)` deletes the thread + its comments
  + votes. **No** moderation queue, **no** word filter (D4) — admin takedown is the
  only lever. (Optional `admin_remove_comment(id)` for surgical removal.)
- **Caps:** title ≤100, body ≤1000; max comments/thread; max threads/proposal;
  per-caller comment rate-limit; `TICKETS_PER_THREAD_CAP`.

## E. Candid / methods
`get_thread_quote`, `get_comment_quote`, `get_thread_deposit_address` (+ comment
deposit address or reuse one per-caller escrow), `start_thread`, `add_comment`,
`vote_thread`, `vote_comment`, `list_threads`, `get_thread`, `list_comments`,
`get_thread_count`, `list_my_threads`; admin `admin_remove_thread` (+ optional
`admin_remove_comment`), `admin_set_discussion_config(thread_fee_usd_e8s,
comment_fee_usd_e8s, caps, rate_limit, tickets_cap)`,
`admin_set_feature_flag("discussions", …)`; dev `dev_seed_threads(...)`.
Regenerate `backend.did` + `npm run gen:bindings`.

## F. Feature flag
Ship dark behind `discussions` (default Off); add to `deploy-prod.sh` CORE_OFF
until ready.

## G. Task list
**Phase 1 — Threads (money path, reuse)**
- [ ] 1.1 Thread struct + stores (+ `proposal_id→threads` index) + `derive_*_subaccount`; $1 USD quote (reuse XRC). *S.*
- [ ] 1.2 `start_thread` escrow→treasury (clone `submit_idea`/`submit_dapp`) + validation + caps. *M.*
- [ ] 1.3 `list_threads`/`get_thread`/`get_thread_count`/`list_my_threads` (+ `my_vote`, score sort). *S.*

**Phase 2 — Comments, votes, reward**
- [ ] 2.1 Comment struct + `add_comment` ($0.25 escrow→treasury, one-level, rate-limit, D6 auth). *M.*
- [ ] 2.2 `vote_thread`/`vote_comment` up/down toggle (`DISCUSSION_VOTES`). *S.*
- [ ] 2.3 **Lottery reward**: factor `grant_lottery_tickets`; award on qualifying new thread-upvote (sybil gate + per-thread cap). *M.*
- [ ] 2.4 **Delete-on-settle** sweep hook + `admin_remove_thread`. *M.*

**Phase 3 — Frontend**
- [ ] 3.1 Card controls ("Start a conversation" / "See open threads (N)"). *S.*
- [ ] 3.2 Compose+fee dialogs (clone Explorer modal): $1 thread, $0.25 comment. *M.*
- [ ] 3.3 Thread list + thread view + comment composer + up/down vote controls + score sort + "earn a ticket per upvote" hint. *L.*
- [ ] 3.4 Share-on-X (thread permalink) + `dev_seed_threads` toggles. *S.*

**Phase 4 — Tests & ship**
- [ ] 4.1 Unit: thread+comment fee→treasury, validation/caps, rate-limit, one-level
  reply enforcement, up/down vote toggle + count math, **reward grants exactly 1
  ticket per qualifying upvote (sybil gate: no self/no-history/over-cap; downvote &
  un-upvote don't claw back)**, **delete-on-settle removes threads/comments/votes
  but keeps tickets**, admin remove. *M.*
- [ ] 4.2 `cargo test` + `tsc -b` + vitest; commit + **local deploy**; mainnet gated.
