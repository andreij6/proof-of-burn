---
type: idea
title: "Admin — Revenue & Expense Dashboard — Tasks (PB-320 … PB-329)"
tags: [ideas, admin-revenue]
timestamp: 2026-06-14T01:26:27-04:00
---

# Admin — Revenue & Expense Dashboard — Tasks (PB-320 … PB-329)

> Read [`revenue-expense-dashboard.md`](revenue-expense-dashboard.md) first.
> Read-only reporting over the existing `AUDIT_LOG` + `PAYOUTS` journals — **no new
> money flows, no migrations.** v1 needs **no new MemoryId** (scan-on-read). The only
> MemoryId this feature would ever claim is **96** (optional precompute, PB-328,
> deferred). Stays clear of the course-nft band (0–89 used/reserved per the overview).
>
> Repo conventions (from the course-nft overview §6): backend is the single
> `src/backend/src/lib.rs` with `// ===== N. Title =====` banners — add
> `// ===== 21. Revenue reporting =====`. Candid `src/backend/backend.did` is
> hand-maintained, update in lockstep. New stable struct fields need
> `#[serde(default)]`. `require_admin` on every endpoint. Amounts are `u64` e8s.
> Value-moving / aggregation logic needs a native test seam. Skills:
> `backend-canister-dev`, `frontend-dev`, `run-tests`.

---

## Ordering / dependency graph

```
PB-320 (types + pure aggregator)
   ├── PB-322 (get_revenue_report query)   ← depends 320
   │       └── PB-324 (candid)             ← depends 322
   │               └── PB-325 (Admin section + period toggle + cards) ← depends 324
   │                       ├── PB-326 (breakdown tables + sparkline + top events)
   │                       └── PB-327 (caveats MoreInfo + token mix)
   ├── PB-321 (treasury_withdraw audit row)   ← independent, small, do early
   ├── PB-323 (backend aggregator unit tests) ← depends 320
   └── PB-328 (OPTIONAL precompute, MemoryId 96)  ← deferred
PB-329 (frontend vitest + manual verify)    ← depends 325/326/327
```

---

## PB-320 — Backend: report types + pure aggregator

**Scope (lib.rs, new section 21):**
- Add `RevenuePeriod { Daily, Weekly, Monthly }`, `TokenAmount`, `RevenueLine`,
  `ExpenseLine`, `RevenueBucket`, `TopEvent`, `RevenueReport` (CandidType +
  Serialize/Deserialize) exactly as in design §7.2.
- Period-bucketing helpers from `timestamp` nanos:
  - `day_index(ts) -> u64` (`ts/1e9/SECS_PER_DAY`),
  - `week_start_ts(ts)` and `month_start_ts(ts)` (civil-from-days; reuse the
    `(day+4)%7` weekday trick already in `next_draw_after`, lib.rs ~8203),
  - `bucket_label(period, start_ts) -> String` ("2026-06-08" / "2026-W23" / "2026-06").
- `fn aggregate_report(audit, payouts, upvotes_by_ref, fundings_by_ref, period, now,
  icp_usd_rate_e8s, token_usd_rates) -> Vec<RevenueBucket>` — **pure**, no ledger/oracle
  calls. Implements the taxonomy:
  - REVENUE: `"burn"`→`amount/2`; `"pool_register"`→`amount/2`; `"idea_post"`,
    `"project_fund"`, `"idea_upvote"`, `"arcade_customize"`,
    `"arcade_customize_kicker"`→full amount; everything else ignored for revenue.
  - EXPENSE (from audit): cycle-topups = the **non-treasury half** of `"burn"` +
    `"pool_register"` (`amount - amount/2`); `"treasury_withdraw"` (PB-321) full.
  - EXPENSE (from payouts): one line per `PayoutType`; `CommitmentRefund` &
    `UnstakeDisbursement` carry `pass_through = true`.
  - USD via `icp_amount_usd_e8s` for ICP lines and the passed token rates for
    token-typed payout/journal amounts (design §5).
  - `operating_net = revenue − (expense excl. pass_through)`;
    `net_incl_passthrough = revenue − all expense`.
  - token mix: where a revenue/expense line is token-typed, fill `by_token` by joining
    `*_by_ref` (upvotes/fundings) or the payout's own `token`; else `[{ICP, e8s}]`.

**Acceptance criteria:**
- New types compile; `cargo build` (wasm + native) green.
- `aggregate_report` is pure (takes slices, returns Vec) — no `*.with` / `await` inside.
- A burn of 100 ICP produces revenue line `burn` = 50 ICP **and** expense line
  `cycle_topups` = 50 ICP in the same bucket.
- `CommitmentRefund` / `UnstakeDisbursement` lines have `pass_through = true` and are
  excluded from `operating_net`.
- Buckets are returned **newest-first**, window-bounded.

**Depends:** none. **Blocks:** PB-322, PB-323.

---

## PB-321 — Backend: journal admin treasury withdrawals (audit row)

**Scope:** In `admin_withdraw_treasury` and `admin_withdraw_treasury_token`
(lib.rs ~3404 / ~3424), after a **successful** transfer append an
`AuditLogEntry { event_type: "treasury_withdraw", proposal_id: 0, user: <to>,
amount_e8s: <amount> }`. (Token withdrawals: log the native amount; note token in a
follow-up if a token field is ever added — for now amount-only, ICP-equiv not required
since these are rare and operator-initiated.)

**Acceptance criteria:**
- A withdrawal appends exactly one audit row with `event_type = "treasury_withdraw"`.
- No change to the transfer/floor-check logic (append is the only addition, after
  success).
- Existing withdrawal tests still pass; add one asserting the row is written.

**Depends:** none (do early — small, unblocks accurate expense). **Blocks:** PB-320's
withdrawal expense line being non-empty (PB-320 already handles the event_type).

---

## PB-322 — Backend: `get_revenue_report` query endpoint

**Scope (lib.rs section 21):**
```rust
#[ic_cdk::query(guard = "require_admin")]
fn get_revenue_report(period: RevenuePeriod, window: u32) -> RevenueReport
```
- Clamp `window` to `1..=60`.
- Compute the oldest bucket-start in the window from `now`; scan `AUDIT_LOG` backward
  only to that start (stop early — entries are time-ordered), collect into a Vec.
- Collect `PAYOUTS` filtered by `created_at >= oldest_start`.
- Build `upvotes_by_ref` / `fundings_by_ref` from `IDEA_UPVOTES` / `PROJECT_FUNDINGS`
  (ref_id → (token, amount)) for token mix.
- Read current rates from the cached helpers (`cached_usd_rate_e8s(ICP)` and per
  ck-token) — **no async** (cache only).
- Call `aggregate_report(...)`.
- Fill `top_events` (largest N revenue audit entries in window), `generated_at`,
  `rate_caveat = true`.
- Leave `treasury_*` and `cycle_burn_e8s_per_day`/`runway_days` computed from the
  in-window burn-share total ÷ window days; treasury balance fields = 0 (frontend fills
  from existing balance reads, design §7.3).

**Acceptance criteria:**
- Admin-guarded (non-admin → trap/err like other admin queries).
- Returns within query limits for a log of ≥10k synthetic entries (verify in PocketIC).
- Scan stops at the window boundary (does not iterate the whole log).
- Empty window → empty `buckets`, zeroed totals, no panic.

**Depends:** PB-320. **Blocks:** PB-324.

---

## PB-323 — Backend: aggregator unit tests (native)

**Scope:** `#[cfg(test)]` unit tests over `aggregate_report` with synthetic
`AuditLogEntry` / `Payout` vectors (native, no canister):
- burn split: 50/50 revenue/cycle as above.
- multi-source day: idea_post + project_fund + arcade + burn → correct per-source lines.
- pass-through exclusion from `operating_net`, inclusion in `net_incl_passthrough`.
- period bucketing: entries on a day boundary land in the right Daily/Weekly/Monthly
  bucket; week boundary uses the same weekday math as the lottery.
- USD normalisation: ICP and a ck-token line both convert via the supplied rates.
- token mix: an `idea_upvote` line joins its `upvotes_by_ref` token.
- newest-first ordering; window bound respected.

**Acceptance criteria:** all green via `cargo test` (see `run-tests` skill); no
flakiness; covers each revenue source and each `PayoutType`.

**Depends:** PB-320. **Blocks:** none (gate for merge).

---

## PB-324 — Candid: hand-update `backend.did`

**Scope:** Add the new types and `get_revenue_report : (RevenuePeriod, nat32) ->
(RevenueReport) query;` to `src/backend/backend.did`, then regenerate the frontend
bindings (`src/frontend/src/declarations/...`) per the project's candid workflow.

**Acceptance criteria:**
- `.did` matches the Rust types exactly (field order/types).
- Frontend typechecks against the regenerated `backend.did.d.ts` (`RevenueReport`,
  `RevenuePeriod` importable).
- `dfx`/build candid check passes.

**Depends:** PB-322. **Blocks:** PB-325.

---

## PB-325 — Frontend: Admin "Revenue" section, period toggle, headline cards

**Scope (`src/frontend/src/Admin.tsx`):**
- Add `'revenue'` to `AdminSection` and a `{ key:'revenue', label:'Revenue',
  icon:'coins' }` entry to `SECTIONS` (after `treasury`).
- State: `period: RevenuePeriod`, `report: RevenueReport | null`. Fetch on
  section-select and on period change (wire into the nav `onClick` like `refreshAudit`).
- **Period toggle**: three `Btn sm`, selected = `variant="primary"`.
- **Headline strip** reusing `StatCard`: Revenue (USD + ICP sub), Expense (USD),
  Operating net (`tone ok|bad`), Treasury (ICP, reuse existing `floorTone`), Cycle
  burn/day + Runway (`tone warn|bad` under threshold). Treasury + runway computed
  client-side from the balances the Treasury section already loads (design §7.3).
- Add `fmtUSD(n) => '$' + (Number(n)/1e8).toFixed(2)` helper (local to Admin or ui.tsx).

**Acceptance criteria:**
- Switching the toggle re-fetches and re-renders the cards.
- All figures use `mono` + CSS vars; net/runway tones correct.
- Loads without error when the report is empty (cards show 0 / "—").

**Depends:** PB-324. **Blocks:** PB-326, PB-327.

---

## PB-326 — Frontend: breakdown tables, net-flow sparkline, top events

**Scope (`Admin.tsx`):**
- **Revenue-by-source** and **Expense-by-category** tables: bucket columns (newest
  first) × source/category rows + total column + Net footer. App `card`/table styling,
  `mono` figures, `fmtICP`/`fmtUSD`.
- Pass-through expense rows under a collapsible "Escrow & principal returns
  (pass-through)" sub-header (reuse the `Section` collapse pattern or a simple toggle).
- **Net-flow sparkline**: dependency-free inline SVG, per-bucket operating net, bars
  `--sprout` positive / `--ember` negative.
- **Top revenue events** list: `formatPrincipal`, kind `Chip`, ICP, USD, relative time.

**Acceptance criteria:**
- Tables render correct per-bucket and total figures matching the backend.
- Sparkline scales to the window and colors by sign.
- Empty window → single muted empty-state line, no broken layout.
- No new chart dependency added.

**Depends:** PB-325.

---

## PB-327 — Frontend: token mix + "About these numbers" caveats

**Scope (`Admin.tsx`):**
- Per revenue cell (or a small stacked bar per bucket): token mix from `by_token`
  (ICP vs ck-tokens) as `Chip`s or a tooltip.
- A `MoreInfo` modal ("About these numbers") listing the design §6 caveats verbatim:
  cycle sweep not logged; withdrawals tracked only from PB-321 onward; audit token
  amounts are ICP-equiv; historical USD uses the current rate; direct deposits ≠
  revenue (balance ≠ revenue total).

**Acceptance criteria:**
- Caveat modal opens from the section header and lists all six items.
- Token-mix UI reads from `by_token` and degrades gracefully to "ICP only".

**Depends:** PB-325.

---

## PB-328 — (OPTIONAL, DEFERRED) Precompute rolling buckets — MemoryId 96

**Scope (only if scan-on-read hits query limits):**
- `REVENUE_BUCKETS: StableBTreeMap<(u8 period, u64 bucket_start), RevenueBucket>` at
  **MemoryId 96** + a `last_folded_audit_index` / `last_folded_payout_id` cell.
- Fold the **tail** since the last index in the existing sweep timer; `get_revenue_report`
  reads precomputed buckets and scans only the current in-progress bucket.
- Upgrade-safe: derivable from the log, rebuildable on first read if absent
  (`#[serde(default)]` everywhere).
- Update the course-nft overview MemoryId table to claim **96** in the same change.

**Acceptance criteria:** report output identical to pure scan-on-read for the same
data; timer fold is incremental (does not rescan the whole log); rebuild-from-empty
works after an upgrade.

**Depends:** PB-322 (do NOT build until profiling justifies it).

---

## PB-329 — Frontend tests + manual verification

**Scope:**
- Vitest: a small render test of the Revenue section with a mocked `get_revenue_report`
  (period toggle switches data; tables/cards render; empty state renders) — see
  `run-tests` (frontend vitest).
- Manual verify locally (skill `icp-local-deploy` / `verify`): seed a few burns +
  payouts (the dev seed helpers already exist, e.g. the payout seeder ~8854), open
  Admin → Revenue, confirm daily/weekly/monthly bucketing, net sign, runway, and the
  caveats modal.

**Acceptance criteria:**
- Vitest green; manual checklist passes against a local deploy with seeded data;
  figures reconcile against the raw audit-log tail already shown in the Governance
  section.

**Depends:** PB-325, PB-326, PB-327.
