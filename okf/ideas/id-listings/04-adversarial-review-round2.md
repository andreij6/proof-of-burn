---
type: idea
title: "ID Listings — Adversarial Review, Round 2"
tags: [ideas, id-listings]
timestamp: 2026-06-16T05:25:50-04:00
---

# ID Listings — Adversarial Review, Round 2

> Two independent red-team agents attacked the *written design* — one technical/architecture (verifying
> claims against `lib.rs` and current IC docs), one product/legal/trust/abuse. This consolidates their
> findings. Corrections have been patched into README.md / 02 / 03 and are flagged "(patched)".
>
> **Headline:** the technical pass found my central architecture pivot was **wrong** (on-chain validation
> *is* possible), and the product/legal pass made a strong, well-cited case that the feature **should
> largely not be built as specified** — the two most user-visible elements (a validation **badge** and
> **cached prices**) are exactly what convert idgeek's risk into *our* liability and users' losses.

---

## Part A — Technical / architecture (verified against code + IC docs)

### A0 (Critical, patched) — Validation CAN run on-chain: `canister_info`, not `read_state`

My docs pivoted the whole architecture to an off-chain indexer because "a canister can't `read_state`,
so validation can't run on-chain." The `read_state` statement is true, but the **conclusion is false.**
The management canister method **`canister_info`** (rolled out 2023-06-05):

- is callable **by any canister, for any target** — **NOT controller-gated** (unlike `canister_status`);
- is callable **only via inter-canister call** (the canister-native counterpart of `read_state`);
- returns the target's current **`module_hash`**, current **`controllers`**, `total_num_changes`, and the
  20 most recent change records.

**Verified in this repo's pinned toolchain:** `ic-cdk` 0.19 ships
`canister_info(CanisterInfoRequest) -> CanisterInfoResponse` with `module_hash: Option<Vec<u8>>`,
`controllers`, `recent_changes` (`~/.cargo/.../ic-cdk-0.19.0/src/api/management_canister/main/`).

**Effect:** the geekfactory-style validation (module_hash + controllers, re-checked every cycle) **runs
on-chain in the backend timer**, comparing against admin-pinned expected values in `CONFIG`. The
off-chain-indexer-as-sole-validator design collapses. Staleness caveat still holds (`canister_info`
returns a live snapshot — re-check every cycle; use the *current* hash/controllers, not the bounded
20-entry change log, for the pass/fail). Sources: IC management-canister spec / canister-history docs.

> Note: the product/legal red-team (Part B) affirmed the old "can't validate on-chain" claim — that
> affirmation is **superseded** by this finding.

### A1 (High, patched) — Indexer was a trusted writer AND sole validator → contradicts "trustless"

With validation off-chain, a compromised/buggy indexer could fabricate listings *and* stamp
`source_validated=true`. The badge would mean "the indexer says so," not "the chain says so" — the
opposite of the stated "pre-validate the contract" goal. **Fix (patched):** validation moves on-chain
(A0) so the flag is canister-computed; the backend independently re-runs `canister_info` on ingest and
**rejects upserts when the source canister fails validation**, so even a compromised ingester can't push
listings from a drifted/swapped canister. (The product pass argues the badge should be removed entirely
anyway — see B4.)

### A2 (High, patched) — "Query returns verifiable canister state" overstates certification

A plain IC **query** is **not certified** — a dishonest boundary node/replica can return arbitrary data
on a query response; only **update calls** and `read_state`/certified-data carry chain-key signatures.
My docs were precise about certification for the *validation* path but called the *listing ingestion*
query "verifiable." **Fix (patched):** either ingest via an **update call** (replicated → certified) or
drop the "verifiable" language for listing data and rely solely on the mandatory deep-link to idgeek as
source of truth. (This dovetails with B5: don't present price/status as authoritative at all.)

### A3 (High, patched) — "Can't call a query from an update" is wrong

My docs claimed the on-chain path dies if idgeek's read method is query-only. The actual rule: **a
canister CAN call another canister's `query` (or `update`) method from its update-context timer** — it
just executes in replicated/update mode (more cycles, consensus latency). The genuine blockers are
narrower: idgeek's method being **`composite_query`-only** (ingress-only; canisters can't call it) or
**auth-gated**. **Fix (patched):** the on-chain inter-canister ingestion path is viable for any normal
query/update method; D0 must capture whether idgeek's method is `composite_query` or auth-gated (the real
blockers), and budget the per-poll replicated-call cost.

### A4 (Medium, patched) — Candid decode of an unknown interface fails hard

The data model is built on **unverified** idgeek fields, and "store raw `source_status` + derive" does
**not** rescue a decode mismatch: Candid decoding is structural — a renamed field, `nat32`→`nat64`, a new
`opt` wrapper, or a new variant arm **rejects the whole message**, you don't get a salvageable partial.
**Fix (patched):** pin the exact verified interface at D0; decode into a maximally-optional shape; wrap
the decode so a trap/decode-error = "ingest failed, keep last-good" and never poisons the timer tick; add
a canary alert on schema drift.

### A5 (Medium, patched) — Staleness on mutable financial state is higher-stakes than the Explorer analog

Reposting II+neuron sales where price/offers/sold-status mutate: a stale "Active" card for an
already-sold, repriced, or withdrawn *neuron bundle* is materially misleading, not cosmetic. The Dapp
Explorer it clones never reposts mutating third-party prices, so its TTL tuning isn't a precedent.
**Fix (patched, and reinforced by B5):** treat price/sold-status as **never authoritative in our UI** —
don't show price as a live figure; the deep-link is the only call-to-action; sweep sold/withdrawn
aggressively (cadence ≤ TTL); consider a just-in-time single-listing status re-fetch on card open.

### A6 (Medium, patched) — Put ingest on its OWN timer; budget cycles; the "free" claim is shaky

`setup_timers` already runs ~13 sequential `await` jobs every 300s (several inter-canister). Adding idgeek
ingest there means a slow/hanging idgeek call delays settlements/lottery/etc. **Fix (patched):** run
ingest on its **own** `set_timer_interval`; budget the recurring replicated-call + `canister_info` cost
explicitly (revisit "free v1").

### A7 (Low, patched) — Mirror must live in STABLE storage, not a heap cache

The reuse map pointed at heap caches (`EXPLORER_USD_RATES`, `LEADER_INFO`) as the template, but listings
should survive upgrades. **Fix (patched):** the mirror lives in the **stable** `ID_LISTINGS` map; heap is
only for transient rate data if promoted listings are ever added.

### Verified verdicts
- **"Canister can't `read_state`" — TRUE, but the architectural conclusion was FALSE** (use `canister_info`).
- **"MemoryId 53–59 free" — TRUE** (grep-verified; no collisions). Minor: 94–95 are also free, and the
  Faucet uses 90–93 + 96 (not the full 90–96 my doc implied). Harmless.

---

## Part B — Product / legal / trust / abuse (well-cited; recommends NOT building most of it)

> The product pass's bottom line: **don't build the reposting feature as specified.** Mirroring a market
> in "buy someone's Internet Identity + their neurons" and stamping it with a trust badge amplifies a
> harm the IC protocol was deliberately designed to suppress, for marginal benefit over a plain link.

### B1 (Critical) — Amplifying a market the protocol deliberately prevents

DFINITY intentionally blocks canisters from controlling ICP neurons **specifically to stop neuron
marketplaces** (governance-attack risk + the long-term-alignment premise of staked voting). idgeek routes
around that guardrail by selling the **II credential** instead of transferring the neuron. A second app
that aggregates, ranks, and badges these listings actively normalizes the exact behavior the platform
de-sanctioned. For a **governance-adjacent** dapp (Proof of Burn / Cycles of Influence) whose value is
community trust, "the app that promotes selling people's identities and governance power" is a brand you
can't easily walk back. Sources: forum *Reevaluating Neuron Control Restrictions* (28597), *Should
canisters control ICP neurons* (24568).

### B2 (Critical) — Known-Neuron follower-delegation: selling votes nobody consented to

When an II controlling a **Known Neuron** (a follow target) is sold, the followers' delegated voting
power silently transfers to an unknown buyer — a live governance-capture vector the community flagged
directly (*Known Neurons & ID Geek*, 27413). Reposting/featuring such a listing means our app advertises
"buy this bundle of other people's delegated votes." We can't reliably detect which neurons are follow
targets — another reason to avoid neuron listings wholesale. The docs didn't mention this at all.

### B3 (Critical) — Seller-recoverability: "sell an II you can take back"

II is multi-device + recovery-phrase based. idgeek's escrow disables *voting* during the window, but
nothing establishes a sold II is genuinely unrecoverable afterward (lingering recovery phrase, a second
passkey, a hidden recovery device). The validation badge checks idgeek's *canister code* — it says
nothing about whether a *specific seller* kept a backdoor. This is classic identity-resale fraud
(sell access, keep a recovery path, drain later), plus stolen-II laundering and IIs still entangled with
*other* services. **Intrinsic to identity resale; unmitigable from an aggregator.**

### B4 (High) — The validation badge is a trust trap → REMOVE it

A green "validated contract" badge next to a *sale* reads as "this listing/sale is safe." It actually
proves only that idgeek's canister hash+controllers are unchanged since an admin glanced once — nothing
about listing legitimacy, neuron transferability, seller rug, or current price. Careful wording does not
beat the visual semantics of a badge; nobody reads the footnote. This is where false confidence becomes
user losses **and our liability**. **Recommendation (patched into design): remove the badge entirely.**
At most a neutral factual line on a details page ("idgeek's marketplace canister code unchanged since
[date]") — no checkmark, no color, no "validated" word, never on the card.

### B5 (High) — Cached price/status for a financial decision = misrepresentation → don't cache prices

A user acting on *our* stale number (makes an offer, picks this listing) has a real grievance — the exact
fact pattern for a misrepresentation/reliance claim, and avoidable. **Recommendation (patched): do not
cache or display price/offer figures at all;** show only non-financial discovery metadata, fetch live or
link out for price/status. If product value depends on showing prices, that's a signal the value isn't
there (B10).

### B6 (High) — Revocable SNS transferability makes a listing class unsound

DFINITY: SNS neuron transferability "can be disabled at any moment by the collective will of the relevant
SNS DAO... completely outside the control of IDGeek" (*How reliable is idgeek*, 25461). An SNS-bundled
listing can become non-deliverable mid-sale through no fault of anyone. **Recommendation: exclude SNS- (and
per B1–B2, NNS-) neuron listings** — which leaves little but bare anchor numbers (see B10).

### B7–B9 (Medium → counsel, don't self-clear)

- **B7 Endorsement liability:** selecting/normalizing/ranking/badging third-party listings is editorial
  conduct implying vetting → negligent-misrepresentation / implied-warranty exposure; disclaimers are
  weakened by a simultaneous "validated" signal. Kill badge + cached prices; keep presentation neutral.
- **B8 Trademark / IP / ToS / scraping:** using "idgeek"/"geekfactory" marks, mirroring their data, and
  reverse-engineering their private SPA interface (the doc's literal "Step 0") raise trademark, DB/
  misappropriation, and anti-circumvention concerns. **Make consent a HARD GATE (D3), not a footnote** —
  contact GeekFactory for an explicit data/API/partnership agreement *before* any build; if they decline,
  a plain "visit idgeek" link with no data mirroring is the only consent-free option.
- **B9 Regulatory:** advertising sales of identities/credentials + financial instruments (staked neurons)
  can implicate **AML/KYC, money-transmission, securities, consumer-protection/false-advertising**
  depending on jurisdiction/role. The **promoted-listing fee** idea materially worsens this (taking money
  to advertise identity/neuron sales) — **drop monetization from scope.** Flag all four categories to
  counsel.

### B10 (Deciding factor) — Thin product value; the safe version barely needs building

Strip everything dangerous (no badge, no cached prices, no neuron listings, no ranking/promotion) and
what remains is "a list of idgeek anchor numbers that link to idgeek" — a bookmark, not a product, built
on expensive new infra for marginal discovery convenience. **Ranked recommendations:**

1. **Don't build the repost feature.** Best option given B1–B3.
2. **If you want *something*:** a single, manually-curated, **consent-based** "ecosystem links" card that
   links to idgeek — **no data mirroring, no badge, no prices, heavy disclaimer.** Days, not weeks; sidesteps
   B4/B5/B8.
3. **Reframe as user protection:** a neutral **risk explainer** ("what to know before buying/selling an II
   or neuron") that links to idgeek and the DFINITY threads. On-brand for a governance dapp — turns the
   feature from market lubrication into community protection.

### What the product pass said the docs got right
Read-only/no-custody (D1) minimizes fraud surface; honest that the badge is a snapshot and idgeek is
operator-controlled not trustless; honest that idgeek exposes no usable interface and the schema is
unconfirmed.

---

## Net effect on the proposal

- **Technically:** the build is *more* feasible than I first wrote (on-chain validation via
  `canister_info`; on-chain ingestion viable for normal query/update methods) — but several "verifiable"
  claims were overstated and are corrected.
- **As a product:** the honest recommendation is **don't ship the badge or cached prices, exclude
  neuron-bundled listings, make GeekFactory consent a hard gate, drop monetization, and seriously
  consider not building the aggregator at all** — favoring a consent-based link card or a risk-explainer
  that's on-brand for a governance dapp. The original D1 ("v1 = aggregator, assume yes") is **reopened.**
