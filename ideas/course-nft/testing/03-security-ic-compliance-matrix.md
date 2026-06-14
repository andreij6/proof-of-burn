# Course NFT — Security & IC-Compliance Regression Matrix

> The **blocking** test suite for the Course NFT feature. Where [01](01-backend-unit-tests.md)
> and [02](02-integration-pocketic-e2e.md) prove the features *work*, this doc proves the
> feature is **safe and standards-correct** — it turns the spec review's correctness issues
> (**C1–C5**, [course-nft-specs-review.md](../course-nft-specs-review.md) §2), PB-306's
> anti-cheat threat model (**V1–V7**), and the money/ticket invariants into named, layered
> regression tests. Read the [testing overview](00-testing-overview.md) first — it fixes the
> pyramid (L1 backend unit, L2 `course_nft` unit, L3 PocketIC), the coverage targets (§7:
> *money & anti-cheat = 100% of branches*), and the phase gates (§6). Every test below names
> its **layer**, its **setup**, its **assertion**, and — the point of a regression suite —
> the **failure mode it catches**: what a future regression would actually look like.
>
> These tests are **first-class and merge-blocking** per their phase (§5 traceability). A red
> test here blocks merge even if the feature "works" in a demo.

---

## 0. Shared harness facts these tests rely on (verified against the repo)

So the assertions below are grounded, not hand-wavy — these are confirmed in `src/backend/src/lib.rs`:

- **`impl_storable!` is CBOR with `Bound::Unbounded`** (`macro_rules! impl_storable`,
  `ciborium::into_writer` / `from_reader`, `const BOUND: Bound = Bound::Unbounded`). This is
  *exactly* why **C2** bites: a CBOR-encoded composite key does **not** sort by its leading
  field, so any `StableBTreeMap::range()` over a CBOR key returns garbage. C2's fix is a
  hand-rolled fixed-width big-endian `Storable` (`Bound::Bounded { max_size: 38,
  is_fixed_size: true }`).
- **`raw_rand` is an async management-canister call** (`ic_cdk::call(Principal::management_canister(),
  "raw_rand", ())`) used **only** by `lottery_random_u64` (per *draw*) and the genesis-chain
  seed — never on a per-action hot path. This is the baseline **C4** protects: `start_play_session`
  must not introduce a new `raw_rand`/inter-canister `await`.
- **Lottery ticket model:** `LOTTERY_TICKETS: StableBTreeMap<Principal, TicketEntry>` with
  `TicketEntry { round, count, last_claim_day }`. A credit/claim resets `count` to 0 only when
  `entry.round != state.round` (the stale-round reset in `claim_daily_tickets` /
  `dev_grant_lottery_tickets`), and `state.round` increments **only on a draw/win**
  (`lottery_draw_check` → `state.round += 1`). This is the mechanism behind the **never-void**
  invariant.
- **`void_current_round_tickets(user)`** zeroes a user's current-round `count` and decrements
  `state.total_tickets`. It has **two** call sites today: the **unstake** path
  (`if !user_has_stake(caller) { void_current_round_tickets(caller); }`) — which the lottery
  companion change **removes** — and the **admin-promotion** path (admins never hold tickets)
  — which is **retained**.
- **`settle_burn_split`** is the split/idempotency template: each leg gated by its own
  `Option<u64>` block index (`treasury_block`, `cmc_block_index`, `frontend_cmc_block`),
  remainder leg computed last (`frontend_amt = amount − treasury − backend`), treasury fronts
  per-leg fees via a balance-checked top-up, and `CMC_REFUNDED → block = None → retry`. PB-307's
  buy saga and these economic-invariant tests mirror it exactly (with the pure-escrow ordering
  of C3).

---

## 1. IC-compliance regression matrix (C1–C5)

One named test (or small cluster) per correctness issue. Each is written so that **reverting
the fix in the spec makes the test fail** — that is the definition of a regression guard.

### C1 — ICRC-7 token ids/supplies are unbounded `nat`, not `nat64` (PB-301)

The fix (PB-301 B.6): the public ICRC-7 surface takes/returns `candid::Nat`; storage stays
`u64`; the edge helper `nat_to_u64(n) -> Option<u64>` returns `None` for out-of-`u64` ids
(→ that id "doesn't exist", no trap). The non-standard minter methods keep `nat64`.

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `c1_nat_overflow_owner_of_returns_none` | **L2** (`course_nft` unit) | Mint token 1 to dev1. Call `icrc7_owner_of(vec![Nat::from(u64::MAX) + 1])`. | Returns `vec![None]` — **no trap**. (And `icrc7_owner_of([Nat::from(1u8)])` returns `Some(dev1)`.) | A future refactor that does `n.0.to_u64().unwrap()` (or `as u64` truncation) at the edge — would trap or alias the over-`u64` id onto a real token. |
| `c1_supply_returns_nat` | **L2** | Mint 3 tokens. | `icrc7_total_supply()` / `icrc7_supply_cap()` return `Nat` (compiles against `Nat`), value `== 3`. | Someone reverts the return type to `nat64` — breaks the Candid contract silently at the type level. |
| `c1_standard_wallet_shaped_call_decodes` | **L3** (PocketIC, real Candid) | Install `course_nft`, mint a token. Issue a **`vec nat`-shaped** `icrc7_owner_of` query call encoded exactly as a standard wallet would (`(vec nat)`), and an `icrc7_token_metadata((vec nat))` call. | Both **decode and return** without a Candid deserialization error. | The whole reason C1 exists: a `nat64` interface makes Plug/Bitfinity/Yumi/Toniq fail to decode. Only a **real Candid boundary (L3)** catches this — an L2 unit test using Rust types would pass even with the wrong wire type. This is the canary for D2 ("be readable by any standard wallet"). |

> **Why L3 is mandatory for C1:** L1/L2 use native Rust types and would happily compile/run a
> `nat64` interface. Only the PocketIC `update_call`/`query_call` path exercises the *wire*
> encoding a third-party wallet uses. C1 is therefore owned jointly by 03 (this doc) and 02.

### C2 — Composite stable keys are fixed-width big-endian, not CBOR (PB-301 `OwnerTokenKey`, PB-310 `RatingKey`)

The fix: keys that are **range-scanned** hand-roll `Storable` (token/owner field first,
big-endian, `Bound::Bounded { max_size: 38, is_fixed_size: true }`). Keys that are only
point-`get`/`insert` (`DayCapKey`, `PairCapKey` in PB-306) stay CBOR (`impl_storable!`) on
purpose — the C2 scope note in [06](../tasks/06-play-to-earn-and-anticheat.md).

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `c2_owner_tokens_range_isolates_one_owner` | **L2** | Mint **> 256** tokens to **two** owners *interleaved* (so `token_id`'s high byte varies across owners): A,B,A,B,…. | `icrc7_tokens_of(ownerA, prev=None, take=large)` returns **exactly** ownerA's ids, **ascending**, and **none** of ownerB's; same for ownerB. Count matches what was minted to each. | `OwnerTokenKey` reverted to `impl_storable!` (CBOR): the `range(OwnerTokenKey{owner, 0}..)` prefix scan bleeds ownerB's rows in / drops ownerA's rows — `icrc7_tokens_of` / `icrc7_balance_of` return corrupted, cross-owner results. >256 tokens is required so the `token_id` high byte actually varies (a small N can pass by luck). |
| `c2_owner_token_key_roundtrip_fixed_width` | **L2** | Construct `OwnerTokenKey{owner, token_id}` for a short and a 29-byte principal. | `from_bytes(to_bytes(k)) == k`; `to_bytes(k).len() == 38` for **both**; byte order: `to_bytes(k_lo) < to_bytes(k_hi)` whenever `(owner,id)` sorts lower. | A `to_bytes` that doesn't pad the principal region to fixed 29 (+1 len) bytes — variable-length keys break ordering and the `is_fixed_size: true` bound. |
| `c2_rating_range_isolates_one_course` | **L2** | Seed ratings for **≥ 2** courses whose `token_id`s differ in the **high byte**, interleaved with raters whose principal bytes would sort **before** a lower `token_id` under CBOR. | `list_course_reviews(token_id)` (which does `COURSE_RATINGS.range(token_id..)`) returns **exactly** that course's rows, never bleeding into the adjacent course; ordering stable. | `RatingKey` reverted to CBOR: CBOR puts type tags/lengths ahead of the value, so a principal can sort before a smaller `token_id` → a course's review list leaks/loses rows. The "raters sort before a lower token_id" construction is what specifically exposes a CBOR key. |
| `c2_rating_key_roundtrip_fixed_width` | **L2** | `RatingKey{token_id, rater}` round-trip. | `from_bytes(to_bytes(k)) == k`; length `== 38`; `token_id` sorts **first** (big-endian) ahead of `rater`. | Field order flipped (rater first) — would group by rater, not course, silently breaking per-course aggregation. |
| `c2_pointlookup_keys_stay_cbor` | **L1** (backend unit) | Insert/get `DayCapKey{who, day}` and `PairCapKey{player, token_id, day}` (these use `impl_storable!`). | Exact-key `get` after `insert` returns the value; **no `.range()` is ever called on these maps** (assert by code review / a doc-comment grep; functionally: point lookups round-trip). | Someone "upgrades" `DayCapKey`/`PairCapKey` to fixed-width unnecessarily (churn), **or** worse, adds a `.range()` over a CBOR cap key (re-introduces C2 on the cap path). The C2 scope note says these are point-lookup-only on purpose. |

### C3 — Pure-escrow buy saga: refund is 100% escrow-funded, treasury never fronts the price (PB-307)

The fix (PB-307 A6): order is **pull-to-escrow → transfer NFT → pay-from-escrow**. On a
failed transfer, refund the buyer **from the escrow subaccount**; the treasury fronts only
per-leg ledger fees, never the principal. **These are the Phase-2 merge-blockers.**

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `c3_payout_legs_gated_on_transferred` | **L1** | Build a `CourseSale` and run `run_buy_saga`; inspect the journal at each await boundary. | No payout leg block (`seller_block`/`royalty_block`/`backend_cmc_block`/`frontend_cmc_block`/`treasury_block`) is **ever** set while `transferred == false`; `pull_block` is set first and exactly once. | The original (broken) ordering — splits distributed *before* `custodial_transfer`. If a leg can be paid before the NFT moves, a forced-transfer-failure leaks paid splits. This is the structural guarantee behind C3. |
| `c3_forced_transfer_failure_refunds_from_escrow` | **L1** | Mock `course_nft.custodial_transfer` to **fail** (`TEST_MOCK_*` leg toggle / `OwnershipChanged`). Run the buy. Snapshot treasury balance before/after. | (a) Buyer is refunded the **full `price_e8s`** from the **escrow subaccount**; (b) `refund_block` set **once**; (c) **treasury principal balance unchanged** except the single refund ledger fee; (d) escrow subaccount nets to ≈ 0; (e) returns `OWNERSHIP_CHANGED`; (f) buyer ends up with **neither** lost funds **nor** the token. | A regression to treasury-fronted refunds (C3's original drain). If the refund draws from the treasury, (c) fails — that's the liquidity/drain bug. |
| `c3_puppet_account_drain_sim` | **L3** (PocketIC, real ledger + `course_nft`) | Attacker mints/owns a high-priced course via a puppet, lists it, approves+`buy_course_nft` from a second principal they control, then **moves the NFT out-of-band** (`icrc7_transfer`) so `custodial_transfer(from=live_owner)` rejects. | Refund comes **only** from escrow; **treasury liquid balance does not drop**; escrow drained to ≈ 0; no split was ever paid (all leg blocks `None`). The attacker recovers only their own escrowed money. | The exact C3 exploitation scenario in the review (§2 C3.2): attacker forces a failed transfer to siphon treasury buffers. If treasury balance drops by ~price, the drain vector is open. **L3 because it needs a real ledger + real `custodial_transfer` rejection.** |
| `c3_payout_leg_failure_is_resumable_no_double_pay` | **L1** | After `transferred == true`, fail at each payout-leg boundary in turn; re-run the saga. | Each leg block index is set **exactly once** across re-runs; the buyer is **never** refunded after the NFT moved (no reverse); totals equal the split (see §3). | A non-idempotent payout (re-pays a leg on retry) — double-spends from escrow. Mirrors `settle_burn_split`'s per-leg block idempotency. |

### C4 — `start_play_session` is synchronous: no `raw_rand`, no inter-canister `await` (PB-306)

The fix (PB-306 A2/C4): the start endpoint is a pure sync update; the journal nonce is derived
synchronously (`current_time() ^ (session_id·k)`); owner resolution moved to the hole-2 moment.

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `c4_start_session_makes_no_management_call` | **L1** | Install a counting mock for both `raw_rand` and `course_nft_owner_of` (the existing `TEST_MOCK_RAND` / new `TEST_MOCK_OWNER` seams). Call `start_play_session(token_id)` for a minted+listed course. | `raw_rand` call count == 0 **and** `course_nft_owner_of` call count == 0 across the call. Session is created with `nonce != 0` (synchronously derived), monotonic `session_id`, `last_hole == 0`. | A regression that re-adds `raw_rand` for a nonce, or re-adds the start-time `icrc7_owner_of` snapshot — both re-introduce the 2–4 s consensus latency C4 removed. The call-count assertion is the latency canary without timing flakiness. |
| `c4_start_session_synchronous_nonce` | **L1** | Start two sessions at the **same** mocked `current_time()`. | Their nonces differ (because `session_id` differs in the `time ^ id·k` derivation) and are computed without any `await`/`raw_rand`. | A nonce derived purely from `time()` (collides for same-tick starts) or re-introducing async randomness. |
| `c4_start_session_latency_free_in_pocketic` | **L3** (optional, advisory) | Drive `start_play_session` against the real backend in PocketIC. | Completes in one round (no extra inter-canister hop observed); contrast with `record_hole_event(hole=2)` which *does* make the one allowed `icrc7_owner_of` call. | Confirms the synchronous boundary holds through the real Candid/ingress path, not just the mock. Non-blocking if PocketIC timing is noisy — the L1 call-count test is authoritative. |

### C5 — Query-response 2 MiB ceiling: `icrc7_token_metadata` capped at 25 ids (PB-301, PB-303)

The fix (PB-301 A.5): `course_data` ≤ 64 KiB per token; `icrc7_token_metadata` ≤ **25** ids
(25 × 64 KiB = 1.6 MiB < 2 MiB); light methods keep the standard **100**-id cap; over-cap
returns `BATCH_TOO_LARGE`.

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `c5_metadata_rejects_over_25_ids` | **L2** | Call `icrc7_token_metadata` with **26** ids. | Returns `Err`/trap with `BATCH_TOO_LARGE` (per ICRC-7 oversize behavior). 25 ids is accepted. | The cap reverted to the standard 100 for the blob-bearing method — re-opens the 6.4 MiB trap. |
| `c5_light_methods_keep_100_cap` | **L2** | Call `icrc7_owner_of` / `icrc7_tokens_of` / `icrc7_balance_of` with 100 ids (ok) and 101 (reject). | 100 accepted, 101 → `BATCH_TOO_LARGE`. | Over-tightening the light methods (breaks standard wallet pagination) **or** leaving them uncapped. |
| `c5_25x64kib_reply_under_2mib` | **L3** (PocketIC, real response size) | Mint **25** tokens each carrying a **64 KiB** `course_data` blob (the canister ceiling). Call `icrc7_token_metadata` with all 25 ids. | The query **returns successfully** (does not trap on the response-size limit); decoded reply contains 25 entries; observed reply size < 2 MiB. | The core C5 regression: a metadata reply that exceeds the IC's 2 MiB response cap and **traps the query**. Only a **real boundary (L3)** with real blobs exercises the actual message-size limit — an L2 unit test never hits the IC's response cap. |
| `c5_mint_rejects_oversize_blob` | **L2** | `mint` a token with `course_data` of 65_537 bytes. | Rejected (`course_data > 65536`); 65_536 accepted. | The 64 KiB ceiling removed — a single huge token could push even a 1-id metadata reply toward the limit and corrupt the C5 math. |

---

## 2. Anti-cheat matrix (V1–V7, PB-306 threat model)

Tickets convert to real lottery-prize ICP, so fabricated tickets are theft from honest
holders. Per D1 there is **no server-side physics replay**; the defense is structural
(server-minted monotonic sessions + in-order holes + pacing) plus rate limits (caps). Each row
states the **attack**, the **defense under test**, the **proving test** (L1 unless noted), and
the **explicitly accepted residual** — the residual is part of the contract, not a gap.

| V | Attack | Defense under test | Proving test(s) | Accepted residual |
|---|---|---|---|---|
| **V1** | Owner scripts `record_hole_event(hole=2)` repeatedly to pump their own owner tickets. | Hole-2 credit fires only inside a live session, requires holes 1→2 **in order**, **pacing**-gated, and capped per `(player,course,day)` + per `(owner,day)`; **self-play suppressed**. | `v1_hole2_requires_in_order_live_session` (jump straight to hole 2 → `OUT_OF_ORDER`, no credit); `v1_self_play_no_owner_credit` (player == live owner → `owner_credited:false`, but completion still earns the player ticket). | Owner can still earn up to `MAX_OWNER_TICKETS_PER_DAY` (200) from *real-looking* sessions by *other* players. Bounded, accepted. |
| **V2** | Player scripts a fake "completion" to mint a player ticket. | `complete_round` needs a live session with **all 9 holes recorded in order**, each pacing-gated, deduped; costs ≥ 9 × min-pace wall-clock; counts against the player daily cap. | `v2_complete_requires_9_in_order` (`last_hole < 9` → `INCOMPLETE_ROUND`); `v2_completion_costs_min_pace` (9 holes faster than `9 × MIN_HOLE_INTERVAL_NS` is impossible — pacing rejects). | A patient bot earns up to `MAX_PLAYER_TICKETS_PER_DAY` (20). Bounded, accepted. |
| **V3** | Replay a captured `record_hole_event` / `complete_round`. | Per-`(session,hole)` dedupe via monotonic acceptance; `complete_round` **terminal**; `session_id` **server-minted & monotonic**, never client-chosen. | `v3_replay_hole_rejected` (re-send the same hole → `OUT_OF_ORDER`); `v3_complete_is_terminal` (second `complete_round` → `ALREADY_COMPLETED`, no second ticket). | None material. |
| **V4** | Headless loop: start → 9 holes as fast as allowed → complete → repeat. | `MIN_HOLE_INTERVAL_NS` (3 s) floor between holes + per-`(player,course,day)` and per-`(player,day)` caps bound throughput. | `v4_pacing_floor` (hole faster than 3 s → `TOO_FAST`; ≥ 3 s → `Ok`); `v4_player_daily_cap` (21st completion ticket/day skipped → `player_credited:false, reason: DAILY_CAP`). | Bot earns up to the daily cap, then nothing more that day. The explicit accepted ceiling. |
| **V5** | Sock-puppet swarm plays the attacker's own course to farm owner tickets. | Per-`(owner,day)` cap (200) over **all** their courses; per-`(player,course,day)` cap (5) stops one puppet hammering one course; **self-play suppression** when player == owner; player ticket itself needs Tier 2+. | `v5_per_course_per_player_cap` (6th owner credit from same player on same course/day skipped; a 6th from a *different* player still credits); `v5_owner_daily_cap` (201st owner ticket/day skipped; resets next UTC day); `v5_self_play_suppressed` (player == owner → no owner credit). | Sybil across many *real* Tier-2 principals can farm owner tickets up to the per-owner cap. KYC-grade Sybil resistance is **out of scope**; the per-owner daily cap is the backstop. |
| **V6** | Report hole 5 without 1–4 (skip pacing) or report hole 2 twice. | Monotonic in-order rule: accept only `hole == last_hole + 1`, `1..=9`; dedupe per `(session,hole)`. | `v6_out_of_order_rejected` (jump to hole 5 → `OUT_OF_ORDER`); `v6_bad_hole_rejected` (hole 0 or 10 → `BAD_HOLE`). | None. |
| **V7** | Hold a session open across an NFT transfer or a lottery-round boundary to credit the wrong owner/round. | Owner resolved **live at the hole-2 moment** (not the start snapshot); credit always targets the **current** lottery round; sessions **expire** (TTL) and are swept. | `v7_owner_resolved_at_hole2` (change `TEST_MOCK_OWNER` mid-session → hole-2 credits the **new** owner, not the start owner); `v7_credit_targets_current_round` (bump `state.round` mid-session → credit lands in the new round, stale-round count reset first); `v7_expired_session_rejected` (advance time past `SESSION_TTL_NS` → `SESSION_EXPIRED`). | None material. |

**Cross-cutting anti-cheat tests (not a single V row):**

| Test | Layer | Assertion |
|---|---|---|
| `ac_foreign_caller_rejected` | L1 | A caller who isn't `session.player` → `NOT_YOUR_SESSION` on `record_hole_event`/`complete_round`. |
| `ac_owner_of_failure_advances_no_credit` | L1 | `course_nft_owner_of` returning `None`/`Err` at hole 2 → hole **advances**, **no** owner credit, **no trap**, `owner_credited:false`. |
| `ac_cap_hit_does_not_fail_play` | L1 | When any cap is hit, the play call still returns `Ok` (credit silently skipped) — caps never error the round. |
| `ac_admin_recipient_excluded` | L1 | If the credit recipient (owner **or** player) `is_admin_principal`, the credit is silently skipped (admin-exclusion), play still succeeds. |
| `ac_caps_reset_next_utc_day` | L1 | Advancing `current_time()` to the next UTC epoch-day yields a fresh `(principal, day)` / `(player, token_id, day)` row → counters effectively zero. |
| `ac_sweep_reaps_expired_and_completed` | L1 | `sweep_play_sessions()` removes past-TTL **and** `Completed` sessions, leaves active in-TTL ones, honors `SESSION_SWEEP_BATCH` (200). |
| `ac_tier_gate_player_ticket` | L1 | Tier-0 (anon) and Tier-1 completion → `player_credited:false`; Tier-2 (following set in `USER_NEURONS`) → `true`. Owner ticket has **no** tier gate. |

---

## 3. Economic invariants

The money-path branch-coverage target is **100%** (overview §7). These tests assert the
properties that, if violated, lose real ICP.

### 3.1 Split sums == 100% (representative + odd-remainder prices)

The remainder leg is computed last (`treasury = price − others`), mirroring `settle_burn_split`'s
`frontend_amt = amount − treasury − backend`. So the sum is exact **by construction** — these
tests prove it stays that way and that the remainder lands on the right leg.

| Test | Layer | Setup | Assertion |
|---|---|---|---|
| `econ_mint_split_sums` | L1 | Mint fee **50/25/25** (creator-or-treasury / backend cycles / frontend cycles, per PB-304). | `creator/treasury + backend + frontend == fee` for representative fees **and** odd-remainder fees (e.g. `0.5 ICP`, a prime-ish e8s value, `1 e8s`). No leg negative; remainder ≤ 2 e8s on the last leg. |
| `econ_resale_split_sums` | L1 | Resale **75/10/5/5/5** (seller / royalty / backend / frontend / treasury), bps `7500/1000/500/500/500`. | `seller + royalty + backend + frontend + treasury == price_e8s` for representative and **odd-remainder** prices (e.g. `0.1 ICP` floor, `333_333_337 e8s`, `MAX_SALE_PRICE_E8S`). Treasury (computed-last remainder) absorbs the ≤ 4 e8s rounding dust; sum is exact. |
| `econ_seller_eq_creator_coalesced` | L1 | First resale where `seller == creator`. | The 75% + 10% are paid as one **85%** transfer (one fewer ledger fee), but the journal records **both** `seller_block` and `royalty_block` (same block index) so idempotency logic is uniform; total still sums to `price_e8s`. |

### 3.2 No NFT moves without payment; no payment without escrow funding (C3 economic restatement)

| Test | Layer | Assertion |
|---|---|---|
| `econ_no_transfer_before_escrow` | L1 | `custodial_transfer` is **never** attempted before `pull_block.is_some()` (escrow funded). |
| `econ_no_payout_without_transfer` | L1 | No payout leg pays before `transferred == true` (= `c3_payout_legs_gated_on_transferred`). |
| `econ_buyer_never_pays_and_loses_token` | L1/L3 | Across every saga failure boundary, the end state is one of: {buyer owns token AND all legs paid} or {buyer owns no token AND fully refunded from escrow}. Never {paid but no token} or {token moved but legs unpaid-and-unrecoverable}. |

### 3.3 Ticket lifetime invariant — never voided on unstake; reset only on a lottery win

This is the **lottery companion change** (overview §6 / §8). The single uniform reset is the
round bump on a draw; `void_current_round_tickets` survives **only** for admin-exclusion.

| Test | Layer | Setup | Assertion | Failure mode it catches |
|---|---|---|---|---|
| `inv_unstake_does_not_void_tickets` | **L1** | dev1 stakes, earns tickets (any source: daily grant, course play). dev1 fully **unstakes** (drops to `!user_has_stake`). | dev1's `LOTTERY_TICKETS[dev1].count` is **unchanged**; `state.total_tickets` unchanged. (Daily-grant simply stops accruing *new* tickets.) | Re-introduction of the `void_current_round_tickets(caller)` call in `unstake` (the call removed by the companion change). This is the regression guard for the never-void rule. |
| `inv_only_win_resets_all_sources` | **L1** | Seed one principal with tickets from **all three** sources (staking daily grant, course play credit, NFT-holding owner credit) in round R. Run a draw so `state.round` → R+1. | On next touch, the user's stale-round `count` reads **0** (the `entry.round != state.round` reset) — uniformly for **all** sources. No source survives, none is voided early. | A source that resets independently of the round (e.g. course tickets given their own clear), or a round bump that doesn't reset some source — breaks the "one uniform reset" rule. |
| `inv_admin_promotion_still_voids` | **L1** | Give dev1 tickets, then promote dev1 to admin (the path at the second `void_current_round_tickets` call site). | dev1's current-round tickets are zeroed and `total_tickets` decremented — **admin-exclusion retained**. | The companion change over-reaching and removing **both** call sites — admins must never hold tickets. |
| `inv_credit_into_current_round_only` | **L1** | Credit a course ticket while a stale `TicketEntry` (old round) exists for the recipient. | The stale-round entry is reset to `count=0` **before** the +1, `count == 1`, `state.total_tickets += 1`, `next_draw_at` armed if 0 — matching `dev_grant_lottery_tickets`. Never credits a snapshot/old round. | A credit that adds onto a stale-round count (would inflate `total_tickets` against a dead round). |
| `inv_admin_never_credited` | **L1** | Credit recipient `is_admin_principal`. | Credit silently skipped; no `LOTTERY_TICKETS` row created/changed for the admin. | Admin accidentally accumulating tickets through the course path (bypassing the lottery's admin-exclusion). |

---

## 4. Auth / permission matrix

Who-can-call for **every new update method**. Cells: ✅ accept (subject to method logic),
❌ reject (with the documented error). Queries are open to all (incl. anonymous) per D2 and are
omitted. "Owner" = current token owner; "minter" = the backend canister principal (allowlisted
on `course_nft`); "admin" = config admin / deploy controller.

### 4.1 `course_nft` canister (PB-301)

| Method | anonymous | auth non-owner | owner | admin (≠minter) | minter (backend) | Reject error |
|---|---|---|---|---|---|---|
| `mint` | ❌ | ❌ | ❌ | ❌ | ✅ | `NOT_MINTER` (non-minter); inspect_message rejects anon update |
| `custodial_transfer` | ❌ | ❌ | ❌ | ❌ | ✅ | `NOT_MINTER` |
| `bump_play_count` | ❌ | ❌ | ❌ | ❌ | ✅ | `NOT_MINTER` |
| `add_tickets_distributed` | ❌ | ❌ | ❌ | ❌ | ✅ | `NOT_MINTER` |
| `icrc7_transfer` | ❌ | ❌ (not owner of the id) | ✅ (own token only) | ❌ unless owner | ❌ unless owner | `Unauthorized` (non-owner); `NonExistingTokenId` |
| `set_minter` / `set_admin` | ❌ | ❌ | ❌ | ✅ | ❌ unless also admin | non-admin rejected |

Named tests: `auth_nft_minter_methods_reject_nonminter` (L2 — anon/owner/admin all `NOT_MINTER`
on the four minter methods), `auth_icrc7_transfer_owner_only` (L2 — owner ✅, any other caller
`Unauthorized`, unknown id `NonExistingTokenId`), `auth_admin_can_rotate_minter` (L2 — admin
`set_minter` ✅, non-admin ❌), `auth_anon_update_rejected_inspect_message` (L3 — anonymous
ingress to any update rejected at the inspect-message gate; queries still open).

### 4.2 Backend methods (PB-306 play, PB-307 sale, PB-310 ratings)

| Method | anonymous | auth non-owner | owner | admin | Notes / reject error |
|---|---|---|---|---|---|
| `start_play_session` | ✅ (plays for fun) | ✅ | ✅ | ✅ | Anyone may start; anon earns no *player* ticket. Course must be minted+listed (else `Err`). |
| `record_hole_event` | ✅ (own session) | ✅ (own session) | ✅ | ✅ | Caller must own the session → `NOT_YOUR_SESSION` otherwise. |
| `complete_round` | ✅ but no player ticket (Tier 0) | ✅ if Tier 2+ | ✅ | credit skipped (admin-excluded) | `NOT_YOUR_SESSION` / `ALREADY_COMPLETED` / `INCOMPLETE_ROUND`. |
| `list_course_for_sale` | ❌ | ❌ (`NOT_OWNER`) | ✅ | ❌ unless owner | `require_authenticated`; live owner check; `BAD_PRICE` out of bounds. |
| `delist_course` | ❌ | ❌ (`NOT_OWNER`) | ✅ | ❌ unless owner | owner-gated, live. |
| `buy_course_nft` | ❌ | ✅ (buyer) | ❌ self-buy (`CANNOT_BUY_OWN_COURSE`) | ✅ (as a buyer) | `require_authenticated`; `SALE_IN_PROGRESS` / `NOT_FOR_SALE` / `PRICE_CHANGED`. |
| `rate_course` | ❌ | ✅ if completed a round (Tier 2+) | ❌ (`CANNOT_RATE_OWN_COURSE`) | ✅ if not owner/creator | also `MUST_COMPLETE_ROUND`, `BAD_STARS`, `TEXT_TOO_LONG`; creator also blocked. |
| `admin_remove_rating` | ❌ | ❌ | ❌ | ✅ | `require_admin`. |

Named tests: `auth_play_anon_allowed_no_player_ticket` (L1), `auth_session_owner_only` (L1 —
`NOT_YOUR_SESSION`), `auth_list_delist_owner_only` (L1 — non-owner `NOT_OWNER`, anon rejected),
`auth_buy_requires_auth_and_not_self` (L1 — anon ❌, buyer==seller `CANNOT_BUY_OWN_COURSE`),
`auth_rate_completion_and_not_owner` (L1 — non-completer `MUST_COMPLETE_ROUND`, creator/owner
`CANNOT_RATE_OWN_COURSE`, anon ❌), `auth_admin_remove_rating_admin_only` (L1).

---

## 5. Consolidated traceability (C/V/invariants → test → layer → phase gate)

Merge-blocking = the test must be green to merge the PR for that phase (overview §6). **C3 is
the explicit Phase-2 blocker; every C and V is blocking for the phase that ships its feature.**

| Item | Primary test(s) | Layer(s) | Phase gate | Merge-blocking? |
|---|---|---|---|---|
| **C1** nat vs nat64 | `c1_nat_overflow_owner_of_returns_none`, `c1_supply_returns_nat`, `c1_standard_wallet_shaped_call_decodes` | L2 + **L3** | Phase 1 (PB-301) | **Yes** |
| **C2** ordered keys | `c2_owner_tokens_range_isolates_one_owner`, `c2_owner_token_key_roundtrip_fixed_width`, `c2_rating_range_isolates_one_course`, `c2_rating_key_roundtrip_fixed_width`, `c2_pointlookup_keys_stay_cbor` | L2 + L1 | Phase 1 (`OwnerTokenKey`, PB-301) / Phase 3 (`RatingKey`, PB-310) | **Yes** (per the shipping spec) |
| **C3** escrow / treasury-drain | `c3_payout_legs_gated_on_transferred`, `c3_forced_transfer_failure_refunds_from_escrow`, `c3_puppet_account_drain_sim`, `c3_payout_leg_failure_is_resumable_no_double_pay` | L1 + **L3** | **Phase 2 (PB-307)** | **Yes — no merge without these green** |
| **C4** no raw_rand on start | `c4_start_session_makes_no_management_call`, `c4_start_session_synchronous_nonce`, (`c4_start_session_latency_free_in_pocketic`) | L1 (+ L3 advisory) | Phase 1 (PB-306) | **Yes** |
| **C5** 2 MiB query cap | `c5_metadata_rejects_over_25_ids`, `c5_light_methods_keep_100_cap`, `c5_25x64kib_reply_under_2mib`, `c5_mint_rejects_oversize_blob` | L2 + **L3** | Phase 1 (PB-301/303) | **Yes** |
| **V1** spoofed hole-2 | `v1_hole2_requires_in_order_live_session`, `v1_self_play_no_owner_credit` | L1 | Phase 1 (PB-306) | **Yes** |
| **V2** spoofed completion | `v2_complete_requires_9_in_order`, `v2_completion_costs_min_pace` | L1 | Phase 1 | **Yes** |
| **V3** replay | `v3_replay_hole_rejected`, `v3_complete_is_terminal` | L1 | Phase 1 | **Yes** |
| **V4** idle-bot loop | `v4_pacing_floor`, `v4_player_daily_cap` | L1 | Phase 1 | **Yes** |
| **V5** multi-account/self-play | `v5_per_course_per_player_cap`, `v5_owner_daily_cap`, `v5_self_play_suppressed` | L1 | Phase 1 | **Yes** |
| **V6** out-of-order/partial | `v6_out_of_order_rejected`, `v6_bad_hole_rejected` | L1 | Phase 1 | **Yes** |
| **V7** stale/cross-round/owner | `v7_owner_resolved_at_hole2`, `v7_credit_targets_current_round`, `v7_expired_session_rejected` | L1 | Phase 1 | **Yes** |
| Anti-cheat cross-cutting | `ac_*` (foreign caller, owner_of failure, cap-no-fail, admin-excluded, day reset, sweep, tier gate) | L1 | Phase 1 (PB-306) | **Yes** |
| Split sums == 100% | `econ_mint_split_sums` (P1, PB-304), `econ_resale_split_sums` + `econ_seller_eq_creator_coalesced` (P2, PB-307) | L1 | Phase 1 / Phase 2 | **Yes** (per phase) |
| No-move-without-pay / escrow funding | `econ_no_transfer_before_escrow`, `econ_no_payout_without_transfer`, `econ_buyer_never_pays_and_loses_token` | L1 (+ L3) | **Phase 2 (PB-307)** | **Yes** |
| Ticket lifetime (never-void / reset-on-win) | `inv_unstake_does_not_void_tickets`, `inv_only_win_resets_all_sources`, `inv_admin_promotion_still_voids`, `inv_credit_into_current_round_only`, `inv_admin_never_credited` | L1 | Phase 1 (lottery companion change) | **Yes** |
| Auth — course_nft | `auth_nft_*` (minter-only, owner-only transfer, admin rotate, anon inspect) | L2 + L3 | Phase 1 (PB-301) | **Yes** |
| Auth — backend play/sale/ratings | `auth_play_*`, `auth_list_delist_owner_only`, `auth_buy_*`, `auth_rate_*`, `auth_admin_remove_rating_admin_only` | L1 | P1 (play) / P2 (sale) / P3 (ratings) | **Yes** (per phase) |

**Phase-gate summary** (echoes overview §6, with this doc's tests as the security spine):

- **Phase 1 (MVP):** all C1, C2(`OwnerTokenKey`), C4, C5 tests green; the full V1–V7 + `ac_*`
  matrix green; `econ_mint_split_sums` green; the **ticket-lifetime `inv_*` suite** green
  (the companion change must land with Phase 1 so staking and course tickets share never-void
  semantics from day one); auth-course_nft + auth-play green.
- **Phase 2:** **C3 suite is the blocker** (`c3_*`, `econ_no_*`, `econ_buyer_never_pays_and_loses_token`)
  + `econ_resale_split_sums` + auth-sale.
- **Phase 3:** C2(`RatingKey`) suite + auth-ratings.

---

## 6. What this doc does **not** cover (owned elsewhere)

- Feature happy-paths / full E2E lifecycle (`create→mint→…→rate`) — [02](02-integration-pocketic-e2e.md).
- Per-method functional unit tests beyond the security/invariant lens — [01](01-backend-unit-tests.md).
- Engine/editor/marketplace UI logic + render smokes and manual QA scripts — [04](04-frontend-and-manual-acceptance.md).
- Deferred/rejected review items O1 (CMC batching) and O2 (`float64` ratings) — out of scope by
  [00 §9](../tasks/00-overview-and-architecture.md); no tests here (O2's *integer* `avg_x10`
  contract is exercised by the ratings functional tests in 01).
