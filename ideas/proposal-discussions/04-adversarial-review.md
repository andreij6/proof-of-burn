# Proposal Discussions — Adversarial Review

This feature publishes **arbitrary user text on-chain under our brand** — a bigger
content-risk surface than any prior feature here. Ranked by severity.

## R1 — Harmful / illegal content + on-chain permanence (HIGH)
User-generated posts can contain harassment, hate, doxxing, CSAM links, defamation,
or illegal material — and **on-chain data is effectively permanent and globally
public**. "Delete" only removes it from the canister's *current* state; it may
persist in snapshots, node state history, and anything already indexed/scraped.
This collides with takedown obligations and "right to be forgotten" (GDPR-style).
- **Mitigate:** (1) **Admin takedown** (`admin_remove_thread/_comment`) + the
  existing moderation queue. (2) A **word/pattern filter** on submit to block the
  worst categories pre-publication. (3) Clear **content guidelines + a public
  notice** that posts are permanent/public. (4) Consider storing only a **hash +
  off-chain body** if hard-delete is a legal must (heavier; flag to owner). (5)
  The **$1 thread fee + auth** raises the cost of spam-flooding illegal content.
- **Owner decision (Q4):** how aggressive is moderation, and is true hard-delete a
  requirement? This gates the storage design.

## R2 — Spam / sybil flooding (HIGH)
Comments are **free** (user spec). A sybil can flood a thread with comments or
upvotes to drown dissent or fake consensus, cheaply.
- **Mitigate:** (1) **Per-caller comment rate-limit** (N/min). (2) **Upvote dedupe**
  (one per principal per item) — but principals are free to mint, so dedupe ≠ sybil
  resistance. (3) **Q6 gate:** require commenters to **hold a token / have voted**
  (cost to sybil). (4) The **$1 thread fee** gates thread spam well; comment spam is
  the soft spot → consider an **optional comment micro-fee** (Q1) if abuse appears.
  (5) Length caps + max comments/thread bound blast radius.

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

## R4 — Moderation burden & centralization (MED)
Admin-only takedown means the team is on the hook to police content 24/7, and
"admin can delete posts" is a centralization vector (censoring dissent).
- **Mitigate:** publish a **moderation policy**; log removals (audit log) for
  transparency; consider **community flagging** feeding the moderation queue;
  keep removal scoped + reviewable. Don't let one key silently rewrite discourse.

## R5 — Cost / state growth (MED)
Unbounded threads+comments grow canister state (cycles) indefinitely; the $1 fee
covers thread spam but **free comments don't pay for their storage**.
- **Mitigate:** hard caps (comments/thread, threads/proposal, body length);
  **lock/expire** old threads (Q3) so dead discussions stop growing; monitor state
  size; the comment micro-fee (Q1) as a release valve.

## R6 — Payment edge cases (LOW–MED)
The thread fee uses the escrow→treasury path; a charge that succeeds while the
insert fails would take $1 with no thread.
- **Mitigate:** clone `submit_dapp`'s ordering (validate + escrow check before the
  transfer; insert immediately after) and its **claim-before-await refund** if any
  await sits between charge and insert. Unit-test the failure path. Note: **no
  treasury-fronting** is involved (fee flows *into* treasury), so this feature is
  **not** subject to the `require_treasury_can_front` gate.

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
**Buildable and high-engagement, but it's the team's first foray into hosting
arbitrary public user content** — the dominant risks are **content moderation +
on-chain permanence (R1)** and **free-comment spam/sybil + astroturfing governance
(R2/R3)**, not anything technical (the money path and storage are pure reuse).
Resolve **Q4 (moderation/permanence)** and **Q1/Q6 (comment cost / sybil gate)**
before building — they shape both the storage model and the legal posture.
