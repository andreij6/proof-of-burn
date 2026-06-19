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
  "history": ["prior draft text 1", "prior draft text 2"]
}
```
- `drafts_per_day`: int, clamped 1..10 server-side.
- `persona`: required non-empty string.
- `history`: array of strings (prior drafts not to repeat); may be `[]`.

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

## Status Log (both streams append; newest at top)

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
