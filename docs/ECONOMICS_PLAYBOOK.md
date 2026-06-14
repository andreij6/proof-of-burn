# Economics Playbook — Proof of Burn

**Goal:** $60,000/year personal developer income at ~$5 ICP · Break even from day 1 · Keep users rewarded

---

## How Money Flows (Read This First)

Every settled commitment runs through `settle_burn_split` in `lib.rs`. The split is **hardcoded**:

- **50% → treasury** (`TREASURY_SUBACCOUNT`) — this is withdrawable developer income
- **25% → backend canister cycles** (via CMC)
- **25% → frontend canister cycles** (via CMC)

There is **no protocol fee** on commitments — the escrow deposit equals the commitment amount exactly, and the treasury fronts all settlement/refund ledger fees (zero-fee commits). Treasury income from voting comes entirely from the 50% burn share above.

Pool neuron registration fees (`pool_initiation_fee_e8s`) use the same 50/25/25 split.

Idea board upvotes split 75% treasury / 25% idea poster. Post fees (1 ICP) go 100% to treasury.

**Developer takes home money via `admin_withdraw_treasury(to, amount_e8s)`.** There is currently no time-lock on this function — see Risk Mitigations section.

---

## Admin Functions Quick Reference

These are the only runtime-tunable levers. Everything else requires a canister upgrade.

| Function | What it changes | Current default |
|---|---|---|
| `admin_set_default_threshold(e8s)` | ICP threshold for all open/future proposals | `200_000_000` (2 ICP) |
| `admin_set_pool_fee(e8s)` | Pool neuron initiation fee | `12_500_000_000` (125 ICP) |
| `admin_set_feature_flag(key, bool)` | Toggle any feature | See below |
| `admin_set_staking_config(min_stake, min_unstake, maturity_threshold)` | Staking floor, unstake min, maturity sweep trigger | 0.1 ICP / 1 ICP / 1.05 ICP |
| `admin_set_lottery_config(tickets_per_day)` | Base ticket grant for 6-month stakers | `5` |
| `admin_withdraw_treasury(to, amount)` | Withdraw ICP from treasury | — |
| `admin_set_min_upvote(token, min)` | Minimum upvote on idea board | 0.2 ICP / 0.00001 ckBTC / 0.00033 ckETH |

**Feature flag defaults** (from `feature_default` in `lib.rs`):

| Key | Default | Notes |
|---|---|---|
| `idea_board` | ON | Enabled at launch |
| `lossless_voting` | ON | Enabled at launch |
| `dapp_explorer` | ON | Enabled at launch |
| `lossless_lottery` | **OFF** | Ships dark, admin enables |
| `arcade` | **OFF** | Ships dark, admin enables |
| `early_adopters` | **OFF** | Ships dark, admin enables |

**NOT runtime-configurable** (requires code change + upgrade):
- Treasury/cycles split ratio (50/25/25), inside `settle_burn_split`
- Lottery minimum pot: `LOTTERY_MIN_POT_E8S` = `2_500_000_000` (25 ICP — lowered June 2026, see GROWTH_TARGETS.md)
- AI reviewer price: `ai_price_e8s` = `5_000_000` (0.05 ICP), set at `init`
- Early Adopter constants: treasury cut (150 ICP/month), close threshold (600 ICP/month), restake-below (50 ICP/month) — recalibrated June 2026, see GROWTH_TARGETS.md §3

---

## Phase 1 — Break Even From Day 1

**Objective:** Stop the bleeding. Cold-start costs are ~$44/month (~8.8 ICP/month at $5 ICP) from timer overhead even at zero users. One settled proposal at the 2 ICP threshold yields ~1 ICP to treasury. You need roughly one settled proposal every 3–4 days to cover costs.

### Day-1 Parameter Settings

Run these immediately after mainnet deploy:

```
# Raise threshold from 2 ICP to 5 ICP — still easy to meet with 3–5 users,
# but signals more conviction and doubles revenue per settled proposal.
admin_set_default_threshold(500_000_000)        # 5 ICP

# Keep pool fee at 125 ICP — already reasonable; don't change until you have
# multiple pool neuron registrations to gauge price sensitivity.
# admin_set_pool_fee(12_500_000_000)            # no change needed

# Keep these OFF — do not enable until the treasury floor bug is patched.
admin_set_feature_flag("lossless_lottery", false)
admin_set_feature_flag("early_adopters", false)
admin_set_feature_flag("arcade", false)

# Staking: lower the minimum stake so early users can participate with
# small amounts. The default 0.1 ICP is already good. Leave it.
# admin_set_staking_config(Some(10_000_000), None, None)  # no change needed
```

**Treasury floor guard (do this before ANYTHING else):**
Send at least 15 ICP directly to the treasury deposit address (get it from `get_treasury_deposit_address()`). The cycle top-up check silently skips if treasury ≤ 10 ICP (line 3694 in `lib.rs`: `Ok(b) if b > 1_000_000_000 => b`). Your canisters will run out of cycles and go dark without this buffer.

**Revenue math at 5 ICP threshold:**
- Commits are zero-fee — treasury income comes solely from the 50% burn share.
- Per settled proposal (if threshold met with ~10 ICP total committed): ~5 ICP → treasury
- Monthly break-even: 8.8 ICP ÷ 5 ICP/proposal ≈ **2 settled proposals/month** (1 every 15 days)

At 5 ICP, you're covered if even a single real NNS proposal settles twice a month. That is achievable from week 1.

### What "Settled" Means for Revenue

A proposal must:
1. Reach its `threshold_e8s` (either side's committed ICP, or combined lossless stake)
2. Have its NNS vote executed
3. Have its sweep run (`admin_trigger_sweep` or the 5-minute timer)

If proposals are sitting in "met" status without settling, call `admin_trigger_sweep()` manually. Faster settlement = faster treasury credit.

---

## Phase 2 — Path to $60,000/Year

**Target:** 12,000 ICP/year withdrawable from treasury (~1,000 ICP/month).

Since treasury gets 50% of burns, you need **2,000 ICP/month burned** through the app. With ICP price volatility, design for ICP income and let USD upside happen naturally.

### Revenue Streams and TVL Triggers

**Stream 1: Burn mechanics (primary)**

At any given threshold, revenue scales with: (proposals settled/month) × (avg total committed) × 50%.

| Proposals/day | Avg committed (ICP) | Monthly treasury revenue |
|---|---|---|
| 0.5 | 10 | 75 ICP |
| 1 | 20 | 300 ICP |
| 2 | 30 | 900 ICP |
| 3 | 50 | 2,250 ICP |

Raise `default_threshold` as your user base grows. A higher threshold filters noise, requires real conviction, and increases revenue per proposal.

| TVL (total staked, e8s locked) | Recommended threshold | Rationale |
|---|---|---|
| < 1,000 ICP | `500_000_000` (5 ICP) | Low bar to build habit |
| 1,000–5,000 ICP | `1_000_000_000` (10 ICP) | Credible conviction signal |
| 5,000–20,000 ICP | `2_000_000_000` (20 ICP) | Match NNS voter stake levels |
| > 20,000 ICP | `5_000_000_000` (50 ICP) | High-stakes governance |

**Stream 2: Pool neuron initiation fees**

Each new pool neuron registration at 125 ICP → **62.5 ICP to treasury** (50% split). Even 2–3 new pool neurons/month is 125–187 ICP to treasury. This alone covers ~15% of the annual income target.

Monitor pool neuron registrations. If you're seeing steady demand, keep the fee at 125 ICP. If registrations stall, try `admin_set_pool_fee(7_500_000_000)` (75 ICP) to test price elasticity.

**Stream 3: Early Adopter program (enable at >50 ICP TVL in EA neuron)**

When enabled, the first 150 ICP/month of yield goes to the treasury (capped — recalibrated June 2026). The monthly yield check fires every 30 days; yield below 50 ICP/month is re-staked rather than distributed; everything above the cut flows to members.

At the EA neuron's 2-year dissolve delay (NNS ~7–7.8% APY at 2-year max dissolve, up to ~8.75% APY with max age bonus on a long-held non-dissolving neuron — post-Mission 70 rates):
- To yield 500 ICP/month (minimum payout trigger): need ~69,000–81,000 ICP staked in EA program
- To yield 1,000 ICP/month (full treasury cut): need ~137,000–162,000 ICP staked

These are aspirational milestones. Begin collecting EA deposits early (1 ICP minimum), but don't expect material treasury income from this stream until year 2 or 3 at realistic user growth.

**Stream 4: Idea board**

Every upvote splits 75% to treasury. Revenue depends on idea board engagement. At $1+ upvotes (default 0.2 ICP minimum), even modest traction (100 upvotes/month at 0.5 ICP avg) = 37.5 ICP/month. Not a primary income source but friction-free if the product is sticky.

**Stream 5: AI reviewer**

At 0.05 ICP/review, this is near-pure margin while DFINITY's LLM canister remains free. 10,000 reviews/year = 500 ICP/year. Enable when it's shippable; price is set at `init` so tune it at your next upgrade if demand is inelastic.

### Phase 2 Parameter Schedule

```
# At ~1,000 ICP TVL: raise threshold for credibility
admin_set_default_threshold(1_000_000_000)      # 10 ICP

# Enable lottery once treasury > 60 ICP (covers first 50 ICP min pot + buffer)
admin_set_feature_flag("lossless_lottery", true)

# At this point tune ticket grants — 5 base tickets for 6-month stakers is fine;
# increase to 10 if you want lottery engagement to drive staking adoption.
admin_set_lottery_config(Some(10))

# Enable Early Adopters once treasury floor bug is patched and you have a
# disclosure page live on the frontend.
admin_set_feature_flag("early_adopters", true)
```

---

## User Reward Optimization

### Staking Yields

Lossless staking yield flows from the pool neuron's NNS maturity, split **50% lottery prize pot / 50% treasury**. Users receive 0% of the raw NNS yield directly — their "yield" is entirely lottery-denominated.

At 10,000 ICP TVL and the pool neuron's current ~7–8.75% APY (post-Mission 70, 2-year max dissolve): ~700–875 ICP/year maturity → ~350–437 ICP/year to lottery pot → ~2.2–2.8 ICP per draw (3 draws/week, 156/year). At this TVL draws are modest; prize per draw scales linearly with TVL — 100,000 ICP staked produces ~22–28 ICP/draw.

The pool neuron earns 7–7.8% APY at 2-year dissolve delay, rising to ~8.75% APY with max age bonus on a long-held non-dissolving neuron. After the 50/50 treasury/lottery split, users see an effective ~3.5–4.4% APY on their staked ICP via lottery winnings — the upper end requires the neuron to have accumulated a strong age bonus. In practice, lottery is zero-sum and most users win nothing in any given draw. Be transparent about this in the UI.

**To improve perceived yield:**
- Keep `maturity_threshold_e8s` at `105_000_000` (1.05 ICP) — sweeps fire frequently so the pot grows steadily
- Tune `lottery_tickets_per_day` via `admin_set_lottery_config` to reward longer-term stakers:
  - 6-month tier: base × 1 (e.g. 5 tickets/day)
  - 1-year tier: base × 2 (e.g. 10 tickets/day)
  - 2-year tier: base × 4 (e.g. 20 tickets/day)
  The tier multipliers are applied in code automatically — you only tune the base value.
- Draw 3× per week (Tue/Thu/Sun at 03:00 UTC) is already baked in. Do not change.

**Lottery min-pot guard:**
The lottery will not draw until the pot holds ≥ 25 ICP (`LOTTERY_MIN_POT_E8S` = `2_500_000_000`; lowered from 50 — see GROWTH_TARGETS.md). At 7–8.75% NNS APY (post-Mission 70), you need roughly **1,150–1,350 ICP staked** for the pot to accumulate its first 50 ICP within about a year. Target **3,000+ ICP TVL** for the pot to grow fast enough that draws feel regular and prizes are worth anticipating (~2+ ICP/draw at 3×/week pace). Communicate this clearly. Until the pot crosses 50 ICP, users accumulate tickets but no draws happen — make this visible in the UI to avoid a "lottery is broken" perception.

### Keeping Governance Participation High

The burn mechanic only generates revenue if proposals actually settle. To keep the proposal pipeline healthy:
- Target NNS proposals with real community interest (SNS, treasury, subnet updates)
- Encourage small initial commits to get proposals to "met" status quickly
- At 5 ICP threshold: one 5-ICP commit is enough to trigger settlement if the proposal deadline is set reasonably
- Use `admin_set_proposal_deadline` to extend deadlines on proposals that are close to threshold but stalling

---

## Risk Mitigations to Ship Before Launch

### 1. Treasury Floor Bug (CRITICAL — fix before launch)

**What it is:** `cycle_topup_check` in `lib.rs` line 3694 silently skips the cycle top-up if treasury balance ≤ 10 ICP:
```rust
Ok(b) if b > 1_000_000_000 => b,  // 10 ICP
_ => return,                        // ← silent skip
```
If the treasury drains to ≤ 10 ICP, canisters stop receiving cycles and go dark. No alert, no error.

**Interim fix:** Manually maintain treasury balance > 20 ICP at all times. Add a monitoring alert on `get_treasury_balance()` — trigger a PagerDuty/Discord alert if balance drops below 15 ICP.

**Code fix (required):** Change line 3694 to raise a canister_print alert and/or lower the floor trigger to 5 ICP so there's more warning runway. Consider bumping the floor check from `> 1_000_000_000` to `> 500_000_000` after a top-up and adding a log line when the silent skip path is hit.

### 2. Admin Treasury Drain — No Time-Lock (HIGH)

**What it is:** `admin_withdraw_treasury(to, amount_e8s)` transfers the full treasury to any principal with a single call. No time-lock, no maximum, no second confirmation.

**Risk:** A compromised admin key drains the treasury immediately. Users who trust the app's treasury balance are rugged without recourse.

**Mitigations to ship before significant TVL:**
- Add a second admin principal and require both to sign (multi-sig pattern via a separate approval map)
- Or add a 48-hour time-lock: record a pending withdrawal in stable storage; a second admin call after the delay executes it
- Or cap single-withdrawal maximum at 100 ICP, requiring multiple calls to drain large amounts (at least forces a longer window)

Until a code fix ships: use a hardware wallet as the admin principal. Do not use the same principal for day-to-day dApp operations.

### 3. Early Adopters Disclosure (REQUIRED before enabling)

`FLAG_EARLY_ADOPTERS` must remain OFF until you have a clearly visible disclosure on the frontend that informs users of:

- **ICP is locked in a 2-year platform-controlled neuron.** Users cannot withdraw their principal during this period; they can only unstake through normal NNS dissolve mechanics managed by the canister.
- **The treasury takes the first 1,000 ICP/month.** Any yield below this threshold is compounded back into the neuron (specifically, months below 500 ICP/month are entirely re-staked).
- **Membership may close permanently.** Once a single month's yield exceeds 2,000 ICP, new participants are permanently excluded (`membership_closed` latches true and never resets).
- **Unclaimed monthly shares are forfeited.** Each early adopter must claim their share before the next monthly settlement, or it goes to the treasury.
- **This is not a regulated investment product.** There is no guaranteed return. NNS staking yield varies with ICP governance participation rates.

These disclosures must be confirmed by the user (checkbox + signature) before their ICP is accepted. Failure to disclose is a regulatory and trust risk.

---

## Break-Even Calculator

**Fixed costs:** ~$44/month (~8.8 ICP/month at $5/ICP) from timer overhead.

**Revenue formula per settled proposal:**
```
treasury_income = total_committed_e8s × 0.50
```

The table below uses a conservative assumption of symmetric burn (total committed = threshold × 1, since one side just barely meets the threshold). Commits are zero-fee, so treasury income is exactly 50% of what burns.

| Threshold (ICP) | Committed at settlement (est.) | Treasury per proposal | Proposals/month to break even | Daily revenue at 1 proposal/day |
|---|---|---|---|---|
| 2 ICP | 2 ICP | ~1.0 ICP | ~9 | ~0.33 ICP/day |
| 5 ICP | 5 ICP | ~2.5 ICP | ~4 | ~0.83 ICP/day |
| 10 ICP | 10 ICP | ~5.0 ICP | ~2 | ~1.67 ICP/day |
| 20 ICP | 20 ICP | ~10.0 ICP | ~1 | ~3.33 ICP/day |
| 50 ICP | 50 ICP | ~25.0 ICP | <1 | ~8.33 ICP/day |

**Realistic model** (multiple users, both sides commit):

| Threshold | Avg total committed | Treasury/proposal | Proposals/day for $60k/year |
|---|---|---|---|
| 5 ICP | 15 ICP | ~7.5 ICP | ~4.4/day |
| 10 ICP | 30 ICP | ~15 ICP | ~2.2/day |
| 20 ICP | 60 ICP | ~30 ICP | ~1.1/day |
| 50 ICP | 150 ICP | ~75 ICP | ~0.44/day |

At a mature phase with 10 ICP threshold and 3× over-subscription:
- 2 proposals/day × 15 ICP to treasury = 30 ICP/day = 900 ICP/month = **$4,500/month = $54k/year** (close)
- Add pool neuron fees: 2–3 registrations/month × 62.5 ICP = +~156 ICP/month
- Combined: ~1,056 ICP/month × $5 = **$5,280/month = ~$63k/year** ✓

**Path to that number:** grow to ~60 active users who each join 1 proposal/week.

---

## Income Withdrawal Cadence

1. **Weekly:** Run `get_treasury_balance()`. If balance > 20 ICP, withdraw the surplus above 20 ICP to your personal wallet via `admin_withdraw_treasury(your_principal, balance_minus_20_icp)`.
2. **Never withdraw below 20 ICP** — the treasury floor bug means dropping near 10 ICP silently kills cycle top-ups.
3. **Monthly:** Review TVL and proposals-per-day. If proposals/day has held above the Phase 2 threshold table triggers for 4+ weeks, call `admin_set_default_threshold` with the next tier.
4. **Quarterly:** Check if lottery pot has crossed 50 ICP. If yes and lottery is off, enable it. Review whether EA neuron TVL justifies turning on `early_adopters`.

---

*Last updated: June 2026 (APY figures corrected to post-Mission 70 rates: 6-month ~2.6%, 1-year ~3.5%, 2-year ~7–7.8%, 2-year + max age ~8.75%). All line numbers and constants reference `src/backend/src/lib.rs` at the time of writing.*
