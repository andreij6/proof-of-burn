# 01 — Economics: voting power as the chip currency

## The one number poker moves

A single new per-user signed ledger:

```rust
// MemoryId 57: Principal -> i64 (e8s of voting weight, may be negative)
static POKER_VP_DELTA: StableBTreeMap<Principal, i64, Memory>;
```

**Effective VP** for user `u`:

```
effective_weight_e8s(u) = max(0, staking_total_weight_e8s(u) + poker_vp_delta(u))
```

- `staking_total_weight_e8s` is the lossless-staking weight
  (stake ÷ 10 × term multiplier: 1×/2×/4×) **plus the Early Adopters weight
  (D25, PB-220): `ea_staked_e8s ÷ 10 × 6`** — the permanent lock earns the
  top multiplier. EA stake mints VP but NOT lottery tickets.
- `poker_vp_delta` starts at 0 and is adjusted **only** by: cash-hand
  settlement, tournament buy-in, tournament payout, and admin void-hand
  compensation. Nothing else may write it.
- The delta may go negative up to `-staking_weight` at the moment of loss
  (you can only lose chips you had on the table, and chips are capped by
  effective VP — so effective VP can reach 0 but never below).

## Chips

```
CHIPS_PER_VP = 1_000          // 1 VP (1e8 weight_e8s) = 1,000 chips
chips(u)     = effective_weight_e8s(u) * CHIPS_PER_VP / 100_000_000
             = effective_weight_e8s(u) / 100_000     // exact integer division
```

- Chip granularity = 0.001 VP = 100,000 `weight_e8s`. The sub-chip remainder
  (< 0.001 VP) is **not** playable and is never destroyed — effective VP keeps
  full e8s precision; only the table floor-divides.
- Blinds 25/50 chips ⇒ a 1-VP bankroll is 20 BB; the 0.5 VP minimum sit-down
  (500 chips) is 10 BB.

## Session accounting (cash games)

1. **Sit-down snapshot.** When the agent is seated, the canister computes
   `stack = chips(u)` and records `seat.buyin_e8s = stack * 100_000`. While
   seated, the user's *playable* VP is locked to the snapshot: staking more
   mid-session does NOT grow the live stack (it grows effective VP, which the
   next sit-down will pick up); unstaking mid-session is allowed and does not
   shrink the stack (the table plays the snapshot — see reconciliation).
2. **Per-hand settlement.** At the end of every hand, for each seat:
   `delta_chips = stack_after − stack_before_hand`;
   `POKER_VP_DELTA[u] += delta_chips * 100_000`. Permanent immediately —
   there is no "cash out" step, no reversal. Hands are zero-sum in chips, so
   the sum of deltas over any hand is exactly 0 (invariant I-1).
3. **Stand-up.** Clears the seat; nothing to settle (settlement is per-hand).
4. **Busted.** Stack hits 0 ⇒ automatic stand-up. Effective VP is now ≤
   0.001 VP. The user cannot re-seat until effective VP ≥ 0.5 (stake more
   ICP). Their staked ICP and unstaking rights are completely unaffected —
   this is the "no-loss" guarantee, stated verbatim in the UI.

### Mid-session unstake reconciliation

Unstaking can push `staking_weight + poker_vp_delta` below the snapshot the
table is playing. Allowed (we never lock a user's ICP), with one rule: the
per-hand settlement still applies in full, so effective VP after the session
may be clamped at 0 by the `max`. The clamp only forgives losses that exceed
remaining stake-weight — equivalent to "you can't owe VP". To prevent
farming (sit with big stack → unstake → keep playing risk-free):

- On every hand start, the table re-checks `effective_weight_e8s(u)`. If it
  is now lower than the seat's current stack value, the stack is **clamped
  down** to the new effective VP before cards are dealt (excess chips simply
  vanish from the table — they were never real). If that takes the seat
  below 500 chips ⇒ stand up.

## Stop-loss (D23)

Per-agent `stop_loss_e8s: u64` (0 = off). Default at claim = 25% of the
owner's staking weight at that moment (stored as an absolute number; the UI
re-suggests 25% at each sit-down but never silently changes it). Enforced in
exactly two places:

1. **After every settled hand:** `effective_weight_e8s ≤ stop_loss` ⇒
   automatic stand-up, agent state `StopLossHit`; cannot re-seat (or register
   for a tournament whose buy-in would breach the floor) until the owner
   lowers the floor or effective VP rises above it.
2. **At sit-down / registration:** rejected with `STOP_LOSS_FLOOR` if the
   500-chip minimum (or the buy-in) could not be lost without breaching the
   floor — prevents pointless one-hand sessions.

The floor is owner-editable any time between hands; mid-hand changes apply
from the next hand. Stop-loss can NOT save a stack mid-hand (an all-in that
loses still settles in full — the floor triggers the exit, it does not
rewrite results). Flywheel rationale: doc 08.

## Tenure doubling + the jubilee (D27 — base VP is alive)

The app now ships **VP tenure**: each tier-stake's weight doubles every 6
months staked (×2/×4/×8, capped ×16 at 2 years; top-ups move `staked_at` to
the amount-weighted average). Two casino consequences:

1. **The base grows under the delta.** `staking_total_weight_e8s` is
   time-dependent; effective VP rises at every doubling without any casino
   event. Bankrolls re-snapshot at sit-down as usual.
2. **The jubilee (writer #7):** at each user's 6-month tenure tick, a
   negative `CASINO_VP_DELTA` is **reset to 0** — losses are forgiven, the
   player stands restored at their full (doubled) base. Implementation:
   store `last_jubilee_period` per user; lazily compare against
   `min(tenure periods across their tier stakes)` at every settle and
   effective-VP read; apply at most once per period. Positive deltas are
   NEVER touched — winners keep winnings.

Accounting honesty: forgiveness mints VP (the winners' gains are no longer
offset). Tracked in a lifetime `jubilee_minted` counter; invariant I-1
generalizes to **Σ users + house + burned − jubilee_minted = 0**. The mint
is bounded: per user per 6 months, at most their accumulated losses — and
strategically it's the strongest retention promise in the casino: *"stay
staked and you can never be down for more than six months."*

## What poker does NOT touch

| System | Effect |
|---|---|
| Staked ICP / unstake / restake | none — principal always returns in full |
| Lottery tickets & eligibility | none — tickets derive from *staked amounts*, not VP |
| Arcade access | none — stake- or vote-based |
| Burn commitments | none — wallet-funded |
| Early Adopters | none |
| **Lossless vote weight** | **switches to effective VP** (D3). `cast_lossless_vote` and every read of `total_weight_e8s` for balance-of-power purposes go through `effective_weight_e8s`. |

Implementation note: introduce one function `effective_weight_e8s(user)` in
lib.rs and migrate the (few) voting-weight call sites to it; `get_my_stake`
gains an `effective_weight_e8s` field so the UI can show "VP after poker".

## Invariants (enforced by tests, PB-200/PB-217)

- **I-1 Zero-sum:** Σ per-hand deltas = 0 for every hand; Σ `POKER_VP_DELTA`
  over all users + Σ(tournament prize pool in flight) = 0 at all times.
- **I-2 No negative effective VP:** `effective_weight_e8s ≥ 0` always.
- **I-3 No ICP movement:** poker code paths perform **zero** ledger calls
  (the script fee/marketplace are separate, non-poker flows).
- **I-4 Stack ≤ effective VP** at every hand start (clamp rule).
- **I-5 Only the four sanctioned writers** mutate `POKER_VP_DELTA` (hand
  settle, tourney buy-in, tourney payout, admin void) — checked by grep-level
  review + a debug assertion counter in tests.

## Edge cases decided

- **Two users, same staking pool**: irrelevant — VP is per-user.
- **Admin players**: admins may claim agents and play (poker moves VP, not
  treasury money; unlike the lottery there is no house edge to abuse). Their
  effective VP affects their votes like anyone's.
- **Rounding**: all arithmetic in `u64/i64` e8s and integer chips; no floats
  anywhere in settlement paths.
- **Display**: UI shows chips at the table and "≈ X.XXX VP" everywhere else.
