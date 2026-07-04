---
type: idea
title: "X-Farm — Architecture Overview"
tags: [ideas, x-farm]
timestamp: 2026-06-19T11:37:22-04:00
---

# X-Farm — Architecture Overview

> Feature overview. **D-arch is RESOLVED → per-user Farmer canisters + a factory**
> (04 R1): each Farmer **is** its own canister, created/installed/funded by the
> factory. A **shared-state module** stays a documented **Phase-2 fallback** only
> (cheaper, but concentrates all deliberate burn on one subnet — R9) — see
> [README §3 / D-arch](README.md) and [04 R1/R5](04-adversarial-review.md).
> Everything except *where Farmers physically live* is identical between the two.

## System context

```
        user (browser)                         IC mainnet
   ┌────────────────────┐        ┌───────────────────────────────────────────┐
   │  XFarm.tsx          │        │  backend canister  (factory + money path) │
   │  • persona wizard   │        │   ┌─────────────────────────────────────┐ │
   │  • tier + pay ──────┼───────▶│   │ create_farmer: escrow→10% treasury  │ │
   │  • My Farmer        │        │   │ + 90% burn→cycles, then create the  │ │
   │  • Share on X ──────┼──▶ X   │   │ Farmer canister & fund it           │ │
   └────────────────────┘ (user  │   │ FARMERS registry · tiers · proxy cfg│ │
            ▲              posts) │   │ cleanup sweep (stop+delete depleted)│ │
            │ drafts/status       │   └───────────┬─────────────────────────┘ │
            │                     │   create/install/deposit_cycles│           │
            │                     │               ▼                            │
            │                     │   ┌─────────────────────────────────────┐ │
            └─────────────────────┼───│  Farmer canister  (one per user)    │ │
                                  │   │  • own DRAFTS (bounded last 30)     │ │
                                  │   │  • daily ic timer ──┐               │ │
                                  │   │  • init: owner/tier/persona/budget  │ │
                                  │   └─────────────────────┼───────────────┘ │
                                  │  pay/burn      (non-replicated outcall)    │
                                  │   ▼                     │                  │
                                  │ ┌──────────────┐        │                  │
                                  │ │ ICP ledger   │        │                  │
                                  │ │ + CMC (burn) │        │                  │
                                  │ │ + Treasury   │        │                  │
                                  │ └──────────────┘        │                  │
                                  └─────────────────────────┼──────────────────┘
                                                            ▼
                                          ┌──────────────────────────────────┐
                                          │ Cloud-Run proxy (off-chain)        │
                                          │ POST /v1/tweets · holds Gemini key │
                                          │ bearer auth (scoped/capped/rotate) │
                                          │ shared with ai-proposal-review     │
                                          └──────────────┬─────────────────────┘
                                                         ▼
                                          ┌──────────────────────────────────┐
                                          │ Gemini 3 Flash (preview)            │
                                          │ generateContent + responseSchema   │
                                          │ + Google Search / URL-context      │
                                          └──────────────────────────────────┘
```

## Where Farmers live — chosen (per-user) vs Phase-2 fallback (shared-state)

```
CHOSEN — per-user canister (D-arch)     FALLBACK — shared-state module (Phase-2)
─────────────────────────────────       ─────────────────────────────────────────
factory ──create_canister──▶ Farmer      backend holds FARMERS rows +
         ──install_code────▶  (timer,   per-farmer DRAFTS sub-maps;
         ──deposit_cycles──▶  drafts)   ONE backend daily sweep timer
expiry: stop+delete depleted            iterates active farmers;
+$0.683 creation/farmer                 expiry: purge rows (no delete)
(cycles already ~0 — nothing            ~4–5× cheaper · R1+R5 vanish
 to reclaim)                            + R9: deliberate burn concentrated
"your own autonomous canister"          on one canister/subnet here
```

The frontend, the money path (Flow A), the daily-generation logic (Flow B), the
proxy, and the Candid API are **the same** in both. Only the *Farmer storage +
compute location* and the *lifecycle* (delete-canister vs purge-rows) differ.

## Flow A — Create a Farmer (pay → split → burn → spawn)

```mermaid
sequenceDiagram
    actor U as User
    participant FE as XFarm.tsx
    participant FC as backend / factory
    participant LG as ICP ledger
    participant CMC as CMC
    participant TR as Treasury subacct
    participant FM as Farmer canister

    U->>FE: pick persona + tier, confirm pay
    FE->>FC: get_xfarm_quote(tier)   (USD price → ICP at XRC rate, D1)
    FE->>LG: icrc1_transfer(price → per-user escrow)
    FE->>FC: create_farmer(tier, persona)
    FC->>LG: balance(escrow) ≥ price+fee ?
    FC->>TR: transfer 10% (escrow → treasury)
    FC->>FM: create_canister (≥500B cycles) + install_code(owner,tier,persona,budget,proxy,bearer)
    FC->>CMC: 90% burn-to-cycles (call_cmc_topup_transfer, journaled)
    FC->>FM: deposit_cycles (fund the 7-day budget)
    FC->>FC: insert Farmer{owner,tier,canister_id,budget_cycles,expected_depleted_at,burn_block}
    FM->>FM: init → set daily timer (+ burn tick)
    FC-->>FE: Farmer (running)
    Note over FC,FM: order = create → install → top-up; if install fails,<br/>delete_canister immediately (R5). Burn leg is journaled (PB-148-safe).
```

- **Shared-state alt:** skip create/install/deposit_cycles; the 90% tops up the
  backend's own balance, earmarked to the farmer; the Farmer is a row, not a canister.
- Burn leg + 10% split + escrow ordering are **pure reuse** (`settle_burn_split`
  CMC leg, `submit_dapp` treasury transfer); journaled like every CMC burn here.
- **Not** `require_treasury_can_front`-gated (the burn is upfront, no refund).

## Flow B — Daily autonomous generation (timer → proxy → Gemini → store)

```mermaid
sequenceDiagram
    participant T as daily timer (per Farmer)
    participant FM as Farmer canister
    participant PX as Cloud-Run proxy
    participant GM as Gemini

    T->>FM: tick (once/day)
    FM->>FM: guard: cycles > floor (balance = the 7-day timer)
    FM->>PX: POST /v1/tweets {persona, n, history}  (non-replicated)
    PX->>GM: generateContent (persona+history = UNTRUSTED data, grounded, responseSchema)
    GM-->>PX: {drafts:[{text,cited_url}]}
    PX-->>FM: drafts JSON
    alt 200 + parseable
        FM->>FM: store drafts (bounded last 30)
    else failure
        FM->>FM: mark day Failed; SKIP burn tick (budget lasts longer — R8)
    end
    FM->>FM: burn tick: spend (budget/7 − real_work) in steady chunks (R9) → Depleted at floor
```

- **Persona + history are untrusted data** in the proxy's system prompt
  (prompt-injection defense, R3). Output is plain text, ≤270 chars, schema-constrained.
- **The burn tick (finding #7):** real Gemini work is only ~$0.03–0.08 over 7 days,
  far below the budget, so each daily tick **deliberately spends `budget/7 −
  real_work` of no-op compute** to deplete the budget on a 7-day schedule —
  honest proof-of-burn in miniature. Steady chunks, not one burst (R9 subnet optics).
- **Make-good (R8):** on a `Failed` day the burn tick is **skipped** so the budget
  isn't spent on nothing — the 7-day window effectively extends by failed days (no
  ICP moves; the cycle balance is the timer, there is no `expires_at`).
- **Shared-state alt:** one backend sweep timer runs this per active farmer — but
  all Farmers' deliberate burn lands on one canister/subnet (R9, worse).

## Component responsibilities

| Component | Owns | Reuse / net-new |
|---|---|---|
| `XFarm.tsx` (frontend) | wizard, pay dialog, My-Farmer dashboard, Share-on-X | reuse Explorer modal + `shareProposalOnX` |
| backend / factory | `FARMERS` registry, tiers/config/proxy cfg, money path, create/install/fund, cleanup sweep | reuse burn leg + escrow; **net-new = factory (`create_canister`/`install_code`/`deposit_cycles`/`delete_canister`)** |
| Farmer canister (per user) | own bounded `DRAFTS`, init config, **daily timer**, generation outcall | **net-new = a 2nd wasm** the factory installs |
| ICP ledger / CMC / Treasury | payment, burn-to-cycles, 10% cut | pure reuse |
| Cloud-Run proxy | holds Gemini key (or ADC), `/v1/tweets`, bearer auth | **shared with ai-proposal-review** (build once); see [06-cloud-run-proxy-build.md](06-cloud-run-proxy-build.md) |
| Gemini 3 Flash | draft generation, grounding + structured output in one call | off-chain |

## How the adversarial risks land on this architecture
- **R0 (USD vs burn sustainability):** tiers are **USD-priced via XRC, paid in ICP
  (D1)** so the 10% treasury cut tracks the fixed-USD Gemini bill even if ICP falls
  (the margin doesn't compress); the 10% covers Gemini ~5× over at launch (7-day).
  → [04 R0](04-adversarial-review.md).
- **R1 (creation cost floor):** per-user adds **$0.683/farmer day-0** (carved out of
  the 7-day budget) → Sprout must be ~1 ICP under per-user; the **shared-state
  fallback removes it** (Sprout 0.5 ICP holds).
- **R3 (prompt injection):** persona/history framed as untrusted data in the proxy.
- **R5 (lifecycle/orphans):** create→install→top-up ordering, delete-on-failed-
  install, factory = sole controller, cleanup sweep stops+deletes **depleted**
  Farmers (no cycle reclamation — they're ~0 by design), live-Farmer cap;
  **vanishes under shared-state**.
- **R8 (paid-but-no-tweets):** failed days **skip the burn tick** (budget lasts
  longer) — make-good is delivery, not ICP.
- **R9 (deliberate-burn subnet load — new under the 7-day model):** the burn tick
  is real no-op compute on a shared subnet; steady per-tick chunks, cap live
  Farmers, **prefer per-user** so burn is isolated per canister (shared-state
  concentrates it). Surface `burned_cycles` in the dashboard so the burn is
  visible. → [04 R9](04-adversarial-review.md).
