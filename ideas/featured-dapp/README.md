# Featured Dapp — Spec & Task List

> **Status:** Spec / design proposal. Not built. Not scheduled.
> **Date:** 2026-06-16
> **Produced via agent fan-out** (UX spec + backend/data-model + code-reuse map). Detail docs:
> [`01-ux-spec.md`](./01-ux-spec.md) · [`02-backend-and-tasks.md`](./02-backend-and-tasks.md) ·
> [`03-reuse-map.md`](./03-reuse-map.md) · [`04-adversarial-review.md`](./04-adversarial-review.md).

## What was asked

> A "Featured Dapp": a **full-width hero card** for a dapp in the Dapp Explorer. Users **apply to be
> featured by paying a premium** for the spot for a **specific length of time**. **Max 3** dapps featured
> at once. **1 dapp randomly selected at page load** to show in the spot. If **no one** is paying for the
> spot, the card shows a **state advertising how to purchase** it. The hero is a **2-card slider**: slide
> 1 = the featured app, slide 2 = the advertisement.

## The model (one paragraph)

A new, time-boxed **paid placement** layered on top of the existing Dapp Explorer. A dapp owner with an
approved listing **applies** to feature it, paying a **USD-denominated premium** (priced live via the XRC
oracle, like the existing $1/day listing) for a **fixed duration**. Up to **3** featured placements are
**active** at a time; an admin approves applications (reusing the explorer's approve/reject/refund flow),
and a timer **auto-expires** them. The Explorer renders a **full-width hero** at the top: a **2-card
slider** whose slide 1 is **one randomly chosen** active featured dapp (picked client-side per page load)
and slide 2 is the **"feature your dapp here"** advertisement. When **zero** are active, the hero is just
the advertisement.

This is **not** the existing course `FeaturedSlot` (PB-308): that's a single, perpetual, highest-bid
auction slot in the *course* marketplace. We need 3 slots, fixed durations, and rotation — a different
product. We reuse the *dapp-listing paid flow*, not the auction.

## Requirements → where each is handled

| Requirement | Design |
|---|---|
| Full-width hero card | `FeaturedHero` at top of `Explorer.tsx`, full-width like the course featured card. UX §2–§3. |
| 2-card slider (featured + ad) | Custom ~50-LOC React slider (no carousel dep exists). UX §4. Collapses to a static ad when 0 active. |
| Apply + pay a premium | `apply_featured` reusing `submit_dapp` escrow + `get_featured_quote` reusing the XRC quote. Backend §2–§3. |
| Specific length of time | `days` purchased → `expires_at = approved_at + days×DAY_NANOS`; timer sweep expires it. Backend §3. |
| Max 3 at a time | Enforced **at approval** via a claim-before-await `Pending→Approving` flip (the escrow→treasury sweep makes approval async). Backend §4 + [Review F2](./04-adversarial-review.md). |
| 1 random at page load | **Client-side** `Math.random()` over the active set (server `raw_rand` is update-only; the hero must be an anonymous query). Backend §5. |
| Advertise state when empty | `get_featured_dapps()` returns `slots_open` + `price_per_day_usd_e8s`; hero shows the ad. UX §3b/§5. |

## Architecture decisions (settled)

- **Separate stable map**, not fields on `DappListing`. A placement has its own lifecycle/escrow/expiry;
  folding it into the listing couples two lifecycles and bloats every grid card. `FeaturedDapp` keyed by
  its own id, referencing `listing_id`. (Backend §1.)
- **Reuse the dapp-listing paid flow** (escrow → treasury, admin approve/reject-with-refund, timer
  expiry), **not** the PB-308 auction (no eviction — eviction would break the "specific length of time"
  guarantee a buyer paid for).
- **Client-side random selection.** Keeps `get_featured_dapps()` a pure query (anonymous-renderable, no
  consensus round). No value rides on *which* of ≤3 shows, so client randomness is fine.
- **Slider arrows page only the 2 slides** (chosen-dapp + ad), not all 3 active dapps — this preserves
  the value advertisers paid for (top-of-fold, single random pick) and matches the literal "2-card
  slider." (UX OD-4.)
- **MemoryIds 88 / 89 / 94** for `FEATURED` / `NEXT_FEATURED_ID` / `FEATURED_QUOTES` (grep-confirmed free:
  26–33, 53–59, 73, 76, 88–89, 94–95, 97+). ⚠️ Re-confirm at build time — the unbuilt `nueron-sale` and
  `id-listings` specs also reserve ids on paper; whichever builds first wins, the others must rebase.

## Funds & lifecycle model (RESOLVED after adversarial review — was the spec's biggest hole)

The first draft contradicted itself: it recommended "reserve-only when sold out" while specifying a clone
of `submit_dapp`, which charges to **treasury** at apply — you can't reserve-without-charging by cloning a
charging function ([Review Finding 1](./04-adversarial-review.md)). Resolved model:

- **Escrow-until-approval.** `apply_featured` charges on apply **into the caller's
  `derive_explorer_subaccount` escrow — funds stay there, NOT treasury, while Pending.** Approval is the
  point where escrow sweeps to treasury. No indefinite treasury custody; clean refund exit.
- **Approval has an `await`** (the escrow→treasury sweep), so max-3 is protected by a **claim-before-await
  `Pending → Approving` flip** that re-counts `Active + Approving` as occupied before the await (mirrors
  `admin_reject_dapp`). The "no-await race-safe" claim from the draft only held for the contradictory
  charge-at-apply model; this replaces it. (Findings 1–2.)
- **Refund is the universal exit** for every non-Active terminal state: explicit withdraw, **auto-refund
  of any Pending older than a 7-day TTL** (Finding 3), no-slot, and listing-gone (Finding 7). With
  escrow-until-approval a refund just returns the caller's own escrowed funds.
- **Pro-rata removal refund** of an Active ICP placement is gated behind an `override_floor`-style admin
  ack (it's a treasury outflow; the ICP treasury floor is otherwise bypassed by refunds). (Finding 4.)
- **One placement per listing/applicant** — `apply_featured` rejects if the caller/`listing_id` already
  has an Active or Pending placement, so no one can corner 2–3 of the 3 slots. (Finding 6.)

## Open decisions (need a call — flagged for review)

- **D1 — Admin approval, or auto-go-live on payment?** The existing explorer requires admin approval, and
  "apply" implies review. **Recommend: admin-approved** (consistent, lets you reject scams before they hit
  the hero). Auto-approve is possible but then a paid scam dapp is briefly top-of-page.
- **D2 — RESOLVED above** (escrow-until-approval; see Funds & lifecycle model).
- **D3 — Logos:** the hero needs a visual; `DappListing` has no logo field. **Recommend:** optional
  https `logo_url` on the featured application (admin-reviewed), with a generated monogram fallback.
  (UX OD-1.)
- **D4 — Duration range & default premium.** Recommend a tighter range than directory listings (e.g.
  7–90 days) since the spot is scarce, and a premium of ~10× the $1/day listing (~$10/day) — both
  admin-configurable. (Backend §2, UX OD-6.)
- **D5 — Auto-advance the slider?** **Recommend no** (a11y/tone); user-driven only. (UX OD-2.)
- **D6 — Admin "house feature"** (place a listing free) — allow, but drop the "paid placement" honesty
  line so a free promo isn't mislabeled as sponsored. (UX OD-8.)

## Build order (summary — full list in [`02-backend-and-tasks.md`](./02-backend-and-tasks.md))

1. Data model + stable maps (88/89/94) → 2. Premium pricing + `get_featured_quote` → 3. `apply_featured`
(escrow) → 4. approve / reject / remove + **max-3** → 5. expiry sweep (timer) → 6. `get_featured_dapps`
query → 7. frontend hero + 2-card slider → 8. apply-for-featured UI → 9. admin queue → 10. tests →
11. candid + bindings → 12. local deploy + manual anon-hero verify. **Do not deploy to mainnet without an
explicit ask.**

## Files

- [`01-ux-spec.md`](./01-ux-spec.md) — full UX: hero anatomy (featured + ad states), slider behavior,
  random selection, apply/purchase flow, admin moderation, responsive + a11y + copy, wireframes, 9 ODs.
- [`02-backend-and-tasks.md`](./02-backend-and-tasks.md) — data model, pricing, lifecycle, max-3,
  random-selection query, methods, persistence/upgrade/tests, and the ordered phased task list.
- [`03-reuse-map.md`](./03-reuse-map.md) — exact identifiers + line numbers to reuse (course
  `FeaturedSlot` analog, dapp-listing flow, quote/escrow/oracle, timers, frontend helpers, MemoryIds).
- [`04-adversarial-review.md`](./04-adversarial-review.md) — red-team pass over this spec.
