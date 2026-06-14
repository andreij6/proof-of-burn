# Caldera — Full App Audit

_Date: 2026-06-13 · Scope: backend canister, frontend, tests, docs, agent skill files, build/ops, repo hygiene._

Produced by fanning out three parallel audit agents (backend · frontend · tests/docs/ops) and consolidating their findings.

> **Update 2026-06-13 — issues 1–9 resolved.** The copy/docs-accuracy findings (#2–#8) and the backend pool-reward fund bug (#1/#9) are all fixed; see the Status column and the per-finding ✅ notes below. Backend: 183 tests pass (+2 new pool-reward tests); frontend typechecks clean and tests pass (168; one obsolete `claim_yield` test removed). Remaining open: **#10–#14** (cleanups, the Casino/Poker decision, and pre-mainnet/commit process).

## Baseline health

- Backend: `cargo build -p backend --lib` succeeds (36 warnings, most are false positives from wasm-only code invisible to the host build). `cargo test -p backend --lib` → **181 passed / 0 failed / 0 ignored**.
- Frontend: `npx tsc -b` clean. `npx vitest run` → **169 passed / 0 skipped**.
- Candid: method surface matches the Rust service 1:1; bindings regenerate cleanly.

Everything compiles and tests pass. **Almost every finding below is accuracy/correctness/hygiene debt left by the recent rapid redesign** (burn-only voting, staking→lottery-tickets, SVP/SVPP retired, casino disabled, Early Adopters→Perm, Pool Neurons→Verified Followers/top-100, free upvotes, USD project goals, 50/50 yield, feature-flag default flip). **All changes are local-only; mainnet still runs the old model.**

---

## Priority summary

| # | Sev | Area | Status | Finding |
|---|-----|------|--------|---------|
| 1 | **High** | Backend correctness | ✅ Fixed | Verified-Follower pool rewards under-paid on retried burns and never retried a failed recipient payout |
| 2 | **High** | Agent docs | ✅ Fixed | `llms-early_adopters-validate.txt` pointed at a **deleted file** + non-existent tests for a money-locked feature |
| 3 | **High** | Agent docs | ✅ Fixed | `llms-rd-*.txt` advertised **paid upvotes** (75/25, `upvote_idea(id, token, amount)`); upvotes are now free |
| 4 | **High** | Agent docs | ✅ Fixed | `llms-prod/local.txt` framed the protocol as "rent/buy voting power" — voting is burn-only |
| 5 | **High** | Docs | ✅ Fixed | Yield split documented as **80/20** but code is **50/50**; `GROWTH_TARGETS.md` falsely marked 80/20 "✅ Implemented" |
| 6 | **High** | Docs | ✅ Fixed | Docs referenced a **0.005 ICP protocol commit fee** that no longer exists (commits are zero-fee); break-even math wrong |
| 7 | **High** | Frontend copy | ✅ Fixed | `Admin.tsx` said "**top 25**"; actual is top 100. The real error was `App.tsx` claiming the split is proportional — it is **equal** per qualifying owner |
| 8 | **Med** | Frontend copy | ✅ Fixed | Admin/Payouts/Dashboard described **Early Adopters as an ICP-paying monthly annuity** (now Perm, tickets-only) |
| 9 | **Med** | Backend | ✅ Fixed | `pool_distributed` latched before transfers → no recovery if a payout leg fails |
| 10 | **Med** | Backend | ⬜ Open | Stale section banners (§13, §18) + dead `EarlyAdopterInfo` fields exposed via candid |
| 11 | **Med** | Frontend | ⬜ Open | Casino/Poker dormant but intact — flipping `crash`/`poker` re-exposes retired **SVPP** UI (reactivation hazard) |
| 12 | **Med** | Ops | ⬜ Open | Prod/local divergence: `deploy-prod.sh` sets no flags; new wasm flips behaviour on install; no EA→Perm state-migration test |
| 13 | **Med** | Consistency | ⬜ Open | Container-width + header-anatomy inconsistency across Lottery/Staking vs hub/Earn pages |
| 14 | **Med** | Hygiene | ⬜ Open | The entire redesign (~14 files) is **uncommitted on `main`** |

---

## 1. Backend — correctness & money flows

### ✅ HIGH — Pool rewards under-pay on retried burns; no payout retry — FIXED
`distribute_pool_rewards` used to latch `pool_distributed = true` up front and pay each recipient once against the settle-time burn total, so retried `FailedBurn` commitments never paid the top-100 their 25% of the extra burn, and a failed `call_ledger_transfer` was logged but never retried.
**Fix shipped:** distribution is now **idempotent and incremental** per `(proposal, recipient)`:
- New stable map `POOL_REWARDS_PAID: StableBTreeMap<PoolRewardKey, u64>` (**MemoryId 75**) tracks the cumulative gross e8s paid to each recipient. Each run pays only the *delta* between the current target share (`total_burned/4/n`) and what they've already received — so retried burns **top up** and a re-run **never double-pays**.
- `retry_failed_settlements` now sets `pool_distributed = false` when a retried burn bumps `total_burned_e8s`, re-opening distribution; the sweep then tops up.
- A failed transfer leaves that recipient's `POOL_REWARDS_PAID` unchanged and `pool_distributed` un-latched, so the next sweep **retries** the outstanding share.
- A new in-memory `PoolDistLock` (mirrors `ProposalLock`) guards against the public `distribute_pool_rewards` endpoint racing the sweep across an await point.
- Coverage: `test_pool_rewards_top_up_on_retried_burn`, `test_pool_rewards_retry_after_failed_transfer` (existing idempotency/no-op tests still green). 183 backend tests pass.

### ✅ MEDIUM — `pool_distributed` latched before any transfer — FIXED
The flag is no longer written before transfers. It is latched only once **every recipient has reached target with no failed transfer and no larger burn total landed mid-flight** (`finalize()` re-reads the proposal and checks `total_burned_e8s == distributed_against`). Distribution is now fully recoverable.

### LOW — token-commit burn accounting can drift
`ensure_commitment_swapped` (`~2110–2114`) overwrites `commitment.amount_e8s` with post-swap ICP (minus fees) while pots/`total_committed_e8s` were recorded at the commit-time oracle rate; aggregates then use the post-swap figure. Acceptable, but reconcile or document for volatile tokens.

### INFO — verified sound
Burn split (`settle_burn_split` `2163–2265`) covers rounding via a remainder term, per-leg idempotency, treasury-fronted fees with balance checks. Lottery payout and yield-split sagas persist block indices before status (retry-safe). Division-by-zero guarded (`n==0`, odds `max(1)`).

## Early-Adopter / "Perm" settlement — INFO (verified clean)
`early_adopter_route_yield` (`10941–10946`) → `(restake=0, treasury=yield/2, lottery=yield/2−fee)`; `early_adopter_run_settlement` routes to `TREASURY_SUBACCOUNT` + `LOTTERY_SUBACCOUNT`, records `distributed_e8s: 0`, and `claim_early_adopter_yield` hard-refuses. **No path pays ICP to users.** Legacy `claimable_e8s` only drains pre-migration shares to treasury.

## 2. Backend — security & upgrade safety (INFO — solid)

- All 40 `admin_*` methods use `#[ic_cdk::update(guard = "require_admin")]` (zero gaps). `require_admin` rejects anonymous then checks the admin set.
- `inspect_message` (`667–676`) traps anonymous on every ingress update except `wallet_receive`; update bodies independently `require_authenticated()`.
- Dev endpoints gated by `require_local_dev` — **LOW:** `dev_faucet`, `dev_faucet_token`, `dev_seed_pool_neuron` inline the same `is_local` check instead of calling `require_local_dev()`; unify for auditability.
- Upgrade safety clean: MemoryIds 0–74 with retired-id gaps never reused; added fields carry `#[serde(default)]`; init/post_upgrade parity good.
- **LOW:** `notify_top_up` is an anonymous-reachable stub (mock on local, error on mainnet) — remove before mainnet.

## 3. Backend — dead/stale code from the migration

- **MEDIUM:** §13 banner (`5830–5843`) still says "stakers vote on tracked proposals for free"; §18 banner (`10704–10721`) still describes the monthly share-pool/claim model. Misleading to any auditor.
- **MEDIUM:** `EarlyAdopterInfo` still exposes dead fields (`share_pool_e8s`, `my_claimable_e8s`, `total_distributed_e8s`, `min_distribution_e8s`, `close_threshold_e8s`, `restake_threshold_e8s`, `10866–10874`) computed from now-dead state, mirrored in `backend.did:288–333`. Consider dropping (coordinated candid + frontend change).
- **LOW:** dead constants — `MAX_EARLY_ADOPTERS` (genuinely unused), and `EARLY_ADOPTER_TREASURY_CUT/CLOSE_YIELD/RESTAKE_BELOW/MIN_DISTRIBUTION` no longer drive routing (fixed 50/50) yet still surface for display.
- **LOW:** `Proposal.lossless_adopt_e8s/reject_e8s` always 0; `LOSSLESS_VOTES` map never written (still read in `arcade_access` `10140` as a permanently-false OR-term — harmless). `user_voting_weight`/`staked_voting_power`/`stake_weight_e8s`/`vp_tenure_multiplier` now feed only the disabled casino + stake-info display.

## 4. Frontend — copy accuracy (stale vs current behaviour)

### HIGH
- ✅ **`Admin.tsx:938`** — "25% … split **equally** among the **top 25** pool neurons." Was wrong on the count (**top 100**). Investigation also showed the *real* error was the opposite-direction claim in `App.tsx` ("the bigger your neuron, the bigger your share") — the canister splits `total_burned/4` **equally** per distinct owner (`distribute_pool_rewards`, `lib.rs:966`), not proportionally. **Fixed:** Admin → "top 100, split equally"; `App.tsx` rewritten to "split equally; voting power only decides who makes the top 100"; `App.tsx:1557` comment + `Payouts.tsx` blurb updated.
- ✅ **`public/llms-prod.txt` + `llms-local.txt`** — "Why Use This Protocol?" framed it as **rent/buy voting power**. **Fixed:** rewritten to burn-only conviction framing (mechanics sections were already correct).

### MEDIUM
- ✅ **`Admin.tsx:964–976`, `Payouts.tsx:72`, `hubLogic.ts:45`** — described Early Adopters as a live ICP-paying monthly annuity. **Fixed:** Admin section rewritten to the Perm tier (tickets-only, 50/50 yield, no payout); Payouts `EarlyAdopterYield`/upvote-share blurbs marked legacy; the dead `claim_yield` attention card (always 0 under Perm, routed to a redirect) **removed** from `hubLogic.ts` along with its test.
- ✅ **`Dashboard.tsx:217`** "Founder stake" → "Perm stake".
- ✅ **`Admin.tsx:571,638`** neuron/treasury help updated (Perm, 50/50). **Not changed (out of scope):** `IdeaBoard.tsx:869` seed-idea example copy (low risk).

## 5. Frontend — consistency, dead code, UX

- **MEDIUM (consistency):** width split — Earn/Verified-Followers + LotteryHub use `idea-board-container` (1080px) while `Lottery.tsx:142`, `Staking.tsx:316`, `Payouts.tsx:241`, `Admin.tsx:399` use `dashboard-container` (720px), so hub→subpage visibly reflows. Header anatomy also varies: some pages use `<h4>` (Explorer/Earn/LotteryHub/Casino), Lottery/Staking use a bold `<span>`/`<b>` instead of a heading — breaks the documented anatomy + doc outline.
- **MEDIUM (reactivation hazard):** `Casino.tsx`/`Poker.tsx` are dormant (flags off) but intact with retired **SVPP** copy (`Casino.tsx:343,352–353`; `Poker.tsx:214`; ticker promo `App.tsx:1960`). Flipping `crash`/`poker` re-exposes retired UI. If retirement is permanent, remove the routes/flag plumbing/`cards.ts`/`crashMath.ts` and the Admin "Seed bots & grant me SVPP" tool; otherwise it's a live re-activation hazard.
- **INFO (candid bindings — healthy):** optionals handled via the `__kind__` wrapper throughout; the historically-buggy `fetchMyPoolNeuron` is fixed/commented; e8s stays `bigint`, narrowed only at format time. **LOW:** `Dashboard.tsx:308` floors bigint before ×100 (fine for whole-ICP Perm stakes).
- **LOW (reuse):** a few hand-rolled `<button>`s (skill-copy at `App.tsx:2401–2433`, `Lottery.tsx:171`) and a duplicated modal-scrim literal `rgba(12,10,9,0.85)` (ui.tsx/IdeaBoard/Explorer/App pool modals) should be `Btn`/a `--scrim` CSS var.
- **INFO:** error handling (`__kind__ === "Err"` guards + banners), loading states, and disabled-state logic (incl. Perm `boosterAck` gate) are solid.

## 6. Tests

- **INFO:** backend suite (~230 tests) covers the reworked areas — burn-only threshold (`test_staked_weight_does_not_affect_threshold`), Perm tickets/yield (`test_booster_daily_tickets_100_per_icp`, `test_early_adopter_settlement_routes_50_50_no_user_payout`, `test_boosters_open_forever_no_gates`), top-100 payout (`test_distribute_pool_rewards_pays_top_members_once`), free upvotes, USD goals (`test_admin_project_usd_goal_and_accepts_all_crypto`). No skipped/ignored tests.
- **LOW (false-confidence tests):** `test_split_upvote_75_25` (`16779`) tests a 75/25 helper with no live caller (upvotes are free); `test_vp_tenure_doubling` / `user_voting_weight` tests exercise the dormant casino-only VP path — both pass but imply live features that aren't. Rename/remove or comment as casino-only.
- **MEDIUM (coverage gap):** frontend tests are pure-logic only (`crashMath`, `cards`, minigolf, etc.). **No render/interaction tests** for the rewritten pages (Staking, Lottery/LotteryHub, Payouts, IdeaBoard, the Verified-Followers Earn view) — exactly the "dead button / candid-optional" class of bug has no coverage. Add smoke/render tests for the reworked flows.

## 7. Docs — accuracy (economically load-bearing; several are now false)

- ✅ **HIGH (yield split):** code is **50/50** (`settle_yield_split`, `7443`). **Fixed:** `OPS.md:99`, `ECONOMICS_PLAYBOOK.md:183` corrected to 50/50; `GROWTH_TARGETS.md` §5/§6 return math rebased on 50/50 (2-yr EV 6.2%→3.1%, pot inflow 47→29 ICP/mo) and the false "✅ Implemented" changed to "⬜ PROPOSED, NOT SHIPPED — code still splits 50/50." The genuinely-correct 80% `LOTTERY_WINNER_SHARE_PCT` references (winner's share of the pot) were left intact.
- ✅ **HIGH (protocol fee):** commits are zero-fee. **Fixed:** removed the 0.005 ICP fee from `ECONOMICS_PLAYBOOK.md` (intro, non-configurable list, revenue math, and the break-even formula/table — now `treasury_income = committed × 0.50`), `MAINNET.md:94`, and `configurations.md:232`.
- **MEDIUM:** `docs/OPS.md:89–91,125–144` describes retired staked-voting + the `lossless_vote` audit event and omits the Booster (100/ICP/day) path entirely — no Perm/Booster section despite a full Crash section. `docs/ECONOMICS_PLAYBOOK.md:39–49` feature-flag default table is wrong (claims lottery/arcade/early_adopters default OFF; actual default-OFF set is only `arcade_turborush/crash/poker/ticker`). EA economics in docs (`:143,149,244–245`) contradict code constants and the now-no-user-payout model.
- **INFO:** `README.md:27–36` is moderately stale (pooled staking "proportional yield", Early Adopters "shares yield proportionally", old names). There is **no `CLAUDE.md`** (conventions live in `.claude/skills/`).

## 8. Agent skill files (`src/frontend/public/llms-*.txt`) — shipped to AI agents as ground truth

- ✅ **HIGH — `llms-early_adopters-validate.txt`:** pointed at the deleted `EarlyAdopters.tsx` and nonexistent tests; every advertised rule was false. **Fixed:** fully rewritten to validate the current **Perm tier** (permanent stake, 100 tickets/ICP/day, 50/50 yield with no user payout, open-forever), pointing at `Staking.tsx` and the tests that actually exist.
- ✅ **HIGH — `llms-rd-prod.txt`/`llms-rd-local.txt`:** advertised paid upvotes. **Fixed:** rewritten to free `upvote_idea(idea_id)` (once per principal), with projects described as a single USD goal fundable in any token; the "must hold tokens to upvote" prerequisite was corrected.
- **INFO:** `llms-prod.txt`/`llms-local.txt` core burn flow (zero-fee commits, escrow, thresholds, `commit_token`, USD thresholds) is accurate. `llms-lottery-*` and `llms-rd` upvote-expiry/lottery numbers are otherwise fine. `llms-crash-*` describe disabled features.

## 9. Build / deploy / ops

- **MEDIUM:** `scripts/deploy-prod.sh` sets **no** feature flags/economics (just prints `list_feature_flags`), so installing the new wasm on mainnet would silently flip behaviour (new defaults turn arcade/early_adopters/lottery ON; commits become zero-fee; EA becomes Perm/no-payout) while the prod `llms-*` docs still describe the old model. **No EA→Perm stable-storage migration test was found.** Before any mainnet upgrade: reconcile prod docs/llms files, explicitly script the intended prod flags, and verify the EA state migration path.
- **LOW:** `deploy-local.sh:100–104` comment references the retired "SVPP/points redesign" (functionally correct — it forces crash/poker off).
- **INFO:** `feature_default` OFF-set (`arcade_turborush/crash/poker/ticker`) matches `deploy-local.sh`; `icp.yaml`/`package.json` consistent; no flag drift.

## 10. Repo hygiene

- **MEDIUM:** the entire redesign (~14 modified + 1 deleted + 3 untracked, incl. `lib.rs`, `backend.did`, 9 frontend pages, deleted `EarlyAdopters.tsx`, new `LotteryHub.tsx`, new skill) is **uncommitted on `main`**. Project convention is to branch for shippable work — commit it off `main`.
- **LOW:** `.DS_Store` is tracked and there's no gitignore rule for it (`git rm --cached` + add `**/.DS_Store`). A 467 KB `public/dapp-factory.png` ships to every client.
- **LOW:** many scratch/planning docs at repo root (`Fable tasks.md`, `FABLE-IDEAS.md`, `GOALS.md`, `IDEAS.md`, `observations.md`, `plans/`, `house-keeping/`, `tasks/`, `gemma-reviewer/`) clutter the root and may be stale — move under `docs/` or a gitignored `notes/`.

---

## Recommended order of attack

✅ **Done 2026-06-13 (#1–#9):** the pool-reward fund bug + payout retry (#1, #9), the agent skill files (#2–#4), the economics docs (#5–#6), and the admin/UI copy incl. the `claim_yield` dead card (#7–#8) have all been fixed. Remaining:

1. **Decide Casino/Poker's fate** — fully retire (remove routes + SVPP code) or keep, but close the reactivation hazard (#11).
2. **Pre-mainnet checklist** — script prod flags, reconcile prod docs, and add an EA→Perm state-migration test before any prod upgrade (#12). Note the docs were corrected for local/current behaviour; a prod upgrade still flips behaviour on install.
3. Cleanups: dead backend banners/fields/constants (#10), container/header consistency (#13), commit the redesign off `main` + `.DS_Store`/scratch hygiene (#14), add frontend render tests + retire the now-stale `test_split_upvote_75_25` / casino-only VP tests (#6).
