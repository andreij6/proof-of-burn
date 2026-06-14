# Admin — Revenue & Expense Dashboard (PB-320, design doc)

> A new **Admin → Revenue** section that turns the canister's `AUDIT_LOG` + `PAYOUTS`
> journals into a daily / weekly / monthly **P&L** for the Caldera platform:
> revenue by source, expense by category, net, treasury-balance context, and
> cycle-runway. This doc is grounded in the actual backend (`src/backend/src/lib.rs`)
> and the existing admin UX (`src/frontend/src/Admin.tsx`); the companion
> [`tasks.md`](tasks.md) is the implementation-ready breakdown.

---

## 1. Motivation

Today an admin can see the **treasury balances** (per-token, `Admin.tsx` Treasury
section) and scroll a raw **audit-log tail** (last 1000 entries via `get_audit_log`).
There is no way to answer the questions an operator actually has:

- *How much did the platform earn last week, and from what?*
- *What did we spend — payouts, refunds, cycle top-ups, withdrawals?*
- *Are we net-positive? Is the trend up or down?*
- *At the current cycle burn rate, how long until the treasury floor?*

The data already exists — every money-moving flow writes an `AuditLogEntry` and/or a
`Payout` record. We just need a **period-bucketed aggregation query** over those two
journals plus a clean admin surface. This is read-only reporting: no new money flows,
no migrations of existing data, no risk to value-moving code.

The economics docs (`docs/ECONOMICS_PLAYBOOK.md`, `GROWTH_TARGETS.md`, `OPS.md`)
already frame the model around *burn revenue → treasury, 25%+25% → cycles*, and the
`OPS.md` runway concern. This dashboard makes those numbers observable in-product
rather than only reconstructable from raw logs.

---

## 2. Source of truth: the two journals

Two stable structures already record essentially every value movement. **The audit
log is the canonical source of truth** for inflows-from-users and on-chain events; the
payout journal is the canonical source for outflows-to-users.

### 2.1 `AUDIT_LOG: Log<AuditLogEntry>` (append-only)

```rust
pub struct AuditLogEntry {
    pub timestamp: u64,   // nanos
    pub event_type: String,
    pub proposal_id: u64, // overloaded ref id (proposal / month / draw / tier …)
    pub user: Principal,  // get_canister_id() for system events
    pub amount_e8s: u64,  // ICP e8s for ICP flows; oracle-ICP-equiv for token commits
}
```

Helpers that append: direct `AUDIT_LOG.with(...)` at many call sites and
`staking_audit(event_type, user, amount_e8s, ref_id)` (lib.rs ~6528). Read via
`get_audit_log(offset, limit)` (lib.rs ~4639, capped 1000/call).

### 2.2 `PAYOUTS: StableBTreeMap<u64, Payout>` (MemoryId 38)

```rust
pub enum PayoutType { LotteryWin, UnstakeDisbursement, IdeaUpvoteShare,
                      CommitmentRefund, PoolReward, EarlyAdopterYield }
pub struct Payout { id, user, payout_type, token: IdeaToken, amount, created_at, ref_id }
```

Written by `record_payout(...)` (lib.rs ~8217). **Crucially `Payout` carries a real
`token` field** (ICP / ckBTC / ckETH / ckUSDC / ckUSDT), so outflows are token-typed.
The audit log does *not* carry a token field — see §5.

---

## 3. Revenue / Expense taxonomy (mapped to actual records)

The economic model is summarised authoritatively in the Admin "Treasury & cycles"
reference (`Admin.tsx` ~974): *"Treasury inflows: 50% of burns, 50% of staking yield,
50% of Perm-neuron yield, idea post fees, project funding, verified-follower
initiation fees, explorer and arcade payments. Cycles: 25% of each burn tops up each
canister via the CMC."* The taxonomy below makes that precise per record.

### 3.1 REVENUE — inflows that increase platform net worth

A burn is the canonical example: the user's escrow is consumed and **50% lands in the
treasury** (the other 50% becomes cycles — see expense §3.2). So the *revenue* booked
for a burn is **half** the `amount_e8s` on the `"burn"` audit entry.

| Revenue source | Record | event_type / PayoutType | Amount to book as revenue | Notes |
|---|---|---|---|---|
| **Burn — treasury share** | AUDIT_LOG | `"burn"` | `amount_e8s / 2` | `settle_burn_split` 50/25/25 (lib.rs ~2406). The 25%+25% are cycles, not treasury. |
| **Idea post fee** | AUDIT_LOG | `"idea_post"` | `amount_e8s` (1 ICP, `IDEA_POST_FEE_E8S`) | 100% to treasury (lib.rs ~5394). |
| **Project funding** | AUDIT_LOG | `"project_fund"` | `amount_e8s` | 100% to treasury; **token-typed** (ICP/ckBTC/ckETH) — audit amount is ICP-equiv only (see §5). |
| **Idea upvote share — house cut** | AUDIT_LOG | `"idea_upvote"` | poster-share is paid out; remainder to treasury | The poster gets `IdeaUpvoteShare` (expense); the rest is house revenue. Token-typed. |
| **Verified-follower initiation fee** | AUDIT_LOG | `"pool_register"` | `amount_e8s` (split 50/25/25) | Treasury share = `amount_e8s / 2`; 25%+25% cycles (mirrors burn). lib.rs ~2798. |
| **Dapp Explorer listing** | treasury transfer (no dedicated revenue audit row) | — | quoted USD→token amount | `submit_dapp` moves the payment straight to treasury (lib.rs ~9878). **Gap: no audit row** — see §6. |
| **Arcade customize** | AUDIT_LOG | `"arcade_customize"`, `"arcade_customize_kicker"` | `amount_e8s` ($1 USD, token-typed) | 100% to treasury (lib.rs ~10506 / ~10570). |
| **Course mint fee** (course-nft) | settle_burn_split via MINT_ESCROW_TAG | `"burn"` w/ mint tag, or mint saga | 0.5 ICP, split like a burn | Lands via the same split machinery (lib.rs ~14221). Treasury share = half. |
| **Course sale — house cut** (course-nft) | `COURSE_SALES` saga | (sale split 75/10/5/5/5) | the platform's 5–10% slice | Not an audit `event_type`; lives in the sale-saga records — see §6. |
| **Featured-slot bid** (course-nft) | treasury transfer | — | 100% of bid (token-typed, non-refundable) | Per spec 08; no audit row by default — see §6. |
| **Direct treasury deposit** | ledger only | — | n/a | Admin/external top-ups (`get_treasury_deposit_address`). Shows in balance, **not** a revenue event — exclude from "earned revenue" or tag as `ExternalDeposit`. |

> **Locked rule:** for split flows (`burn`, `pool_register`, course `mint`), book only
> the **treasury share** (`amount / 2`) as revenue; the cycle shares are tracked as the
> cycle-expense line so they are not double-counted.

### 3.2 EXPENSE — outflows that decrease platform net worth

| Expense category | Record | source | Amount | Notes |
|---|---|---|---|---|
| **Cycle top-ups (burn 25%+25%)** | derived from AUDIT_LOG `"burn"` | `amount_e8s/2` (the two CMC legs) | per burn | The platform's main *recurring* expense. Recorded as the CMC legs of `settle_burn_split`; book the non-treasury half of every burn here. |
| **Cycle top-ups (initiation 25%+25%)** | derived from `"pool_register"` | `amount_e8s/2` | per registration | Same split mechanics. |
| **Lottery prizes** | PAYOUTS | `LotteryWin` | `amount` (ICP) | Paid from the lottery pot, funded by yield (lib.rs ~8452). |
| **Pool rewards** | PAYOUTS | `PoolReward` | `amount` (ICP) | The 25% of each burn split to top verified-follower owners — *but* this comes out of the **treasury**, so it IS a treasury expense (lib.rs ~1081). |
| **Idea upvote shares** | PAYOUTS | `IdeaUpvoteShare` | `amount` (token-typed) | Poster's cut of upvote fees (lib.rs ~5452). |
| **Early Adopter yield** | PAYOUTS | `EarlyAdopterYield` | `amount` (ICP) | Claimed monthly yield share. |
| **Commitment refunds** | PAYOUTS | `CommitmentRefund` | `amount` (token-typed) | Abstained / failed-vote escrow returns (lib.rs ~4222). Pass-through, not a true cost — flag as such (§3.3). |
| **Unstake disbursements** | PAYOUTS | `UnstakeDisbursement` | `amount` (ICP) | Lossless-stake principal returns (lib.rs ~7501). **Pass-through** (the principal was never revenue) — flag. |
| **Admin treasury withdrawals** | AUDIT_LOG / call | `admin_withdraw_treasury(_token)` | `amount_e8s` | Currently **no dedicated audit row** — see §6. Should be booked as an expense/transfer-out. |
| **Ledger fees fronted by treasury** | implicit | 10_000 e8s per leg | per transfer | Zero-fee commits mean the treasury fronts every split/refund fee (lib.rs ~2410). Small but real; estimate, don't try to reconstruct exactly. |
| **Cycle sweep (treasury→cycles)** | sweep timer | — | variable | When backend dips below 5T, treasury ICP auto-converts. Not in audit log — see §6. |

### 3.3 NET and the pass-through caveat

```
Gross revenue   = Σ revenue lines (§3.1)
Gross expense   = Σ expense lines (§3.2)
Net             = Gross revenue − Gross expense
```

**Pass-through flows** (`CommitmentRefund`, `UnstakeDisbursement`) move money the
platform never *earned* — they are escrow/principal returns. The report must let the
admin see **both** a "Net incl. pass-throughs" and a **"Operating net"** that excludes
them, so a big day of unstakes doesn't read as a loss. Treat them as a clearly-labelled
`PassThrough` expense subgroup, excluded from operating net by default.

---

## 4. The metric set (what the dashboard shows)

### 4.1 Periods

A single **period toggle**: **Daily / Weekly / Monthly**, plus an explicit
window (e.g. last 30 days, last 12 weeks, last 12 months). Bucketing is by UTC
calendar boundary derived from `timestamp` nanos:

- day bucket: `ts / 1e9 / SECS_PER_DAY`
- week bucket: ISO-ish, `(day + 4) / 7` (the codebase already uses the `(day + 4) % 7`
  epoch-weekday trick for lottery draw days, lib.rs ~8203 — reuse it for consistency).
- month bucket: derive `(year, month)` from the day (civil-from-days).

### 4.2 Per-period cards (the headline strip — reuse `StatCard`)

For the **currently selected period bucket** (e.g. "this week"):

1. **Revenue** (USD-normalised total, with ICP sub-figure)
2. **Expense** (USD-normalised total)
3. **Operating net** (revenue − expense, excl. pass-throughs) — tone `ok`/`bad`
4. **Treasury balance now** (ICP, with the 15-ICP floor tone, reusing the existing
   `floorTone` logic) — context, not a period figure
5. **Cycle burn rate** (cycles/day, from the burn-share expense) + **runway**
   (treasury ICP ÷ daily cycle cost, in days) — the OPS.md runway metric

### 4.3 Breakdown table (the body)

A two-section table for the selected window, newest bucket first:

- **Revenue by source** — rows = each source in §3.1, columns = per-period amounts
  across the window (e.g. 12 weekly columns) + a total column. USD-normalised, with a
  token-mix tooltip per cell.
- **Expense by category** — rows = each category in §3.2 (pass-throughs grouped and
  collapsible), same column layout.
- A **Net** row at the bottom of each, and a combined Net row.

### 4.4 Trend + extras

- **Treasury-balance trend** is *not* reconstructable from the journals alone
  (deposits/withdrawals/sweeps aren't all logged) — show the **current** balance and a
  *derived* "net-flow per period" sparkline (Σ revenue − Σ expense per bucket) instead,
  clearly labelled as flow, not balance. (Optional later: snapshot balances on a timer.)
- **Top revenue events** for the window: the N largest single `"burn"` / funding /
  bid records, with user (formatted principal), amount, USD, and timestamp — drawn
  straight from the journals.
- **Multi-token mix**: a small per-period stacked bar of revenue by token (ICP vs
  ck-tokens) so the operator sees how much is non-ICP.

---

## 5. Multi-token handling & USD normalisation

Three token realities the report must respect:

1. **`Payout.token` is authoritative** for outflow currency. Sum each `PayoutType`
   **per token**, then normalise.
2. **The audit log is ICP-denominated.** For ICP flows `amount_e8s` is exact. For
   **token commitments / token fundings / token upvotes / arcade**, the audit
   `amount_e8s` holds the **oracle ICP-equivalent at the time of the event** (see the
   `Commitment.amount_e8s` doc-comment at lib.rs ~321 and `commit_token` at ~2924),
   *not* the native token amount. The token-native amounts live in the side journals
   (`IDEA_UPVOTES.token/amount`, `PROJECT_FUNDINGS.token/amount`). For a faithful
   token-mix breakdown, **join** revenue rows to those journals by ref_id where a token
   breakdown matters; otherwise the ICP-equiv in the audit log is sufficient for the
   USD total.
3. **USD normalisation via the XRC oracle.** Reuse the existing cached-rate helpers —
   `icp_amount_usd_e8s(amount_e8s)` (lib.rs ~3949) and
   `token_amount_usd_e8s(token, amount)` (~3956). Both read the XRC-cached rate
   (`cached_usd_rate_e8s`). The report query should **normalise on read** using the
   *current* cached rate (cheap, no async per row), and clearly label that historical
   USD figures use the latest rate, not the rate at event time (a known approximation;
   booking per-event historical USD would require persisting the rate per record).

USD figures are in **USD e8s** (the codebase convention, `USD_E8S_PER_USD`). Frontend
divides by 1e8 and formats as `$x.xx`.

---

## 6. Data-source caveats (be honest in the doc + the UI)

These are real gaps. The dashboard should render an "About these numbers" `MoreInfo`
note enumerating them so an operator never over-trusts a figure:

1. **Cycle costs are not fully in the audit log.** The burn/registration cycle legs are
   derivable (the non-treasury split halves), but **the treasury→cycles sweep** (when
   backend dips below 5T) and any manual cycle ops are **not** journaled. Cycle burn
   rate from burns is a *lower bound* on true cycle spend.
2. **Admin withdrawals have no audit row** (`admin_withdraw_treasury` /
   `_token`, lib.rs ~3404). The report can't see them today → **recommend adding an
   audit `event_type: "treasury_withdraw"` row** (a tiny, safe addition; see tasks
   PB-321). Until then, label withdrawals "not tracked".
3. **Explorer listings, course sales, featured bids** move money to the treasury
   *without* a dedicated revenue `event_type` (they go straight via ledger transfer or
   live only in their saga maps). Either (a) add audit rows in those flows, or (b) have
   the report read the `DAPPS` / `COURSE_SALES` / `FEATURED_SLOT` journals directly.
   The tasks doc takes approach (a) for explorer + a journal-read for course-nft
   (cross-canister, deferred until those features ship).
4. **Token amounts in the audit log are ICP-equiv, not native** (§5.2).
5. **Historical USD uses the current rate** (§5.3).
6. **Direct deposits inflate the treasury balance but are not earned revenue** — the
   balance card and the revenue total are intentionally different numbers.

Document each caveat inline next to the figure it affects.

---

## 7. Backend aggregation design

### 7.1 Scan-on-read vs precomputed counters — recommendation: **scan-on-read**

The `AUDIT_LOG` is a `Log` and `PAYOUTS` a `StableBTreeMap`. For a reporting query the
question is whether to **scan and bucket on each call** or **maintain rolling
per-period counters** incremented at each write.

**Recommendation: scan-on-read for v1**, bounded by a `since` timestamp (the query
takes a window) and a hard cap. Rationale:

- The report is **admin-only and infrequent** — it is not on a hot path. A few thousand
  log entries per call is well within a query's instruction budget.
- Precomputed counters mean touching **every** value-moving call site to increment a
  bucket — exactly the high-risk, value-moving code we want to leave alone. Scan-on-read
  adds **zero** new write-path code.
- Buckets are derived purely from `timestamp`, so a read-time scan is correct with no
  migration and no upgrade-safety concern.

**When to revisit:** if the log grows past ~50–100k entries and the query approaches
the cycle limit, add an incremental aggregator (a timer that folds new entries into a
`StableBTreeMap<PeriodKey, PeriodBucket>` and only scans the tail since the last fold).
Reserve **MemoryId 96** for that future `REVENUE_BUCKETS` map (see §7.4) — *but do not
create it for v1*. The query first reads precomputed buckets if present, else scans.

> **MemoryId note:** the course-nft overview reserves backend MemoryIds through ~89
> (0–87 used, 88–89 reserved). Per the planning instruction, this feature claims the
> **96+** band to stay clear of any in-flight allocations. v1 needs **none**; only the
> optional precompute path (§7.4) would claim **96**.

### 7.2 Candid query shape

```candid
type RevenuePeriod = variant { Daily; Weekly; Monthly };

type TokenAmount = record { token : IdeaToken; amount : nat64 };

type RevenueLine = record {
  source     : text;            // "burn" | "idea_post" | "project_fund" | …
  e8s_icp    : nat64;           // ICP-equiv total (from audit log)
  usd_e8s    : nat64;           // USD-normalised (current cached rate)
  by_token   : vec TokenAmount; // native token mix where known (else just ICP)
};

type ExpenseLine = record {
  category    : text;           // "cycle_topups" | "LotteryWin" | "PoolReward" | …
  e8s_icp     : nat64;
  usd_e8s     : nat64;
  by_token    : vec TokenAmount;
  pass_through : bool;          // true for refunds / unstake disbursements
};

type RevenueBucket = record {
  // Period key, both machine + human:
  start_ts    : nat64;          // bucket start, nanos UTC
  label       : text;           // "2026-06-08" | "2026-W23" | "2026-06"
  revenue     : vec RevenueLine;
  expense     : vec ExpenseLine;
  revenue_usd_e8s        : nat64;
  expense_usd_e8s        : nat64;
  operating_net_usd_e8s  : int64;   // excl. pass-through
  net_incl_passthrough_usd_e8s : int64;
};

type TopEvent = record {
  kind : text; user : principal; e8s_icp : nat64; usd_e8s : nat64; timestamp : nat64;
};

type RevenueReport = record {
  period          : RevenuePeriod;
  buckets         : vec RevenueBucket;     // newest first, window-bounded
  treasury_icp_e8s : nat64;                // current balance, context
  treasury_usd_e8s : nat64;
  cycle_burn_e8s_per_day : nat64;          // derived from burn-share window
  runway_days     : nat64;                 // treasury_icp / daily cycle cost
  top_events      : vec TopEvent;
  generated_at    : nat64;
  rate_caveat     : bool;                  // true ⇒ USD uses current rate, not historical
};
```

Endpoint (admin-guarded, **query** — but balance is async so the *balance* fields are
filled by a thin update wrapper, see §7.3):

```rust
#[ic_cdk::query(guard = "require_admin")]
fn get_revenue_report(period: RevenuePeriod, window: u32) -> RevenueReport
```

`window` = number of buckets to return (cap e.g. 60). The query scans `AUDIT_LOG`
back to the oldest bucket start in the window and `PAYOUTS` filtered by `created_at`.

### 7.3 Treasury balance & runway (the one async bit)

`get_treasury_balance` is an **update** (it calls the ledger). Two clean options:

- **A (recommended):** keep `get_revenue_report` a pure **query** that returns
  `treasury_icp_e8s = 0` / `runway_days = 0` as "unknown", and have the frontend fill
  the balance from the **existing** `get_treasury_balance` / per-token balance reads it
  already does in the Treasury section. Compute runway client-side. Zero new async code.
- **B:** add `get_revenue_report_full()` as an **update** that awaits the balance then
  calls the shared aggregation helper. More self-contained but makes the report an
  update call.

Go with **A** for v1: the dashboard already has balances in scope.

### 7.4 Optional precompute (deferred — do not build for v1)

If/when needed: `REVENUE_BUCKETS: StableBTreeMap<(PeriodKind,u64 bucket), Bucket>` at
**MemoryId 96**, folded by the existing sweep timer (append-only log ⇒ only fold the
tail since `last_folded_index`). The query prefers buckets, falls back to scan for the
current (in-progress) bucket. Upgrade-safe: derivable, so it can be rebuilt from the
log on first read if absent.

### 7.5 Aggregation helper (native-testable)

Factor the bucketing into a **pure function** over slices so it has a native mock seam
(per repo convention, lib.rs value-moving logic needs native tests):

```rust
fn aggregate_report(
    audit: &[AuditLogEntry],
    payouts: &[Payout],
    upvotes_by_ref: &HashMap<u64, (IdeaToken, u64)>,  // for token mix
    fundings_by_ref: &HashMap<u64, (IdeaToken, u64)>,
    period: RevenuePeriod,
    now: u64,
    icp_usd_rate_e8s: u64,
    token_usd_rates: &[(IdeaToken, u64)],
) -> Vec<RevenueBucket>
```

Pure → unit-testable with synthetic entries, no ledger/oracle calls.

---

## 8. Admin UI design (fits existing `Admin.tsx`)

### 8.1 New section

Add a section to the `SECTIONS` array and `AdminSection` union:

```ts
{ key: 'revenue', label: 'Revenue', icon: 'coins' },
```

(`coins` already exists in `ui.tsx` `iconPaths`.) Slot it right after `treasury` in the
nav so finance lives together. Loads its report on section-select, same pattern as
`refreshAudit()` is wired into the nav `onClick`.

### 8.2 Layout (top → bottom)

1. **Period toggle** — three `Btn` (sm) Daily / Weekly / Monthly, the selected one
   `variant="primary"` (mirrors the section-nav pattern). Re-fetches on change.
2. **Headline `StatCard` strip** (reuse `StatCard`, the existing wrap-flex row): the
   five §4.2 cards. Net card uses `tone='ok' | 'bad'`. Runway card uses
   `tone='warn'/'bad'` when runway < N days.
3. **Net-flow sparkline** — a lightweight inline SVG (no chart dep) of operating net
   per bucket across the window; bars colored `--sprout` (positive) / `--ember`
   (negative). Keep it dependency-free and small, like the existing inline SVGs.
4. **Revenue-by-source table** + **Expense-by-category table** — bucket columns
   (newest first), source/category rows, a total column, a Net footer row. Use the
   app's table/`card` styling and `mono` for figures; `fmtICP` for ICP and a
   `fmtUSD` helper (`$ ${(n/1e8).toFixed(2)}`). Token mix shown as a small `Chip`
   row or a tooltip per revenue cell. Pass-through expense rows grouped under a
   collapsible "Escrow & principal returns (pass-through)" sub-header.
5. **Top revenue events** — a compact list: formatted principal, kind `Chip`, ICP,
   USD, relative time.
6. **"About these numbers"** — a `MoreInfo` modal enumerating the §6 caveats verbatim
   (cycle sweep not logged, withdrawals not tracked until PB-321, token amounts are
   ICP-equiv, USD uses current rate, direct deposits ≠ revenue).

### 8.3 Accessibility / consistency

- Use the existing CSS vars and tones (`--sprout`/`--ember`/`--haze`) so it passes the
  light-mode contrast bar the repo already enforces (`ui-copy-in-sync` /
  `frontend-dev` skills).
- All figures `mono`; never hard-code colors outside the var palette.
- Empty state (no events in window): a single muted line, not a broken table.

---

## 9. Out of scope (v1)

- Per-canister cycle accounting beyond the burn-derived estimate (needs the management
  canister + the sweep to journal — future).
- Course-nft revenue (mint/sale/featured) until those features land in this branch;
  the taxonomy reserves slots so it slots in later via a cross-canister read or added
  audit rows.
- CSV export, historical-rate-accurate USD, and balance snapshots over time (all
  listed as natural follow-ups).
