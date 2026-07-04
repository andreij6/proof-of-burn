---
type: idea
title: "Mini-Golf Course NFT — Economy & User Experience"
tags: [ideas, course-nft]
timestamp: 2026-06-13T22:37:20-04:00
---

# Mini-Golf Course NFT — Economy & User Experience

## Concept

Users create mini-golf courses in the course editor and mint them as ICRC-7 NFTs.
Once minted, a course is listed in the Course Marketplace, which doubles as the
course selector when starting a round. Playing a course earns lottery tickets for
whoever currently owns that course's NFT. The NFT can be bought and sold,
transferring the earning rights to the new owner. The original creator always
earns a royalty on every secondary sale.

The loop: **create → mint → list → earn tickets passively as people play → sell
to someone who values the earning rights more than you do.**

> When this feature ships, the existing global mini-golf score leaderboard is
> removed. There are no per-course leaderboards either. The game is about
> playing for fun and earning tickets — not rankings.

---

## NFT Structure (ICRC-7)

Each minted course is one ICRC-7 token in a shared `CourseNFT` canister.
All courses are exactly 9 holes — enforced at mint time, not configurable.
Token metadata (stored on-chain, returned by `icrc7_token_metadata`):

| Field | Type | Description |
|---|---|---|
| `name` | Text | Course name set by creator |
| `creator` | Principal | Original minting principal (never changes) |
| `created_at` | Nat64 | Mint timestamp (nanoseconds) |
| `course_data` | Blob | Serialized course layout (9 holes, par, obstacles, theme) |
| `par_total` | Nat8 | Sum of par values across all 9 holes |
| `play_count` | Nat | Rounds where hole 2 was completed (the owner ticket trigger) |
| `tickets_distributed` | Nat | Lifetime lottery tickets earned by all owners combined |
| `mint_fee_e8s` | Nat64 | ICP paid at mint (provenance record) |

`icrc7_transfer` is not blocked — courses are freely transferable. The
marketplace handles listing and sale; direct transfers are allowed for gifting
or OTC deals.

---

## Minting a Course

See the [Course Editor](course-editor.md) document for how a course is built.
Once complete, the mint flow is:

1. User taps **"Mint as NFT"** inside the editor.
2. The frontend calls `mint_course_nft(course_data, name)` on the backend.
3. The backend:
   - Validates that the course has **exactly 9 holes**. Rejects if not.
   - Charges a minting fee of **0.5 ICP**, split as follows:
     - **50% → treasury** (0.25 ICP house revenue, withdrawable)
     - **25% → backend cycles** (burned via CMC)
     - **25% → frontend cycles** (burned via CMC)
   - Serializes the course layout into the NFT metadata.
   - Calls the CourseNFT canister to mint the token to the caller's principal.
4. The NFT is automatically listed in the marketplace (can be delisted any time).
5. The course appears in the Course Marketplace immediately.

The 0.5 ICP minting fee keeps low-effort courses off the marketplace, generates
0.25 ICP in house revenue per mint, and gives each course on-chain provenance —
proof of what was paid and when.

---

## The Course Marketplace

The marketplace is the primary UI surface for the arcade. It shows all minted,
listed courses and doubles as the course picker before starting a round.

### Layout & Ordering

- **Featured slot** — one course card pinned at the very top of the page, won
  by the highest bidder (see Featured Course Slot section below).
- **All other courses** — randomly ordered on every page load so every listed
  course gets fair exposure regardless of age or play count. There is no sort
  control.

### Filtering

| Filter | Options |
|---|---|
| Difficulty | Easy (par ≤ 27) · Medium · Hard (par ≥ 45) |
| Theme | Desert · Ocean · Space · Forest · Custom |
| Listed for sale | Yes / No / Any |

### Each Course Card Shows

- Course name and creator username
- Theme and par total
- Total play count
- Current owner (may differ from creator)
- Sale price if listed, or "Not for sale"
- **Play** and **Buy** buttons

---

## Playing a Course

Any listed course can be played for free. Playing does not require owning or
purchasing the NFT.

### Play Flow

1. User selects a course from the marketplace and taps **Play**.
2. A round begins in the mini-golf engine (9 holes).
3. When the player **completes hole 2**:
   - The backend calls `record_hole_reached(token_id, player_principal, hole: 2)`.
   - The CourseNFT canister resolves the current owner of that token.
   - **The owner is credited 1 lottery ticket.**
   - The `play_count` field on the NFT increments.
4. When the player **completes all 9 holes**:
   - **The player is credited 1 lottery ticket** (Tier 2+ / signed-in users only).
5. Quitting before hole 2 is completed earns nothing for either party. Completing
   hole 2 but quitting before the end earns the owner their ticket but the player
   earns nothing.

### Ticket Summary

| Event | Who earns | Tickets |
|---|---|---|
| Player completes hole 2 | Current NFT owner | 1 |
| Player completes all 9 holes | The player | 1 |

Owner earning is tied to live ownership. The backend resolves the owner at the
exact moment hole 2 is completed — if the NFT was transferred since the round
started, the new owner gets the ticket. No partial credit, no retroactive payouts,
no grace period.

---

## Featured Course Slot

One course card is pinned at the top of every marketplace page load. The slot is
held by the highest bidder until someone bids higher.

- Any user can bid at any time via `bid_featured_slot(token_id, token, amount)`.
- Accepted tokens: **ckBTC, ckETH, ckUSDT, ckUSDC** only.
- Bids are compared in USD terms using the XRC oracle (already integrated), so
  different tokens compete on equal footing.
- **100% of the winning bid goes to the treasury.** The fee is non-refundable —
  there is no refund to a holder when they are displaced.
- The outbid course returns to the random pool.
- No time limit — the slot is held until a higher bid is placed.
- The featured card shows a "Featured" badge. No other mechanical advantage.

---

## Buying and Selling

### Listing for Sale

The NFT owner calls `list_course_for_sale(token_id, price_e8s)` via the
marketplace UI. The course card shows the price and a **Buy** button. The owner
can delist at any time.

### Purchase Flow

1. Buyer taps **Buy** on a listed course.
2. Frontend initiates an ICRC-2 approve for `price_e8s` from the buyer to the marketplace contract.
3. Backend calls `buy_course_nft(token_id)` and splits the payment:
   - **75%** → seller
   - **10%** → original creator (royalty, enforced on-chain, permanent)
   - **10%** → canister cycles (5% backend, 5% frontend, burned via CMC)
   - **5%** → treasury
4. CourseNFT canister transfers the token to the buyer.
5. From this point, the buyer is the owner and receives all future play ticket credits.

### Royalties

The 10% creator royalty is enforced by the purchase function using the `creator`
field in the NFT metadata, which never changes. The seller cannot route around it.
Creators who build popular courses continue to earn on every resale, forever.

### Price Discovery

Courses are yield-bearing assets. Every play where hole 2 is completed earns the
owner a lottery ticket. As the player base grows, a course that gets regular plays
becomes a meaningful passive ticket source. Buyers are paying for future earnings
— the NFT's track record (play count) is the primary signal of its value.

---

## Delisting

Owners can remove a course from the marketplace at any time:

- `delist_course(token_id)` hides it from the marketplace browser.
- The course can be re-listed later with no penalty.
- Delisted courses earn no owner tickets — listing is required for ticket accrual.

This creates a trade-off: list publicly to earn passively, or hold privately
while waiting to sell at a higher price.

---

## Canister Architecture

Course NFT logic lives in a dedicated second canister to avoid expanding the
already-large backend.

```
backend (existing)               CourseNFT canister (new, ICRC-7)
──────────────────               ──────────────────────────────────
mint_course_nft()        ──────► icrc7_mint()
record_hole_reached()    ──────► icrc7_owner_of() → credit tickets
buy_course_nft()         ──────► icrc7_transfer()
bid_featured_slot()              icrc7_token_metadata()
list_course_for_sale()           icrc7_tokens_of()
```

The backend is the marketplace controller — it holds ICP during sales, enforces
royalties, credits lottery tickets, and runs the featured slot auction. The
CourseNFT canister is a standard ICRC-7 ledger readable by any ICP wallet or
explorer.

---

## Ticket Economy Fit

Lottery tickets today come from daily staking logins. The course NFT adds two new
earning channels: a **passive channel** for owners (earn tickets automatically as
long as your course gets plays, no daily action needed), and an **active channel**
for players (finish a 9-hole round, earn a ticket). The two channels reinforce
each other — players want tickets, which drives plays, which rewards course owners,
which incentivises quality course creation.

---

## Phased Rollout

**Phase 1 — MVP**
- Mint a course (0.5 ICP fee, exactly 9 holes enforced)
- Marketplace with random ordering and filters
- Free play on any listed course
- Owner earns 1 ticket when player completes hole 2
- Player earns 1 ticket on round completion (Tier 2+ only)
- Global mini-golf leaderboard removed

**Phase 2 — Secondary Market**
- Buy / sell at fixed price
- Creator royalty and full resale split enforced on-chain

**Phase 3 — Featured Slot**
- Featured course slot (ckBTC / ckETH / ckUSDT / ckUSDC bids, 100% to treasury)
- Course ratings and reviews
