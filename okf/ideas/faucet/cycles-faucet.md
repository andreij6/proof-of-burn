---
type: idea
title: "Cycles Faucet — Vision (PB-400, draft)"
tags: [ideas, faucet]
timestamp: 2026-06-14T06:50:51-04:00
---

# Cycles Faucet — Vision (PB-400, draft)

> A production feature that recycles a slice of the protocol treasury back into
> the IC builder community: eligible, engaged participants can top up a canister
> they're building with a small weekly cycles grant, paid for by burning
> treasury ICP into cycles via the CMC. Skin-in-the-game gates (a pool neuron +
> a recent burn-vote) keep it sybil-resistant; a hard treasury floor keeps it
> from ever threatening protocol solvency.

Status: **idea / vision**. Not scheduled, not built, not flagged on. This doc
captures the why, the loop, the eligibility model, the parameters, and the
mechanism — grounded in the canister's existing CMC/treasury/pool/voting
machinery — so a future build spec can be written against it.

---

## 1. Why

Caldera already converts ICP into cycles every time a burn-vote settles: 25% of
each commitment is minted into backend cycles and 25% into frontend cycles via
the Cycles Minting Canister (CMC). The treasury (the other 50% of every burn,
plus mint fees) accumulates ICP. **We already own, operate, and have hardened
the exact ICP→cycles→canister pipeline a faucet needs** (`settle_burn_split`,
`call_cmc_topup_transfer`, `notify_cmc_topup`; see [§5](#5-mechanism)).

A cycles faucet turns that capability outward. The single biggest "cold start"
papercut for a new IC developer is keeping a canister topped up while they
learn — cycles run out, the canister freezes, the demo dies. A small, recurring,
no-strings top-up removes that papercut for people who are *already* part of
this protocol's community. It is:

- **Ecosystem-aligned** — more canisters alive on the IC is good for everyone;
  it's the most on-mission thing a governance-burn treasury could spend on.
- **A flywheel, not a giveaway** — recipients must be staked pool members who
  burn ICP to vote. The faucet rewards the exact behaviour the protocol runs on,
  and recipients are by construction invested in the protocol's health.
- **Cheap to build** — the value-moving core is a parameterized reuse of code
  that already runs in production. The new surface is *eligibility + rate-limit +
  circuit-breaker*, all of which have close analogues in the codebase already.

Non-goal: this is **not** a general public faucet. Public, ungated cycles
faucets get drained by sybils in hours. The gates below are the feature.

---

## 2. The loop

```
developer registers a canister they're building
        │
        ▼
eligibility check  ── pool neuron?  voted (burn-commit) in last 30d?  not claimed this week?  canister under its 25-claim lifetime cap?  treasury above floor?
        │ all yes
        ▼
treasury spends $2 USD of ICP (priced via XRC oracle) → CMC mints cycles → cycles deposited into the developer's canister
        │
        ▼
claim recorded (per-dev + per-canister weekly cap; canister lifetime count++); audit-logged; public stats updated
        │
        ▼
one week later, if still eligible, under 25 lifetime, and the treasury is healthy → claim again
```

---

## 3. Eligibility (the heart of the feature)

A claim is allowed only if **all** of these hold for the calling principal at
claim time:

| # | Gate | Why | Reuses |
|---|---|---|---|
| G1 | **Registered canister.** The caller has registered a target canister id they want topped up. | The faucet needs a destination; registration also gives us a per-canister rate-limit key and an audit trail. | new `FAUCET_REGISTRATIONS` map |
| G2 | **Active pool neuron** (a "Verified Follower"). | Staking ICP into the pool is real, recoverable skin-in-the-game and the protocol's core sybil cost. One pool seat ≈ one genuine participant. | `get_my_pool_neuron()` returns `Some` |
| G3 | **Voted in the last 30 days.** Voting here is **burn-only** — a vote is a burn-commit behind an adopt/reject stance. So this means: the caller has an `Open`/`Met` commitment (or a recorded vote) with `created_at`/`cast_at` within the last 30 days. | Proves the recipient is *currently active*, not a dormant staker, and has recently burned ICP — the behaviour the protocol exists to produce. | the exact pattern in `arcade_access`: scan `COMMITMENTS` + `LOSSLESS_VOTES` against a `now − 30d` cutoff (`ARCADE_VOTE_WINDOW_NANOS`) |
| G4 | **Not claimed this week.** At most one claim per rolling 7 days, keyed per **developer principal** *and* per **registered canister**. | The headline rate limit. Two keys so a dev can't register N canisters to multiply their grant, and a shared canister can't be farmed by N devs. | per-dev + per-canister last-claim maps; `DAY_NANOS × 7` window |
| G5 | **Canister under its lifetime cap.** A given canister may claim **at most 25 times, ever** (`FAUCET_CANISTER_LIFETIME_CAP`). | The faucet bootstraps *new* builders; it is not a permanent cycles subsidy. 25 weekly claims ≈ ~6 months of runway, then the canister graduates to self-funding. Also hard-bounds lifetime treasury exposure per canister (25 × $2 = **$50 max** to any one canister, ever). | new lifetime `count` on the per-canister record |
| G6 | **Treasury above the floor.** Global circuit-breaker (see [§4](#4-treasury-circuit-breaker)). | The faucet must never spend the protocol into a corner. | `get_treasury_balance()` vs a configured floor |

Gates G2 + G3 together are the sybil wall: to farm the faucet you'd need, *per
fake identity*, to stake into the pool (locking real ICP) **and** burn ICP to
vote within the trailing month — i.e. spend more than a small weekly cycles
grant is worth. The economics are upside-down for an attacker, which is the
whole point. G4 (weekly) and G5 (lifetime 25×) then bound how much any single
canister can ever extract, independent of how engaged its owner is.

### Registration must prove control (resolved — was an open question)
Earlier drafts left controllership verification optional ("cycles are a gift, so
topping up a canister you don't control isn't an attack"). **The PB-400 spec
review (C1) found the real attack, and it's a good catch:** because G4
rate-limits **per canister**, an open registration lets an attacker register a
*popular ecosystem canister* and burn its weekly slot, locking the genuine owner
out — a cheap griefing vector even though the attacker gains nothing.

So registration is **gated by proof-of-control, required, not optional**:

> Registration must be initiated by an **inter-canister call originating from the
> target canister itself** — the target calls `faucet.register_canister()`. The
> IC protocol authenticates the calling principal of every message (per the
> [interface spec](https://docs.internetcomputer.org/references/ic-interface-spec):
> a canister cannot forge being called *from* another canister's principal), so
> `msg_caller == target_canister` is cryptographic proof of control. No controller
> relationship, no management-canister read, no nonce dance.

This is strictly better than the alternatives we'd considered (a nonce handshake,
or adding the backend as a controller to read `canister_status`) — it's one
authenticated call with zero extra trust.

**Bonus: this subsumes the "does the canister exist?" check (C2).** A
non-existent or deleted canister *cannot* make an inbound call, so a successful
registration proves the target both exists and is controlled by the registrant
at registration time. The only residual case is a canister deleted *between*
registration and a later claim — handled at the value-movement layer, not here
(see [§5](#5-mechanism)).

Friction note: the dev must add a one-line outbound call to their canister to
register. That's reasonable for someone *building* a canister, and it's a far
stronger filter than an open form.

---

## 4. Treasury circuit-breaker

The faucet is a **discretionary** spend that must yield to protocol operations
(cycle self-funding, refunds, payouts). So:

- **Hard floor `FAUCET_TREASURY_FLOOR_E8S`.** If the treasury ICP balance is at
  or below the floor at claim time, the claim is rejected (`TREASURY_LOW`) and
  the faucet is effectively closed.
- **Hysteresis to avoid flapping.** Close at the floor; only *re-open* once the
  balance recovers to `floor + reopen_buffer`. Otherwise a treasury hovering at
  the line would open/close on every block.
- **Optional weekly global budget** `FAUCET_WEEKLY_BUDGET_E8S` on top of the
  floor — a cap on total faucet outflow per week, so a sudden rush can't drain
  toward the floor in one day. Belt and braces.
- **Owner kill switch.** The whole feature sits behind a `cycles_faucet`
  feature flag (ships dark, default OFF, like every other feature here), so an
  admin can hard-stop it instantly regardless of balances.

**Reading the balance (review C3).** The review notes that calling
`get_treasury_balance()` on every claim is an async ledger round-trip (~1 extra
consensus round + cycles). Fair, though marginal — a claim already makes 2+
inter-canister calls (CMC transfer + notify), so one balance read isn't the
dominant cost. Still, the idiomatic optimization here is a **timer-refreshed
cached balance**, exactly like the ICP USD-rate cache this canister already warms
on a timer in `post_upgrade`. **Correctness caveat the review missed: a safety
circuit-breaker must fail *closed* on stale data.** So the cache is only safe if
either (a) we also maintain a *conservative local tally* — debit every faucet
grant the moment we make it, so the cache can never read high between refreshes —
or (b) refreshes are frequent and we treat a stale/over-budget read as "closed."
Caching a number that can drift *upward* (e.g. ignoring external inflows is fine;
ignoring our own outflows is not) would let claims through below the floor. Net
recommendation: timer-refreshed authoritative balance **minus** a live
local-grant tally since last refresh.

All thresholds live in `CONFIG` (admin-settable), never hardcoded in prose or
logic — same discipline as `pool_initiation_fee_e8s` / `min_stake_e8s`.

---

## 5. Mechanism (grounded in existing code)

The faucet does **not** introduce a new value-movement primitive. A claim is a
narrower cousin of `settle_burn_split`:

1. **Price the grant at a fixed $2 USD.** `grant_usd_e8s = 200_000_000`
   (= $2.00 in USD e8s, the same unit as `ARCADE_CUSTOMIZE_FEE_USD_E8S` where
   $1 = 100_000_000). Convert to ICP at claim time via the XRC USD oracle —
   the *exact* path the Explorer's $1/day listings and the arcade's $1
   customization already use (`explorer_usd_rate_e8s` → ICP e8s). The treasury
   fronts the 10,000 e8s ledger fee + CMC, exactly as `settle_burn_split` does
   on every burn.
2. `call_cmc_topup_transfer(grant_e8s, developer_canister)` — moves ICP from the
   treasury subaccount to the CMC's subaccount **for the developer's canister**.
   This function is *already* parameterized by `target_canister`; the faucet just
   passes the registered id instead of our own.
3. `notify_cmc_topup(cmc, developer_canister, block_index, …)` — the CMC mints
   cycles straight into the developer's canister. Idempotent on `block_index`
   (the CMC memoizes per block), so a retry never double-mints.
4. Record the claim — stamp the per-dev + per-canister last-claim times **and
   increment the canister's lifetime `count`** (G4/G5) — append an
   `AuditLogEntry` (`event_type: "cycles_faucet_grant"`), bump public stats.

Because legs 2–3 are async inter-canister calls that can partially fail, the
claim is a **small saga with idempotent retry**, identical in shape to the burn
settlement we already run:
- Reserve the weekly slot *before* moving funds (so a retry can't double-grant),
  but only finalize the slot once `notify_top_up` confirms.
- On a stuck claim, a sweep re-drives it from the recorded `block_index` — the
  same recovery pattern that auto-heals stuck commitment 142135.

### Failed top-up is *refunded*, not "stuck forever" (correcting review C2)
The spec review (C2) claimed that if `notify_top_up` fails because the target
canister doesn't exist, the ICP is "trapped in the CMC forever." **That's not how
the CMC behaves**, and the correction matters for the design:

- `notify_top_up` is **idempotent on the ledger `block_index`** — a transient
  failure is just retried against the same block; nothing is lost (confirmed on
  the [dev forum](https://forum.dfinity.org/t/lost-icp-trying-to-top-up-canister/5204)
  and matching how `notify_cmc_topup` already memoizes per block here).
- When the CMC genuinely *can't* mint (canister gone, minting limit hit), it
  returns **`NotifyError::Refunded { block_index, reason }`** and mints the ICP
  back to the **sender** — i.e. back to the backend (you can see real
  `"Refunded at block height N"` results in the wild). The ICP returns to the
  backend's account; our saga then **reconciles it back to the treasury
  subaccount** (the same treasury-cover/reconcile plumbing the burn flow already
  uses). Net: a wasted ~10,000 e8s ledger fee, not a lost grant.

So the robust handling of "developer's canister was deleted after registration"
is **attempt → handle `Refunded` → reconcile**, *not* a pre-flight existence
ping. A pre-flight ping (the review's suggested `RejectCode::DestinationInvalid`,
code 3, check) is both racy — TOCTOU between the ping and the transfer — and an
extra consensus round-trip, and the proof-of-control registration
([§3](#3-eligibility-the-heart-of-the-feature)) already guarantees existence at
registration. We rely on the CMC's refund path for the delete-after-registration
edge instead. (We *can* still cheaply reject obviously-bad input — e.g. a
non-canister / non-opaque principal — at registration, with no network call.)

> **Known caveat — PB-148.** Locally, the test ledger records the wrong block
> type for CMC `notify_top_up`, so end-to-end faucet claims may not complete on
> the local replica even when the code is correct. This is a known local-only
> issue; don't "fix" the faucet code to work around it. It does not affect
> mainnet.

### Denomination: $2 USD per request (updated — supersedes the earlier ICP-fixed note)
An earlier draft argued for a *fixed ICP* grant (treasury cost is then exactly
predictable; cycles delivered float with the CMC's XDR rate). The product
decision is instead a **fixed $2 USD** grant, and that's the better call for a
*builder-facing* number: "$2 of compute" means the same real-world amount of help
whether ICP is $4 or $40, which is what a developer actually cares about. The
honest trade-off: the **treasury's ICP outflow per claim now floats** with the
ICP/USD price (a $2 claim costs more ICP when ICP is cheap). That's acceptable
and bounded here because (a) the grant is tiny and hard-capped per canister
(25 × $2 = $50 lifetime), and (b) the circuit-breaker floor is still an ICP
number — we convert $2→ICP at claim time and require `treasury ≥ floor + that
ICP` before spending, so a price spike just closes the faucet sooner, never
overspends.

Two rate layers to keep straight (don't conflate them):
- **$2 USD → ICP** uses our **XRC USD oracle** (the Explorer/arcade $1 path).
- **ICP → cycles** is then done by the **CMC at its XDR rate**. Cycles are pegged
  to XDR, not USD, so the cycles delivered are "$2-of-ICP worth," ≈ $2 of compute
  modulo the USD/XDR basket drift — fine for a faucet. The UI shows the live
  estimated cycles with an "actual cycles depend on the live CMC rate" note.

---

## 6. Parameters (all admin-settable via CONFIG, illustrative)

| Parameter | Value / default | Notes |
|---|---|---|
| `faucet_grant_usd_e8s` | **200_000_000 ($2.00)** | Per claim, **fixed in USD**. Priced to ICP at claim time via the XRC oracle ($1 = 100_000_000 e8s, as `ARCADE_CUSTOMIZE_FEE_USD_E8S`). |
| `faucet_canister_lifetime_cap` | **25** | Max claims per canister, **ever**. Hard lifetime ceiling = 25 × $2 = **$50** per canister. |
| `faucet_claim_window` | 7 days | Rolling weekly cap, per-developer **and** per-canister. |
| `faucet_vote_window` | 30 days | Reuse `ARCADE_VOTE_WINDOW_NANOS`'s 30-day semantics. |
| `faucet_treasury_floor_e8s` | TBD by ops | Below this → closed. The "X" in the ask. |
| `faucet_reopen_buffer_e8s` | TBD | Hysteresis above the floor. |
| `faucet_weekly_budget_e8s` | optional | Global per-week outflow cap. |
| `cycles_faucet` flag | OFF | Ships dark; owner flips it on. |

The **$2 grant** and the **25-claim lifetime cap** are fixed product decisions.
The rest (treasury floor, reopen buffer, weekly budget) are ops/business calls
left for the build spec — the floor especially (how much runway the protocol
insists on keeping for its own cycle self-funding). All still live in `CONFIG`,
admin-settable, so the $2 and the 25 can be tuned without a code change if ever
needed.

---

## 7. Abuse surface & answers

| Vector | Mitigation |
|---|---|
| Sybil farming (many fake identities) | G2 (stake a pool neuron) + G3 (burn-vote in 30d) make each identity cost more than a grant is worth. |
| One dev, many canisters | G4 keyed per **developer principal** as well as per canister. |
| Many devs, one canister | G4 keyed per **canister**; plus G5 caps that canister at **25 claims ever** regardless of how many devs cycle through it. |
| Indefinite subsidy of one canister | G5 lifetime cap: 25 × $2 = **$50 max** to any canister, ever — the faucet bootstraps, it doesn't sponsor forever. |
| Drain the treasury | G6 hard floor + hysteresis + optional weekly global budget + owner kill switch; every grant is a bounded $2. |
| Register/lock out a canister you don't control | Blocked: proof-of-control registration (the target must call `register_canister` itself) — see [§3](#registration-must-prove-control-resolved--was-an-open-question). |
| Claim spam / reentrancy mid-`await` | `CallerGuard` lock + reserve-slot-before-spend, same as existing escrow flows. |
| Stuck claim after partial failure | Idempotent saga keyed on `block_index` + sweep recovery (PB-148 post-mortem pattern). |

---

## 8. Transparency

A faucet spending community treasury must be legible:
- **Public query** (`get_faucet_stats`): open/closed state and *why* (floor hit /
  flag off / budget exhausted), total cycles granted all-time, claims this week,
  current treasury balance vs floor (runway), and the caller's own
  next-eligible-at timestamp, which gate they're failing, and **claims remaining
  (of 25)** for their registered canister.
- **Audit log**: every grant as a `cycles_faucet_grant` entry (developer,
  canister, amount, block index) — same trail as every other money move.
- **Agent-facing skill file** (`llms-faucet-*.txt`) so a developer's agent can
  check eligibility and claim from the CLI, consistent with the repo's
  agent-first convention.

---

## 9. Implementation notes (for a future build spec)

- **New stable structures (MemoryIds — pinned).** Allocated in the canonical
  cross-feature registry (`/ideas/course-nft/tasks/00-overview-and-architecture.md
  §5`): the faucet owns **`90–93`** (course-nft = 76–89, AI reviewer = 94–95), so
  there is no collision. Structures:
  - **90** `FAUCET_REGISTRATIONS: Principal(canister) → Registration` (registrant,
    registered_at) — written by the proof-of-control `register_canister` call.
  - **91** `FAUCET_DEV_LAST_CLAIM: Principal(developer) → u64(ns)` (weekly cap G4)
    and **92** `FAUCET_CANISTER_USAGE: Principal(canister) → CanisterUsage {
    last_claim_ns: u64, count: u32 }` — **two flat maps, adopting review C4.** The
    weekly caps need only the *last* claim time (O(1) `now − last ≥ 7d`); the
    per-canister map also carries the **lifetime `count` for the 25× cap (G5)** —
    `count < 25` is another O(1) check, incremented on each grant. (An earlier
    draft proposed a single composite-keyed `FAUCET_CLAIMS`; two flat maps are
    simpler and express the independent caps directly — claim *history* lives in
    the audit log, not here.)
  - **93** a counters/stats cell (all-time cycles granted, claims this week, last
    balance refresh).
- **New endpoints (sketch):** `register_canister()` (update, **caller must be the
  target canister** — proof of control), `claim_cycles()` (update, the saga),
  `get_faucet_stats()` (query), `get_my_faucet_status()` (query), plus admin
  setters for the CONFIG params and the `cycles_faucet` flag. Mirror in
  `backend.did` (hand-maintained).
- **Structured status (review optimization).** `get_my_faucet_status` returns a
  typed reason, not a bool — e.g. `enum FaucetGate { Eligible, NoPoolNeuron,
  NotVotedIn30d, ClaimedThisWeek{next_at}, CanisterLifetimeReached{count},
  CanisterNotRegistered, TreasuryLow, FaucetDisabled }` — so a developer's
  CLI/agent can render exactly which gate is blocking them and when they're next
  eligible.
- **Reuse, don't reinvent:** `call_cmc_topup_transfer` / `notify_cmc_topup`
  (cycles), `get_my_pool_neuron` (G2), the `arcade_access` 30-day scan (G3),
  the XRC USD oracle / `explorer_usd_rate_e8s` ($2 pricing),
  `get_treasury_balance` (G6), the feature-flag + CONFIG-setter scaffolding.
- **Mainnet-only behaviour.** This is a production feature by definition; it
  cannot be meaningfully exercised on the local replica (PB-148). Follow the
  repo's hard rule: **never deploy to mainnet unless explicitly asked** — this
  doc is design only.

---

## 10. Phasing

1. **Phase 1 — core faucet.** Registration, the four eligibility gates, the
   treasury floor + flag, the claim saga, stats query, audit logging. Ships dark.
2. **Phase 2 — safety/ops polish.** Weekly global budget, hysteresis, the
   `llms-faucet-*.txt` agent skill, a small dashboard card (runway + your
   eligibility).
3. **Phase 3 (maybe) — proof-of-control** handshake, and/or tiered grants (e.g.
   longer-tenured pool neurons get a slightly larger or more frequent grant),
   only if demand and abuse data justify the added surface.

---

## 11. Open questions to settle before a build spec

- The treasury floor `X` and the per-claim grant size — pure ops/business call.
- Does "voted in the last 30 days" mean *any* commitment in that window, or only
  *settled* ones? (Recommend: any `Open`/`Met` commitment created in-window, to
  match `arcade_access`.)
- Should grants scale with pool tenure/stake, or stay flat for simplicity?
  (Recommend flat for v1; tiered is a Phase 3 idea.)
- Where exactly does a CMC `Refunded` leg land, and what's the cleanest
  reconcile-to-treasury step? (Confirm against the live CMC `NotifyError`
  shape during the build, reusing the burn-flow reconcile path.)

*Resolved by the PB-400 review (see §12):* controllership verification (now
**required** via proof-of-control), per-dev **and** per-canister caps (keep
both), and the "stuck ICP" concern (CMC refunds; no pre-flight ping).

---

## 12. PB-400 spec-review responses (`cycles-faucet-specs-review.md`)

Each correctness critique, cross-referenced against
[docs.internetcomputer.org](https://docs.internetcomputer.org/) and the CMC's
actual behaviour:

| # | Critique | Verdict | What changed |
|---|---|---|---|
| **C1** | Open registration + per-canister cap → griefer locks out real owners | **Accepted — good catch.** Caller principals are protocol-authenticated (interface spec), so an inbound call *from* the target is sound proof of control. | §3: proof-of-control registration is now **required**, via the target calling `register_canister()`. |
| **C2** | Failed `notify_top_up` traps ICP in the CMC "forever" | **Partially accepted — premise corrected.** The CMC **refunds** (`NotifyError::Refunded`, real "Refunded at block height N" results) and notify is idempotent per block, so funds aren't lost. The defensive instinct is kept, but as *handle-refund-and-reconcile*, not a racy pre-flight ping. Also: proof-of-control already proves existence at registration. | §5: added the refund/reconcile path; rejected the pre-flight `DestinationInvalid` ping as TOCTOU + extra round-trip. |
| **C3** | Async treasury-balance read per claim adds latency/cost | **Accepted with a caveat the review missed.** Cache via timer (like the existing USD-rate cache) — **but** a safety breaker must fail *closed*, so cache = authoritative refresh **minus a live local-grant tally**, never a number that can drift high. | §4: cached-balance approach + fail-closed rule. |
| **C4** | Composite-key weekly-cap map is complex/slow | **Accepted.** Two flat `Principal → u64(last_claim_ns)` maps, O(1) `now − last ≥ 7d`. (Reason refined: composite *point* lookups aren't actually slow — we just don't need history, only the last timestamp.) | §9: `FAUCET_DEV_LAST_CLAIM` + `FAUCET_CANISTER_USAGE` (last-claim + lifetime count). |
| Opt. | Tiered grants by tenure/stake | **Deferred** to Phase 3 ([§10](#10-phasing)). | — |
| Opt. | Structured `get_my_faucet_status` reason enum | **Accepted.** | §9: typed `FaucetGate` reason. |

Grades from the review (Completeness 9.0 / Correctness 7.5 / Creativity 9.5,
overall **B+**) predate these revisions; C1–C4 and both optimizations are now
folded in.
