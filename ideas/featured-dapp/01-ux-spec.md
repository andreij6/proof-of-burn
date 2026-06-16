# UX Spec — Featured Dapp Hero (Dapp Explorer)

> Surface: `src/frontend/src/Explorer.tsx`. Grounded in the existing Explorer directory + submit/quote/
> admin-approval flow and the `CourseMarketplace.tsx` featured-card precedent. Reuses the shared `ui.tsx`
> vocabulary (`Btn`, `Chip`, `Icon`, `Eyebrow`, `LiveDot`, `MoreInfo`, `MODAL_OVERLAY`/`MODAL_CARD`).

## 1. Goals & constraints

| # | Requirement | Section |
|---|---|---|
| G1 | Full-width hero at the top of the Explorer | §2–3, §8 |
| G2 | 2-card slider: slide 1 = featured dapp, slide 2 = ad | §4 |
| G3 | Premium, fixed-length featured window | §6 |
| G4 | Max 3 featured at once | §5, §7 |
| G5 | One of the active (≤3) chosen at random per page load | §5 |
| G6 | If none active, hero falls back to the ad | §5 |
| G7 | Honest "paid placement" copy + strict light/dark contrast | §9 |

**Inherited principles:** page-anatomy (`Eyebrow accent` → icon + `h4` → one-line value prop + `MoreInfo`
long form); money shown USD-denominated with a live token quote + "price locked 15 min" + balance line;
pay-into-escrow then admin approval gates visibility, reject = refund minus one ledger fee; color tokens
only (`--burn`, `--burn-ink`, `--fg`/`--fg-2`/`--fg-3`, `--ember`, `--haze-ink`), tints via
`color-mix(... transparent)` so they read in both themes — no hardcoded hex on text.

## 2. Placement

Insert the hero **between the page header and the category filter row** in `Explorer` (after the header
`MoreInfo` paragraph, before the filter pills). Full-width (spans the container like the course featured
card's `gridColumn: '1 / -1'`), visually distinct from the 3×3 grid via an elevated surface
(`--surface-hi` / `--elev-2`) and `burn`-toned "Featured" framing. The directory grid, paging, and modals
below are untouched.

## 3. Hero anatomy

The hero is one full-width card with a viewport showing exactly one of two slides; both slides share a
min-height so the slider doesn't jump.

### 3a. Slide 1 — FEATURED state
```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◜ FEATURED · PAID PLACEMENT                                    ● Featured   │
│   ┌────────┐   Acme Swap                                  ⏱ 12d left         │
│   │  LOGO  │   [DeFi] [Trading]                                              │
│   │  64px  │   Lightning-fast token swaps on the IC with zero gas.          │
│   └────────┘                                                                 │
│   ⓘ This is a paid placement.                              [ Visit  ↗ ]     │
│                              ●  ○                          ‹   ›             │
└────────────────────────────────────────────────────────────────────────────┘
```
- **Eyebrow** "FEATURED · PAID PLACEMENT" (honest framing up front).
- **Badge** `Chip tone="burn"` + `LiveDot`, top-right (same as the course featured card).
- **Logo** 64px. `DappListing` has no logo today → **monogram tile fallback** (first letter, `--burn-ink`
  on `color-mix(var(--burn) 16% transparent)`); add optional https `logo_url` to the application (OD-1).
- **Name** `h4/h5`, `overflowWrap: anywhere`. **Categories** ≤3 `Chip tone="muted"` (reuse listing).
- **Description** `--fg-2`, **2-line clamp** (keeps both slides equal height). Vibe-coded `Chip tone="ok"`
  inline if set.
- **Time-remaining** `⏱ {n}d left` mono `--fg-3`, `--haze-ink` at ≤5d (matches grid `dappDaysLeft`).
- **Honesty line** "This is a paid placement." (always in featured state).
- **CTA** `Btn variant="primary"` "Visit ↗" wrapping `<a target="_blank" rel="noopener noreferrer">`.

### 3b. Slide 2 (and fallback Slide 1) — ADVERTISEMENT state
```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◜ SPONSORED SPOT                                          ✦ 2 of 3 open    │
│   ✦ Feature your dapp here                                                   │
│   Put your dapp in front of every Explorer visitor. One of up to three      │
│   spots, shown at the top — from $X/day, paid in ICP or any ck-token.       │
│   ⓘ Paid placement · admin-reviewed   [ How it works ]  [ Feature my dapp ] │
│                              ○  ●                          ‹   ›             │
└────────────────────────────────────────────────────────────────────────────┘
```
- **Eyebrow** "SPONSORED SPOT". **Availability chip** (top-right): ≥1 open → `Chip tone="ok"` "✦ {n} of 3
  open"; 0 open → `Chip tone="muted"` "✦ Sold out — 3 of 3 filled".
- **Headline** `Icon name="spark"` + "Feature your dapp here". **Value prop** includes price (from `info`,
  like the directory's $1/day), the cap ("one of up to three"), the placement ("top of the Explorer").
- **CTAs** `MoreInfo` "How it works" + primary `Btn` "Feature my dapp" (signed-out → `onSignIn()`).
  Sold-out → "Join the waitlist"/disabled per OD-3. **Honesty line** "Paid placement · admin-reviewed".

## 4. Slider behavior (exactly 2 slides)

| Aspect | Spec |
|---|---|
| Slides | Always 2: `[chosen-dapp-or-ad, ad]`. When 0 active, **collapse to a single static ad card** (no dots/arrows) — two identical slides is pointless. |
| Controls | 2 dots bottom-center + prev/next `Btn variant="ghost" sm` (`Icon chevLeft/chevRight`), matching the grid pager. |
| Auto-advance | **None (recommended).** Auto-rotating carousels are an a11y/usability liability and clash with the calm tone. If forced: 7s, pause on hover/focus, disabled under reduced-motion (OD-2). |
| Transition | `transform: translateX` with `var(--dur)`/`var(--ease-out)`; container `overflow: hidden`. |
| Reduced motion | `prefers-reduced-motion` → instant cut/cross-fade, no translate. |
| Swipe (mobile) | Horizontal swipe (~40px threshold) advances; only capture when |Δx| > |Δy| so vertical scroll passes through. |
| Keyboard a11y | Labeled region; Left/Right arrows move slides when focus is inside; dots are real `<button>`s with `aria-current`; off-screen slide `inert`/`aria-hidden` so Tab can't reach the hidden CTA. |
| Focus | On slide change, move focus to the new slide's region (not its CTA — don't yank into an external link). |

## 5. Random selection (1 of ≤3 per load)

On mount, fetch the active set (≤3), pick **one at random** for slide 1, seeded per page load
(`seedRef.current = freshSeed()` like `CourseMarketplace`, stable within the visit, re-rolls each visit).
Reuse `shuffleSeeded`/`poolOrder`/`freshSeed` from `arcade/courseMarket.ts`.

**OD-4 — arrows page all active dapps, or only the 2 slides? → Only the 2 slides.** (1) The requirement
is literally "2-card slider." (2) The product value of randomness is *fair rotation of exposure* across
the paying dapps; letting users browse all 3 dilutes what advertisers paid for (top-of-fold single pick).
(3) All featured dapps still appear in the directory grid below, so nothing is hidden.

**Fallback (0 active, G6):** slide 1 = ad; since slide 2 is also the ad, collapse to a single static ad
card (drop slider chrome) — clean house-ad, no degenerate 2-identical-slide carousel.

| Active count | Slide 1 | Slide 2 | Slider chrome | Availability chip |
|---|---|---|---|---|
| 0 | Ad | — | hidden (static) | "3 of 3 open" |
| 1 | the dapp | Ad | shown | "2 of 3 open" |
| 2 | random of 2 | Ad | shown | "1 of 3 open" |
| 3 | random of 3 | Ad | shown | "Sold out — 3 of 3 filled" |

## 6. Application / purchase flow

Reuses the "List your dapp" submit modal mental model: pick duration → live USD quote in chosen token →
pay into escrow → pending admin approval → live once approved. Entry: the ad slide's "Feature my dapp"
CTA (signed-out → `onSignIn()`).

**Modal "Feature your dapp"** (`MODAL_OVERLAY`+`MODAL_CARD`), header `Icon spark` + "Feature your dapp".
Top `--haze` info box (honest):
> Featured spots sit at the very top of the Explorer — one of up to **three** at a time, one shown at
> random per visitor. It's a **paid placement**, reviewed by an admin before it goes live. Your paid days
> start counting **at approval**. If rejected, you're refunded (minus one ledger fee).

Fields: (1) **Which dapp** — radio/select of the caller's own approved listings (`list_my_dapp_submissions`);
none → inline "List your dapp first" + open submit modal (OD-5: don't allow brand-new+feature in one
flow). (2) **Optional logo** (OD-1). (3) **Duration** `Days featured · {premium}/day`, min/max from
backend config (OD-6: e.g. 7–90). (4) **Pay with** — the 5-token pill row.

**Quote box** (identical to Explorer's): `{amount} {TOKEN} = {USD} ({n} days × {premium})` ·
`1 {TOKEN} ≈ {rate} · price locked 15 min · balance {bal}`. States: fetching / no-quote / error (`--ember`).
Primary: `Pay {amount} {TOKEN} & apply` → step 1 pay into escrow, step 2 submit application → success
panel "Submitted! Goes live (and paid days start) once approved."

**Sold-out at submit (OD-3 — RESOLVED, see [04 F1](./04-adversarial-review.md)):** the application is
accepted as **Pending with funds held in the caller's escrow subaccount** (escrow-until-approval — funds
never reach treasury while Pending), so there's no indefinite treasury custody. Warn: "All 3 spots filled
— your application is queued and won't go live until a spot opens. Withdraw any time for a refund."
**Auto-refund** kicks in if it stays Pending past 7 days. (The earlier "reserve-only / charged when a slot
frees" idea is dropped — it was incompatible with charging on apply.)

**"Your featured spots" strip** (mirrors "Your pending listings"):

| State | Chip | Action |
|---|---|---|
| Pending approval | `pending` "Featured · pending" | Withdraw → refund (−fee) |
| Queued (sold out) | `pending` "Featured · queued (3/3)" | Withdraw → refund |
| Active/live | `burn` "Featured · live · {daysLeft}d" | — |
| Expired | `muted` "Featured ended {date}" | Re-feature |
| Rejected | `danger` "Featured · rejected — refunded" (+reason) | Re-apply |

## 7. Admin moderation

Parallel to the existing `pendingDapps` queue. A "Featured applications" section with a header counter
"{n} of 3 live":
- **Pending rows** — reuse `adminQueue` buttons: `Btn danger` "Reject & refund" + `Btn primary` "Approve"
  (`actionBusyId` lock). **Approve hard-blocks at 3 active** (disabled + tooltip "3 spots already live —
  remove one first"), preventing the cap being exceeded server-side.
- **Active rows** — name, category, days-left, paid amount + USD, `Remove` (`Btn ghost` ember) with a
  confirm modal ("Remove {name}? {daysLeft} days left") and an admin choice to **pro-rata refund unused
  days** (OD-7, default on).
- **Promote a listing** — admin places an existing listing into a free spot without payment ("house
  feature"); drop the "paid placement" honesty line so it isn't mislabeled (OD-8).
- Actions refetch via `refreshAll`; the hero re-reads its active set on success.

## 8. Responsive

**Desktop (≥720px):** full-width horizontal — logo left, text center, time/CTA right, min-height ~150px;
arrows flank edges, dots bottom-center. **Mobile (<720px):** stacked, full-bleed within page padding; CTA
full-width; arrows hide in favor of swipe + dots; availability chip wraps under the eyebrow.

## 9. A11y, contrast, copy

**Carousel ARIA:** region `aria-roledescription="carousel"` `aria-label="Featured dapp"`; each slide
`role="group"` `aria-roledescription="slide"` `aria-label="N of 2"`, hidden slide `aria-hidden`+`inert`;
dots `aria-label="Show slide N of 2"` `aria-current`; arrows labeled; polite `aria-live` status
("Slide 1 of 2, featured dapp Acme Swap"). No auto-advance = no pause control needed.

**Contrast (strict standard):** theme tokens only — body `--fg`/`--fg-2`, meta `--fg-3`, accents via
`*-ink`; chip tints `color-mix(... transparent)`; monogram tile `--burn-ink` on `color-mix(var(--burn)
16% transparent)` verified ≥4.5:1 both themes; ≤5d uses `--haze-ink` not raw red; primary CTA `--char-950`
on `--burn`. Run the frontend contrast check before ship.

**Copy (honest paid placement, non-negotiable):** eyebrow discloses "FEATURED · PAID PLACEMENT" /
"SPONSORED SPOT" before the name; persistent "This is a paid placement." line; ad states price + cap +
"admin-reviewed"; avoid "endorsed/recommended/best"; `MoreInfo` repeats "Inclusion is not an endorsement;
every featured dapp is reviewed by an admin before going live."

## 10. Open UX decisions

| ID | Decision | Recommendation |
|---|---|---|
| OD-1 | Logos | Optional https `logo_url` (admin-reviewed) + monogram fallback |
| OD-2 | Auto-advance | No; user-driven only |
| OD-3 | Charge when sold out | RESOLVED: escrow-until-approval — accept Pending with funds held in caller escrow; withdraw-refund + 7-day auto-refund (see 04 F1) |
| OD-4 | Arrows scope | Only the 2 slides (preserves the paid random single-pick) |
| OD-5 | New dapp + feature in one flow | No — require an existing approved listing |
| OD-6 | Duration range | Tighter than directory (e.g. 7–90 days) |
| OD-7 | Admin removes a live spot | Offer pro-rata refund of unused days, default on |
| OD-8 | House feature visual | Same card, drop the "paid placement" line (don't mislabel) |
| OD-9 | Exactly 1 active | Still show the 2-slide slider (ad keeps selling open spots) |

## 11. New/changed pieces

New `FeaturedHero` at top of `Explorer`. Reuses `MODAL_OVERLAY`/`MODAL_CARD`, the quote `useEffect`+box,
the token pill row, the `--haze` info box, `dappDaysLeft`, `Chip`/`Btn`/`Icon`/`Eyebrow`/`LiveDot`/
`MoreInfo`, the `adminAction` approve/reject/remove pattern, and `shuffleSeeded`/`poolOrder`/`freshSeed`.
New applicant "Your featured spots" strip + admin "Featured applications" section (with the 3-cap guard).
Backend surface in [`02-backend-and-tasks.md`](./02-backend-and-tasks.md).
