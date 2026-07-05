---
type: note
title: "ICPSwap LP — implementation sketch (Model B custody staking + Model A verify)"
tags: [ideas, icpswap-lp-stake, impl]
timestamp: 2026-07-05T00:00:00Z
---

# Implementation sketch (NOT built)

## Model B — LP staking (headline)

Flag `icpswap_lp_stake`. New section; endpoints:
- `stake_lp_position(pool: principal, position_id: nat)` update:
  1. Caller must have (out-of-band, via ICPSwap UI or a helper deep link)
     called `transferPosition(their_icpswap_principal → our backend,
     position_id)` FIRST; our endpoint then verifies
     `getUserPosition(position_id)` shows OUR canister as owner and the
     pool is the configured ICP/ckUSDC pool, then records
     {user, pool, position_id, staked_at, liquidity_at_stake}.
     (Ordering alternative: approval + our canister pulls the transfer —
     confirm pull-transfer support in the v3 candid at build time.)
  2. Position registry: MemoryId 122 (position_id → StakedLp record),
     123 (user → position ids).
- `unstake_lp_position(position_id)` update: only the recorded staker;
  transfers the position back to a TARGET PRINCIPAL THE USER NAMES (their
  ICPSwap principal — repeated back in the UI with a confirm step);
  removes registry entry; audit-logged. NOT flag-gated (custody exit must
  always work), NOT pausable.
- Sweep leg `harvest_icpswap_lp()`: per staked position, claim fees →
  withdraw ICP + ckUSDC to backend subaccounts → swap ckUSDC→ICP on the
  same pool (slippage-bounded, skip if tiny) → route ICP: X% lottery pot
  transfer (existing pot subaccount), Y% burn via existing CMC
  notify_top_up machinery (settle_burn_split-style journaling), Z%
  treasury (owner to set X/Y/Z; suggest 50/40/10). Journal per-leg like
  the escrow sagas; idempotent resume.
- Tickets: per lottery round, every staker with a live staked position
  gets 10 tickets ("icpswap_lp" source) — auto-granted by the sweep at
  round start OR claim-button parity with ANSEM (recommend the button:
  no timer surprises, same UX language).
- Views: get_lp_stake_info (my positions, pool stats, harvest totals,
  next-round status).

## Model A — verify-only companion

`verify_icpswap_position(icpswap_principal, position_id?)`: reads
`getUserPositionIdsByPrincipal`; ownership proof = position approval for
our canister (verify approval method in v3 candid) or global-principal
wallet login. Same 10-tickets/round claim keyed by lottery round. Storage:
124 (verified links), 125 (claims).

## Reuse map

- Ticket sources + round-keyed claims: identical to ANSEM LP ("icpswap_lp").
- CMC burn leg + journaled multi-leg settlement: settle_burn_split pattern.
- Lottery pot funding: the pot subaccount + existing balance reads.
- Sweep: add harvest leg like course_nft_cycle_guard / luckproof award.
- Audit: staking_audit events for stake/unstake/harvest/route legs.

## Testing

Mock the SwapPool canister behind a seam (native mocks like the
ledger/CMC mocks): position ownership before/after transfer, stake
verify, unstake returns to named principal, harvest routing splits +
journal resume after a failed leg, round-keyed tickets, out-of-range
position (zero fees) still earns tickets.

## Open questions for the owner

1. Split X/Y/Z of harvested yield (pot/burn/treasury)?
2. Tickets flat 10/round or scaled by liquidity?
3. Admin recovery endpoint for stuck positions: yes (operational safety)
   or no (rug-proof purity)? Recommend: NO admin transfer; only a
   user-callable unstake, plus a time-locked escape hatch discussed openly.
4. Phase 2 ICS farms: worth the two extra canister integrations?

## Estimate

Model B: backend ~700 lines + mocks + tests ~400, frontend page ~300.
Model A companion: +200. Phase-2 farms: +400.
