# Core Launch Readiness Review — 2026-06-14

**Question asked:** *Are the core features ready to start getting users today?*
**Core scope (audited):** Voting · Neuron Syndicate (pool neurons) · Lottery (Drawings + Stake-to-Earn + Perm) · Community R&D (ideas + projects) · Dapp Explorer · Dashboard · Wallet/Payouts · Admin · Auth (Internet Identity) · Landing.
**Explicitly out of scope (to stay OFF):** Arcade (Mini Golf / Course NFTs **and** Field Goal), Crash/Casino, Cycles Faucet.

---

## TL;DR verdict

**The core product is functionally complete and green in code — but it is NOT safely launchable to real users *today* without four deploy-prep steps.** The blockers are about *shipping*, not about the features themselves.

- ✅ **Code quality / functionality:** core features are built, gated correctly, and all automated tests pass.
- 🟥 **Production deployment:** not ready as-is. See "Launch blockers" — chiefly (1) all current work is uncommitted/local, (2) no tested upgrade-migration against the live mainnet canister, (3) Arcade + games **default ON** and must be explicitly disabled on prod, (4) `deploy-prod.sh` sets no flags / runs no migration.

**Recommendation:** the app is demo-ready locally today. A safe *public* launch is realistically a short, well-defined runway (commit → tested upgrade on a staging canister → flip flags → go), not a same-hour push.

---

## Test & build status (this audit)

| Suite | Result |
|---|---|
| `cargo test -p backend --lib` | ✅ 266 passed / 0 failed |
| Frontend `tsc -b` | ✅ exit 0 |
| Frontend `vitest` | ✅ 267 passed (10 files) |
| `cargo test -p course_nft` | ⚠️ 0 tests run (course NFT is out of core scope) |
| `src/backend/tests/integration.rs` (PocketIC) | ⚠️ **NOT run this session** — unit tests only |

Backend `TODO/FIXME/panic!` count in `lib.rs`: **2** (low).

---

## Per-feature readiness

### Voting (burn voting) — ✅ Ready
Burn-to-vote flow is the most mature path (saga with per-leg block-index idempotency, treasury fronts fees, retried settlement). Note: the Voting page and nav entry are **always on (no feature flag)** — fine for core, but it cannot be toggled off.

### Neuron Syndicate (pool neurons) — ✅ Ready (recently reworked)
Register a neuron (hotkey + follow leader), pay a one-time fee, earn 25% of each settled burn split among the top 100 by voting power. This session: fee set to **10 ICP**, join dialog simplified (clean fee, no fee-split copy, wallet button on insufficient balance, hotkey docs link), member cards reworked (ID title, Rank badge, registered date, Explorer card style). Always on (no flag). **Verify the 10 ICP fee is the intended public value before launch.**

### Lottery (Drawings + Stake-to-Earn + Perm) — ✅ Ready
Tabbed page (Drawings / Stake to Earn Tickets). Lossless: staking principal never spent; draws 3×/week, only run when pot ≥ 25 ICP, 1-in-13 per-draw odds via `raw_rand`; winner 80% / 20% rolls over; payouts journaled + retried. Daily tickets: term tiers 5/10/20 per ICP; **Perm now 40/ICP/day** (changed this session from 100, backend constant + all copy updated, test green). Gated by `lossless_lottery` (+ `early_adopters` for the Perm tab).

### Community R&D (ideas + projects) — ✅ Ready
Post (1 ICP anti-spam, 100% treasury), free upvotes (1/user, resets 30-day expiry), admin-curated projects with USD goals accepting ICP/ckBTC/ckETH. Gated by `idea_board`.

### Dapp Explorer — ✅ Ready
Paid listings + XRC USD oracle. Gated by `dapp_explorer`.

### Dashboard — ✅ Ready
Every tile is flag-gated; no Arcade/Casino/Faucet tile leaks when those flags are off (verified). Admin tile is `isAdmin`-gated.

### Wallet / Payouts — ✅ Ready
Per-user payout history (lottery, pool rewards, refunds, unstake), wallet deposit/withdraw. Profile bounces signed-out visitors after auth resolves.

### Admin — ✅ Ready (admin-only)
Feature flags, thresholds, lottery config, pool fee, treasury. Includes the new course-moderation section (admin-only; harmless even with courses off).

### Auth (Internet Identity) — ✅ Ready
II via `@icp-sdk/auth`; progressive-disclosure tiers; signed-out users no longer see dead "Sign in to…" buttons (fixed this session).

### Landing — ✅ Ready (copy caveat)
Markets only Voting / Staking / Lottery / Community R&D / "Built for agents" — no games/casino/courses. Sections are **hardcoded (not flag-aware)**: fine now (all core on), but if you later disable a core feature the landing would still advertise it. Tagline still says "…play…" (generic; the lottery is arguably "play").

---

## Cross-cutting

### Feature gating / leaks — ✅ (with one prod-config gotcha)
Earlier full leak audit + fixes: Arcade/Casino/Faucet nav, dashboard tiles, and page routes are all flag-gated; deep-link `#/arcade|casino|faucet` no longer flash-render before redirect. **Gotcha:** `feature_default()` defaults **everything ON except Crash and Cycles Faucet** — so `arcade`, `arcade_minigolf`, and `arcade_fieldgoal` **default ON**. On a fresh prod canister with no flag overrides, the games would be live. They must be explicitly turned **Off** post-deploy (see blockers).

### Security — ✅ reasonable for core
Admin guards on mutating endpoints; anonymous-caller rejection; per-user reads keyed off caller. Value-moving flows have native mock seams + tests.

### Upgrade safety (this session's backend changes) — ✅ self-consistent
`ActivePoolNeuron.registered_at` (recomputed cache, not persisted long-term), `CourseListing.hidden` (`#[serde(default)]`), pool-fee/Perm-ticket constants — all upgrade-safe, no MemoryId reuse. The risk is **not** these deltas; it's the cumulative diff vs the *live mainnet* version (below).

---

## 🟥 Launch blockers (must clear before real users)

1. **Everything is uncommitted and local.** 30 modified files on `main` (this session's UI + 10 ICP fee + 40-ticket + moderation backend + nav/back-button + tabbed lottery) are **not committed, not pushed, not on mainnet.** Mainnet runs an older version. → Commit → PR → review → deploy.

2. **No tested upgrade/migration against the live prod canister.** Mainnet holds real stable state from an older economics model. A production `post_upgrade` that fails to decode old state **bricks the canister**. There is no migration test. → Dry-run the upgrade on a throwaway/staging canister seeded with prod-shaped data before touching production.

3. **Arcade + both games default ON.** `deploy-prod.sh` sets **no** feature flags. → After deploy, explicitly set `arcade`, `arcade_minigolf`, `arcade_fieldgoal` = **Off** (Crash + Cycles Faucet already default Off). Confirm via `list_feature_flags` that only the core five are On.

4. **`deploy-prod.sh` is bare** (installs backend wasm + prints flags only). → Decide the prod flag config + run a flag-setting step as part of the deploy; verify ledger wiring and the `primary_neuron_id` / admin set are correct on prod.

---

## 🟡 Strong recommendations (not hard blockers)

- **Run the PocketIC integration suite** (`src/backend/tests/integration.rs`) before prod — unit tests don't cover cross-canister flows.
- **Confirm core economic values for production:** Neuron Syndicate fee = 10 ICP, Perm = 40 tickets/ICP/day, lottery min pot 25 ICP / 1-in-13 odds, pool reward 25% / top 100. These were tuned for local; lock them in deliberately.
- **PB-148 (CMC cycle top-up):** fixed in code per project notes but verify on prod — the treasury→cycles auto top-up keeps the canister alive; a silent failure here is an outage risk over time.
- **Landing flag-awareness:** if you expect to toggle core features post-launch, make the landing sections honor flags so it never advertises a disabled feature.

---

## Go / No-Go

- **Local demo to prospective users today:** ✅ GO. Core is feature-complete, tests green, no leaks of excluded features (after flipping arcade flags off locally too — they're currently On from `deploy-local.sh`).
- **Public production launch today:** 🟥 NO-GO as-is. Clear blockers 1–4 first. Realistic path: commit + PR today → tested upgrade on staging → flip flags → production deploy. None are large, but skipping #2 risks bricking the live canister.

*Prepared by an automated core-readiness audit. Excludes Arcade (Mini Golf/Course NFTs, Field Goal), Crash/Casino, and Cycles Faucet per request.*
