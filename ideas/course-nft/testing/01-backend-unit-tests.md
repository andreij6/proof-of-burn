# Course NFT — Backend Unit Tests (L1 + L2)

> Plan doc **01** of the Course NFT testing suite. Owns the **off-wasm unit
> layer**: L1 (`cargo test -p backend --lib`) for the marketplace controller +
> sagas, and L2 (`cargo test -p course_nft`) for the ICRC-7 ledger crate. Read the
> anchor [`00-testing-overview.md`](00-testing-overview.md) first — this doc obeys
> its pyramid (§2), reuses the repo's native mock seams (§3), and feeds its phased
> gates (§6) and traceability matrix (§8).
>
> Scope boundary: **pure logic + saga state machines via mock seams**, no real
> ledger / NNS / CMC / cross-canister wasm. The real-boundary versions of these
> (ingress guards, real Candid types, cross-canister atomicity, upgrade
> persistence at the wasm level) live in [02](02-integration-pocketic-e2e.md) (L3).
> The **C1–C5 / V1–V7** security tests are *named* here where they are unit-shaped,
> but their authoritative spec is [03](03-security-ic-compliance-matrix.md) — this
> doc cross-references, it does not duplicate the C/V detail.

---

## 0. Conventions these tests follow (mirror the existing `mod tests`)

The backend's `#[cfg(test)] mod tests` (`src/backend/src/lib.rs`, opens ~L13456)
is the template. Every test below assumes:

- **`use super::*;`** at the top of the module, as today.
- **Principals** via the existing `fn p(text: &str) -> Principal` helper and
  `fn anon() -> Principal { Principal::anonymous() }`.
- **Caller** set with `set_mock_caller(p("…"))` (L697) before any `get_caller()`
  path; reset between tests by setting it explicitly (tests must not depend on
  prior state — clear maps in their own arrange step, like
  `clear_early_adopters()` does).
- **Time** is `current_time()` (L222); off-wasm it is fixed/controllable — fixtures
  pin a base `const T0: u64 = 1_700_000_000_000_000_000` (ns) and advance via the
  test time hook (see §1.0 "required seam" — the existing tests already drive
  expiry/clock logic, e.g. the early-adopter settlement clock).
- **Money mocks**: `set_mock_ledger_balance(u64)` (L1901),
  `set_mock_ledger_transfer(Result<u64,String>)` (L1908), `set_mock_cycles` (L3378).
- **NNS/tier mocks**: `MOCK_GOV` + `set_mock_neuron(_for_id)` and
  `install_staking_test_config()` (L16241) for tier-2 derivation; `TEST_MOCK_RAND`
  (L8007) for any randomness; `TEST_MOCK_NNS_VOTE` for vote legs.
- **Async endpoints** (`mint_course_nft`, `buy_course_nft`, `list_course_for_sale`,
  `bid_featured_slot`, `rate_course`) are tested with `#[tokio::test]`, exactly as
  `test_early_adopter_stake_is_permanent_and_validated` (L15496) does.
- **Naming**: `fn test_<feature>_<behaviour>()`; group under a `// ── PB-3xx: <name>`
  banner comment mirroring the existing `// ── PB-090: …` banners.
- **Fixtures**: add small builders next to the existing `sample_commitment` /
  `sample_proposal` (L13465+): `sample_course_listing(...)`, `sample_mint_saga(...)`,
  `sample_course_sale(...)`, `seed_valid_course_data() -> Vec<u8>` (a valid 9-hole
  `CourseDataV1` CBOR blob from PB-303), and `seed_completed_session(player, token)`.

---

## 1. Required new mock seams (add these first — nothing below tests without them)

These are the explicit seams the specs already call for plus the few extra needed
to exercise cross-canister and leg-failure paths off-wasm. Add each as a
`#[cfg(any(test, not(target_arch = "wasm32")))]` thread-local plus a `set_*` setter,
mirroring `TEST_MOCK_RAND` / `set_mock_ledger_transfer`.

### 1.A — backend crate (`src/backend/src/lib.rs`)

| Seam | Shape | Why | Spec hook |
|---|---|---|---|
| `course_nft_owner_of` mock | `TEST_MOCK_OWNER: RefCell<HashMap<u64, Principal>>` + `set_mock_course_owner(token_id, owner)` and `clear_mock_course_owner()`; the async fn returns the mapped owner (or `None`) instead of calling the canister | live owner-at-hole-2 (PB-306), owner-gating list/delist/buy (PB-305/307), self-rating owner check (PB-310) | PB-306 B2 ("`TEST_MOCK_OWNER`"), PB-305 B10, PB-307 A5/A6, PB-310 B7 |
| `course_nft_increment_play` mock | `TEST_MOCK_INCREMENT: RefCell<Vec<u64>>` recording each `(token_id)` bumped (no-op transport) | assert hole-2 bumps NFT counters exactly once; assert it is **not** called on cap-skip / completion | PB-306 A6 / B2 |
| `course_nft.mint` mock | `TEST_MOCK_MINT: RefCell<Result<u64, String>>` + `set_mock_mint_result(...)`; lets a test force `MintCallFailed` and force a fixed returned `token_id` | mint saga leg ordering + `MintCallFailed` resume (PB-304 step 4) | PB-304 B4 step 4 |
| `course_nft.custodial_transfer` mock | `TEST_MOCK_CUSTODIAL: RefCell<Result<(), String>>` + `set_mock_custodial_result(...)`; default `Ok(())`, set `Err("OWNERSHIP_CHANGED")` to drive the C3 refund path | escrow-ordering / refund-from-escrow invariant (PB-307 A6/C3) | PB-307 B7 ("force `custodial_transfer` to fail (mock)") |
| `icrc7_token_metadata.creator` read mock | reuse `TEST_MOCK_OWNER`-style map: `TEST_MOCK_CREATOR: RefCell<HashMap<u64, Principal>>` + `set_mock_course_creator(...)` | royalty-anchor read (PB-307), self-rating creator check (PB-310) — when `COURSE_LISTINGS.creator` is not used | PB-307 A4, PB-310 A3 |
| CMC/transfer-from leg-failure toggles | extend the existing money mocks: `set_mock_ledger_transfer(Err("…"))` already covers ledger legs; add `TEST_MOCK_TRANSFER_FROM: RefCell<Result<u64,String>>` + `TEST_MOCK_CMC_TOPUP: RefCell<Result<u64,String>>` if `settle_burn_split`'s reused path doesn't already expose them | per-leg fail/resume for mint split (PB-304) and buy saga (PB-307) | PB-307 B7 ("add a `TEST_MOCK_*` toggle if a leg needs to simulate failure") |
| XRC rate fallback (already exists) | confirm the off-wasm path uses static fallback rates (per PB-308 B7); add `set_mock_usd_rate(token, rate_e8s)` only if the fallback isn't deterministic enough for strict-exceed tests | featured-slot USD valuation/compare (PB-308) | PB-308 B7 |
| `has_completed_round` reachability | no new seam — drive it by seeding a `Completed` `PlaySession` for `(player, token)` via `seed_completed_session`, so the predicate reads real state | ratings completion gate (PB-310) | PB-310 A2/B7 |

> If `settle_burn_split` is reused verbatim for the mint (PB-304 chose option (b):
> construct a `Commitment` with `proposal_id = MINT_ESCROW_TAG`), its existing
> ledger/CMC mocks already make the split testable; the new toggles above are only
> for legs that the existing mocks don't already cover.

### 1.B — course_nft crate (`src/course_nft/src/lib.rs`) — the L2 mock-caller seam

The crate has **no** test infra yet. Add the minimal mirror of the backend's
caller seam so update guards (`require_minter`, the `icrc7_transfer` owner check)
are testable natively:

```rust
// ===== 10. Tests ===== (per PB-301 B.1 section map)
#[cfg(any(test, not(target_arch = "wasm32")))]
thread_local! { static TEST_CALLER: RefCell<Option<Principal>> = const { RefCell::new(None) }; }

fn caller() -> Principal {
    #[cfg(any(test, not(target_arch = "wasm32")))]
    { if let Some(c) = TEST_CALLER.with(|c| *c.borrow()) { return c; } }
    ic_cdk::caller()
}
#[cfg(any(test, not(target_arch = "wasm32")))]
fn set_mock_caller(c: Principal) { TEST_CALLER.with(|t| *t.borrow_mut() = Some(c)); }
```

Also add a `fn now()` indirection (so `created_at` is deterministic off-wasm,
default to a fixed test value when not on wasm) and a `fn test_reset_state()` that
clears `TOKENS`, `OWNER_TOKENS`, resets `NEXT_TOKEN_ID` to 1, and writes a known
`CONFIG` with `minter = MINTER`, `admin = ADMIN`. Every L2 test calls
`test_reset_state()` then `set_mock_caller(MINTER)` in its arrange step.

Constants for the L2 module: `MINTER`, `ADMIN`, `ALICE`, `BOB` (all via `p("…")`),
distinct.

---

## 2. L2 — `course_nft` crate unit tests (`cargo test -p course_nft`)

Maps to **PB-301**, its acceptance criteria, and its Test plan. Naming
`test_nft_*`. Each test: `test_reset_state(); set_mock_caller(<caller>);` then act.

### 2.1 Mint — happy + reject paths

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_mint_happy_assigns_monotonic_ids` | caller `MINTER`; mint two valid `MintArgs` (name 1–60, blob ≤64 KiB, par 18–45) | first returns `Ok(1)`, second `Ok(2)`; `icrc7_total_supply() == Nat::from(2)`; `NEXT_TOKEN_ID == 3` |
| `test_nft_mint_records_owner_and_metadata` | mint to `ALICE`, creator `ALICE` | `TOKENS[1].owner == ALICE`; `OWNER_TOKENS` contains `OwnerTokenKey{ALICE,1}`; `created_at == now()`; `play_count == 0`; `tickets_distributed == 0` |
| `test_nft_mint_rejects_non_minter` | `set_mock_caller(ALICE)` (not minter) | `mint(..)` → `Err("NOT_MINTER")`; supply unchanged |
| `test_nft_mint_rejects_oversize_blob` | minter; `course_data` of 65_537 bytes | `Err` mentioning size (`DATA_TOO_LARGE`/`BLOB_TOO_LARGE`); supply unchanged |
| `test_nft_mint_rejects_bad_name_len` | minter; name `""` then 61-char name | both `Err`; supply unchanged |
| `test_nft_mint_rejects_bad_par_total` | minter; `par_total = 17` then `46` | both `Err`; supply unchanged |
| `test_nft_mint_rejects_over_supply_cap` | `test_reset_state` with `supply_cap = Some(1)`; mint once Ok, mint again | second `Err` (cap); supply stays 1 |

### 2.2 Custodial vs owner transfer auth

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_custodial_transfer_moves_owner_and_index` | mint to `ALICE`; `set_mock_caller(MINTER)`; `custodial_transfer(1, BOB)` | `Ok`; `icrc7_owner_of([1]) == [Some(BOB)]`; `OWNER_TOKENS` no longer has `{ALICE,1}` and now has `{BOB,1}` |
| `test_nft_custodial_transfer_rejects_non_minter` | mint to `ALICE`; `set_mock_caller(ALICE)`; `custodial_transfer(1, BOB)` | `Err("NOT_MINTER")`; owner still `ALICE` |
| `test_nft_custodial_transfer_rejects_unknown_id` | minter; `custodial_transfer(999, BOB)` | `Err` (unknown id); no index change |
| `test_nft_owner_transfer_owner_succeeds` | mint to `ALICE`; `set_mock_caller(ALICE)`; `icrc7_transfer([{token_id:1, to:BOB...}])` | element `Some(Ok(_))`; `icrc7_owner_of([1]) == [Some(BOB)]`; index rewritten |
| `test_nft_owner_transfer_nonowner_unauthorized` | mint to `ALICE`; `set_mock_caller(BOB)`; transfer token 1 | element `Some(Err(Unauthorized))`; owner unchanged |
| `test_nft_owner_transfer_nonexistent_id` | `set_mock_caller(ALICE)`; transfer token 1 (never minted) | element `Some(Err(NonExistingTokenId))` |
| `test_nft_owner_transfer_preserves_creator_and_counters` | mint to `ALICE` (creator `ALICE`); minter bumps play+tickets; `ALICE` transfers to `BOB` | after transfer, metadata `caldera:creator == ALICE`, `play_count`/`tickets_distributed` unchanged |

### 2.3 `icrc7_*` read methods

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_icrc7_owner_of_reflects_transfers` | mint→custodial_transfer→owner transfer chain | `icrc7_owner_of([1])` tracks each move; unknown id → `[None]` |
| `test_nft_icrc7_balance_of` | mint 2 to `ALICE`, 1 to `BOB` | `icrc7_balance_of([ALICE_acct]) == [Nat::from(2)]`, `[BOB_acct] == [1]` |
| `test_nft_icrc7_tokens_of_pagination` | mint 3 to `ALICE`; call with `prev=None, take=Some(2)` then `prev=Some(2), take=Some(2)` | first `[1,2]`, second `[3]`; ascending |
| `test_nft_icrc7_tokens_global_pagination` | mint 5 across owners | `icrc7_tokens(prev, take)` paginates ascending across all ids |
| `test_nft_icrc7_token_metadata_maps_all_keys` | mint with known fields | returned map has exactly the A.3 keys with correct `Value` variants: `icrc7:name`→`Text`, `caldera:creator`→`Text`, `caldera:created_at`→`Nat`, `caldera:course_data`→`Blob`, `caldera:par_total`→`Nat`, `caldera:play_count`→`Nat`, `caldera:tickets_distributed`→`Nat`, `caldera:mint_fee_e8s`→`Nat` |
| `test_nft_icrc7_token_metadata_course_data_verbatim` | mint with a specific blob | the `Blob` value round-trips byte-identical to the input |
| `test_nft_icrc7_collection_metadata_batch_caps` | — | `icrc7_collection_metadata()` advertises `icrc7:max_query_batch_size = 100` and `course:max_metadata_batch_size = 25` |
| `test_nft_metadata_batch_cap_25` (**C5**, detail in [03](03-security-ic-compliance-matrix.md)) | mint 26 tokens; `icrc7_token_metadata([1..=26])` | `Err`/trap with `BATCH_TOO_LARGE`; a 25-id batch succeeds |
| `test_nft_light_batch_cap_100` (**C5**) | `icrc7_owner_of` with 101 ids | `Err`/trap; 100 ids ok |

### 2.4 Counter monotonicity

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_bump_play_count_monotonic_minter_only` | mint; `set_mock_caller(MINTER)`; `bump_play_count(1, 3)` then `(1, 2)` | returns `3` then `5`; metadata `caldera:play_count == 5`; non-minter caller → `Err("NOT_MINTER")` |
| `test_nft_add_tickets_distributed_monotonic_minter_only` | as above for tickets | returns cumulative; minter-gated; never decrements |

### 2.5 `OwnerTokenKey` range correctness + 38-byte round-trip (**C2**)

> Authoritative C2 spec is [03](03-security-ic-compliance-matrix.md); this is the
> L1/L2 range test it references (PB-301 Test plan, last bullet).

| Test | Setup | Assertion |
|---|---|---|
| `test_owner_token_key_roundtrip_38_bytes` | construct `OwnerTokenKey{owner, token_id}` for several principals incl. a 29-byte one and the anonymous principal | `to_bytes().len() == 38` always; `from_bytes(to_bytes()) == key` |
| `test_owner_token_key_orders_owner_then_id` | build keys for the same owner with `token_id` 1, 255, 256, 257, u64::MAX | `to_bytes()` byte-ordering is strictly ascending by `token_id` (big-endian region) |
| `test_nft_tokens_of_range_no_bleed` (**C2**) | mint **> 256** tokens interleaved across `ALICE` and `BOB` (so the high byte of `token_id` varies) | `icrc7_tokens_of(ALICE)` returns *exactly* `ALICE`'s ids ascending and **none** of `BOB`'s — the test a CBOR-encoded key fails |

### 2.6 `nat` boundary (**C1**)

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_owner_of_out_of_u64_returns_none` (**C1**) | `icrc7_owner_of([Nat::from(u64::MAX as u128 + 1)])` | `[None]`, no trap (the helper `nat_to_u64` returns `None` → id doesn't exist) |
| `test_nft_supply_is_nat_type` (**C1**) | mint 2 | `icrc7_total_supply()` is `candid::Nat` equal to 2; storage stays `u64` |

### 2.7 Upgrade round-trip (state-level, off-wasm)

> Real `--mode upgrade` persistence is the L3 job ([02](02-integration-pocketic-e2e.md));
> at L2 we assert the stable structures + `from_bytes`/`to_bytes` survive a
> simulated reload.

| Test | Setup | Assertion |
|---|---|---|
| `test_nft_storable_roundtrip_token_and_config` | build a `CourseToken` (all fields) and `NftConfig`; `Storable::to_bytes` then `from_bytes` | equal to the original (CBOR via `impl_storable!`); a `CourseToken` byte blob lacking a later `#[serde(default)]` field still decodes |
| `test_nft_next_id_persists_after_reload` | mint 3, simulate reload (re-init `StableCell` over the same memory) | `NEXT_TOKEN_ID` reads 4; `icrc7_owner_of` still resolves the 3 tokens |

---

## 3. L1 — Mint saga (PB-304) — `cargo test -p backend --lib`

Banner `// ── PB-304: Course mint saga`. Async tests via `#[tokio::test]`. All use
the `course_nft.mint` mock (§1.A), the ledger/CMC mocks, and tier mocks for the
Tier-2 gate. Each test arranges: `CONFIG` with `course_nft_canister` set,
`set_mock_caller(USER)`, tier-2 via `install_staking_test_config()` + a following
neuron.

### 3.1 Server-side validation (PB-304 B.2)

| Test | Setup | Assertion |
|---|---|---|
| `test_mint_validate_9_holes_ok` | `validate_course_data_for_mint(seed_valid_course_data())` | `Ok(course)`; `par_total == sum of 9 hole pars` (server-computed, not client) |
| `test_mint_validate_rejects_8_holes` | 8-hole blob | `Err(InvalidCourse("NOT_NINE_HOLES"))` |
| `test_mint_validate_rejects_10_holes` | 10-hole blob | `Err(InvalidCourse("NOT_NINE_HOLES"))` |
| `test_mint_validate_rejects_oversize` | blob > `MAX_COURSE_DATA_BYTES` | `Err(InvalidCourse("DATA_TOO_LARGE"))` |
| `test_mint_validate_rejects_bad_hole` | 9 holes, one missing a cup (PB-303 per-hole fail) | `Err(InvalidCourse(<PB-303 reason>))` |
| `test_mint_par_total_is_server_computed` | valid blob whose embedded "par_total" claim (if any) is wrong | the saga uses the recomputed value, ignoring the client's |

### 3.2 Fee split 50/25/25 (PB-304 B.3/B.4 step 3)

| Test | Setup | Assertion |
|---|---|---|
| `test_mint_fee_split_amounts_50_25_25` | reuse the `settle_burn_split` mocks (`set_mock_ledger_balance(MINT_FEE_E8S + headroom)`, `set_mock_ledger_transfer(Ok(n))`) | treasury leg = 50% of `MINT_FEE_E8S`, backend cycles = 25%, frontend cycles = 25%; the three sum to `MINT_FEE_E8S` (remainder, computed last, goes to the last leg exactly like `settle_burn_split`) |
| `test_mint_fee_split_idempotent_second_run_no_transfers` | run the split once (block indices recorded on the saga's `Commitment`), then re-run | no new `set_mock_ledger_transfer` calls fire; block indices unchanged (mirrors the existing settle idempotency tests) |

### 3.3 Idempotent `MintSaga` resume at each leg boundary (PB-304 B.4, AC 4/5)

| Test | Setup | Assertion |
|---|---|---|
| `test_mint_resume_after_split_skips_charge` | persist a `MintSaga` with all three block fields `Some(_)`, `minted_token_id = None`; re-enter `mint_course_nft` | no fee transfers happen; proceeds to mint (`course_nft.mint` mock called once); ends `Ok(token_id)` |
| `test_mint_resume_after_mint_only_lists` | `MintSaga` with `minted_token_id = Some(7)`, `listed = false`; re-enter | no charge, **no** second `course_nft.mint` call (TEST_MOCK_MINT recorder shows 0), only the auto-list step runs; `COURSE_LISTINGS[7]` created `listed=true` |
| `test_mint_call_failed_then_retry_no_recharge` | first call: `set_mock_mint_result(Err("trap"))` → `Err(MintCallFailed)`; second call: `set_mock_mint_result(Ok(7))` | second succeeds; ledger-transfer mock recorded **no additional** charge between the two; exactly one token minted (`minted_token_id` set once) |
| `test_mint_insufficient_deposit_charges_nothing` | `set_mock_ledger_balance(MINT_FEE_E8S - 1)` | `Err(InsufficientDeposit{needed, found})`; zero ledger transfers; no `MintSaga` left partially charged |
| `test_mint_concurrency_guard_already_minting` | mark the in-flight guard set for `USER`, then call | `Err(AlreadyMinting)`; no escrow touched |

### 3.4 Two-canister ordering + draft cleanup (PB-304 B.4 ordering guarantees)

| Test | Setup | Assertion |
|---|---|---|
| `test_mint_orders_charge_before_mint` | instrument: a charge that fails (`set_mock_ledger_transfer(Err)`) | `course_nft.mint` mock is **never** called (charge precedes mint); course never minted free |
| `test_mint_orders_mint_before_list` | force mint to fail | no `COURSE_LISTINGS` row is created (list never references a missing token) |
| `test_mint_draft_cleared_last_on_success` | seed a draft for `USER` (PB-302 `set_course_draft`); full happy run | after `Ok`, `get_my_course_draft(USER) == None`; `MINT_SAGAS[USER]` removed; `log_dapp_event("course_mint", …)` emitted |
| `test_mint_draft_survives_midsaga_failure` | seed draft; force mint failure | draft still present (cleanup is last); `MINT_SAGAS[USER]` retained for retry |

---

## 4. L1 — Marketplace (PB-305)

Banner `// ── PB-305: Course marketplace`. Uses the `course_nft_owner_of` mock for
owner-gating; otherwise pure in-memory over `COURSE_LISTINGS`.

### 4.1 Difficulty bucket + listing cache writes

| Test | Setup | Assertion |
|---|---|---|
| `test_marketplace_difficulty_bucket_edges` | call `difficulty_bucket(par)` | 27→Easy, 28→Medium, 44→Medium, 45→Hard (PB-305 B9) |
| `test_marketplace_mint_seeds_listing_row` | run a mint (or call the auto-list step directly) for token 1 | `COURSE_LISTINGS[1]` exists: `listed=true`, `price_e8s=0`, cached `owner/creator/par_total/theme/play_count=0/name` populated |
| `test_marketplace_cache_fields_persist` | insert a `CourseListing`, `Storable` round-trip | all `#[serde(default)]` cache fields survive; an old blob missing a new field decodes with defaults (PB-305 B9 upgrade bullet) |

### 4.2 Filters (difficulty / theme / for-sale / mine)

Seed a fixed corpus of listings via `sample_course_listing(...)`: mix of pars
(20/34/48), themes (0..=4), `listed`/`for_sale` flags, owners.

| Test | Filter | Assertion |
|---|---|---|
| `test_marketplace_filter_difficulty` | `DifficultyFilter::Hard` | only par≥45 listings returned; `total` == count of matches pre-pagination |
| `test_marketplace_filter_theme` | `theme=Some(2)` (Space) | only theme==2; `None` returns all |
| `test_marketplace_filter_for_sale` | `ListedFilter::Yes` / `::No` / `::Any` | Yes→`listed && price>0`; No→complement; Any→all |
| `test_marketplace_filter_mine_only` | `mine_only=true`, caller `ALICE` | only listings whose live/cached owner == `ALICE` |
| `test_marketplace_filter_composite` | Hard + Space + for-sale | intersection only |

### 4.3 Server-seeded ordering determinism + featured exclusion (PB-305 A5/B3)

| Test | Setup | Assertion |
|---|---|---|
| `test_marketplace_order_is_ascending_token_id` | seed listings 5,2,9,1 | `courses` returned in ascending `token_id` (the server is deterministic; shuffle is client-side) |
| `test_marketplace_seed_present` | any query | `MarketplacePage.seed` is set (non-trivial hint); the query is pure/no-await/no-`raw_rand` (**C4** — see [03](03-security-ic-compliance-matrix.md)) |
| `test_marketplace_excludes_featured_token` | set `FEATURED_SLOT` to token 3, ensure token 3 is in the pool | `featured_token_id == Some(3)` **and** `3 ∉ courses` (no duplicate) |
| `test_marketplace_featured_dangling_dropped` | `FEATURED_SLOT` token id not in `COURSE_LISTINGS` | `featured_token_id == None` (stale slot dropped per A2/PB-308) |

### 4.4 list / delist owner-gating (PB-305 B4/B5)

| Test | Setup | Assertion |
|---|---|---|
| `test_list_course_for_sale_owner_ok` | `set_mock_course_owner(1, ALICE)`; caller `ALICE` | `Ok`; `COURSE_LISTINGS[1].listed=true`, `price_e8s` set; cached owner refreshed |
| `test_list_course_for_sale_rejects_non_owner` | owner `ALICE`; caller `BOB` | `Err("NOT_OWNER")`; row unchanged |
| `test_list_course_for_sale_rejects_zero_price` | owner caller; `price_e8s=0` | `Err` (use delist instead) |
| `test_list_course_for_sale_rejects_over_cap` | `price_e8s > MAX_LISTING_E8S` | `Err` |
| `test_delist_course_keeps_row` | listed token; owner caller | `Ok`; row retained, `listed=false`, `price_e8s=0` (course still playable/ticket-accruing per PB-305 A6) |
| `test_delist_course_rejects_non_owner` | non-owner caller | `Err("NOT_OWNER")` |
| `test_refresh_course_listing_updates_cached_owner` | listing cached owner `ALICE`; `set_mock_course_owner(1, BOB)`; call `refresh_course_listing(1)` | cached owner becomes `BOB` (lazy reconciliation, PB-305 B6) |

---

## 5. L1 — Play + anti-cheat (PB-306)

Banner `// ── PB-306: Play-to-earn & anti-cheat`. The richest money/anti-cheat
surface — bias to 100% branch coverage (overview §7). Uses `set_mock_course_owner`,
the `course_nft_increment_play` recorder, the time hook, tier mocks, and the
lottery state. Fixtures: a minted+listed course (seed `COURSE_LISTINGS[1]`,
`listed=true`), `T0` base time.

> These rows ARE the **V1–V7** anti-cheat matrix at the unit layer; the matrix's
> authoritative cross-cut is [03](03-security-ic-compliance-matrix.md) (it maps each
> V to its owning test — do not duplicate the threat narrative here).

### 5.1 Session lifecycle (PB-306 A2)

| Test | Setup | Assertion |
|---|---|---|
| `test_session_start_mints_monotonic_id` | `start_play_session(1)` twice | `session_id` 1 then 2; `PLAY_SESSIONS` rows stamped `player=caller, token_id=1, last_hole=0, status=Active, issued_at=now` |
| `test_session_start_requires_minted_listed` | token not in `COURSE_LISTINGS`; then `listed=false` | both → `Err` (unlisted accrues nothing) |
| `test_session_start_anonymous_allowed` | `set_mock_caller(anon())` | `Ok` (anyone can play); player ticket later gated by tier |
| `test_session_start_is_pure_no_await` (**C4**) | — | start path performs no `icrc7_owner_of`/`raw_rand` (nonce derived synchronously); see [03](03-security-ic-compliance-matrix.md) |

### 5.2 In-order / monotonic hole events + dedupe (V6, V3)

| Test | Setup | Assertion |
|---|---|---|
| `test_record_hole_in_order_advances` | record holes 1 then 2 with ≥`MIN_HOLE_INTERVAL_NS` between | both `Ok`; `last_hole` becomes 1 then 2 |
| `test_record_hole_out_of_order_rejected` | after hole 1, record hole 5 | `Err("OUT_OF_ORDER")`; `last_hole` stays 1 |
| `test_record_hole_duplicate_rejected` | record hole 1 twice | second `Err("OUT_OF_ORDER")` (dedupe — no path to credit same `(session,hole)` twice) |
| `test_record_hole_bad_hole_number` | record hole 0 or 10 | `Err` |
| `test_record_hole_foreign_caller` | session owned by `ALICE`; caller `BOB` | `Err("NOT_YOUR_SESSION")` |
| `test_record_hole_completed_session` | complete a round, then record | `Err` (session terminal) |

### 5.3 Pacing floor (V4)

| Test | Setup | Assertion |
|---|---|---|
| `test_record_hole_too_fast_rejected` | record hole 2 `< MIN_HOLE_INTERVAL_NS` after hole 1 | `Err("TOO_FAST")`; `last_hole` unchanged |
| `test_record_hole_pacing_first_hole_from_issued_at` | record hole 1 too soon after `issued_at` | `Err("TOO_FAST")`; at exactly the interval → `Ok` |

### 5.4 Owner credit at hole 2 via the `course_nft_owner_of` seam (V1, V7)

| Test | Setup | Assertion |
|---|---|---|
| `test_hole2_credits_live_owner` | `set_mock_course_owner(1, ALICE)`; reach hole 2 | `RecordHoleResult.owner_credited == true`, `owner == Some(ALICE)`; `LOTTERY_TICKETS[ALICE].count` +1; `course_nft_increment_play` recorder has token 1 exactly once |
| `test_hole2_uses_owner_at_credit_moment_not_start` (**V7**) | owner `ALICE` at start; change `set_mock_course_owner(1, BOB)` before hole 2 | `BOB` credited, not `ALICE` (live resolution, not snapshot) |
| `test_hole2_owner_lookup_failure_advances_no_credit` | mock `course_nft_owner_of` to return error/`None` | hole still advances to 2; `owner_credited == false`; no trap; no retro credit |
| `test_hole2_increment_only_on_successful_credit` | cap already hit (see 5.6) so credit skipped | `course_nft_increment_play` recorder is **empty** (counters bumped only on a real credit) |

### 5.5 Completion player ticket + Tier gate (V2, A3)

| Test | Setup | Assertion |
|---|---|---|
| `test_complete_round_requires_all_9` | `last_hole=8`; `complete_round` | `Err("INCOMPLETE_ROUND")` |
| `test_complete_round_tier2_credits_player` | tier-2 player (USER_NEURONS following set via `install_staking_test_config`) completes | `player_credited == true`; `LOTTERY_TICKETS[player].count` +1 |
| `test_complete_round_anon_no_player_ticket` | anonymous player completes | `Ok{player_credited:false, reason:Some("ANON")}`; no ticket |
| `test_complete_round_tier1_no_player_ticket` | authenticated-not-following | `player_credited:false, reason:"TIER_TOO_LOW"` |
| `test_complete_round_terminal_idempotent` (**V3**) | complete, then complete again | second → `Err("ALREADY_COMPLETED")`; only one ticket credited |

### 5.6 Per-day + per-(player,course,day) caps (V4, V5)

| Test | Setup | Assertion |
|---|---|---|
| `test_owner_cap_per_player_course_day` | same player triggers 5 hole-2 credits on course 1; 6th attempt | 6th: `owner_credited:false`; `COURSE_PAIR_CAPS[(player,1,day)] == 5`; hole still advances |
| `test_owner_cap_different_player_still_credits` | after one player hits the per-(player,course) cap, a **different** player reaches hole 2 | that player's credit fires (cap is per-player-course) |
| `test_owner_cap_per_owner_day` | drive owner credits until `MAX_OWNER_TICKETS_PER_DAY (200)`; the 201st | 201st skipped; `TicketCapEntry.owner_tickets == 200` |
| `test_player_cap_per_day` | tier-2 player completes 20 rounds; 21st completion | 21st `player_credited:false, reason:"DAILY_CAP"`; `player_tickets == 20` |
| `test_caps_reset_next_utc_day` | hit a cap, advance time past UTC day boundary | new `(principal, day)` key → counter reads 0; credit resumes |
| `test_selfplay_suppresses_owner_credit` (**V5**) | player == live owner | no owner credit at hole 2; but a tier-2 self-player still earns the **completion** player ticket (until player cap) |
| `test_admin_recipient_credit_skipped` | owner (or player) is an admin principal | credit silently skipped (admin-exclusion); the play call still `Ok` |

### 5.7 Ticket crediting into the current round (PB-306 A6)

| Test | Setup | Assertion |
|---|---|---|
| `test_credit_increments_lottery_total` | credit owner/player | `lottery_state().total_tickets` +1 alongside `LOTTERY_TICKETS[recipient].count` (mirror `dev_grant_lottery_tickets`) |
| `test_credit_resets_stale_round_entry` | recipient has a `TicketEntry` with an older `round` | entry reset to `count=0` for the current round before incrementing (keeps `last_claim_day`) |
| `test_credit_arms_next_draw_when_zero` | `lottery_state().next_draw_at == 0` | first credit sets `next_draw_at = next_draw_after(now)` |
| `test_credit_always_current_round` | credit, advance the round, credit again | second credit lands in the new round, not a snapshot |

### 5.8 TTL expiry + sweep (V7, A4)

| Test | Setup | Assertion |
|---|---|---|
| `test_session_expired_rejected_all_endpoints` | advance time past `issued_at + SESSION_TTL_NS` | `record_hole_event` / `complete_round` → `Err("SESSION_EXPIRED")` |
| `test_sweep_removes_expired_and_completed` | seed one past-TTL Active, one Completed, one in-TTL Active; run `sweep_play_sessions()` | first two removed, third survives |
| `test_sweep_respects_batch_cap` | seed `SESSION_SWEEP_BATCH + 10` expired sessions | at most `SESSION_SWEEP_BATCH` removed per pass |

### 5.9 Lottery companion change (the never-void rule) — **regression, owned by 03**

| Test | Owner |
|---|---|
| `test_unstake_does_not_void_tickets` (companion to PB-306 A6) | **named here, spec'd in [03](03-security-ic-compliance-matrix.md)** — assert the `unstake` path no longer calls `void_current_round_tickets`; previously-earned tickets (any source) ride until a win; admin-exclusion retained; reset happens only on the round rollover at a draw |

---

## 6. L1 — Secondary market (PB-307)

Banner `// ── PB-307: Secondary market & royalties`. `#[tokio::test]`. Uses
`course_nft_owner_of`, `course_nft.custodial_transfer` mock, `creator` mock, and the
ledger/CMC leg mocks. Fixture: a for-sale `CourseListing` with a bound `price_e8s`,
a `CourseSale` builder.

### 6.1 Split math (incl. remainder + seller==creator coalescing)

| Test | Setup | Assertion |
|---|---|---|
| `test_buy_split_sums_to_price` | several `price_e8s` incl. odd values (e.g. 100_000_003) | `seller(75%) + royalty(10%) + backend(5%) + frontend(5%) + treasury(remainder) == price_e8s`; treasury computed last absorbs the remainder (mirrors `settle_burn_split`) |
| `test_buy_split_bps_exact` | round price (e.g. 1 ICP) | seller=7500bps, royalty=1000, backend=500, frontend=500, treasury=500 of price |
| `test_buy_seller_equals_creator_coalesces` | `seller == creator` | a single 85% transfer fires (one ledger fee saved); journal still records both `seller_block` and `royalty_block` pointing at the same block index (PB-307 A4) |

### 6.2 Escrow-ordering invariant (no payout leg before transfer) — **C3**

| Test | Setup | Assertion |
|---|---|---|
| `test_buy_no_payout_before_transfer` (**C3**) | step through `run_buy_saga` with `transferred=false` | **no** payout block (`seller_block`/`royalty_block`/`treasury_block`/cmc blocks) is ever set while `transferred == false`; `pull_block` may be set (escrow funded first) |
| `test_buy_pull_before_transfer` | run order | `pull_block` set (step 1) before `transferred=true` (step 2) before any payout block (step 3) |

### 6.3 Per-leg idempotent resume

| Test | Setup | Assertion |
|---|---|---|
| `test_buy_resume_each_leg_once` | run saga; inject failure at each leg boundary (seller / royalty / backend-cmc / frontend-cmc / treasury) via the leg-failure toggle; re-run | each block index set exactly once across runs; totals correct; `pull_block` never repeated |
| `test_buy_resume_between_pull_and_transfer` | fail after pull, before transfer; re-run | escrow holds funds; retry completes transfer+payout (or refunds if listing gone) — no double pull |

### 6.4 Refund-from-escrow on failed transfer — **C3**

| Test | Setup | Assertion |
|---|---|---|
| `test_buy_transfer_fail_refunds_from_escrow` (**C3**) | `set_mock_custodial_result(Err("OWNERSHIP_CHANGED"))` | buyer refunded full `price_e8s` from the **escrow subaccount**; `refund_block` set once; treasury balance unchanged except the single refund ledger fee (treasury never fronts the price); escrow nets to ~0; call returns `OWNERSHIP_CHANGED` |

### 6.5 Guards reject before pull

| Test | Setup | Assertion |
|---|---|---|
| `test_buy_rejects_not_for_sale` | listing `for_sale=false` | `Err("NOT_FOR_SALE")`; **no** `pull_block`, no transfer |
| `test_buy_rejects_buyer_is_seller` | live owner == buyer | `Err("CANNOT_BUY_OWN_COURSE")`; no funds moved |
| `test_buy_rejects_price_changed` | journal price ≠ live listing price | `Err("PRICE_CHANGED")`; no pull |
| `test_buy_sale_in_progress` | `BUY_LOCKS` already holds token | `Err("SALE_IN_PROGRESS")` |
| `test_list_for_sale_price_bounds` | price below `MIN_SALE_PRICE_E8S` / above `MAX_SALE_PRICE_E8S` | `Err("BAD_PRICE")` |
| `test_list_for_sale_non_owner` | non-owner | `Err("NOT_OWNER")` before any write |

---

## 7. L1 — Featured slot (PB-308)

Banner `// ── PB-308: Featured slot auction`. `#[tokio::test]`. Uses the XRC
fallback rates (off-wasm) or `set_mock_usd_rate`, the `transfer_from` mock, and a
seeded listed `COURSE_LISTINGS` row.

| Test | Setup | Assertion |
|---|---|---|
| `test_featured_usd_valuation_by_decimals` | value 0.001 ckBTC (8 dec) and 50 ckUSDC (6 dec) | `token_amount_usd_e8s_live` scales correctly per token decimals; the ckBTC value > the ckUSDC value (cross-token compare on equal footing) |
| `test_featured_strict_exceed_to_win` | set slot at usd X; bid valuing exactly X | `Err("BID_TOO_LOW:<X>")` (equal does **not** win); bid valuing X+1 wins |
| `test_featured_rejects_icp` | `token = ExplorerToken::ICP` | `Err("UNSUPPORTED_TOKEN")` |
| `test_featured_rejects_zero_amount` | amount 0 | `Err("BAD_AMOUNT")` |
| `test_featured_rejects_unlisted` | unknown / `listed=false` token | `Err("NOT_LISTABLE")` |
| `test_featured_single_leg_payment_to_treasury` | winning bid | exactly one `icrc2_transfer_from(bidder → TREASURY_SUBACCOUNT)` of `amount - fee`; **no** split/cycles/royalty legs (single-leg, 100% house) |
| `test_featured_collect_before_set` | force the transfer to fail | slot **unchanged** (collect funds first, then `set`); bidder lost nothing |
| `test_featured_overwrite_on_higher_bid` | win, then a strictly higher USD bid | slot reflects the new winner; displaced holder gets **no** refund (non-refundable) |
| `test_featured_retained_on_delist` | feature token 1, then delist it | `FEATURED_SLOT` still set to token 1 (retained, not vacated) — only `admin_clear_featured_slot` or a dangling id clears it |
| `test_featured_admin_clear` | `require_admin` caller | slot set to `None`; non-admin → guard error |
| `test_featured_get_drops_dangling` | slot token id not in listings | `get_featured_slot()` returns `None` |

---

## 8. L1 — Ratings (PB-310)

Banner `// ── PB-310: Ratings & reviews`. `#[tokio::test]` for `rate_course`
(awaits owner lookup). Uses `course_nft_owner_of`/`creator` mocks and a seeded
completed session (so `has_completed_round` is real state).

### 8.1 Bounds, gates, self-rating

| Test | Setup | Assertion |
|---|---|---|
| `test_rate_star_bounds` | stars 0 and 6 | both `Err("BAD_STARS")`; 1 and 5 ok |
| `test_rate_text_trim_and_length` | 281-char text → `Err("TEXT_TOO_LONG")`; whitespace-only → stored `None`; normal → `Some(trimmed)` | as stated |
| `test_rate_requires_completion` | rater has **no** completed session for the token | `Err("MUST_COMPLETE_ROUND")`; with a seeded completed session → passes the gate |
| `test_rate_requires_tier2` | anonymous / tier-1 rater | rejected (Tier 2+ gate, mirrors PB-306 player gate) |
| `test_rate_reject_creator` | rater == cached/metadata `creator` | `Err("CANNOT_RATE_OWN_COURSE")` |
| `test_rate_reject_owner` | rater == live owner (via `course_nft_owner_of`) | `Err("CANNOT_RATE_OWN_COURSE")` |
| `test_rate_no_course` | unknown token | `Err("NO_COURSE")` |

### 8.2 Upsert aggregate math

| Test | Setup | Assertion |
|---|---|---|
| `test_rate_new_updates_aggregate` | first rating 4★ | `COURSE_RATINGS` has one row; listing `rating_sum=4`, `rating_count=1` |
| `test_rate_edit_in_place` | rate 4★ then 2★ (same rater) | still one row; `rating_sum += new-old` → `sum=2`, `count=1` (no duplicate) |
| `test_rate_multiple_raters_mean` | three completers rate 5,3,1 | `rating_sum=9`, `rating_count=3`; `avg_x10 == 30` |
| `test_admin_remove_rating_decrements` | remove one of the above | row gone; `sum -= old`, `count -= 1`; recomputed mean matches |
| `test_rating_summary_my_stars` | `get_course_rating_summary` as a prior rater | `my_stars == Some(<their stars>)`; non-rater → `None` |
| `test_list_course_reviews_limit_cap` | 60 reviews on one course; `list_course_reviews(t, 0, 999)` | returns ≤ 50 (limit cap), most-recent-first |

### 8.3 `RatingKey` range correctness + round-trip — **C2**

> Authoritative C2 detail in [03](03-security-ic-compliance-matrix.md); this is the
> unit-level range test (PB-310 B7 last bullet).

| Test | Setup | Assertion |
|---|---|---|
| `test_rating_key_roundtrip_38_bytes` | build `RatingKey{token_id, rater}` incl. a 29-byte principal | `to_bytes().len() == 38`; `from_bytes(to_bytes()) == key` |
| `test_rating_key_orders_token_id_first` | keys for token 255/256/257 with raters whose principals would sort *before* a lower token under CBOR | byte order sorts by `token_id` big-endian first |
| `test_list_reviews_no_bleed_across_courses` (**C2**) | seed ratings for ≥2 courses whose `token_id`s differ in the high byte, interleaved raters | `list_course_reviews(token_id)` returns *exactly* that course's rows, never an adjacent course's — the test a CBOR key fails |

---

## 9. C1–C5 regression cross-reference (defer detail to [03](03-security-ic-compliance-matrix.md))

These tests live physically in this doc's L1/L2 files but their **threat narrative
and acceptance bar** are owned by [03-security-ic-compliance-matrix.md](03-security-ic-compliance-matrix.md).
Listed here only so the file knows to host them:

| Item | Unit test(s) here | Owner |
|---|---|---|
| **C1** `nat` vs `nat64` | §2.6 `test_nft_owner_of_out_of_u64_returns_none`, `test_nft_supply_is_nat_type` | 03 (+ 02 real Candid) |
| **C2** ordered composite keys | §2.5 `test_nft_tokens_of_range_no_bleed` + key round-trip; §8.3 `test_list_reviews_no_bleed_across_courses` + round-trip | 03 |
| **C3** escrow / treasury-drain | §6.2 `test_buy_no_payout_before_transfer`, §6.4 `test_buy_transfer_fail_refunds_from_escrow` (**blocking — Phase 2**) | 03 (+ 02 E2E) |
| **C4** no `raw_rand` on game start / browse | §5.1 `test_session_start_is_pure_no_await`; §4.3 `test_marketplace_seed_present` | 03 |
| **C5** query 2 MiB limit | §2.3 `test_nft_metadata_batch_cap_25`, `test_nft_light_batch_cap_100` | 03 |
| **V1–V7** anti-cheat | all of §5.2–§5.8 | 03 (matrix) |
| Lottery companion (never-void) | §5.9 `test_unstake_does_not_void_tickets` | 03 (invariant) |

---

## 10. How to run (the §6 per-PR gate)

The two unit layers this doc owns are the first two lines of the anchor's per-PR
gate ([00 §6](00-testing-overview.md)):

```
cargo test -p backend --lib       # L1 (§§3–8)
cargo test -p course_nft          # L2 (§2)
```

(The third per-PR line, `cd src/frontend && npx tsc -b && npx vitest run`, is
[04](04-frontend-and-manual-acceptance.md)'s.) The wasm-needing L3 lines run in the
pre-merge/nightly gate and are owned by [02](02-integration-pocketic-e2e.md).
Per the `run-tests` skill: backend unit tests need no wasm or PocketIC binary, so
both commands above run cleanly for any contributor.

---

## 11. Per-PB checklist (definition of done for the unit layer)

- [ ] **PB-301** (L2): §2.1–§2.7 all green; `course_nft` mock-caller + `now()` +
      `test_reset_state` seams added (§1.B); C1 (§2.6) + C2 (§2.5) + C5 (§2.3) pass.
- [ ] **PB-304** (L1): §3.1–§3.4 green; `course_nft.mint` mock + split leg mocks
      added (§1.A); AC 1–6 each covered by a named test; idempotent resume at every
      leg boundary proven.
- [ ] **PB-305** (L1): §4.1–§4.4 green; `course_nft_owner_of` mock added; difficulty
      edges, filters, featured exclusion, owner-gating, upgrade-default round-trip.
- [ ] **PB-306** (L1): §5.1–§5.8 green at **100% branch coverage** for credit/cap
      paths; `TEST_MOCK_OWNER` + increment recorder added; every V1–V7 has its named
      test; C4 start-is-pure test green. §5.9 companion test named (owned by 03).
- [ ] **PB-307** (L1, **Phase 2 — C3 blocking**): §6.1–§6.5 green; `custodial_transfer`
      mock + leg-failure toggle added; **no merge** without §6.2 + §6.4 (C3 escrow
      ordering + refund-from-escrow) green.
- [ ] **PB-308** (L1, Phase 3): §7 green; USD valuation across decimals,
      strict-exceed, single-leg payment, slot-retained-on-delist.
- [ ] **PB-310** (L1, Phase 3): §8 green; completion gate uses real seeded sessions;
      self-rating (creator+owner) rejected; aggregate math across edit+remove; C2
      `RatingKey` range + round-trip (§8.3).
- [ ] **Seams** (§1): every seam in §1.A/§1.B added behind
      `#[cfg(any(test, not(target_arch = "wasm32")))]`, with a `set_*`/`clear_*`
      setter, and reset in each test's arrange step.
- [ ] Both per-PR unit commands (§10) green locally before opening the PR.
```
