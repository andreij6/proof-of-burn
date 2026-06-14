# Course NFT — Consolidated Testing Plan: Overview & Strategy

> Anchor for the Course NFT testing plan. Each task spec ([tasks/01–10](../tasks/))
> already carries a per-feature **Test plan** section; this folder consolidates them
> into one cross-cutting strategy: shared harness/tooling, end-to-end scenarios that
> span specs, a security + IC-compliance regression matrix tied to the spec review,
> and phased CI/QA gates. Read this first.

Related: [tasks/00-overview-and-architecture.md](../tasks/00-overview-and-architecture.md)
(decisions D1–D4, MemoryId map), [course-nft-specs-review.md](../course-nft-specs-review.md)
(issues C1–C5, O1–O2).

---

## 1. What exists vs. what this adds

- **Exists:** every spec has a Test plan (unit + integration + manual). The repo has
  real test infra to build on — see §3.
- **This plan adds:** (a) the *shared* harness work (two-canister PocketIC, stubbed CMC,
  ck-token ledgers, `course_nft.wasm` build), (b) **end-to-end** scenarios that no single
  spec owns, (c) a **security/IC-compliance regression matrix** (review C1–C5 + anti-cheat
  V1–V7) as first-class tests, (d) **phased gates** + a **traceability matrix** so every
  PB-3xx / C / V item maps to at least one named test.

---

## 2. Test pyramid (and where each layer lives)

| Layer | Scope | Tooling | Command |
|---|---|---|---|
| **L1 — backend unit** | pure logic + saga state machines via mock seams (no real ledger/NNS/CMC) | `#[cfg(test)] mod tests` in `src/backend/src/lib.rs` | `cargo test -p backend --lib` |
| **L2 — course_nft unit** | ICRC-7 ledger logic, custodial auth, ordered keys | `#[cfg(test)]` in `src/course_nft/src/lib.rs` (mirror the backend mock-caller seam) | `cargo test -p course_nft` |
| **L3 — integration (PocketIC)** | real wasm at the canister boundary: ingress/guards, cross-canister sagas, upgrade persistence | `src/backend/tests/integration.rs` (+ new `course_nft_integration.rs`) | `cargo test -p backend --test integration` |
| **L4 — frontend** | pure game/marketplace logic + render/interaction smoke | vitest + `@testing-library/react` + jsdom in `src/frontend/src/test/` | `cd src/frontend && npx tsc -b && npx vitest run` |
| **L5 — manual local** | full UX on a live local replica, multi-identity | `bash scripts/deploy-local.sh` | per-phase QA scripts ([04](04-frontend-and-manual-acceptance.md)) |

Bias toward **L1** for money/anti-cheat logic (fast, deterministic via mock seams) and use
**L3** for the things unit tests can't reach (real Candid types → catches C1; real
`StableBTreeMap` byte-ordering → catches C2; cross-canister mint/buy atomicity → C3;
ingress/guards). Keep **L4** pure-logic-first per the `frontend-dev` skill.

---

## 3. Repo test infrastructure (build on this — don't reinvent)

**Native mock seams (L1/L2)** — already in `lib.rs`, set in `#[cfg(test)]`:
`set_mock_caller`, `set_mock_ledger_balance`, `set_mock_ledger_transfer`,
`set_mock_cycles`, `set_mock_neuron` / `set_mock_neuron_for_id`, `TEST_MOCK_NNS_VOTE`,
`MOCK_GOV`, plus helpers like `install_staking_test_config()` and `p("<principal>")`.
New value-moving course code MUST expose an equivalent seam (the specs already require it,
e.g. PB-306's `course_nft_owner_of` seam, PB-307's `TEST_MOCK_*` leg-failure toggle).

**PocketIC integration (L3)** — `pocket-ic = "9"` is a dev-dep; `src/backend/tests/integration.rs`
(2.2k lines, PB-112) is the template. Key conventions to reuse verbatim:
- Build wasm first: `cargo build --target wasm32-unknown-unknown --release -p backend`
  (and now `-p course_nft`). Tests **skip with a message** if a wasm or the PocketIC
  server binary is missing, so `cargo test` stays green for contributors who didn't build.
- Point at the server: `POCKET_IC_BIN=~/.cache/dfinity/versions/<v>/pocket-ic`.
- It already installs the project ICRC ledger (`ledger.wasm.gz`) into PocketIC and drives
  `create_canister`/`install_canister`/`update_call`/`query_call`.
- **New for this feature ([02](02-integration-pocketic-e2e.md) owns it):** a two-canister
  installer (backend + `course_nft`, wired as allowlisted minter), a **stubbed CMC**
  canister returning `notify_top_up` Ok/Err for the cycle legs, and ck-token test ledgers
  (ckBTC/ckETH/ckUSDC/ckUSDT) for buy/featured-slot flows.

**Frontend (L4)** — vitest run/watch scripts exist; `src/frontend/src/test/` already has
`minigolf.test.ts`, `crash.test.ts`, `dashboard.test.ts`, `ideaBoard.test.ts`, `setup.ts`.
Extend `minigolf.test.ts` for the new elements (PB-303) and add page render smokes.

**CI** — there is **no `.github/workflows` today**; this plan **recommends** adding one
(gates in §6). Until then the gates are run manually / pre-merge.

---

## 4. Plan documents (this folder)

| Doc | Scope | Primary layers |
|---|---|---|
| [01-backend-unit-tests.md](01-backend-unit-tests.md) | Per-method/saga L1 unit tests for the marketplace backend + L2 course_nft crate unit tests; required mock seams | L1, L2 |
| [02-integration-pocketic-e2e.md](02-integration-pocketic-e2e.md) | Two-canister PocketIC harness, full-lifecycle E2E scenarios, saga-failure injection, upgrade-persistence | L3 |
| [03-security-ic-compliance-matrix.md](03-security-ic-compliance-matrix.md) | Review **C1–C5** regression tests + anti-cheat **V1–V7** matrix + economic invariants (split sums, ticket caps, never-void) | L1, L2, L3 |
| [04-frontend-and-manual-acceptance.md](04-frontend-and-manual-acceptance.md) | vitest (engine/editor/marketplace/play logic + render smokes) and the per-phase manual local QA scripts | L4, L5 |

---

## 5. End-to-end happy path (the scenario the whole feature must satisfy)

`create → mint → list → play → earn → buy → resell → feature → rate`, exercised in L3
([02](02-integration-pocketic-e2e.md)) and walked manually in L5 ([04](04-frontend-and-manual-acceptance.md)):

1. dev1 builds a valid 9-hole course (draft) and `mint_course_nft` (0.5 ICP, 50/25/25).
2. Course auto-lists; appears in `list_marketplace_courses`; `icrc7_owner_of` == dev1.
3. dev2 `start_play_session` → 9 ordered `record_hole_event` → `complete_round`:
   owner dev1 gets 1 ticket at hole 2, player dev2 gets 1 ticket at completion.
4. dev1 `list_course_for_sale`; dev2 approves + `buy_course_nft`: 75/10/10/5 split,
   token moves to dev2 (escrow saga, C3), creator royalty paid to dev1.
5. Subsequent plays credit dev2 (live owner) at hole 2.
6. A ckBTC `bid_featured_slot` pins the course; a higher USD bid displaces it.
7. dev2 (a completer) `rate_course`; aggregate shows on the card.
8. A win on the lottery resets *all* ticket counts (course + staking) uniformly; no
   unstake voids tickets (the §6 ticket-lifetime rule).

---

## 6. Phased gates & CI

**Per-PR gate (must pass, all phases):**
```
cargo test -p backend --lib
cargo test -p course_nft
cd src/frontend && npx tsc -b && npx vitest run
```
**Pre-merge / nightly gate (needs wasm + PocketIC server):**
```
cargo build --target wasm32-unknown-unknown --release -p backend -p course_nft
POCKET_IC_BIN=<path> cargo test -p backend --test integration
POCKET_IC_BIN=<path> cargo test -p backend --test course_nft_integration
```
**Phase exit criteria:**
- **Phase 1 (MVP):** L1/L2 green for PB-301/303/302/304/305/306/309 + the lottery
  companion change; the E2E §5 steps 1–5 pass in L3; C1, C2, C4, C5 regression tests
  pass; V1–V7 anti-cheat matrix passes; manual QA script P1 signed off.
- **Phase 2:** PB-307 — **C3 escrow tests are blocking** (no merge without the
  treasury-drain + refund-from-escrow tests green); E2E steps 4–5.
- **Phase 3:** PB-308 (featured slot) + PB-310 (ratings, incl. C2 RatingKey test); E2E
  steps 6–7.

Recommend a `.github/workflows/ci.yml` running the per-PR gate on every PR and the
nightly gate on a schedule (cache the PocketIC binary + the wasm build).

---

## 7. Coverage targets

- **Money & anti-cheat paths: 100% of branches** — every fee/royalty leg, every saga
  failure/retry boundary, every anti-cheat rule (V1–V7), the never-void/reset rule.
  These are the lines where a bug costs real ICP.
- **ICRC-7 surface:** every standard method has a unit + a PocketIC test (interop is the
  point of D2).
- Editor/engine/marketplace logic: meaningful unit coverage; render smokes for each new
  page. No hard % gate on UI, but each reworked page gets at least one render test (closes
  the "candid-optional dead-button" class of bug noted in project memory).

---

## 8. Master traceability matrix (skeleton — [03](03-security-ic-compliance-matrix.md) owns the full C/V detail)

| Item | What it is | Owning test doc |
|---|---|---|
| PB-301 | course_nft ICRC-7 | 01 (unit), 02 (interop), 03 (C1/C2/C5) |
| PB-302 | editor | 04 |
| PB-303 | engine + course_data format | 04 (engine/serialize), 03 (C5 size) |
| PB-304 | minting flow | 01 (saga), 02 (E2E mint), 03 (split sums) |
| PB-305 | marketplace | 01, 02, 04 |
| PB-306 | play-to-earn + anti-cheat | 01, 03 (V1–V7, C4), 02 |
| PB-307 | secondary market | 01, 02, **03 (C3 — blocking)** |
| PB-308 | featured slot | 01, 02, 03 (USD valuation) |
| PB-309 | leaderboard removal / migration | 01, 02 (upgrade), 04 (manual cutover) |
| PB-310 | ratings | 01, 03 (C2 RatingKey) |
| C1 | `nat` vs `nat64` | 03 + 02 (real Candid) |
| C2 | ordered composite keys | 03 + 01 (range tests) |
| C3 | escrow / treasury-drain | 03 + 02 (E2E) |
| C4 | no `raw_rand` on game start | 03 + 01 |
| C5 | query response 2 MiB limit | 03 + 01 |
| Lottery companion | remove on-unstake void; reset only on win | 01 + 03 (invariant) |
