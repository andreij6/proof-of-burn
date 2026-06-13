# 02 — Wagering: the shared casino VP ledger, the house, the burn

## One ledger for the whole casino (C2; amends poker PB-200)

`POKER_VP_DELTA` is renamed **`CASINO_VP_DELTA`** (same MemoryId 57, same
semantics): a signed per-principal modifier with
`effective_weight_e8s = max(0, staking_weight + delta)` and chips =
effective VP × 1,000. Poker and Crash draw from the same bankroll — a
player's chips are fungible across the casino, their staked ICP is never
touched, and the **stop-loss floor (poker D23) is casino-wide**: a crash
bet is rejected if losing it could take effective VP below the floor
(`STOP_LOSS_FLOOR`), and an auto-pilot stop fires on the same boundary.

Sanctioned writers grow from four to **six**:
1. poker hand settlement
2. tournament buy-in
3. tournament payout
4. admin void (poker hand / crash round)
5. **crash round settlement** (per-bet deltas + the house's absorbing delta)
6. **the weekly house burn**

## The house account (C3)

Crash is house-banked — players bet against the curve, not each other. A
reserved principal-keyed entry (the canister's own principal) inside
`CASINO_VP_DELTA` is **the house**:

- Round settlement: each winning bet `+wager×(target−1)`, each losing bet
  `−wager`; the house entry receives the exact negation of the round's net,
  so **Σ(all users) + house = 0 at every instant** (invariant I-1c).
- The house entry is allowed to be negative (players collectively up) —
  variance bounded by the exposure cap (doc 01). With the 1% edge,
  E[house per round] = +1% of round wagers; the cap analysis in PB-233
  sizes worst-case drawdown vs. recovery time (at 5,000 VP cap and ~1%
  edge, a max-loss round recovers in ≈ 100 average rounds — acceptable;
  the cap is admin-tunable downward at any time).
- The house never plays poker, never votes, never appears on leaderboards;
  `effective_weight_e8s` explicitly excludes the house principal.

## The weekly burn (C3) — crash as a VP furnace

Every week (sweep, same Thursday boundary as seasons), if the house entry
is **positive**, it is set to 0 and the amount is recorded as **burned VP**
(audit event `crash_house_burn`, lifetime counter exposed via
`get_casino_stats`). Negative house carries over (no minting to cover it).

Why burning beats keeping: the platform must not accumulate voting power
from games (governance neutrality), and destroyed VP can only re-enter the
system through **staking more ICP** — so the house edge directly feeds the
bust→restake flywheel (poker doc 08). The UI wears it proudly:
*"The house edge is burned. Nobody keeps your chips — they leave the game
forever."*

## Per-bet accounting

```
crash_bet(wager, target):
  guards: flag, betting phase, one bet/round, rails (C8),
          chips(user) ≥ wager, stop-loss floor check
  reserve: bet recorded against the round (no delta written yet)

settle (at crash):
  winners (auto or manual): delta += wager·(multiplier−1)   // net of stake
  losers:                    delta −= wager
  house: −Σ(round deltas)
  all writes in one atomic settle pass; round archived with per-bet results
```

- No mid-round VP movement: a player's chips are *reserved* during a round
  (a second bet or a poker sit-down can't double-spend them — reservation
  checked by both games via a shared `reserved_chips(user)` helper).
- Busted (effective VP < min bet) ⇒ same restake nudge as poker (R6), same
  no-loss copy (C16).

## Invariants (extend poker I-1…I-5)

- **I-1c:** Σ `CASINO_VP_DELTA` over users + house = 0 between burns; each
  burn decreases the total by exactly the burned amount (tracked lifetime).
- **I-2/I-4 unchanged** (no negative effective VP; reservations ≤ chips).
- **I-6:** house never positive after a burn tick; burn events monotone.
- **I-7:** Σ(per-round bet results) + house round delta = 0 for EVERY round
  (checked per settle in test builds).
- **I-8 (jubilee, poker D27/C18):** at each user's 6-month tenure tick any
  negative delta resets to 0 (writer #7); forgiven amounts accumulate in
  `jubilee_minted`.
- `get_poker_reconciliation` generalizes to `get_casino_reconciliation`:
  **Σ users + house + lifetime burned − jubilee_minted = 0 forever.**
