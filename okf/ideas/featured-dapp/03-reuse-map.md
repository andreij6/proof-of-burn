---
type: idea
title: "Featured Dapp — Codebase Reuse Map"
tags: [ideas, featured-dapp]
timestamp: 2026-06-16T10:12:10-04:00
---

# Featured Dapp — Codebase Reuse Map

> Exact identifiers + line numbers (approx., `src/backend/src/lib.rs` unless noted) for what to reuse.
> Condensed from the code-reuse fan-out; the per-id MemoryId ledger below is the **grep-confirmed**
> authoritative list (the agent's hand-annotated full ledger had guesses/dups — trust this section).

## 1. Course FeaturedSlot (PB-308) — the closest analog (study, don't reuse)

In the **course** marketplace (`CourseMarketplace.tsx`, `COURSE_LISTINGS`, `token_id`).

| Item | Line(s) | Note |
|---|---|---|
| `FeaturedSlot` struct | ~16151 | one slot: `token_id, bidder, token, amount, usd_value_e8s, at`. **No expiry.** |
| `FeaturedSlotCell` + `FEATURED_SLOT` | ~16160 / ~16167 | `StableCell` at **MemoryId 78**. |
| `FEATURED_BID_LOCK` | ~16171 | heap bool lock serializing concurrent bids. |
| `featured_slot_get/set` | ~16176 | persist/clear. |
| `token_amount_usd_e8s_live` | ~16187 | async XRC valuation. |
| `bid_featured_slot` | ~16204 | strict "to-beat" auction; collects 100% to treasury, non-refundable. |
| `get_featured_slot` | ~16274 | drops dangling slot if `token_id` gone. |
| pinned into page | ~14735 / grid-exclude ~14752 | `featured_token_id` pinned + filtered out of the grid. |

**Why not reuse:** single perpetual highest-bid slot — no fixed duration, no max-3, eviction breaks a
paid time window. We want 3 fixed-duration placements → clone the **dapp-listing** flow instead.

## 2. Dapp Explorer — the home of this feature (reuse heavily)

| Item | Line(s) | Reuse |
|---|---|---|
| `DappStatus` | ~9194 | Pending/Approved pattern → `FeaturedStatus`. |
| `DappListing` | ~9201 | the listing the placement references (`listing_id`). |
| `ExplorerQuote` | ~9234 | reuse the type verbatim for `FEATURED_QUOTES`. |
| `ExplorerInfo` | ~9247 | model for `FeaturedInfo`. |
| `DAPPS`/`NEXT_DAPP_ID`/`EXPLORER_QUOTES` | ~9271 / ~9275 / ~9279 | MemoryId 40/41/42 — pattern for 88/89/94. |
| `delete_expired_dapps` + timer | ~9863 / ~4625 | model for `expire_featured`. |
| `submit_dapp` | ~10174 | **clone for `apply_featured`** (validate → quote → escrow → treasury → insert Pending). |
| `admin_approve_dapp` | ~10281 | model for approve — but featured approve **adapts** it to claim-before-await (escrow→treasury sweep adds an await; flip Pending→Approving before it). See 02 §4 / 04 F2. |
| `admin_reject_dapp` | ~10305 | clone for reject (claim-before-await + restore + refund −fee). |
| `admin_add_dapp` | ~10340 | model for admin "house feature". |
| `list_dapps`/`list_my_dapp_submissions`/`list_pending_dapps` | ~10086 / ~10102 / ~10117 | query patterns. |
| `get_explorer_deposit_address` | ~10133 | escrow address for the apply flow. |

## 3. Quote / escrow / oracle (reuse)

| Item | Line(s) | Reuse |
|---|---|---|
| `EXPLORER_PRICE_PER_DAY_USD_E8S` | ~9168 | model for `FEATURED_PRICE_PER_DAY_USD_E8S`. |
| `EXPLORER_QUOTE_TTL_NANOS` / `DAY_NANOS` | ~9176 / ~9182 | 15-min quote TTL; days→ns for `expires_at`. |
| `explorer_usd_rate_e8s` | ~9525 | async XRC rate (ckUSDC/ckUSDT = 1:1, others via XRC, cached). |
| `explorer_quote_amount` | ~9402 | **refactor** to take `price_per_day_usd_e8s` → shared by both quotes. |
| `explorer_token_decimals` / `_ledger` / `_fee` | (nearby) | token math/ledger/fee. |
| `derive_explorer_subaccount` | ~9372 | per-caller escrow subaccount (reuse as-is). |
| `get_explorer_quote` | ~10145 | clone for `get_featured_quote`. |
| `TREASURY_SUBACCOUNT` + `call_ledger_transfer` | (nearby) | escrow→treasury move + refund. |

## 4. Randomness + timers

| Item | Line(s) | Note |
|---|---|---|
| `lottery_random_u64` | ~8406 | `raw_rand` is **update-only** → can't use in the hero query. **Use client-side `Math.random()` instead.** |
| `run_lottery_draw` | ~8485 | example of `raw_rand` → index selection (not needed if client-side). |
| `setup_timers` (300s) | ~4612 | add `expire_featured()` near `delete_expired_dapps()` (~4625). |

## 5. Admin / config (reuse)

| Item | Line(s) | Reuse |
|---|---|---|
| `Config` struct | ~403 | add `featured_price_per_day_usd_e8s: Option<u64>` (`#[serde(default)]`). |
| `require_admin` | ~809 | guard for admin endpoints. |
| `admin_set_faucet_grant_usd` / `admin_set_default_threshold_usd` | ~17053 / ~1242 | template for `admin_set_featured_price_usd` (fetch config → set field → persist → log). |

## 6. Frontend (reuse)

| Item | File / line | Reuse |
|---|---|---|
| Explorer page (hero goes here) | `Explorer.tsx` ~111 | component; `refreshAll` ~154; `dappCard` ~352; layout ~426. |
| Featured-card precedent | `CourseMarketplace.tsx` ~66/114/178/385 | `refreshFeatured`, derived featured card, pinned-above-grid + placeholder. |
| Shuffle / seed / paging helpers | `arcade/courseMarket.ts` ~45/59/72/106 | `shuffleSeeded`, `poolOrder`, `pageSlice`, `freshSeed` — reuse for client-side random pick + grid exclude. |
| UI primitives | `ui.tsx` | `Icon`, `Btn`, `Chip`, `Eyebrow`, `LiveDot`, `MoreInfo`, `MODAL_OVERLAY`/`MODAL_CARD`. |
| **Slider** | — | **None exists.** Build ~50-LOC custom (`useState(slide)` + 2 divs + `translateX`). |

## 7. MemoryIds (grep-confirmed)

**Used:** 0–25, 34–52, 60–72, 74–75, 77–87, 90–93, 96.
**Free:** **26–33, 53–59, 73, 76, 88–89, 94–95, 97+.**
**Allocate:** `FEATURED` = 88, `NEXT_FEATURED_ID` = 89, `FEATURED_QUOTES` = 94. (78 is the course slot.)
⚠️ Re-confirm at build — `nueron-sale` (reserved 97–100 on paper) and `id-listings` (53–59) are unbuilt
specs that also reserve ids; first to build wins.

## 8. Reuse vs build-new summary

| Area | Verdict |
|---|---|
| Listing lifecycle (apply/approve/reject/expire/escrow/refund) | **Reuse** the dapp-listing flow |
| Quote + oracle + pricing | **Reuse** (refactor `explorer_quote_amount` to take the price) |
| Admin config setter | **Reuse** `admin_set_*` pattern |
| Timer expiry sweep | **Reuse** `delete_expired_dapps` pattern |
| Frontend grid/card/shuffle | **Reuse** Explorer + `courseMarket.ts` |
| `FeaturedDapp` data model + max-3 + `get_featured_dapps` | **Build-new** |
| 2-card slider | **Build-new** (~50 LOC) |
| PB-308 auction | **Do not reuse** |
