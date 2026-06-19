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
│    100% to treasury). Comments are free.     │
│            [ Cancel ]  [ Pay & post ]        │
└──────────────────────────────────────────────┘
```

- Two-step pay (deposit → `start_thread`), identical to `submit_dapp` / `submit_idea`.
- Treasury-gate aware: if `globalStats.treasury_can_front_fees` is false… *posting
  doesn't need fronting* (fee flows escrow→treasury, no refund-fronting), so this
  feature is **not** gated by the treasury check. (Unlike commit/AI-review, there's
  no later treasury-fronted payout — the $1 just goes to treasury.)

## 3. Thread list (per proposal)

A simple list, each row:
```
▲ 23   "RVM memory bump is premature"        — alice · 4 comments · 2h ago
▲ 8    "Strongly support, here's why"         — bob   · 1 comment  · 5h ago
```
- `▲` = upvote count + button (free; filled when `has_upvoted`).
- Sort: **Top** (upvotes) / **New** (created) / **Active** (last activity) toggle.
- Header: **"Start a conversation"** + the proposal title for context.

## 4. Thread view

- **Opening post** (title + author + the starter's take + upvote control).
- **Comment composer** (signed-in; free): a text box + "Comment". One-level
  replies (Q2): each comment has a "Reply" that posts a child comment.
- **Comments** sorted by upvotes (best counter first) / newest toggle, each with an
  upvote control and (if Q2 = one-level) its replies indented once.
- **Share on X** (top-right): tweets the thread title + verdict-ish snippet + a
  **deep-link to the thread** (`#/voting?thread=<id>` or a `/thread/<id>` route).
- **Locked banner** (Q3): once the proposal settles, "This proposal has been
  decided — the thread is read-only." Upvotes/comments disabled, still viewable.

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
- **Content guidelines:** a one-line "Be civil. Posts are public & on-chain;
  removed content can't fully disappear." near the composer (sets expectations, Q4).

## 7. Local-dev toggles

`usePageDevControls`: `dev_seed_threads(proposal_id, n_threads, n_comments)` to
populate a proposal with sample threads/comments (no fee) so list/thread/locked/
empty states can be previewed offline.
