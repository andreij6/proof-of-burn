# 04 — Crash strategies: the builder, auto-pilot, shared marketplace

## Strategy DSL (C11) — the bustabit "script bank", declawed

Declarative JSON (no code, bounded interpreter — same philosophy as poker
scripts, different shape: crash strategies are about *bet sizing over a
sequence of rounds*, not in-round decisions):

```jsonc
{
  "schema": 1,
  "name": "Classic Martingale",
  "description": "Double on loss, reset on win, 2x target.",
  "base_bet_chips": 100,             // 10..10_000
  "auto_target_x100": 200,           // 101..10_000 (1.01×..100×)
  "on_loss":  { "bet": "multiply", "factor_x100": 200, "target": "keep" },
  "on_win":   { "bet": "reset",                         "target": "keep" },
  "max_bet_chips": 5_000,            // progression ceiling (≤ round max)
  "max_consecutive_losses": 7,       // 0 = unlimited
  "skip_rounds_after_loss": 0,       // 0..10 — "cool down" pattern
  "stop": {                          // ANY trigger ends auto-pilot
    "take_profit_vp_x1000": 50_000,  // +50 VP session profit
    "stop_loss_vp_x1000": 20_000,    // −20 VP session loss (≤ casino floor)
    "max_rounds": 500                // 1..5_000
  }
}
```

- Integer-only fields (chips, ×100 multipliers, ×1000 VP) — no floats.
- Validation at save: ranges above, `base ≤ max_bet`, factor 1.0–10.0×,
  stop block REQUIRED with at least one finite trigger (no immortal
  martingales), ≤ 4 KB.
- Interpreter is O(1) per round; deterministic given the round results.
- **Builtins (free):** Flat (no progression), Classic Martingale, Paroli
  (reverse martingale), Target Sniper (flat bets, 10× target, skip 2 after
  loss). Listed first, never sellable.

## Auto-pilot (C10, PB-236)

- `start_autopilot(strategy_id)` / `stop_autopilot()` — owner only. State
  (MemoryId 66): strategy, session P&L, consecutive losses, rounds played,
  skip counter.
- Each betting window the round loop walks the auto-pilot set and places
  bets per strategy state — house-agent style: budget-bounded, O(pilots)
  per round with a hard cap (first 500 pilots per round, FIFO fairness;
  cap admin-tunable).
- Every guard still applies per bet (rails, reservation, **casino stop-loss
  floor** — the strategy's own stop is on top, not instead).
- Stop reasons surface in the UI dock and `get_my_autopilot`.
- Auto-pilot survives the user going offline (that's the point) but NOT a
  feature-flag off or admin pause (cleanly stopped, state says why).

## Creation — $5.00 any token (PB-236)

Identical machinery to poker scripts: `get_casino_script_quote(token)`
(shared with poker — one quote map), `create_crash_strategy(json, token)`
→ validate, charge to treasury, store with version. ≤ 20 per author; edits
free but bump version and are blocked while listed.

## Shared marketplace (C12, PB-237)

The poker marketplace (PB-210) generalizes rather than duplicates:

- `Listing` and `License` records gain `kind: Poker | Crash` (one storage,
  one payment path, one 80/20 split, one `ScriptSale` payout type).
- `list_marketplace(kind_filter)` + the UI gets a Poker | Crash toggle;
  crash cards show strategy *shape* teasers (base/target/progression class,
  e.g. "martingale ×2.0 @ 2.00×") and the **lifetime VP leaderboard**
  (accumulated per strategy at round settlement, same mechanism as poker's
  script leaderboard) — bodies hidden until licensed.
- Licenses grant auto-pilot use + body view; no resale/edit/relist (same
  rules as poker).
- Strategy stats honesty note in the UI: *"Past variance is not edge — every
  strategy has −1% expectation. Buy style, not magic."* (We sell fun, not
  false hope; this line is non-negotiable copy.)

## Revenue summary (casino-wide)

| Flow | Price | Split |
|---|---|---|
| Crash strategy creation | $5 any token | 100% treasury |
| Poker script creation | $5 any token | 100% treasury |
| Marketplace sale (either kind) | $1–$500 | 80% seller / 20% treasury |
| Cosmetics (poker R4; crash skins later) | $1–$5 | 100% treasury |
| House edge | 1% of crash wagers | **burned** (VP, not money — doc 02) |
