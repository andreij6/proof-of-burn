---
type: idea
title: "04 — Play-style scripts ($5) and the marketplace"
tags: [ideas, poker]
timestamp: 2026-06-13T22:37:20-04:00
---

# 04 — Play-style scripts ($5) and the marketplace

## What a script is

A **declarative strategy, not code**: a JSON document the canister's bounded
interpreter (and any external agent that wants to) evaluates to pick an
action. Deterministic given the hand's RNG stream; no loops, no expressions —
just lookup tables with weighted choices. This is what makes a $5 purchase
plug-and-play for house-agent users and keeps execution costs flat.

### Schema (v1)

```jsonc
{
  "schema": 1,
  "name": "Loose Cannon",            // ≤ 40 chars
  "description": "…",                // ≤ 200 chars
  "params": { "aggression": 0.7, "bluff_freq": 0.15, "tightness": 0.4 }, // 0..1, used by defaults
  "rules": [
    // First matching rule wins; ≤ 200 rules; total doc ≤ 8 KB.
    {
      "when": {
        "street": "preflop",                  // preflop|flop|turn|river|any
        "position": "late",                   // early|middle|late|blinds|any
        "hand": "premium",                    // bucket, see below
        "facing": "raise",                    // none|bet|raise|reraise|any
        "pot_odds_max": 0.35,                 // optional numeric gates
        "stack_bb_min": 10
      },
      "do": [                                  // weighted actions, weights sum ≤ 100
        { "action": "raise", "size": "pot",   "weight": 70 },  // size: min|half_pot|pot|2x|allin
        { "action": "call",                    "weight": 30 }
      ]
    }
  ]
}
```

- **Hand buckets** are computed by the canister so scripts stay small:
  preflop `premium / strong / speculative / weak / trash` (Sklansky-style
  grouping baked into the interpreter); postflop
  `nuts / strong / good / draw / weak / air` from evaluator strength +
  draw detection. Buckets are part of the public spec so marketplace buyers
  know exactly what they're buying.
- **Fallback ladder:** no rule matches → built-in default decision (check if
  free, call if cheap relative to `tightness`, else fold). A script can never
  produce an illegal action: the interpreter clamps every choice to
  `legal_actions` (illegal raise → call; illegal call → check/fold).
- **Validation at save:** schema version, size caps, weight sums, enum
  values, numeric ranges. Invalid ⇒ `INVALID_SCRIPT` with a path message.
- **Determinism:** mixed strategies draw from the hand's committed RNG
  stream (seed ‖ action counter), so the audit trail can replay every house
  decision.

## Built-in free presets (PB-208)

Every user can select these at no cost (they are the "factory firmware"):
`Standard TAG` (default on claim), `Rock`, `Loose-Passive`, `Maniac`. They
are ordinary script records owned by the canister, listed first in the
picker, never sellable.

## Custom scripts — $5.00 in any token (PB-209)

- `get_poker_script_quote(token)` → ExplorerQuote at the live oracle rate,
  locked 15 min — **identical machinery** to the Arcade $1 flow (quote map,
  caller-bound escrow subaccount, transfer to treasury, audit-log entry
  `poker_script_create`).
- `create_poker_script(json, token)` validates, takes the $5, stores:

```rust
// MemoryId 58: script_id -> PokerScript
PokerScript { id, author, name, description, body_json, version: u32,
              created_at, listed: Option<ListingId>, sales: u64, builtin: bool }
```

- **Versioning:** editing your script costs nothing but bumps `version` and
  is blocked while the script is listed for sale (buyers get the exact
  version they paid for — a sale snapshots `body_json`).
- Cap: ≤ 20 scripts per author.
- `set_active_script(script_id)` — owner-only; must be builtin, authored, or
  licensed.

## Marketplace (PB-210)

```rust
// MemoryId 59: listing_id -> Listing { script_id, seller, price_usd_e8s, active }
// MemoryId 60: (script_id, buyer) -> License { version_snapshot, paid_usd_e8s, at }
```

- **List:** `list_script_for_sale(script_id, price_usd_e8s)` — author only,
  price $1–$500, custom scripts only (not builtins, not licensed copies).
- **Buy:** quote in any supported token (same oracle flow) →
  `buy_script_license(listing_id, token)`:
  - escrow balance check → single transfer split **80% seller / 20%
    treasury** (two ledger transfers from the buyer's escrow subaccount;
    journal both block indices, retry-safe in the existing failed-payout
    sweep style);
  - mint `License` with a snapshot of the script body at purchase time;
  - `sales += 1`. Buyers may use the script (house agent or export to their
    external bot) but cannot resell, edit, or re-list it.
- **Browse:** `list_marketplace()` query — name, description, author, price,
  sales count, win-rate teaser (script's lifetime VP delta while active,
  computed from hand settlements — coarse but honest), NO rule bodies
  (the strategy is the product; body is revealed only to licensees/author).
- **Delist:** seller anytime; existing licenses unaffected.
- Seller proceeds go to the seller's **wallet principal** directly (ICP/ck
  token transfer, recorded as a `Payout` of new type `ScriptSale` so it shows
  in Profile history).

## Script leaderboard — the marketplace meta (R8, in PB-210)

`get_script_leaderboard()` query: scripts ranked by **lifetime VP won while
active** (accumulated at hand settlement onto the acting seat's active
script id), with hands-played and sales counts. Rendered both in the
marketplace (sort: winningest first) and as a "Top strategies this week"
card in the lobby. Famous scripts sell more → the 20% treasury cut scales
with the meta; authors get bragging rights + revenue. Stats are coarse and
public by design; the rule bodies stay hidden until licensed.

## Cosmetics economy (R4, PB-221)

Pure-visual items sold through the same oracle quote flow, 100% treasury:

- **Card backs** ($1), **table felts** ($2, applies to your agent's seat
  pod accents), **win animations** ($5, plays on your pot wins), **chip-set
  skins** ($2).
- Stored as palette/style indices on the PokerAgent (one slot per category);
  catalog is a static Rust table (no admin upload pipeline in v1; new items
  ship with releases).
- Zero gameplay impact, visible to every spectator (D22 renders them), and
  prize inventory for leaderboard seasons (R5/PB-222: season rewards grant
  cosmetics for free — same items, `granted` flag instead of paid).

## Revenue summary

| Flow | Price | Split |
|---|---|---|
| Create custom script | $5 any token | 100% treasury |
| Marketplace sale | seller-set $1–$500 | 80% seller / 20% treasury |
| Cosmetics (R4) | $1–$5 any token | 100% treasury |
| Builtin presets / season-prize cosmetics | free | — |
