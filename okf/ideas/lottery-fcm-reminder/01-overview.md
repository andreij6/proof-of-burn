---
type: idea
title: "01 — Overview"
tags: [ideas, lottery-fcm-reminder]
timestamp: 2026-06-20T04:38:29-04:00
---

# 01 — Overview

## What

A "Notify me 1 hour before the draw" push notification for the lossless lottery. A
user opts in on the Lottery page; their browser gets an FCM token; an off-chain job
pushes them a reminder at `next_draw_at − 1h` for each scheduled drawing (Sun/Tue/Thu
03:00 UTC — `src/backend/src/lib.rs:9014`, `next_draw_after` at `:9236`).

## Why

- The lottery is the app's main recurring-reengagement hook, but a user has to open
  the app to learn a draw is imminent. A T-1h push catches the "I keep forgetting to
  claim today's ticket" crowd — daily ticket claims are the top of the funnel into
  staking/burning.
- The infra is half there: the Firebase web app is already initialized
  (`src/frontend/src/firebase.ts`) and `firebase@^12.14.0` is a dependency, so
  messaging is an import + a service worker away, not a new vendor.
- `next_draw_at` is already a public on-chain field (`LotteryState.next_draw_at`,
  exposed via `get_lottery_info` → `LotteryInfo.next_draw_at`), so the scheduler has a
  trustless source of truth for "when."

## The decisive constraint → off-chain sender required

FCM v1 sends via `POST https://fcm.googleapis.com/v1/projects/{id}/messages:send`
with an `Authorization: Bearer <oauth2 access token>`. The access token is minted by
signing a service-account JWT (RS256) and exchanging it at Google's OAuth endpoint.
**An IC canister cannot produce that signature** — canisters sign with threshold
ECDSA/BLS (derivation keys), not an arbitrary RSA service-account private key, and
there's no on-chain RSA-signing primitive. Putting the service-account private key on
a canister is also a non-starter (it'd be public).

So the push **sender** must live off-chain. The canister's job is only to be the
opt-in registry + the source of truth for `next_draw_at`. The off-chain sender polls
the canister and fires pushes. This mirrors the X-Farm Cloud Run proxy already in
the repo — same vendor, same deploy posture, just a cron-shaped job instead of a
request-shaped proxy.

## Architecture

```
 Browser (signed in)                      ICP backend canister              Cloud Run scheduler
 ─────────────────────                     ──────────────────────            ─────────────────────
 1. toggle "notify me" ON                                                    (deployed alongside
 2. Notification.permission.request()                                        the x-farm proxy)
 3. getToken(messaging, {vapidKey})        4. register_push_token(token)
    └────────────────────────────────────▶     stores Principal → token
                                              (StableBTreeMap, MemoryId 103)
                                              feature-gated on lossless_lottery
                                              5. get_lottery_info() ──────▶  poll every ~5 min
                                                 returns next_draw_at        at next_draw_at − 1h:
                                                                             list_push_tokens()
                                                  ◀──────────────────────      send FCM to each
                                                                               (service-account
                                                                                JWT → access token)
                                            6. unregister_push_token(token)
                                               (toggle OFF / logout)
```

The canister exposes: `register_push_token(token)`, `unregister_push_token(token)`,
`list_push_tokens()` (admin-only — see Q1) or `get_push_token_count()`, and a public
`get_next_draw_at()` (or just reuse `get_lottery_info`). The scheduler is a single
Cloud Run service + Cloud Scheduler trigger.

## Options considered

### A. Pure browser-side, no server (rejected)
Frontend reads `next_draw_at`, schedules a `setTimeout` for T-1h, calls
`registration.showNotification`. **Fails the requirement:** a `setTimeout` dies when
the tab/app closes; web push while closed *requires* a server-sent push. This option
only notifies users who leave the tab open — not "message users directly," which
implies background push. Useful only as a *fallback* for the open-tab case (cheap,
no infra — keep as a bonus, not the design).

### B. Canister sends FCM directly (rejected — see decisive constraint)
Canister does an HTTPS outcall to FCM. Can't mint the OAuth2 access token (no RS256).
Rejected at the protocol layer.

### C. Off-chain scheduler + on-chain token registry (recommended)
Above. Reuses Cloud Run + the existing Firebase project. Canister stays the source
of truth; the off-chain job is stateless and replaceable.

### D. Off-chain scheduler + off-chain token DB, canister stores only an opaque handle
Same as C but the FCM token never touches the chain — the canister stores
`Principal → Vec<subscription_id>` and a separate off-chain DB stores
`subscription_id → fcm_token`. The scheduler reads subscription_ids from the canister
and resolves tokens from its own DB. **More infra** (a DB to operate), **better
privacy** (tokens aren't public). See Q1.

## Identity & timing model

- **Identity mismatch:** FCM tokens are per-browser/device, not per-Principal. One
  Principal may have N devices (phone + laptop) → N tokens; one browser could hold
  multiple II identities (rare). Model as `Principal → Vec<FCM token>` (dedup on
  register). Logout should drop the device's token for that Principal.
- **Timing source of truth:** `next_draw_at` can move forward when a draw rolls over
  (pot below `LOTTERY_MIN_POT_E8S` = 25 ICP — `lib.rs:9000`) — `run_lottery_draw`
  resets `next_draw_at = next_draw_after(now)` (`lib.rs:9374`). So the scheduler must
  **poll** `next_draw_at` periodically (every 5 min mirrors the canister's own
  `set_timer_interval(300s)` heartbeat at `lib.rs:4734`), not trust a cached value.
- **Late opt-in:** a user opting in after T-1h has passed for the current draw simply
  gets the next one — the scheduler only schedules future draws.
- **No double-send:** the scheduler records "fired for draw at <ts>" per token to
  avoid re-pushing if it wakes twice for the same draw (Cloud Scheduler retries on
  failure). Idempotency key = `(next_draw_at, token)`.

## What this is NOT

- Not a general messaging system — one notification, one schedule (lottery T-1h).
  Other reminders (X-Farm depleted, proposal-discussions reply, etc.) are a separate
  scope; this builds the *plumbing* they'd reuse.
- Not transactional/alert email — push only. Email would need an address + an SMTP
  provider; out of scope.
- Not a notification center / in-app inbox — the push is fire-and-forget; the app
  already shows draw status on the Lottery page.

## Reuse map

| Need | Reuse | Where |
|---|---|---|
| Firebase app | already initialized | `src/frontend/src/firebase.ts` |
| Firebase messaging SDK | `firebase/messaging` (v12 dep present) | `package.json:19` |
| Off-chain deploy pattern | X-Farm Cloud Run proxy | `/ideas/x-farm/06-cloud-run-proxy-build.md` |
| On-chain source of truth | `LotteryInfo.next_draw_at` | `get_lottery_info` |
| Periodic heartbeat cadence | `set_timer_interval(300s)` | `lib.rs:4734` |
| Opt-in toggle UI | existing toggles/patterns on Lottery page | `src/frontend/src/Lottery.tsx` |
| Stable-map registry + MemoryId | next free id is **103** (102 is highest in use) | `lib.rs` §3 |

## Net-new (no precedent in the repo)

- The token registry stable map (MemoryId 103) + 2 update endpoints.
- The Firebase Messaging service worker (`public/firebase-messaging-sw.js`) + VAPID
  key config (admin-settable, not shipped in the bundle).
- The off-chain scheduler (Cloud Run + Cloud Scheduler cron) + its service-account
  auth flow. This is the only genuinely new operational surface.