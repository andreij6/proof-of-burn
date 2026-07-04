---
type: idea
title: "03 — Risks, gates & open questions"
tags: [ideas, x-farm-published-tracking]
timestamp: 2026-06-20T01:26:49-04:00
---

# 03 — Risks, gates & open questions

## R1 — Sybil / astroturf (the big one)

A self-attested leaderboard with no reward is low-stakes, but **rank itself is a
soft incentive** — vanity farmers could spin up farms and log fake tweets to top
the board. Mitigations already in the design:

- One published entry per `(farmer, draft)` (idempotent).
- ≤ `drafts_per_day` per farmer per day (can't log more than was drafted).
- One entry per distinct `tweet_url` globally (one real tweet can't be re-logged).
- Rank tiebreak on `burned_cycles` — to lead you must also **burn**, not just log.
- Admin `admin_disable_farmer` (`lib.rs:19417`) already exists; add an
  `admin_purge_published(farmer_id)` for moderators to scrub a gaming farm.

**Residual:** a determined actor can still post one real (throwaway) tweet per
draft per farm and log it. Accepted: the leaderboard says "self-reported
amplification," is non-financial, and admins can purge. This is the same trust
posture as any "post a link to prove you did X" community board.

**Hard line (do not cross):** never wire published count → any ICP / ticket /
yield reward. The instant it pays, sybil economics flip from "vanity" to "profit"
and the whole feature reopens the securities + astroturf-governance risks X-Farm
already navigated. If a reward is ever desired, it must go through the same
review the lottery/staking split got.

## R2 — Unverifiable ownership / content match

We can't prove the logged tweet belongs to the owner, contains the draft text, or
mentions `$ICP`. v1 stores **self-attested URLs only** and the UI says so. Real
verification needs the X API (read) — a new paid outcall and a new trust boundary
(the proxy would hold X credentials). **Q1** (below) is the gate; v1 ships without
it and the leaderboard copy is honest about that.

## R3 — Content permanence / moderation

Published-log `tweet_url`s are on-chain (stable storage) and therefore permanent
on the IC even if the tweet is deleted on X. A logged URL could later resolve to
deleted/changed/harmful content. Mitigations:

- We store **only the URL string** (no tweet text) — the IC hosts a pointer, not
  the content.
- Public leaderboard rows expose **counts + principal only, not URLs**; URLs are
  owner-visible only on the caller's own rows. So a stranger can't use the
  leaderboard to surface arbitrary URLs.
- `admin_purge_published` (R1) doubles as the moderation off-switch for a bad URL.
- Same "admins may disable" posture the Farmer cards already carry
  (`XFarm.tsx` footer: *"Admins may disable Farmers"*).

## R4 — Leaderboard scan cost

`get_xfarm_leaderboard` is a linear scan + sort over 30 days of logs. At expected
volume (tens–hundreds of farms) this is trivial. If it ever gets hot (called on
every page load by many users), add a denormalized `published_count_30d` on
`Farmer` + a cached sorted index rebuilt in `xfarm_sweep`. **Start without it.**

## R5 — Upgrade safety

v1 adds a stable map (MemoryId 57) + next-id cell (58) — no change to the `Farmer`
struct, so **no `Farmer` migration / `Option` defaults** needed. Future
denormalized counters on `Farmer` would need `Option`/default handling on upgrade;
defer.

## Build gates (must be true before shipping)

- [ ] `grep` confirms MemoryIds 57 + 58 are free (no collision).
- [ ] `.did` regenerated + `bindings/` updated; `tsc --noEmit` clean.
- [ ] Backend tests cover: idempotent re-log (same `(farmer,draft)`), daily cap,
  global-URL cap, owner-mismatch rejection, 30-day prune in sweep.
- [ ] `x_farm` flag still gates all 3 endpoints (feature stays dark until the
  flag flips — mainnet-deploy gate still applies).
- [ ] Leaderboard copy explicitly says "self-reported."

## Open questions

### Q1 — Verify the tweet (X API read)?
**Decision needed before v1 or explicitly deferred.** Fetching the tweet on
`log_published` (via the Cloud-Run proxy, which would hold X API creds) could
validate: (a) the tweet exists, (b) it contains `$ICP`, ideally (c) its text
matches the draft. Cost: a paid X API tier + a new outcall leg + new proxy
endpoint + new credential rotation. **Recommendation: defer.** v1 ships
self-attested with honest copy; revisit only if the leaderboard gets gamed or a
sponsor wants "verified" tiers.

### Q2 — Empty-state use-case grid layout
The current `XFARM_USE_CASES` grid is `repeat(2, 1fr)` (2×2, two cards). Adding
"See your impact" as a third card forces a layout choice: revert to
`auto-fit, minmax(220px, 1fr)` (responsive, may go 3-up on wide screens) or keep
2 columns and let the third wrap to a second row (2+1). **Recommendation:** keep
2 columns and accept the 2+1 wrap; the card belongs thematically with the others.

### Q3 — Leaderboard placement
Standalone section below the owner's farms, or a tab on the X-Farm page? A tab
keeps the page from growing. **Recommendation:** section below for v1 (cheaper,
more discoverable); extract to a tab if the page gets long after this + the
localization feature lands.

### Q4 — Per-farm vs per-owner ranking
A user can own unlimited farms. Rank by **farm** (each `Farmer` is a row) or by
**owner** (aggregate a user's farms)? Per-farm is simpler and matches the burn
model (each farm is its own burn). **Recommendation:** per-farm, with the owner's
farms collapsible into one pinned "you" summary row.