# Fund-Leak / Treasury-Drain Audit — 2026-06-15

**Scope:** value-moving paths in `src/backend/src/lib.rs` — anything that could (a)
drain the treasury to ~0 or (b) make the system lose value silently (double-pay,
over-front, mis-split). Read-only review of the live mainnet code.

**TL;DR:** the one catastrophic drain (the cycle-top-up sweep) is **already
fixed**. The remaining real risk is a **trap-then-retry double-payment funded by
the treasury** in the settlement/refund sagas — low probability, but it can drain
the treasury below its floor. Core split/payout math is sound and idempotency
holds on the *common* (rejection) failure path.

---

## ✅ FIXED — cycle-top-up sweep drained the whole treasury (was CRITICAL)
`cycle_topup_check` used to transfer `balance - 10_000` (the entire treasury) to
the CMC whenever backend cycles fell below 5T, ignoring the 15-ICP floor — this
is what converted the 15 ICP. Fixed 2026-06-15: it now targets **7T**, converts
only enough ICP (priced via the CMC rate), and only the **surplus above
`TREASURY_FLOOR_E8S` (15 ICP)**. Floor test added. *(No further action.)*

---

## 🟥 F-1 (HIGH impact / LOW probability) — trap mid-saga → treasury-funded double-payment

**Where:** `settle_burn_split` (lib.rs ~2450) + its caller (~4216/4313); the
abstain **refund** path (~4273) via `refundable_with_treasury_cover` (~2400).

**Mechanism.** These sagas are idempotent against a *rejection* (a downstream
`Err` is caught, the commitment — with its per-leg block indices / status — is
persisted at the post-saga `COMMITMENTS.insert` at line 4313, and a retry skips
completed legs). **But the idempotency keys live only in the in-memory
`commitment` until that post-saga persist.** If the canister *traps* mid-saga
(panic or out-of-cycles between a successful ledger transfer and line 4313), the
stable map keeps the *pre-saga* commitment (no block index / status), so a retry
re-runs the leg.

That alone would "only" re-pay from the escrow — except the escrow is now
**empty** (the first attempt drained it), and the **treasury-cover logic then
fronts the missing funds from the treasury**:

- `refundable_with_treasury_cover` (lib.rs ~2411): `needed = deposited + fee`;
  if `balance < needed` it transfers `shortfall = needed - balance` **from the
  treasury** into the escrow, then refunds `deposited`. On a re-refund the escrow
  balance is `0`, so `shortfall = deposited + fee` → **the treasury funds the
  entire second refund.**
- `settle_burn_split` (lib.rs ~2475): same shape — `required` counts the legs
  whose block index is `None`; on a lost-progress retry an already-paid leg is
  still `None`, the escrow no longer holds it, so the treasury fronts the
  already-transferred amount and the leg is paid twice.

**Impact:** a single ill-timed trap can double-pay one commitment/refund, funded
by the treasury, and **the treasury-cover path does not honor the 15-ICP floor**,
so it can push the treasury to 0. Bounded per event to one commitment's size, but
repeatable.

**Why low probability:** the *common* failure is a ledger **rejection**, which is
handled correctly. A hard trap requires a panic (math is checked/saturating, so
rare) or out-of-cycles mid-saga (now far less likely at ~14.5T). The codebase
already recognizes this class of bug for the swap leg — line 4205-4213 journals
the swap to the stable map *before* splitting "so a trap can never re-swap" — but
the split legs and the refund don't get the same eager persistence.

**Fix (defense in depth — do both):**
1. **Cap every treasury *cover/front* to the intended fee.** The cover is only
   ever meant to pre-pay a ledger fee; it should never front principal. Change
   `refundable_with_treasury_cover` and the `settle_burn_split` shortfall to
   `cover = min(shortfall, fee)` (or reject if `shortfall > fee`). Then an
   empty-escrow retry can't drain principal from the treasury — it just fails and
   retries safely. **This is the high-value, low-risk change.**
2. **Persist idempotency keys eagerly** — write the per-leg block index / refund
   block / status to the stable `COMMITMENTS` map immediately after each transfer
   (mirroring the swap journal at 4205), not only at the post-saga insert, so a
   trap can't lose completed-leg state.
3. Consider making the treasury-cover path respect `treasury_floor_check` (with
   no override), so no automated path can cross the floor.

---

## 🟡 F-2 (MEDIUM/LOW) — lottery payout: same trap-window, but bounded to the pot

`settle_lottery_payout` (lib.rs ~8573) is idempotent via `payout_block`, but the
draw (with `payout_block`) is only persisted by the caller at ~8551 after the
`await`. A trap between the winner transfer and that persist would, on retry,
re-pay the winner from the **lottery pot** (not the treasury). Lower severity than
F-1 (no treasury exposure, and the win already restarts the round), but the same
eager-persist fix applies: set+persist `payout_block` in the stable map within the
same slice as the transfer.

---

## 🟢 Reviewed and SOUND (no action)
- **Burn split math** (`settle_burn_split`): `treasury=amount/2`, `backend=amount/4`,
  `frontend=amount − treasury − backend` (remainder) → sums to exactly `amount`,
  no rounding leak. Per-leg block-index idempotency on the rejection path. ✓
- **Yield split** (~7788): guarded by `balance < YIELD_MIN_DISTRIBUTION_E8S`
  before subtracting `2 * fee`; 50/50 via remainder. ✓
- **Reclaim/refund subtractions** (`bal - 10_000` ~2592, `balance - fee` ~10298):
  all guarded by an early `return Err` when `balance <= fee`, so no underflow
  wrap. (Note: a wrapped amount would be rejected by the ledger anyway — the
  ledger caps transfers at the real balance, so "wrap → huge transfer" is not a
  drain vector by itself.) ✓
- **Pool rewards** (`distribute_pool_rewards` / `POOL_REWARDS_PAID`): incremental,
  idempotent (paid-once-per-member), covered by tests asserting "once each". ✓
- **Overflow discipline:** burn totals use `checked_add(...).unwrap_or(...)`;
  balances use `saturating_*`. No wrapping arithmetic in the accounting paths. ✓
- **Admin outflow guards:** `admin_withdraw_treasury` / `_token` enforce the 15-ICP
  floor unless `override_floor` (the intended explicit-withdraw path);
  `admin_send_cycles_to_frontend` and all `admin_*` outflows are
  `guard = "require_admin"`. ✓ No anonymous/auth gap on value-moving methods
  (`inspect_message` blocks anonymous updates except the read-only allowlist). ✓

---

## ℹ️ Watch-list (not bugs today)
- **Treasury "fronts every fee"** is by design and bounded to ~1 ledger fee per
  transfer — but it bypasses the floor. Many tiny fronts over time are a slow
  drip, not a drain. F-1 fix (cap to fee) keeps it bounded.
- **Cycles Faucet** (`claim_faucet_cycles`, flag OFF in prod): moves treasury ICP
  → cycles grants. It has its own `faucet_treasury_floor_e8s` + caps, but
  **re-audit before enabling** — it's value-moving and currently dark.
- **Course NFT sale split** (~14942 `treasury = price − seller − royalty − …`):
  out-of-core/disabled; if the parts ever exceed `price` it wraps. Validate the
  inputs sum ≤ price before enabling the arcade/course flags in prod.

---

## Priority
1. **F-1 fix #1 — cap treasury cover to the fee.** Small, surgical, removes the
   only known path that can drain the treasury below its floor automatically.
2. F-1 fix #2 / F-2 — eager idempotency persistence in the sagas.
3. Re-audit Faucet + Course split before those flags go on in prod.

*Read-only audit; no code changed. cycle-top-up drain already fixed + shipped.*
