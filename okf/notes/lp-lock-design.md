---
type: design
title: "ICPSwap v3 LP Lock — Implementation Design"
tags: [notes]
timestamp: 2026-06-13T03:17:23-04:00
---

# ICPSwap v3 LP Lock — Implementation Design

> **Status:** Design / pre-implementation  
> **Author:** Research pass, June 2026  
> **Scope:** Lock ICPSwap v3 LP positions in the proof-of-burn canister for a pre-defined period in exchange for voting power.

---

## 0. Core Question: Does `transferPosition` Exist?

**Yes — confirmed.** ICPSwap v3 SwapPool exposes:

```candid
transferPosition : (from: principal, to: principal, positionId: nat) -> (Result)
```

Source: [`ICPSwap-Labs/icpswap-validators`](https://github.com/ICPSwap-Labs/icpswap-validators) README, which shows the exact didc encoding:

```bash
ARGS="$(didc encode --format blob "(principal \"$GOV_CID\", principal \"$TO_PRINCIPAL\", $POSITION_ID)")"
```

This function is typically called by an SNS DAO governance canister, but it can equally be called by any principal that IS the `from` (i.e., the current position owner). The proof-of-burn canister can receive a position (user calls `transferPosition(user, pb_canister, positionId)`) and later return it (pb_canister calls `transferPosition(pb_canister, user, positionId)` as an inter-canister call).

**Design choice: custody model.** The proof-of-burn canister takes physical custody of the position for the duration of the lock. This is the cleanest trustless model — no "proxy approval" scheme needed.

---

## 1. Full SwapPool Candid Interface (Relevant Subset)

From the Adding Liquidity and Getting Amounts for Liquidity docs:

```candid
type Error = variant {
    CommonError;
    InternalError : text;
    UnsupportedToken : text;
    InsufficientFunds;
};

type PoolMetadata = record {
    sqrtPriceX96 : nat;
    tick : int;
    fee : nat;
    token0 : record { address : text; standard : text };
    token1 : record { address : text; standard : text };
    liquidity : nat;
    maxLiquidityPerTick : nat;
};

type UserPosition = record {
    id : nat;
    tickLower : int;
    tickUpper : int;
    liquidity : nat;
    feeGrowthInside0LastX128 : nat;
    feeGrowthInside1LastX128 : nat;
    tokensOwed0 : nat;
    tokensOwed1 : nat;
};

type Result    = variant { ok : nat;        err : Error };
type Result_7  = variant { ok : record { balance0 : nat; balance1 : nat }; err : Error };
type Result_11 = variant { ok : vec nat;    err : Error };
type MetaResult = variant { ok : PoolMetadata; err : Error };
type PosResult  = variant { ok : UserPosition; err : Error };

service SwapPool {
    // Position ownership
    getUserPositionIdsByPrincipal : (principal) -> (Result_11) query;
    getUserPosition               : (nat)       -> (PosResult) query;
    transferPosition              : (principal, principal, nat) -> (Result);

    // Pool state
    metadata : () -> (MetaResult) query;

    // Deposit / Withdraw (not used for LP lock — just for reference)
    deposit     : (DepositArgs)  -> (Result);
    depositFrom : (DepositArgs)  -> (Result);
    withdraw    : (WithdrawArgs) -> (Result);
};
```

**SwapCalculator canister** (`phr2m-oyaaa-aaaag-qjuoq-cai`):

```candid
service SwapCalculator {
    getTokenAmountByLiquidity : (
        sqrtPriceX96 : nat,
        tickLower    : int,
        tickUpper    : int,
        liquidity    : nat
    ) -> (record { amount0 : nat; amount1 : nat }) query;
};
```

---

## 2. User Flow — End to End

### Locking an LP position for voting power

```
Step 1.  User has an LP position in an ICPSwap v3 ICP-paired pool.
         e.g. positionId=42 in the ICP/ckBTC pool.

Step 2.  User calls swap_pool.transferPosition(
             user_principal,
             pb_canister_principal,
             42
         ) directly from their wallet.
         ▸ ICPSwap SwapPool records pb_canister as the new owner of position 42.

Step 3.  User calls pb_canister.register_lp_lock(
             pool_canister = xmiu5-jqaaa-aaaag-qbz7q-cai,
             position_id   = 42,
             duration      = LpLockDuration::OneEightyDays
         ).

Step 4.  Backend performs the 4-call verification chain (see §5).
         Computes ICP-equivalent value and VP amount.

Step 5.  Backend writes an LpLockRecord, expiry = now + 180 days.

Step 6.  The user's next cast_lp_lock_vote() call counts this VP.
         UI shows "You have 10 LP-VP active, expires 2026-12-12."
```

### Unlocking after expiry

```
Step 1.  Lock expires (current_time() >= lock.expires_at).

Step 2.  User calls pb_canister.unlock_lp_position(lock_id = 7).

Step 3.  Backend verifies expiry. Calls:
             swap_pool.transferPosition(
                 pb_canister_principal,
                 user_principal,
                 42
             )
         ▸ ICPSwap returns position ownership to the user.

Step 4.  Backend marks lock.returned = true and removes the VP.
```

### Early unlock (not allowed)

The position is locked until `expires_at`. No early exit. Admin can emergency-unlock (removes the record, leaves the position in the canister's name — user must contact to recover manually, or a future admin_force_return_position call handles it).

---

## 3. New State — Rust Data Structure Sketches

### 3a. Enums

```rust
/// Pre-defined lock durations. Longer locks earn a VP bonus multiplier.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LpLockDuration {
    ThirtyDays,      // 30 days  — 1.0× multiplier
    NinetyDays,      // 90 days  — 1.5× multiplier
    OneEightyDays,   // 180 days — 2.0× multiplier
    OneYear,         // 365 days — 3.0× multiplier
}

impl LpLockDuration {
    pub fn seconds(self) -> u64 {
        match self {
            LpLockDuration::ThirtyDays    =>  30 * 24 * 3600,
            LpLockDuration::NinetyDays    =>  90 * 24 * 3600,
            LpLockDuration::OneEightyDays => 180 * 24 * 3600,
            LpLockDuration::OneYear       => 365 * 24 * 3600,
        }
    }

    /// VP bonus multiplier, stored as (numerator, denominator) for integer math.
    /// 1.0× = (1,1), 1.5× = (3,2), 2.0× = (2,1), 3.0× = (3,1).
    pub fn multiplier_frac(self) -> (u64, u64) {
        match self {
            LpLockDuration::ThirtyDays    => (1, 1),
            LpLockDuration::NinetyDays    => (3, 2),
            LpLockDuration::OneEightyDays => (2, 1),
            LpLockDuration::OneYear       => (3, 1),
        }
    }
}
```

### 3b. LpLockRecord — the core state

```rust
/// One record per locked LP position. Key = lock_id (auto-increment u64).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LpLockRecord {
    pub id: u64,
    /// Who locked the position. Only they can unlock.
    pub user: Principal,
    /// The ICPSwap SwapPool canister that holds the position.
    pub pool_canister: Principal,
    /// ICPSwap position ID (Nat, stored as a u64; positions IDs are u64 in practice).
    pub position_id: u64,
    /// Which token is "the other" token (not ICP) in the pool pair.
    pub other_token_principal: Principal,
    /// Whether other_token is token0 or token1 in the pool. Used for valuation.
    pub icp_is_token0: bool,
    pub duration: LpLockDuration,
    pub locked_at: u64,     // nanoseconds
    pub expires_at: u64,    // nanoseconds = locked_at + duration.seconds() * 1_000_000_000
    /// ICP-equivalent of the position at lock time (both sides summed, e8s).
    pub icp_equivalent_e8s: u64,
    /// VP units credited to this user from this lock.
    pub vp_granted: u64,
    /// True once transferPosition back to user succeeded. Terminal state.
    pub returned: bool,
    /// Nanosecond timestamp of successful return (None while active).
    pub returned_at: Option<u64>,
}

// LP locks use the same impl_storable! macro as everything else.
impl_storable!(LpLockRecord);
```

### 3c. Stable Storage Layout

```rust
// MemoryId 54: LP_LOCKS — StableBTreeMap<u64, LpLockRecord>
// MemoryId 55: LP_LOCK_SEQ — StableCell<u64, _>  (next lock ID, starts at 1)

thread_local! {
    static LP_LOCKS: RefCell<StableBTreeMap<u64, LpLockRecord, Memory>> =
        MEMORY_MANAGER.with(|mm| {
            RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(54))))
        });

    static LP_LOCK_SEQ: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| {
            RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(55)), 1u64))
        });
}
```

> **MemoryId rationale:** IDs 0–53 are already taken (highest observed: 53). Using 54–55 keeps a clean sequential block.

### 3d. Proposal extensions

Add two new fields to `Proposal` (default to 0 on decode — same pattern as `lossless_adopt_e8s`):

```rust
pub struct Proposal {
    // ... existing fields ...

    /// Aggregate LP-lock voting weight on each side (does not count toward
    /// the burn threshold, only the balance-of-power direction).
    #[serde(default)]
    pub lp_lock_adopt_e8s: u64,
    #[serde(default)]
    pub lp_lock_reject_e8s: u64,
}
```

---

## 4. VP Formula

### 4a. Base formula

```
lp_vp_base = icp_equivalent_e8s / 20
lp_vp      = lp_vp_base × duration_numerator / duration_denominator
```

**Rationale for the 20× divisor:**
- Burns: 1 ICP → 1 VP (capital destroyed, maximum commitment)
- NNS staking: 1 ICP → 0.1 VP (1:10 discount — capital locked but still earns, not destroyed)
- LP lock: 1 ICP → 0.05 VP (1:20 discount — capital still earns trading fees AND has impermanent loss; less skin in the game than NNS staking)

**With the duration multiplier:**

| Duration | Multiplier | 100 ICP LP → VP |
|----------|-----------|----------------|
| 30 days  | 1.0×      | 5 VP           |
| 90 days  | 1.5×      | 7.5 VP → 7 VP (integer truncation) |
| 180 days | 2.0×      | 10 VP          |
| 365 days | 3.0×      | 15 VP          |

This rewards longer commitment while keeping LP VP clearly below staking and burns.

### 4b. Implementation

```rust
fn compute_lp_vp(icp_equivalent_e8s: u64, duration: LpLockDuration) -> u64 {
    let base = icp_equivalent_e8s / 20;
    let (num, den) = duration.multiplier_frac();
    // Safe integer multiply-then-divide; saturate on overflow.
    (base as u128)
        .saturating_mul(num as u128)
        .saturating_div(den as u128) as u64
}
```

### 4c. VP composition with existing mechanisms

VP sources are additive and independent on each proposal vote. In the balance-of-power calculation (inside `proposal_sync_sweep`/`execute_vote`):

```
total_adopt = adopt_pot_e8s       // burned ICP (commits)
            + lossless_adopt_e8s  // NNS staked ICP weight
            + lp_lock_adopt_e8s   // LP locked weight
total_reject = reject_pot_e8s + lossless_reject_e8s + lp_lock_reject_e8s
```

Only `adopt_pot_e8s + reject_pot_e8s` counts toward the burn threshold. The staking and LP contributions move the needle on which side wins without inflating the burn count.

---

## 5. The 4-Call Verification Chain

This happens inside `register_lp_lock`, which is an **async update** function.

### Call 1 — Ownership verification

```rust
// Query: does the pb_canister own this position?
let owned_ids: Vec<u64> = call_swappool_get_position_ids(
    pool_canister,
    get_canister_id()  // our canister principal
).await?;

if !owned_ids.contains(&position_id) {
    return Err("POSITION_NOT_OWNED_BY_CANISTER".to_string());
}
```

This is a **query call** to `getUserPositionIdsByPrincipal(pb_canister_principal)`. The user must have already transferred the position BEFORE calling `register_lp_lock`. This is the trustless proof — if our canister isn't in the owned list, the user didn't complete Step 2.

```rust
async fn call_swappool_get_position_ids(
    pool: Principal,
    owner: Principal,
) -> Result<Vec<u64>, String> {
    #[derive(CandidType, Deserialize)]
    enum R { #[serde(rename = "ok")] Ok(Vec<candid::Nat>), #[serde(rename = "err")] Err(IcpswapError) }
    let res: Result<(R,), _> = ic_cdk::call(pool, "getUserPositionIdsByPrincipal", (owner,)).await;
    match res {
        Ok((R::Ok(ids),)) => ids.iter().map(|n| u64::try_from(n.0.clone()).map_err(|_| "ID_OVERFLOW".to_string())).collect(),
        Ok((R::Err(e),)) => Err(format!("GET_POSITION_IDS_ERR: {:?}", e)),
        Err((code, msg)) => Err(format!("GET_POSITION_IDS_REJECTED ({:?}): {}", code, msg)),
    }
}
```

### Call 2 — Position metadata (liquidity, ticks)

```rust
let position: IcpswapUserPosition = call_swappool_get_position(pool_canister, position_id).await?;
// Returns: tickLower, tickUpper, liquidity (and fee accumulators — ignored for valuation)
```

Simultaneously (or sequentially) query pool metadata:

```rust
let meta: IcpswapPoolMetadata = call_swappool_metadata(pool_canister).await?;
// Returns: sqrtPriceX96, token0 address, token1 address
```

From `meta`, determine:
- `icp_is_token0` (check if `token0.address == ICP_LEDGER_ID`)
- `other_token_principal` (the non-ICP token)

**MVP restriction:** If neither token is ICP, return `Err("NON_ICP_POOL_NOT_SUPPORTED")`. This sidesteps the need for two-hop price lookups. Only ICP-paired pools (ICP/ckBTC, ICP/ckETH, ICP/ckUSDC, etc.) are supported initially.

### Call 3 — Compute token amounts from liquidity

```rust
const SWAP_CALCULATOR: &str = "phr2m-oyaaa-aaaag-qjuoq-cai";

let amounts = call_swap_calculator_amounts(
    meta.sqrtPriceX96,
    position.tickLower,
    position.tickUpper,
    position.liquidity,
).await?;
// Returns: amount0 (e8s of token0), amount1 (e8s of token1)
```

```rust
async fn call_swap_calculator_amounts(
    sqrt_price_x96: candid::Nat,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: candid::Nat,
) -> Result<(u64, u64), String> {
    #[derive(CandidType, Deserialize)]
    struct Amounts { amount0: candid::Nat, amount1: candid::Nat }
    let calc = Principal::from_text(SWAP_CALCULATOR).unwrap();
    let res: Result<(Amounts,), _> = ic_cdk::call(
        calc,
        "getTokenAmountByLiquidity",
        (sqrt_price_x96, tick_lower, tick_upper, liquidity),
    ).await;
    match res {
        Ok((a,)) => Ok((
            u64::try_from(a.amount0.0).unwrap_or(u64::MAX),
            u64::try_from(a.amount1.0).unwrap_or(u64::MAX),
        )),
        Err((code, msg)) => Err(format!("SWAP_CALC_REJECTED ({:?}): {}", code, msg)),
    }
}
```

### Call 4 — ICP-equivalent valuation

With `icp_is_token0` from step 2, we know:
- `icp_amount = if icp_is_token0 { amounts.0 } else { amounts.1 }`
- `other_amount = if icp_is_token0 { amounts.1 } else { amounts.0 }`

To value `other_amount`, use the **existing cached USD rate infrastructure** (`cached_usd_rate_e8s(token)` + `cached_usd_rate_e8s(ICP)` → token/ICP price):

```rust
fn other_token_to_icp_e8s(
    other_token: Principal,
    other_amount: u64,
    config: &Config,
) -> u64 {
    // Identify the ExplorerToken from the principal
    let token = explorer_token_from_principal(other_token, config);
    // cached_usd_rate_e8s gives USD per whole token (e8s of USD).
    // icp_per_token = token_usd / icp_usd
    let token_usd = cached_usd_rate_e8s(token) as u128;
    let icp_usd   = cached_usd_rate_e8s(ExplorerToken::ICP) as u128;
    if icp_usd == 0 { return 0; }
    // other_amount is in token e8s; result in ICP e8s
    ((other_amount as u128) * token_usd / icp_usd) as u64
}

fn icp_equivalent_e8s(
    icp_amount: u64,
    other_token: Principal,
    other_amount: u64,
    config: &Config,
) -> u64 {
    icp_amount.saturating_add(other_token_to_icp_e8s(other_token, other_amount, config))
}
```

**Important:** The existing `cached_usd_rate_e8s` is fed by the XRC oracle on mainnet (refreshed by the sweep timer). No new oracle calls needed — we reuse what's already there.

---

## 6. New Canister Endpoints

### 6a. Update functions (user-facing)

```rust
/// Step 1 must already be done: user transferred the position to this canister.
/// Step 2: this call verifies and registers the lock.
#[ic_cdk::update]
async fn register_lp_lock(
    pool_canister: Principal,
    position_id: u64,
    duration: LpLockDuration,
) -> Result<u64, String>
```

Full happy-path pseudocode:

```rust
require_authenticated()?;
let caller = get_caller();
let _guard = CallerGuard::new(caller)?;           // re-entrancy guard (same pattern as stake)

// [1] Ownership check
let owned = call_swappool_get_position_ids(pool_canister, get_canister_id()).await?;
if !owned.contains(&position_id) {
    return Err("POSITION_NOT_OWNED_BY_CANISTER");
}

// [2] Pool metadata + position data (parallel-ish — two sequential calls)
let meta     = call_swappool_metadata(pool_canister).await?;
let position = call_swappool_get_position(pool_canister, position_id).await?;

// MVP: ICP-paired pools only
let icp_ledger = config.ledger_canister_id.to_text();
let icp_is_token0 = meta.token0.address == icp_ledger;
let icp_is_token1 = meta.token1.address == icp_ledger;
if !icp_is_token0 && !icp_is_token1 {
    return Err("NON_ICP_POOL_NOT_SUPPORTED");
}
let other_token = if icp_is_token0 { meta.token1.address } else { meta.token0.address };

// [3] Compute token amounts from liquidity
let (amt0, amt1) = call_swap_calculator_amounts(
    meta.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity
).await?;
let icp_amount   = if icp_is_token0 { amt0 } else { amt1 };
let other_amount = if icp_is_token0 { amt1 } else { amt0 };

// [4] Valuation via cached rates
let other_principal = Principal::from_text(&other_token).map_err(|_| "BAD_TOKEN_PRINCIPAL")?;
let icp_equiv = icp_equivalent_e8s(icp_amount, other_principal, other_amount, &config);
if icp_equiv < MIN_LP_LOCK_ICP_E8S {       // e.g. 1 ICP minimum
    return Err("POSITION_TOO_SMALL");
}

// VP calculation
let vp = compute_lp_vp(icp_equiv, duration);

// Write lock record
let now = current_time();
let lock_id = LP_LOCK_SEQ.with(|c| { let id = *c.borrow().get(); c.borrow_mut().set(id + 1); id });
let expires_at = now.saturating_add(duration.seconds().saturating_mul(1_000_000_000));

LP_LOCKS.with(|m| m.borrow_mut().insert(lock_id, LpLockRecord {
    id: lock_id,
    user: caller,
    pool_canister,
    position_id,
    other_token_principal: other_principal,
    icp_is_token0,
    duration,
    locked_at: now,
    expires_at,
    icp_equivalent_e8s: icp_equiv,
    vp_granted: vp,
    returned: false,
    returned_at: None,
}));

Ok(lock_id)
```

```rust
/// Return a position to the user after the lock expires.
#[ic_cdk::update]
async fn unlock_lp_position(lock_id: u64) -> Result<(), String>
```

```rust
require_authenticated()?;
let caller = get_caller();
let _guard = CallerGuard::new(caller)?;

let mut lock = LP_LOCKS.with(|m| m.borrow().get(&lock_id))
    .ok_or("LOCK_NOT_FOUND")?;
if lock.user != caller {
    return Err("NOT_YOUR_LOCK");
}
if lock.returned {
    return Err("ALREADY_RETURNED");
}
let now = current_time();
if now < lock.expires_at {
    return Err("LOCK_NOT_EXPIRED");
}

// Call transferPosition: us → user
let res: Result<(IcpswapResult,), _> = ic_cdk::call(
    lock.pool_canister,
    "transferPosition",
    (get_canister_id(), caller, candid::Nat::from(lock.position_id)),
).await;
match res {
    Ok((IcpswapResult::Ok(_),)) => {},
    Ok((IcpswapResult::Err(e),)) => return Err(format!("TRANSFER_BACK_FAILED: {:?}", e)),
    Err((code, msg)) => return Err(format!("TRANSFER_BACK_REJECTED ({:?}): {}", code, msg)),
}

lock.returned = true;
lock.returned_at = Some(now);
LP_LOCKS.with(|m| m.borrow_mut().insert(lock_id, lock));

Ok(())
```

```rust
/// Cast a lossless vote using all active LP-lock VP.
/// Mirrors cast_lossless_vote() — same mechanics, different weight source.
#[ic_cdk::update]
fn cast_lp_lock_vote(proposal_id: u64, stance: Stance) -> Result<(), String>
```

Internally this:
1. Computes `total_lp_vp = sum of vp_granted for all non-returned, non-expired locks`
2. Checks no existing LP vote on this proposal for this user (LP_LOCK_VOTES map, same as LOSSLESS_VOTES)
3. Writes a vote record and bumps `proposal.lp_lock_adopt_e8s` or `lp_lock_reject_e8s`

### 6b. Admin functions

```rust
/// Emergency: if ICPSwap upgrades and transferPosition breaks, an admin
/// can clear the lock record so the user isn't forever blocked.
/// The position stays in the canister's name — admin must separately
/// resolve it via dfx/wallet. 
#[ic_cdk::update(guard = "require_admin")]
fn admin_emergency_clear_lp_lock(lock_id: u64) -> Result<(), String>

/// Admin: force-attempt to return a stuck position to its owner.
/// Same as unlock_lp_position but skippable expiry check.
#[ic_cdk::update(guard = "require_admin")]
async fn admin_force_return_lp_position(lock_id: u64) -> Result<(), String>
```

### 6c. Query functions

```rust
/// All locks ever created by the caller (including returned ones).
#[ic_cdk::query]
fn get_my_lp_locks() -> Vec<LpLockRecord>

/// All active (non-returned) locks for a given user. None = caller.
#[ic_cdk::query]
fn get_lp_locks_for(user: Option<Principal>) -> Vec<LpLockRecord>

/// Total VP from active LP locks for the caller.
#[ic_cdk::query]
fn get_my_lp_vp() -> u64

/// Global count of active LP positions locked and total ICP-equiv held.
#[ic_cdk::query]
fn get_lp_lock_stats() -> LpLockStats

pub struct LpLockStats {
    pub active_locks: u64,
    pub total_icp_equivalent_e8s: u64,
    pub total_vp_granted: u64,
}
```

---

## 7. Lock Duration Options — Rationale

| Duration | Seconds | VP Multiplier | Rationale |
|----------|---------|---------------|-----------|
| 30 days  | 2,592,000 | 1.0× | Short-term signal — same base rate |
| 90 days  | 7,776,000 | 1.5× | Quarter-year commitment |
| 180 days | 15,552,000 | 2.0× | Aligns with NNS 6-month staking tier |
| 365 days | 31,536,000 | 3.0× | Annual commitment — 3× bonus mirrors NNS 2-year weight gain |

**No fractional durations** — same "whole-ICP / fixed-tier" design principle as the existing staking system. This prevents users gaming tiny duration differences.

---

## 8. Unlock Mechanics

### Normal unlock (post-expiry)

1. `unlock_lp_position(lock_id)` — caller must be `lock.user`
2. Expiry check: `current_time() >= lock.expires_at`
3. Inter-canister call: `transferPosition(pb_canister, user, positionId)`
4. On success: set `lock.returned = true`, `returned_at = now`

The lock record is **NOT deleted** — it remains for the audit trail, and also to preserve the invariant that `vp_granted` can be read historically.

### What happens if ICPSwap upgrades their canister?

This is the main risk. If ICPSwap changes the `transferPosition` interface or their canister is upgraded to a different version:

- The `unlock_lp_position` call will fail with a Candid decode error or rejection.
- The position is stuck in the pb_canister's name.
- The admin can call `admin_emergency_clear_lp_lock(lock_id)` to remove the record (freeing the user from perpetual lock expiry), and then separately arrange recovery via dfx with a direct canister call.

**Mitigation in UX:** Document clearly that LP locks are dependent on ICPSwap's continued API compatibility. Consider a hardcoded maximum lock horizon (e.g., the canister won't accept locks beyond 2 years from today) so there's a natural upper bound on custodial risk.

### Multiple positions

Each position gets its own `LpLockRecord`. A user can lock 5 positions in 5 different pools simultaneously. Each accrues VP independently. The total VP is the sum.

### Position value change during lock

VP is **snapshotted at lock time**. If the position gains or loses value from impermanent loss or fee accumulation during the lock, the VP doesn't change. This is the same as how staking VP works (the snapshot is the stake amount, not the current neuron value).

---

## 9. VP Integration Into Voting

### 9a. Where LP votes affect the outcome

In the balance-of-power logic (currently in `proposal_sync_sweep` and `execute_vote`):

```rust
// Before (existing):
let adopt_side = proposal.adopt_pot_e8s + proposal.lossless_adopt_e8s;
let reject_side = proposal.reject_pot_e8s + proposal.lossless_reject_e8s;

// After (with LP):
let adopt_side = proposal.adopt_pot_e8s
    + proposal.lossless_adopt_e8s
    + proposal.lp_lock_adopt_e8s;
let reject_side = proposal.reject_pot_e8s
    + proposal.lossless_reject_e8s
    + proposal.lp_lock_reject_e8s;
```

### 9b. Vote eligibility

LP lock VP is only counted if:
- `lock.returned == false` — position still in custody
- `lock.expires_at > current_time()` at vote cast time — lock hasn't expired

If a lock expires between when the user voted and when the proposal settles, the VP is **not retroactively removed** (same as the staking snapshot-at-cast-time design). The lock record shows it expired, but the vote already landed.

### 9c. LP_LOCK_VOTES storage

A new map paralleling `LOSSLESS_VOTES`:

```rust
// MemoryId 56: LP_LOCK_VOTES — StableBTreeMap<CommitmentKey, LpLockVote>
// Key reuses CommitmentKey { proposal_id, principal }.

pub struct LpLockVote {
    pub proposal_id: u64,
    pub principal: Principal,
    pub stance: Stance,
    pub weight_e8s: u64,  // snapshot of total lp_vp at cast time
    pub cast_at: u64,
}
```

One LP vote per user per proposal (enforced by map uniqueness on the key).

---

## 10. Full Memory ID Summary

| MemoryId | Name | Type |
|----------|------|------|
| 54 | LP_LOCKS | `StableBTreeMap<u64, LpLockRecord>` |
| 55 | LP_LOCK_SEQ | `StableCell<u64>` |
| 56 | LP_LOCK_VOTES | `StableBTreeMap<CommitmentKey, LpLockVote>` |

---

## 11. Configuration Extensions

Add to `Config`:

```rust
/// Minimum ICP-equivalent for an LP position to be lockable.
/// Prevents dust positions from cluttering state.
#[serde(default = "default_min_lp_lock_icp_e8s")]
pub min_lp_lock_icp_e8s: u64,    // default: 100_000_000 (1 ICP)

/// LP_VP divisor (base discount vs burns). Default: 20.
/// Admin-tunable so the governance can adjust without an upgrade.
#[serde(default = "default_lp_vp_divisor")]
pub lp_vp_divisor: u64,

/// Kill switch — same pattern as FLAG_LOSSLESS_VOTING.
/// "lp_locking" must be in FEATURE_FLAGS for register_lp_lock to proceed.
```

Admin setter:

```rust
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_lp_vp_divisor(new_divisor: u64) -> Result<(), String>
```

---

## 12. Limitations and Open Questions

**Q: What about non-ICP pools (e.g., ckBTC/ckETH)?**  
MVP: reject with `NON_ICP_POOL_NOT_SUPPORTED`. V2: two-hop valuation using XRC-cached USD rates for both tokens.

**Q: What if the user has unclaimed fees inside the locked position?**  
Fees accumulate inside the SwapPool and can only be collected by the owner (now the pb_canister). The canister currently has no logic to collect fees on behalf of users. For V1: fees are forfeited during the lock period, which is a cost of the lock and is documented. For V2: add a `collect_lp_fees(lock_id)` endpoint that calls SwapPool's `collect` method and forwards proceeds to the user.

**Q: What if the same position is transferred to the canister twice without unlocking?**  
The `getUserPositionIdsByPrincipal` check returns the live ownership list. If position_id is already registered in LP_LOCKS with `returned == false`, reject with `POSITION_ALREADY_LOCKED`. This check happens before the write.

**Q: Can a user vote on a proposal that's already settled?**  
No — `cast_lp_lock_vote` checks the same proposal status guards as `cast_lossless_vote`.

**Q: SwapCalculator canister ID hardcoded?**  
Yes (`phr2m-oyaaa-aaaag-qjuoq-cai`). Add to Config if it ever changes, following the same pattern as `frontend_canister_id`.

---

## 13. Implementation Checklist

- [ ] Add `LpLockDuration`, `LpLockRecord`, `LpLockVote` types + `impl_storable!` macros
- [ ] Add MemoryIds 54–56 to `thread_local!` block
- [ ] Extend `Proposal` with `lp_lock_adopt_e8s`, `lp_lock_reject_e8s`
- [ ] Extend `Config` with `min_lp_lock_icp_e8s`, `lp_vp_divisor`
- [ ] Add `admin_set_lp_vp_divisor` and `admin_emergency_clear_lp_lock`, `admin_force_return_lp_position`
- [ ] Implement `call_swappool_get_position_ids`, `call_swappool_metadata`, `call_swappool_get_position`, `call_swap_calculator_amounts` helper functions
- [ ] Implement `register_lp_lock` (the main 4-call update)
- [ ] Implement `unlock_lp_position`
- [ ] Implement `cast_lp_lock_vote`
- [ ] Implement `get_my_lp_locks`, `get_lp_locks_for`, `get_my_lp_vp`, `get_lp_lock_stats`
- [ ] Implement `explorer_token_from_principal` helper (maps token Principal → ExplorerToken enum)
- [ ] Update `proposal_sync_sweep` / balance-of-power to include `lp_lock_*` fields
- [ ] Add `FLAG_LP_LOCKING` feature flag gate
- [ ] Add `MIN_LP_LOCK_ICP_E8S` constant (1 ICP default)
- [ ] Unit tests: lock flow, unlock flow, early unlock rejection, non-ICP pool rejection, VP formula, position-already-locked guard
- [ ] Update `admin_trigger_sweep` to call an `lp_lock_sweep` that logs expired-but-unreturned positions

---

## 14. Sources Consulted

- [ICPSwap-Labs/icpswap-validators README](https://github.com/ICPSwap-Labs/icpswap-validators) — confirmed `transferPosition(from, to, positionId)` signature
- [ICPSwap-Labs/docs — Adding Liquidity](https://github.com/ICPSwap-Labs/docs/blob/main/02.SwapPool/Liquidity/02.Adding_Liquidity.md) — full SwapPool Candid interface excerpt
- [ICPSwap-Labs/docs — Getting Amounts For Liquidity](https://github.com/ICPSwap-Labs/docs/blob/main/02.SwapPool/Liquidity/05.Getting_Amounts_For_Liquidity.md) — SwapCalculator.getTokenAmountByLiquidity workflow
- `src/backend/src/lib.rs` — existing staking pattern (StakeTier, StakingPool, UserStake, CallerGuard, StakingLock, impl_storable!, MemoryId layout, ICPSwap swap integration)
