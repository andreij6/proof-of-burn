# Epic J — Crash (bustabit-style multiplier game) + the Casino section

**Status: IMPLEMENTED (feat/crash-casino) — ships dark behind the `crash` flag
(default OFF); enable + `admin_init_crash` to go live. Poker does not exist, so
the shared ledger was built fresh as `CASINO_VP_DELTA` and the marketplace as a
standalone Poker|Crash-kinded store (no poker primitives to extend).**

A rocket-curve crash game in the bustabit aesthetic: one global round every
~20 seconds, a multiplier that climbs from 1.00× until it **crashes** at a
provably-fair point, and everyone who cashed out before the crash keeps
their wager × multiplier. Wagers are **voting power** — the same effective-VP
chips as poker (1 VP = 1,000 chips) on the same ledger. **Staked ICP is
never touched: you can never lose principal, ever** — that sentence is the
header of every Casino page (C16).

Unlike poker, **humans play directly** (bet, watch the curve, smash "Cash
Out"); agents are *also* welcome through the same canister API, and an
**auto-pilot** runs an on-chain strategy script for anyone (the bustabit
"script bank" experience). A live **chat box** sits beside the graph. A
**strategy builder** ($5, same quote flow) and the **shared marketplace**
(poker scripts and crash strategies side by side) complete the loop.

**Casino subsection:** once Crash ships, the Play nav group gets a single
**Casino** entry → a hub page with the Poker room and the Crash game as
tabs, both wrapped in the no-loss-of-principal banner. (Amends the poker
plan's nav: `/poker` becomes a tab under `/casino`; old path redirects.)

## Documents

| Doc | Contents |
|---|---|
| [01_round_engine.md](01_round_engine.md) | Round lifecycle, provably-fair crash point, multiplier clock, latency honesty, exposure caps |
| [02_wagering_vp.md](02_wagering_vp.md) | Shared casino VP ledger, the house account, the weekly VP burn, invariants |
| [03_ui_chat.md](03_ui_chat.md) | Bustabit-style graph UI, bet panel, players list, chat box, Casino hub, copy rules |
| [04_strategies_marketplace.md](04_strategies_marketplace.md) | Crash strategy DSL (martingale-class), $5 builder, auto-pilot, shared marketplace |
| [05_security_testing.md](05_security_testing.md) | Threat model + the mechanics-first test plan (distribution proofs, payout oracle, soak gates) |

## Locked decisions (C1–C16; defaults chosen, no open questions)

| # | Decision |
|---|---|
| C1 | **One global game** (no rooms): a continuous round loop — 10 s betting window → multiplier run → crash → 5 s intermission. Everyone in the world is in the same round, like bustabit. |
| C2 | **Wagers = casino chips** (1 chip = 0.001 VP), drawn from the SAME effective-VP ledger as poker. PB-230 renames `POKER_VP_DELTA` → `CASINO_VP_DELTA`; crash settlement becomes sanctioned writers #5/#6. Stop-loss (poker D23) applies to crash too — it is a casino-wide floor. |
| C3 | **House-banked, 1% edge, and the house BURNS its winnings.** Crash is not player-vs-player; a platform **house account** inside the ledger absorbs every round's net delta (Σ players + house = 0 at all times). Each week the sweep **burns the house account's accumulated positive VP** (sets it to 0, audit-logged): the edge permanently destroys VP, which only staking can re-mint — crash is a direct VP-deflation engine for the bust→restake flywheel. |
| C4 | **Crash-point distribution** (bustabit-classic, 1% edge): draw U uniform from the round seed; with p = 1/101 the round insta-busts at 1.00×; otherwise `crash = floor(100 · 99/(100·(1−U))) / 100`, capped at **100.00×**. Median ≈ 1.98×; E[payout] = 0.99 × wager for any cashout target. The exact integer-math formula + a histogram proof live in doc 01/05. |
| C5 | **Provably fair via commit-reveal hash chain**: at genesis the canister generates a 10M-element hash chain head from `raw_rand` and publishes the terminal hash; round N's seed is chain[N], revealed at crash, verifiable against round N−1's reveal. (Stronger than per-round commit: every future crash point is pre-committed at genesis.) |
| C6 | **Multiplier clock: 6%/s compound** — `m(t) = 1.00 × e^(0.06t)`: 2× ≈ 11.6 s, 10× ≈ 38 s, 100× ≈ 77 s. Slow by bustabit standards, deliberately: IC consensus adds 1–3 s to a manual cashout, which at 6%/s costs ≈ 6–18% of the multiplier — material but playable, and stated in the UI (C7). |
| C7 | **Every bet carries an auto-cashout target** (default 2.00×, range 1.01–100×) — the latency-fair primary mechanism, settled purely from the committed crash point. The **manual "CASH OUT" button is a bonus action**: it executes at the multiplier of the block that processes it, never better than your auto target. UI is honest: *"Manual cashouts take 1–3 s to land on-chain — set your auto target; the button is for nerves of steel."* |
| C8 | Bet limits: min **10 chips (0.01 VP)**, max **10,000 chips (10 VP)** per round, one bet per user per round. **Round exposure cap**: betting closes early if Σ(wager × auto-target) across the round would exceed **5,000 VP** potential payout (house variance bound; admin-tunable with rails). |
| C9 | **Humans AND agents play.** Humans use the UI; agents call the same three endpoints (`crash_bet`, `crash_cashout`, `get_crash_round`). No claim step needed (unlike poker): any signed-in principal may bet its own VP. The poker agent registry is NOT involved. |
| C10 | **Auto-pilot** = the canister runs the user's **crash strategy script** each round (bet sizing, target, martingale-style progressions, stop conditions) until a stop fires or the user turns it off — the "agent" option for non-programmers, mirroring poker's house agent. |
| C11 | **Strategy DSL** (doc 04): declarative JSON — base bet, auto target, on-loss/on-win multiply-or-reset, max consecutive losses, stop-loss/take-profit in VP, rounds-to-skip after loss. ≤ 4 KB, bounded interpreter, validated at save. Creation costs **$5** (same oracle quote flow); 4 free builtin presets (Flat, Classic Martingale, Reverse Martingale (Paroli), Target Sniper). |
| C12 | **Marketplace is shared with poker** (same listings/licenses storage, new `kind: Poker \| Crash` discriminator): list $1–$500, 80% seller / 20% treasury, body hidden until licensed, per-strategy lifetime-VP leaderboard. |
| C13 | **Chat box** (doc 03): one global Casino chat, signed-in users, 200-char messages, 1 msg / 5 s / user, 500-message ring buffer, admin mute + delete. Rendered beside the graph (bustabit layout) and on the Casino hub. |
| C14 | **History + fairness UI**: last-rounds bar (bustabit-style colored multiplier chips), every round expandable to seed/hash verification, "verify" deep link that recomputes the crash point client-side. |
| C15 | Feature flag **`crash`** (default OFF) + the Casino hub renders whichever of `poker`/`crash` is on; both off ⇒ no Casino nav entry. Admin can pause the round loop (current round completes; betting closed). |
| C16 | **Copy doctrine — "no loss of principal, ever":** the Casino hub header, both game headers, every bet panel and every bust screen carry it: *"Chips are voting power. Your staked ICP is never wagered, never at risk, and always unstakeable in full."* Stop-loss + restake nudge (poker D23/R6) surface identically here. |
| C17 | Stable memory ids **63–67 reserved**: rounds archive (63), bets-by-round (64), chat ring (65), crash strategies + auto-pilot state (66), house/burn bookkeeping (67). |
| C18 | **Tenure jubilee applies casino-wide** (poker D27): the app's shipped 6-month VP tenure doubling also forgives negative casino deltas at each tick — crash losses included. Invariant I-1c extends with the `jubilee_minted` term; the burn and the jubilee are separate counters (house edge destroyed vs losses forgiven). UI: the bust screen shows "your VP fully restores on <date> — or stake now to get back in." |

## Task index (PB-230 … PB-241, `tasks/todo/`)

| Task | Title | Depends on |
|---|---|---|
| PB-230 | Casino VP ledger: rename to `CASINO_VP_DELTA`, house account, weekly burn (amends poker PB-200) | PB-200 |
| PB-231 | Crash domain types + stable storage (63–67) + `crash` flag + Casino hub nav/redirects | — |
| PB-232 | Provably-fair engine: genesis hash chain, crash-point math, verify endpoint | PB-231 |
| PB-233 | Round loop: betting window, multiplier clock, auto/manual cashout, exposure cap, settlement + house delta | PB-230,232 |
| PB-234 | Bets API for humans + agents (`crash_bet/crash_cashout/get_crash_round`) with latency-honest semantics | PB-233 |
| PB-235 | Casino chat: ring buffer, rate limits, admin mute/delete, UI box | PB-231 |
| PB-236 | Crash strategy DSL + $5 builder + auto-pilot executor | PB-233 |
| PB-237 | Marketplace `kind` extension: crash strategies beside poker scripts | PB-236, poker PB-210 |
| PB-238 | UI: bustabit-style graph + bet panel + players list + history/verify + Casino hub + no-loss copy | PB-234,235 |
| PB-239 | Test infra: distribution histogram proof, payout oracle, round-sim soak harness | PB-231 |
| PB-240 | PocketIC integration: full rounds, house-zero-sum invariant, burn events, flag lockout | PB-233…237 |
| PB-241 | llms-crash skill doc + OPS runbook (pause, exposure cap, burn audit) | PB-234 |

## Milestones

1. **J-M1 — Fairness proven** (PB-239, 231, 232): crash-point distribution
   matches theory (histogram χ² test), hash chain verifies end-to-end.
2. **J-M2 — Rounds local** (PB-230, 233, 234, 238): humans bet/cash out on
   local; house account reconciles to exact zero-sum; burn fires.
3. **J-M3 — Auto-pilot + chat + marketplace** (PB-235…237).
4. **J-M4 — Integration + Casino hub** (PB-240, 241; poker/crash co-exist
   behind their flags; old `/poker` path redirects).
5. **Mainnet**: dark behind `crash`; owner playtest → explicit enable ask
   (standing deploy gate).

## Cross-epic amendments (poker plan)

- PB-200/doc 01: ledger renamed `CASINO_VP_DELTA`; sanctioned writers grow
  to six (poker hand settle, tourney buy-in, tourney payout, admin void,
  **crash settle, house burn**); invariant I-1 becomes *"Σ over users +
  house = 0; the burn zeroes the house and is audit-logged as destroyed
  VP"*.
- Poker doc 06/nav (D17): Poker moves under the Casino hub
  (`/casino`, tabs Poker | Crash); `/poker` redirects.
- Stop-loss (D23) is enforced casino-wide: crash bets are rejected when
  they could breach the floor.
