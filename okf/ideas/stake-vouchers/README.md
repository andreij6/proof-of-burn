---
type: idea
title: "Stake Vouchers — NFT exit liquidity + marketplace + house buyback"
description: "Option 2 from the exit-liquidity debate (owner, 2026-07-10): staked positions become transferable ICRC-7 voucher NFTs; ICP-only marketplace (owner revision 2026-07-10 — was multi-token); house buyback at 15% discount from a dedicated, balance-gated buyback fund; fees split 1/3 treasury / 1/3 buyback fund / 1/3 voucher-canister cycles burn."
tags: [ideas, stake-vouchers, marketplace, exit-liquidity]
timestamp: 2026-07-10T00:00:00Z
---

# Stake Vouchers

**Owner decisions locked (2026-07-10):** voucher = NFT (not fungible token);
marketplace accepts **ICP only** (owner revision same day — ckBTC/ckUSDC/
ckETH dropped); house buyback at a **15% discount** (seller receives 85% of
principal instantly); buybacks pay from a **dedicated buyback wallet** and
the option is **disabled whenever the wallet can't cover a buyback**;
**fees split 1/3 treasury · 1/3 buyback fund · 1/3 voucher-canister cycles
burn**.

## 1. The product

A staker can wrap any stake position into a **voucher**: an ICRC-7 NFT on a
new `voucher_nft` canister representing `{tier, amount_e8s, minted_at}` — a
transferable claim on staked ICP inside our pooled neurons. The backend stays
sole custodian of the neurons; the voucher only moves the CLAIM.

Three exits, from best to worst for the user:
1. **Sell on the marketplace** — market sets the discount; buyer provides the
   liquidity; we take a fee.
2. **House buyback** — instant 85% of principal in ICP, always-on floor
   (when funded).
3. **Classic unstake** — 100% after the tier's dissolve (unchanged, never
   gated — the voucher wrap is optional; plain stakes keep working exactly
   as today).

## 2. Custody & ticket mechanics (what keeps the lottery honest)

- STAKES stays the source of truth. Wrapping debits the owner's (tier,user)
  row into a **voucher registry** row `{voucher_id → tier, amount_e8s,
  owner}` mirrored by the NFT. Transfer/sale/buyback moves the registry row's
  owner and re-credits STAKES rows accordingly (unwrap on transfer-in keeps
  daily grants flowing through the existing `user_daily_tickets` path).
- **Tickets follow the owner, once per day** — the existing server-side daily
  grant + stakers-only + admin-excluded rules apply untouched. A seller whose
  last stake leaves voids tickets instantly (existing rule); a buyer starts
  earning at the next daily grant. No snapshot gaming: transferring twice a
  day cannot double-earn because grants are keyed `last_claim_day`.
- **House-held positions earn NOTHING**: registry rows owned by the buyback
  fund are excluded from the daily grant (same spirit as admin exclusion).
- **EA/Booster stakes are NOT voucherable** (permanent, admin-only).
- NFT canister is minter-restricted to the backend (course_nft precedent);
  metadata is the claim tuple + provenance. Transfers happen ONLY through
  backend endpoints (approve/registry dance) so the registry and NFT can
  never disagree about the owner.

## 3. House buyback (the 15% floor)

- New **BUYBACK_SUBACCOUNT** `[10u8;32]` (verified free) — the "house
  wallet". Admin endpoints: fund, withdraw, view. The owner seeds it.
- `buyback_voucher(voucher_id)`: pays the CURRENT owner `85% of amount_e8s`
  in ICP from the buyback subaccount, transfers the claim to the house, then
  starts the classic unstake (split + dissolve) with the payout targeted BACK
  to the buyback subaccount.
- **Balance gate**: the endpoint refuses (and the UI hides/disables the
  button) whenever `buyback_balance < 85% + fees` for that voucher. Info
  endpoint exposes live capacity so the frontend can show "buyback available
  up to N ICP".
- **The spread is realized at dissolve**: when the 100% principal lands back,
  85% replenishes the fund (principal) and the **15% spread is treated as
  fee revenue → split 1/3 treasury / 1/3 stays in the buyback fund / 1/3
  cycles burn** (recommended reading of the owner's fee rule; alternative —
  spread stays whole in the fund — noted as an owner dial).
- Capital note: the fund's capital is locked per buyback for the tier's
  dissolve length. Effective APR on deployed capital ≈ 17.6% over the
  dissolve term (100/85) — ~35% annualized on 6-month vouchers, ~8.8% on
  2-year. Phase-4 option (house re-LISTS bought vouchers instead of
  dissolving) recycles capital instantly and is strictly better when the
  market bid > 85%.

## 4. Marketplace

- Reuses the course-marketplace saga (escrow subaccount per sale, journaled
  legs, reclaim_escrow on abandonment) — the app's proven money path.
- **Listing**: voucher owner sets an ask in **ICP** (USD hinting in the UI
  via the existing XRC cache).
- **Purchase**: buyer funds the sale escrow subaccount in ICP →
  `buy_voucher(id)` settles: seller paid (ask − fee), claim + NFT move to
  buyer, fee routed per §5. Buyer needs no prior stake; owning the claim IS
  a stake (tickets begin next day — stakers-only holds because they are now
  staked).
- **Marketplace fee: 2.5% of sale price** (owner dial, pending confirmation;
  precedent: course sales keep 25% total across royalty+platform, but
  vouchers are money-like so a low single-digit fee wins volume).
- Listings are cancelable anytime; escrow always reclaimable; no admin
  transfer of vouchers (custody house rules).

## 5. Fee routing — 1/3 · 1/3 · 1/3

Every fee (marketplace fee + realized buyback spread) is ICP, split:
- **1/3 → treasury** `[1;32]`.
- **1/3 → buyback fund** `[10;32]` (self-reinforcing exit liquidity).
- **1/3 → voucher-canister cycles burn** — the exact
  `settle_burn_split_with_target` precedent from course_nft: ICP → CMC →
  cycles for the voucher_nft canister (its operating budget is literally
  burned ICP).
ICP-only removes the whole ck→ICP fee-conversion problem (no swap queue, no
fee subaccount, no ICPSwap dependency in the money path).

## 6. New surface (implementer's map)

- **Canisters**: `voucher_nft` (new ICRC-7, cloned from course_nft; backend
  is minter + controller; cycle-guard like course_nft's).
- **Backend**: voucher registry + next-id + listings + sale escrow journal +
  buyback journal + fund stats — **MemoryIds 128–134** (next free; 127 is
  the pot cache). Subaccounts: buyback `[10;32]`; per-sale escrow via the
  domain-separated escrow-seed pattern. (No fee-conversion queue — ICP-only.)
- **Endpoints** (flag `stake_vouchers`, dark): wrap_stake_voucher /
  unwrap_stake_voucher / list_voucher / cancel_listing / buy_voucher /
  buyback_voucher / get_voucher_market (incl. buyback capacity + my
  vouchers) / admin_fund_buyback / admin_withdraw_buyback /
  admin_set_voucher_fees.
- **Frontend**: "Vouchers" page in Stake 4 Tickets (wrap CTA on Neuron
  Stake positions; market grid; buy flow per token; prominent-but-honest
  buyback card: "Instant exit: 85% now vs 100% after dissolve"); lottery-
  page copy untouched (no-loss brand: classic unstake remains the headline
  exit; voucher exits are opt-in extras with the discount stated plainly).
- **Developer docs (required per phase)**: `#/dev-docs` and `/llms.txt` are
  the public integration contract and MUST ship in the same commit as each
  phase's endpoints — a partner integrating from stale docs is a support
  incident. Phase 1 adds a "Voucher buyback" section (wrap_stake_voucher +
  buyback_voucher + capacity read, with the 85%/15% math stated plainly);
  phase 2 adds list/buy/cancel + the escrow-funding flow (ICP only). Each
  addition extends BOTH the page's candid/idlFactory
  snippets AND the llms.txt single-source (they import the same file — keep
  it that way). The caller-keyed identity rule applies to every voucher call
  and must be restated in the voucher section.
- **Tests**: registry conservation (sum of voucher amounts + plain stakes ==
  neuron principal per tier), ticket-follow-the-owner across sale/buyback
  (incl. house earns nothing, seller voids on last-stake exit), balance-gate
  refusal, fee three-way split exactness, escrow reclaim, buyback journal
  resume after mid-flight failure.

## 7. Promo ("claim") vouchers — acquisition variant (owner, 2026-07-10)

A second voucher CLASS for capped claim campaigns ("first N sign-ins claim
a starter voucher"). Owner spec: **promo vouchers earn tickets ONLY — they
can NEVER redeem ICP from a neuron and are NEVER buyback-eligible.** Both
money paths hard-reject the promo class at the endpoint level (not just UI).

Design consequences & recommendations:
- **No backing required.** Since a promo voucher carries no principal claim,
  no real ICP needs staking behind it — a campaign of any size costs zero
  principal. It is a pure ticket stream ("golden ticket"), diluting odds but
  never touching the pot. The stakers-only eligibility rule gets an explicit
  promo carve-out: holding a promo voucher counts as lottery-eligible.
- **Expiry (owner-locked): 60 days after the individual claim** — each
  voucher's clock starts at ITS claim, then it goes inert. An onboarding
  trial that funnels holders toward real staking, not a perpetual annuity.
- **Rate (owner-locked): 1 ticket per day flat** per promo voucher (not
  tier-scaled — trivially small next to real stakes at 5-20/ICP/day, so
  even a fully farmed campaign dilutes odds by at most 5,000 tickets/day
  for 60 days).
- **Soulbound** (recommended): non-transferable and non-listable — kills
  sybil resale loops and keeps the marketplace purely for real, backed
  vouchers. (Marketplace listings reject the promo class.)
- **Claim gating**: one per principal per campaign, campaign-level cap
  (budget = tickets, not ICP), flag-gated per campaign, admin endpoints to
  open/close campaigns. Sybil pressure is real but bounded: a farmed promo
  voucher yields only diluted lottery odds, never principal.
- Registry marks class {Backed, Promo}; daily grant treats both the same;
  buyback_voucher / unstake paths and the marketplace reject Promo.

### The claim screen (owner spec, 2026-07-10)

- **Standalone page with its own path** (`#/claim`), landing-style full-bleed
  — it IS the campaign link you share on X/OpenChat; reachable signed-out,
  not tied to the app nav.
- **Two claim methods**:
  1. **Sign in** (II) → voucher mints to the session principal.
  2. **Paste an ICP wallet principal** (Plug/OISY/NNS users) → voucher mints
     to the pasted principal, NO sign-in required. Earning is server-side and
     jackpots pay automatically, so a pasted-principal holder participates
     fully without ever logging in. Validation: must parse as a principal,
     must be self-authenticating (reject anonymous, reject canister ids),
     one voucher per principal per campaign.
- **Cap: 5,000 promo vouchers** for the campaign (owner-locked). Counter
  shows "N remaining" ONLY — never "claimed so far" (hide-scale-signals
  rule: scarcity reads strong, small claim counts read empty).
- **Anti-drain recommendations** (the paste path is anonymously callable, so
  a scripted farmer could otherwise eat the cap in minutes): a **daily drip
  cap** (e.g. 500 claims/day — a bot can't take the whole 5,000 before an
  admin reacts) + admin pause/close kill-switch + the existing
  one-per-principal rule. Accepted residual risk: sock-puppet principals
  can still farm within the drip — bounded to odds dilution (never
  principal) by the tickets-only class.

## 8. Phases

1. **Wrap + house buyback** (no marketplace): smallest slice that produces
   income and proves demand. Ships with its dev-docs + llms.txt section
   (see §6).
2. **Marketplace** (course-market saga reuse, ICP asks).
3. **Promo claim campaigns** (§7) — the acquisition lever; can be pulled
   forward ahead of 2 if growth is the priority (it shares the registry +
   NFT canister with 1 but none of the money paths).
4. *(Optional)* house re-lists bought vouchers; auction-style asks.

## 9. Risks & mitigations

- **No-loss brand tension**: the 15% haircut must read as an optional
  express-exit FEE, never as principal risk — copy pattern per the IL
  disclaimer precedent; classic 100% unstake stays the default everywhere.
- **Registry/NFT divergence**: all transfers routed through the backend;
  invariant test + audit events on every ownership move.
- **Wash-trade ticket farming**: neutralized by day-keyed grants (analysis
  in §2).
- **Fund insolvency**: hard balance gate + capacity surfaced; buyback
  journal resumes half-paid flows (escrow-journal precedent).
- **Securities optics**: NFT receipt on a specific position (not a fungible
  yield token); no promised return on vouchers; buyback framed as a fee.

## 10. Owner dials still open

1. Marketplace fee % (2.5% proposed).
2. Buyback spread: counts as fee (1/3-split, recommended) vs stays whole in
   the fund.
3. Minimum voucherable amount (proposed 1 ICP — matches first-stake min).
4. House re-listing phase yes/no.
5. Soulbound confirmation (expiry and rate now owner-locked: 60 days from
   claim, 1 ticket/day).
