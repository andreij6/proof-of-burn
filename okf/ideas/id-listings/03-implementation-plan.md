---
type: idea
title: "ID Listings — Implementation Plan & Codebase Reuse Map"
tags: [ideas, id-listings]
timestamp: 2026-06-16T05:25:50-04:00
---

# ID Listings — Implementation Plan & Codebase Reuse Map

> Mapping against `src/backend/src/lib.rs` and `src/frontend` (line numbers as of 2026-06-15). The
> **Dapp Explorer** is the closest existing analog (a paid listing directory with XRC pricing, admin
> approval, timer-driven expiry, and a directory page) — the ID Listings page reuses its anatomy. The
> two genuinely new pieces are **external ingestion** and **certified contract validation**, and the
> validation **cannot live in the backend canister** (see [`02`](./02-validation-method.md) §3).

## 0. Blocking prerequisite (D0)

Before any code: capture idgeek's **real backend canister id**, its **public read method name + return
type** (and whether it's a *query*), and the **listing field schema**, from the SPA's live network calls
in a browser (devtools → watch the agent's `read`/`query` calls). Leading candidate
`cocmv-eiaaa-aaaah-qdbxq-cai` is **unconfirmed**. The ingestion architecture (on-chain vs indexer) forks
on whether idgeek exposes a *public query*.

## 1. External data ingestion — patterns & gaps

| Need | Existing pattern | Location | Reuse |
|---|---|---|---|
| Call an external canister | XRC oracle: `call_with_payment128(canister, "get_exchange_rate", …)` | `lib.rs:9498` | Template for an `ic_cdk::call` to idgeek's backend (IF public query) |
| Cache external state w/ TTL | `EXPLORER_USD_RATES` heap cache, 10-min TTL, stale-fallback | `lib.rs:9285, 9525-9551` | Model for caching mirrored listings |
| Transient external cache struct | `LeaderNeuronInfo` + `LEADER_INFO` heap + `fetch_leader_neuron_info` | `lib.rs:172-178, 730, 1573-1616` | Model for "fetch on timer, cache, serve via query" |
| Timer ingest job | `setup_timers` pattern | `lib.rs:4612-4637` | Add `ingest_id_listings()` on its **OWN** `set_timer_interval`, NOT the shared 300s tick (Round-2 A6 — a hung idgeek call must not stall settlements); budget the replicated-call + `canister_info` cost (revisit "free") |

**Gaps (net-new):**
- **No HTTPS-outcall infrastructure** anywhere in the repo — all external calls are inter-canister. So
  the SPA/JSON ingestion path is impossible on-chain; ingestion is either inter-canister query (if idgeek
  exposes one) or an off-chain indexer.
- **Off-chain indexer (FALLBACK only — corrected, Round-2 A0/A3)** is net-new: a worker (Node/Rust +
  agent) that queries idgeek and calls a **validation-gated, `indexer_principal`-only ingest method**. It
  does **not** run the validation verdict (that's on-chain via `canister_info`, §3). Use it only if
  idgeek's read method is `composite_query`-only or auth-gated; otherwise prefer on-chain inter-canister
  ingestion.

## 2. Listing directory — reuse the Dapp Explorer

| Piece | Identifier | Location | Reuse |
|---|---|---|---|
| Listing struct | `DappListing` (id, status, created/approved/expires_at, categories…) | `lib.rs:9201-9229` | Clone as `IdListing` with idgeek fields (below) |
| Status enum | `DappStatus {Pending, Approved}` | `lib.rs:9194-9198` | New `IdListingStatus {Upcoming, Active, Expired}` derived from timestamps |
| Storage | `DAPPS` (MemoryId 40) + `NEXT_DAPP_ID` (41) | `lib.rs:9271-9276` | New `ID_LISTINGS` map, MemoryId from free list (§6) |
| Query methods | `list_dapps` / `list_pending_dapps` / `list_my_dapp_submissions` | `lib.rs:10086-10125` | `list_id_listings()` (active+upcoming), sorted by status/time |
| Expiry cleanup | `delete_expired_dapps` on timer | `lib.rs:9863-9881, 4625` | `delete_expired_id_listings()` (drop sold/expired) |
| Paid-listing (optional promote) | `submit_dapp` + XRC quote + escrow | `lib.rs:10145-10276` | Only if D2 adds promoted listings later |
| Frontend page | `Explorer.tsx` anatomy (refreshAll, card grid, filters, admin queue) | `src/frontend/src/Explorer.tsx:111-731` | Clone as `IdListings.tsx`; cards deep-link to idgeek |
| Status-on-read | `dappDaysLeft` computed in the frontend | `Explorer.tsx:63-67` | Compute Upcoming/Active/expired from `start_time`/`end_time` |

### `IdListing` data model (proposed)

```
IdListing {
  source_canister: Principal,     // idgeek backend (pinned)
  source_listing_id: u64,         // idgeek anchor number (the listing key)
  anchor: u64,                    // II anchor being sold
  price_e8s: u64,                 // gross idgeek price
  currency: String,              // "ICP" (FLAG: verify)
  start_time: u64,                // go-live / protection start (ns)
  end_time: u64,                  // protection/expiry end (ns)
  source_status: String,         // raw status from idgeek (robust to schema changes)
  asset_summary: String,         // e.g. "II + 1 NNS neuron (8yr)"; display-only
  has_offers: bool,               // pending offers below ask
  source_validated: bool,         // result of the geekfactory-style check at last ingest
  validated_at: u64,              // when validation last ran
  fetched_at: u64,                // when this row was last refreshed from idgeek
}
```

Display status derivation: `now < start_time → Upcoming`; `start_time ≤ now < end_time → Active`;
else drop. Always show `fetched_at` and a "View on idgeek" deep link (source of truth).

## 3. Validation plumbing (CORRECTED — on-chain via `canister_info`)

- **The check runs ON-CHAIN in the backend** via the management canister's `canister_info` (callable by
  any canister for any target, NOT controller-gated; in `ic-cdk` 0.19 as
  `canister_info(CanisterInfoRequest) -> CanisterInfoResponse` returning `module_hash` + `controllers` +
  `recent_changes`). Round-2 A0 corrected the earlier "must be off-chain" claim. Use the **current**
  `module_hash`/`controllers` (not the bounded 20-entry change log) for pass/fail.
- **Backend computes & enforces:**
  - `CONFIG` additions (pattern: `admin_set_pool_fee` `lib.rs:1334`, Config struct `lib.rs:403`):
    `idgeek_backend_canister: Principal`, `idgeek_expected_module_hash: Vec<u8>`,
    `idgeek_expected_controllers: Vec<Principal>` (+ `indexer_principal: Principal` only if the indexer
    fallback is used).
  - `admin_set_idgeek_source(...)` (require_admin) pins the expected hash/controllers (baseline at
    approval) and the backend canister id.
  - The ingest path calls `canister_info`, compares to the pinned values, and **rejects the upsert if it
    fails/drifts** — so the validated state is canister-computed, and even a compromised indexer can't
    push listings from a drifted/swapped canister (Round-2 A1). On fail, mark existing rows stale.
- **Frontend (optional):** a live `read_state` (agent-js) re-check for a user-side signal, independent of
  the backend flag. **No "validated" badge on cards** (Round-2 B4) — at most a neutral factual line on a
  details page.
- **Existing reference:** `admin_get_frontend_cycles` → `canister_status` at `lib.rs:3433-3444`
  (controller-only — NOT usable for idgeek); `canister_info` is the net-new, non-controller-gated call to
  add.

## 4. The off-chain indexer (FALLBACK ONLY — corrected)

Round-2 A0/A3 demoted this from "recommended" to **fallback**, used **only if** idgeek's read method is
`composite_query`-only (canisters can't call those) or auth-gated. Otherwise prefer on-chain
inter-canister ingestion (a canister *can* call a normal `query`/`update` method from its update-context
timer; it runs replicated). If the indexer is used:
1. **Fetch** listings from idgeek's backend (the confirmed method from D0); **never** owns the validation
   verdict — validation is on-chain (§3) and the backend re-checks on ingest.
2. **Normalize** to `IdListing` (derive start/end/status; summarize bundled assets) with **defensive
   candid decode** (Round-2 A4): a schema mismatch rejects the whole message, so pin the verified
   interface at D0, decode into a maximally-optional shape, and treat decode errors as "ingest failed,
   keep last-good" + canary alert.
3. **Upsert** via the validation-gated, `indexer_principal`-only ingest method (diff; remove
   sold/expired).
4. **Degrade gracefully:** on failure, leave last-good and mark stale; alert admin.

Trust note: an indexer is a trusted writer of listing *data* (not the validation verdict). Worst case is
stale/wrong display data, mitigated by the live deep-link and by never presenting price as authoritative.

## 5. Frontend "ID Listings" page

- Clone `Explorer.tsx` anatomy: `refreshAll` → `list_id_listings()`; card grid + pagination + status
  filter (Upcoming / Active); no submit/payment flow in v1 (read-only).
- Each card: anchor, asset summary, status + countdown, `fetched_at`, and a prominent **"View on idgeek
  →"** deep link to `https://idgeek.app/identity/<anchor>`. **No "validated" badge** (Round-2 B4) and
  **no live/authoritative price** (Round-2 B5/A5) — show "price as of {fetched_at}, confirm on idgeek" at
  most, with the deep-link as the only call-to-action (no "buy", no price-prominent CTA).
- Prominent disclaimer banner: "Listings sourced from idgeek. We are not affiliated with idgeek/
  GeekFactory and do not custody, settle, or guarantee these sales." (See `ui-copy-in-sync` skill.)
- **Optional live re-validation:** the frontend can re-run the certified `read_state` check via agent-js
  for a real-time badge, independent of the indexer's last result.

## 6. Persistence / upgrade

- `impl_storable!(IdListing)` (macro `lib.rs:608`).
- **MemoryId allocation — authoritative free list** (grep-verified, Round-2 confirmed; used: `0-25,
  34-52, 60-72, 74-75, 77-87, 90-93, 96`): free are **26–33, 53–59, 73, 76, 88–89, 94–95, 97+**. (The
  Faucet uses 90–93 + 96, not the full 90–96.) Allocate from **53–59** (contiguous, verified free):
  `53 ID_LISTINGS`, `54 NEXT_ID_LISTING_ID` (+ spares). Listings live in this **stable** map (Round-2 A7
  — survives upgrades), NOT a heap cache. Add a source-of-truth MemoryId table comment + uniqueness
  debug-assert.
- New `CONFIG` fields use `#[serde(default = "…")]` for upgrade safety.

## 7. Test plan

- **Host unit tests:** status derivation (Upcoming/Active/expired boundaries), ingest upsert/diff
  (add/update/remove), indexer-only auth on the ingest method, validation-fail path hides/flags rows,
  stale-fallback on fetch failure. Reuse `set_mock_time` (`lib.rs:233`) for time-window edges.
- **Indexer tests (net-new):** mock idgeek query + mock `read_state` cert (valid/invalid hash, drifted
  controllers) → assert validated flag and withhold-on-fail behavior.
- **Frontend:** vitest for status badge + countdown + disclaimer rendering.
- Run via the `run-tests` skill.

## 8. Candid / build

- Mirror `IdListing`, the query methods, and the admin/indexer methods into `backend.did`
  (`backend-canister-dev` skill for `.did` sync + upgrade safety). Regenerate frontend bindings.

## Effort summary (reuse vs build-new)

| Component | Decision |
|---|---|
| Listing directory struct/storage/query/expiry/page | **REUSE** Dapp Explorer (high reuse) |
| External fetch from idgeek | **BUILD-NEW**, blocked on D0; on-chain inter-canister viable for a normal query/update method (blockers: `composite_query`-only / auth-gated) |
| Off-chain indexer | **BUILD-NEW, FALLBACK ONLY** (only if idgeek's method is `composite_query`/auth-gated) |
| Contract validation | **BUILD-NEW, ON-CHAIN** via `canister_info` (corrected — not off-chain); enforced on ingest |
| Validation badge / authoritative prices | **DON'T BUILD** (Round-2 B4/B5) |
| Promoted-listing fees | **DON'T BUILD** (Round-2 B9 — regulatory/optics) |
