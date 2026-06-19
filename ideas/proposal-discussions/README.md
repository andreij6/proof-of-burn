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

- **"Start a conversation"** button on each proposal card. Opens a compose dialog
  (title + opening opinion) and a **$1 fee** confirm (USD-priced, any supported
  token → treasury — clone of the Explorer listing flow).
- **"See open threads (N)"** entry on the card when `N > 0` → a thread list for
  that proposal (sorted by activity/upvotes).
- **Thread view:** the opening opinion + a flat/one-level comment list. Anyone
  signed in can **upvote** the thread/comments and **post a comment** (free).
- **Share on X** on a thread → deep-links to the thread (threads are stored, so a
  permalink works — unlike the ephemeral AI review).
- **Moderation:** admin remove thread/comment; reuse the existing
  moderation-candidate tooling; length/rate caps; content guidelines notice.

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Open questions (need owner input)

- **Q1 — Comment fee.** User spec: only the **thread starter** pays $1; comments &
  upvotes are **free**. Free comments invite spam. Default: **free comments**, with
  rate-limits + length caps + the $1 thread fee as the main anti-spam gate. Add an
  optional **micro-fee** (e.g. $0.10) for comments later if abuse appears?
- **Q2 — Nesting depth.** "Counter with comments" → **flat** comments, **one-level**
  replies (comment → replies), or a **full tree**? Recommend **one-level**
  (comment + replies-to-comment) — readable, bounds depth, simple storage.
- **Q3 — Thread lifecycle.** Persist forever, **expire** on inactivity like ideas
  (30 days), or **lock to read-only** once the proposal settles/expires? Recommend
  **lock on proposal settle** (discussion is about a live decision) + keep readable.
- **Q4 — Moderation & permanence.** On-chain content is effectively permanent and
  public — harassment / illegal content / "right to be forgotten" are real. What's
  the policy (admin takedown only? user delete-own? word filter)? See
  [04](04-adversarial-review.md) R1/R2.
- **Q5 — Upvote scope.** Upvote **threads only**, or **threads + comments**?
  Recommend **both** (comment upvotes drive "best counter" sorting).
- **Q6 — Who can comment.** Any authenticated user, or **must hold a token / have
  voted** (sybil resistance)? Recommend **authenticated + holds any supported
  token** (cheap client check; consistent with the AI-review gating) — or just
  authenticated for max participation. → owner call.

## MemoryId note
Free ids (verify at build): **26–33, 54–59, 73, 76, 95, 97+** (94 is taken). This
feature needs ~3: `THREADS`, `NEXT_THREAD_ID`/`COMMENTS`, `THREAD_UPVOTES`
(+ comment upvotes). Update the registry before claiming.
