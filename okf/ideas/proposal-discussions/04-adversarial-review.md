---
type: idea
title: "Proposal Discussions — Adversarial Review"
tags: [ideas, proposal-discussions]
timestamp: 2026-06-19T05:28:14-04:00
---

# Proposal Discussions — Adversarial Review

This feature publishes **arbitrary user text on-chain under our brand** — a bigger
content-risk surface than any prior feature here. Ranked by severity.

## R0 — Sybil lottery-ticket farming via free upvotes (HIGH; the new headline)
The D-reward (1 lottery ticket to the thread author **per upvote**) pays out into a
**real-ICP lottery**, but **upvotes are free and principals are free to mint**. So
an author can spin up N Internet Identities, upvote their own thread N times, and
**farm N lottery tickets** — diluting honest players and draining EV from the pot.
This is the single most dangerous interaction in the design.
- **Mitigate (baked into D-reward):** (1) **Sybil gate** — only an upvote from a
  principal with **participation history** (`USER_AGGREGATES.proposals_joined > 0`,
  i.e. has committed/voted real ICP before) mints a ticket; minting a qualifying
  sybil now costs a real commitment each. (2) **Never** reward the author's own
  principal. (3) **Per-thread ticket cap** (`TICKETS_PER_THREAD_CAP`, e.g. 50) caps
  the blast radius. (4) Tickets are **not** clawed back on un-upvote/downvote, but
  each principal can only upvote once, so the cap + gate bound total mint.
- **Residual:** a determined attacker with many funded, participating principals can
  still earn up to the cap. Tune the cap low; monitor; consider requiring a *minimum
  upvoter balance* or only counting upvotes from **distinct prior-round lottery
  participants** if farming appears. → owner should confirm the gate + cap.

## R1 — Harmful / illegal content + on-chain permanence (HIGH)
User-generated posts can contain harassment, hate, doxxing, CSAM links, defamation,
or illegal material — and **on-chain data is effectively permanent and globally
public**. "Delete" only removes it from the canister's *current* state; it may
persist in snapshots, node state history, and anything already indexed/scraped.
This collides with takedown obligations and "right to be forgotten" (GDPR-style).
- **Decided posture (D3/D4):** **no moderation pipeline, no word filter** — so
  illegal/harmful content **can appear and stay until** (a) an admin deletes the
  thread (`admin_remove_thread`, the only lever), or (b) the proposal settles and
  the thread **auto-deletes (D3)**. Delete-on-settle bounds *lifespan* and current-
  state growth, but **does not solve permanence** — removed bytes may persist in
  snapshots / node state history / scrapes.
- **Mitigate within that posture:** (1) keep admin takedown fast + obvious. (2)
  Render plain-text only (R7). (3) The **content notice** sets expectations. (4)
  *If* legal hard-delete ever becomes a requirement, revisit storing **hash +
  off-chain body** — flag now, out of MVP scope.
- **Owner aware:** D4 trades moderation cost for legal exposure on user content;
  acceptable for launch given delete-on-settle + admin takedown, but revisit if the
  surface gets abused.

## R2 — Spam flooding (MED; mitigated by paid comments)
Per D1, **comments cost $0.25** and threads $1 — so flooding now costs real money
per item, a strong spam gate (much better than the originally-floated free
comments). Residual: a funded attacker can still post, and **votes are free**
(see R0 for the ticket-farming angle; here it's drowning dissent / fake consensus).
- **Mitigate:** (1) **Per-caller comment rate-limit** even though paid (burst
  control). (2) **Vote dedupe** (one per principal per item, toggle). (3) caps on
  comments/thread + threads/proposal. (4) the $0.25/$1 fees make sustained spam
  expensive.

## R3 — Vote manipulation / astroturfing (MED–HIGH; product-specific)
This app **routes burns into NNS votes**. A manufactured "top thread" arguing a
stance — amplified by sybil upvotes and shared on X under our brand — could
**steer real governance** and look like the platform endorsing a position.
- **Mitigate:** (1) Frame threads as **community opinion, not platform/official
  guidance** (notice on thread + in the X-share text). (2) Never surface a thread's
  stance as a default/auto-applied vote. (3) Sort transparency: show upvote counts,
  not an opaque "recommended." (4) Sybil resistance (R2) directly limits astroturf
  reach. (5) Consider showing **whether a poster actually committed/voted** on the
  proposal (skin-in-the-game signal) rather than anonymous opinion.

## R4 — Admin-delete centralization (MED; accepted via D4)
D4 = **no moderation queue, no filter; admin can delete any thread.** Low ops
burden, but "one key can delete any discussion" is a **censorship/centralization
vector** (silently removing dissent).
- **Mitigate:** **log every admin removal to the audit log** (transparency); keep
  the removal scoped to spam/illegal; delete-on-settle means most content ages out
  on its own. Consider community-flagging later if abuse outpaces admins.

## R5 — Cost / state growth (LOW–MED; mitigated)
Both levers now help: **comments are paid ($0.25)** so they pay toward their own
storage, and **delete-on-settle (D3)** purges a proposal's whole discussion when it
resolves — so state can't grow unbounded across closed proposals.
- **Also:** hard caps (comments/thread, threads/proposal, body length); monitor
  total state size.

## R6 — Payment / burn edge cases (LOW–MED)
Fee routing is by token (D7): **ICP → burned** to backend cycles (CMC two-step:
ledger-transfer-then-`notify_top_up`, the PB-148 class — can partially complete);
**non-ICP → treasury** (a plain escrow→`TREASURY_SUBACCOUNT` transfer, no swap).
Either way a charge that succeeds while the insert fails would take money with no
post.
- **Mitigate:** for the **ICP/burn** path reuse `settle_burn_split`'s **idempotent
  journaling** (store the CMC block; a retry skips the done transfer and re-notifies
  — CMC memoizes per-block). For the **token/treasury** path clone `submit_dapp`'s
  ordering + claim-before-await. Insert the post only after a confirmed charge (or
  journal so a sweep finishes it). Unit-test both partial-failure paths. **No
  treasury payout/refund** ⇒ not `require_treasury_can_front`-gated; the ICP burn is
  on-theme (proof-of-burn) and self-funds compute.

## R7 — XSS / injection via rendered content (MED)
User text rendered in the app (and pulled into tweets) can carry HTML/script or
markdown trickery.
- **Mitigate:** render as **plain text** (escape; no `dangerouslySetInnerHTML`);
  strip control chars on submit; URL-encode everything in the X-share intent
  (`shareProposalOnX` already uses `encodeURIComponent`).

## R8 — Impersonation / misleading authorship (LOW)
Posts show a principal; users can't tell who's who, enabling "I'm the proposer"
claims.
- **Mitigate:** show truncated principals consistently; if the app has any verified
  identity/handle, surface it; never imply authorship beyond the principal.

---
### Verdict
**Buildable and high-engagement** — money path and storage are pure reuse. The
decisions resolved most spam/cost concerns (paid comments + delete-on-settle), so
the dominant residual risks are now **R0 (sybil farming of the lottery reward via
free upvotes)** and **R1/R4 (no-moderation posture: illegal content can appear
until admin/settle deletes it, and on-chain permanence)**. R0 is the one to nail
before shipping — confirm the **sybil gate + per-thread ticket cap**, and watch it
in production. The astroturfing-governance angle (R3) persists: keep the
"community opinion, not advice" framing and consider showing posters' actual
skin-in-the-game (did they commit/vote).
