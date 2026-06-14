# Mini-Golf Course NFT — Design Document

## Concept

Users create mini-golf courses in the existing course editor and mint them as
ICRC-7 NFTs. Once minted, a course is listed in the Course Marketplace, which
doubles as the course selector when starting a round. Playing a course earns
lottery tickets for whoever currently owns that course's NFT. The NFT can be
bought and sold, transferring the earning rights to the new owner. The original
creator always earns a royalty on every secondary sale.

The loop: **create → mint → list → earn tickets passively as people play → sell
to someone who values the earning rights more than you do.**

> **Note:** When this feature ships, the existing global mini-golf score
> leaderboard is removed. There are no per-course leaderboards either. The game
> is about playing for fun and earning tickets — not rankings.

---

## NFT Structure (ICRC-7)

Each minted course is one ICRC-7 token in a shared `CourseNFT` canister.
All courses are exactly 9 holes — this is enforced at mint time and is not
configurable. Token metadata (stored on-chain, returned by `icrc7_token_metadata`):

| Field | Type | Description |
|---|---|---|
| `name` | Text | Course name set by creator |
| `creator` | Principal | Original minting principal (never changes) |
| `created_at` | Nat64 | Mint timestamp (nanoseconds) |
| `course_data` | Blob | Serialized course layout (9 holes, par, obstacles, theme) |
| `par_total` | Nat8 | Sum of par values across all 9 holes |
| `play_count` | Nat | Cumulative rounds where hole 2 was reached (updated each time) |
| `tickets_distributed` | Nat | Lifetime lottery tickets earned by all owners |
| `mint_fee_e8s` | Nat64 | ICP burned at mint (provenance record) |

`icrc7_transfer` is **not blocked** — courses are freely transferable (the earning
rights are the point). The marketplace handles listing and sale; direct transfers
are allowed for gifting or OTC deals.

---

## Minting a Course

1. User finishes building a course in the editor and taps **"Mint as NFT"**.
2. The frontend calls `mint_course_nft(course_data, name)` on the backend.
3. The backend:
   - Validates that the course has **exactly 9 holes**. Rejects if not.
   - Charges a minting fee of **0.5 ICP**, split as follows:
     - **50% → treasury** (0.25 ICP house revenue, withdrawable)
     - **25% → backend cycles** (0.125 ICP burned via CMC)
     - **25% → frontend cycles** (0.125 ICP burned via CMC)
   - Serializes the course layout into the NFT metadata.
   - Calls the CourseNFT canister to mint token to the caller's principal.
4. The minted NFT is automatically listed in the marketplace (can be delisted any time).
5. The creator receives the NFT and their course appears in the Course Marketplace.

**Why burn to mint:** keeps low-quality courses off the marketplace (skin in the
game), generates 0.25 ICP in house revenue per course minted, funds the canisters,
and gives minted courses provenance — on-chain proof of what was paid.

---

## The Course Marketplace

The marketplace is the primary UI surface for the arcade. It shows all minted,
listed courses and doubles as the course picker before starting a round.

### Layout & Ordering

- **Featured slot** — one pinned card at the top of the page, won by the
  highest bidder (see Featured Course Slot below).
- **Remaining courses** — randomly ordered on every page load so every listed
  course gets fair exposure regardless of age or play count.

### Filtering

| Filter | Options |
|---|---|
| Difficulty | Par-based: Easy · Medium · Hard |
| Theme | Desert · Ocean · Space · Forest · Custom |
| Listed for sale | Yes / No / Any |

There is no sort control — the random order is intentional.

### Each Course Listing Shows
- Course name and creator
- Par total
- Total plays
- Current owner (may differ from creator)
- Sale price (if listed) or "Not for sale"
- **Play** and **Buy** buttons

---

## Playing a Course

Any listed course can be played for free. Playing does not require purchasing
the NFT.

### Play Flow

1. User selects a course from the marketplace and taps **Play**.
2. A round begins in the existing mini-golf engine.
3. When the player **completes hole 2**:
   - The backend calls `record_hole_reached(token_id, player_principal, hole: 2)`.
   - The CourseNFT canister looks up the current owner of that token.
   - **The owner is credited 1 lottery ticket.**
   - The `play_count` metadata field increments.
4. When the player **completes all 9 holes** (round completion):
   - **The player is credited 1 lottery ticket.**
5. Players who quit before completing hole 2 earn nothing. Players who complete
   hole 2 but quit before finishing earn nothing themselves — only the owner
   gets a ticket for reaching hole 2.

### Ticket Summary

| Event | Who earns | Tickets |
|---|---|---|
| Player completes hole 2 | Current NFT owner | 1 |
| Player completes all 9 holes | The player | 1 |

Owner earning is tied to live ownership. The backend resolves the owner at the
moment hole 2 is completed — if the NFT has been transferred, the new owner
gets the ticket and the previous owner receives nothing from that point forward.
No partial credit, no retroactive payouts, no grace period.

Player tickets are gated behind Tier 2+ (signed-in users only) — anonymous
play does not earn tickets.

---

## Featured Course Slot

One course card is pinned at the very top of the marketplace page. The slot is
won by the highest bidder and held until a higher bid displaces it.

### How It Works

- Any user can place a bid at any time via `bid_featured_slot(token_id, token, amount)`.
- Accepted tokens: **ckBTC, ckETH, ckUSDT, ckUSDC** only.
- The bid amount is converted to a USD value at the moment of bidding using
  the XRC oracle (already integrated). Bids are compared in USD terms so
  different tokens compete on equal footing.
- **100% of the winning bid goes to the treasury.** No refunds to the previous
  winner when displaced — the slot is non-refundable once held.
- The outbid holder's course returns to the random pool.
- There is no time limit — the slot is held until someone bids higher.

### What the Featured Slot Gets

- Pinned position at the top of every marketplace page load.
- A "Featured" badge on the course card.
- No other mechanical advantage — the random pool below is still visible and
  playable.

---

## Buying and Selling

### Listing for Sale

The NFT owner calls `list_course_for_sale(token_id, price_e8s)` on the backend
(or via the marketplace UI). The course card shows the price and a **Buy** button.
The owner can delist at any time.

### Purchase Flow

1. Buyer taps **Buy** on a listed course.
2. Frontend initiates an ICRC-2 approve for `price_e8s` from the buyer to the marketplace contract.
3. Backend calls `buy_course_nft(token_id)`:
   - Transfers `price_e8s × 75%` to the seller.
   - Transfers `price_e8s × 10%` to the creator (royalty — immutable, enforced by the canister, not the seller).
   - Routes `price_e8s × 10%` (5% each) to backend and frontend canister cycles via CMC.
   - Routes `price_e8s × 5%` to the treasury.
   - Calls the CourseNFT canister to transfer the token to the buyer.
4. From this point, the buyer is the owner and receives all play-based ticket credits.

### Royalty Rate

Every resale splits as follows: **75% to the seller, 10% to the original creator,
10% to canister cycles (5% backend, 5% frontend), 5% to the treasury.** All four
cuts are enforced on-chain by the purchase function — the seller cannot route
around any of them. The `creator` field in the NFT metadata never changes, so
the creator royalty follows the NFT forever regardless of how many times it
changes hands.

### Price Discovery

Courses are yield-bearing assets. A popular course generating 1 owner ticket per
play is a meaningful lottery ticket source as the player base grows. Buyers are
paying for future passive earnings — the more plays a course accumulates, the
more its secondary market value reflects that track record.

---

## Delisting / Unlisting

Owners can remove a course from the marketplace at any time:
- `delist_course(token_id)` hides it from the marketplace browser.
- The course can be re-listed later (no penalty).
- Delisted courses earn no tickets — listing is required for ticket accrual.

---

## Canister Architecture

The minimum-friction path: add course NFT logic as a **second canister** rather
than expanding the already-large backend.

```
backend (existing)               CourseNFT canister (new, ICRC-7)
──────────────────               ──────────────────────────────────
mint_course_nft()        ──────► icrc7_mint()
record_hole_reached()    ──────► icrc7_owner_of() → credit tickets
buy_course_nft()         ──────► icrc7_transfer()
bid_featured_slot()              icrc7_token_metadata()
list_course_for_sale()           icrc7_tokens_of()
```

The backend is the marketplace controller (holds ICP during sales, enforces
royalties, credits lottery tickets, runs the featured slot auction). The
CourseNFT canister is a standard ICRC-7 ledger that the backend calls for
ownership queries and token transfers. This keeps the NFT state portable and
readable by any ICP wallet or explorer.

---

## Ticket Economy Fit

Lottery tickets today come from daily staking logins. The course NFT adds two
new channels: a **passive yield channel** for owners (earn tickets without any
daily action as long as your course gets plays), and an **active play channel**
for players (finish a 9-hole round, earn a ticket). The tickets come from real
user activity, not inflation, and the two channels reinforce each other —
players want tickets, which drives plays, which rewards owners.

---

## Phased Rollout

**Phase 1 — MVP**
- Mint a course (0.5 ICP fee, exactly 9 holes enforced)
- Marketplace listing with random ordering
- Free play on any listed course
- Owner earns 1 ticket when player reaches hole 2
- Player earns 1 ticket on round completion (Tier 2+ only)
- Global mini-golf leaderboard removed

**Phase 2 — Secondary Market**
- Buy / sell at fixed price
- Creator royalty and resale split enforced on-chain

**Phase 3 — Featured Slot**
- Featured course slot auction (ckBTC / ckETH / ckUSDT / ckUSDC)
- Course ratings / reviews
