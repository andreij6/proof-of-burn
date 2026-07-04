---
type: idea
title: "02 — Implementation (backend + frontend + off-chain scheduler)"
tags: [ideas, lottery-fcm-reminder]
timestamp: 2026-06-20T04:38:29-04:00
---

# 02 — Implementation (backend + frontend + off-chain scheduler)

Line numbers approximate (2026-06-20) — verify before building. MemoryId **103** is
the next free id (102 highest in use). Everything is gated on `FLAG_LOSSLESS_LOTTERY`
so it stays dark until the flag is on.

## Backend (`src/backend/src/lib.rs`)

### Registry: `PUSH_TOKENS: StableBTreeMap<Principal, Vec<String>>` (MemoryId 103)

A Principal maps to its registered FCM tokens (one per browser/device). Dedup on
register; remove on unregister; drop all on a "logout-everywhere" (optional).

```rust
thread_local! {
    static PUSH_TOKENS: StableBTreeMap<Principal, Vec<String>, MemoryId> =
        StableBTreeMap::init(MemoryId::new(103));
}
```

Token strings are FCM registration tokens (~200 chars, opaque). Cap per-Principal at
e.g. 8 devices (`MAX_PUSH_TOKENS`) to bound map growth; reject over that with
`TOO_MANY_DEVICES`.

### Endpoints

```rust
#[ic_cdk::update]
fn register_push_token(token: String) -> Result<(), String>
//   require_authenticated(); CallerGuard; validate non-empty + length cap;
//   feature_active(FLAG_LOSSLESS_LOTTERY); dedup-insert into PUSH_TOKENS[caller].

#[ic_cdk::update]
fn unregister_push_token(token: String) -> Result<(), String>
//   require_authenticated(); remove token from PUSH_TOKENS[caller] (no err if absent).

#[ic_cdk::query]
fn get_my_push_tokens() -> Vec<String>   // caller's own — for the toggle UI state

#[ic_cdk::query]
fn get_push_subscription_count() -> u64   // public — surfaced on the Lottery page ("N devices opted in")
```

### `list_push_tokens()` — admin-only (see Q1)

If Q1 lands as "tokens on-chain," the scheduler needs the full list. **Do NOT** make
this a public query — FCM tokens in the public Candid interface = anyone can scrape
and spam. Gate it behind `require_admin` and have the scheduler authenticate with an
admin principal (or a dedicated `scheduler` principal added to `config.admins`). If
Q1 lands as "off-chain DB," this endpoint returns only subscription_ids and the
scheduler resolves tokens from its own DB.

### VAPID key config (admin-settable)

The frontend needs the public VAPID key to subscribe. Store it as an admin-set
config field so it's not hardcoded in the bundle:

```rust
// In the lottery/x-farm-style config block:
pub fcm_vapid_public_key: String,   // #[serde(default)] for upgrade safety
// admin_set_fcm_vapid_key(key: String) -> Result<(), String>
// surfaced via get_lottery_info (or a new get_fcm_info query)
```

### Candid sync (`backend.did`)

Add `register_push_token`, `unregister_push_token`, `get_my_push_tokens`,
`get_push_subscription_count`, `admin_set_fcm_vapid_key`, and the `fcm_vapid_public_key`
field. Regenerate `bindings/` (`npm run gen:bindings`).

### Upgrade safety

- New `PUSH_TOKENS` map (MemoryId 103) — never reuse/renumber; init is lazy (no
  `init`/`post_upgrade` seeding needed — empty on first upgrade).
- New config field `fcm_vapid_public_key` → `#[serde(default)]` so old config bytes
  decode.
- No existing struct is mutated. `EscrowKind`-style: purely additive.

## Frontend (`src/frontend/src/`)

### Service worker — `public/firebase-messaging-sw.js`

Firebase Messaging needs a SW at a stable scope-rooted path. The `firebase` npm
package ships `firebase-messaging-sw.js` — the simplest path is an `importScripts`
shim (avoids bundling the SW):

```js
// public/firebase-messaging-sw.js
importScripts("https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js");
firebase.initializeApp({
  /* same firebaseConfig as firebase.ts — or read from import.meta.env */
  messagingSenderId: "1067471750",
});
firebase.messaging();
```

(If offline-first is wanted later, bundle the SW with Vite's `import.meta.glob` +
`vite-plugin-pwa`; for v1 the gstatic importScripts is fine and matches Firebase's
docs.) Vite serves `public/*` at root, so it lands at `/firebase-messaging-sw.js`.

### Messaging init — extend `firebase.ts`

```ts
import { getMessaging, getToken, deleteToken, onMessage } from "firebase/messaging";
export const messaging = getMessaging(app);
export { messaging, getToken, deleteToken, onMessage };
```

### Toggle UI — `Lottery.tsx`

A "Notify me 1 hour before the draw" toggle near the "Next drawing" card
(`Lottery.tsx:~303`). On enable:

1. `Notification.permission.request()` → if denied, show a "blocked — enable in
   browser settings" hint and stop (don't store a token).
2. `getToken(messaging, { vapidKey })` — `vapidKey` from `get_lottery_info()`
   (or `get_fcm_info`). On failure, surface the error; don't half-register.
3. `actor.register_push_token(token)` — bind to the signed-in Principal.
4. Show a toast: "We'll ping this device 1 hour before each drawing."

On disable: `actor.unregister_push_token(token)` then `deleteToken(messaging)`.
Reflect state via `get_my_push_tokens()` on load.

**Auth gate:** the toggle only appears for signed-in users (we need a Principal to
bind the token). For anonymous visitors, show a disabled "sign in to get reminders"
hint.

### Foreground fallback (bonus — see 01 option A)

`onMessage(messaging, payload => { show a toast + the existing in-app notice })` so
an open tab also gets the reminder inline. Cheap; doesn't need the server for the
open-tab case if you also wire a local `setTimeout(next_draw_at − 1h)` — but keep the
server push as the primary path (works closed-tab).

## Off-chain scheduler (Cloud Run + Cloud Scheduler)

Single small service, deployed like the X-Farm proxy
(`/ideas/x-farm/06-cloud-run-proxy-build.md`). Python/FastAPI or a tiny Node script.

### Flow

```
every 5 min  ── Cloud Scheduler ──▶ GET canister.get_lottery_info()
                                   → next_draw_at
                                   if next_draw_at − 1h is within [now, now+5min] AND
                                      not yet fired for this next_draw_at:
                                       GET admin canister.list_push_tokens()
                                       for each token: POST FCM messages:send
                                       mark fired[next_draw_at] = done
```

Polling (not a pre-scheduled future job) is deliberate: `next_draw_at` can jump
forward on a rollover, and Cloud Scheduler can't cheaply "reschedule at T-1h for a
moving T." 5-min polling is well inside the 1h window and matches the canister's own
heartbeat cadence.

### FCM auth (service account)

- A Firebase service account with **Cloud Messaging API Admin** role.
- The scheduler signs a JWT (RS256) with the service-account private key (kept in
  Cloud Run secret manager — **never** on the canister) and exchanges it for an
  OAuth2 access token (1h TTL; cache + refresh).
- Sends `POST https://fcm.googleapis.com/v1/projects/catalyst-de16d/messages:send`
  with `{ "message": { "token", "notification": { "title", "body" }, "webpush": {
  "fcm_options": { "link": "<app URL>/lottery" } } } }`. The `link` makes the click
  land on the Lottery page.

### Notification content (see Q2)

v1: static — *"⏰ Lossless lottery draws in 1 hour. Claim today's ticket if you
haven't."* with `link: /lottery`. Personalized variants (ticket count, "you have N
tickets in this round") need a per-user fetch — see Q2.

### Idempotency

`fired: Map<next_draw_at, bool>` in the scheduler's own state (Firestore or a
Cloud Run in-memory + a Firestore flag). Key on `next_draw_at` (changes per draw, so
a rollover produces a new key → re-fires correctly). Prevents double-push if Cloud
Scheduler retries.

### Failure modes

- Canister unreachable → skip this tick (next tick retries). Log + alert.
- FCM 404 (invalid/unregistered token) → call `unregister_push_token` on the canister
  for that token (the scheduler needs an admin principal to act for another user —
  see Q1/Q3) OR drop it from the off-chain DB and let a periodic canister reconcile
  prune stale tokens. Simplest: log + leave; a nightly reconcile prunes tokens older
  than 60d / not seen.
- No tokens registered → no-op (don't error).

## Deploy

- Backend: `cargo build --target wasm32-unknown-unknown --release -p backend`, then
  `scripts/deploy-local.sh` for local smoke (NEVER mainnet without explicit ask).
- Frontend: `npm run build` (regenerates bindings). Verify the SW loads at
  `/firebase-messaging-sw.js` and `getToken` succeeds locally.
- Scheduler: `gcloud run deploy` + `gcloud scheduler jobs create` (5-min cron
  `*/5 * * * *`). Store the service-account key + the canister admin principal in
  secret manager. Local: run the scheduler script with `node`/`python` against the
  local canister.

## Sizing

- Backend: ~60 lines (map + 4 endpoints + config field). LOW.
- Frontend: ~80 lines (SW + messaging init + toggle + foreground handler). LOW–MEDIUM.
- Scheduler: ~120 lines + Cloud Run/Cloud Scheduler config. MEDIUM (the only new
  operational surface — needs monitoring, secrets, a cron).
- Total: **MEDIUM**, almost entirely because of the off-chain sender.