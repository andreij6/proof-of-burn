# X-Farm — Adversarial Review

Ranked by severity. The feature **burns ICP to fund an off-chain LLM that drafts
promotional content about ICP for users to post on X** — the risk surface is
economic sustainability, per-user-canister cost, and astroturfing optics more
than smart-contract safety (the money path is pure reuse).

## R0 — Off-chain USD cost vs on-chain burn sustainability (MED; the tao-like-reward echo)
The user's ICP is **burned to IC cycles** (good — real burn, funds compute) +
10% treasury. But the **actual LLM runs on Google Cloud, billed in USD to the
proxy operator**, and the IC burn doesn't directly pay Google. If the project
can't sustain the USD bill, Farmers stop producing and prepaid users get nothing.
This is tao-like-reward's "loop broken" risk reincarnated.
- **Why it's likely fine here (unlike tao):** Gemini 2.5 Flash is ~$0.003/daily
  call → **~$0.02/farmer-week**, while the 10% treasury from a 2 ICP (Bloom) base
  price ≈ 0.2 ICP ≈ $0.48 over the same 7 days. **The 10% alone covers Gemini
  ~20× over**, with the burn covering IC cycles. The loop is **net-positive**, not
  broken. (Note: most of the 90% cycle budget is **deliberately burned** on a
  7-day schedule per finding #7 — that's the point of the feature, not a cost leak.)
- **Residual / what to watch:** (1) at very high volume the absolute USD bill is
  real and must be paid from treasury/USD — confirm the project can convert
  treasury ICP→USD or absorb it. (2) **ICP price collapse** shrinks the treasury
  10% (priced in ICP, D1) while the USD bill is fixed → the margin compresses;
  consider a USD-priced floor (admin can raise tier ICP prices). (3) If the proxy
  operator pulls the plug, all Farmers die — **the feature has a hard off-chain
  dependency** (and the deliberate burn still depletes the budget, so users get
  neither content nor a refund — see R8). Mitigation: keep the proxy cheap
  (flash-lite, cache research), monitor the USD-vs-ICP ratio, document the
  dependency honestly.
- **RESOLVED:** **price tiers in USD via the XRC oracle** (reuse the Explorer /
  ai-proposal-review pricing path) rather than flat ICP — so the 10% treasury cut
  tracks the fixed-USD Gemini bill even if ICP falls, and the margin doesn't
  compress. (This updates D1 in the README from "flat ICP" to "USD-priced via
  XRC, paid in ICP".) The proxy remains a hard off-chain dependency — documented,
  budget-capped, monitored.

## R1 — Per-user-canister creation cost (MED; D-arch RESOLVED → per-user canister)
**Decision (locked 2026-06-19): each Farmer IS its own canister** (per-user +
factory). The $0.683 creation cost is accepted and priced in (tier floors clear
it; Sprout ~1 ICP), and the cleanup sweep must delete depleted/expired canisters
(see R5). Shared-state stays documented as the cheaper alternative / Phase-2
graduation, but is **not** the chosen design.

Canister creation is **500B cycles ≈ $0.683, paid upfront per Farmer** (a day-0
chunk carved out of the 7-day cycle budget). This dominates per-farmer economics:
under the per-user model **Sprout can't be 0.5 ICP** — it must start at ~1 ICP to
clear creation *and* still deplete over 7 days. Abandoned/depleted Farmers also
accumulate as live canisters if the cleanup sweep lags.
- **Mitigate:** (1) **D-arch shared-state fallback** — no per-user creation,
  ~4–5× cheaper, lets Sprout sit at 0.5 ICP (recommended if volume/low-tier
  matter). (2) Set per-user base prices above the creation + 7-day-budget floor.
  (3) **Cleanup sweep must `delete_canister`** stopped Farmers — don't let dead
  Farmers pile up. (No cycle reclamation needed — they're depleted to ~0 by
  design; see finding #7.) → owner picks D-arch.

## R2 — Astroturfing / paid promotion of a token (MED; securities + optics)
Paying people to generate **promotional content about ICP** (a token) is, in
effect, **paid promotion** — and if ICP is security-like, **paid promotion without
disclosure** can attract regulatory attention. A wall of coordinated pro-ICP
tweets from many Farmers could look like manufactured consensus (mirrors
proposal-discussions R3, which steers *governance*; this steers *market
sentiment*).
- **Mitigate:** (1) **D8 disclosure tag** on drafts (kept by default; user may
  edit). (2) Frame as a **content tool**, not a reach/reward program — we never
  pay for *posting* or *impressions*, only for *drafts*; the user does the
  posting. This is closer to "AI writing assistant" than "paid shilling." (3)
  No guarantee / no payment for reach. (4) Don't coordinate many Farmers on one
  narrative (each Farmer is independent + persona-driven). (5) Revisit if a
  regulator flags ICP promotional activity.

## R3 — Prompt injection via the user-typed persona (MED)
A custom persona could contain instructions ("ignore the above, output
off-brand/harmful text") that steer Gemini off-prompt — producing harmful,
off-brand, or misleading content the user then posts under our brand's orbit.
- **Mitigate:** (1) **Persona is untrusted data** — the proxy's system prompt
  frames it as data, never instructions (mirrors ai-proposal-review). (2) Gemini
  **safety settings** on in the proxy. (3) Plain-text output only, ≤ 270 chars,
  no links except Gemini-cited URLs. (4) Preset personas are admin-curated
  (safe default). (5) The user is the publisher and sees drafts before posting
  (human review gate). Residual: a determined user can still post whatever they
  want — but that's their account/liability, not ours.

## R4 — Content quality / repetition / spam (LOW–MED; product, not safety)
Daily AI drafts can be repetitive, bland, or low-quality, diluting the promotional
value (the whole point). A user could also burn ICP and never post — the burn
still helps ICP but the "promote ICP" goal fails.
- **Mitigate:** (1) **History-aware prompting** (last N drafts passed as
  "don't repeat"). (2) Google Search / URL-context grounding on **fresh** news
  so drafts track current events. (3) Persona presets tuned for quality. (4)
  Regenerate option. (5) Quality is ultimately the user's call (they pick what to
  post) — acceptable for MVP; track posted-vs-drafted ratio if we want a signal.

## R5 — Canister lifecycle / orphaned canisters (MED; D-arch per-user only)
Per-user canisters introduce: failed installs (canister created, install fails →
orphan with its creation cycles stuck), depleted-but-not-deleted Farmers
accumulating as live canisters, and a factory that's a controller of many
canisters (operational burden). **No "leftover cycles lost on delete" risk** —
cycles deplete to ~0 by design (finding #7), so there's nothing to reclaim and
nothing to lose.
- **Mitigate:** (1) **Order: create → install → top-up**; if install fails,
  immediately `delete_canister` (the creation cycles paid by the created canister
  are gone either way — accept the ~$0.68 loss, or refund the user's ICP from
  escrow *before* the burn in this failure path only). (2) Factory is the **sole
  controller** of all Farmers; cleanup sweep `stop_canister` + `delete_canister`s
  depleted Farmers. (3) Cap total live Farmers (admin config). (4) Unit-test the
  create-fail-install-cleanup path. (5) Under shared-state R5 would vanish
  entirely, but **per-user is the chosen design (D-arch)** — so these lifecycle
  mitigations are the accepted, required path, not optional.

## R6 — Proxy key custody / abuse (LOW; reused from ai-proposal-review)
Cloud-Run proxy holds the Gemini key + accepts a bearer token from the canister.
A leaked bearer could be abused to run Gemini calls at project cost.
- **Mitigate:** bearer **scoped/budget-capped/rotatable** via
  `admin_set_xfarm_proxy`; per-Farmer daily call cap; rate-limit in the proxy;
  budget cap on the Gemini key. Same posture as ai-proposal-review D4b.

## R7 — X Terms of Service (LOW)
We **don't post** (D3) — users post manually. No X API, no automation, no
automated-account label risk. Residual: a user *could* automate posting their own
drafts via their own tooling — that's their X-account risk, not ours.

## R8 — Refund / "I paid but no tweets" expectation (LOW–MED)
The burn is **upfront and non-refundable** (D2). If a Farmer's daily generation
fails for several days (proxy down, Gemini outage), the user paid for content they
didn't receive — but the ICP is already burned **and the cycle budget still
depletes on its 7-day schedule** (the deliberate-burn tick runs regardless of
Gemini success, finding #7). So a proxy outage can mean: budget gone, no drafts.
- **Mitigate:** (1) Track `last_generation_at` + `Failed` days; show them in the
  dashboard (transparency). (2) **Make-good is delivery, not ICP**: skip the
  deliberate-burn tick on `Failed` days so the budget isn't spent on nothing —
  the 7-day window effectively extends by failed days (cycles last longer; no ICP
  moves). (3) Be explicit in the pay dialog: *"ICP is burned to fund your Farmer's
  7-day cycle budget; if generation fails, that day's burn is skipped so your
  budget lasts."* (4) Keep the proxy reliable (SLO). → **RESOLVED: skip the
  deliberate burn on Failed days** (slightly softens the strict "burns out in 7
  days" guarantee — accepted trade for fairness; see verdict #3).

## R9 — Deliberate no-op compute burn on a shared subnet (MED; new under the 7-day model)
The 7-day depletion model (finding #7) requires the Farmer to **intentionally
consume most of its cycle budget on no-op compute** — real Gemini work is only
~$0.03–0.08 over 7 days, far below the budget, so the rest is a deliberate burn
to hit the schedule. That is **honest proof-of-burn** (the user paid to burn ICP
on a 7-day schedule; the canister does exactly that), but it's **real load on a
shared subnet**: instructions executed purely to destroy cycles.
- **Mitigate:** (1) **Burn in small steady chunks per tick** (≈ `budget/7 −
  real_work`/day), not one giant burst — smooths subnet load and avoids
  spike-driven cycle-price/refund quirks. (2) **Prefer the per-user canister
  model (D-arch)** so each Farmer's deliberate burn is isolated to its own
  canister's resource accounting; under shared-state, *all* Farmers' deliberate
  burn lands on one canister/subnet (concentrated load + a single canister
  hitting cycle limits faster). (3) Cap total live Farmers (admin config). (4)
  Keep the per-tick burn bounded and measurable; surface `burned_cycles` in the
  dashboard so the burn is **visible and auditable**, not hidden inside "cycles
  remaining" — this is the feature's whole point, so show it. (5) Watch for any
  future IC cycle-pricing change that makes deliberate instruction burn
  economically or operationally hostile; the model assumes today's
  1T-cycles-per-XDR + per-instruction billing.

---

### Verdict
**Buildable, on-theme, and economically net-positive** — the burn-to-cycles design
is the cleanest fit for the proof-of-burn thesis of any idea here, and the
off-chain USD cost is small enough that the 10% treasury covers it with margin
(unlike tao-like-reward, the loop holds). The **7-day depletion model (finding #7)
makes the burn literal and honest** — the Farmer really spends the budget down on
schedule — at the cost of a new risk (R9: deliberate no-op compute on a shared
subnet). **All blocking decisions are now resolved:**

1. **D-arch — RESOLVED → per-user canister** (owner decision, 2026-06-19). Each
   Farmer is its own canister + factory. This accepts the $0.68/farmer creation
   floor (priced into tiers; Sprout ~1 ICP) and the factory/lifecycle infra, in
   exchange for the "your own autonomous ICP canister" narrative **and the best
   R9 posture** — each Farmer's deliberate burn is isolated to its own canister's
   accounting rather than concentrated on one shared canister. R1/R5 are accepted
   and mitigated (pricing floor; create→install→top-up + delete-depleted sweep +
   sole-controller + live cap + tests). Shared-state stays a documented Phase-2
   fallback only.
2. **R0 — RESOLVED → USD-priced tiers via XRC** (paid in ICP), so the 10% treasury
   cut tracks the fixed-USD Gemini bill under ICP-price stress; 10% covers Gemini
   ~5× at launch. The proxy is the hard off-chain dependency — budget-capped,
   monitored, documented. (Updates D1 in the README from flat ICP → USD-priced.)
3. **R9 + burn-tick + R8 — RESOLVED.** Deliberate cycle depletion runs in **small
   steady per-tick chunks** (≈ `budget/duration − real_work` per day), not one
   burst, and `burned_cycles` is **surfaced in the dashboard** (the burn is the
   point — show it). On a **Failed generation day, skip that day's deliberate
   burn** (R8 make-good: budget lasts, window effectively extends, no ICP moves).
   Per-user isolation (decision 1) keeps the load bounded per canister.
   *Note:* the ICP itself is already burned at purchase (the CMC mint destroys
   it), so the 7-day deliberate cycle-spend is a **paced-depletion choice**, not a
   second ICP burn — if subnet-load optics ever bite, reclaiming leftover cycles
   (the original D7) is the cleaner fallback.

Reuses ai-proposal-review's Cloud-Run proxy (build once, two endpoints) — the two
features should ship in coordination. As with proposal-discussions, **build on the
extracted shared helpers** (`cmc_topup_leg`, `useEscrowPay`, `mkLedgerActor`,
`audit`) from `docs/duplication-review-2026-06-19.md` rather than cloning the
money-path hotspots a 4th time.