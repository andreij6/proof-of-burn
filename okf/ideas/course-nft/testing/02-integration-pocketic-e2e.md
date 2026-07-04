---
type: idea
title: "Course NFT — L3 Integration (PocketIC) & End-to-End Tests"
tags: [ideas, course-nft]
timestamp: 2026-06-13T22:37:20-04:00
---

# Course NFT — L3 Integration (PocketIC) & End-to-End Tests

> **Layer L3** of the test pyramid in [`00-testing-overview.md`](00-testing-overview.md)
> (read the anchor first — this doc owns the "shared harness work" called out in §1,
> the §5 end-to-end scenario as a runnable test, and the cross-canister/upgrade
> coverage the unit docs can't reach). Architecture: the **two-canister** topology
> (backend marketplace controller + `course_nft` ICRC-7 ledger) from
> [`tasks/00-overview-and-architecture.md`](../tasks/00-overview-and-architecture.md) §3.
>
> **Scope boundary (no duplication):**
> - Pure logic, saga state machines via native mock seams, split math, anti-cheat
>   rules off-wasm → **[01-backend-unit-tests.md](01-backend-unit-tests.md)** (L1/L2).
> - The C1–C5 / V1–V7 regression *matrix* (one named test per item, ownership of the
>   detailed assertions) → **[03-security-ic-compliance-matrix.md](03-security-ic-compliance-matrix.md)**.
> - This doc owns the L3 tests those two reference for their *integration* leg: where
>   C1/C2/C3 must be proven against **real wasm at the canister boundary**, and the
>   full lifecycle E2E that no single spec owns.
>
> Everything here extends the existing PocketIC harness
> `src/backend/tests/integration.rs` (PB-112). **Reuse its conventions verbatim** —
> do not reinvent wasm-locate, skip-if-absent, or ledger-install.

---

## 1. What we're building on (existing PB-112 patterns — cite, don't reinvent)

`src/backend/tests/integration.rs` (`pocket-ic = "9"`, a `[dev-dependencies]` of
`src/backend/Cargo.toml`) already gives us, and the new file **must reuse**:

| Pattern | Where in `integration.rs` | How we extend it |
|---|---|---|
| **Wasm locate** — probe `../../target/...release/<name>.wasm` then `target/...` | `wasm_path()` (lines 74–81) | Generalize to `wasm_path(name)`; call for both `backend` and `course_nft`. |
| **Skip-if-absent, stay green** — `Some(p) => …, None => { eprintln!("SKIP: …"); return None }` so `cargo test` passes for contributors who didn't build the wasm | `setup()` (84–107), `setup_saga()` (463–485) | Identical guard for `course_nft.wasm`, the CMC stub wasm, and each ck-token ledger; **every test starts `let Some(env) = setup_course_env() else { return };`**. |
| **PocketIC server discovery** — honor `POCKET_IC_BIN`, else probe `~/.cache/pocket-ic` and `~/.cache/dfinity/versions/0.29.2/pocket-ic`, else SKIP | lines 94–107 / 472–485 | Lift verbatim into one helper `ensure_pocket_ic_bin() -> bool`. |
| **ICRC ledger install** — `LedgerInitArgs` / `LedgerArg::Init`, `feature_flags.icrc2 = true`, `minting_account`, `initial_balances`, `transfer_fee` | lines 273–513 | Reuse the *same* structs to install **5** ledgers (ICP + 4 ck-tokens) with the real symbols/decimals/fees from `icp.yaml`. |
| **`create_canister`/`add_cycles`/`install_canister`** flow; `update_call`/`query_call`; `candid::{encode_one,encode_args,decode_one}` | throughout | Same call discipline. After every inter-canister update, `for _ in 0..5 { pic.tick(); }` to flush messages (cf. `trigger_settlement` line 638). |
| **Mint/seed ICP via the minting account** | `SagaEnv::mint` / `mint_sub` (424–460) | Reuse; add a generic `mint_token(ledger, minter, to, amount)` so we can fund ck-token balances for buy/featured flows. |
| **Treasury float** — the treasury fronts ledger fees under zero-fee commits | `TREASURY_FLOAT_E8S` + `env.mint_sub(backend, vec![1u8;32], …)` (534) | Seed the same ICP treasury float **and** a per-token treasury float for each ck-token (the resale/featured legs also front per-leg fees). |
| **Subaccount helpers** — `derive`/principal→subaccount; `TREASURY_SUBACCOUNT = vec![1u8;32]` | `principal_to_subaccount` (748–754), treasury_sub (727) | Reuse to assert escrow + CMC-share balances. |
| **Time control** — `pic.advance_time(Duration)`, `pic.get_time()`, `pic.tick()` | `trigger_settlement` (612–641) | Reuse for session-TTL sweep, featured-slot ordering, lottery-round reset. |
| **Admin-gated test drivers** — `admin_set_proposal_deadline`, `admin_trigger_sweep` as the owner principal `OWNER_TEXT` | 36, 612–641 | Reuse the owner principal; new admin setters (`admin_set_course_nft_canister`, `admin_set_token_ledger`) are driven the same way. |

> **Why a new file, not edits to `integration.rs`:** the Course NFT topology installs
> ≥ 6 canisters (backend, course_nft, CMC stub, ICP + 4 ck ledgers) and a much larger
> Candid mirror. Keeping it in **`src/backend/tests/course_nft_integration.rs`** isolates
> it (its own `cargo test -p backend --test course_nft_integration` target, per anchor §6)
> and lets the small shared helpers (wasm-locate, bin-probe, ledger-install) be copied or
> lifted into a `mod common;` without disturbing the proven PB-112 suite.

---

## 2. Build step & how to run (gates the nightly/pre-merge phase per anchor §6)

The new tests need **two** Rust wasms. `course_nft` is a new crate (PB-301); the
workspace root `Cargo.toml` currently has only `src/backend` as a member — PB-301
adds `src/course_nft`. Until that crate exists the build for `-p course_nft` fails and
**the tests SKIP** (the file's `setup_course_env()` returns `None` with a message), so
this suite can be merged before PB-301 lands without breaking `cargo test`.

```bash
# 1. build both canister wasms (release, wasm32)
cargo build --target wasm32-unknown-unknown --release -p backend -p course_nft

# 2. (optional) build the CMC stub wasm — see §4. If absent, top-up legs SKIP.
cargo build --target wasm32-unknown-unknown --release -p cmc_stub

# 3. run the suite (needs a PocketIC server binary)
POCKET_IC_BIN=~/.cache/dfinity/versions/0.29.2/pocket-ic \
  cargo test -p backend --test course_nft_integration
```

- **Per-PR gate (anchor §6):** does *not* include this file — it's the unit gate
  (`cargo test -p backend --lib`, `cargo test -p course_nft`, frontend vitest).
- **Pre-merge / nightly gate (anchor §6):** runs `--test integration` **and**
  `--test course_nft_integration` after the two-wasm build.
- **Phase gating (anchor §6 exit criteria), per test:** each test below is tagged
  `[P1]`, `[P2]`, or `[P3]`. **P2's C3 escrow tests are blocking** — no merge of PB-307
  without `buy_refund_from_escrow_treasury_untouched` and the payout-resume test green.

---

## 3. The two-canister harness — `CourseEnv` + `setup_course_env()`

Mirror `SagaEnv` (integration.rs 416–536) but install the full topology and wire the
allowlist. One struct holds every principal a test needs.

```rust
struct CourseEnv {
    pic: PocketIc,
    backend: Principal,
    course_nft: Principal,
    cmc: Principal,                 // stubbed CMC (§4)
    icp: Principal,                 // ICP ledger
    ck: BTreeMap<CkToken, Principal>, // ckBTC/ckETH/ckUSDC/ckUSDT ledgers
    minter: Principal,              // ledgers' minting account (mints test balances)
    owner: Principal,               // OWNER_TEXT — backend admin + first creator (dev1)
    // convenience players
    dev2: Principal,
}
```

### 3.1 Install order (each step SKIPs the whole suite if its wasm is missing)

```rust
fn setup_course_env() -> Option<CourseEnv> {
    let backend_wasm   = wasm_path("backend")?;          // SKIP-if-absent (reuse PB-112)
    let course_nft_wasm = match wasm_path("course_nft") {
        Some(w) => w,
        None => { eprintln!("SKIP: course_nft.wasm not built — \
            cargo build --target wasm32-unknown-unknown --release -p course_nft"); return None; }
    };
    let lwasm = ledger_wasm()?;                          // SKIP-if-absent (reuse PB-112)
    if !ensure_pocket_ic_bin() { return None; }          // SKIP-if-no-server (reuse PB-112)

    let pic = PocketIc::new();
    let owner  = Principal::from_text(OWNER_TEXT).unwrap();
    let minter = Principal::from_slice(&[1]);
    let dev2   = Principal::from_slice(&[2; 16]);

    // (a) CMC stub at the well-known id rkp4c-7iaaa-aaaaa-aaaca-cai (§4) — so the
    //     backend's hard-coded CMC principal resolves. Default mode = NotifyOk.
    let cmc = install_cmc_stub(&pic);                    // None => top-up legs SKIP (§4)

    // (b) ICP ledger — identical to setup_saga(), funding owner + dev2 + minter.
    let icp = install_ledger(&pic, &lwasm, "ICP", 8, 10_000, &[(owner, 1e14), (dev2, 1e14)]);

    // (c) the 4 ck-token ledgers, real symbol/decimals/fee from icp.yaml lines 34–67.
    let mut ck = BTreeMap::new();
    for (t, sym, dec, fee, bal) in CK_LEDGER_SPECS {     // §3.3 table
        ck.insert(t, install_ledger(&pic, &lwasm, sym, dec, fee, &[(owner, bal), (dev2, bal)]));
    }

    // (d) course_nft, minter = a PLACEHOLDER for now (backend id not yet known).
    let course_nft = pic.create_canister();
    pic.add_cycles(course_nft, 4_000_000_000_000);
    pic.install_canister(course_nft, course_nft_wasm,
        encode_one(NftInitArgs { minter: owner, admin: owner, /* placeholder */
            symbol: Some("CALCRS".into()), name: Some("Caldera Mini-Golf Courses".into()),
            supply_cap: None }).unwrap(), None);

    // (e) backend, pointed at the ICP ledger (cf. setup_saga line 516+).
    let backend = pic.create_canister();
    pic.add_cycles(backend, 50_000_000_000_000);         // above the 5T topup floor (PB-112 note)
    pic.install_canister(backend, std::fs::read(&backend_wasm).unwrap(),
        encode_one(InitPayload { owner, primary_neuron_id: 4821667,
            default_threshold_e8s: 10_000_000_000, ai_price_e8s: 5_000_000,
            ledger_canister_id: Some(icp) }).unwrap(), None);

    // (f) WIRE THE ALLOWLIST (the cross-canister trust edge, PB-301 A.2 / PB-304 B.1):
    //   1. course_nft.set_minter(backend)  — admin(owner)-gated; now ONLY the backend
    //      may mint / custodial_transfer.
    call_ok(&pic, course_nft, owner, "set_minter", encode_one(backend).unwrap());
    //   2. backend.admin_set_course_nft_canister(course_nft) — so mint/buy can reach it.
    call_ok(&pic, backend, owner, "admin_set_course_nft_canister", encode_one(course_nft).unwrap());
    //   3. backend.admin_set_token_ledger(<CkX>, ck_id) for each ck token (reuse the
    //      existing Dapp Explorer setter, icp.yaml line 32 comment).
    for (t, id) in &ck { call_ok(&pic, backend, owner, "admin_set_token_ledger",
        encode_args((ck_token_variant(*t), *id)).unwrap()); }
    //   4. enable the marketplace feature flag (PB-305 reuses `arcade`; tri-state Admin-on
    //      is enough because owner == admin). admin_set_feature_flag("arcade", On).
    call_ok(&pic, backend, owner, "admin_set_feature_flag",
        encode_args(("arcade".to_string(), feature_on())).unwrap());

    // (g) treasury floats: ICP + each ck-token (the resale/featured legs front per-leg fees).
    mint_sub(&pic, icp, minter, backend, TREASURY_SUBACCOUNT.to_vec(), TREASURY_FLOAT_E8S);
    for (_, id) in &ck { mint_sub(&pic, *id, minter, backend, TREASURY_SUBACCOUNT.to_vec(), CK_TREASURY_FLOAT); }

    Some(CourseEnv { pic, backend, course_nft, cmc, icp, ck, minter, owner, dev2 })
}
```

Notes:
- **The allowlist edge (f.1/f.2) is the security-critical wiring** — every minter-guard
  test in §6 depends on it being set, and the negative tests (§6.4) confirm a *non*-backend
  caller is rejected even after wiring.
- **`set_minter`/`admin_set_course_nft_canister`/`admin_set_token_ledger`** are the
  setters PB-301 B.5 / PB-304 B.1 / Explorer already define; if a setter name differs
  at implementation time, fix it in **one** helper here.

### 3.2 Candid mirror (`#[derive(CandidType, Deserialize)]` structs in the test file)

Mirror only what the tests decode, exactly as PB-112 mirrors `Config`/`Commitment`/etc.
Required new mirrors (shapes from the specs cited):

- `NftInitArgs`, `MintArgs` (PB-301 B.4/B.5), `Account { owner, subaccount: Option<Vec<u8>> }`,
  ICRC-7 `Value` variant (PB-301 B.6: `Blob|Text|Nat|Int|Array|Map`).
- `MintError`/`MintResult` (PB-304 B.7), `MarketplaceFilter`/`MarketplacePage`/`CourseCard`
  (PB-305 B.2/B.3), `StartSessionResult`/`RecordHoleResult`/`CompleteRoundResult` (PB-306 A.2),
  `FeaturedSlot` (PB-308 B.2), `CkToken`/`ExplorerToken` variant.
- **`icrc7_owner_of` decodes to `Vec<Option<Account>>`; ids are sent as `candid::Nat`**
  (PB-301 C1 — see §6.4). Keep a `nat(u64) -> candid::Nat` helper.

### 3.3 ck-token ledger specs (real params from `icp.yaml` lines 34–67)

| `CkToken` | symbol | decimals | transfer_fee | initial test balance |
|---|---|---|---|---|
| `CkBTC`  | `ckBTC`  | 8  | `10`               | `10_000_000_000` |
| `CkETH`  | `ckETH`  | 18 | `2_000_000_000_000` | `2e18` |
| `CkUSDC` | `ckUSDC` | 6  | `10_000`           | `100_000_000_000` |
| `CkUSDT` | `ckUSDT` | 6  | `10_000`           | `100_000_000_000` |

Install each with `LedgerArg::Init` (reuse `LedgerInitArgs` from integration.rs 273–513),
`feature_flags.icrc2 = true` (buy + featured flows use `icrc2_approve`/`transfer_from`).

---

## 4. The stubbed CMC (deterministic Ok/Err for cycle-top-up legs)

The mint 50/**25/25** split and the resale **5%+5%** cycle legs each end with a CMC
`notify_top_up`. In PB-112 there is *no* CMC canister, so `notify_top_up` always rejects
→ the burn lands in `FailedBurn` and only the *idempotency* of failure is testable
(integration.rs 232–237, 709–775). Course NFT needs **both** the success path
(happy-path E2E must reach `Listed`/sale `complete`) and deterministic failure injection.

**Decision: a tiny `cmc_stub` canister installed at the well-known CMC id
`rkp4c-7iaaa-aaaaa-aaaca-cai`** (the constant `CMC_PRINCIPAL`, integration.rs line 239),
so the backend's hard-coded CMC target resolves to it.

- PocketIC lets us choose a canister id via `create_canister_with_id(...)` (pocket-ic v9);
  install the stub there. If that id is unavailable in the harness, fall back to an
  `admin_set_cmc_canister`-style override if the backend exposes one; otherwise the CMC
  legs SKIP (documented, same green-stay convention).
- **Stub surface** (mirror the real CMC's two methods the backend calls in
  `settle_burn_split`):
  - `notify_top_up(record { block_index: nat64; canister_id: principal }) ->
     variant { Ok: nat /*cycles*/ ; Err: NotifyError }` — PB-148 shape (`memo TPUP`,
     `block_index nat64`). Default returns `Ok(<deterministic cycles>)`.
  - An accompanying ICRC `icrc1_transfer` *into* a CMC subaccount is just a normal ledger
    transfer to the `cmc` principal's per-canister subaccount — that already works against
    the real ledger (integration.rs asserts `cmc_after_first == total/4`, line 758). The
    stub only needs to answer `notify_top_up`.
- **Failure injection:** a test-only `cmc_stub_set_mode(variant { NotifyOk; NotifyErr:text })`
  update on the stub. Tests flip it to `NotifyErr` to force a specific leg to fail, then
  assert the backend saga records the partial state and is resumable (no double transfer)
  — the same guarantee PB-112 proves, now with a *controllable* failure point and a
  *recoverable* success path on retry (flip back to `NotifyOk`, re-run the sweep/saga).

This keeps the proven `settle_burn_split` transfer-then-notify ordering intact and only
swaps the *notify* result, so the cycle-leg balance assertions stay meaningful.

---

## 5. The §5 end-to-end scenario as one ordered test `[P1→P3]`

`e2e_full_lifecycle()` walks anchor §5 `create → mint → list → play → earn → buy →
resell → feature → rate → lottery-reset` as a single ordered integration test against the
real two-canister wasm. Steps 1–5 gate **Phase 1**, step "buy/resell" gates **Phase 2**,
"feature/rate" gates **Phase 3** (anchor §6). Implement as one `#[test]` with clearly
sectioned blocks so a later-phase failure points at its step; the harness is reused so the
marginal cost of one long test is low.

Pre-req fixtures: `valid_course_data_v1()` — a CBOR `CourseDataV1` (PB-303) with exactly
9 holes, one tee/one cup each, `par_total` in `18..=45`, blob ≤ 24 KiB (PB-304
`MAX_COURSE_DATA_BYTES`). Keep it as a const byte fixture committed under the test module
so the test does not depend on the TS editor.

```text
STEP 1 — create + mint (PB-302/303/304)                                    [P1]
  - dev1 (owner) get_mint_deposit_address(); deposit 0.5 ICP into that escrow
    subaccount (icrc1_transfer, fee 10_000), exactly like do_commit_as (562–604).
  - mint_course_nft(valid_course_data_v1(), "Sunset Links") -> Ok(token_id=1).
  ASSERT:
    * the 0.5 ICP split: treasury subaccount += 50% net of fronted fees (the
      TREASURY_FLOAT + 25_000_000 − fronted-fee pattern of integration.rs 760–765);
      CMC backend subaccount += 25%; CMC frontend subaccount += 25% (CMC stub = Ok).
    * course_nft.icrc7_owner_of([nat(1)]) == [Some(account(dev1))]              (C1: nat round-trip)
    * course_nft.icrc7_token_metadata([nat(1)]) carries caldera:course_data (verbatim
      bytes == fixture), caldera:par_total, caldera:creator == dev1, caldera:mint_fee_e8s
      == 50_000_000, play_count == 0, tickets_distributed == 0 (PB-301 A.3).
    * get_my_course_draft(dev1) == None (draft cleared last, PB-304 B.4 step 6).

STEP 2 — auto-list + visible (PB-304 step 5 / PB-305)                       [P1]
  ASSERT list_marketplace_courses(default_filter) contains token 1, listed=true,
  for_sale=false, cached owner == dev1, par_total/theme match the fixture.

STEP 3 — play → earn (PB-306)                                              [P1]
  - dev2 start_play_session(1) -> session_id (server-minted, monotonic).
  - record_hole_event(session_id, 1); advance_time(MIN_HOLE_INTERVAL_NS); event(.,2);
    ... in order through 9, advancing time past the pacing floor each hole (reuse
    pic.advance_time + tick).
  ASSERT after hole 2: owner dev1 current-round LOTTERY_TICKETS count == 1
    (resolve via get_lottery_tickets/my_tickets query), course_nft
    tickets_distributed(1) bumped, play_count bumped.
  - complete_round(session_id) -> Ok (player dev2 is Tier-2 fixture).
  ASSERT player dev2 current-round ticket count == 1; complete_round is terminal
    (a second call -> AlreadyCompleted, no extra ticket — V3).

STEP 4 — buy / resell (PB-307, escrow saga C3)                            [P2]
  - dev1 list_course_for_sale(1, price=1 ICP).
  - dev2 icrc2_approve(icp, spender=backend, price + ICP_FEE), then buy_course_nft(1).
  ASSERT split 75/10/5/5/5 of price, all paid FROM the per-sale escrow subaccount
    (derive_subaccount(dev2,1)): seller dev1 += 75% (net fronted fee), creator dev1
    (== seller here → coalesced 85% in one transfer, two journaled blocks, PB-307 A4),
    treasury += 5%, CMC backend/frontend += 5% each; escrow subaccount nets ~0.
  ASSERT course_nft.icrc7_owner_of([nat(1)]) == [Some(dev2)]; listing for_sale=false.

STEP 5 — subsequent plays credit the NEW owner (PB-306 V7)                 [P2]
  - a third principal plays a fresh in-order session to hole 2.
  ASSERT the hole-2 owner ticket now credits dev2 (the live owner, resolved at the
    hole-2 moment), NOT dev1.

STEP 6 — featured slot (PB-308)                                           [P3]
  - dev1 bid_featured_slot(1, CkBTC, amount_a): icrc2_approve(ckbtc, backend, ...) then bid.
  ASSERT get_featured_slot() == token 1, bidder dev1; 100% of amount_a landed in the
    ckBTC TREASURY_SUBACCOUNT (non-refundable); usd_value_e8s persisted (XRC valued).
  - dev2 bid_featured_slot(1or2, CkUSDC, amount_b) with a HIGHER usd value (drive the
    XRC rate via the existing admin rate setter / mock so the comparison is deterministic).
  ASSERT slot now == dev2's bid; dev1 got NO refund (earlier bid already in treasury).
  ASSERT a LOWER-usd bid returns BID_TOO_LOW:<current_usd>.

STEP 7 — rate (PB-310, C2)                                                [P3]
  - dev2 (a completer from STEP 3/5) rate_course(1, 5) -> Ok.
  ASSERT the listing card aggregate shows ★5.0 (1); a non-completer rate_course -> Err
    (gated on has_completed_round). (Detailed RatingKey byte-ordering is §6.3 / doc 03.)

STEP 8 — lottery win resets ALL ticket counts uniformly                    [P1 rule]
  - drive a lottery draw (admin_trigger / lottery_draw path) so lottery_state().round bumps.
  ASSERT on next touch every principal's stale-round count is zero — course tickets AND
    staking tickets alike (never-void rule, anchor §6 / overview §6). Earlier, assert an
    UNSTAKE between STEP 3 and the draw did NOT void dev2's player ticket (companion change:
    void_current_round_tickets removed).
```

---

## 6. Cross-canister, boundary & upgrade tests (separate `#[test]`s)

These are the things L1/L2 unit tests structurally cannot reach. Each is small and
independent (its own `setup_course_env()`), so a failure is diagnosable in isolation.

### 6.1 Saga atomicity / failure injection (mint + buy) `[P1 mint, P2 buy]`

- **`mint_partial_failure_resumable` [P1]** — charge succeeds, `course_nft.mint` fails:
  set the course_nft into a "reject mint" state for one call (a test-only
  `course_nft_test_fail_next_mint()` minter hook, OR temporarily point
  `admin_set_course_nft_canister` at a non-existent id to force an inter-canister reject),
  call `mint_course_nft` → expect `MintCallFailed`. Re-point/clear, call again.
  ASSERT: exactly one token exists (`icrc7_total_supply == 1`), the treasury/CMC balances
  moved **once** (compare deltas across the two calls — no second charge), the saga record
  is gone, draft cleared. (PB-304 acceptance 4/5; the *unit* idempotency of each leg is
  doc 01 — this proves it across the real canister boundary.)

- **`mint_no_orphan_on_charge_failure` [P1]** — force the *first* split leg to fail (CMC
  stub `NotifyErr` on the backend-cycles leg). ASSERT no token is minted (charge before
  mint, PB-304 ordering), saga marks the failed leg, retry (stub→`NotifyOk`) completes
  with no double-charge. No orphan token, no double-spend.

- **`buy_refund_from_escrow_treasury_untouched` [P2, BLOCKING — anchor §6 Phase 2]** —
  the C3 core (PB-307 A6/B7): dev2 approves + `buy_course_nft(1)`, but force
  `custodial_transfer` to fail (out-of-band move: have dev1 `icrc7_transfer(1 → dev3)`
  *after* approve but *before* buy, so the live-owner resolution + transfer rejects with
  `OWNERSHIP_CHANGED`). ASSERT:
    * dev2 (buyer) is refunded the **full `price_e8s` from the escrow subaccount**
      (`derive_subaccount(dev2,1)` nets ~0 after refund),
    * the backend **treasury liquid balance is unchanged** except the single refund ledger
      fee it fronts — i.e. the treasury never fronts the *price* (the C3 drain vector),
    * no split leg block index is set (no payout happened), `refund_block` set once,
    * a retry does not over-refund.

- **`buy_payout_leg_resumes` [P2]** — let the NFT transfer succeed, then force one payout
  leg (e.g. frontend CMC, stub `NotifyErr`) to fail *after* `transferred==true`. ASSERT
  the buyer already owns the token (`icrc7_owner_of == dev2`), the saga is **resumable**
  (re-run with stub→`NotifyOk` pays only the remaining legs, each block index set once),
  unpaid funds sat in escrow until the retry, totals reconcile to 75/10/5/5/5.

- **`concurrent_buyers_reentrancy_lock` [P2]** — two buyers approve, then issue
  `buy_course_nft(1)` interleaved (submit both ingress messages before ticking, then flush
  with `pic.tick()` loops). ASSERT exactly one succeeds; the other gets `SALE_IN_PROGRESS`
  and, on retry, `NOT_FOR_SALE`/`OWNERSHIP_CHANGED` — never a double transfer or double
  charge. (Heap `BUY_LOCKS`, PB-307 A5.)

### 6.2 Boundary / guard coverage (ingress + auth, unit-unreachable) `[P1]`

- **`anonymous_ingress_rejected`** — mirror integration.rs `anonymous_is_rejected_on_updates`
  (132–142): anonymous `update_call` of `mint_course_nft`, `buy_course_nft`,
  `list_course_for_sale`, `bid_featured_slot`, `rate_course` must `is_err()` (rejected by
  `#[inspect_message]`). On `course_nft`: anonymous `mint`/`custodial_transfer`/`icrc7_transfer`
  rejected; anonymous **queries** (`icrc7_owner_of`, `icrc7_collection_metadata`) succeed
  (PB-301 A.2: queries stay open). **`start_play_session` is the one update anon MAY call**
  (PB-306 A.2) — assert it succeeds for anonymous but credits no player ticket.

- **`minter_guard_only_backend`** — from a *non-backend* principal call `course_nft.mint`
  and `custodial_transfer` directly → `Err("NOT_MINTER")`. Even the `admin` (owner) is not
  the minter after `set_minter(backend)`, so owner-direct `mint` also fails (admin ≠ minter,
  PB-301 A.2). Confirms the allowlist is the *only* mint path.

- **`owner_transfer_only_owner`** — `course_nft.icrc7_transfer` succeeds for the live owner
  only; a non-owner gets `Unauthorized`; `creator` + counters unchanged after transfer
  (PB-301 acceptance). This is the gift/OTC path the backend must reconcile on next read.

- **`admin_guards`** — `admin_set_course_nft_canister`, `admin_set_token_ledger`,
  `admin_clear_featured_slot`, `set_minter` reject non-admins (pattern of
  `non_admin_cannot_add_admin`, integration.rs 158–173).

### 6.3 Real-Candid / real-StableBTreeMap correctness (C1, C2) `[P1]`

These exist at L3 specifically because the *bug class* only manifests with real Candid
serialization and real stable byte-ordering — a host unit test with native types can't
catch them. **Doc 03 owns the C-matrix entry; this is its integration leg.**

- **`c1_nat_id_round_trip`** — call `course_nft.icrc7_owner_of` with token ids encoded as
  **`candid::Nat`** (the standard wallet/explorer shape, PB-301 C1), not `nat64`. ASSERT a
  real minted id decodes and resolves; ASSERT `icrc7_owner_of([nat_from(u128::from(u64::MAX)+1)])`
  returns `[None]` (out-of-u64 id → doesn't exist, no trap, per PB-301 B.6 `nat_to_u64`);
  ASSERT `icrc7_total_supply()` decodes as `candid::Nat`. This is the test that fails if the
  surface exposes `nat64` and breaks Plug/Bitfinity. (Cross-ref doc 03 §C1.)

- **`c2_tokens_of_ordering_across_many`** — mint **> 256** tokens to two owners
  *interleaved* via the backend mint path (so the high byte of `token_id` varies and a
  CBOR-encoded key would mis-sort). ASSERT `course_nft.icrc7_tokens_of(account(ownerA),
  prev=None, take=1000)` returns **exactly** ownerA's ids in **ascending** order and none
  of ownerB's; page it with `(prev, take)` and assert contiguity. This is the test a
  CBOR `(Principal,u64)` key fails (PB-301 B.2 C2). (Cross-ref doc 03 §C2.)

- **`c2_ratings_range_scan` [P3]** — after several `rate_course` calls across two tokens,
  the listing aggregate for token 1 reflects only token 1's ratings — i.e. the
  `RatingKey` `token_id`-big-endian-first ordering makes `COURSE_RATINGS.range(token_id..)`
  list exactly one course (PB-310 B2). Asserted via the public aggregate, no internal access.

- **`c5_metadata_batch_cap`** — `course_nft.icrc7_token_metadata` with **26** ids → `Err`
  `BATCH_TOO_LARGE` (cap 25, PB-301 A.5/C5); with 25 ids → Ok and the reply decodes under
  the message limit. Light methods (`icrc7_owner_of`/`icrc7_tokens_of`) accept 100, reject 101.
  (Cross-ref doc 03 §C5; the *size* arithmetic is doc 01.)

### 6.4 Upgrade persistence `[P1, gates PB-309 cutover per anchor §8 / traceability matrix]`

State must survive `pic.upgrade_canister(...)` (pocket-ic v9) on **both** canisters
(serde defaults + no MemoryId reuse, overview §8). One test, two upgrades:

```text
upgrade_persists_state():
  - mint token 1 (dev1), list it for sale, dev2 plays to hole 2 (owner ticket credited),
    dev1 bids a featured slot.
  - pic.upgrade_canister(course_nft, course_nft_wasm, encode_one(()) /* post_upgrade */, owner)
  - pic.upgrade_canister(backend, backend_wasm, <upgrade arg>, owner); flush ticks.
  ASSERT after upgrade:
    * course_nft: icrc7_owner_of(1)==dev1, icrc7_token_metadata(1) byte-identical
      (course_data + creator), icrc7_total_supply unchanged, NEXT_TOKEN_ID intact
      (next mint == 2, not 1) — PB-301 acceptance "upgrade safety".
    * backend: COURSE_LISTINGS row for 1 survives (for_sale, price), the credited
      lottery ticket count survives, FEATURED_SLOT survives, any in-flight MINT_SAGAS /
      COURSE_SALES journal survives so a half-run saga still resumes (PB-304/307).
  - then mint token 2 post-upgrade to prove the counters + minter allowlist still work.
```

Also a focused **`course_nft_smoke_upgrade`** mirroring PB-301's own "deploy → mint →
upgrade → re-assert ownership + metadata" smoke (PB-301 test plan), kept here so the
crate-local test in `src/course_nft` (doc 01) and this boundary test don't drift.

---

## 7. Traceability (which L3 test gates which item)

Maps into the anchor §8 master matrix; doc 03 owns the full C/V detail, doc 01 owns the
unit legs. **This doc is the "02" cell** for every row below.

| Item | L3 test(s) here | Phase |
|---|---|---|
| PB-301 ICRC-7 interop | `e2e` STEP 1, `minter_guard_only_backend`, `owner_transfer_only_owner`, `course_nft_smoke_upgrade` | P1 |
| PB-304 mint E2E + saga | `e2e` STEP 1, `mint_partial_failure_resumable`, `mint_no_orphan_on_charge_failure` | P1 |
| PB-305 marketplace | `e2e` STEP 2, filter/page assertions | P1 |
| PB-306 play-to-earn / V7 | `e2e` STEP 3 & 5 | P1 |
| PB-307 secondary market **(C3)** | `buy_refund_from_escrow_treasury_untouched` **(blocking)**, `buy_payout_leg_resumes`, `concurrent_buyers_reentrancy_lock`, `e2e` STEP 4 | **P2** |
| PB-308 featured slot | `e2e` STEP 6 | P3 |
| PB-309 leaderboard/migration | `upgrade_persists_state` (cutover survives upgrade) | P1 |
| PB-310 ratings | `e2e` STEP 7, `c2_ratings_range_scan` | P3 |
| C1 `nat` vs `nat64` | `c1_nat_id_round_trip` | P1 |
| C2 ordered keys | `c2_tokens_of_ordering_across_many`, `c2_ratings_range_scan` | P1/P3 |
| C3 escrow / treasury-drain | `buy_refund_from_escrow_treasury_untouched`, `buy_payout_leg_resumes` | P2 |
| C5 2 MiB query cap | `c5_metadata_batch_cap` | P1 |
| Anon/guards | `anonymous_ingress_rejected`, `admin_guards` | P1 |
| Lottery never-void / reset-on-win | `e2e` STEP 8 | P1 |

---

## 8. Conventions checklist for the implementer

- [ ] New file `src/backend/tests/course_nft_integration.rs`; shared helpers either copied
      from `integration.rs` or lifted to `mod common;` — **never** edit the PB-112 suite.
- [ ] Every test opens with `let Some(env) = setup_course_env() else { return };` so a
      missing wasm / CMC stub / PocketIC server **SKIPs green** (anchor §3, PB-112 convention).
- [ ] Build with `cargo build --target wasm32-unknown-unknown --release -p backend -p course_nft`
      (+ `-p cmc_stub` if used) before running `cargo test -p backend --test course_nft_integration`.
- [ ] After every inter-canister `update_call`, `for _ in 0..5 { env.pic.tick(); }` (flush).
- [ ] ck-token params come from `icp.yaml` (§3.3) — keep them in lockstep if the yaml changes.
- [ ] Money assertions account for the **treasury fronting per-leg fees** (the
      `+ TREASURY_FLOAT − n*fee` arithmetic of integration.rs 760–765) — do not assert raw
      gross amounts.
- [ ] Do **not** re-test pure split math / anti-cheat pacing here (doc 01); do **not**
      duplicate the C/V matrix narrative (doc 03) — only their canister-boundary legs.
```
