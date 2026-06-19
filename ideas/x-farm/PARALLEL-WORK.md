# X-Farm — Parallel Work Coordination

Two streams are building x-farm at once. This file is the shared contract + status
board. **Both streams append to the Status Log; neither edits the other's lane.**

Last updated: 2026-06-19.

---

## Lanes (hard file boundaries — do not cross)

| | **Stream A — Proxy & Cloud (Claude, main session)** | **Stream B — Canister & UI (spawned agent)** |
|---|---|---|
| Owns | `proxy/**`, GCP/Cloud Run deploy, `06-cloud-run-proxy-build.md` | `src/backend/src/lib.rs` (x-farm code), Farmer wasm crate, `src/backend/backend.did`, `src/frontend/src/XFarm.tsx` (+ nav wiring in `App.tsx`), x-farm tests |
| Must NOT touch | anything in `src/backend`, `src/frontend` | anything in `proxy/`, GCP, `06-*.md` |
| Deploy rights | `gcloud run deploy` (billable — only on owner's explicit go-ahead) | **LOCAL ONLY** (`bash scripts/deploy-local.sh`). **NEVER** `-e production`/`-e staging` |

Shared docs (`README.md`, `01`–`05`, this file): coordinate before editing; prefer
appending to the Status Log over rewriting. `07-premium-images` is out of scope for now.

---

## FROZEN CONTRACT — the proxy API (Stream B builds the outcall against this)

Stream B can build + test the entire canister-side outcall **now**, before the proxy
is deployed, by mocking this. The shape will not change.

**Endpoint:** `POST {PROXY_URL}/v1/tweets`
**Header:** `Authorization: Bearer {BEARER}`  (`Content-Type: application/json`)

**Request body:**
```json
{
  "drafts_per_day": 3,
  "persona": "free-text persona string (UNTRUSTED — treated as data by the proxy)",
  "history": ["prior draft text 1", "prior draft text 2"],
  "caller_id": "<optional> farmer canister id / owner principal"
}
```
- `drafts_per_day`: int, clamped 1..10 server-side.
- `persona`: required non-empty string.
- `history`: array of strings (prior drafts not to repeat); may be `[]`.
- `caller_id`: **optional, additive** (does not break the contract). If passed, the
  proxy enforces a per-caller daily cap (default 50/day) and tags logs with it.
  Stream B should pass the Farmer's canister id (or owner principal) so the cap +
  log attribution work per-Farmer. Omitting it = global cap only.

**Response 200:**
```json
{ "drafts": [ { "text": "<= 270 chars, plain text", "cited_url": "https://... or null" } ] }
```
- Exactly `drafts_per_day` items (capped).
- `cited_url` is the grounding source (may be null). In JSON mode the SDK exposes
  the source here, not in grounding metadata.

**Errors:** `401` bad/missing bearer · `422` bad input · `502` generation failed
(→ canister marks a **Failed** day and **skips the burn tick**, R8) · `501` `/v1/review`
(not built yet).

**Wiring:** `PROXY_URL` + `BEARER` are set on the canister via
`admin_set_xfarm_proxy(url, bearer)` (R6: rotatable). Until Stream A deploys, the
URL/bearer are placeholders; the outcall code + tests should not hard-code them.

**Local note:** IC local replica HTTPS outcalls can't easily reach an external
proxy; Stream B should unit-test the request build + response parse with a mock,
and gate the live outcall behind config so local UI states work via `dev_*` seeds.

---

## Stream B — suggested build order (canister & UI)

Read first: `README.md`, `01-ux-spec.md`, `02-backend-and-tasks.md`, `03-reuse-map.md`,
`05-architecture.md`. Decisions are locked there (per-user Farmer canister + factory;
USD-priced tiers via XRC; 7-day deliberate-burn depletion; generate-don't-post).

1. **⚠️ FIRST: claim free MemoryIds.** Spec pencils in 54–58 but flags a collision
   with proposal-discussions + ai-proposal-review (ship-first-wins). Grep `MemoryId::new(`
   in `lib.rs`, pick a unique free block, record it in the Status Log below.
2. Types + stable storage: `Farmer`, tiers, config; `FARMERS` registry, `NEXT_ID`,
   `CONFIG`, `WASM_HASH`, `PROXY` (url+bearer). `impl_storable!` + `#[serde(default)]`.
3. Money path (REUSE, don't clone): `create_farmer` = quote (XRC) → escrow →
   10% treasury → 90% burn-to-cycles (`call_cmc_topup_transfer` + journaled notify).
   Build on extracted helpers per `docs/duplication-review-2026-06-19.md` if present.
4. Factory (net-new): `create_canister` / `install_code` / `deposit_cycles`;
   order create→install→top-up; delete-on-failed-install (R5); factory = sole controller.
5. Farmer wasm (net-new 2nd canister): init(owner/tier/persona/budget/proxy/bearer);
   per-Farmer daily timer → outcall (FROZEN CONTRACT) → store bounded last-30 drafts;
   burn tick spends `budget/7 − real_work` in steady chunks (R9); skip burn on Failed day (R8).
6. Cleanup sweep: stop+delete depleted Farmers (nothing to reclaim — cycles ~0 by design).
7. `admin_set_xfarm_proxy(url, bearer)`; `FLAG_X_FARM = "x_farm"` (ship dark / default Off).
8. Frontend `XFarm.tsx`: persona wizard + tier/pay dialog + My-Farmer dashboard
   (surface `burned_cycles`, R9) + Share-on-X (reuse `shareProposalOnX`). Reuse
   `useEscrowPay`/Explorer modal/`ui.tsx` primitives.
9. `dev_seed_farmers` / `dev_clear_farmers` (gated by `require_local_dev`) for offline UI states.
10. Tests (cargo): money split, factory lifecycle, burn-tick math, outcall parse (mock),
    Failed-day skip. Regen candid + `npm run gen:bindings`. `bash scripts/deploy-local.sh`.

Guardrails: behind `x_farm` flag, default OFF; **local deploys only, mainnet is
gated per-deploy by the owner**; commit to local freely; coordinate doc edits here.

---

## Owner requirements (Stream B must implement)

- **Generation is ON-DEMAND, max once per day (owner directive 2026-06-19 — SUPERSEDES
  the autonomous daily-timer model in `05-architecture.md` Flow B and `02` §D).**
  - Tweets are requested **only when the user views their Farmer**, not on an
    autonomous schedule. **No per-Farmer generation timer.**
  - **Throttle: at most one proxy call per Farmer per UTC day.** Store
    `last_generated_at` on the Farmer. If a generation already happened today, the
    view returns the **stored** drafts (bounded last 30) with NO new proxy call.
  - **Only the Farmer's owner can trigger a generation** (caller == owner) — it spends
    the budget, so non-owners viewing get read-only stored drafts, never a new call.
  - On a real generation: pass `caller_id` = Farmer id to the proxy (the proxy's
    per-caller 50/day cap is then a belt-and-suspenders backstop to the on-chain 1/day).
  - Failed proxy call (502) = no drafts stored for today, no day consumed; the user
    can retry (subject to the 1/day throttle — decide if a *failed* attempt counts;
    recommend it does NOT, so a failure doesn't waste the day).
- **Burn model = 7-CALENDAR-DAY burn timer, DECOUPLED from generation (owner decision
  2026-06-19).**
  - Each Farmer keeps a per-Farmer **burn-only** IC timer that deliberately spends
    ~`budget/7` per day in steady chunks (R9), depleting to the floor over **7 calendar
    days regardless of whether the user ever views** — preserves the literal "lasts 7
    days" promise + guaranteed proof-of-burn.
  - **The timer NO LONGER generates tweets** — it only burns. Generation is the
    separate on-demand/lazy path above. (This splits the old combined daily tick into
    two independent mechanisms.)
  - At the floor (~day 7) the factory cleanup sweep `stop_canister` + `delete_canister`s
    the Farmer (cycles ~0, nothing to reclaim).
  - **⚠️ Timer re-arm gotcha:** IC timers live in the heap and are lost on upgrade —
    the Farmer's `post_upgrade` MUST re-arm the burn timer (compute remaining days from
    `created_at`/`expected_depleted_at`), or depletion silently stalls after any upgrade.
  - Failed/depleted-budget guard: the burn tick checks `cycles > floor` before spending.


- **Tier pricing MUST be admin-configurable at runtime** (owner directive 2026-06-19).
  - Tiers (name, USD price, drafts/day, duration) live in `XFARM_CONFIG` (stable
    `StableCell`), NOT hardcoded constants — survive upgrades, no redeploy to change.
  - Add an admin-guarded setter, e.g. `admin_set_xfarm_tiers(vec Tier)` /
    `admin_set_xfarm_config(...)`, behind the same admin check as other `admin_*`
    methods. Ship sensible defaults (Sprout/Grow/Bloom) but they must be mutable.
  - Prices are **USD-denominated** (XRC converts to ICP at purchase, D1/R0) — the
    admin sets USD, not a fixed ICP amount.
  - Expose current tiers via a query (e.g. `get_xfarm_tiers`) so the frontend renders
    live prices.
- **Pricing math (resolve explicitly):** recommend `price = creation_cost +
  7day_budget`, then `+10% treasury on top`, so the advertised burned 7-day budget is
  a clean number and the ~$0.683 per-user creation cost is covered by the buyer (the
  treasury never fronts creation — `create_farmer` is an upfront burn, not
  treasury-front-gated). Make `creation_cost` + `treasury_pct` config fields too.

## Status Log (both streams append; newest at top)

- **2026-06-19 (A): Owner directive — generation model changed + burn model decided.**
  Generation is now ON-DEMAND on view, max 1/day, owner-gated, NO generation timer
  (supersedes Flow B autonomous tick). Burn model = **7-calendar-day burn-only timer,
  decoupled from generation** (owner chose "keep timer" over burn-on-use). See Owner
  requirements above. `05-architecture.md` Flow B + `02` §D are now partially
  superseded — Stream B follows PARALLEL-WORK over those.
- **2026-06-19 (A): Logged owner requirement** — tier pricing must be
  admin-configurable at runtime (see Owner requirements above) + pricing-math
  resolution. Stream B to implement in `XFARM_CONFIG` + admin setter.

- **2026-06-19 (A): Proxy hardened (retry/backoff + rate caps + structured logs).**
  Gemini 429/5xx now retried w/ exponential backoff (env `GEMINI_MAX_RETRIES`=4).
  Best-effort daily caps (env `MAX_CALLS_PER_DAY`=1000, `MAX_CALLS_PER_CALLER_PER_DAY`=50;
  in-memory/per-instance → $10 budget is still the true hard cap). New **optional**
  `caller_id` request field (see contract above) — Stream B: pass the Farmer id to
  get per-Farmer caps + log attribution. Structured JSON logs to Cloud Logging.
  Verified locally; redeployed to Cloud Run.
- **2026-06-19 (A): PROXY DEPLOYED TO CLOUD RUN — live + verified.**
  - **`PROXY_URL` = `https://xfarm-proxy-1032507435523.us-central1.run.app`**
  - Endpoint `POST /v1/tweets` (bearer-authed) returns grounded + schema-typed
    drafts; `GET /health` → 200; `/v1/review` → 501. 401 enforced without bearer.
  - **Bearer:** stored in Secret Manager `xfarm-bearer:latest` (NOT in this repo).
    The owner supplies URL + bearer to `admin_set_xfarm_proxy(url, bearer)` when
    Stream B's backend is ready. Rotatable: add a new secret version + re-call.
  - Deviations from `06`/spec (all deliberate): `--allow-unauthenticated` (IC
    canister can't mint a Google OIDC token; app-level bearer + $10 budget cap are
    the boundary); `--min-instances=0` (daily caller, scale-to-zero = free tier);
    health path is `/health` not `/healthz` (GFE intercepts `/healthz`).
  - Region `us-central1`; runtime SA `xfarm-runtime` (aiplatform.user +
    secret accessor); $10 budget alert (50/90/100%). Model `gemini-3.5-flash`.


- **2026-06-19 (B):** MemoryIds claimed — all free + uncontested (verified `MemoryId::new(N)` count == 0 in lib.rs):
  - **54** `XFARM_FARMERS` (StableBTreeMap<u64, Farmer>)
  - **55** `XFARM_NEXT_ID` (StableCell<u64>)
  - **56** `XFARM_CONFIG` (StableCell<XFarmConfig> — tiers + proxy + caps)
  - **57** `XFARM_WASM_HASH` (StableCell<Option<[u8;32]>> — Farmer wasm hash to install)
  - **58** `XFARM_PROXY` (folded into CONFIG; 58 held in reserve)
  Spares: 59, 73, 76, 103+. Farmer canister (separate wasm) uses its own MemoryIds 0+ inside its own canister — no backend collision. Starting build per the Stream B order.
- **2026-06-19 (A):** Proxy built + validated end-to-end vs Vertex (project
  `pob-x-farm-proxy`, keyless ADC). `/v1/tweets` live, `/v1/review` 501-stub.
  Committed `05f33ad` (local). FROZEN CONTRACT above is final. Cloud Run deploy
  pending owner go-ahead → will post real `PROXY_URL` + bearer-handling here when live.
- **2026-06-19 (A):** Coordination file created. Stream B: claim MemoryIds and log them next.
