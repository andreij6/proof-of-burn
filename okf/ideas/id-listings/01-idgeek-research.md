---
type: idea
title: "idgeek — Research (for a repost/aggregation feature)"
tags: [ideas, id-listings]
timestamp: 2026-06-16T05:25:50-04:00
---

# idgeek — Research (for a repost/aggregation feature)

> Research against the idgeek app, the IC dashboard / ic-api, and the DFINITY forum. **Methodology
> limit:** idgeek's frontend is a client-side-rendered SPA — every server fetch of `/`, `/marketplace`,
> `/faq`, `/identity/<n>` returns only the `IDGEEK 2.0` shell; listing data is fetched in-browser via
> canister query calls. So several specifics below are **FLAGGED as unverified** and require capturing
> the SPA's live network calls in a browser to confirm.

## 1. What is sold

idgeek ("ID Geek", "IDGEEK 2.0") is a marketplace for buying/selling **Internet Identity (II) anchors
bundled with their linked on-chain assets** — launched ~April 2023, part of the **GeekFactory** family
(Usergeek, NFTgeek, Canistergeek, Configeek, VPgeek, idgeek).

- The unit of sale is the **II anchor itself** (the login credential) **plus the assets it controls** —
  most notably **NNS and SNS neurons** (governance/voting power, staked ICP/tokens) and desirable/low
  anchor numbers. GeekFactory materials describe **SNS Neuron Trading**: move an II + SNS neurons to
  idgeek, **unlink the SNS neurons into separate assets, and sell each separately.**
- **Safe handover:** via a **per-sale "sale contract" (a standalone immutable contract acting as
  escrow/custody)**. During the escrow/protection window the **seller cannot vote with that II on NNS/SNS
  proposals** (anti-rug). Settlement/transfer is executed by the contract, not a manual passkey handover.
- **Trust caveats (explicit on the forum / from DFINITY):**
  - **Not trustless** — "they control the contract"; "it could stop working at any time."
  - **SNS neuron transferability can be disabled at any time by the relevant SNS DAO**, which can strand
    SNS-neuron-based sales (DFINITY's stated concern).
  - Mixed user reports ("been great" vs "would not trust").
  - **For our repost feature:** treat idgeek listings as **third-party, operator-controlled data**;
    surface a disclaimer; never imply the bundled neurons are guaranteed transferable.

Sources: forum [Introducing IDgeek](https://forum.dfinity.org/t/introducing-idgeek-identity-anchor-marketplace/19628) ·
[How reliable is idgeek](https://forum.dfinity.org/t/how-reliable-is-idgeek-for-sales/25461) ·
[Identity sales and offers on idgeek](https://forum.dfinity.org/t/identity-sales-and-offers-on-idgeek/33172) ·
[theIDGEEK / GeekFactory (SNS neuron trading)](https://x.com/theIDGEEK)

## 2. Canister / API surface

- **Frontend (asset) canister:** `xdtth-dyaaa-aaaah-qc73q-cai` (serves `idgeek.app`, 302 → `…raw.icp0.io`).
  Module hash `04e565b3425fe7510ee16b02adcfe3f01abc9a2725c82a21cb08969241debd62`.
- **Controllers of the frontend canister** (IC dashboard / ic-api):
  - `e3mmv-5qaaa-aaaah-aadma-cai` (self-controlled; module hash `210cf941…`)
  - `cocmv-eiaaa-aaaah-qdbxq-cai` (controlled by `6j3en-5qaaa-aaaah-qc6ka-cai`; module hash `e8a5a176…`)
  - `lpag6-ktxsv-…-wae` (a principal — likely a dev identity)
- **Leading (UNCONFIRMED) backend candidate: `cocmv-eiaaa-aaaah-qdbxq-cai`** — a non-frontend canister in
  the controller set, itself controlled by `6j3en-5qaaa-aaaah-qc6ka-cai` (an admin/factory controller).
  **FLAG:** not definitively confirmed — the SPA JS (which contains the real `createActor`/`idlFactory`/
  canister id) was not readable via WebFetch.
- **Candid interface / public query methods: NOT DETERMINED.** No method names verified (candidates to
  look for: `getListings`, `listIdentities`, `getActiveSales`, `getUpcoming`). **Whether any read method
  is a public *query* (vs `update`/auth-gated) is unknown — this is the single most important unknown for
  on-chain ingestion.**
- **Listing data model: NOT DETERMINED** from the on-chain interface. UI uses `…/identity/<anchorNumber>`
  (e.g. `/identity/16100`), so the **anchor number is the listing key**. Inferred (unverified) fields:
  anchor/identity number, price, currency, status (active/upcoming/sold), seller, protection/expiry
  window, linked neurons/devices.

Sources: [dashboard canister page](https://dashboard.internetcomputer.org/canister/xdtth-dyaaa-aaaah-qc73q-cai) ·
[ic-api cocmv](https://ic-api.internetcomputer.org/api/v3/canisters/cocmv-eiaaa-aaaah-qdbxq-cai)

## 3. Active vs upcoming listings

- Lifecycle is driven by a **time-based "protection period."** A listed ID **"starts with 30 days of
  protection,"** **offers are made during the protection period,** and when it expires it becomes **"a
  direct purchase, or however many days are remaining"** — protection does **not reset** when an offer is
  accepted near the end.
- Strongly implies status is **timestamp-driven** (a start/go-live time + a protection-end time), with an
  offer/bidding phase during the window and direct-purchase after.
- **FLAG:** unconfirmed whether idgeek uses a literal "upcoming" status with a scheduled future go-live,
  or whether "upcoming" = still in protection/offer window vs "active" = directly purchasable. The status
  enum and the driving field(s) (`startTime`/`goLiveAt` vs `protectionEndsAt`) are **not verified.**
  **→ Design for a time-window model (store start + end + raw source status; derive our display status).**

Sources: [Identity sales and offers on idgeek](https://forum.dfinity.org/t/identity-sales-and-offers-on-idgeek/33172)

## 4. How to ingest for repost (ranked)

- **(a) Inter-canister query to idgeek's backend — most reliable IF a public query exists.** On-chain,
  fast, no scraping. **Blocked on §2:** backend id + public query method unconfirmed. Viable only after
  confirming the canister exposes a public (non-auth-gated) query returning listings.
- **(b) HTTPS outcall to a JSON endpoint — NOT available.** idgeek serves an SPA shell, no `/api`/JSON.
  (Also: this repo has no HTTPS-outcall infra today.) Not usable.
- **(c) HTML scraping — NOT usable.** Pages are client-rendered; server HTML has no listing data.
- **Recommendation:** use **(a)** if idgeek exposes a public query; otherwise fall back to an **off-chain
  indexer** (a worker running agent-js that fetches listings and writes them into our canister). A pure
  on-chain HTTPS-outcall ingestion cannot work against an SPA.
- **Certification:** listing data is on-chain in idgeek's canister, so a query returns canister state, but
  it is **operator-controlled mutable state, not independently certified market data.** Store a fetch
  timestamp + source canister id; label "sourced from idgeek"; re-fetch before display.
- **Rate limits:** none documented; poll on a sane interval (minutes), not per-view.

## 5. Pricing / fees / escrow

- **Settlement:** executed by the per-sale smart contract; funds + identity held until conditions met;
  seller's II voting disabled during escrow.
- **Offers vs fixed price:** supports **direct/fixed-price purchase** and **offers/bids**; offers **below
  the asking price require seller approval** (accept/decline). A reposted listing may carry both an ask
  price and pending offers.
- **Currency:** **ICP** (assume ICP; **FLAG:** ckBTC/other unconfirmed).
- **Fees:** **NOT DETERMINED.** A platform/commission fee almost certainly exists but no %/split was
  documented. **FLAG** — if we show prices, decide whether to show idgeek's gross price and note idgeek
  fees aren't reflected.

## Open items to resolve before building (all FLAGGED)

1. **Backend canister id** — `cocmv-eiaaa-aaaah-qdbxq-cai` leading but unconfirmed; capture from SPA
   network calls.
2. **Public read method name(s) + return type, and query-vs-update** — none verified; required for
   on-chain ingestion option (a).
3. **Listing data model field names/types** — inferred, not verified.
4. **Exact active-vs-upcoming mechanism** — appears time-window-based; status field/enum unverified.
5. **Fee structure** — undocumented.
6. **Multi-currency (ckBTC?)** — unconfirmed; assume ICP.

> **Bottom line:** idgeek sells II anchors bundled with neurons/assets via per-sale escrow contracts; it
> is operator-controlled (not trustless). Listings are time-windowed (30-day protection → direct
> purchase). The only viable on-chain repost ingestion is an inter-canister query to idgeek's backend —
> but the backend id, the public query method, and the schema **must first be captured from the SPA's
> live network calls.** Plan for an off-chain indexer fallback.
