---
type: idea
title: "03 — Risks, gates & open questions"
tags: [ideas, lottery-fcm-reminder]
timestamp: 2026-06-20T04:38:29-04:00
---

# 03 — Risks, gates & open questions

## R1 — FCM tokens on a public ledger are scrapable

IC canister state is public. If `list_push_tokens()` is a public query, anyone can
pull every registered token and push arbitrary messages to those devices through
*your* Firebase project. Severity: spam/abuse, **not** funds (FCM tokens are scoped to
one project; a leaked token can't move money). Mitigations:

- **`list_push_tokens()` is admin-only.** The scheduler authenticates with an admin
  (or dedicated `scheduler`) principal. Anonymous can't enumerate.
- A per-Principal cap (`MAX_PUSH_TOKENS = 8`) bounds the registry size.
- Rate-limit `register_push_token` per caller (e.g. 5/hour) so a bot can't spam-fill
  the map.
- Accept the residual: even admin-gated, the tokens *are* on-chain — a determined
  actor with an admin principal (compromise) could exfiltrate. If that's
  unacceptable, choose **Q1 option D** (tokens off-chain, canister stores only opaque
  subscription_ids).

## R2 — The off-chain scheduler is a new operational surface

Cloud Run + Cloud Scheduler + a service account + secret manager + monitoring. New
failure modes (scheduler down, secret rotated, cron misfired) the canister can't
self-heal. Mitigations:

- Stateless scheduler: all state is either on-chain (`next_draw_at`, token list) or
  idempotency-keyed in Firestore (`fired[next_draw_at]`). A redeploy loses nothing.
- Alert on: cron hasn't run in 10 min, FCM error rate > 5%, canister query failing.
- The canister keeps working without the scheduler — a dead scheduler just means no
  pushes, not a broken lottery. Blast radius is exactly "reminders stop."

## R3 — Notification permission fatigue + browser variance

`Notification.permission.request()` is a one-shot, in-context prompt; calling it on
page load (before the user toggles) gets it blocked permanently in Chrome. Mitigations:

- Only request on explicit toggle click (the design above).
- iOS Safari 16.4+ supports web push but requires the site be installed to Home
  Screen (a PWA manifest). If iOS is a target, add a minimal `manifest.webmanifest`
  + an "Add to Home Screen" hint. v1 can defer iOS and ship desktop/Android first —
  document the gap.
- Firefox uses Mozilla's autopush, not FCM, but the FCM JS SDK + service worker still
  works via the standard Push API (Firebase wraps it). Verify in smoke.

## R4 — Timing drift / rollover edge

`next_draw_at` jumps forward when a draw rolls over (pot < 25 ICP). The scheduler
polls every 5 min and keys idempotency on `next_draw_at`, so a rollover produces a new
key and the reminder fires for the *new* draw. Risk: a draw that rolls over *inside*
the last hour (e.g. at T-30m the pot is still < 25 ICP so `next_draw_at` jumps to the
next day) — a reminder may have already fired for the original `next_draw_at` (now
cancelled). Acceptable: a "draws in 1h" push for a draw that then rolls over is a
minor false alarm; the user opens the app and sees the real state. Document; don't
over-engineer.

## R5 — Identity/credential hygiene for the scheduler

The scheduler holds a Firebase service-account key (RS256) and an admin principal
for the canister. If the scheduler is compromised, the attacker can (a) push
arbitrary messages to all registered devices, (b) call admin canister endpoints as
that principal. Mitigations:

- Service-account key in Cloud Run secret manager, rotated; scope the key to FCM
  only (not full project owner).
- Use a **dedicated `scheduler` principal** (a fresh II identity added to
  `config.admins`) — not a shared admin. Compromise is contained to FCM + the
  read-only-ish `list_push_tokens`. Better: add a narrow `scheduler` role that can
  *only* call `list_push_tokens`, not all admin endpoints (see Q3).
- The canister admin list change is a mainnet-deploy-gated action.

## R6 — Token staleness

Devices uninstall the app / clear storage → their FCM token goes stale; FCM returns
404 on send. The registry grows with dead tokens. Mitigations:

- On FCM 404, the scheduler prunes (if it can act for the user — see Q1/Q3) or marks
  the token dead in its own DB; a nightly reconcile prunes tokens not successfully
  sent in 60d.
- Add an `admin_prune_push_tokens(stale_before: u64)` admin endpoint for manual
  cleanup. Keep it simple for v1.

## Build gates (must be true before shipping)

- [ ] `backend.did` regenerated + `bindings/` updated; `tsc -b` clean.
- [ ] `register_push_token` rejects when `lossless_lottery` flag is off (or —
      decision — is un-gated like reclaim so opt-in works regardless of the lottery
      kill switch; see Q4). Decide and implement consistently.
- [ ] `list_push_tokens()` is admin-gated; anonymous call is rejected (verify via
      `icp canister call` as anon).
- [ ] Per-Principal token cap enforced (`TOO_MANY_DEVICES`); rate-limit on register.
- [ ] Frontend: SW loads at `/firebase-messaging-sw.js`; `getToken` succeeds on
      desktop Chrome; toggle persists across reloads via `get_my_push_tokens`.
- [ ] Foreground `onMessage` shows the reminder when the tab is open.
- [ ] Scheduler: 5-min poll reads `next_draw_at`; fires exactly once per draw
      (idempotency verified by running two consecutive ticks for the same draw);
      FCM 404 prunes the token.
- [ ] Notification click lands on `/lottery`.
- [ ] No service-account key or VAPID *private* key in the frontend bundle (only the
      public VAPID key, via `get_lottery_info`).

## Open questions

### Q1 — Token storage on-chain vs off-chain (scope-defining)

**On-chain (Q1-C):** canister stores `Principal → Vec<FCM token>`; scheduler reads via
admin `list_push_tokens()`. Simpler, one source of truth, no DB to operate. Risk:
tokens are public-on-chain (R1). **Off-chain DB (Q1-D):** canister stores
`Principal → Vec<subscription_id>`; a Firestore collection stores
`subscription_id → token`; scheduler joins. More infra, but tokens never touch the
chain. **Recommendation: ship Q1-C for v1** (the spam-only severity doesn't justify a
DB), with admin-gated listing + the per-Principal cap. Revisit to Q1-D if a
privacy-sensitive feature later wants the same plumbing.

### Q2 — Notification content: static vs personalized

Static ("draws in 1h, claim today's ticket") needs only `next_draw_at` — no per-user
fetch. Personalized ("you have N tickets this round", "you haven't claimed today")
needs the scheduler to call a per-Principal query for each registered user (batch).
Personalization materially improves CTR but multiplies the scheduler's canister calls.
**Recommendation: static for v1; add personalization as a v1.1 once we see opt-in
volume.** The `claimed_today` flag already exists on `LotteryInfo` per-caller — cheap
to add per-user once we decide.

### Q3 — A narrow `scheduler` role instead of full admin

Giving the scheduler a full admin principal is over-privileged. Add a dedicated
`SCHEDULER_PRINCIPALS` config list + a guard `require_scheduler` that gates *only*
`list_push_tokens`. Cleaner blast radius (R5). **Recommendation: do it** — it's ~15
lines and meaningfully reduces the scheduler's power. Pairs with Q1-C.

### Q4 — Gate `register_push_token` on the lottery flag, or not?

`reclaim_escrow` is deliberately un-gated (stranded-funds recovery must survive a kill
switch). Is opt-in the same — should a user be able to register for reminders even if
the lottery is temporarily off? **Recommendation: gate it on `lossless_lottery`** —
unlike reclaim, there's no trapped-funds rationale; reminders for a disabled feature
are noise. If the flag is off, the toggle shows "lottery is paused" and hides.

### Q5 — Browser-only, or also email/SMS later?

FCM is web/mobile-web push only. If the user base skews toward users who'd want email
(or SMS for the T-1h urgency), this plumbing doesn't cover them. **Recommendation: out
of scope for this idea** — note it as a future "notification preferences" surface that
would abstract over channels (push/email/SMS) and reuse this opt-in registry.

### Q6 — Other reminders on the same plumbing?

X-Farm depleted, proposal-discussions reply, a settled commitment payout — these are
natural follow-ons. **Recommendation: build this as lottery-only but structure the
scheduler + registry so a second reminder type is an additive `NotificationKind`
enum + a new schedule, not a rewrite.** Keep the registry `Principal → tokens`
channel-agnostic; the *schedule* is per-reminder-type.