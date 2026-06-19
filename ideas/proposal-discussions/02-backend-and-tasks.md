# Proposal Discussions — Backend & Tasks

Companion to [README](README.md) / [01-ux-spec](01-ux-spec.md). All in
`src/backend/src/lib.rs`. The **Idea Board** is the template — clone its
post/upvote/escrow/expiry/moderation shape, keyed to a `proposal_id`, with a
second level (comments).

## A. Data model

```rust
#[derive(CandidType, Serialize, Deserialize, Clone)]
pub struct Thread {
    pub id: u64,
    pub proposal_id: u64,
    pub author: Principal,
    pub title: String,            // ≤ 100
    pub body: String,             // the opening take, ≤ 1000
    pub created_at: u64,
    pub last_activity_at: u64,    // bumped on new comment; drives "Active" sort / expiry (Q3)
    pub comment_count: u64,
    pub upvote_count: u64,
    pub locked: bool,             // true once the proposal settles (Q3)
    #[serde(default)] pub has_upvoted: bool, // per-caller at query time (NOT stored)
}

#[derive(CandidType, Serialize, Deserialize, Clone)]
pub struct Comment {
    pub id: u64,
    pub thread_id: u64,
    pub parent_id: Option<u64>,   // None = top-level; Some = a one-level reply (Q2)
    pub author: Principal,
    pub body: String,             // ≤ 1000
    pub created_at: u64,
    pub upvote_count: u64,
    #[serde(default)] pub has_upvoted: bool, // per-caller at query time
}
impl_storable!(Thread); impl_storable!(Comment);
```

Stores (claim fresh ids — **94 taken**; verify registry):
- `THREADS: StableBTreeMap<u64, Thread>` + `NEXT_THREAD_ID: StableCell<u64>`
- `COMMENTS: StableBTreeMap<u64, Comment>` + `NEXT_COMMENT_ID: StableCell<u64>`
- `THREAD_UPVOTES: StableBTreeMap<(u64 thread_id, Principal), ()>` (dedupe; mirror
  `IDEA_UPVOTES`) and `COMMENT_UPVOTES: StableBTreeMap<(u64 comment_id, Principal), ()>`
  (Q5) — or fold both into one keyed map with a kind tag to save an id.
- *(comment trees: query-time assembly by filtering `COMMENTS` on `thread_id`;
  cap comments/thread so this stays cheap, or add a secondary index if needed.)*

## B. Fee & escrow (reuse Idea + Explorer USD pricing)

- `THREAD_START_FEE_USD_E8S = 100_000_000` (= **$1**). Unlike `IDEA_POST_FEE_E8S`
  (flat 1 ICP), price it **in USD via XRC** so it's $1 in any token — reuse
  `explorer_usd_rate_e8s` + `explorer_quote_amount`.
- `get_thread_quote(token) -> ExplorerQuote` + `get_thread_deposit_address()` (new
  `derive_thread_subaccount(user)`), mirroring the Idea post-fee escrow
  (`IDEA_POST_SEED` subaccount) / Explorer deposit flow.
- `start_thread(proposal_id, title, body, token)`:
  1. `require_authenticated` + `_guard` + feature-flag check + proposal exists &
     not locked.
  2. validate text (clone `validate_idea_text` caps).
  3. quote match/fresh; escrow funded?; **move fee escrow → TREASURY** (100% to
     treasury, like `submit_idea`). No refund-fronting needed (no later payout).
  4. insert `Thread`; return it.
- **No treasury-can-front gate** (fee flows *into* treasury; nothing fronted).

## C. Comments & upvotes (free; reuse free-upvote model)

- `add_comment(thread_id, parent_id: opt, body) -> Comment`: authenticated (+ Q6
  gate), thread not locked, validate length, **rate-limit per caller** (e.g. N/min
  via a `LAST_COMMENT_AT` map or a rolling counter), `parent_id` must be a
  top-level comment in this thread (one-level, Q2). Bumps `thread.comment_count`
  + `last_activity_at`.
- `upvote_thread(thread_id)` / `upvote_comment(comment_id)` (Q5): free; dedupe via
  the upvotes map (mirror the Idea free-upvote path); idempotent (re-upvote =
  no-op or toggle — pick toggle for UX).
- Queries: `list_threads(proposal_id, sort) -> vec Thread`, `get_thread(thread_id)
  -> opt Thread`, `list_comments(thread_id) -> vec Comment`,
  `get_thread_count(proposal_id) -> nat64` (cheap, for the card badge),
  `list_my_threads()`. Fill `has_upvoted` per-caller at query time (like `Idea`).

## D. Lifecycle, moderation, limits

- **Lock on settle (Q3):** when a proposal transitions to settled/voted/abstained,
  set `locked = true` on its threads (do it lazily at query time from the proposal
  status, or in the existing settlement sweep). Locked = read-only.
- **Expiry (Q3 alt):** if not locking, reuse the Idea 30-day inactivity sweep on
  `last_activity_at`.
- **Moderation:** `admin_remove_thread(id)` / `admin_remove_comment(id)` (clone
  `admin_remove_idea`); surface in the existing **moderation-candidate** tooling
  (`admin_list_moderation_candidates`). Optional `delete_own_comment` (Q4).
- **Caps:** title ≤100, body ≤1000; max comments/thread; max threads/proposal;
  per-caller comment rate-limit; optional word-filter on submit.

## E. Candid / methods
`get_thread_quote`, `get_thread_deposit_address`, `start_thread`, `add_comment`,
`upvote_thread`, `upvote_comment`, `list_threads`, `get_thread`, `list_comments`,
`get_thread_count`, `list_my_threads`; admin `admin_remove_thread/_comment`,
`admin_set_discussion_config(fee_usd_e8s, caps, rate_limit)`,
`admin_set_feature_flag("discussions", …)`; dev `dev_seed_threads(...)`.
Regenerate `backend.did` + `npm run gen:bindings`.

## F. Feature flag
Ship dark behind `discussions` (default Off); add to `deploy-prod.sh` CORE_OFF
until ready.

## G. Task list
**Phase 1 — Threads (money path, reuse)**
- [ ] 1.1 Thread struct + stores + `derive_thread_subaccount`; $1 USD quote (reuse XRC). *S.*
- [ ] 1.2 `start_thread` escrow→treasury (clone `submit_idea`/`submit_dapp`) + validation + caps. *M.*
- [ ] 1.3 `list_threads`/`get_thread`/`get_thread_count`/`list_my_threads` (+ has_upvoted). *S.*

**Phase 2 — Comments & upvotes**
- [ ] 2.1 Comment struct + `add_comment` (one-level, rate-limit, Q6 gate). *M.*
- [ ] 2.2 Free `upvote_thread`/`upvote_comment` (dedupe map; toggle). *S.*
- [ ] 2.3 Lock-on-settle (Q3) + admin remove + moderation-candidate hookup. *M.*

**Phase 3 — Frontend**
- [ ] 3.1 Card controls ("Start a conversation" / "See open threads (N)"). *S.*
- [ ] 3.2 Compose+fee dialog (clone Explorer modal). *M.*
- [ ] 3.3 Thread list + thread view + comment composer + upvotes + sort toggles. *L.*
- [ ] 3.4 Share-on-X (thread permalink) + `dev_seed_threads` toggles. *S.*

**Phase 4 — Tests & ship**
- [ ] 4.1 Unit: quote/fee→treasury, validation/caps, rate-limit, one-level reply
  enforcement, upvote dedupe/toggle, lock-on-settle, admin remove. *M.*
- [ ] 4.2 `cargo test` + `tsc -b` + vitest; commit + **local deploy**; mainnet gated.
