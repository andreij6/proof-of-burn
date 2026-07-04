---
type: idea
title: "ID Listings — Repost idgeek Identity Listings (with contract pre-validation)"
tags: [ideas, id-listings]
timestamp: 2026-06-16T05:25:50-04:00
---

# ID Listings — Repost idgeek Identity Listings (with contract pre-validation)

> **Status:** Exploration / design proposal. Not built. Not scheduled.
> **Date:** 2026-06-15
> **Author:** drafted with a research + adversarial-review agent fan-out (see
> [`01-idgeek-research.md`](./01-idgeek-research.md), [`02-validation-method.md`](./02-validation-method.md),
> [`03-implementation-plan.md`](./03-implementation-plan.md), [`04-adversarial-review-round2.md`](./04-adversarial-review-round2.md)).
>
> ## ⚠️ Recommendation after adversarial review: probably DON'T build this as specified
>
> A Round-2 product/legal red-team made a strong, well-cited case to **not build the reposting feature as
> written** ([`04`](./04-adversarial-review-round2.md) Part B):
> - **It amplifies a market the IC protocol was deliberately designed to suppress** — DFINITY blocks
>   canister-controlled neurons *specifically to prevent neuron marketplaces*; idgeek routes around that
>   by selling the II credential. For a governance-adjacent dapp, "the app that promotes selling people's
>   identities and governance power" is a brand you can't walk back. (B1)
> - **Known-Neuron follower delegation** means selling an II can transfer votes *other people delegated* —
>   governance capture we can't reliably detect. (B2)
> - **Seller-recoverability:** an II can be "sold" and later recovered by the seller; unmitigable from an
>   aggregator. (B3)
> - The two most user-visible elements — a **validation badge** and **cached prices** — are exactly what
>   convert idgeek's risk into *our* liability and users' losses. (B4, B5)
>
> **Ranked alternatives:** (1) don't build it; (2) a consent-based, manually-curated "ecosystem link"
> card to idgeek with no data mirroring / no badge / no prices; (3) reframe as a neutral **risk
> explainer** ("what to know before buying/selling an II or neuron") that links out — on-brand for a
> governance dapp. Decision **D1 is reopened.** A Round-2 technical pass also found the build is *more*
> feasible than first written (on-chain validation via `canister_info`) — the sections below are corrected
> accordingly, but "more feasible" is not "should build."

## What was asked

> "Research the idgeek app and how it sells identities (https://xdtth-dyaaa-aaaah-qc73q-cai.raw.icp0.io/).
> I want users to be able to repost active & upcoming listings, and my app should pre-validate the
> existing contract using the https://geekfactory.app/ method to validate the contract."

## What this feature is (and is not)

**Is:** an **aggregator / mirror.** Our app fetches idgeek's active & upcoming identity listings, displays
them in a new "ID Listings" page (modelled on the existing Dapp Explorer), and deep-links each card back
to idgeek for the actual transaction. Before trusting idgeek's data, we **pre-validate idgeek's
canister(s)** using the geekfactory-style method (module-hash + controller check, on-chain via
`canister_info`). Note: Round-2 review recommends **against a user-facing "validated" badge** (it implies
sale safety it can't deliver — see banner above and [`04`](./04-adversarial-review-round2.md) B4).

**Is not:** we do **not** custody identities, escrow funds, settle sales, or hold neurons. The sale
happens entirely on idgeek. This keeps our custody/fraud surface near zero — but it shifts the risk to
**data accuracy, staleness, liability, and the trust we imply by reposting** (see §Risks).

> **Decision (D1):** v1 is a **read-only aggregator that links out to idgeek**, not a competing
> marketplace and not a relay that lets *our* users create listings. If you want native listing creation
> later, that's the "neuron sale / custody" problem from `/ideas/nueron-sale` — out of scope here.

## TL;DR — two facts that gate the whole build

1. **idgeek exposes no usable public interface yet (to us).** idgeek is a client-rendered SPA with no
   JSON/REST endpoint and no scrapeable HTML. The **backend canister id, the listing query method, and
   the listing schema are all unconfirmed** — they must be captured from the SPA's live network calls in
   a browser before any ingestion can be written. Leading (unconfirmed) backend candidate:
   `cocmv-eiaaa-aaaah-qdbxq-cai`. See [`01-idgeek-research.md`](./01-idgeek-research.md) §2.
   **→ Step 0 of this project is reverse-engineering idgeek's read interface. Everything else is blocked
   on it.**

2. **Validation CAN run on-chain via `canister_info` (Round-2 correction).** My first draft said the
   backend can't validate idgeek because it can't `read_state` and `canister_status` is controller-only.
   That conclusion was **wrong.** The management-canister method **`canister_info`** is callable **by any
   canister for any target, not controller-gated**, and returns the target's current `module_hash` +
   `controllers` (+ recent change history). It's present in this repo's pinned `ic-cdk` 0.19. So the
   geekfactory-style check (module_hash == pinned expected; controllers == pinned expected, re-checked
   every cycle) **runs on-chain in the backend timer** — the result is canister-computed, not an
   off-chain assertion. `read_state` (frontend/agent) is still useful for a live, user-side re-check.
   See [`02-validation-method.md`](./02-validation-method.md) and [`04`](./04-adversarial-review-round2.md) A0.

So the realistic architecture is **on-chain validation + on-chain ingestion** (if idgeek exposes a normal
`query`/`update` method — see below), with an off-chain indexer only as a fallback (e.g. if idgeek's read
method turns out to be `composite_query`-only or auth-gated).

## Architecture

> **Round-2 update:** the original "off-chain indexer is the centerpiece" recommendation was driven by
> the now-corrected belief that validation can't run on-chain. With `canister_info`, the **recommended
> architecture is on-chain validation + on-chain inter-canister ingestion**, with the off-chain indexer
> demoted to a *fallback* (only if idgeek's read method is `composite_query`-only or auth-gated). The
> diagram below is retained for the indexer-fallback case; see the corrected notes after it.

```
  idgeek backend canister (cocmv-…? — CONFIRM)
        │  (1) query listings via IC agent
        ▼
  Off-chain indexer (our worker; agent-js / ic-agent)
        │  (2) read_state idgeek canister: module_hash + controllers → VALIDATE
        │      (verify chain-key certificate; compare to pinned expected values)
        │  (3) normalize listings → {anchor, price, currency, start, end, status, offers, validated}
        ▼
  Our backend canister  (admin/indexer-only ingest method, MemoryId from free list)
        │  (4) store mirrored listings + validation result + fetched_at
        ▼
  Our frontend "ID Listings" page (reuse Explorer.tsx anatomy)
        │  (5) render cards; OPTIONALLY re-validate live via agent-js read_state in the browser
        ▼  deep-link "View on idgeek" → https://idgeek.app/identity/<anchor>
      user transacts on idgeek (NOT in our app)
```

Corrected notes (Round 2):
- **Validation runs on-chain** via `canister_info` (fact #2 corrected). The backend re-runs it every
  cycle and **rejects an ingest upsert if the source canister fails validation** — so even a compromised
  ingester can't push listings from a drifted/swapped canister ([`04`](./04-adversarial-review-round2.md) A1).
- **On-chain ingestion is viable for a normal `query` OR `update` method.** A canister *can* call another
  canister's query method from its update-context timer (it runs replicated/more-expensive). The real
  blockers are idgeek's method being **`composite_query`-only** (ingress-only) or **auth-gated** — that's
  what D0 must determine ([`04`](./04-adversarial-review-round2.md) A3).
- A plain query response is **not certified** — so do **not** call ingested listing data "verifiable";
  ingest via an update call if you want certification, else treat the deep-link to idgeek as the only
  source of truth ([`04`](./04-adversarial-review-round2.md) A2, and B5: don't present price as authoritative).
- HTTPS outcalls won't help: idgeek serves an SPA shell, not JSON (and this repo has no HTTPS-outcall
  infra; [`03`](./03-implementation-plan.md) §1).
- **Off-chain indexer = fallback only**, for the `composite_query`/auth-gated case. If used, it never owns
  the validation verdict (that's on-chain); it only ferries listing data through the validation-gated
  ingest method.
- The mirror lives in **stable** storage (survives upgrades), and ingest runs on its **own timer** (so a
  hung idgeek call can't stall settlements) ([`04`](./04-adversarial-review-round2.md) A6, A7).

## The validation step ("geekfactory method")

Before reposting, and on a re-validation cadence, verify idgeek's marketplace canister(s):

| Check | Source (certified `read_state` path) | Pass condition |
|---|---|---|
| **Code identity** | `/canisters/<idgeek_backend>/module_hash` | equals the **pinned expected hash** (from a reproducible build of idgeek's published source, or the last admin-approved hash) |
| **Mutability / ownership** | `/canisters/<idgeek_backend>/controllers` | equals the **pinned expected controller set** (idgeek is operator-controlled, NOT blackholed — so the realistic check is "controllers unchanged since admin approval," not "immutable") |

The check **runs on-chain** in the backend via `canister_info` (Round-2 correction), compared to
admin-pinned expected values, re-run every ingest cycle. The frontend may additionally do a live
`read_state` re-check for a user-side signal.

**Critical caveats (from research) — and why the badge should be REMOVED:**
- A module-hash match proves only the code running *right now*; a non-blackholed canister can upgrade a
  second later. Hash is meaningless without the controller check, and both are snapshots — re-validate
  every cycle.
- idgeek is **operator-controlled, not trustless** (the operator can stop or change the contract).
- **Round-2 product finding (B4): do NOT show a "validated" badge.** A green badge next to a *sale* reads
  as "this sale is safe," but the check proves nothing about listing legitimacy, neuron transferability,
  seller rug, or current price — it only proves idgeek's *canister code* is unchanged. Careful wording
  loses to the visual semantics of a badge. **At most** a neutral factual line on a details page
  ("idgeek's marketplace canister code unchanged since [date]") — no checkmark, no color, no "validated"
  word, never on the card. This is the element most likely to create false confidence and our liability.
- "the geekfactory method" is **inferred**, not confirmed from a primary source. We implement the robust
  ICP-native equivalent (hash + controllers — on-chain via `canister_info`, plus optional frontend
  `read_state`). [`02`](./02-validation-method.md) §2.

## Active vs upcoming listings

idgeek's lifecycle is **time-window driven**: a listing "starts with 30 days of protection," offers are
made during the window, and after it expires it becomes a direct purchase / remaining-days countdown.
We derive status from timestamps rather than trusting a discrete flag:

- **Upcoming** = `now < start_time` (scheduled go-live), if idgeek exposes a future start; otherwise
  treat "in protection/offer window" as one state.
- **Active** = `start_time ≤ now < end_time`.
- **Expired/sold** = `now ≥ end_time` or status sold → drop from the repost.

> **FLAG:** idgeek's exact status enum and which field drives active/upcoming are **unverified** (Step 0).
> Design stores `start_time` + `end_time` + a raw `source_status` string and derives our display status,
> so we're robust to whatever idgeek actually returns.

## Fees

This is an aggregator that links out — **there is no sale settlement in our app, so the neuron-sale fee
model does not apply.** Options for monetization, if any:

- **v1: free.** Reposting is a content/discovery feature; no fee.
- **~~Optional later: promoted-listing fee~~ — Round-2 product finding (B9): DROP monetization from
  scope.** Taking money to advertise identity/neuron sales materially worsens the regulatory posture
  (money-transmission / false-advertising) and the optics. Do not charge to promote third-party
  identity-sale links.

> **Decision (D2):** v1 free, no fees, and **no promoted-listing monetization at all** (B9).

## Risks (this feature's real surface — not custody, but not zero)

**Round-2 governance/abuse risks (the strongest arguments against building — see [`04`](./04-adversarial-review-round2.md) Part B):**
- **Amplifying a de-sanctioned market (B1)** — the protocol blocks canister-controlled neurons to prevent
  neuron marketplaces; reposting idgeek normalizes the workaround. Brand risk for a governance dapp.
- **Known-Neuron follower delegation (B2)** — selling an II that's a follow target transfers *other
  people's* delegated votes to an unknown buyer; we can't reliably detect this. Exclude neuron listings.
- **Seller-recoverability (B3)** — a "sold" II may be recoverable by the seller (recovery phrase / hidden
  passkey); intrinsic to identity resale, unmitigable from an aggregator. Also: stolen-II laundering, IIs
  still entangled with other services.
- **Revocable SNS transferability (B6)** — an SNS DAO can disable transfer mid-sale, making a listing
  undeliverable through no fault of anyone. Exclude SNS-neuron listings.

**Data/liability risks:**
- **Stale / wrong data** — prices, offers, and status mutate on idgeek; a reposted card can show a sold
  or repriced listing. Mitigation: short TTL, `fetched_at` on every card, re-validate before display,
  always deep-link to the live idgeek page as source of truth.
- **Implied endorsement / liability** — by reposting we imply these are legit. idgeek is
  operator-controlled and DFINITY has flagged that SNS-neuron transferability can be revoked by the SNS
  DAO mid-sale. Mitigation: prominent "sourced from idgeek — we are not affiliated and do not custody or
  guarantee these sales" disclaimer; and per Round-2 B4, **no "validated" badge** (see §validation).
- **Legal / ToS / trademark (now a HARD GATE, B8)** — using "idgeek"/"geekfactory" marks, mirroring their
  data, and reverse-engineering their private SPA interface (the literal "Step 0") raise trademark, DB/
  misappropriation, and anti-circumvention concerns. **Get explicit GeekFactory consent / a data
  agreement BEFORE any build (D3);** if they decline, a plain "visit idgeek" link with no data mirroring
  is the only consent-free option.
- **Regulatory (B9, flag to counsel)** — advertising sales of identities + financial instruments (staked
  neurons) can touch AML/KYC, money-transmission, securities, and false-advertising depending on
  jurisdiction/role. Get counsel before launch; the dropped promoted-listing fee would have worsened this.
- **Source interface breakage** — idgeek is an unverified, changeable interface; an upgrade can break our
  ingestion or the schema. Mitigation: ingestion failures degrade gracefully (serve last-good + stale
  badge), alert admin.
- **Validation false-confidence** — see §validation caveats; a passing badge is a snapshot, not a
  guarantee. Word it accordingly.

## Open questions / decisions

- **D0 (blocking):** capture idgeek's real backend canister id + public read method + listing schema from
  the SPA's live network calls. Nothing can be built until this is known.
- **D3:** legal/ToS/trademark sign-off for reposting idgeek listings & using the marks.
- **D4:** indexer vs pure-on-chain ingestion (recommend indexer; depends on D0 — is idgeek's read method
  a public query?).
- **D5:** validation cadence + what we pin as "expected" (idgeek's current hash/controllers at admin
  approval) and what happens to live listings when validation drifts (hide vs flag).
- **D6:** do we ever want native listing creation / our own escrow? (Out of scope; that's `nueron-sale`.)

## Files in this folder

- [`01-idgeek-research.md`](./01-idgeek-research.md) — what idgeek sells, its canister surface, the
  active/upcoming lifecycle, ingestion options, and the (many) unverified items. Citation-backed.
- [`02-validation-method.md`](./02-validation-method.md) — the geekfactory "validate the contract" method
  and trust caveats. **(Corrected: on-chain `canister_info` is preferred over the off-chain `read_state`
  framing — see Round 2 A0.)**
- [`03-implementation-plan.md`](./03-implementation-plan.md) — reuse map against the Dapp Explorer / XRC
  oracle / timers, data model, and test plan. **(Corrected after Round 2 — on-chain validation, own
  timer, stable storage, no badge/prices.)**
- [`04-adversarial-review-round2.md`](./04-adversarial-review-round2.md) — the two red-team passes
  (technical + product/legal). **Read this before trusting anything above; it reopens the should-we-build
  question.**
