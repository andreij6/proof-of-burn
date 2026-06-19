# Proposal Discussions (forum-style threads on proposals)

> **Status: SCOPED, NOT BUILT.** Design only. Date: 2026-06-19.

The **human** counterpart to [AI Proposal Review](../ai-proposal-review/README.md):
instead of (or alongside) an AI verdict, let users **debate a proposal**. Anyone
can **start a thread** with their opinion for a **$1 fee**; everyone else can
**upvote** it or **counter with comments** (free). Each proposal card gets a
**"Start a conversation"** button and, when threads exist, a **"See open
threads"** entry. Threads are **shareable on X**.

This is the same "get community signal on a proposal" problem from a different
angle — AI review = one paid machine opinion; discussions = many human opinions,
ranked by upvotes.

---

## Why this is mostly reuse

The **Idea Board** already implements ~90% of the hard parts and is the template:
- **Paid post → treasury.** `submit_idea` charges a flat fee (currently 1 ICP,
  100% to treasury) via a per-poster escrow subaccount (`IDEA_POST_SEED`).
- **Free upvotes** with a per-caller "already upvoted" flag computed at query time
  (`Idea.has_upvoted`, `IDEA_UPVOTES`).
- **Lifecycle:** validation (title/body length caps), 30-day expiry sweep,
  admin removal, moderation-candidate listing, a feature flag (`idea_board`).
- **Multi-token fees + USD pricing** exist in the Explorer path (`$1/day`) we'll
  borrow for the **$1 USD** thread fee.

**Net-new vs the Idea Board:** content is **keyed to a `proposal_id`**, and there
are **two levels** (Thread → Comments) instead of one (Idea → Upvotes). Comments
are the genuinely new structure.

---

## What ships (MVP)

- **"Start a conversation"** on each proposal card → compose (title + opening
  opinion) + a **$1 fee** confirm (USD-priced, any supported token; **100% burned
  to backend-canister cycles** — D7); clone of the Explorer listing flow.
- **"See open threads (N)"** when `N > 0` → a thread list, sorted by **net score
  (upvotes − downvotes)** / new / active.
- **Thread view:** the opening opinion + one-level comments. Signed-in users can
  **upvote / downvote** the thread and comments, and **post a comment for $0.25**.
- **Quality reward (NEW):** the **thread author earns 1 lottery ticket per upvote**
  on their thread (comment votes are *not* rewarded) — to incentivize good
  conversation-starters. Reward upvotes are **gated for sybil resistance** (see
  Decisions D-reward).
- **Delete on settle:** when the proposal is decided (settled/voted/abstained), its
  threads + comments + votes are **deleted** — discussions are about a *live*
  decision; earned lottery tickets are kept.
- **Share on X** on a thread → deep-links to the thread (works until settle/delete).
- **Admin delete** any thread (no moderation queue / no word filter — D4).

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Decisions (locked 2026-06-19)

- **D1 — Comment fee $0.25** (USD-priced, any token). Threads $1.
- **D7 — Fee routing by token (applies to EVERY fee in this feature — thread $1
  and comment $0.25):**
  - **ICP fee → 100% burned** to backend-canister cycles via the CMC (reuses the
    backend-cycles leg of `settle_burn_split`: top-up + `notify_top_up`, target =
    the backend's own canister id). On-theme ("proof of burn"); self-funds compute.
  - **Non-ICP fee (ckBTC/ckETH/ckUSDC/ckUSDT) → 100% to the treasury** (escrow →
    `TREASURY_SUBACCOUNT`, exactly like `submit_dapp`/`submit_idea`). No swap.
  - Either way: no treasury payout/refund ⇒ **not** subject to
    `require_treasury_can_front`.
- **D2 — One-level** comments (comment + replies-to-comment).
- **D3 — Delete on settle.** Threads/comments/votes for a proposal are removed when
  it settles (not locked/persisted). Bounds state growth; shortens content lifespan.
- **D4 — No moderation, but admin can delete any thread** (`admin_remove_thread`,
  removes its comments too). No pre-publication filter, no moderation queue.
- **D5 — Upvotes AND downvotes** on both threads and comments. Score = up − down
  drives sorting.
- **D6 — Signed-in users can comment** (auth only; they still pay the $0.25 fee, so
  funds are the practical gate).
- **D-reward — 1 lottery ticket to the thread author per upvote on the thread.**
  Comment upvotes earn nothing; downvotes never subtract tickets. ⚠️ **Sybil risk:**
  upvotes are free + principals are free → an author could mint principals to
  upvote their own thread and farm real-ICP lottery tickets. **Mitigation (default,
  needs your nod):** only an upvote from a principal **with participation history**
  (has committed/voted before — cheap `USER_AGGREGATES` check) mints a ticket;
  **never** the author's own principal; **cap N tickets/thread**. See
  [04](04-adversarial-review.md) R0.

## MemoryId note
Free ids (verify at build): **26–33, 54–59, 73, 76, 95, 97+** (94 taken). Needs ~4:
`THREADS`(+`NEXT_THREAD_ID`), `COMMENTS`(+`NEXT_COMMENT_ID`), and a `VOTES` map
keyed `(kind, item_id, principal) → Up|Down` (one map covers thread+comment votes).
Update the registry before claiming.
