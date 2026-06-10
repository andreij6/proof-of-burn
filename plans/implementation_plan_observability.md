# Observability — Bug Reports & Admin Health Metrics — Implementation Plan

## What this feature is

Two halves of the same job: **keeping the app healthy now that real users
(and real ICP) are on mainnet.**

1. **User bug reports, on-chain.** A lightweight "Report a problem" flow any
   signed-in user can file from the app. Reports land in canister storage,
   show up in the Admin console with triage state, and cost the user nothing
   (rate-limited instead of fee-gated).
2. **Admin health metrics.** One `get_admin_metrics` call (and an Admin
   console "Health" section rendering it) that answers, at a glance: is money
   moving correctly, is anything stuck, is usage growing or dying — without
   ssh-ing into dashboards or replaying audit logs by hand.

Context that motivates this: the protocol now has five money-moving
subsystems (burn commitments, pool rewards, 3-tier staking, lottery, R&D
payments), all saga-based with retry queues. Every one of those queues is a
place where value can silently sit "stuck" today, visible only by manually
querying state. The owner cannot manually test after every change — the
canister should report on itself.

## Decisions to lock in (owner veto points)

1. **Bug reports are free but rate-limited** — 1 ICP fees would kill the
   signal we want most (confused new users). Limit: 3 open reports per
   principal, 280-char title + 2,000-char body, max 500 stored (oldest
   resolved reports pruned). No anonymous reports.
2. **Reports are NOT public** in v1 — listing is admin-gated (a public
   roadmap/issues view can come later; private-by-default avoids leaking
   security-sensitive reproduction steps).
3. **Metrics are computed on demand**, not sampled into time series. v1 is a
   snapshot endpoint; trend history comes from the off-chain monitor cron
   (scripts/monitor.sh already exists) appending snapshots to a CSV/sheet.
   On-chain time-series storage is explicitly out of scope for v1.
4. **No new external dependencies** — everything derives from state the
   canister already holds (audit log, saga journals, maps).
5. Feature flag: `bug_reports` (default ON — it's free and harmless;
   kill-switchable like everything else).

## Backend design

### Bug reports (memory IDs 40–41; 42–45 reserved for this epic)

```
BugStatus     = variant { Open; Acknowledged; Resolved; Wont fix → WontFix }
BugReport     = record {
  id : nat64;
  reporter : principal;
  title : text;            // ≤ 280 chars
  body : text;             // ≤ 2,000 chars; steps to reproduce
  page : text;             // which page the user was on (frontend fills it)
  created_at : nat64;
  status : BugStatus;
  admin_note : text;       // triage note, visible to the reporter
  updated_at : nat64;
}
```

Endpoints:
* `report_bug(title, body, page) -> Result<nat64>` — authenticated; rejects
  when the caller already has 3 reports in `Open`/`Acknowledged`.
* `get_my_bug_reports() -> vec BugReport` — reporter's own, with status +
  admin note (closes the loop: users see their report was acted on).
* `admin_list_bug_reports(filter: opt BugStatus) -> vec BugReport`.
* `admin_set_bug_status(id, BugStatus, note) -> Result`.
* Pruning: on insert past 500, drop oldest `Resolved`/`WontFix` first; never
  drop open reports (insert fails with `REPORTS_FULL` instead — that itself
  is a signal the admin must triage).

### Health metrics — `get_admin_metrics() -> AdminMetrics` (admin-gated)

One record, grouped by the question it answers:

**Is money stuck?** (each of these should be 0 in a healthy system)
* `failed_burns`, `failed_refunds` — commitments in `FailedBurn`/`FailedRefund`.
* `upvotes_failed`, `fundings_failed` — R&D sagas parked in `FailedPayout`.
* `unstakes_awaiting_dissolve`, `unstakes_missing_fee_refund` — Disbursed
  rows with `fee_refund_block = null` (treasury empty / transfer failing).
* `lottery_payouts_pending` — draws stuck in `PayoutPending`.
* `yield_distributions_in_progress` + age of the oldest one.
* `oldest_stuck_saga_age_ns` — max age across all of the above (the single
  number worth alerting on).

**Are the balances sane?**
* `treasury_e8s`, `lottery_pot_e8s`, `yield_inbox_e8s` (ledger reads — this
  makes the endpoint an update, mirroring `get_treasury_balance`).
* `cycle_balance`, `frontend_cycles_unknown: bool` (frontend canister cycles
  aren't readable from the backend in v1 — monitor.sh covers it off-chain).
* `treasury_fee_float_days` — treasury balance ÷ recent fee-cover spend rate
  (zero-loss staking dies with `TREASURY_FEE_COVER` if this hits 0).

**Is anyone using it?**
* `active_principals_7d` / `30d` — distinct users in the audit-log window.
* `commitments_open`, `tvl_e8s`, `total_staked_e8s` (per tier),
  `stakers_per_tier`, `tickets_this_round`, `claimers_today`,
  `ideas_active`, `upvotes_7d`, `bug_reports_open`.

Implementation note: counts come from single passes over the relevant maps
(all bounded) plus a capped tail scan of the audit log (same pattern as
`get_my_transactions`'s `TX_AUDIT_SCAN`).

### Off-chain alerting (extends scripts/monitor.sh)

Cron calls `get_admin_metrics` (admin identity) every 10 min and alerts when:
* `oldest_stuck_saga_age_ns` > 1 hour (a retry queue isn't draining),
* `cycle_balance` < 10T (existing PB-102 threshold),
* `treasury_fee_float_days` < 7,
* `bug_reports_open` increases.
Each snapshot appended to `metrics.csv` → free trend history.

## Frontend design

* **"Report a problem"** — small link in the nav drawer footer (signed-in
  only). Modal: title, what happened, auto-filled current page. Confirmation
  shows the report id. "My reports" list with status chips on the Profile
  page.
* **Admin console → Health section** (top of the page, above controls):
  - Stuck-money strip: red badges for any non-zero failure counter, each
    with a one-click "run sweep now" (`admin_trigger_sweep`).
  - Balances strip: treasury / pot / inbox / cycles with the fee-float gauge.
  - Usage strip: actives, TVL, stake per tier, tickets, claimers.
  - Bug triage table: filter by status, expand → set status + note.

## Task breakdown (PB-190 … PB-196)

| Task | Scope |
|---|---|
| PB-190 | BugReport storage + report/list/status endpoints + rate limits + pruning + unit tests |
| PB-191 | `get_admin_metrics` (stuck-saga counters + balances + usage) + unit tests |
| PB-192 | Admin console Health section (badges, balances, usage strips) |
| PB-193 | Report-a-problem modal + Profile "My reports" + nav entry |
| PB-194 | monitor.sh: metrics polling, CSV append, alert thresholds |
| PB-195 | Candid/bindings/OPS runbook ("Health & triage" section) |
| PB-196 | Exhaustive tests to hold the ≥90% coverage gate; local smoke; deploy |

## Out of scope (v1)

* On-chain time-series / charts (off-chain CSV covers trends).
* Public bug board / upvoting bugs.
* Frontend-canister cycle telemetry from the backend.
* Automatic anomaly detection — thresholds are static and admin-tuned.

## Open questions for the owner

1. Should resolved bug reports auto-notify the reporter beyond the Profile
   status chip (e.g., a banner on next visit)?
2. Alert delivery for monitor.sh — email, Telegram, or just terminal/cron
   mail? (Determines PB-194's last mile.)
3. Is 3 open reports per principal the right cap, or should tier-3 users
   (proven burners) get more?
