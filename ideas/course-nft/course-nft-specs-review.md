# Course NFT Specifications Review & Scorecard

This document evaluates the 11 build specifications (`00-overview-and-architecture.md` through `10-ratings-and-reviews.md`) for the Course NFT feature. The grading is divided into **Completeness**, **Correctness** (with a focus on Internet Computer Protocol compliance), and **Creativity**.

---

## 1. Executive Summary & Grading

| Spec / Task | Focus | Completeness | Correctness | Creativity | Overall Grade |
|---|---|---|---|---|---|
| **PB-301** | [01-coursenft-canister-icrc7.md](tasks/01-coursenft-canister-icrc7.md) | 9.5 / 10 | 7.0 / 10 | 9.0 / 10 | **B+** |
| **PB-302** | [02-course-editor.md](tasks/02-course-editor.md) | 10 / 10 | 9.5 / 10 | 9.5 / 10 | **A** |
| **PB-303** | [03-minigolf-engine-and-course-format.md](tasks/03-minigolf-engine-and-course-format.md) | 9.5 / 10 | 8.0 / 10 | 9.5 / 10 | **A-** |
| **PB-304** | [04-minting-flow.md](tasks/04-minting-flow.md) | 9.5 / 10 | 8.5 / 10 | 9.0 / 10 | **A-** |
| **PB-305** | [05-marketplace.md](tasks/05-marketplace.md) | 9.5 / 10 | 9.0 / 10 | 10 / 10 | **A** |
| **PB-306** | [06-play-to-earn-and-anticheat.md](tasks/06-play-to-earn-and-anticheat.md) | 10 / 10 | 7.5 / 10 | 9.5 / 10 | **B+** |
| **PB-307** | [07-secondary-market-royalties.md](tasks/07-secondary-market-royalties.md) | 9.0 / 10 | 6.0 / 10 | 9.5 / 10 | **B-** |
| **PB-308** | [08-featured-slot-auction.md](tasks/08-featured-slot-auction.md) | 9.5 / 10 | 9.0 / 10 | 10 / 10 | **A** |
| **PB-309** | [09-leaderboard-removal-and-arcade-migration.md](tasks/09-leaderboard-removal-and-arcade-migration.md) | 10 / 10 | 9.5 / 10 | 9.5 / 10 | **A** |
| **PB-310** | [10-ratings-and-reviews.md](tasks/10-ratings-and-reviews.md) | 9.5 / 10 | 8.0 / 10 | 9.0 / 10 | **A-** |

> [!IMPORTANT]
> The overall proposal is exceptionally detailed, well-thought-out, and structurally clean. However, there are **three critical correctness issues** regarding standard compliance, key serialization in stable BTreeMaps, and secondary market escrow safety that must be resolved prior to implementation.

---

## 2. Core Correctness & IC Compliance Issues (Critical)

### C1. ICRC-7 Standard Compliance: Token ID and Supply Types (PB-301)
* **The Issue**: The spec defines the Candid interface with `nat64` for token IDs and supplies (e.g. `icrc7_owner_of : (vec nat64) -> (vec opt Account)`).
* **IC Compliance**: The official [ICRC-7 standard specification](https://github.com/dfinity/ICRC-1/tree/main/standards/ICRC-7) specifies that token IDs, balances, and total supplies must be of type `nat` (unbounded natural numbers).
* **Impact**: If public methods use `nat64`, standard IC wallets (e.g. Plug, Bitfinity) and NFT explorers (e.g. Yumi, Toniq) will fail to call these query/update methods due to Candid deserialization type mismatches.
* **Resolution**: The public Candid interface **must** use `nat` for token IDs and supplies. Rust code can receive/return `candid::Nat`, and cast it to/from `u64` internally for efficient stable storage.

### C2. Stable BTreeMap Composite Key Sorting & Range Queries (PB-301, PB-306, PB-310)
* **The Issue**: Composite keys (`OwnerTokenKey` in PB-301, `PairCapKey`/`DayCapKey` in PB-306, `RatingKey` in PB-310) are set to use default CBOR serialization (`impl_storable!`).
* **IC Compliance**: `StableBTreeMap` keys are ordered based on their raw serialized bytes. CBOR serialization appends type tags, lengths, and variable-length headers. It does **not** guarantee lexicographical order of fields (e.g. sorting by `token_id` or `Principal` prefix).
* **Impact**: Range queries like `COURSE_RATINGS.range(token_id..)` (PB-310) or `icrc7_tokens_of` range scans on `OWNER_TOKENS` (PB-301) will return corrupted, incomplete, or incorrectly ordered results.
* **Resolution**: Implement a custom `Storable` trait for composite keys that serializes fields in a fixed-width, big-endian format. For example, `OwnerTokenKey` should serialize to:
  1. `Principal` byte length (1 byte)
  2. `Principal` bytes padded to 29 bytes
  3. `token_id` as big-endian bytes (`u64::to_be_bytes()`, 8 bytes)
  This ensures lexicographical sorting and allows utilizing `Bound::Bounded { max_size: 38, is_fixed_size: true }` for optimal performance.

### C3. Secondary Market Escrow Safety & Treasury Drain Vulnerability (PB-307)
* **The Issue**: The buy saga distributes the ICP splits to the seller, creator, and CMC *before* performing the `custodial_transfer` of the NFT. If the transfer fails (e.g., owner transferred out-of-band), it refunds the buyer in full *from the treasury*.
* **IC Compliance & Security**: This introduces a severe drain vulnerability and liquidity risk:
  1. **Liquidity Risk**: If a high-priced course (e.g., 5,000 ICP) has a failed transfer, the treasury must front 5,000 ICP. If the treasury lacks liquid funds, the refund fails, locking the buyer's funds indefinitely.
  2. **Exploitation**: An attacker could buy their own course from a puppet account, cause the transfer to fail (by moving the NFT out-of-band right before), and trigger a treasury refund, potentially draining the treasury's liquid buffers.
* **Resolution**: Use a **pure escrow model**.
  1. Pull the buyer's full payment (`price_e8s + fees`) into a backend-controlled escrow subaccount.
  2. Attempt `course_nft.custodial_transfer`.
  3. If it **succeeds**, execute the splits (seller, creator, CMC, treasury) out of the escrow subaccount.
  4. If it **fails**, return the escrowed funds directly back to the buyer's account. This guarantees the refund is 100% funded and eliminates any treasury-fronting risk.

### C4. `raw_rand` Performance Trap in Play Sessions (PB-306)
* **The Issue**: `start_play_session` is an update method that calls `raw_rand` to generate an 8-byte nonce.
* **IC Compliance**: `raw_rand` makes an asynchronous call to the Management Canister, which requires consensus round-trips for threshold randomness.
* **Impact**: Starting a game will take 2–4 seconds of latency and cost cycles, degrading the user experience.
* **Resolution**: Seed a local pseudo-random number generator (PRNG) (e.g. `rand_chacha`) once during initialization or upgrade, or mix the low bits of `time()` with a hash of the previous state. Generate the nonce synchronously without inter-canister awaits.

### C5. Query Response Size Limits (PB-301, PB-303)
* **The Issue**: `icrc7_token_metadata` allows batches of up to 100 token IDs.
* **IC Compliance**: The maximum query response size limit on the IC is 2 MiB.
* **Impact**: If a course's `course_data` blob reaches the 64 KiB ceiling, a batch of 100 metadata requests would return \(100 \times 64 \text{ KiB} = 6.4 \text{ MiB}\), exceeding the limit and causing the query to trap.
* **Resolution**: Lower the standard `max_query_batch_size` specifically for metadata requests containing `course_data` to a maximum of 25 (which guarantees responses remain under 1.6 MiB), or exclude the large `course_data` blob from standard metadata arrays unless explicitly requested.

---

## 3. Detailed Task-by-Task Evaluation

### PB-301 — CourseNFT canister (core ICRC-7)
* **Completeness**: **9.5/10** — Very comprehensive specification of standard endpoints, memory spaces, and admin hooks.
* **Correctness**: **7.0/10** — Standard mismatch on `nat` vs `nat64` (see C1) and sorting hazard on `OwnerTokenKey` (see C2).
* **Creativity**: **9.0/10** — The decision to make the backend an allowlisted minter/custodian is elegant, bypassing the need for ICRC-37 approvals while preserving direct user transfer capability.

### PB-302 — Course Editor
* **Completeness**: **10/10** — Exceptional UX layout mapping, client-side validation logic, and draft autosaving limits.
* **Correctness**: **9.5/10** — Accurately identifies the Candid optional decoding wrapper (`__kind__`) trap.
* **Creativity**: **9.5/10** — The 4-zone layout is standard-compliant and feels premium. Autosaving drafts every 60s reduces on-chain write frequency and transaction costs.

### PB-303 — Mini-golf engine & shared `course_data` format
* **Completeness**: **9.5/10** — Lists all element dynamics, sizes, and physics constants.
* **Correctness**: **8.0/10** — Vulnerability to the 2 MiB query response limit on batch queries (see C5).
* **Creativity**: **9.5/10** — Incorporating a deterministic hole clock `tSec` ensures gameplay fairness and synchronization without the overhead of server-side physics simulation.

### PB-304 — Minting Flow
* **Completeness**: **9.5/10** — Explicitly details the steps, status transitions, and split distributions.
* **Correctness**: **8.5/10** — Stepping through 3 separate splits and CMC top-ups on *every single mint* introduces latency and burns ledger fees. (See optimization suggestion below).
* **Creativity**: **9.0/10** — Idempotent saga design using `MintSaga` prevents double-charging or orphan tokens. Waiving the mint fee for the default courses prevents a "dead start" empty marketplace.

### PB-305 — Course Marketplace
* **Completeness**: **9.5/10** — Covers filters, card displays, and cache management.
* **Correctness**: **9.0/10** — The reliance on lazy cache updates (`refresh_course_listing`) is fine, but needs to be triggered on critical actions (like transfers) to avoid stale marketplace owners.
* **Creativity**: **10/10** — Server-seeded, client-shuffled random ordering is a brilliant solution to IC query non-determinism, ensuring fairness without cycle overhead.

### PB-306 — Play-to-Earn & Anti-Cheat
* **Completeness**: **10/10** — Strong threat model (V1-V7) covering all primary attack vectors.
* **Correctness**: **7.5/10** — Latency trap with `raw_rand` (see C4) and composite key sorting hazards for day-caps.
* **Creativity**: **9.5/10** — The three-layer check (order validation, inter-hole pacing, and daily caps) provides high Sybil resistance at low complexity.

### PB-307 — Secondary Market & Royalties
* **Completeness**: **9.0/10** — Outlines fixed-price splits and reentrancy blocks.
* **Correctness**: **6.0/10** — Critical treasury refund drainage vulnerability (see C3).
* **Creativity**: **9.5/10** — Creator royalties are permanently bound to the NFT metadata (`creator`), preventing sellers from bypassing the split.

### PB-308 — Featured Slot Auction
* **Completeness**: **9.5/10** — Clear auction logic and displacement rules.
* **Correctness**: **9.0/10** — The lock-in USD valuation model is correct and prevents price drift issues.
* **Creativity**: **10/10** — Non-refundable bids held until outbid create a highly effective token burn mechanism and a perpetual revenue stream for the treasury.

### PB-309 — Leaderboard Removal & Arcade Migration
* **Completeness**: **10/10** — Smooth cutover steps, cleanup sweeps, and rollbacks.
* **Correctness**: **9.5/10** — Two-step upgrade process ensures old data is converted before code deprecation.
* **Creativity**: **9.5/10** — Seeding the default courses as system-minted NFTs creates reference content and immediate playability.

### PB-310 — Ratings & Reviews
* **Completeness**: **9.5/10** — Clean data models and frontend hooks.
* **Correctness**: **8.0/10** — Key sorting hazard in `RatingKey` (see C2).
* **Creativity**: **9.0/10** — Restricting reviews to users who have completed the course (via the session database) prevents spam/review-bombing.

---

## 4. Suggested Optimizations (Creativity)

### O1. Cycle Split Buffering (Batching CMC Top-ups)
* **Current Design**: Splits 25% of the mint fee (or 5% of resales) to cycles immediately, converting to cycles and calling CMC top-up.
* **Optimization**: Accumulate cycle fractions in a local buffer (e.g. `cycles_pool: u64`). Once the pool exceeds a threshold (e.g. 1 ICP), run a single CMC top-up.
* **Benefits**: Saves substantial ledger fees (10,000 e8s per transfer) and reduces consensus latency for the user during minting or buying.

### O2. Float Usage in Ratings
* **Current Design**: Uses `avg_x10: nat32` to avoid floats over Candid.
* **Optimization**: Candid supports `float32` and `float64` natively. It is cleaner and more standard to declare `average_rating: float64` directly.

---

## 5. Verdict

* **Completeness Grade**: **A** (9.7 / 10) — The specifications are exceptionally detailed and implementation-ready.
* **Correctness Grade**: **B** (8.1 / 10) — Deducted for standard mismatches, query batch size limits, PRNG latency traps, key sorting hazards, and the critical treasury refund vulnerability.
* **Creativity Grade**: **A+** (9.6 / 10) — Excellent design decisions regarding custodial transfers, client-side shuffles, and non-refundable auctions.

> [!TIP]
> After resolving the standard type mismatch (C1), custom storable key serialization (C2), escrow refund pattern (C3), and local PRNG seeding (C4), these specifications are fully recommended for development.
