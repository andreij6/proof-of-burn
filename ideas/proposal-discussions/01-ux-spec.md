# Proposal Discussions — UX Spec

Companion to [README](README.md). Frontend in `App.tsx` (proposal cards + modals);
the thread list/view can be a new `Discussions.tsx` or inline panels. Primitives
from `ui.tsx`; the Idea Board (`IdeaBoard.tsx`) is the closest visual precedent.

## 1. On the proposal card

The action row (next to **Share** / **AI Review**) shows:
- **"Start a conversation"** — always visible to signed-in users (opens compose +
  fee dialog). Disabled-with-tooltip when not signed in, or when the proposal is
  locked (Q3).
- **"See open threads (N)"** — shown only when `N > 0` (from `get_thread_count(proposal_id)`,
  a cheap query). Opens the thread list for that proposal.

Both can collapse into one control: *"Discuss (N)"* → opens the panel with a
**Start a thread** button at the top. (Picks up the existing card density.)

## 2. Start-a-thread compose + fee dialog

Clone of the Explorer listing modal (`MODAL_OVERLAY`/`MODAL_CARD`, token-picker +
live quote):

```
┌─ Start a conversation · Proposal #12345 ────┐
│  Title:      [ ...... ]            (≤ 100)   │
│  Your take:  [ .................. ] (≤ 1000) │
│                                              │
│  Pay with:  [ICP] ckBTC ckETH ckUSDC ckUSDT  │
│  Fee:  0.21 ICP  = $1.00   (locked 15 min)   │
│  Your balance: 1.20 ICP                      │
│  ⓘ One-time fee to open a thread (anti-spam, │
│    100% to treasury). Each upvote = a lottery ticket. Comments cost $0.25.     │
│            [ Cancel ]  [ Pay & post ]        │
└──────────────────────────────────────────────┘
```

- Commenting opens the **same dialog with a $0.25 fee** (D1) — body only, no title.
- Two-step pay (deposit → `start_thread` / `add_comment`), like `submit_dapp` / `submit_idea`.
- Treasury-gate aware: if `globalStats.treasury_can_front_fees` is false… *posting
  doesn't need fronting* (fee flows escrow→treasury, no refund-fronting), so this
  feature is **not** gated by the treasury check. (Unlike commit/AI-review, there's
  no later treasury-fronted payout — the $1 just goes to treasury.)

## 3. Thread list (per proposal)

A simple list, each row shows **net score** with up/down controls:
```
 ▲ 25
 ▼ 2     "RVM memory bump is premature"   — alice · 4 comments · 2h ago   🎟 25
 ▲ 8
 ▼ 0     "Strongly support, here's why"   — bob   · 1 comment  · 5h ago   🎟 8
```
- `▲`/`▼` = up/down vote buttons (free; the caller's current choice is highlighted
  from `my_vote`); the number is the **net score (up − down)**.
- `🎟 N` (on the author's own rows) = lottery tickets this thread has earned them
  (1 per qualifying upvote, D-reward).
- Sort: **Top** (score) / **New** (created) / **Active** (last activity).

## 4. Thread view

- **Opening post** (title + author + take + up/down control + the author's ticket
  count). A small hint by the vote control: *"Upvotes give the author a lottery
  ticket."*
- **Comment composer** (signed-in; **$0.25 fee**, D1/D6): text box + "Comment
  ($0.25)". One-level replies (D2): each comment has a "Reply" → child comment.
- **Comments** sorted by score (best counter first) / newest, each with an up/down
  control (comment votes are **not** rewarded) and its one level of replies indented.
- **Share on X** (top-right): thread title + snippet + a **deep-link to the thread**
  (`#/voting?thread=<id>`), valid until the proposal settles (then deleted).
- **Settle = delete (D3):** there is no locked/read-only state — when the proposal
  is decided, the whole thread (and its comments) is **removed**. Optionally warn
  near settle time: *"This conversation will close when the proposal is decided."*

## 5. Share on X

Reuse `shareProposalOnX`'s `twitter.com/intent/tweet` pattern:
```
💬 Discussion on NNS proposal #12345 "<proposal title>":
"<thread title>" — <N> upvotes, <M> comments. Join in 👇
```
+ `url` = the thread permalink. Keep ≤ ~270 chars.

## 6. Empty / error / abuse states

- **No threads yet:** the "Discuss" panel shows "No conversations yet — start one."
- **Post failure** (payment/validation): inline error; fee only charged on success
  (escrow pattern; a failed `start_thread` after deposit refunds, like `submit_dapp`).
- **Rate-limited:** "You're posting too fast — try again in N min."
- **Content notice (D4 = no moderation):** a one-line "Posts are public & on-chain
  and auto-delete when the proposal is decided. Admins may remove any thread."
  near the composer (no word filter / no moderation queue; admin takedown only).

## 7. Local-dev toggles

`usePageDevControls`: `dev_seed_threads(proposal_id, n_threads, n_comments)` to
populate a proposal with sample threads/comments + votes (no fee) so list / thread
/ empty states can be previewed offline.
