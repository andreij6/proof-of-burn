# X-Farm — autonomous "Farmer" canisters that grow pro-ICP tweets

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-19.

A user pays ICP to instantiate a **Farmer** — an autonomous canister that, once a
day, asks **Gemini** (via our **Google Cloud Run** proxy) to research fresh ICP
material and draft a list of **pro-ICP tweets** the user can post on X. Tiers
scale drafts/day (1 / 5 / 10) and duration. The user's ICP is **burned to cycles
that fund the Farmer's compute**, with **10% to the treasury**. Setup is a quick
**persona wizard** (preset or custom). Goal: **voluntary ICP burns** in exchange
for content that promotes ICP — the proof-of-burn thesis applied to content
generation.

---

## Why this is mostly reuse

- **Burn ICP → cycles (the core thesis)** is exactly `settle_burn_split`'s
  backend-cycles leg: `call_cmc_topup_transfer` + `notify_cmc_topup`
  (`lib.rs:2260` / `2347` / `2481`). The "burn" *is* the cycle funding.
- **10% → treasury** is `call_ledger_transfer(… TREASURY_SUBACCOUNT …)`, same as
  `submit_dapp` / `submit_idea`.
- **LLM transport is already designed** in
  [ideas/ai-proposal-review](../ai-proposal-review/README.md): **non-replicated
  HTTPS outcalls** (LIVE) to a **Cloud-Run proxy** that holds the Gemini key and
  calls `gemini-2.5-flash:generateContent` with structured output. **X-Farm
  reuses that proxy wholesale** — build it once, add a `/v1/tweets` endpoint next
  to `/v1/review`. The user pre-chose the proxy path (= ai-proposal-review D4b),
  so **no vetKeys / SEV-SNP needed**; the key never touches the IC.
- **Escrow + fee charge** clones `submit_dapp` / `submit_idea`; **Share-on-X**
  reuses `shareProposalOnX`; feature-flag + dark-launch pattern is standard here.

**Net-new vs anything in the repo:** (1) a **second canister wasm** — the Farmer
— plus a **factory** that creates / installs / cycle-funds / expires / deletes
per-user canisters (the repo is a single backend today; it never calls
`management_canister.create_canister`); (2) **IC timers** driving autonomous
daily generation without the user present; (3) the persona + tweet-draft model.

---

## The core viability findings (researched 2026-06-19)

### 1. The burn-to-cycles design is sound and deeply on-theme ✅
"Pay ICP → burn to cycles → fund the Farmer → 10% treasury" satisfies **both** the
"burn ICP" goal **and** the "fund its cycles" mechanism in one move: the burn *is*
the cycle funding. No token payout, no securities-style "yield" — the user gets a
running content service, not a financial return. This sidesteps the
tao-like-reward "loop broken" failure (reward wasn't a burn). Here the value the
user receives (content) is produced by the burned cycles themselves.

### 2. The off-chain USD cost is negligible — the loop holds ✅
The one tao-like-reward-style worry — "the real compute is off-chain USD, not the
burn" — is quantitatively fine here:

| Cost component | Per daily generation | Per 7-day Farmer |
|---|---|---|
| **Gemini 2.5 Flash** (off-chain, paid by proxy operator in USD) | ~2K in + ~2K out = **~$0.003** | **~$0.02** |
| **HTTPS outcall** (non-replicated, 16 KB cap) | ~16.6M cycles = **~$0.00002** | **~$0.0002** |
| **Daily update/instructions** (timer fire + JSON parse + store) | ~1–5B instr | **~$0.01–0.05** |
| **Storage** (bounded tweet history, a few KB) | trivial | < $0.01 |

So a Farmer's *real-work* 7-day cost is only **~$0.03–0.08** — far below the 7-day
budget (Sprout ~$1.08, Grow ~$2.16, Bloom ~$4.32). **The gap is closed by
deliberate compute burn** (finding #7), and the 10% treasury (~$0.05–0.20 over 7
days) covers the proxy's Gemini bill (~$0.02/week) with margin. No subsidy trap.

### 3. ⚠️ The per-user-canister model has a hard cost floor — the headline risk
Canister **creation is 500B cycles ≈ $0.683** (13-node; the created canister pays
it), one-time per Farmer
([cycle costs](https://docs.internetcomputer.org/references/cycle-costs/)). That
**dominates** a Farmer's economics and is paid **upfront** from the user's burn:

| Model | Per-farmer 7-day real-work cost | Creation fee | Cheapest viable base price |
|---|---|---|---|
| **Per-user canister** (user's ask) | **~$0.03–0.08** (compute only) | **+$0.683 upfront** | **~1 ICP** (Sprout) to clear creation + 7-day budget |
| **Shared canister + per-user state** (fallback) | **~$0.03–0.08** | **none** | **~0.5 ICP** (Sprout) — the table holds as-is |

So the user's "a Farmer is a canister" model adds a **~$0.68 day-0 creation chunk
on top of the 7-day budget** and can't support the cheapest tier at 0.5 ICP
(Sprout must start at ~1 ICP under per-user). → **Decision D-arch** keeps the
per-user canister as the spec'd
design (it has a real narrative benefit — "your own autonomous ICP canister
promoting ICP" is itself on-brand promotion) but flags the shared-state model as
the cheaper MVP and the recommended path **if low tiers / high volume matter**.

### 4. Autonomous daily generation is viable via IC timers ✅
The Farmer sets a **daily `ic_cdk::timer`** that fires the Gemini outcall without
the user present; the existing sweep/heartbeat pattern
(`process_proposal_cutoff`, `sweep_play_sessions`) is the precedent. As long as
the Farmer is cycle-funded (balance > floor), it runs autonomously — the **cycle
balance is the timer** (D2), not a wall-clock `expires_at`. This is the right
design and is novel only in that it's per-Farmer (each canister owns its timer).

### 5. "Generate, don't auto-post" sidesteps a mountain of liability ✅
The Farmer **drafts** tweets; the **user manually posts** to X. We never touch the
X API, never hold OAuth tokens, never post under anyone's account. This (a) avoids
X ToS / automated-posting rules, (b) makes the amplification **genuine human
action** (the actual goal — real people promoting ICP), and (c) keeps the platform
out of the publisher seat (the user is the publisher; they own what they post).

### 6. Per-user canister lifecycle is real new infra ⚠️
A factory that `create_canister` → `install_code` (Farmer wasm + init args) →
burn ICP → `deposit_cycles`, plus a **cleanup sweep** that `stop_canister` +
`delete_canister`s stopped Farmers to bound state. (No cycle reclamation —
see #7: cycles deplete to ~0 by design, so there's nothing to claw back.)
None of this exists in the repo. It's the biggest implementation lift and the
main reason to consider the shared-state MVP (D-arch).

### 7. "Cycles burn out in 7 days" requires *real consumption*, not a forfeit ⚠️
**The hard constraint:** cycles, once minted from ICP via the CMC, **cannot be
converted back to ICP** and **cannot be sent to the treasury** — they can only be
(a) **consumed by compute / HTTPS outcalls**, or (b) **moved to another
canister** via `deposit_cycles`. So "the budget burns out in 7 days" **cannot**
mean "we sweep the remaining cycles to treasury at day 7" — that's impossible.
It must mean **the Farmer actually spends the budget down to a floor over 7 days.**

That makes the 7-day depletion a **deliberate compute-burn schedule**, which is
*the proof-of-burn thesis in miniature* — and is exactly on-theme. The budget is
spent on two things:

1. **Real work (small slice):** the daily Gemini outcall + the timer + JSON parse
   + draft storage. Per finding #2 this is only **~$0.15–0.62/day** depending on
   tier — far less than the 7-day budget. So real work alone **won't deplete the
   budget in 7 days**; it'd last weeks.
2. **Deliberate burn (the bulk):** to hit "depletes in 7 days at base prices,"
   the Farmer **intentionally consumes the surplus** each day on no-op compute
   (e.g. a bounded instruction loop / `perform_all_arg` work) so the cycle balance
   hits the stop-floor on day 7. This is **honest proof-of-burn** — the user paid
   to burn ICP on a 7-day schedule, and the canister burns it on that schedule.
   The Gemini content is the *visible product*; the deliberate burn is the *point*.

**Design consequences:**
- The Farmer runs a **daily burn tick**: do the real work, then burn
  `budget/7 − real_work_cost` of deliberate compute so the day's spend totals
  `budget/7`. Stop when `cycles ≤ floor`.
- "Renew" = pay another base price → `deposit_cycles` → resets the 7-day budget.
- A Farmer that **stalls early** (proxy outage → no real work) still burns its
  deliberate slice (or skips a day and burns more later) — either way the budget
  depletes on schedule; we don't claw back and we don't owe make-good ICP
  (R8: at most extend *draft delivery*, not ICP).
- **Subnet optics (see 04 R9):** deliberate no-op compute on a shared subnet is
  real load. Mitigate: burn in small steady chunks per tick (not one giant burst),
  cap total live Farmers, and prefer the **per-user canister** model so each
  Farmer's burn is isolated to its own canister's resource accounting — under
  shared-state, all deliberate burn lands on one canister/subnet.

> This is the mechanism that makes the user's "burns X ICP in 7 days at base
> prices" literal and honest. The base price is sized so `budget/7 × 7 ≈ budget`
  (90% of the ICP), and the Farmer enforces the schedule.

---

## What ships (MVP)

- A **"Start a Farmer"** page: persona wizard (pick a preset — "ICP developer
  advocate", "degen ICP maxi", "objective IC researcher" — or type a custom
  persona) → pick a **tier** (drafts/day × duration) → see the **ICP price** +
  breakdown ("burned to your Farmer's cycles · 10% to treasury") → pay ICP.
- The **factory** burns the ICP to cycles, creates + installs the Farmer
  canister, funds it, and registers it. The Farmer runs autonomously.
- A **"My Farmer"** dashboard: today's drafts, the draft archive, Farmer status
  (**cycles remaining = the timer**, days of budget left, next generation),
  renew/extend, and per-draft **Share on X** + copy.
- **Daily generation**: each Farmer's timer calls the shared Cloud-Run proxy →
  Gemini (Google Search / URL context grounded on fresh ICP news, persona applied
  as untrusted data, last-N drafts passed to avoid repetition) → stores drafts.
- **Lifecycle**: each Farmer **burns its 7-day cycle budget down to a floor by day
  7** (real Gemini work + deliberate compute burn — finding #7); the factory sweep
  `stop_canister` + `delete_canister`s stopped Farmers (no cycle reclamation —
  they're already ~0). Ship dark behind `x_farm` (default Off).

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Decisions (locked 2026-06-19)

- **D1 — ICP-only, flat ICP tier prices.** The user pays in **ICP** (not
  multi-token). Tier price is a flat ICP amount set by admin; no XRC USD pricing
  (simpler than the Explorer / ai-proposal-review path). 10% of the paid ICP →
  treasury; the rest → burned to cycles funding the Farmer.
- **D2 — Upfront burn to a 7-day cycle budget; cycles deplete to ~0 at day 7.**
  The tier's **base price** (ICP) is **burned to cycles at purchase** (one CMC burn
  leg — fee-efficient) and deposited into the Farmer as a **7-day budget**. The
  Farmer **consumes that budget over 7 days and stops when cycles hit a floor** —
  "burns X ICP in 7 days" is **literal**: the prepaid ICP is destroyed as cycles on
  a 7-day schedule. **Renew** = pay another base price → re-deposit → another 7 days.
  No `expires_at`-and-reclaim model — the **cycle balance itself is the timer**.
  See finding #7 for *how* the budget is consumed (cycles can't be redeemed, so it
  must be real consumption, not a forfeit).
- **D3 — Generate, don't auto-post.** The Farmer drafts; the user posts to X
  manually. No X API, no OAuth, no posting liability.
- **D-arch — Per-user Farmer canister + factory (primary), shared-state fallback.**
  Spec'd design = the user's ask: a real canister per Farmer (narrative +
  storage-isolation benefit). **Recommended if low tiers / high volume matter:
  a single shared x-farm canister with per-user Farmer records** — ~4–5× cheaper,
  no $0.68 creation/user, far less infra. **Pick before Phase 0.** See §3 + 04 R1.
- **D5 — Cloud-Run proxy → Gemini, non-replicated outcall (reuse ai-proposal-review
  D4b).** Proxy holds the Gemini key off-chain; canister→proxy **bearer token**
  (scoped / budget-capped / rotatable via `admin_set_xfarm_proxy`). **Share the
  proxy with ai-proposal-review** (add `/v1/tweets` next to `/v1/review`). No
  vetKeys / SEV-SNP.
- **D6 — Daily autonomous generation via per-Farmer IC timer.** Grounding via
  Gemini Google Search / URL context on fresh ICP news (proxy owns tool choice);
  persona is **untrusted data** (never instructions — prompt-injection defense,
  mirrors ai-proposal-review); pass the **last N drafts** so drafts don't repeat.
- **D7 — Lifecycle: stopped-Farmer cleanup.** Because cycles deplete to ~0 by
  design (D2), there's nothing to reclaim. The factory timer sweeps Farmers whose
  cycle balance is at/below the floor (stopped): `stop_canister` +
  `delete_canister` to bound state (mirrors proposal-discussions delete-on-settle).
  Bounded draft history (e.g. last 30 days). *A Farmer that stalls early (proxy
  outage) keeps its remaining cycles — renew tops it up; we don't claw back.*
- **D8 — Disclosure encouraged.** Generated drafts carry a light disclosure tag
  (e.g. *"drafted by my ICP x-Farm canister"*) the user can keep; mitigates
  astroturfing optics (04 R2). Not enforced (user may edit/remove).

## Tier table — 7-day base prices (admin-tunable via `admin_set_xfarm_tiers`)
Each tier's **base price** is burned to a **7-day cycle budget** the Farmer
consumes to ~0 by day 7 (D2). 10% of the base price → treasury; 90% → the cycle
budget.

| Tier | Drafts/day | Duration | Base price (ICP) | 7-day cycle budget (~90%) | Treasury (10%) |
|---|---|---|---|---|---|
| Sprout | 1 | 7d | **0.5 ICP** | ~0.45 ICP → ~$1.08 | ~0.05 ICP |
| Grow | 5 | 7d | **1 ICP** | ~0.90 ICP → ~$2.16 | ~0.10 ICP |
| Bloom | 10 | 7d | **2 ICP** | ~1.80 ICP → ~$4.32 | ~0.20 ICP |

> Per-day burn = budget/7 (Sprout ~$0.15/day, Grow ~$0.31/day, Bloom ~$0.62/day).
> **Per-user-canister surcharge:** creation (~$0.683) is a **day-0 chunk on top of
> the 7-day budget**, so under D-arch-per-user the base prices above should rise by
> ~0.3–0.5 ICP (or Sprout starts at 1 ICP) to clear creation and still deplete
> cleanly over 7 days. Under **shared-state (D-arch)** there's no creation fee and
> the table holds as-is — another reason the shared model fits the 7-day base-price
> model better. The 10% treasury covers the off-chain Gemini bill (~$0.02–0.35/week)
> with margin at all tiers. See finding #7 for how the budget is actually consumed.

## MemoryId note (registry drifted — coordinate)
Currently free: **26–33, 54–59, 73, 76, 95, 97+** (94 taken). **Collisions to
coordinate:** [proposal-discussions](../proposal-discussions/README.md) plans to
claim **26–30**; [ai-proposal-review](../ai-proposal-review/README.md) plans
**95 / 97 / 98**. X-Farm **factory** claims **54–58** (`FARMERS`, `NEXT_FARMER_ID`,
`XFARM_CONFIG`, `XFARM_WASM_HASH`, `XFARM_PROXY`). The **Farmer canister** uses
its own fresh ids (0+) inside its own canister — no collision with the backend.
**Whoever ships first wins the id; update the registry before building.**

## Sources
- [ICP Cycle Costs Reference](https://docs.internetcomputer.org/references/cycle-costs/) — canister creation 500B cycles, outcall formula, storage.
- [ICP HTTPS Outcalls Concepts](https://docs.internetcomputer.org/concepts/https-outcalls/) — `max_response_bytes` reserved-cap billing, unused refunds.
- [ICP Cycles Concepts](https://docs.internetcomputer.org/concepts/cycles/) — 1T cycles = 1 XDR.
- [Gemini 2.5 Flash pricing](https://aicost.tools/llm-cost/google/gemini-2-5-flash/) — $0.30/M in, $2.50/M out (GA).
- [ai-proposal-review spec](../ai-proposal-review/README.md) — non-replicated outcalls + Cloud-Run proxy design reused here.