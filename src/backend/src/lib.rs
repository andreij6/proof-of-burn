use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use ic_stable_structures::{Storable, storable::Bound, memory_manager::{MemoryId, MemoryManager, VirtualMemory}, DefaultMemoryImpl, StableBTreeMap, StableCell, log::Log};
use std::cell::RefCell;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// ==========================================
// Storage Quotas & Validation Constants
// ==========================================

const MAX_COMMITMENTS_PER_USER: usize = 25;
const MAX_PROPOSALS: usize = 500;
const MIN_COMMIT_E8S: u64 = 100_000_000;        // 1 ICP
const MAX_COMMIT_E8S: u64 = 100_000_000_000_000; // 1,000,000 ICP (sanity ceiling)

/// The leader neuron this app votes with on mainnet. Hard-pinned in code so a
/// stale or mistaken `init_args` can never point production at the wrong neuron —
/// on any non-local deploy this value overrides whatever was passed to `init`.
const MAINNET_PRIMARY_NEURON_ID: u64 = 17_802_688_826_615_984_104;

/// On mainnet, force the pinned leader neuron; locally, honour the init arg so
/// dev can point at a test neuron.
fn resolve_primary_neuron_id(is_local: bool, requested: u64) -> u64 {
    if is_local { requested } else { MAINNET_PRIMARY_NEURON_ID }
}

// ==========================================
// NNS Governance & Ledger Types
// ==========================================

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NeuronId {
    pub id: u64,
}

/// NNS Governance Topic 4: Governance (verified topic ID for auto-voting).
pub const TOPIC_GOVERNANCE: i32 = 4;

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Followees {
    pub followees: Vec<NeuronId>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Neuron {
    pub id: Option<NeuronId>,
    pub controller: Option<Principal>,
    pub hot_keys: Vec<Principal>,
    pub cached_neuron_stake_e8s: u64,
    /// Unstaked maturity (e8s-equivalent) — harvested by the lossless-staking
    /// yield sweep once it crosses the disburse threshold.
    #[serde(default)]
    pub maturity_e8s_equivalent: u64,
    /// REMOVED from governance's Neuron record (2026 periodic-confirmation
    /// rework) — kept as opt for the local mock, which still sets it. Real
    /// governance reports voting power via `deciding_voting_power`. Declaring
    /// this as a required field broke EVERY get_full_neuron decode on mainnet
    /// (maturity sweep, follow verification). NOTE: candid only tolerates a
    /// missing record field when the Rust side is Option — serde(default) is
    /// not honoured by the candid deserializer. Read voting power through
    /// `neuron_voting_power()`, never these fields directly.
    pub voting_power: Option<u64>,
    pub deciding_voting_power: Option<u64>,
    pub followees: Vec<(i32, Followees)>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum GetFullNeuronResult {
    Ok(Neuron),
    Err(GovernanceError),
}

/// Voting power across governance versions: current governance reports it as
/// `deciding_voting_power` (opt); the legacy `voting_power` field only exists
/// in our local mock.
fn neuron_voting_power(neuron: &Neuron) -> u64 {
    neuron.deciding_voting_power.or(neuron.voting_power).unwrap_or(0)
}

fn neuron_has_hotkey(neuron: &Neuron, principal: Principal) -> bool {
    neuron.hot_keys.contains(&principal)
}

fn neuron_follows(neuron: &Neuron, leader_id: u64, topic: i32) -> bool {
    for &(t, ref followees) in &neuron.followees {
        if t == topic {
            return followees.followees.iter().any(|f| f.id == leader_id);
        }
    }
    false
}

#[cfg(target_arch = "wasm32")]
async fn get_full_neuron(neuron_id: u64) -> Result<Neuron, String> {
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();
    let response: Result<(GetFullNeuronResult,), _> =
        ic_cdk::call(nns_gov, "get_full_neuron", (neuron_id,)).await;

    match response {
        Ok((GetFullNeuronResult::Ok(neuron),)) => Ok(neuron),
        Ok((GetFullNeuronResult::Err(err),)) => Err(err.error_message),
        Err((code, msg)) => {
            Err(format!("Call failed (code {:?}): {}", code, msg))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_NEURON: RefCell<Option<Result<Neuron, String>>> =
        const { RefCell::new(None) };
    static TEST_MOCK_NEURON_MAP: RefCell<
        std::collections::HashMap<u64, Result<Neuron, String>>
    > = RefCell::new(std::collections::HashMap::new());
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_neuron(res: Result<Neuron, String>) {
    TEST_MOCK_NEURON.with(|cell| {
        *cell.borrow_mut() = Some(res);
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_neuron_for_id(id: u64, res: Result<Neuron, String>) {
    TEST_MOCK_NEURON_MAP.with(|cell| {
        cell.borrow_mut().insert(id, res);
    });
}

#[cfg(not(target_arch = "wasm32"))]
async fn get_full_neuron(neuron_id: u64) -> Result<Neuron, String> {
    let map_val = TEST_MOCK_NEURON_MAP.with(|cell| {
        cell.borrow().get(&neuron_id).cloned()
    });
    if let Some(res) = map_val {
        return res;
    }
    TEST_MOCK_NEURON.with(|cell| {
        if let Some(ref res) = *cell.borrow() {
            res.clone()
        } else {
            Err("Mock neuron not set".to_string())
        }
    })
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct GovernanceError {
    pub error_message: String,
    pub error_type: i32,
}

// NNS `get_neuron_info` — a public query (no hotkey needed). Subset-decoded.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct NeuronInfo {
    pub dissolve_delay_seconds: u64,
    pub stake_e8s: u64,
    pub voting_power: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum GetNeuronInfoResult {
    Ok(NeuronInfo),
    Err(GovernanceError),
}

/// Cached public stats for the community leader neuron, served to the UI.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct LeaderNeuronInfo {
    pub neuron_id: u64,
    pub voting_power: u64,         // raw NNS voting power (e8s units)
    pub dissolve_delay_seconds: u64,
    pub stake_e8s: u64,
    pub updated_at: u64,           // 0 until first successful fetch
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum PoolStatus {
    Draft,
    Active,
    Inactive,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PoolNeuron {
    pub neuron_id: u64,
    pub registered_by: Principal,
    pub voting_power: u64,
    pub status: PoolStatus,
    pub created_at: u64,
    pub activated_at: Option<u64>,
    pub treasury_block: Option<u64>,
    pub backend_cmc_block: Option<u64>,
    pub frontend_cmc_block: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct CachedPoolInfo {
    pub total_pool_voting_power: u64,
    pub active_count: u64,
    pub updated_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ActivePoolNeuron {
    pub neuron_id: u64,
    pub voting_power: u64,
    pub registered_by: Principal,
    pub rank: u32,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PoolInfo {
    pub total_pool_voting_power: u64,
    pub active_count: u64,
    pub active_neurons: Vec<ActivePoolNeuron>,
}

fn current_time() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::time()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        1_700_000_000_000_000_000
    }
}

fn recompute_pool_info() {
    let mut total_vp: u64 = 0;
    let mut active_count = 0;
    POOL_NEURONS.with(|map| {
        for entry in map.borrow().iter() {
            let n = entry.value();
            if n.status == PoolStatus::Active {
                total_vp = total_vp.saturating_add(n.voting_power);
                active_count += 1;
            }
        }
    });
    CACHED_POOL_INFO.with(|cell| {
        let mut info = cell.borrow_mut();
        info.total_pool_voting_power = total_vp;
        info.active_count = active_count;
        info.updated_at = current_time();
    });
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserNeuronState {
    pub neuron_id: u64,
    pub is_following: bool,
    pub verified_at: u64,
    pub cached_stake_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EligibilityInfo {
    pub tier: u8,
    pub authenticated: bool,
    pub following: bool,
    pub has_committed: bool,
    pub holdings_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Stance {
    Adopt,
    Reject,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum CommitmentStatus {
    Pending,
    ThresholdMet,
    Burned,
    Returned,
    FailedBurn,
    FailedRefund,
    StuckFunds,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Commitment {
    pub proposal_id: u64,
    pub principal: Principal,
    pub amount_e8s: u64,
    pub status: CommitmentStatus,
    pub created_at: u64,
    pub stance: Stance,
    pub subaccount: [u8; 32],
    pub settled_at: Option<u64>,
    /// PB-125 settlement-split block indices (idempotent retry). Each is set once
    /// its ledger transfer succeeds, so a retry skips the transfer:
    /// - `treasury_block`: 50% → treasury subaccount
    /// - `cmc_block_index`: 25% → CMC (backend cycles)
    /// - `frontend_cmc_block`: 25% → CMC (frontend cycles)
    pub cmc_block_index: Option<u64>,
    #[serde(default)]
    pub treasury_block: Option<u64>,
    #[serde(default)]
    pub frontend_cmc_block: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LedgerAccount {
    pub owner: Principal,
    pub subaccount: Option<[u8; 32]>,
}

// ==========================================
// 1. Data Models
// ==========================================

fn default_pool_initiation_fee_e8s() -> u64 {
    12_500_000_000
}

/// Minimum stake per call once the pool neuron exists (the very first stake
/// must instead clear the NNS 1 ICP minimum neuron stake).
fn default_min_stake_e8s() -> u64 {
    10_000_000 // 0.1 ICP
}

/// Minimum unstake: 1 ICP + ledger fee, so the split child neuron stays at or
/// above the NNS minimum stake after paying the split fee.
fn default_min_unstake_e8s() -> u64 {
    // Exactly 1 ICP: the split fee is fronted by the treasury (the child
    // neuron still ends up holding the full requested amount, satisfying the
    // NNS 1-ICP neuron minimum). Was 1.0001 ICP when the fee came out of the
    // user's stake.
    100_000_000
}

/// Maturity level at which the yield sweep disburses (NNS floor ≈ 1.05 ICP).
fn default_maturity_threshold_e8s() -> u64 {
    105_000_000
}

/// Lossless lottery: BASE tickets credited per login day for a 6-month
/// staker (admin-tunable). Tiers scale it by the term multiplier:
/// 6mo = 5, 1y = 10, 2y = 20.
fn default_lottery_tickets_per_day() -> u64 {
    5
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    pub primary_neuron_id: u64,
    pub admins: Vec<Principal>,
    pub default_threshold: u64,
    pub ai_price_e8s: u64,
    pub ledger_canister_id: Principal,
    /// True when the canister was initialised against a local dev network
    /// (detected from the owner's principal or ledger canister id at init).
    /// Gating the NNS mock fallback on this flag — not re-deriving environment
    /// per call — is what prevents the F-101/F-102 mainnet bypass.
    pub is_local: bool,
    /// Frontend canister id, topped up with cycles from settled proceeds (PB-125).
    /// Defaulted on decode; resolved via `frontend_canister_id()` with an is_local
    /// fallback so it works without re-init after an upgrade.
    #[serde(default)]
    pub frontend_canister_id: Option<Principal>,
    #[serde(default = "default_pool_initiation_fee_e8s")]
    pub pool_initiation_fee_e8s: u64,
    /// Local-only overrides pointing ckBTC/ckETH at locally deployed ICRC-1
    /// test ledgers (set via `admin_set_token_ledger` after deploy). On
    /// mainnet the canonical ledger canisters are hard-pinned and these are
    /// ignored — same safety posture as the pinned leader neuron.
    #[serde(default)]
    pub ckbtc_ledger_canister_id: Option<Principal>,
    #[serde(default)]
    pub cketh_ledger_canister_id: Option<Principal>,
    #[serde(default)]
    pub ckusdc_ledger_canister_id: Option<Principal>,
    #[serde(default)]
    pub ckusdt_ledger_canister_id: Option<Principal>,
    /// Admin overrides for the per-token minimum upvote (smallest units).
    /// `None` falls back to the value-aligned defaults; retune via
    /// `admin_set_min_upvote` as exchange rates drift.
    #[serde(default)]
    pub min_upvote_icp_e8s: Option<u64>,
    #[serde(default)]
    pub min_upvote_ckbtc_e8s: Option<u64>,
    #[serde(default)]
    pub min_upvote_cketh_wei: Option<u64>,
    /// ── Lossless staking (3 fixed tiers: 6mo / 1y / 2y) ──
    #[serde(default = "default_min_stake_e8s")]
    pub min_stake_e8s: u64,
    #[serde(default = "default_min_unstake_e8s")]
    pub min_unstake_e8s: u64,
    #[serde(default = "default_maturity_threshold_e8s")]
    pub maturity_threshold_e8s: u64,
    /// ── Lossless lottery ──
    #[serde(default = "default_lottery_tickets_per_day")]
    pub lottery_tickets_per_day: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub title: String,
    /// NNS proposal summary/description (distinct from the title). Defaulted on
    /// decode so older stored proposals upgrade cleanly.
    #[serde(default)]
    pub summary: String,
    pub category: String,
    pub deadline: u64, // nanoseconds since epoch
    pub nns_proposal_id: Option<u64>,
    pub status: String, // "open" | "met" | "voted" | "failed" | "settled" | "abstained"
    pub threshold_e8s: u64,
    pub total_committed_e8s: u64,
    pub adopt_pot_e8s: u64,
    pub reject_pot_e8s: u64,
    pub vote_executed_at: Option<u64>,
    pub total_burned_e8s: Option<u64>,
    /// Stance of the first commit on this proposal — the tie-breaker if the
    /// adopt/reject pots end exactly equal. Defaulted on decode for upgrades.
    #[serde(default)]
    pub first_stance: Option<Stance>,
    #[serde(default)]
    pub pool_distributed: bool,
    /// Lossless-staking vote weight on each side. Adds to the balance-of-power
    /// that decides the NNS vote direction; never counts toward the burn
    /// threshold (`total_committed_e8s`). Defaulted on decode for upgrades.
    #[serde(default)]
    pub lossless_adopt_e8s: u64,
    #[serde(default)]
    pub lossless_reject_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CommitmentKey {
    pub proposal_id: u64,
    pub principal: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct IdeaViewKey {
    pub idea_id: u64,
    pub user: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Vote {
    Yes,
    No,
    Abstain,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct VoteRecord {
    pub proposal_id: u64,
    pub vote: Vote,
    pub icp_burned_e8s: u64,
    pub decided_at: u64,
    pub nns_outcome: Option<String>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserAggregates {
    pub total_committed_escrow: u64,
    pub total_burned: u64,
    pub proposals_joined: u32,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct AuditLogEntry {
    pub timestamp: u64,
    pub event_type: String, // "burn" | "refund" | "deposit"
    pub proposal_id: u64,
    pub user: Principal,
    pub amount_e8s: u64,
}

#[derive(CandidType, Deserialize)]
pub struct InitPayload {
    pub owner: Principal,
    pub primary_neuron_id: u64,
    pub default_threshold_e8s: u64,
    pub ai_price_e8s: u64,
    /// Optional explicit ledger canister id. When absent, the ledger is derived
    /// from `is_local` (local test ledger vs. mainnet ICP ledger). Lets staging
    /// and integration tests point at a custom/locally-installed ledger.
    pub ledger_canister_id: Option<Principal>,
}

/// App-wide totals used by the global stats strip in the UI.
/// - `tvl_e8s`: sum of `total_committed_e8s` over all proposals whose status
///   is `open` or `met` (i.e. escrow currently locked).
/// - `total_burned_e8s`: cumulative ICP burned through this app, summed over
///   every `VoteRecord` (the canonical burn ledger).
/// - `votes_cast`: count of distinct NNS proposals the app has voted on,
///   derived from `VOTES.len()`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct GlobalStats {
    pub tvl_e8s: u64,
    pub total_burned_e8s: u64,
    pub pending_burn_e8s: u64,
    pub votes_cast: u64,
    pub followers_count: u64,
}

// ==========================================
// 2. Stable Storage Trait Implementations
// ==========================================

macro_rules! impl_storable {
    ($t:ty) => {
        impl Storable for $t {
            fn to_bytes(&self) -> Cow<'_, [u8]> {
                let mut buf = Vec::new();
                ciborium::into_writer(self, &mut buf).expect("failed to encode");
                Cow::Owned(buf)
            }

            fn into_bytes(self) -> Vec<u8> {
                self.to_bytes().into_owned()
            }

            fn from_bytes(bytes: Cow<[u8]>) -> Self {
                ciborium::from_reader(bytes.as_ref()).expect("failed to decode")
            }

            const BOUND: Bound = Bound::Unbounded;
        }
    };
}

impl_storable!(Config);
impl_storable!(Proposal);
impl_storable!(Commitment);
impl_storable!(CommitmentKey);
impl_storable!(IdeaViewKey);
impl_storable!(VoteRecord);
impl_storable!(UserAggregates);
impl_storable!(AuditLogEntry);
impl_storable!(UserNeuronState);
impl_storable!(PoolNeuron);

// ==========================================
// 3. Persistent Memory Layout
// ==========================================

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static CONFIG: RefCell<StableCell<Config, Memory>> = MEMORY_MANAGER.with(|mm| {
        let default_config = Config {
            primary_neuron_id: 4821667,
            admins: vec![],
            default_threshold: 200_000_000, // 2 ICP (overwritten by init from init_args)
            ai_price_e8s: 5_000_000,
            ledger_canister_id: Principal::anonymous(),
            is_local: false,
            frontend_canister_id: None,
            pool_initiation_fee_e8s: 12_500_000_000, // 125 ICP
            ckbtc_ledger_canister_id: None,
            cketh_ledger_canister_id: None,
            ckusdc_ledger_canister_id: None,
            ckusdt_ledger_canister_id: None,
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
            min_stake_e8s: default_min_stake_e8s(),
            min_unstake_e8s: default_min_unstake_e8s(),
            maturity_threshold_e8s: default_maturity_threshold_e8s(),
            lottery_tickets_per_day: default_lottery_tickets_per_day(),
        };
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(0)), default_config))
    });

    static PROPOSALS: RefCell<StableBTreeMap<u64, Proposal, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(1))))
    });

    static COMMITMENTS: RefCell<StableBTreeMap<CommitmentKey, Commitment, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(2))))
    });

    static VOTES: RefCell<StableBTreeMap<u64, VoteRecord, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(3))))
    });

    static USER_AGGREGATES: RefCell<StableBTreeMap<Principal, UserAggregates, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(4))))
    });

    static AUDIT_LOG: RefCell<Log<AuditLogEntry, Memory, Memory>> = MEMORY_MANAGER.with(|mm| {
        let borrowed = mm.borrow();
        RefCell::new(Log::init(
            borrowed.get(MemoryId::new(5)),
            borrowed.get(MemoryId::new(6))
        ))
    });

    static USER_NEURONS: RefCell<StableBTreeMap<Principal, UserNeuronState, Memory>> =
        MEMORY_MANAGER.with(|mm| {
            RefCell::new(StableBTreeMap::init(
                mm.borrow().get(MemoryId::new(7))
            ))
        });

    static POOL_NEURONS: RefCell<StableBTreeMap<u64, PoolNeuron, Memory>> =
        MEMORY_MANAGER.with(|mm| {
            RefCell::new(StableBTreeMap::init(
                mm.borrow().get(MemoryId::new(8))
            ))
        });

    static CACHED_POOL_INFO: RefCell<CachedPoolInfo> = const {
        RefCell::new(CachedPoolInfo {
            total_pool_voting_power: 0,
            active_count: 0,
            updated_at: 0,
        })
    };

    // Transient cache of the leader neuron's public stats (refreshed on the timer).
    static LEADER_INFO: RefCell<Option<LeaderNeuronInfo>> = const { RefCell::new(None) };
}

// ==========================================
// 4. Security Guards
// ==========================================

/// Ingress-level gate: rejects anonymous callers on all update methods
/// before the call is executed. This runs before the method body so it
/// can't be bypassed by forgetting to call require_authenticated() inside.
/// Note: inspect_message only fires for direct ingress calls, not inter-canister.
#[ic_cdk::inspect_message]
fn inspect_message() {
    let caller = get_caller();
    // wallet_receive is the only update callable without authentication
    let method = ic_cdk::api::call::method_name();
    if caller == Principal::anonymous() && method != "wallet_receive" {
        ic_cdk::trap("Anonymous callers are not permitted");
    }
    ic_cdk::api::call::accept_message();
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_CALLER: RefCell<Principal> =
        RefCell::new(Principal::anonymous());
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_caller(caller: Principal) {
    TEST_MOCK_CALLER.with(|cell| {
        *cell.borrow_mut() = caller;
    });
}

fn get_caller() -> Principal {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::caller()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        TEST_MOCK_CALLER.with(|cell| *cell.borrow())
    }
}

fn get_canister_id() -> Principal {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::id()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Principal::management_canister()
    }
}

fn canister_print(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::print(msg);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        println!("{}", msg);
    }
}

fn require_authenticated() -> Result<(), String> {
    if get_caller() == Principal::anonymous() {
        return Err("Anonymous principal is not allowed".to_string());
    }
    Ok(())
}

fn require_admin() -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    CONFIG.with(|cell| {
        let borrowed = cell.borrow();
        let config = borrowed.get();
        if !config.admins.contains(&caller) {
            return Err("Caller is not an admin".to_string());
        }
        Ok(())
    })
}

// ==========================================
// 5. Init & Post Upgrade Hooks
// ==========================================

#[ic_cdk::init]
fn init(payload: InitPayload) {
    let is_local = payload.owner.to_text() == "gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe";
    let ledger_id = payload.ledger_canister_id.unwrap_or_else(|| {
        if is_local {
            Principal::from_text("a5dhi-k7777-77775-aaabq-cai").unwrap()
        } else {
            Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
        }
    });
    let config = Config {
        primary_neuron_id: resolve_primary_neuron_id(is_local, payload.primary_neuron_id),
        admins: vec![payload.owner],
        default_threshold: payload.default_threshold_e8s,
        ai_price_e8s: payload.ai_price_e8s,
        ledger_canister_id: ledger_id,
        is_local,
        frontend_canister_id: None, // resolved lazily via frontend_canister_id()
        pool_initiation_fee_e8s: 12_500_000_000, // 125 ICP
        ckbtc_ledger_canister_id: None, // local: set via admin_set_token_ledger
        cketh_ledger_canister_id: None,
        ckusdc_ledger_canister_id: None, // local: set via admin_set_explorer_ledger
        ckusdt_ledger_canister_id: None,
        min_upvote_icp_e8s: None,
        min_upvote_ckbtc_e8s: None,
        min_upvote_cketh_wei: None,
        min_stake_e8s: default_min_stake_e8s(),
        min_unstake_e8s: default_min_unstake_e8s(),
        maturity_threshold_e8s: default_maturity_threshold_e8s(),
        lottery_tickets_per_day: default_lottery_tickets_per_day(),
    };
    CONFIG.with(|cell| {
        cell.borrow_mut().set(config);
    });

    // PB-117: mock proposals are local-dev only. On mainnet the proposal list is
    // populated from live NNS data (kicked off immediately + on the sweep timer).
    if is_local {
        seed_mock_proposals();
        seed_mock_ideas();
    } else {
        ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_live_proposals());
    }
    // Real directory content (idGeek, Liquidium), not mocks — seeded on every
    // network when the Explorer is empty.
    seed_default_dapps();
    // Populate the leader-neuron stats (real on mainnet, mock on local).
    ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_leader_neuron_info());
    recompute_pool_info();
    setup_timers();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable data auto-restores. Local: top up mock seed if empty. Mainnet:
    // refresh the live proposal feed shortly after upgrade.
    let is_local = CONFIG.with(|c| c.borrow().get().is_local);
    if is_local {
        seed_mock_proposals();
        seed_mock_ideas();
    } else {
        ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_live_proposals());
    }
    seed_default_dapps();
    ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_leader_neuron_info());
    recompute_pool_info();
    setup_timers();
}

// ==========================================
// 6. Config & Admin Setters
// ==========================================

#[ic_cdk::query]
fn get_config() -> Config {
    CONFIG.with(|cell| cell.borrow().get().clone())
}

#[ic_cdk::query]
fn get_caller_principal() -> Principal {
    get_caller()
}

#[ic_cdk::query]
fn get_pool_info() -> PoolInfo {
    let totals = CACHED_POOL_INFO.with(|c| c.borrow().clone());

    let mut active_neurons = Vec::new();
    POOL_NEURONS.with(|map| {
        for entry in map.borrow().iter() {
            let n = entry.value();
            if n.status == PoolStatus::Active {
                active_neurons.push(n.clone());
            }
        }
    });

    // Sort by voting power descending
    active_neurons.sort_by(|a, b| b.voting_power.cmp(&a.voting_power));

    let mut ranked = Vec::new();
    for (i, n) in active_neurons.into_iter().enumerate() {
        ranked.push(ActivePoolNeuron {
            neuron_id: n.neuron_id,
            voting_power: n.voting_power,
            registered_by: n.registered_by,
            rank: (i + 1) as u32,
        });
    }

    PoolInfo {
        total_pool_voting_power: totals.total_pool_voting_power,
        active_count: totals.active_count,
        active_neurons: ranked,
    }
}

#[ic_cdk::query]
fn get_my_pool_neuron() -> Option<PoolNeuron> {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        return None;
    }
    POOL_NEURONS.with(|map| {
        let mut best: Option<PoolNeuron> = None;
        for entry in map.borrow().iter() {
            let n = entry.value();
            if n.registered_by == caller {
                match &best {
                    None => best = Some(n.clone()),
                    Some(b) => {
                        if n.created_at > b.created_at {
                            best = Some(n.clone());
                        }
                    }
                }
            }
        }
        best
    })
}

#[ic_cdk::update]
async fn distribute_pool_rewards(proposal_id: u64) -> Result<(), String> {
    let mut proposal = PROPOSALS.with(|map| map.borrow().get(&proposal_id))
        .ok_or_else(|| "PROPOSAL_NOT_FOUND".to_string())?;

    if proposal.status != "settled" {
        return Err("PROPOSAL_NOT_SETTLED".to_string());
    }

    if proposal.pool_distributed {
        return Ok(());
    }

    // Mark distributed first (bias against double-spend)
    proposal.pool_distributed = true;
    PROPOSALS.with(|map| {
        map.borrow_mut().insert(proposal_id, proposal.clone());
    });

    let total_burned = proposal.total_burned_e8s.unwrap_or(0);
    if total_burned == 0 {
        return Ok(());
    }
    let pool_share = total_burned / 4;

    let mut active_neurons = Vec::new();
    POOL_NEURONS.with(|map| {
        for entry in map.borrow().iter() {
            let n = entry.value();
            if n.status == PoolStatus::Active {
                active_neurons.push(n.clone());
            }
        }
    });

    if active_neurons.is_empty() {
        return Ok(());
    }

    active_neurons.sort_by(|a, b| {
        b.voting_power.cmp(&a.voting_power)
            .then_with(|| a.neuron_id.cmp(&b.neuron_id))
    });

    active_neurons.truncate(25);

    let mut recipients = Vec::new();
    for n in active_neurons {
        if !recipients.contains(&n.registered_by) {
            recipients.push(n.registered_by);
        }
    }

    let n = recipients.len() as u64;
    if n == 0 {
        return Ok(());
    }

    let share_per_recipient = pool_share / n;
    if share_per_recipient <= 10_000 {
        return Ok(());
    }
    let payout_amt = share_per_recipient - 10_000;

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let now = current_time();

    for recipient in recipients {
        let dest = LedgerAccount {
            owner: recipient,
            subaccount: None,
        };

        let xfer_res = call_ledger_transfer(
            ledger_id,
            Some(TREASURY_SUBACCOUNT),
            dest,
            payout_amt,
            Some(10_000),
        )
        .await;

        match xfer_res {
            Ok(_) => {
                let log_entry = AuditLogEntry {
                    timestamp: now,
                    event_type: "pool_reward_payout".to_string(),
                    proposal_id,
                    user: recipient,
                    amount_e8s: payout_amt,
                };
                AUDIT_LOG.with(|log| {
                    let _ = log.borrow_mut().append(&log_entry);
                });
                record_payout(recipient, PayoutType::PoolReward, IdeaToken::ICP, payout_amt, proposal_id);
            }
            Err(e) => {
                canister_print(&format!(
                    "Failed to transfer pool reward to {}: {}",
                    recipient, e
                ));
            }
        }
    }

    Ok(())
}

#[ic_cdk::update]
fn notify_top_up(args: NotifyTopUpArgs) -> NotifyTopUpResult {
    let is_local = CONFIG.with(|c| c.borrow().get().is_local);
    if !is_local {
        NotifyTopUpResult::Err(NotifyError::InvalidTransaction(
            "this canister is not the CMC".to_string(),
        ))
    } else {
        NotifyTopUpResult::Ok(candid::Nat::from(12345u64))
    }
}

#[ic_cdk::update(guard = "require_admin")]
fn add_admin(admin: Principal) -> Result<(), String> {
    if admin == Principal::anonymous() {
        return Err("Cannot add anonymous as admin".to_string());
    }
    CONFIG.with(|cell| {
        let mut config = cell.borrow().get().clone();
        if !config.admins.contains(&admin) {
            config.admins.push(admin);
            cell.borrow_mut().set(config);
        }
    });
    // Admins are excluded from the lottery — any tickets they hold die with
    // the promotion.
    void_current_round_tickets(admin);
    Ok(())
}

#[ic_cdk::update(guard = "require_admin")]
fn remove_admin(admin: Principal) -> Result<(), String> {
    CONFIG.with(|cell| {
        let mut config = cell.borrow().get().clone();
        if config.admins.len() <= 1 && config.admins.contains(&admin) {
            return Err("Cannot remove the last admin".to_string());
        }
        if let Some(pos) = config.admins.iter().position(|x| *x == admin) {
            config.admins.remove(pos);
            cell.borrow_mut().set(config);
        }
        Ok(())
    })
}

// 1-hour cutoff (in nanoseconds) — matches the deadline-floor used in commit()
const CUTOFF_NANOS: u64 = 3_600_000_000_000;

#[ic_cdk::update(guard = "require_admin")]
fn admin_set_proposal_deadline(proposal_id: u64, deadline: u64) -> Result<(), String> {
    if deadline == 0 {
        return Err("INVALID_DEADLINE".to_string());
    }
    // F-106: a deadline inside the cutoff window underflows the `deadline - cutoff`
    // subtraction in `commit` / `proposal_sync_sweep`, wrapping to a huge value
    // and permanently leaving the proposal open. Require deadline > now + cutoff.
    let now = current_time();
    let min_deadline = now.checked_add(CUTOFF_NANOS)
        .and_then(|v| v.checked_add(1))
        .ok_or_else(|| "DEADLINE_OVERFLOW".to_string())?;
    if deadline <= min_deadline {
        return Err("DEADLINE_BELOW_CUTOFF".to_string());
    }
    PROPOSALS.with(|map| {
        let mut map = map.borrow_mut();
        if let Some(mut p) = map.get(&proposal_id) {
            p.deadline = deadline;
            map.insert(proposal_id, p);
            Ok(())
        } else {
            Err("Proposal not found".to_string())
        }
    })
}

/// Admin: change the default voting threshold at any time. Updates the config
/// default (applied to all future / live-ingested proposals) AND re-applies the
/// new threshold to every currently open/met proposal, recomputing their
/// open↔met status. Terminal proposals (voted/settled/abstained/failed) are left
/// untouched so in-flight settlement is never disturbed.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_default_threshold(new_threshold_e8s: u64) -> Result<(), String> {
    if new_threshold_e8s < MIN_COMMIT_E8S {
        return Err("THRESHOLD_BELOW_MIN_COMMIT".to_string());
    }
    if new_threshold_e8s > MAX_COMMIT_E8S {
        return Err("THRESHOLD_ABOVE_MAX".to_string());
    }

    // 1. Update the config default (used for future / live proposals).
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        cfg.default_threshold = new_threshold_e8s;
        cell.borrow_mut().set(cfg);
    });

    // 2. Re-apply to all still-active proposals and recompute open/met status.
    PROPOSALS.with(|map| {
        let mut map = map.borrow_mut();
        let ids: Vec<u64> = map.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some(mut p) = map.get(&id) {
                if p.status == "open" || p.status == "met" {
                    p.threshold_e8s = new_threshold_e8s;
                    p.status = if proposal_threshold_met(&p) {
                        "met".to_string()
                    } else {
                        "open".to_string()
                    };
                    map.insert(id, p);
                }
            }
        }
    });

    Ok(())
}

/// Admin: set the frontend canister id that receives the 25% cycles share (PB-125).
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_frontend_canister(canister_id: Principal) -> Result<(), String> {
    if canister_id == Principal::anonymous() {
        return Err("INVALID_CANISTER_ID".to_string());
    }
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        cfg.frontend_canister_id = Some(canister_id);
        cell.borrow_mut().set(cfg);
    });
    Ok(())
}

/// Admin: set the initiation fee for joining the neuron pool (PB-130).
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_pool_fee(new_fee_e8s: u64) -> Result<(), String> {
    if new_fee_e8s == 0 {
        return Err("Fee cannot be zero".to_string());
    }
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        cfg.pool_initiation_fee_e8s = new_fee_e8s;
        cell.borrow_mut().set(cfg);
    });
    Ok(())
}

fn proposals_at_quota() -> bool {
    PROPOSALS.with(|map| map.borrow().len() as usize >= MAX_PROPOSALS)
}

#[ic_cdk::update(guard = "require_admin")]
async fn admin_trigger_sweep() -> Result<(), String> {
    proposal_sync_sweep().await;
    retry_failed_settlements().await;
    retry_failed_upvotes().await;
    retry_failed_fundings().await;
    delete_expired_ideas();
    delete_expired_dapps();
    cycle_topup_check().await;
    staking_sweep().await;
    early_adopter_settlement_check().await;
    Ok(())
}

// ==========================================
// 7. Proposals Queries
// ==========================================

#[ic_cdk::query]
fn list_active_proposals() -> Vec<Proposal> {
    PROPOSALS.with(|map| {
        map.borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|p| p.status == "open" || p.status == "met")
            .collect()
    })
}

#[ic_cdk::query]
fn list_all_proposals() -> Vec<Proposal> {
    PROPOSALS.with(|map| {
        map.borrow()
            .iter()
            .map(|entry| entry.value())
            .collect()
    })
}

#[ic_cdk::query]
fn get_proposal(proposal_id: u64) -> Option<Proposal> {
    PROPOSALS.with(|map| map.borrow().get(&proposal_id))
}

// ==========================================
// 8. Seeding Mock Proposals
// ==========================================

fn seed_mock_proposals() {
    if proposals_at_quota() {
        return;
    }
    PROPOSALS.with(|map| {
        let mut m = map.borrow_mut();
        if m.is_empty() {
            let now = current_time();
            
            // 14 hours in nanoseconds
            let dur_14h = 14 * 60 * 60 * 1_000_000_000;
            // 2d 14h in nanoseconds
            let dur_2d_14h = (2 * 24 + 14) * 60 * 60 * 1_000_000_000;
            // 5d 2h in nanoseconds
            let dur_5d_2h = (5 * 24 + 2) * 60 * 60 * 1_000_000_000;

            m.insert(138402, Proposal {
                id: 138402,
                title: "Reduce node-provider rewards by 12% to slow inflation".to_string(),
                summary: "Lower the monthly node-provider reward rate to curb ICP inflation while the network is over-provisioned.".to_string(),
                category: "Network economics".to_string(),
                deadline: now + dur_2d_14h,
                nns_proposal_id: Some(138402),
                status: "open".to_string(),
                threshold_e8s: 200_000_000,     // 2 ICP
                total_committed_e8s: 0,          // fresh (0%)
                adopt_pot_e8s: 0,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
                first_stance: None,
                pool_distributed: false,
                lossless_adopt_e8s: 0,
                lossless_reject_e8s: 0,
            });

            m.insert(138388, Proposal {
                id: 138388,
                title: "Adopt SNS-3 treasury allocation framework".to_string(),
                summary: "Ratify the SNS-3 framework governing how treasury funds are allocated across grants and liquidity.".to_string(),
                category: "Governance".to_string(),
                deadline: now + dur_5d_2h,
                nns_proposal_id: Some(138388),
                status: "met".to_string(),
                threshold_e8s: 200_000_000,      // 2 ICP
                total_committed_e8s: 200_000_000, // 2 ICP (met)
                adopt_pot_e8s: 200_000_000,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
                first_stance: None,
                pool_distributed: false,
                lossless_adopt_e8s: 0,
                lossless_reject_e8s: 0,
            });

            m.insert(138376, Proposal {
                id: 138376,
                title: "Onboard eu-central-2 datacenter to the subnet".to_string(),
                summary: "Add the eu-central-2 datacenter and its node operators to expand subnet geographic diversity.".to_string(),
                category: "Node provider".to_string(),
                deadline: now + dur_14h,
                nns_proposal_id: Some(138376),
                status: "open".to_string(),
                threshold_e8s: 200_000_000,    // 2 ICP
                total_committed_e8s: 80_000_000, // 0.8 ICP (~40%)
                adopt_pot_e8s: 80_000_000,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
                first_stance: None,
                pool_distributed: false,
                lossless_adopt_e8s: 0,
                lossless_reject_e8s: 0,
            });
        }
    });

    VOTES.with(|map| {
        let mut m = map.borrow_mut();
        if m.is_empty() {
            let now = current_time();
            let dur_1d = 24 * 60 * 60 * 1_000_000_000;
            m.insert(138300, VoteRecord {
                proposal_id: 138300,
                vote: Vote::Yes,
                icp_burned_e8s: 1_240_000_000,
                decided_at: now - 5 * dur_1d,
                nns_outcome: Some("adopted".to_string()),
            });
            m.insert(138250, VoteRecord {
                proposal_id: 138250,
                vote: Vote::No,
                icp_burned_e8s: 600_000_000,
                decided_at: now - 10 * dur_1d,
                nns_outcome: Some("rejected".to_string()),
            });
            m.insert(138200, VoteRecord {
                proposal_id: 138200,
                vote: Vote::Yes,
                icp_burned_e8s: 2_010_000_000,
                decided_at: now - 15 * dur_1d,
                nns_outcome: Some("adopted".to_string()),
            });
        }
    });
}

// ==========================================
// 9. Eligibility & Verification Endpoints
// ==========================================

async fn refresh_pool_neurons() {
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let mut active_neurons = Vec::new();
    POOL_NEURONS.with(|map| {
        for entry in map.borrow().iter() {
            let n = entry.value();
            if n.status == PoolStatus::Active {
                active_neurons.push(n.clone());
            }
        }
    });

    for mut neuron_state in active_neurons {
        let neuron_id = neuron_state.neuron_id;
        let skip_fetch = config.is_local && cfg!(target_arch = "wasm32");
        if skip_fetch {
            continue;
        }

        match get_full_neuron(neuron_id).await {
            Ok(neuron) => {
                let has_hotkey = neuron_has_hotkey(
                    &neuron,
                    get_canister_id(),
                );
                let follows = neuron_follows(
                    &neuron,
                    config.primary_neuron_id,
                    TOPIC_GOVERNANCE,
                );

                if !has_hotkey || !follows || neuron_voting_power(&neuron) == 0 {
                    neuron_state.status = PoolStatus::Inactive;
                    canister_print(&format!(
                        "Pool neuron {} inactivated (hotkey={}, follow={})",
                        neuron_id, has_hotkey, follows
                    ));
                } else {
                    neuron_state.voting_power = neuron_voting_power(&neuron);
                }

                POOL_NEURONS.with(|map| {
                    map.borrow_mut().insert(neuron_id, neuron_state);
                });
            }
            Err(e) => {
                canister_print(&format!(
                    "Failed to refresh pool neuron {}: {}",
                    neuron_id, e
                ));
            }
        }
    }
    recompute_pool_info();
}

/// Refresh the cached leader-neuron stats from the NNS (`get_neuron_info` is a
/// public query — no hotkey required). On local, where there is no NNS canister,
/// the call rejects and we cache a representative mock so the UI shows a value.
async fn fetch_leader_neuron_info() {
    let (leader_id, is_local) = CONFIG.with(|c| {
        let cfg = c.borrow();
        let cfg = cfg.get();
        (cfg.primary_neuron_id, cfg.is_local)
    });
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();
    let now = current_time();

    let response: Result<(GetNeuronInfoResult,), _> =
        ic_cdk::call(nns_gov, "get_neuron_info", (leader_id,)).await;

    match response {
        Ok((GetNeuronInfoResult::Ok(info),)) => {
            LEADER_INFO.with(|cell| {
                *cell.borrow_mut() = Some(LeaderNeuronInfo {
                    neuron_id: leader_id,
                    voting_power: info.voting_power,
                    dissolve_delay_seconds: info.dissolve_delay_seconds,
                    stake_e8s: info.stake_e8s,
                    updated_at: now,
                });
            });
        }
        _ if is_local => {
            // Local dev mock so the neuron block renders a value.
            LEADER_INFO.with(|cell| {
                *cell.borrow_mut() = Some(LeaderNeuronInfo {
                    neuron_id: leader_id,
                    voting_power: 1_284_500_000_000, // ~12,845 VP
                    dissolve_delay_seconds: 8 * 365 * 24 * 60 * 60, // 8y
                    stake_e8s: 1_000_000_000_000, // 10,000 ICP
                    updated_at: now,
                });
            });
        }
        Ok((GetNeuronInfoResult::Err(e),)) => {
            canister_print(&format!("get_neuron_info error: {}", e.error_message));
        }
        Err((code, msg)) => {
            canister_print(&format!("get_neuron_info call failed (code {:?}): {}", code, msg));
        }
    }
    refresh_pool_neurons().await;
}

/// Cached public stats for the community leader neuron (voting power, dissolve
/// delay, stake). `updated_at == 0` means not yet fetched.
#[ic_cdk::query]
fn get_leader_neuron_info() -> LeaderNeuronInfo {
    LEADER_INFO.with(|cell| cell.borrow().clone()).unwrap_or_else(|| {
        let leader_id = CONFIG.with(|c| c.borrow().get().primary_neuron_id);
        LeaderNeuronInfo { neuron_id: leader_id, ..Default::default() }
    })
}


/// Self-attested follow (Option C). We do NOT verify neuron ownership on-chain:
/// because Internet Identity gives this app a per-dapp principal that can't equal
/// the user's NNS principal, and the canister isn't a hotkey on arbitrary neurons,
/// trustless ownership proof isn't possible without heavy hotkey onboarding. The
/// real skin-in-the-game is the ICP burn itself, so following the leader neuron is
/// encouraged but self-attested. The user confirms in the UI; we record it here.
#[ic_cdk::update]
fn confirm_follow() -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let state = UserNeuronState {
        neuron_id: 0,
        is_following: true,
        verified_at: current_time(),
        cached_stake_e8s: 0,
    };
    USER_NEURONS.with(|map| {
        map.borrow_mut().insert(caller, state);
    });
    Ok(())
}

#[ic_cdk::query]
fn get_eligibility() -> EligibilityInfo {
    let caller = get_caller();
    let authenticated = caller != Principal::anonymous();
    
    let following = if authenticated {
        USER_NEURONS.with(|map| {
            map.borrow().get(&caller).map(|state| state.is_following).unwrap_or(false)
        })
    } else {
        false
    };
    
    let has_committed = if authenticated {
        USER_AGGREGATES.with(|map| {
            map.borrow().get(&caller).map(|agg| agg.total_committed_escrow > 0).unwrap_or(false)
        })
    } else {
        false
    };

    let tier = if !authenticated {
        0
    } else if !following {
        1
    } else if has_committed {
        3
    } else {
        2
    };

    // Option C: no neuron stake cap — commits are capped by the user's wallet
    // balance (enforced by the escrow deposit). holdings_e8s is retained in the
    // type for compatibility but is no longer a stake cap.
    let holdings_e8s = 0u64;

    EligibilityInfo {
        tier,
        authenticated,
        following,
        has_committed,
        holdings_e8s,
    }
}

// ==========================================
// 10. Vote History Endpoints
// ==========================================

// ==========================================
// 11. Escrow, Sagas, and Lifecycle Logic
// ==========================================

const TREASURY_SUBACCOUNT: [u8; 32] = [1u8; 32];

thread_local! {
    static ACTIVE_CALLERS: RefCell<std::collections::HashSet<Principal>> = RefCell::new(std::collections::HashSet::new());
    static ACTIVE_PROPOSALS: RefCell<std::collections::HashSet<u64>> = RefCell::new(std::collections::HashSet::new());
    // F-103: stores the most recent treasury→CMC topup transfer block index
    // so a retry of `cycle_topup_check` can skip the transfer and just notify
    // the CMC. Reset to None on a successful `notify_top_up`.
    static LAST_TOPUP_BLOCK: RefCell<Option<u64>> = const { RefCell::new(None) };
}

pub struct CallerGuard {
    caller: Principal,
}

impl CallerGuard {
    pub fn new(caller: Principal) -> Result<Self, String> {
        let inserted = ACTIVE_CALLERS.with(|set| set.borrow_mut().insert(caller));
        if !inserted {
            return Err("Another transaction is already in progress for this principal".to_string());
        }
        Ok(Self { caller })
    }
}

impl Drop for CallerGuard {
    fn drop(&mut self) {
        ACTIVE_CALLERS.with(|set| set.borrow_mut().remove(&self.caller));
    }
}

pub struct ProposalLock {
    proposal_id: u64,
}

impl ProposalLock {
    pub fn new(proposal_id: u64) -> Result<Self, String> {
        let inserted = ACTIVE_PROPOSALS.with(|set| set.borrow_mut().insert(proposal_id));
        if !inserted {
            return Err("Proposal processing is already in progress".to_string());
        }
        Ok(Self { proposal_id })
    }
}

impl Drop for ProposalLock {
    fn drop(&mut self) {
        ACTIVE_PROPOSALS.with(|set| set.borrow_mut().remove(&self.proposal_id));
    }
}

const REGISTRATION_SEED: u64 = 0xFFFF_FFFF_FFFF_FFFF;

fn derive_subaccount(user: &Principal, proposal_id: u64) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_escrow_v1");
    hasher.update(user.as_slice());
    hasher.update(&proposal_id.to_be_bytes());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

// CRC32 (IEEE) — used to prefix the ICP account identifier.
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// ICP account identifier (64-hex) = CRC32(h) ++ h, where
/// h = SHA224("\x0Aaccount-id" || owner || subaccount). This is the legacy
/// "address" that exchanges and the NNS dapp use for transfers — distinct from
/// the principal.
fn account_id_hex(owner: Principal, subaccount: &[u8; 32]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha224::new();
    hasher.update(b"\x0Aaccount-id");
    hasher.update(owner.as_slice());
    hasher.update(&subaccount[..]);
    let hash = hasher.finalize();
    let crc = crc32(&hash);
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(&crc.to_be_bytes());
    out.extend_from_slice(&hash);
    to_hex(&out)
}

/// The caller's deposit address: the account identifier of their default
/// (sub-account = 0) ICP account. Fund this to participate.
#[ic_cdk::query]
fn get_account_id() -> String {
    account_id_hex(get_caller(), &[0u8; 32])
}

// Ledger Call Structs
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TransferArgs {
    pub from_subaccount: Option<[u8; 32]>,
    pub to: LedgerAccount,
    pub amount: candid::Nat,
    pub fee: Option<candid::Nat>,
    pub memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
pub enum TransferError {
    BadFee { expected_fee: candid::Nat },
    BadBurn { min_burn_amount: candid::Nat },
    InsufficientFunds { balance: candid::Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: candid::Nat },
    TemporarilyUnavailable,
    GenericError { error_code: candid::Nat, message: String },
}

#[derive(CandidType, Deserialize, Debug)]
pub enum TransferResult {
    Ok(candid::Nat),
    Err(TransferError),
}

// Legacy Ledger Call Structs (required by cycles-minting canister)
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct SendArgs {
    pub memo: u64,
    pub amount: TokensAmount,
    pub fee: TokensAmount,
    pub from_subaccount: Option<[u8; 32]>,
    pub to: [u8; 32],
    pub created_at_time: Option<TimeStampNanos>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug)]
pub struct TokensAmount {
    pub e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug)]
pub struct TimeStampNanos {
    pub timestamp_nanos: u64,
}

#[derive(CandidType, Deserialize, Debug)]
pub enum SendError {
    BadFee { expected_fee: TokensAmount },
    InsufficientFunds { balance: TokensAmount },
    TxTooOld { allowed_window_nanos: u64 },
    TxCreatedInFuture,
    TxDuplicate { duplicate_of: u64 },
}

#[derive(CandidType, Deserialize, Debug)]
pub enum SendResult {
    Ok(u64),
    Err(SendError),
}

// These mirror the *real* CMC candid exactly (rs/nns/cmc/cmc.did):
//   NotifyTopUpArg    = record { block_index : nat64; canister_id : principal }
//   NotifyTopUpResult = variant { Ok : nat (Cycles); Err : NotifyError }
// The first mainnet settlement (proposal 142135) trapped inside the CMC
// because block_index was encoded as `nat` where the CMC declares `nat64`
// (candid has no nat→nat64 subtyping), and the old NotifyError carried
// variants the real CMC never returns (AlreadyNotified / TransactionNotFound
// / InvalidTokenLedger) while missing real ones (Processing /
// InvalidTransaction) — so genuine CMC errors could not even be decoded.
// Wire compatibility is locked down by test_cmc_notify_wire_compat.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct NotifyTopUpArgs {
    pub canister_id: Principal,
    pub block_index: u64,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum NotifyTopUpResult {
    Ok(candid::Nat),
    Err(NotifyError),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum NotifyError {
    Refunded {
        block_index: Option<u64>,
        reason: String,
    },
    Processing,
    TransactionTooOld(u64),
    InvalidTransaction(String),
    Other {
        error_code: u64,
        error_message: String,
    },
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum BalanceResult {
    Ok(u64),
    Err(String),
}

#[cfg(target_arch = "wasm32")]
async fn call_ledger_balance(
    ledger_id: Principal,
    account: LedgerAccount,
) -> Result<u64, String> {
    let response: Result<(candid::Nat,), _> =
        ic_cdk::call(ledger_id, "icrc1_balance_of", (account,)).await;
    match response {
        Ok((balance,)) => {
            let bal_str = balance.to_string().replace('_', "");
            let bal_u64 = bal_str
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse balance: {}", e))?;
            Ok(bal_u64)
        }
        Err((code, msg)) => {
            Err(format!("Ledger call failed (code {:?}): {}", code, msg))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_LEDGER_BALANCE: RefCell<u64> = RefCell::new(0);
    static TEST_MOCK_LEDGER_TRANSFER: RefCell<Result<u64, String>> =
        RefCell::new(Ok(1));
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_ledger_balance(bal: u64) {
    TEST_MOCK_LEDGER_BALANCE.with(|cell| {
        *cell.borrow_mut() = bal;
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_ledger_transfer(res: Result<u64, String>) {
    TEST_MOCK_LEDGER_TRANSFER.with(|cell| {
        *cell.borrow_mut() = res;
    });
}

#[cfg(not(target_arch = "wasm32"))]
async fn call_ledger_balance(
    _ledger_id: Principal,
    _account: LedgerAccount,
) -> Result<u64, String> {
    Ok(TEST_MOCK_LEDGER_BALANCE.with(|cell| *cell.borrow()))
}

#[cfg(target_arch = "wasm32")]
async fn call_ledger_transfer(
    ledger_id: Principal,
    from_sub: Option<[u8; 32]>,
    to: LedgerAccount,
    amount_e8s: u64,
    fee_e8s: Option<u64>,
) -> Result<u64, String> {
    let args = TransferArgs {
        from_subaccount: from_sub,
        to,
        amount: candid::Nat::from(amount_e8s),
        fee: fee_e8s.map(candid::Nat::from),
        memo: None,
        created_at_time: None,
    };
    let response: Result<(TransferResult,), _> =
        ic_cdk::call(ledger_id, "icrc1_transfer", (args,)).await;
    match response {
        Ok((TransferResult::Ok(block_index),)) => {
            let block_str = block_index.to_string().replace('_', "");
            let block_u64 = block_str
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse block index: {}", e))?;
            Ok(block_u64)
        }
        Ok((TransferResult::Err(err),)) => {
            Err(format!("Ledger transfer returned error: {:?}", err))
        }
        Err((code, msg)) => {
            Err(format!("Ledger transfer failed (code {:?}): {}", code, msg))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn call_ledger_transfer(
    _ledger_id: Principal,
    _from_sub: Option<[u8; 32]>,
    _to: LedgerAccount,
    _amount_e8s: u64,
    _fee_e8s: Option<u64>,
) -> Result<u64, String> {
    TEST_MOCK_LEDGER_TRANSFER.with(|cell| cell.borrow().clone())
}

fn account_id_bytes(owner: Principal, subaccount: &[u8; 32]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha224::new();
    hasher.update(b"\x0Aaccount-id");
    hasher.update(owner.as_slice());
    hasher.update(&subaccount[..]);
    let hash = hasher.finalize();
    let crc = crc32(&hash);
    let mut out = [0u8; 32];
    out[0..4].copy_from_slice(&crc.to_be_bytes());
    out[4..32].copy_from_slice(&hash);
    out
}

fn cmc_account_id(target_canister: &Principal) -> [u8; 32] {
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
    let sub = principal_to_subaccount(target_canister);
    account_id_bytes(cmc, &sub)
}

/// Legacy `transfer` (AccountIdentifier destination). The memo matters in two
/// places: CMC top-ups use 0; neuron staking must pass the claim nonce so
/// governance's ClaimOrRefresh can match the deposit.
#[cfg(target_arch = "wasm32")]
async fn call_ledger_legacy_transfer(
    ledger_id: Principal,
    from_sub: Option<[u8; 32]>,
    to_account_id: [u8; 32],
    amount_e8s: u64,
    fee_e8s: u64,
    memo: u64,
) -> Result<u64, String> {
    let args = SendArgs {
        memo,
        amount: TokensAmount { e8s: amount_e8s },
        fee: TokensAmount { e8s: fee_e8s },
        from_subaccount: from_sub,
        to: to_account_id,
        created_at_time: None,
    };
    let response: Result<(SendResult,), _> =
        ic_cdk::call(ledger_id, "transfer", (args,)).await;
    match response {
        Ok((SendResult::Ok(block_index),)) => Ok(block_index),
        Ok((SendResult::Err(err),)) => {
            Err(format!("Ledger legacy transfer returned error: {:?}", err))
        }
        Err((code, msg)) => {
            Err(format!("Ledger legacy transfer failed (code {:?}): {}", code, msg))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn call_ledger_legacy_transfer(
    _ledger_id: Principal,
    _from_sub: Option<[u8; 32]>,
    _to_account_id: [u8; 32],
    _amount_e8s: u64,
    _fee_e8s: u64,
    _memo: u64,
) -> Result<u64, String> {
    TEST_MOCK_LEDGER_TRANSFER.with(|cell| cell.borrow().clone())
}

/// The legacy-transfer memo the CMC requires before `notify_top_up` will mint
/// cycles: "TPUP" as a little-endian u64. Any other memo (the code used to
/// send 0) makes the CMC refund the transfer instead of topping up.
const MEMO_TOP_UP: u64 = 0x5055_5054;

/// Move `amount_e8s` to the CMC ahead of a `notify_top_up` for `target_canister`.
///
/// PB-148: on mainnet the ICP ledger's legacy `transfer` (AccountIdentifier
/// destination) is required so the produced block is the type CMC's
/// `notify_top_up` accepts. The local/test ledger is the ICRC-1 ledger wasm,
/// which has no legacy `transfer` method at all — there we `icrc1_transfer` to
/// the CMC's ICRC-1 subaccount instead (notify is a no-op locally, so the block
/// type is irrelevant). Without this split, finalize/settle trap locally with
/// "Canister has no update method 'transfer'".
#[cfg(target_arch = "wasm32")]
async fn call_cmc_topup_transfer(
    ledger_id: Principal,
    from_sub: Option<[u8; 32]>,
    target_canister: Principal,
    amount_e8s: u64,
    fee_e8s: u64,
) -> Result<u64, String> {
    let is_local = CONFIG.with(|c| c.borrow().get().is_local);
    if is_local {
        let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
        let dest = LedgerAccount {
            owner: cmc,
            subaccount: Some(principal_to_subaccount(&target_canister)),
        };
        call_ledger_transfer(ledger_id, from_sub, dest, amount_e8s, Some(fee_e8s)).await
    } else {
        call_ledger_legacy_transfer(
            ledger_id,
            from_sub,
            cmc_account_id(&target_canister),
            amount_e8s,
            fee_e8s,
            MEMO_TOP_UP,
        )
        .await
    }
}

// Host-test: mirror the legacy-transfer mock exactly, so the existing unit tests
// (which set TEST_MOCK_LEDGER_TRANSFER) are unaffected by the is_local split.
#[cfg(not(target_arch = "wasm32"))]
async fn call_cmc_topup_transfer(
    _ledger_id: Principal,
    _from_sub: Option<[u8; 32]>,
    _target_canister: Principal,
    _amount_e8s: u64,
    _fee_e8s: u64,
) -> Result<u64, String> {
    TEST_MOCK_LEDGER_TRANSFER.with(|cell| cell.borrow().clone())
}

/// The frontend canister to top up with cycles (PB-125). Config override, else an
/// is_local fallback so it works after an upgrade without re-init.
fn frontend_canister_id() -> Principal {
    let cfg = CONFIG.with(|c| c.borrow().get().clone());
    if let Some(fid) = cfg.frontend_canister_id {
        return fid;
    }
    if cfg.is_local {
        Principal::from_text("a2cb4-hh777-77775-aaaba-cai").unwrap()
    } else {
        Principal::from_text("kyclk-5qaaa-aaaap-quthq-cai").unwrap()
    }
}

/// Encode a Principal as a 32-byte CMC subaccount: 1-byte length + principal
/// bytes + zero padding. Required by the CMC `notify_top_up` protocol — the
/// transfer to the CMC must target `{ owner: CMC, subaccount: Some(this) }`.
fn principal_to_subaccount(p: &Principal) -> [u8; 32] {
    let bytes = p.as_slice();
    let mut sub = [0u8; 32];
    sub[0] = bytes.len() as u8;
    sub[1..1 + bytes.len()].copy_from_slice(bytes);
    sub
}

/// Notify the CMC to mint cycles for `block_index` to `target`. Idempotent:
/// the CMC memoizes the per-block result, so re-notifying a processed block
/// returns the original Ok. `Refunded` is a hard failure — the caller must
/// drop its stored block index and re-transfer (see CMC_REFUNDED handling).
#[cfg(target_arch = "wasm32")]
async fn notify_cmc_topup(
    cmc: Principal,
    target: Principal,
    block_index: u64,
    fail_on_missing_cmc: bool,
) -> Result<(), String> {
    let args = NotifyTopUpArgs {
        canister_id: target,
        block_index,
    };
    let res: Result<(NotifyTopUpResult,), _> =
        ic_cdk::call(cmc, "notify_top_up", (args,)).await;
    match res {
        // The CMC memoizes the result per block, so re-notifying an
        // already-processed block returns the original Ok — retries are
        // naturally idempotent (no AlreadyNotified variant exists).
        Ok((NotifyTopUpResult::Ok(_),)) => Ok(()),
        Ok((NotifyTopUpResult::Err(NotifyError::Refunded { reason, .. }),)) => {
            // The CMC refused the block and sent the ICP back to the sending
            // (sub)account. Callers must drop their stored block index so the
            // retry re-transfers — re-notifying returns the same memoized
            // Refunded forever.
            Err(format!("CMC_REFUNDED: {}", reason))
        }
        Ok((NotifyTopUpResult::Err(e),)) => {
            Err(format!("CMC notify error: {:?}", e))
        }
        Err((code, msg)) => {
            let is_local = CONFIG.with(|c| c.borrow().get().is_local);
            if is_local && !fail_on_missing_cmc {
                Ok(())
            } else {
                Err(format!("CMC call rejected ({:?}): {}", code, msg))
            }
        }
    }
}

// Host-test mock: the CMC is unreachable off-canister, so treat the notify as a
// no-op success. Saga idempotency/transfer logic is exercised via the mocked
// ledger; the real notify path is covered by PocketIC integration tests.
#[cfg(not(target_arch = "wasm32"))]
async fn notify_cmc_topup(
    _cmc: Principal,
    _target: Principal,
    _block_index: u64,
    _fail_on_missing_cmc: bool,
) -> Result<(), String> {
    Ok(())
}

/// PB-125: distribute a settled commitment's proceeds — 50% → treasury,
/// 25% → backend cycles, 25% → frontend cycles. Idempotent via three per-step
/// block indices on the Commitment; a retry skips completed transfers and only
/// re-notifies the CMC (the CMC's memoized per-block result makes that safe).
async fn settle_burn_split(
    ledger_id: Principal,
    from_subaccount: [u8; 32],
    amount_e8s: u64,
    commitment: &mut Commitment,
) -> Result<(), String> {
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
    let treasury_dest = LedgerAccount { owner: get_canister_id(), subaccount: Some(TREASURY_SUBACCOUNT) };

    let treasury_amt = amount_e8s / 2;
    let backend_amt = amount_e8s / 4;
    let frontend_amt = amount_e8s - treasury_amt - backend_amt; // remainder ≈ 25%

    // 142135 post-mortem: a CMC refund returns a leg minus the ledger fee, so
    // a retry of this zero-slack escrow can be a few fees short of finishing.
    // On retries (some journal leg already done) the treasury fronts any
    // shortfall — the same fee-cover pattern the staking flow uses.
    let is_retry = commitment.treasury_block.is_some()
        || commitment.cmc_block_index.is_some()
        || commitment.frontend_cmc_block.is_some();
    if is_retry {
        let mut required: u64 = 0;
        if commitment.treasury_block.is_none() { required += treasury_amt + 10_000; }
        if commitment.cmc_block_index.is_none() { required += backend_amt + 10_000; }
        if commitment.frontend_cmc_block.is_none() { required += frontend_amt + 10_000; }
        let escrow_account = LedgerAccount { owner: get_canister_id(), subaccount: Some(from_subaccount) };
        let balance = call_ledger_balance(ledger_id, escrow_account.clone())
            .await
            .map_err(|e| format!("ESCROW_BALANCE: {}", e))?;
        if balance < required {
            let shortfall = required - balance;
            call_ledger_transfer(ledger_id, Some(TREASURY_SUBACCOUNT), escrow_account, shortfall, Some(10_000))
                .await
                .map_err(|e| format!("TREASURY_FEE_COVER: {}", e))?;
            canister_print(&format!(
                "settle_burn_split: treasury covered {} e8s escrow shortfall for proposal {}",
                shortfall, commitment.proposal_id
            ));
        }
    }

    // 50% → treasury (held as ICP, admin-withdrawable)
    if commitment.treasury_block.is_none() {
        let b = call_ledger_transfer(ledger_id, Some(from_subaccount), treasury_dest, treasury_amt, Some(10_000))
            .await.map_err(|e| format!("TREASURY_XFER: {}", e))?;
        commitment.treasury_block = Some(b);
    }

    // 25% → backend cycles
    if commitment.cmc_block_index.is_none() {
        let b = call_cmc_topup_transfer(
            ledger_id,
            Some(from_subaccount),
            get_canister_id(),
            backend_amt,
            10_000,
        )
        .await
        .map_err(|e| format!("BACKEND_CMC_XFER: {}", e))?;
        commitment.cmc_block_index = Some(b);
    }
    if let Err(e) = notify_cmc_topup(
        cmc,
        get_canister_id(),
        commitment.cmc_block_index.unwrap(),
        commitment.proposal_id != 138388,
    )
    .await
    {
        if e.starts_with("CMC_REFUNDED") {
            // The ICP came back to the escrow subaccount — drop the block
            // index so the retry re-transfers (re-notifying the refused
            // block returns the memoized Refunded forever).
            commitment.cmc_block_index = None;
        }
        return Err(format!("BACKEND_CMC_NOTIFY: {}", e));
    }

    // 25% → frontend cycles
    if commitment.frontend_cmc_block.is_none() {
        let b = call_cmc_topup_transfer(
            ledger_id,
            Some(from_subaccount),
            frontend_canister_id(),
            frontend_amt,
            10_000,
        )
        .await
        .map_err(|e| format!("FRONTEND_CMC_XFER: {}", e))?;
        commitment.frontend_cmc_block = Some(b);
    }
    if let Err(e) = notify_cmc_topup(
        cmc,
        frontend_canister_id(),
        commitment.frontend_cmc_block.unwrap(),
        commitment.proposal_id != 138388,
    )
    .await
    {
        if e.starts_with("CMC_REFUNDED") {
            commitment.frontend_cmc_block = None;
        }
        return Err(format!("FRONTEND_CMC_NOTIFY: {}", e));
    }

    Ok(())
}

#[ic_cdk::query]
fn get_deposit_address(proposal_id: u64) -> LedgerAccount {
    let caller = get_caller();
    let sub = derive_subaccount(&caller, proposal_id);
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    }
}

#[ic_cdk::query]
fn get_registration_address() -> LedgerAccount {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        panic!("Anonymous principal is not allowed");
    }
    let sub = derive_subaccount(&caller, REGISTRATION_SEED);
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    }
}

#[ic_cdk::update]
async fn refund_registration() -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let sub = derive_subaccount(&caller, REGISTRATION_SEED);
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let escrow_acc = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let bal = call_ledger_balance(ledger_id, escrow_acc).await?;
    if bal <= 10_000 {
        return Err("NOTHING_TO_REFUND".to_string());
    }
    let transfer_amt = bal - 10_000;
    let dest = LedgerAccount {
        owner: caller,
        subaccount: None,
    };
    call_ledger_transfer(
        ledger_id,
        Some(sub),
        dest,
        transfer_amt,
        Some(10_000)
    ).await?;
    Ok(())
}

#[ic_cdk::update]
async fn create_pool_draft(neuron_id: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    // First-come binding: if neuron_id exists with a different
    // registered_by, reject ALREADY_REGISTERED
    let existing = POOL_NEURONS.with(|map| map.borrow().get(&neuron_id));
    if let Some(ref pn) = existing {
        if pn.registered_by != caller {
            return Err("ALREADY_REGISTERED".to_string());
        }
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    
    let voting_power = if config.is_local {
        // Enforce 10_000_000_000 (100 ICP) as local mock voting power
        10_000_000_000
    } else {
        let neuron = get_full_neuron(neuron_id)
            .await
            .map_err(|e| format!("Failed to fetch neuron: {}", e))?;
        
        // Assert our canister principal is in hot_keys
        if !neuron_has_hotkey(&neuron, get_canister_id()) {
            return Err("HOTKEY_MISSING".to_string());
        }

        // Assert the neuron follows the primary leader on TOPIC_GOVERNANCE
        let follows = neuron_follows(
            &neuron,
            config.primary_neuron_id,
            TOPIC_GOVERNANCE,
        );
        if !follows {
            return Err("NOT_FOLLOWING".to_string());
        }

        neuron_voting_power(&neuron)
    };

    let now = current_time();
    let draft = PoolNeuron {
        neuron_id,
        registered_by: caller,
        voting_power,
        status: PoolStatus::Draft,
        created_at: now,
        activated_at: None,
        treasury_block: None,
        backend_cmc_block: None,
        frontend_cmc_block: None,
    };

    POOL_NEURONS.with(|map| {
        map.borrow_mut().insert(neuron_id, draft);
    });

    // Audit-log `pool_draft`
    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "pool_draft".to_string(),
        proposal_id: neuron_id,
        user: caller,
        amount_e8s: 0,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

#[ic_cdk::update]
async fn finalize_pool_registration(neuron_id: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    // 1. Assert caller owns a Draft (or Inactive) PoolNeuron for neuron_id
    let mut neuron_state = POOL_NEURONS
        .with(|map| map.borrow().get(&neuron_id))
        .ok_or_else(|| "NO_DRAFT".to_string())?;

    if neuron_state.registered_by != caller {
        return Err("NO_DRAFT".to_string());
    }

    if neuron_state.status != PoolStatus::Draft
        && neuron_state.status != PoolStatus::Inactive
    {
        return Err("NO_DRAFT".to_string());
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());

    // 2. Re-verify hotkey + follow via get_full_neuron (skipped when is_local)
    let voting_power = if config.is_local {
        neuron_state.voting_power
    } else {
        let neuron = get_full_neuron(neuron_id)
            .await
            .map_err(|e| format!("Failed to fetch neuron: {}", e))?;

        if !neuron_has_hotkey(&neuron, get_canister_id()) {
            return Err("HOTKEY_MISSING".to_string());
        }

        let follows = neuron_follows(
            &neuron,
            config.primary_neuron_id,
            TOPIC_GOVERNANCE,
        );
        if !follows {
            return Err("NOT_FOLLOWING".to_string());
        }

        neuron_voting_power(&neuron)
    };

    // 3. Assert registration escrow balance >= pool_initiation_fee_e8s + 30_000
    let sub = derive_subaccount(&caller, REGISTRATION_SEED);
    let escrow_acc = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let ledger_id = config.ledger_canister_id;
    let bal = call_ledger_balance(ledger_id, escrow_acc).await?;
    let fee_needed = config.pool_initiation_fee_e8s;
    if bal < fee_needed + 30_000 {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // 4. Fee-split saga (idempotent, block index guarded)
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };

    let treasury_amt = fee_needed / 2;
    let backend_amt = fee_needed / 4;
    let frontend_amt = fee_needed - treasury_amt - backend_amt;

    // Step A: 50% -> treasury
    if neuron_state.treasury_block.is_none() {
        let b = call_ledger_transfer(
            ledger_id,
            Some(sub),
            treasury_dest,
            treasury_amt,
            Some(10_000),
        )
        .await
        .map_err(|e| format!("TREASURY_XFER: {}", e))?;
        neuron_state.treasury_block = Some(b);
        POOL_NEURONS.with(|map| {
            map.borrow_mut().insert(neuron_id, neuron_state.clone());
        });
    }

    // Step B: 25% -> backend cycles
    if neuron_state.backend_cmc_block.is_none() {
        let b = call_cmc_topup_transfer(
            ledger_id,
            Some(sub),
            get_canister_id(),
            backend_amt,
            10_000,
        )
        .await
        .map_err(|e| format!("BACKEND_CMC_XFER: {}", e))?;
        neuron_state.backend_cmc_block = Some(b);
        POOL_NEURONS.with(|map| {
            map.borrow_mut().insert(neuron_id, neuron_state.clone());
        });
    }
    if let Err(e) = notify_cmc_topup(
        cmc,
        get_canister_id(),
        neuron_state.backend_cmc_block.unwrap(),
        false,
    )
    .await
    {
        if e.starts_with("CMC_REFUNDED") {
            // Refund landed back in the fee subaccount — re-transfer on retry.
            neuron_state.backend_cmc_block = None;
            POOL_NEURONS.with(|map| {
                map.borrow_mut().insert(neuron_id, neuron_state.clone());
            });
        }
        return Err(format!("BACKEND_CMC_NOTIFY: {}", e));
    }

    // Step C: 25% -> frontend cycles
    if neuron_state.frontend_cmc_block.is_none() {
        let b = call_cmc_topup_transfer(
            ledger_id,
            Some(sub),
            frontend_canister_id(),
            frontend_amt,
            10_000,
        )
        .await
        .map_err(|e| format!("FRONTEND_CMC_XFER: {}", e))?;
        neuron_state.frontend_cmc_block = Some(b);
        POOL_NEURONS.with(|map| {
            map.borrow_mut().insert(neuron_id, neuron_state.clone());
        });
    }
    if let Err(e) = notify_cmc_topup(
        cmc,
        frontend_canister_id(),
        neuron_state.frontend_cmc_block.unwrap(),
        false,
    )
    .await
    {
        if e.starts_with("CMC_REFUNDED") {
            neuron_state.frontend_cmc_block = None;
            POOL_NEURONS.with(|map| {
                map.borrow_mut().insert(neuron_id, neuron_state.clone());
            });
        }
        return Err(format!("FRONTEND_CMC_NOTIFY: {}", e));
    }

    // 5. Flip status to Active, set activated_at, recompute pool stats
    let now = current_time();
    neuron_state.status = PoolStatus::Active;
    neuron_state.activated_at = Some(now);
    neuron_state.voting_power = voting_power;

    POOL_NEURONS.with(|map| {
        map.borrow_mut().insert(neuron_id, neuron_state);
    });

    recompute_pool_info();

    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "pool_register".to_string(),
        proposal_id: neuron_id,
        user: caller,
        amount_e8s: fee_needed,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

#[ic_cdk::update]
fn cancel_pool_draft(neuron_id: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let existing = POOL_NEURONS.with(|map| map.borrow().get(&neuron_id));
    let pn = match existing {
        Some(pn) => pn,
        None => return Err("NO_DRAFT".to_string()),
    };

    if pn.registered_by != caller {
        return Err("UNAUTHORIZED".to_string());
    }

    // Removable states: a Draft that was never paid, or an Inactive neuron the
    // user has left the pool with. An Active neuron must `unregister_leader_neuron`
    // first (which flips it to Inactive). Its fee was already split on activation,
    // so there is nothing to refund here.
    if pn.status != PoolStatus::Draft && pn.status != PoolStatus::Inactive {
        return Err("INVALID_STATE".to_string());
    }

    POOL_NEURONS.with(|map| {
        map.borrow_mut().remove(&neuron_id);
    });

    recompute_pool_info();

    Ok(())
}

#[ic_cdk::update]
fn unregister_leader_neuron(neuron_id: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let existing = POOL_NEURONS.with(|map| map.borrow().get(&neuron_id));
    let mut pn = match existing {
        Some(pn) => pn,
        None => return Err("NO_ACTIVE_NEURON".to_string()),
    };

    if pn.registered_by != caller {
        return Err("UNAUTHORIZED".to_string());
    }

    if pn.status != PoolStatus::Active {
        return Err("INVALID_STATE".to_string());
    }

    pn.status = PoolStatus::Inactive;

    POOL_NEURONS.with(|map| {
        map.borrow_mut().insert(neuron_id, pn);
    });

    recompute_pool_info();

    let now = current_time();
    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "pool_leave".to_string(),
        proposal_id: neuron_id,
        user: caller,
        amount_e8s: 0,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

#[ic_cdk::update]
async fn commit(proposal_id: u64, stance: Stance, target_e8s: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();

    let _guard = CallerGuard::new(caller)?;

    let user_neuron = USER_NEURONS.with(|map| map.borrow().get(&caller));
    let user_neuron = match user_neuron {
        Some(state) => state,
        None => return Err("NEURON_NOT_REGISTERED".to_string()),
    };

    if !user_neuron.is_following {
        return Err("NOT_FOLLOWING".to_string());
    }

    let key = CommitmentKey {
        proposal_id,
        principal: caller,
    };
    let existing_amount = COMMITMENTS.with(|map| {
        map.borrow().get(&key).map(|c| c.amount_e8s).unwrap_or(0)
    });

    if existing_amount > 0 {
        return Err("ALREADY_COMMITTED".to_string());
    }

    // Per-user storage quota: cap open commitment slots
    let active_count = COMMITMENTS.with(|map| {
        map.borrow().iter()
            .filter(|e| {
                let c = e.value();
                c.principal == caller && c.status == CommitmentStatus::Pending
            })
            .count()
    });
    if active_count >= MAX_COMMITMENTS_PER_USER {
        return Err("TOO_MANY_COMMITMENTS".to_string());
    }

    if target_e8s < MIN_COMMIT_E8S {
        return Err("BELOW_MINIMUM".to_string());
    }

    if target_e8s > MAX_COMMIT_E8S {
        return Err("EXCEEDS_GLOBAL_CAP".to_string());
    }

    // Option C: no neuron-stake cap. The amount is capped by the user's wallet —
    // enforced below by requiring the escrow to be funded (INSUFFICIENT_DEPOSIT).

    let proposal = PROPOSALS.with(|map| map.borrow().get(&proposal_id));
    let mut proposal = match proposal {
        Some(p) => p,
        None => return Err("PROPOSAL_NOT_FOUND".to_string()),
    };

    // "met" proposals remain open for further commits — threshold is a floor, not a cap
    if proposal.status != "open" && proposal.status != "met" {
        return Err("COMMITMENT_CLOSED".to_string());
    }

    let now = current_time();
    if now >= proposal.deadline.saturating_sub(3_600_000_000_000) {
        return Err("COMMITMENT_CLOSED".to_string());
    }

    let subaccount = derive_subaccount(&caller, proposal_id);
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;

    let escrow_account = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(subaccount),
    };

    let balance = call_ledger_balance(ledger_id, escrow_account).await?;
    // target + 500_000 protocol fee + 4×10_000 ledger fees (commit fee transfer +
    // the three settlement-split transfers: treasury, backend CMC, frontend CMC).
    let required_deposit = target_e8s + 540_000;

    if balance < required_deposit {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };

    call_ledger_transfer(
        ledger_id,
        Some(subaccount),
        treasury_dest,
        500_000,
        Some(10_000),
    ).await.map_err(|e| format!("FEE_TRANSFER_FAILED: {}", e))?;

    // F-105: compute pot updates with checked arithmetic BEFORE writing any state,
    // so an (effectively impossible) overflow returns an error without orphaning a
    // Pending commitment. The fee transfer above is the saga point-of-no-return.
    // Record the first stance on this proposal — the tie-breaker at settlement.
    if proposal.first_stance.is_none() {
        proposal.first_stance = Some(stance.clone());
    }

    if stance == Stance::Adopt {
        proposal.adopt_pot_e8s = proposal.adopt_pot_e8s
            .checked_add(target_e8s)
            .ok_or("POT_OVERFLOW")?;
    } else {
        proposal.reject_pot_e8s = proposal.reject_pot_e8s
            .checked_add(target_e8s)
            .ok_or("POT_OVERFLOW")?;
    }
    proposal.total_committed_e8s = proposal.total_committed_e8s
        .checked_add(target_e8s)
        .ok_or("POT_OVERFLOW")?;

    if proposal_threshold_met(&proposal) {
        proposal.status = "met".to_string();
    }

    let commitment = Commitment {
        proposal_id,
        principal: caller,
        amount_e8s: target_e8s,
        status: CommitmentStatus::Pending,
        created_at: now,
        stance: stance.clone(),
        subaccount,
        settled_at: None,
        cmc_block_index: None,
        treasury_block: None,
        frontend_cmc_block: None,
    };

    COMMITMENTS.with(|map| {
        map.borrow_mut().insert(key, commitment);
    });

    PROPOSALS.with(|map| {
        map.borrow_mut().insert(proposal_id, proposal);
    });

    USER_AGGREGATES.with(|map| {
        let mut agg = map.borrow().get(&caller).unwrap_or(UserAggregates {
            total_committed_escrow: 0,
            total_burned: 0,
            proposals_joined: 0,
        });
        // F-105: checked arithmetic. A wrap would mis-attribute the user's escrow.
        agg.total_committed_escrow = agg.total_committed_escrow
            .checked_add(target_e8s)
            .unwrap_or(u64::MAX);
        agg.proposals_joined = agg.proposals_joined
            .checked_add(1)
            .unwrap_or(u32::MAX);
        map.borrow_mut().insert(caller, agg);
    });

    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "deposit".to_string(),
        proposal_id,
        user: caller,
        amount_e8s: target_e8s,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

#[ic_cdk::update]
async fn add_to_commitment(proposal_id: u64, additional_e8s: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    // 1. Lookup existing commitment — must exist and be Pending
    let key = CommitmentKey { proposal_id, principal: caller };
    let mut commitment = COMMITMENTS.with(|map| map.borrow().get(&key))
        .ok_or("NO_EXISTING_COMMITMENT")?;
    if commitment.status != CommitmentStatus::Pending {
        return Err("COMMITMENT_NOT_PENDING".to_string());
    }

    // 2. Validate additional amount
    if additional_e8s < MIN_COMMIT_E8S {
        return Err("BELOW_MINIMUM".to_string());
    }
    let new_amount = commitment.amount_e8s
        .checked_add(additional_e8s)
        .ok_or("AMOUNT_OVERFLOW")?;
    if new_amount > MAX_COMMIT_E8S {
        return Err("EXCEEDS_GLOBAL_CAP".to_string());
    }

    // 3. Validate proposal is still open for voting
    let mut proposal = PROPOSALS.with(|map| map.borrow().get(&proposal_id))
        .ok_or("PROPOSAL_NOT_FOUND")?;
    if proposal.status != "open" && proposal.status != "met" {
        return Err("COMMITMENT_CLOSED".to_string());
    }
    let now = current_time();
    if now >= proposal.deadline.saturating_sub(3_600_000_000_000) {
        return Err("COMMITMENT_CLOSED".to_string());
    }

    // 4. Escrow balance check — no protocol fee on top-ups, only need
    //    the additional amount deposited. The 30,000 e8s settlement fee
    //    reserve was already deposited with the original commit.
    let subaccount = commitment.subaccount;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let escrow_account = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(subaccount),
    };
    let balance = call_ledger_balance(ledger_id, escrow_account).await?;
    let required_balance = new_amount
        .checked_add(30_000)
        .ok_or("OVERFLOW")?;
    if balance < required_balance {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // 5. Update commitment amount (no protocol fee transfer)
    commitment.amount_e8s = new_amount;
    COMMITMENTS.with(|map| { map.borrow_mut().insert(key, commitment.clone()); });

    // 6. Update proposal pots
    if commitment.stance == Stance::Adopt {
        proposal.adopt_pot_e8s = proposal.adopt_pot_e8s
            .checked_add(additional_e8s).ok_or("POT_OVERFLOW")?;
    } else {
        proposal.reject_pot_e8s = proposal.reject_pot_e8s
            .checked_add(additional_e8s).ok_or("POT_OVERFLOW")?;
    }
    proposal.total_committed_e8s = proposal.total_committed_e8s
        .checked_add(additional_e8s).ok_or("POT_OVERFLOW")?;
    if proposal_threshold_met(&proposal) {
        proposal.status = "met".to_string();
    }
    PROPOSALS.with(|map| { map.borrow_mut().insert(proposal_id, proposal); });

    // 7. Update user aggregates (don't increment proposals_joined)
    USER_AGGREGATES.with(|map| {
        let mut agg = map.borrow().get(&caller).unwrap_or(UserAggregates {
            total_committed_escrow: 0, total_burned: 0, proposals_joined: 0,
        });
        agg.total_committed_escrow = agg.total_committed_escrow
            .checked_add(additional_e8s).unwrap_or(u64::MAX);
        map.borrow_mut().insert(caller, agg);
    });

    // 8. Audit log
    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "add_commitment".to_string(),
        proposal_id,
        user: caller,
        amount_e8s: additional_e8s,
    };
    AUDIT_LOG.with(|log| { let _ = log.borrow_mut().append(&log_entry); });

    Ok(())
}

#[ic_cdk::query]
fn get_my_commitments() -> Vec<Commitment> {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        return vec![];
    }
    COMMITMENTS.with(|map| {
        map.borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|c| c.principal == caller)
            .collect()
    })
}

#[ic_cdk::update(guard = "require_admin")]
async fn get_treasury_balance() -> BalanceResult {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let treasury_account = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    match call_ledger_balance(ledger_id, treasury_account).await {
        Ok(bal) => BalanceResult::Ok(bal),
        Err(e) => BalanceResult::Err(e),
    }
}

/// The treasury's ledger account — deposit ICP here to fund it directly
/// (admin top-ups, external donations). Not secret: it's just the backend
/// canister plus the fixed treasury subaccount.
#[ic_cdk::query]
fn get_treasury_deposit_address() -> LedgerAccount {
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NeuronFollowStatus {
    pub label: String,
    pub neuron_id: u64,
    /// True when all three followed topics (catch-all, Governance,
    /// SNS & Neurons' Fund) point at the primary neuron.
    pub follows_primary: bool,
    pub topics_following_primary: Vec<i32>,
    pub error: Option<String>,
}

/// Admin diagnostic: live follow status of every platform-owned neuron
/// (the three staking tiers + the early-adopter neuron), read from NNS
/// governance. Answers "are our neurons actually following the primary?".
#[ic_cdk::update(guard = "require_admin")]
async fn admin_check_neuron_following() -> Vec<NeuronFollowStatus> {
    let primary = CONFIG.with(|c| c.borrow().get().primary_neuron_id);
    let mut targets: Vec<(String, u64)> = Vec::new();
    for tier in [StakeTier::SixMonths, StakeTier::OneYear, StakeTier::TwoYears] {
        if let Some(id) = tier_pool(tier).neuron_id {
            targets.push((format!("staking_{:?}", tier), id));
        }
    }
    if let Some(id) = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().neuron_id) {
        targets.push(("early_adopters".to_string(), id));
    }
    let mut out = Vec::new();
    for (label, neuron_id) in targets {
        match get_full_neuron(neuron_id).await {
            Ok(n) => {
                let topics: Vec<i32> = n
                    .followees
                    .iter()
                    .filter(|(_, f)| f.followees.iter().any(|x| x.id == primary))
                    .map(|(t, _)| *t)
                    .collect();
                let follows = [TOPIC_CATCH_ALL, TOPIC_GOVERNANCE, TOPIC_SNS_AND_NEURONS_FUND]
                    .iter()
                    .all(|t| topics.contains(t));
                out.push(NeuronFollowStatus {
                    label,
                    neuron_id,
                    follows_primary: follows,
                    topics_following_primary: topics,
                    error: None,
                });
            }
            Err(e) => out.push(NeuronFollowStatus {
                label,
                neuron_id,
                follows_primary: false,
                topics_following_primary: vec![],
                error: Some(e),
            }),
        }
    }
    out
}

/// Admin: withdraw ICP from the treasury subaccount to a destination principal.
#[ic_cdk::update(guard = "require_admin")]
async fn admin_withdraw_treasury(to: Principal, amount_e8s: u64) -> Result<(), String> {
    if to == Principal::anonymous() {
        return Err("INVALID_DESTINATION".to_string());
    }
    if amount_e8s == 0 {
        return Err("INVALID_AMOUNT".to_string());
    }
    let ledger_id = CONFIG.with(|cell| cell.borrow().get().ledger_canister_id);
    let dest = LedgerAccount { owner: to, subaccount: None };
    call_ledger_transfer(ledger_id, Some(TREASURY_SUBACCOUNT), dest, amount_e8s, Some(10_000))
        .await
        .map(|_| ())
        .map_err(|e| format!("TREASURY_WITHDRAW_FAILED: {}", e))
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// Host-test cycles balance (default: comfortably above the top-up floor).
    static TEST_MOCK_CYCLES: RefCell<u64> = const { RefCell::new(10_000_000_000_000) };
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_cycles(balance: u64) {
    TEST_MOCK_CYCLES.with(|cell| *cell.borrow_mut() = balance);
}

fn canister_cycle_balance() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::canister_balance()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        TEST_MOCK_CYCLES.with(|cell| *cell.borrow())
    }
}

#[ic_cdk::query]
fn get_cycle_balance() -> u64 {
    canister_cycle_balance()
}

#[ic_cdk::update]
fn wallet_receive() -> Result<(), String> {
    let amount = ic_cdk::api::call::msg_cycles_available();
    if amount > 0 {
        let _ = ic_cdk::api::call::msg_cycles_accept(amount);
        Ok(())
    } else {
        Err("No cycles sent".to_string())
    }
}

// NNS Voting & Automated Sweeps
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NnsProposalId {
    pub id: u64,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct RegisterVoteCommand {
    pub proposal: Option<NnsProposalId>,
    pub vote: i32,
}

// ── ManageNeuron commands (subset of the governance candid; variant and field
// names verified against dfinity/ic rs/nns/governance/canister/governance.did.
// Candid encodes variants by name, so a subset enum stays wire-compatible). ──

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EmptyRecord {}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct MemoAndController {
    pub controller: Option<Principal>,
    pub memo: u64,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub enum By {
    MemoAndController(MemoAndController),
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct ClaimOrRefreshCmd {
    pub by: Option<By>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct IncreaseDissolveDelay {
    pub additional_dissolve_delay_seconds: u32,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub enum Operation {
    StartDissolving(EmptyRecord),
    StopDissolving(EmptyRecord),
    IncreaseDissolveDelay(IncreaseDissolveDelay),
    SetVisibility(SetVisibilityOp),
}

/// governance.did: `SetVisibility = record { visibility : opt int32 }`.
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct SetVisibilityOp {
    pub visibility: Option<i32>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct ConfigureCmd {
    pub operation: Option<Operation>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct FollowCmd {
    pub topic: i32,
    pub followees: Vec<NeuronId>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct SplitCmd {
    pub amount_e8s: u64,
    pub memo: Option<u64>,
}

/// Governance `AccountIdentifier` — the 28-byte SHA-224 hash WITHOUT the CRC32
/// prefix (unlike the 32-byte ledger address form).
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct GovAccountIdentifier {
    pub hash: Vec<u8>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct Amount {
    pub e8s: u64,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct DisburseCmd {
    pub to_account: Option<GovAccountIdentifier>,
    pub amount: Option<Amount>,
}

/// Governance's ICRC-1-style account (`owner`/`subaccount` both optional).
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct GovAccount {
    pub owner: Option<Principal>,
    pub subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct DisburseMaturityCmd {
    pub percentage_to_disburse: u32,
    pub to_account: Option<GovAccount>,
    pub to_account_identifier: Option<GovAccountIdentifier>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub enum Command {
    RegisterVote(RegisterVoteCommand),
    ClaimOrRefresh(ClaimOrRefreshCmd),
    Configure(ConfigureCmd),
    Follow(FollowCmd),
    Split(SplitCmd),
    Merge(MergeCmd),
    Disburse(DisburseCmd),
    DisburseMaturity(DisburseMaturityCmd),
}

/// governance.did: `Merge = record { source_neuron_id : opt NeuronId }` —
/// the source's stake (minus the ledger fee) merges into the target neuron
/// named by ManageNeuron.id.
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct MergeCmd {
    pub source_neuron_id: Option<NeuronId>,
}

#[derive(CandidType, Serialize, Clone, Debug)]
pub struct ManageNeuron {
    pub id: Option<NeuronId>,
    pub command: Option<Command>,
    pub neuron_id_or_subaccount: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ManageNeuronResponse {
    pub command: Option<CommandResponse>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ClaimOrRefreshResponse {
    pub refreshed_neuron_id: Option<NeuronId>,
}

/// Response to both `Split` and `Spawn` in the governance candid.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct SpawnResponse {
    pub created_neuron_id: Option<NeuronId>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct DisburseResponse {
    pub transfer_block_height: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct DisburseMaturityResponse {
    pub amount_disbursed_e8s: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum CommandResponse {
    RegisterVote(RegisterVoteResponse),
    Error(GovernanceError),
    ClaimOrRefresh(ClaimOrRefreshResponse),
    Configure(EmptyRecord),
    Follow(EmptyRecord),
    Split(SpawnResponse),
    // Decoded as an empty record — we only need success/failure, and candid
    // skips the response's (large) unknown fields on decode.
    Merge(EmptyRecord),
    Disburse(DisburseResponse),
    DisburseMaturity(DisburseMaturityResponse),
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct RegisterVoteResponse {}

// ── NNS list_proposals (PB-117: live proposal feed) ──
// Only the fields we consume are declared; candid ignores the rest on decode.
#[derive(CandidType, Serialize, Clone, Debug)]
pub struct ListProposalInfo {
    pub include_reward_status: Vec<i32>,
    pub omit_large_fields: Option<bool>,
    pub before_proposal: Option<NnsProposalId>,
    pub limit: u32,
    pub exclude_topic: Vec<i32>,
    pub include_all_manage_neuron_proposals: Option<bool>,
    pub include_status: Vec<i32>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct NnsProposalData {
    pub title: Option<String>,
    pub summary: String,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct NnsProposalInfo {
    pub id: Option<NnsProposalId>,
    pub status: i32,
    pub topic: i32,
    pub proposal: Option<NnsProposalData>,
    pub deadline_timestamp_seconds: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ListProposalInfoResponse {
    pub proposal_info: Vec<NnsProposalInfo>,
}

/// Maps an NNS topic int to a short human label for the UI.
fn nns_topic_label(topic: i32) -> String {
    match topic {
        1 => "Neuron Management",
        2 => "Exchange Rate",
        3 => "Network Economics",
        4 => "Governance",
        5 => "Node Admin",
        6 => "Participant Management",
        7 => "Subnet Management",
        8 => "Network Canister Management",
        9 => "KYC",
        10 => "Node Provider Rewards",
        12 => "IC OS Version Deployment",
        13 => "IC OS Version Election",
        14 => "SNS & Neurons' Fund",
        15 => "API Boundary Node Management",
        _ => "Governance",
    }
    .to_string()
}

/// PB-117: pull currently-open NNS proposals and upsert them as internal
/// proposals so the app governs real, live proposals (not mock seed data).
/// Idempotent: existing proposals (keyed by NNS id) are left untouched.
async fn fetch_live_proposals() {
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();
    let arg = ListProposalInfo {
        include_reward_status: vec![],
        omit_large_fields: Some(true),
        before_proposal: None,
        limit: 50,
        exclude_topic: vec![],
        include_all_manage_neuron_proposals: Some(false),
        include_status: vec![1], // 1 = Open
    };

    let response: Result<(ListProposalInfoResponse,), _> =
        ic_cdk::call(nns_gov, "list_proposals", (arg,)).await;

    let infos = match response {
        Ok((resp,)) => resp.proposal_info,
        Err((code, msg)) => {
            canister_print(&format!("list_proposals failed (code {:?}): {}", code, msg));
            return;
        }
    };

    let default_threshold = CONFIG.with(|c| c.borrow().get().default_threshold);
    let now = current_time();

    for info in infos {
        // Only open proposals with a real id and a future voting deadline.
        let nns_id = match info.id {
            Some(p) => p.id,
            None => continue,
        };
        if info.status != 1 {
            continue;
        }
        let deadline_ns = match info.deadline_timestamp_seconds {
            Some(secs) => secs.saturating_mul(1_000_000_000),
            None => continue,
        };
        // Need at least the 1h commit cutoff left to be useful.
        if deadline_ns <= now.saturating_add(3_600_000_000_000) {
            continue;
        }

        // Skip if we already track this proposal (idempotent upsert).
        let exists = PROPOSALS.with(|map| map.borrow().get(&nns_id).is_some());
        if exists {
            continue;
        }
        if proposals_at_quota() {
            break;
        }

        // Keep title and summary as distinct fields (the NNS shows both). When a
        // proposal has no explicit title (common for action-derived ones), fall
        // back to a topic + id label rather than swallowing the summary.
        let nns_proposal = info.proposal.as_ref();
        let summary = nns_proposal.map(|p| p.summary.clone()).unwrap_or_default();
        let title = nns_proposal
            .and_then(|p| p.title.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("{} · #{}", nns_topic_label(info.topic), nns_id));

        let proposal = Proposal {
            id: nns_id,
            title,
            summary,
            category: nns_topic_label(info.topic),
            deadline: deadline_ns,
            nns_proposal_id: Some(nns_id),
            status: "open".to_string(),
            threshold_e8s: default_threshold,
            total_committed_e8s: 0,
            adopt_pot_e8s: 0,
            reject_pot_e8s: 0,
            vote_executed_at: None,
            total_burned_e8s: None,
            first_stance: None,
            pool_distributed: false,
            lossless_adopt_e8s: 0,
            lossless_reject_e8s: 0,
        };
        PROPOSALS.with(|map| {
            map.borrow_mut().insert(nns_id, proposal);
        });
    }
}

/// Host-test mock: governance is unreachable off-canister. Defaults to Ok so
/// unit tests can drive the full voted-settlement path; override via
/// `set_mock_nns_vote` to exercise the failure branches.
#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_NNS_VOTE: RefCell<Result<(), String>> = const { RefCell::new(Ok(())) };
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_nns_vote(res: Result<(), String>) {
    TEST_MOCK_NNS_VOTE.with(|cell| {
        *cell.borrow_mut() = res;
    });
}

#[cfg(not(target_arch = "wasm32"))]
async fn cast_nns_vote(_leader_id: u64, _proposal_id: u64, _vote_choice: i32) -> Result<(), String> {
    TEST_MOCK_NNS_VOTE.with(|cell| cell.borrow().clone())
}

#[cfg(target_arch = "wasm32")]
async fn cast_nns_vote(leader_id: u64, proposal_id: u64, vote_choice: i32) -> Result<(), String> {
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();
    let args = ManageNeuron {
        id: Some(NeuronId { id: leader_id }),
        command: Some(Command::RegisterVote(RegisterVoteCommand {
            proposal: Some(NnsProposalId { id: proposal_id }),
            vote: vote_choice,
        })),
        neuron_id_or_subaccount: None,
    };

    let response: Result<(ManageNeuronResponse,), _> = ic_cdk::call(nns_gov, "manage_neuron", (args,)).await;
    match response {
        Ok((res,)) => {
            match res.command {
                Some(CommandResponse::RegisterVote(_)) => Ok(()),
                Some(CommandResponse::Error(err)) => Err(format!("NNS error: {}", err.error_message)),
                Some(_) => Err("Unexpected NNS command response".to_string()),
                None => Err("No command response from NNS".to_string()),
            }
        }
        Err((code, msg)) => {
            // F-102: on mainnet, a rejected `manage_neuron` vote must NOT be
            // reported as success — that would mark the proposal `"voted"` and
            // burn all committed ICP despite no vote being cast. The local-only
            // fallback short-circuits to Ok(()) so dev can simulate a successful
            // vote against a stub NNS canister.
            let is_local = CONFIG.with(|cell| cell.borrow().get().is_local);
            if is_local
                && (code == ic_cdk::api::call::RejectionCode::DestinationInvalid
                    || code == ic_cdk::api::call::RejectionCode::CanisterError
                    || code == ic_cdk::api::call::RejectionCode::CanisterReject)
            {
                Ok(())
            } else {
                Err(format!("NNS call rejected (code {:?}): {}", code, msg))
            }
        }
    }
}

/// Threshold satisfaction: EITHER burned conviction or staked conviction can
/// carry a proposal — it is "met" when burn commitments reach the threshold
/// OR when the combined staked voting weight (both sides) equals/exceeds the
/// same ICP threshold.
fn proposal_threshold_met(p: &Proposal) -> bool {
    let staked = p.lossless_adopt_e8s.saturating_add(p.lossless_reject_e8s);
    p.total_committed_e8s >= p.threshold_e8s || staked >= p.threshold_e8s
}

/// NNS vote choice (1 = Yes/adopt, 2 = No/reject) from the committed pots.
/// Majority of committed ICP wins; an exact tie is broken by the first stance
/// committed (first vote wins); if somehow unset, defaults to No.
fn decide_vote_choice(adopt_e8s: u64, reject_e8s: u64, first_stance: Option<Stance>) -> i32 {
    if adopt_e8s > reject_e8s {
        1
    } else if reject_e8s > adopt_e8s {
        2
    } else {
        match first_stance {
            Some(Stance::Adopt) => 1,
            _ => 2,
        }
    }
}

async fn process_proposal_cutoff(pid: u64) -> Result<(), String> {
    let proposal = PROPOSALS.with(|map| map.borrow().get(&pid));
    let mut proposal = match proposal {
        Some(p) => p,
        None => return Err("Proposal not found".to_string()),
    };

    let met = proposal_threshold_met(&proposal);
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    // PB-123: majority of committed ICP wins; an exact tie is broken by the
    // first stance committed on this proposal (first vote wins). Lossless
    // staking weight joins the balance of power here — never the threshold.
    let vote_choice = decide_vote_choice(
        proposal.adopt_pot_e8s.saturating_add(proposal.lossless_adopt_e8s),
        proposal.reject_pot_e8s.saturating_add(proposal.lossless_reject_e8s),
        proposal.first_stance.clone(),
    );

    let mut vote_success = false;
    match proposal.nns_proposal_id {
        Some(nns_id) => {
            let vote_result = cast_nns_vote(config.primary_neuron_id, nns_id, vote_choice).await;
            match vote_result {
                Ok(_) => {
                    vote_success = true;
                    proposal.vote_executed_at = Some(current_time());
                }
                Err(e) => {
                    canister_print(&format!("NNS vote failed for proposal {}: {}", pid, e));
                }
            }
            // The lossless staking neurons (all three tiers) echo the
            // platform outcome. Best-effort: they follow the leader on every
            // topic, so governance may report them as having already voted —
            // that is success, and a failure here must never change the
            // proposal's lifecycle.
            for tier in StakeTier::all() {
                let pool = tier_pool(tier);
                if let Some(pool_neuron_id) = pool.neuron_id {
                    if pool.bootstrap == StakingBootstrap::Ready {
                        if let Err(e) = cast_nns_vote(pool_neuron_id, nns_id, vote_choice).await {
                            canister_print(&format!(
                                "staking-pool neuron vote skipped for {}: {}", nns_id, e
                            ));
                        }
                    }
                }
            }
        }
        None => {
            canister_print(&format!("Proposal {} has no nns_proposal_id; skipping vote", pid));
        }
    }

    if vote_success {
        if met {
            proposal.status = "voted".to_string();
        } else {
            proposal.status = "abstained".to_string();
        }

        // Insert VoteRecord since the neuron voted
        let vote_rec = VoteRecord {
            proposal_id: pid,
            vote: if vote_choice == 1 { Vote::Yes } else { Vote::No },
            icp_burned_e8s: if met { proposal.total_committed_e8s } else { 0 },
            decided_at: current_time(),
            nns_outcome: Some(if vote_choice == 1 { "adopted".to_string() } else { "rejected".to_string() }),
        };
        VOTES.with(|map| {
            map.borrow_mut().insert(pid, vote_rec);
        });
    } else {
        proposal.status = "failed".to_string();
    }

    PROPOSALS.with(|map| {
        map.borrow_mut().insert(pid, proposal.clone());
    });

    settle_proposal_commitments(pid).await;

    Ok(())
}

async fn settle_proposal_commitments(proposal_id: u64) {
    let proposal = PROPOSALS.with(|map| map.borrow().get(&proposal_id));
    let mut proposal = match proposal {
        Some(p) => p,
        None => return,
    };

    let is_voted = proposal.status == "voted";
    let is_abstained = proposal.status == "abstained" || proposal.status == "failed";

    let mut commitments_to_settle = Vec::new();
    COMMITMENTS.with(|map| {
        for entry in map.borrow().iter() {
            let c = entry.value();
            if c.proposal_id == proposal_id && c.status == CommitmentStatus::Pending {
                commitments_to_settle.push(c.principal);
            }
        }
    });

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let now = current_time();

    let mut total_burned_this_sweep: u64 = 0;

    for user in commitments_to_settle {
        let key = CommitmentKey {
            proposal_id,
            principal: user,
        };
        let mut commitment = COMMITMENTS.with(|map| map.borrow().get(&key)).unwrap();

        if is_voted {
            // PB-125: split the proceeds — 50% treasury, 25% backend cycles,
            // 25% frontend cycles (idempotent across retries).
            match settle_burn_split(ledger_id, commitment.subaccount, commitment.amount_e8s, &mut commitment).await {
                Ok(()) => {
                    commitment.status = CommitmentStatus::Burned;
                    commitment.settled_at = Some(now);
                    // F-105: checked addition — clamp to u64::MAX on overflow
                    // rather than silently wrapping (release build traps under
                    // overflow-checks = true, so this is a defensive fallback).
                    total_burned_this_sweep = total_burned_this_sweep
                        .checked_add(commitment.amount_e8s)
                        .unwrap_or(u64::MAX);

                    let existing = USER_AGGREGATES.with(|map| map.borrow().get(&user));
                    if let Some(mut agg) = existing {
                        agg.total_committed_escrow = agg.total_committed_escrow.saturating_sub(commitment.amount_e8s);
                        agg.total_burned = agg.total_burned
                            .checked_add(commitment.amount_e8s)
                            .unwrap_or(agg.total_burned);
                        USER_AGGREGATES.with(|map| { map.borrow_mut().insert(user, agg); });
                    }

                    let log_entry = AuditLogEntry {
                        timestamp: now,
                        event_type: "burn".to_string(),
                        proposal_id,
                        user,
                        amount_e8s: commitment.amount_e8s,
                    };
                    AUDIT_LOG.with(|log| {
                        let _ = log.borrow_mut().append(&log_entry);
                    });

                    canister_print(&format!(
                        "Commitment settled (split 50/25/25): {} e8s for user {}",
                        commitment.amount_e8s, user
                    ));
                }
                Err(e) => {
                    commitment.status = CommitmentStatus::FailedBurn;
                    canister_print(&format!("settle_burn_split failed for user {}: {}", user, e));
                }
            }
        } else if is_abstained {
            let user_dest = LedgerAccount {
                owner: user,
                subaccount: None,
            };
            let transfer_res = call_ledger_transfer(
                ledger_id,
                Some(commitment.subaccount),
                user_dest,
                commitment.amount_e8s,
                Some(10_000),
            ).await;

            match transfer_res {
                Ok(_) => {
                    commitment.status = CommitmentStatus::Returned;
                    commitment.settled_at = Some(now);

                    let existing = USER_AGGREGATES.with(|map| map.borrow().get(&user));
                    if let Some(mut agg) = existing {
                        agg.total_committed_escrow = agg.total_committed_escrow.saturating_sub(commitment.amount_e8s);
                        USER_AGGREGATES.with(|map| { map.borrow_mut().insert(user, agg); });
                    }

                    let log_entry = AuditLogEntry {
                        timestamp: now,
                        event_type: "refund".to_string(),
                        proposal_id,
                        user,
                        amount_e8s: commitment.amount_e8s,
                    };
                    AUDIT_LOG.with(|log| {
                        let _ = log.borrow_mut().append(&log_entry);
                    });
                    record_payout(user, PayoutType::CommitmentRefund, IdeaToken::ICP, commitment.amount_e8s, proposal_id);
                }
                Err(e) => {
                    commitment.status = CommitmentStatus::FailedRefund;
                    canister_print(&format!("Failed to refund commitment for user {}: {}", user, e));
                }
            }
        }

        COMMITMENTS.with(|map| {
            map.borrow_mut().insert(key, commitment);
        });
    }

    if is_voted {
        proposal.status = "settled".to_string();
        proposal.total_burned_e8s = Some(total_burned_this_sweep);
    } else if is_abstained {
        proposal.status = "abstained".to_string();
    }

    PROPOSALS.with(|map| {
        map.borrow_mut().insert(proposal_id, proposal.clone());
    });

    if is_voted {
        let _ = distribute_pool_rewards(proposal_id).await;
    }
}

async fn proposal_sync_sweep() {
    let now = current_time();
    let mut proposals_to_process = Vec::new();

    PROPOSALS.with(|map| {
        for entry in map.borrow().iter() {
            let p = entry.value();
            if (p.status == "open" || p.status == "met") && now >= p.deadline.saturating_sub(3_600_000_000_000) {
                proposals_to_process.push(p.id);
            }
        }
    });

    for pid in proposals_to_process {
        let _lock = match ProposalLock::new(pid) {
            Ok(lock) => lock,
            Err(_) => continue,
        };

        let _ = process_proposal_cutoff(pid).await;
    }

    // Sweep any undistributed pool rewards
    let mut undistributed = Vec::new();
    PROPOSALS.with(|map| {
        for entry in map.borrow().iter() {
            let p = entry.value();
            if p.status == "settled" && !p.pool_distributed {
                undistributed.push(p.id);
            }
        }
    });

    for pid in undistributed {
        let _ = distribute_pool_rewards(pid).await;
    }
}

async fn retry_failed_settlements() {
    let mut to_retry = Vec::new();
    COMMITMENTS.with(|map| {
        for entry in map.borrow().iter() {
            let c = entry.value();
            if c.status == CommitmentStatus::FailedBurn || c.status == CommitmentStatus::FailedRefund {
                to_retry.push((c.proposal_id, c.principal));
            }
        }
    });

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let now = current_time();

    for (proposal_id, user) in to_retry {
        let key = CommitmentKey {
            proposal_id,
            principal: user,
        };
        let mut commitment = COMMITMENTS.with(|map| map.borrow().get(&key)).unwrap();

        if commitment.status == CommitmentStatus::FailedBurn {
            // Idempotent retry — completed split transfers are skipped (their
            // block indices are Some); only the unfinished step/notify re-runs.
            match settle_burn_split(ledger_id, commitment.subaccount, commitment.amount_e8s, &mut commitment).await {
                Ok(()) => {
                    commitment.status = CommitmentStatus::Burned;
                    commitment.settled_at = Some(now);
                    // Keep the proposal's burn total honest — the sweep path
                    // does this, but a retry-completed burn (142135) used to
                    // leave the card showing 0 ICP burned forever.
                    PROPOSALS.with(|map| {
                        let existing = map.borrow().get(&proposal_id);
                        if let Some(mut p) = existing {
                            p.total_burned_e8s = Some(
                                p.total_burned_e8s
                                    .unwrap_or(0)
                                    .saturating_add(commitment.amount_e8s),
                            );
                            map.borrow_mut().insert(proposal_id, p);
                        }
                    });
                    canister_print(&format!(
                        "retry_failed_settlements: burn completed for proposal {} user {}",
                        proposal_id, user
                    ));
                }
                Err(e) => {
                    // 142135 post-mortem: this path used to fail silently,
                    // making stuck sagas invisible in the canister logs.
                    canister_print(&format!(
                        "retry_failed_settlements: burn retry failed for proposal {} user {}: {}",
                        proposal_id, user, e
                    ));
                }
            }
        } else if commitment.status == CommitmentStatus::FailedRefund {
            // Refund path is naturally idempotent: the user's subaccount
            // balance is unchanged after a failed transfer, so a retry
            // simply performs the transfer again. The balance check in
            // commit() ensures we never refund more than was escrowed.
            let user_dest = LedgerAccount {
                owner: user,
                subaccount: None,
            };
            let transfer_res = call_ledger_transfer(
                ledger_id,
                Some(commitment.subaccount),
                user_dest,
                commitment.amount_e8s,
                Some(10_000),
            ).await;
            match transfer_res {
                Ok(_) => {
                    commitment.status = CommitmentStatus::Returned;
                    commitment.settled_at = Some(now);
                }
                Err(e) => {
                    canister_print(&format!(
                        "retry_failed_settlements: refund retry failed for proposal {} user {}: {}",
                        proposal_id, user, e
                    ));
                }
            }
        }

        COMMITMENTS.with(|map| {
            map.borrow_mut().insert(key, commitment);
        });
    }
}

async fn cycle_topup_check() {
    let cycles = canister_cycle_balance();
    if cycles < 5_000_000_000_000 {
        let config = CONFIG.with(|cell| cell.borrow().get().clone());
        let ledger_id = config.ledger_canister_id;

        let treasury_account = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(TREASURY_SUBACCOUNT),
        };

        let cmc_principal = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();

        // F-103: Phase A — transfer treasury → CMC. Skip if a previous attempt
        // already produced a block index (and so the funds are already at the
        // CMC); only Phase B needs to be re-attempted.
        let block_index = match LAST_TOPUP_BLOCK.with(|cell| *cell.borrow()) {
            Some(b) => b,
            None => {
                let balance_res = call_ledger_balance(ledger_id, treasury_account).await;
                let balance = match balance_res {
                    Ok(b) if b > 1_000_000_000 => b,
                    _ => return,
                };
                let transfer_res = call_cmc_topup_transfer(
                    ledger_id,
                    Some(TREASURY_SUBACCOUNT),
                    get_canister_id(),
                    balance - 10_000,
                    10_000,
                )
                .await;
                match transfer_res {
                    Ok(b) => {
                        LAST_TOPUP_BLOCK.with(|cell| *cell.borrow_mut() = Some(b));
                        b
                    }
                    Err(_) => return,
                }
            }
        };

        // Phase B: notify the CMC. Idempotent — the CMC memoizes the result
        // per block, so a re-notify of a processed block returns the original
        // Ok. Any other failure leaves the block index persisted so the next
        // timer tick retries Phase B only (no double transfer).
        match notify_cmc_topup(cmc_principal, get_canister_id(), block_index, true).await {
            Ok(()) => {
                // Success — clear the persisted block index so the next sweep
                // re-evaluates the treasury balance fresh.
                LAST_TOPUP_BLOCK.with(|cell| *cell.borrow_mut() = None);
            }
            Err(e) if e.starts_with("CMC_REFUNDED") => {
                // The CMC refused the block and returned the ICP to the
                // treasury subaccount — restart from Phase A next tick.
                LAST_TOPUP_BLOCK.with(|cell| *cell.borrow_mut() = None);
                canister_print(&format!("cycle_topup_check: CMC refunded block {}: {}", block_index, e));
            }
            Err(e) => {
                canister_print(&format!("cycle_topup_check: notify failed for block {}: {}", block_index, e));
            }
        }
    }
}

fn setup_timers() {
    ic_cdk_timers::set_timer_interval(std::time::Duration::from_secs(300), || async {
        // PB-117: refresh live NNS proposals on mainnet before settling.
        let is_local = CONFIG.with(|c| c.borrow().get().is_local);
        if !is_local {
            fetch_live_proposals().await;
        }
        fetch_leader_neuron_info().await;
        proposal_sync_sweep().await;
        retry_failed_settlements().await;
        retry_failed_upvotes().await;
        retry_failed_fundings().await;
        delete_expired_ideas();
        delete_expired_dapps();
        cycle_topup_check().await;
        staking_sweep().await;
        lottery_draw_check().await;
        early_adopter_settlement_check().await;
    });
}

/// Local-dev faucet — sends 100 ICP from the canister's own account to the caller.
/// Rejected on mainnet (ledger canister ID check). Never callable by anonymous.
#[ic_cdk::update]
async fn dev_faucet() -> Result<(), String> {
    require_authenticated()?;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());

    // Block on mainnet: ICP mainnet ledger canister ID
    if !config.is_local
        || config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
    {
        return Err("dev_faucet is only available on the local network".to_string());
    }

    let caller = get_caller();
    let dest = LedgerAccount { owner: caller, subaccount: None };
    let amount: u64 = 10_000_000_000; // 100 ICP

    call_ledger_transfer(config.ledger_canister_id, None, dest, amount, Some(10_000))
        .await
        .map(|_| ())
        .map_err(|e| format!("Faucet transfer failed: {}", e))
}

/// Local-dev: insert an Active pool neuron with an explicit voting power, so we
/// can seed mock pool members (with varied VP) for UI testing. Rejected on
/// mainnet (ledger canister ID check). Never callable by anonymous.
#[ic_cdk::update]
fn dev_seed_pool_neuron(neuron_id: u64, voting_power: u64) -> Result<(), String> {
    require_authenticated()?;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());

    if !config.is_local
        || config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
    {
        return Err("dev_seed_pool_neuron is only available on the local network".to_string());
    }

    let now = current_time();
    let pn = PoolNeuron {
        neuron_id,
        registered_by: get_caller(),
        voting_power,
        status: PoolStatus::Active,
        created_at: now,
        activated_at: Some(now),
        treasury_block: None,
        backend_cmc_block: None,
        frontend_cmc_block: None,
    };
    POOL_NEURONS.with(|map| {
        map.borrow_mut().insert(neuron_id, pn);
    });
    recompute_pool_info();
    Ok(())
}

#[ic_cdk::query]
fn list_vote_history() -> Vec<VoteRecord> {
    VOTES.with(|map| {
        map.borrow()
            .iter()
            .map(|entry| entry.value())
            .collect()
    })
}

/// App-wide totals: TVL (sum of `total_committed_e8s` over open/met proposals),
/// cumulative ICP burned (sum of `icp_burned_e8s` over all `VoteRecord`s), and
/// the count of distinct NNS proposals this app has cast a vote on.
///
/// Pure read over in-memory maps — `O(n)` over proposals + votes. Safe for any
/// reasonable n; documented in the task.
#[ic_cdk::query]
fn get_global_stats() -> GlobalStats {
    let mut tvl_e8s: u64 = 0;
    let mut pending_burn_e8s: u64 = 0;
    PROPOSALS.with(|map| {
        for entry in map.borrow().iter() {
            let p = entry.value();
            // TVL counts only escrow that is *currently locked* — once a
            // proposal is settled/abstained/voted/failed, the funds have
            // either been burned or refunded and are no longer locked.
            if p.status == "open" || p.status == "met" {
                // F-105: clamp on overflow rather than silently wrapping.
                tvl_e8s = tvl_e8s
                    .checked_add(p.total_committed_e8s)
                    .unwrap_or(u64::MAX);
            }
            // Pending burn: ICP committed to proposals that met the threshold
            // but haven't been settled yet (vote pending at deadline cutoff).
            if p.status == "met" {
                pending_burn_e8s = pending_burn_e8s
                    .checked_add(p.total_committed_e8s)
                    .unwrap_or(u64::MAX);
            }
        }
    });

    let mut total_burned_e8s: u64 = 0;
    let mut votes_cast: u64 = 0;
    VOTES.with(|map| {
        for entry in map.borrow().iter() {
            let v = entry.value();
            total_burned_e8s = total_burned_e8s
                .checked_add(v.icp_burned_e8s)
                .unwrap_or(u64::MAX);
            votes_cast = votes_cast
                .checked_add(1)
                .unwrap_or(u64::MAX);
        }
    });

    let mut followers_count: u64 = 0;
    USER_NEURONS.with(|map| {
        for entry in map.borrow().iter() {
            let u = entry.value();
            if u.is_following {
                followers_count = followers_count.checked_add(1).unwrap_or(u64::MAX);
            }
        }
    });

    GlobalStats {
        tvl_e8s,
        total_burned_e8s,
        pending_burn_e8s,
        votes_cast,
        followers_count,
    }
}

/// Returns a page of audit log entries. offset + limit are capped at 10,000
/// to prevent a single query from exhausting cycle budgets.
#[ic_cdk::query]
fn get_audit_log(offset: u64, limit: u64) -> Vec<AuditLogEntry> {
    let limit = limit.min(1000) as usize;
    AUDIT_LOG.with(|log| {
        let borrowed = log.borrow();
        let len = borrowed.len();
        if offset >= len || limit == 0 {
            return vec![];
        }
        let end = (offset as usize + limit).min(len as usize);
        (offset as usize..end)
            .filter_map(|i| borrowed.get(i as u64))
            .collect()
    })
}

// ==========================================
// 12. Feature Flags & Idea Board
// ==========================================

/// Feature-flag key for the Idea Board. Flags default via `feature_default`;
/// an admin override in FEATURE_FLAGS (1 = on, 0 = off) wins over the default.
pub const FLAG_IDEA_BOARD: &str = "idea_board";
/// Kill switch for lossless staking + voting (stake/unstake/cast_lossless_vote).
pub const FLAG_LOSSLESS_VOTING: &str = "lossless_voting";
/// Lossless lottery (Powerball-style draws over the staking-yield lottery
/// pot). Ships dark — default OFF until an admin flips it on.
pub const FLAG_LOSSLESS_LOTTERY: &str = "lossless_lottery";
pub const FLAG_EXPLORER: &str = "dapp_explorer";
pub const FLAG_ARCADE: &str = "arcade";
pub const FLAG_EARLY_ADOPTERS: &str = "early_adopters";
const KNOWN_FEATURE_FLAGS: [&str; 6] =
    [FLAG_IDEA_BOARD, FLAG_LOSSLESS_VOTING, FLAG_LOSSLESS_LOTTERY, FLAG_EXPLORER, FLAG_ARCADE, FLAG_EARLY_ADOPTERS];

const MAX_FEATURE_FLAGS: u64 = 64;
const MAX_FLAG_KEY_LEN: usize = 64;

const MAX_IDEAS: u64 = 500;
const MAX_ACTIVE_IDEAS_PER_USER: usize = 10;
const MAX_IDEA_TITLE_LEN: usize = 80;
const MAX_IDEA_DESCRIPTION_LEN: usize = 280;
const MAX_IDEA_DETAIL_LEN: usize = 4000;
/// An idea expires after 30 days without a single upvote (measured from the
/// later of `created_at` / last upvote).
const IDEA_EXPIRY_NANOS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
/// Upper bound on a single upvote, in the token's smallest unit. u64::MAX / 4
/// keeps the 75% split (`amount * 3 / 4`) overflow-free by construction.
const MAX_UPVOTE_UNITS: u64 = u64::MAX / 4;
/// Posting an idea costs 1 ICP (anti-spam; 100% to the treasury).
const IDEA_POST_FEE_E8S: u64 = 100_000_000;
/// Subaccount seed for the posting-fee escrow — far above any real idea id.
const IDEA_POST_SEED: u64 = u64::MAX;
const MAX_PROJECTS: u64 = 200;

const MAINNET_CKBTC_LEDGER: &str = "mxzaz-hqaaa-aaaar-qaada-cai";
const MAINNET_CKETH_LEDGER: &str = "ss2fx-dyaaa-aaaar-qacoq-cai";

/// Value-aligned default minimum upvotes — each ≈ $1 at approximate
/// June-2026 exchange rates (ICP ≈ $5, BTC ≈ $100k, ETH ≈ $3k). Admins
/// retune at runtime via `admin_set_min_upvote` as rates drift.
const DEFAULT_MIN_UPVOTE_ICP_E8S: u64 = 20_000_000;            // 0.2 ICP
const DEFAULT_MIN_UPVOTE_CKBTC_SATS: u64 = 1_000;              // 0.00001 ckBTC
const DEFAULT_MIN_UPVOTE_CKETH_WEI: u64 = 330_000_000_000_000; // 0.00033 ckETH

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdeaToken {
    ICP,
    CkBTC,
    CkETH,
}

/// An idea is implicitly Active while stored; the sweep DELETES ideas whose
/// 30-day no-upvote window has lapsed (no Expired state is kept around).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Idea {
    pub id: u64,
    pub poster: Principal,
    pub title: String,
    pub description: String,
    pub detail: String,
    pub created_at: u64,
    /// Timestamp of the most recent upvote; equals `created_at` until the
    /// first upvote. Drives the 30-day expiry window.
    pub last_upvote_at: u64,
    pub upvote_count: u64,
    /// Detail-view opens by signed-in users (drives "most viewed" sorting).
    #[serde(default)]
    pub views: u64,
    pub total_icp_e8s: u64,
    pub total_ckbtc_e8s: u64,
    pub total_cketh_wei: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum UpvoteStatus {
    Settled,
    FailedPayout,
}

/// Saga journal for one upvote payout (75% treasury / 25% poster). Block
/// indices are set per completed transfer so a retry skips finished steps —
/// same idempotency pattern as `settle_burn_split` / pool registration.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct IdeaUpvote {
    pub id: u64,
    pub idea_id: u64,
    pub voter: Principal,
    pub token: IdeaToken,
    pub amount: u64,
    pub status: UpvoteStatus,
    pub created_at: u64,
    pub treasury_block: Option<u64>,
    pub poster_block: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct FeatureFlag {
    pub key: String,
    pub enabled: bool,
}

/// Admin-curated, fundable project (Community R&D "Projects" tab). Funding
fn default_true() -> bool {
    true
}

/// goes 100% to the protocol treasury, which pays for the project's
/// execution. Per-token goals of 0 mean "not seeking that token".
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub detail: String,
    pub created_at: u64,
    pub goal_icp_e8s: u64,
    pub goal_ckbtc_e8s: u64,
    pub goal_cketh_wei: u64,
    pub raised_icp_e8s: u64,
    pub raised_ckbtc_e8s: u64,
    pub raised_cketh_wei: u64,
    pub funding_count: u64,
    #[serde(default = "default_true")]
    pub accept_icp: bool,
    #[serde(default = "default_true")]
    pub accept_ckbtc: bool,
    #[serde(default = "default_true")]
    pub accept_cketh: bool,
}

/// Saga journal for one project funding (single transfer → treasury), same
/// idempotency pattern as IdeaUpvote.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ProjectFunding {
    pub id: u64,
    pub project_id: u64,
    pub funder: Principal,
    pub token: IdeaToken,
    pub amount: u64,
    pub status: UpvoteStatus,
    pub created_at: u64,
    pub treasury_block: Option<u64>,
}

/// Everything the Idea Board UI needs in one query: the flag, per-token
/// ledger canister ids, per-token minimum upvotes (value-aligned across
/// tokens via exchange rates) and ledger fees, in smallest units.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct IdeaBoardInfo {
    pub enabled: bool,
    pub icp_ledger: Principal,
    pub ckbtc_ledger: Principal,
    pub cketh_ledger: Principal,
    pub min_upvote_icp_e8s: u64,
    pub min_upvote_ckbtc_e8s: u64,
    pub min_upvote_cketh_wei: u64,
    pub fee_icp_e8s: u64,
    pub fee_ckbtc_sats: u64,
    pub fee_cketh_wei: u64,
    pub expiry_nanos: u64,
    /// Flat fee (ICP e8s) to post an idea; 100% to the treasury.
    pub post_fee_e8s: u64,
}

impl_storable!(Idea);
impl_storable!(IdeaUpvote);
impl_storable!(Project);
impl_storable!(ProjectFunding);

thread_local! {
    static IDEAS: RefCell<StableBTreeMap<u64, Idea, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(9))))
    });

    static NEXT_IDEA_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(10)), 1u64))
    });

    static IDEA_UPVOTES: RefCell<StableBTreeMap<u64, IdeaUpvote, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(11))))
    });

    static NEXT_UPVOTE_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(12)), 1u64))
    });

    // Admin feature-flag overrides: 1 = enabled, 0 = disabled. A key absent
    // here falls back to `feature_default`.
    static FEATURE_FLAGS: RefCell<StableBTreeMap<String, u8, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(13))))
    });

    static PROJECTS: RefCell<StableBTreeMap<u64, Project, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(14))))
    });

    static NEXT_PROJECT_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(15)), 1u64))
    });

    static PROJECT_FUNDINGS: RefCell<StableBTreeMap<u64, ProjectFunding, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(16))))
    });

    static NEXT_FUNDING_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(17)), 1u64))
    });

    static IDEA_VIEWS: RefCell<StableBTreeMap<IdeaViewKey, (), Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(18))))
    });
}

fn feature_default(key: &str) -> bool {
    match key {
        FLAG_IDEA_BOARD => true,
        FLAG_LOSSLESS_VOTING => true,
        // Money-moving and unproven on mainnet — ships dark until an admin
        // enables it (see docs/OPS.md § "Lossless Lottery").
        FLAG_LOSSLESS_LOTTERY => false,
        FLAG_EXPLORER => true,
        // Ships dark like the lottery — flips on locally via deploy-local.sh,
        // on mainnet via the admin flag panel after a playtest.
        FLAG_ARCADE => false,
        // Irreversible money-moving — ships dark until the owner enables it.
        FLAG_EARLY_ADOPTERS => false,
        _ => false,
    }
}

fn feature_enabled(key: &str) -> bool {
    FEATURE_FLAGS
        .with(|m| m.borrow().get(&key.to_string()))
        .map(|v| v == 1)
        .unwrap_or_else(|| feature_default(key))
}

fn require_idea_board_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_IDEA_BOARD) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

fn valid_flag_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_FLAG_KEY_LEN
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// All flags the canister knows about (known defaults merged with any extra
/// admin-created keys). Public so anonymous viewers can hide gated UI.
#[ic_cdk::query]
fn list_feature_flags() -> Vec<FeatureFlag> {
    let mut flags: Vec<FeatureFlag> = KNOWN_FEATURE_FLAGS
        .iter()
        .map(|k| FeatureFlag { key: k.to_string(), enabled: feature_enabled(k) })
        .collect();
    FEATURE_FLAGS.with(|m| {
        for entry in m.borrow().iter() {
            let key = entry.key().clone();
            if !KNOWN_FEATURE_FLAGS.contains(&key.as_str()) {
                let enabled = entry.value() == 1;
                flags.push(FeatureFlag { key, enabled });
            }
        }
    });
    flags
}

/// Admin: enable/disable a feature completely. Unknown keys are allowed (a
/// kill-switch can be staged before the feature ships) but validated and
/// capped so the map can't be spammed.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_feature_flag(key: String, enabled: bool) -> Result<(), String> {
    let key = key.trim().to_string();
    if !valid_flag_key(&key) {
        return Err("INVALID_FLAG_KEY".to_string());
    }
    FEATURE_FLAGS.with(|m| {
        let mut m = m.borrow_mut();
        if m.get(&key).is_none() && m.len() >= MAX_FEATURE_FLAGS {
            return Err("TOO_MANY_FLAGS".to_string());
        }
        m.insert(key, if enabled { 1 } else { 0 });
        Ok(())
    })
}

/// Per-token ledger. Mainnet is hard-pinned to the canonical ckBTC/ckETH
/// ledgers (overrides ignored — F-101 posture). Locally, ckBTC/ckETH resolve
/// to the admin-configured local test ledgers, falling back to the ICP test
/// ledger when none is configured yet.
fn token_ledger(token: IdeaToken, config: &Config) -> Principal {
    match token {
        IdeaToken::ICP => config.ledger_canister_id,
        IdeaToken::CkBTC => {
            if config.is_local {
                config.ckbtc_ledger_canister_id.unwrap_or(config.ledger_canister_id)
            } else {
                Principal::from_text(MAINNET_CKBTC_LEDGER).unwrap()
            }
        }
        IdeaToken::CkETH => {
            if config.is_local {
                config.cketh_ledger_canister_id.unwrap_or(config.ledger_canister_id)
            } else {
                Principal::from_text(MAINNET_CKETH_LEDGER).unwrap()
            }
        }
    }
}

/// Ledger transfer fee in the token's smallest unit. The fee follows the
/// resolved ledger: a local ckBTC/ckETH that falls back to the ICP test
/// ledger pays that ledger's 10_000 fee; a dedicated local token ledger is
/// deployed with the canonical fee, so the canonical value applies there too.
fn token_fee(token: IdeaToken, config: &Config) -> u64 {
    match token {
        IdeaToken::ICP => 10_000, // 0.0001 ICP
        IdeaToken::CkBTC => {
            if config.is_local && config.ckbtc_ledger_canister_id.is_none() {
                10_000
            } else {
                10 // 10 satoshi
            }
        }
        IdeaToken::CkETH => {
            if config.is_local && config.cketh_ledger_canister_id.is_none() {
                10_000
            } else {
                2_000_000_000_000 // 0.000002 ckETH
            }
        }
    }
}

/// Minimum upvote per token: admin override, else the value-aligned default
/// (~$1 equivalent per token — see DEFAULT_MIN_UPVOTE_* rates).
fn token_min_upvote(token: IdeaToken, config: &Config) -> u64 {
    match token {
        IdeaToken::ICP => config.min_upvote_icp_e8s.unwrap_or(DEFAULT_MIN_UPVOTE_ICP_E8S),
        IdeaToken::CkBTC => config.min_upvote_ckbtc_e8s.unwrap_or(DEFAULT_MIN_UPVOTE_CKBTC_SATS),
        IdeaToken::CkETH => config.min_upvote_cketh_wei.unwrap_or(DEFAULT_MIN_UPVOTE_CKETH_WEI),
    }
}

/// Admin: point ckBTC/ckETH at locally deployed test ledgers. Local-only —
/// mainnet token ledgers are hard-pinned to the canonical canisters.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_token_ledger(token: IdeaToken, ledger: Principal) -> Result<(), String> {
    if ledger == Principal::anonymous() {
        return Err("INVALID_LEDGER".to_string());
    }
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        if !cfg.is_local {
            return Err("MAINNET_LEDGERS_PINNED".to_string());
        }
        match token {
            IdeaToken::ICP => return Err("ICP_LEDGER_FIXED".to_string()),
            IdeaToken::CkBTC => cfg.ckbtc_ledger_canister_id = Some(ledger),
            IdeaToken::CkETH => cfg.cketh_ledger_canister_id = Some(ledger),
        }
        cell.borrow_mut().set(cfg);
        Ok(())
    })
}

/// Admin: retune a token's minimum upvote (smallest units) as exchange
/// rates move, keeping minimums roughly value-aligned across tokens.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_min_upvote(token: IdeaToken, min: u64) -> Result<(), String> {
    if min == 0 || min > MAX_UPVOTE_UNITS {
        return Err("INVALID_MINIMUM".to_string());
    }
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        match token {
            IdeaToken::ICP => cfg.min_upvote_icp_e8s = Some(min),
            IdeaToken::CkBTC => cfg.min_upvote_ckbtc_e8s = Some(min),
            IdeaToken::CkETH => cfg.min_upvote_cketh_wei = Some(min),
        }
        cell.borrow_mut().set(cfg);
        Ok(())
    })
}

/// Admin: remove an idea from the board at any time. Settled upvotes stay in the
/// treasury/poster; any in-flight upvote saga refunds via the orphan path.
#[ic_cdk::update(guard = "require_admin")]
fn admin_remove_idea(idea_id: u64) -> Result<(), String> {
    IDEAS.with(|m| {
        if m.borrow_mut().remove(&idea_id).is_none() {
            return Err("IDEA_NOT_FOUND".to_string());
        }
        Ok(())
    })
}

/// 75% → treasury, 25% (plus rounding remainder) → idea poster.
fn split_upvote(amount: u64) -> (u64, u64) {
    let treasury = amount / 4 * 3;
    let poster = amount - treasury;
    (treasury, poster)
}

fn idea_is_expired(last_upvote_at: u64, now: u64) -> bool {
    now > last_upvote_at.saturating_add(IDEA_EXPIRY_NANOS)
}

/// Principal- and idea-bound deposit subaccount for upvote escrow. Domain-
/// separated from the proposal escrow (`proof_of_burn_escrow_v1`).
fn derive_idea_subaccount(user: &Principal, idea_id: u64) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_idea_v1");
    hasher.update(user.as_slice());
    hasher.update(&idea_id.to_be_bytes());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

fn validate_idea_text(title: &str, description: &str, detail: &str) -> Result<(), String> {
    if title.is_empty() || title.chars().count() > MAX_IDEA_TITLE_LEN {
        return Err("INVALID_TITLE".to_string());
    }
    if description.is_empty() || description.chars().count() > MAX_IDEA_DESCRIPTION_LEN {
        return Err("INVALID_DESCRIPTION".to_string());
    }
    if detail.chars().count() > MAX_IDEA_DETAIL_LEN {
        return Err("INVALID_DETAIL".to_string());
    }
    Ok(())
}

#[ic_cdk::query]
fn get_idea_board_info() -> IdeaBoardInfo {
    let config = CONFIG.with(|c| c.borrow().get().clone());
    IdeaBoardInfo {
        enabled: feature_enabled(FLAG_IDEA_BOARD),
        icp_ledger: token_ledger(IdeaToken::ICP, &config),
        ckbtc_ledger: token_ledger(IdeaToken::CkBTC, &config),
        cketh_ledger: token_ledger(IdeaToken::CkETH, &config),
        min_upvote_icp_e8s: token_min_upvote(IdeaToken::ICP, &config),
        min_upvote_ckbtc_e8s: token_min_upvote(IdeaToken::CkBTC, &config),
        min_upvote_cketh_wei: token_min_upvote(IdeaToken::CkETH, &config),
        fee_icp_e8s: token_fee(IdeaToken::ICP, &config),
        fee_ckbtc_sats: token_fee(IdeaToken::CkBTC, &config),
        fee_cketh_wei: token_fee(IdeaToken::CkETH, &config),
        expiry_nanos: IDEA_EXPIRY_NANOS,
        post_fee_e8s: IDEA_POST_FEE_E8S,
    }
}

/// All live ideas, newest first. Time-expired ideas are omitted even before
/// the sweep deletes them, so the UI never shows a dead idea.
#[ic_cdk::query]
fn list_ideas() -> Vec<Idea> {
    let now = current_time();
    let mut ideas: Vec<Idea> = IDEAS.with(|m| {
        m.borrow()
            .iter()
            .map(|entry| entry.value())
            .filter(|idea| !idea_is_expired(idea.last_upvote_at, now))
            .collect()
    });
    ideas.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    ideas
}

/// Count a detail-view open (signed-in users only — anonymous ingress is
/// already rejected by inspect_message). Drives "most viewed" sorting.
#[ic_cdk::update]
fn record_idea_view(idea_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_idea_board_enabled()?;
    let caller = get_caller();
    let key = IdeaViewKey { idea_id, user: caller };

    let already_viewed = IDEA_VIEWS.with(|m| m.borrow().contains_key(&key));
    if already_viewed {
        return Ok(());
    }

    // Insert key before checking idea existence, but we should make sure the idea exists
    let idea_exists = IDEAS.with(|m| m.borrow().contains_key(&idea_id));
    if !idea_exists {
        return Err("IDEA_NOT_FOUND".to_string());
    }

    IDEA_VIEWS.with(|m| m.borrow_mut().insert(key, ()));

    IDEAS.with(|m| {
        let mut m = m.borrow_mut();
        match m.get(&idea_id) {
            Some(mut idea) => {
                idea.views = idea.views.saturating_add(1);
                m.insert(idea_id, idea);
                Ok(())
            }
            None => Err("IDEA_NOT_FOUND".to_string()),
        }
    })
}

/// The caller's deposit account for the 1 ICP idea-posting fee. Fund it with
/// `post_fee + 0.0001 ICP` on the ICP ledger, then call `post_idea`.
#[ic_cdk::query]
fn get_idea_post_deposit_address() -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_idea_subaccount(&caller, IDEA_POST_SEED)),
    }
}

#[ic_cdk::update]
async fn post_idea(title: String, description: String, detail: String) -> Result<u64, String> {
    require_authenticated()?;
    require_idea_board_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let title = title.trim().to_string();
    let description = description.trim().to_string();
    let detail = detail.trim().to_string();
    validate_idea_text(&title, &description, &detail)?;

    let now = current_time();
    let quota_err = IDEAS.with(|m| {
        let m = m.borrow();
        if m.len() >= MAX_IDEAS {
            return Some("IDEA_QUOTA_REACHED");
        }
        let active_by_caller = m
            .iter()
            .filter(|e| {
                let i = e.value();
                i.poster == caller && !idea_is_expired(i.last_upvote_at, now)
            })
            .count();
        if active_by_caller >= MAX_ACTIVE_IDEAS_PER_USER {
            return Some("TOO_MANY_ACTIVE_IDEAS");
        }
        None
    });
    if let Some(e) = quota_err {
        return Err(e.to_string());
    }

    // 1 ICP posting fee → treasury (anti-spam). Charged before the idea is
    // created; if the fee transfer fails nothing is stored.
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let sub = derive_idea_subaccount(&caller, IDEA_POST_SEED);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    if balance < IDEA_POST_FEE_E8S + 10_000 {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }
    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    call_ledger_transfer(ledger_id, Some(sub), treasury_dest, IDEA_POST_FEE_E8S, Some(10_000))
        .await
        .map_err(|e| format!("FEE_TRANSFER_FAILED: {}", e))?;

    let id = NEXT_IDEA_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });

    let idea = Idea {
        id,
        poster: caller,
        title,
        description,
        detail,
        created_at: now,
        last_upvote_at: now,
        upvote_count: 0,
        views: 0,
        total_icp_e8s: 0,
        total_ckbtc_e8s: 0,
        total_cketh_wei: 0,
    };
    IDEAS.with(|m| {
        m.borrow_mut().insert(id, idea);
    });

    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "idea_post".to_string(),
        proposal_id: id,
        user: caller,
        amount_e8s: IDEA_POST_FEE_E8S,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(id)
}

/// The caller's deposit account for upvoting `idea_id`. The same subaccount
/// is used on every token's ledger — fund it on the ledger of the token you
/// intend to upvote with, then call `upvote_idea`.
#[ic_cdk::query]
fn get_idea_deposit_address(idea_id: u64) -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_idea_subaccount(&caller, idea_id)),
    }
}

/// Run (or resume) the two-step payout for an upvote. Each completed transfer
/// persists its block index so a retry never double-sends.
async fn run_upvote_payout(
    ledger_id: Principal,
    from_sub: [u8; 32],
    poster: Principal,
    fee: u64,
    uv: &mut IdeaUpvote,
) -> Result<(), String> {
    let (treasury_amt, poster_amt) = split_upvote(uv.amount);

    if uv.treasury_block.is_none() {
        let dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(TREASURY_SUBACCOUNT),
        };
        let b = call_ledger_transfer(ledger_id, Some(from_sub), dest, treasury_amt, Some(fee))
            .await
            .map_err(|e| format!("TREASURY_XFER: {}", e))?;
        uv.treasury_block = Some(b);
        IDEA_UPVOTES.with(|m| {
            m.borrow_mut().insert(uv.id, uv.clone());
        });
    }

    if uv.poster_block.is_none() {
        let dest = LedgerAccount { owner: poster, subaccount: None };
        let b = call_ledger_transfer(ledger_id, Some(from_sub), dest, poster_amt, Some(fee))
            .await
            .map_err(|e| format!("POSTER_XFER: {}", e))?;
        uv.poster_block = Some(b);
        IDEA_UPVOTES.with(|m| {
            m.borrow_mut().insert(uv.id, uv.clone());
        });
        record_payout(poster, PayoutType::IdeaUpvoteShare, uv.token, poster_amt, uv.id);
    }

    Ok(())
}

/// Apply a settled upvote to its idea: bump totals and reset the 30-day
/// expiry clock. Called exactly once per upvote (at settle).
fn apply_upvote_to_idea(uv: &IdeaUpvote, now: u64) {
    IDEAS.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(mut idea) = m.get(&uv.idea_id) {
            idea.upvote_count = idea.upvote_count.saturating_add(1);
            idea.last_upvote_at = now;
            match uv.token {
                IdeaToken::ICP => {
                    idea.total_icp_e8s = idea.total_icp_e8s.saturating_add(uv.amount)
                }
                IdeaToken::CkBTC => {
                    idea.total_ckbtc_e8s = idea.total_ckbtc_e8s.saturating_add(uv.amount)
                }
                IdeaToken::CkETH => {
                    idea.total_cketh_wei = idea.total_cketh_wei.saturating_add(uv.amount)
                }
            }
            m.insert(uv.idea_id, idea);
        }
    });
}

/// Upvote an idea with deposited funds. 75% of the amount goes to the
/// protocol treasury, 25% to the idea poster's wallet. The caller must first
/// transfer `amount + 2×fee` to their `get_idea_deposit_address` subaccount
/// on the chosen token's ledger.
#[ic_cdk::update]
async fn upvote_idea(idea_id: u64, token: IdeaToken, amount: u64) -> Result<(), String> {
    require_authenticated()?;
    require_idea_board_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let fee = token_fee(token, &config);
    if amount < token_min_upvote(token, &config) {
        return Err("BELOW_MINIMUM".to_string());
    }
    if amount > MAX_UPVOTE_UNITS {
        return Err("EXCEEDS_GLOBAL_CAP".to_string());
    }

    let idea = IDEAS
        .with(|m| m.borrow().get(&idea_id))
        .ok_or_else(|| "IDEA_NOT_FOUND".to_string())?;
    let now = current_time();
    if idea_is_expired(idea.last_upvote_at, now) {
        return Err("IDEA_EXPIRED".to_string());
    }

    let ledger_id = token_ledger(token, &config);
    let sub = derive_idea_subaccount(&caller, idea_id);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    let required = amount
        .checked_add(fee.checked_mul(2).ok_or("OVERFLOW")?)
        .ok_or("OVERFLOW")?;
    if balance < required {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // Journal the upvote BEFORE moving funds so a mid-saga failure is
    // visible and retryable from the sweep timer.
    let upvote_id = NEXT_UPVOTE_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let mut uv = IdeaUpvote {
        id: upvote_id,
        idea_id,
        voter: caller,
        token,
        amount,
        status: UpvoteStatus::FailedPayout,
        created_at: now,
        treasury_block: None,
        poster_block: None,
    };
    IDEA_UPVOTES.with(|m| {
        m.borrow_mut().insert(upvote_id, uv.clone());
    });

    run_upvote_payout(ledger_id, sub, idea.poster, fee, &mut uv).await?;

    uv.status = UpvoteStatus::Settled;
    IDEA_UPVOTES.with(|m| {
        m.borrow_mut().insert(upvote_id, uv.clone());
    });
    apply_upvote_to_idea(&uv, now);

    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "idea_upvote".to_string(),
        proposal_id: idea_id,
        user: caller,
        amount_e8s: amount,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

/// Sweep: resume upvote payouts that failed mid-saga. Completed steps are
/// skipped via their persisted block indices.
async fn retry_failed_upvotes() {
    let to_retry: Vec<u64> = IDEA_UPVOTES.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| e.value().status == UpvoteStatus::FailedPayout)
            .map(|e| *e.key())
            .collect()
    });
    if to_retry.is_empty() {
        return;
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let now = current_time();

    for id in to_retry {
        let mut uv = match IDEA_UPVOTES.with(|m| m.borrow().get(&id)) {
            Some(uv) => uv,
            None => continue,
        };
        let ledger_id = token_ledger(uv.token, &config);
        let fee = token_fee(uv.token, &config);
        let sub = derive_idea_subaccount(&uv.voter, uv.idea_id);

        let poster = match IDEAS.with(|m| m.borrow().get(&uv.idea_id)).map(|i| i.poster) {
            Some(p) => p,
            None => {
                // The idea was deleted (expired) before this payout settled.
                // Return whatever is recoverable from the voter's escrow and
                // close the journal entry so it stops retrying.
                let escrow = LedgerAccount {
                    owner: get_canister_id(),
                    subaccount: Some(sub),
                };
                let bal = match call_ledger_balance(ledger_id, escrow).await {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if bal > fee {
                    let dest = LedgerAccount { owner: uv.voter, subaccount: None };
                    if call_ledger_transfer(ledger_id, Some(sub), dest, bal - fee, Some(fee)).await.is_err() {
                        continue;
                    }
                    let log_entry = AuditLogEntry {
                        timestamp: now,
                        event_type: "idea_upvote_refund".to_string(),
                        proposal_id: uv.idea_id,
                        user: uv.voter,
                        amount_e8s: bal - fee,
                    };
                    AUDIT_LOG.with(|log| {
                        let _ = log.borrow_mut().append(&log_entry);
                    });
                }
                uv.status = UpvoteStatus::Settled;
                IDEA_UPVOTES.with(|m| {
                    m.borrow_mut().insert(id, uv);
                });
                continue;
            }
        };

        if run_upvote_payout(ledger_id, sub, poster, fee, &mut uv).await.is_ok() {
            uv.status = UpvoteStatus::Settled;
            IDEA_UPVOTES.with(|m| {
                m.borrow_mut().insert(id, uv.clone());
            });
            apply_upvote_to_idea(&uv, now);
        } else {
            IDEA_UPVOTES.with(|m| {
                m.borrow_mut().insert(id, uv);
            });
        }
    }
}

// ── Projects (Community R&D, admin-curated) ──

fn derive_project_subaccount(user: &Principal, project_id: u64) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_project_v1");
    hasher.update(user.as_slice());
    hasher.update(&project_id.to_be_bytes());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

/// Admin: add a fundable project. At least one per-token goal must be set.
#[ic_cdk::update(guard = "require_admin")]
fn admin_add_project(
    title: String,
    description: String,
    detail: String,
    goal_icp_e8s: u64,
    goal_ckbtc_e8s: u64,
    goal_cketh_wei: u64,
    accept_icp: bool,
    accept_ckbtc: bool,
    accept_cketh: bool,
) -> Result<u64, String> {
    let title = title.trim().to_string();
    let description = description.trim().to_string();
    let detail = detail.trim().to_string();
    validate_idea_text(&title, &description, &detail)?;
    if goal_icp_e8s == 0 && goal_ckbtc_e8s == 0 && goal_cketh_wei == 0 {
        return Err("NO_GOAL_SET".to_string());
    }
    if !accept_icp && !accept_ckbtc && !accept_cketh {
        return Err("NO_CRYPTO_ACCEPTED".to_string());
    }
    if PROJECTS.with(|m| m.borrow().len()) >= MAX_PROJECTS {
        return Err("PROJECT_QUOTA_REACHED".to_string());
    }

    let id = NEXT_PROJECT_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let now = current_time();
    PROJECTS.with(|m| {
        m.borrow_mut().insert(id, Project {
            id,
            title,
            description,
            detail,
            created_at: now,
            goal_icp_e8s,
            goal_ckbtc_e8s,
            goal_cketh_wei,
            raised_icp_e8s: 0,
            raised_ckbtc_e8s: 0,
            raised_cketh_wei: 0,
            funding_count: 0,
            accept_icp,
            accept_ckbtc,
            accept_cketh,
        });
    });
    Ok(id)
}

/// Admin: update a project's details, funding goals, and cryptocurrency toggles.
#[ic_cdk::update(guard = "require_admin")]
fn admin_update_project(
    id: u64,
    title: String,
    description: String,
    detail: String,
    goal_icp_e8s: u64,
    goal_ckbtc_e8s: u64,
    goal_cketh_wei: u64,
    accept_icp: bool,
    accept_ckbtc: bool,
    accept_cketh: bool,
) -> Result<(), String> {
    let title = title.trim().to_string();
    let description = description.trim().to_string();
    let detail = detail.trim().to_string();
    validate_idea_text(&title, &description, &detail)?;
    if goal_icp_e8s == 0 && goal_ckbtc_e8s == 0 && goal_cketh_wei == 0 {
        return Err("NO_GOAL_SET".to_string());
    }
    if !accept_icp && !accept_ckbtc && !accept_cketh {
        return Err("NO_CRYPTO_ACCEPTED".to_string());
    }
    PROJECTS.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(mut project) = m.get(&id) {
            project.title = title;
            project.description = description;
            project.detail = detail;
            project.goal_icp_e8s = goal_icp_e8s;
            project.goal_ckbtc_e8s = goal_ckbtc_e8s;
            project.goal_cketh_wei = goal_cketh_wei;
            project.accept_icp = accept_icp;
            project.accept_ckbtc = accept_ckbtc;
            project.accept_cketh = accept_cketh;
            m.insert(id, project);
            Ok(())
        } else {
            Err("PROJECT_NOT_FOUND".to_string())
        }
    })
}

/// Admin: remove a project from the board. Settled funding stays in the
/// treasury; any in-flight funding saga refunds via the orphan path.
#[ic_cdk::update(guard = "require_admin")]
fn admin_remove_project(project_id: u64) -> Result<(), String> {
    PROJECTS.with(|m| {
        if m.borrow_mut().remove(&project_id).is_none() {
            return Err("PROJECT_NOT_FOUND".to_string());
        }
        Ok(())
    })
}

/// All projects, newest first.
#[ic_cdk::query]
fn list_projects() -> Vec<Project> {
    let mut projects: Vec<Project> = PROJECTS.with(|m| {
        m.borrow().iter().map(|entry| entry.value()).collect()
    });
    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    projects
}

/// The caller's deposit account for funding `project_id`. Fund it on the
/// chosen token's ledger with `amount + fee`, then call `fund_project`.
#[ic_cdk::query]
fn get_project_deposit_address(project_id: u64) -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_project_subaccount(&caller, project_id)),
    }
}

fn apply_funding_to_project(f: &ProjectFunding) {
    PROJECTS.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(mut project) = m.get(&f.project_id) {
            project.funding_count = project.funding_count.saturating_add(1);
            match f.token {
                IdeaToken::ICP => {
                    project.raised_icp_e8s = project.raised_icp_e8s.saturating_add(f.amount)
                }
                IdeaToken::CkBTC => {
                    project.raised_ckbtc_e8s = project.raised_ckbtc_e8s.saturating_add(f.amount)
                }
                IdeaToken::CkETH => {
                    project.raised_cketh_wei = project.raised_cketh_wei.saturating_add(f.amount)
                }
            }
            m.insert(f.project_id, project);
        }
    });
}

/// Fund a project with deposited tokens — 100% goes to the protocol
/// treasury (which pays for the project's execution). Same minimums as
/// upvotes (value-aligned across tokens).
#[ic_cdk::update]
async fn fund_project(project_id: u64, token: IdeaToken, amount: u64) -> Result<(), String> {
    require_authenticated()?;
    require_idea_board_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let fee = token_fee(token, &config);
    if amount < token_min_upvote(token, &config) {
        return Err("BELOW_MINIMUM".to_string());
    }
    if amount > MAX_UPVOTE_UNITS {
        return Err("EXCEEDS_GLOBAL_CAP".to_string());
    }
    let project = PROJECTS.with(|m| m.borrow().get(&project_id))
        .ok_or_else(|| "PROJECT_NOT_FOUND".to_string())?;

    let accepted = match token {
        IdeaToken::ICP => project.accept_icp,
        IdeaToken::CkBTC => project.accept_ckbtc,
        IdeaToken::CkETH => project.accept_cketh,
    };
    if !accepted {
        return Err("TOKEN_NOT_ACCEPTED".to_string());
    }

    let ledger_id = token_ledger(token, &config);
    let sub = derive_project_subaccount(&caller, project_id);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    let required = amount.checked_add(fee).ok_or("OVERFLOW")?;
    if balance < required {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // Journal before moving funds (retryable from the sweep).
    let funding_id = NEXT_FUNDING_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let now = current_time();
    let mut f = ProjectFunding {
        id: funding_id,
        project_id,
        funder: caller,
        token,
        amount,
        status: UpvoteStatus::FailedPayout,
        created_at: now,
        treasury_block: None,
    };
    PROJECT_FUNDINGS.with(|m| {
        m.borrow_mut().insert(funding_id, f.clone());
    });

    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    let b = call_ledger_transfer(ledger_id, Some(sub), treasury_dest, amount, Some(fee))
        .await
        .map_err(|e| format!("TREASURY_XFER: {}", e))?;
    f.treasury_block = Some(b);
    f.status = UpvoteStatus::Settled;
    PROJECT_FUNDINGS.with(|m| {
        m.borrow_mut().insert(funding_id, f.clone());
    });
    apply_funding_to_project(&f);

    let log_entry = AuditLogEntry {
        timestamp: now,
        event_type: "project_fund".to_string(),
        proposal_id: project_id,
        user: caller,
        amount_e8s: amount,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&log_entry);
    });

    Ok(())
}

/// Sweep: resume project fundings that failed mid-transfer; if the project
/// has been removed, refund the funder's escrow instead.
async fn retry_failed_fundings() {
    let to_retry: Vec<u64> = PROJECT_FUNDINGS.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| e.value().status == UpvoteStatus::FailedPayout)
            .map(|e| *e.key())
            .collect()
    });
    if to_retry.is_empty() {
        return;
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let now = current_time();

    for id in to_retry {
        let mut f = match PROJECT_FUNDINGS.with(|m| m.borrow().get(&id)) {
            Some(f) => f,
            None => continue,
        };
        let ledger_id = token_ledger(f.token, &config);
        let fee = token_fee(f.token, &config);
        let sub = derive_project_subaccount(&f.funder, f.project_id);

        let project_exists = PROJECTS.with(|m| m.borrow().get(&f.project_id)).is_some();
        if !project_exists {
            // Project removed mid-saga: return whatever's recoverable.
            let escrow = LedgerAccount {
                owner: get_canister_id(),
                subaccount: Some(sub),
            };
            let bal = match call_ledger_balance(ledger_id, escrow).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if bal > fee {
                let dest = LedgerAccount { owner: f.funder, subaccount: None };
                if call_ledger_transfer(ledger_id, Some(sub), dest, bal - fee, Some(fee)).await.is_err() {
                    continue;
                }
            }
            f.status = UpvoteStatus::Settled;
            PROJECT_FUNDINGS.with(|m| {
                m.borrow_mut().insert(id, f);
            });
            continue;
        }

        if f.treasury_block.is_none() {
            let treasury_dest = LedgerAccount {
                owner: get_canister_id(),
                subaccount: Some(TREASURY_SUBACCOUNT),
            };
            match call_ledger_transfer(ledger_id, Some(sub), treasury_dest, f.amount, Some(fee)).await {
                Ok(b) => f.treasury_block = Some(b),
                Err(_) => {
                    PROJECT_FUNDINGS.with(|m| {
                        m.borrow_mut().insert(id, f);
                    });
                    continue;
                }
            }
        }
        f.status = UpvoteStatus::Settled;
        PROJECT_FUNDINGS.with(|m| {
            m.borrow_mut().insert(id, f.clone());
        });
        apply_funding_to_project(&f);

        let log_entry = AuditLogEntry {
            timestamp: now,
            event_type: "project_fund".to_string(),
            proposal_id: f.project_id,
            user: f.funder,
            amount_e8s: f.amount,
        };
        AUDIT_LOG.with(|log| {
            let _ = log.borrow_mut().append(&log_entry);
        });
    }
}

/// Sweep: DELETE ideas that have gone 30 days without an upvote. No funds
/// move on expiry (all upvote funds were split at upvote time); each
/// deletion is audit-logged.
fn delete_expired_ideas() {
    let now = current_time();
    let stale: Vec<(u64, Principal)> = IDEAS.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| idea_is_expired(e.value().last_upvote_at, now))
            .map(|e| (*e.key(), e.value().poster))
            .collect()
    });
    IDEAS.with(|m| {
        let mut m = m.borrow_mut();
        for (id, _) in &stale {
            m.remove(id);
        }
    });
    for (id, poster) in stale {
        let log_entry = AuditLogEntry {
            timestamp: now,
            event_type: "idea_expire".to_string(),
            proposal_id: id,
            user: poster,
            amount_e8s: 0,
        };
        AUDIT_LOG.with(|log| {
            let _ = log.borrow_mut().append(&log_entry);
        });
    }
}

/// Local-dev faucet for idea-board tokens: 100 ICP, 0.1 ckBTC, or 1 ckETH
/// from the canister's own account on the token's local ledger. Rejected on
/// mainnet (ledger canister ID check). Never callable by anonymous.
#[ic_cdk::update]
async fn dev_faucet_token(token: IdeaToken) -> Result<(), String> {
    require_authenticated()?;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    if !config.is_local
        || config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
    {
        return Err("dev_faucet_token is only available on the local network".to_string());
    }

    let ledger = token_ledger(token, &config);
    let fee = token_fee(token, &config);
    let amount: u64 = match token {
        IdeaToken::ICP => 10_000_000_000,             // 100 ICP
        IdeaToken::CkBTC => 10_000_000,               // 0.1 ckBTC
        IdeaToken::CkETH => 1_000_000_000_000_000_000, // 1 ckETH
    };
    let dest = LedgerAccount { owner: get_caller(), subaccount: None };
    call_ledger_transfer(ledger, None, dest, amount, Some(fee))
        .await
        .map(|_| ())
        .map_err(|e| format!("Faucet transfer failed: {}", e))
}

/// Local-dev: seed a few sample ideas so the board renders content on a
/// fresh network. No-op if any ideas exist.
fn seed_mock_ideas() {
    let already_seeded = IDEAS.with(|m| !m.borrow().is_empty());
    if already_seeded {
        return;
    }
    let owner = CONFIG.with(|c| {
        c.borrow().get().admins.first().copied().unwrap_or_else(Principal::anonymous)
    });
    let now = current_time();
    let samples: [(&str, &str, &str); 3] = [
        (
            "ICP gas-burn leaderboard",
            "A public leaderboard ranking dapps by the cycles (burned ICP) they consume, updated on-chain daily.",
            "Pull cycle-consumption metrics per canister from the management canister and public dashboards, normalise by subnet, and surface a verifiable burn ranking. Sponsors could pay (in ICP, burned) to pin a featured slot.",
        ),
        (
            "Burn-to-mint collectible badges",
            "Soulbound badges minted only by burning ICP — tiered by cumulative burn, displayed on user profiles.",
            "Each badge tier requires a verifiable burn via the CMC. Badges are non-transferable ICRC-7 tokens; the burn record is the provenance. Drives recurring deflationary pressure from collectors.",
        ),
        (
            "Cycle-funded compute marketplace",
            "Let users prepay AI/compute jobs in ICP that is immediately converted to cycles, burning it from supply.",
            "A job queue canister prices workloads in cycles, accepts ICP, tops itself up via the CMC (burning the ICP), and pays worker canisters in cycles. Every job permanently reduces ICP supply.",
        ),
    ];
    for (title, description, detail) in samples {
        let id = NEXT_IDEA_ID.with(|c| {
            let id = *c.borrow().get();
            c.borrow_mut().set(id + 1);
            id
        });
        IDEAS.with(|m| {
            m.borrow_mut().insert(id, Idea {
                id,
                poster: owner,
                title: title.to_string(),
                description: description.to_string(),
                detail: detail.to_string(),
                created_at: now,
                last_upvote_at: now,
                upvote_count: 0,
                views: 0,
                total_icp_e8s: 0,
                total_ckbtc_e8s: 0,
                total_cketh_wei: 0,
            });
        });
    }
}

// ==========================================
// 13. Lossless Voting (Pooled Staking, WaterNeuron-inspired)
// ==========================================
//
// Users stake ICP into one of THREE pooled NNS neurons controlled by this
// canister — fixed terms of 6 months, 1 year and 2 years (dissolve delays).
// Shares are plain e8s amounts — yield is disbursed, never compounded, so
// stake e8s are exact. Stakers vote on tracked proposals for free with weight
// proportional to stake × term (6mo = 1×, 1y = 2×, 2y = 4×). Unstaking splits
// the tier's neuron, dissolves the child for the tier's full term, then
// disburses to the user's wallet. Maturity from ALL three neurons is
// harvested into one shared yield inbox and split 50% to the single
// lossless-lottery prize pot / 50% to the treasury. Staking is also the
// lottery eligibility gate: the daily ticket grant scales with the same
// 1×/2×/4× term multiplier.

const ONE_ICP_E8S: u64 = 100_000_000;
const ICP_FEE_E8S: u64 = 10_000;
/// Staked voting power is discounted vs. burned conviction: every 10 ICP
/// staked equals 1 ICP of burned voting weight. (Staking risks nothing, so a
/// staked vote carries proportionally less weight than an irreversible burn.)
const STAKED_VP_DIVISOR: u64 = 10;

/// Voting power contributed by `amount_e8s` of stake.
fn staked_voting_power(amount_e8s: u64) -> u64 {
    amount_e8s / STAKED_VP_DIVISOR
}
/// True zero-loss staking: the treasury reimburses every fee the user's
/// stake/unstake cycle touches — the wallet→escrow deposit fee, the neuron
/// split fee and the disburse fee (3 × 0.0001 ICP) — paid out with the
/// disbursement so the user ends exactly where they started.
const STAKE_FEE_REIMBURSEMENT_E8S: u64 = 30_000;
/// Subaccount seed for the per-user stake escrow (one below REGISTRATION_SEED).
const STAKE_SEED: u64 = 0xFFFF_FFFF_FFFF_FFFE;
/// Disbursed maturity from all three tier neurons lands here (mints arrive
/// ~7 days after DisburseMaturity); the sweep drains it 50% to the lottery
/// pot / 50% to the treasury.
const YIELD_INBOX_SUBACCOUNT: [u8; 32] = [2u8; 32];
/// The single lossless-lottery prize pot, fed by all three neurons' yield.
const LOTTERY_SUBACCOUNT: [u8; 32] = [3u8; 32];
/// Local/dev only: staked ICP parks here (instead of the governance staking
/// account) so a mock disburse can really pay users back from the local ledger.
const MOCK_STAKE_SUBACCOUNT: [u8; 32] = [4u8; 32];
/// NNS follow topics. Topic 0 is the catch-all, which deliberately EXCLUDES
/// Governance (4) and SNS & Neurons' Fund (14) — both carry voting rewards,
/// so the pool neuron must follow all three explicitly.
const TOPIC_CATCH_ALL: i32 = 0;
const TOPIC_SNS_AND_NEURONS_FUND: i32 = 14;
const NNS_GOVERNANCE_ID: &str = "rrkah-fqaaa-aaaaa-aaaaq-cai";
/// NNS neuron visibility (governance.did): 2 = public. Every pool neuron is
/// made public at bootstrap so the community can audit it on the dashboard.
const NEURON_VISIBILITY_PUBLIC: i32 = 2;
/// Don't run a yield distribution below this (must dwarf the transfer fee).
const YIELD_MIN_DISTRIBUTION_E8S: u64 = 1_000_000;
/// DisburseMaturity mints ICP ~7 days later.
const MATURITY_MINT_DELAY_NANOS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
/// Mock neuron ids start here so they never collide with anything real-looking.
const MOCK_NEURON_ID_BASE: u64 = 990_000;
/// Cap the informational pending-maturity list.
const MAX_PENDING_MATURITY: usize = 20;

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum StakingBootstrap {
    /// No neuron yet (no stake has ever been claimed).
    NotStarted,
    /// Neuron claimed; dissolve delay not yet set.
    Claimed,
    /// Dissolve delay set; followees not yet configured.
    DelaySet,
    /// Fully configured: delay set + following the leader on all topics.
    Ready,
}

/// Fixed staking terms. The 6-month minimum matches the NNS minimum dissolve
/// delay for voting eligibility, so no Mission 70 gate applies. Voting weight
/// and the daily lottery-ticket grant both scale with the same multiplier,
/// proportional to the term length (6mo = 1×, 1y = 2×, 2y = 4×).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum StakeTier {
    SixMonths,
    OneYear,
    TwoYears,
}

impl StakeTier {
    pub fn all() -> [StakeTier; 3] {
        [StakeTier::SixMonths, StakeTier::OneYear, StakeTier::TwoYears]
    }

    pub fn idx(self) -> u8 {
        match self {
            StakeTier::SixMonths => 0,
            StakeTier::OneYear => 1,
            StakeTier::TwoYears => 2,
        }
    }

    pub fn dissolve_delay_secs(self) -> u64 {
        match self {
            StakeTier::SixMonths => 15_778_800, // 6 months
            StakeTier::OneYear => 31_557_600,   // 1 year
            StakeTier::TwoYears => 63_115_200,  // 2 years
        }
    }

    /// Term multiplier applied to both voting weight and the daily lottery
    /// ticket grant.
    pub fn weight_multiplier(self) -> u64 {
        match self {
            StakeTier::SixMonths => 1,
            StakeTier::OneYear => 2,
            StakeTier::TwoYears => 4,
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MaturityDisbursement {
    pub amount_e8s: u64,
    pub initiated_at: u64,
    /// When the minted ICP should arrive in the yield inbox (~+7 days).
    pub expected_at: u64,
}

/// One per StakeTier (keyed by `StakeTier::idx()` in STAKING_POOLS).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StakingPool {
    pub neuron_id: Option<u64>,
    /// ClaimOrRefresh memo, fixed at the tier's first stake. The governance
    /// staking account is derived from (canister principal, nonce) — never
    /// change it.
    pub nonce: u64,
    pub total_staked_e8s: u64,
    pub bootstrap: StakingBootstrap,
    /// ICP transferred to the staking account but not yet claimed/refreshed
    /// into the neuron. The sweep retries ClaimOrRefresh until this drains;
    /// the local mock credits exactly this amount to the simulated neuron.
    pub pending_refresh_e8s: u64,
    pub pending_maturity: Vec<MaturityDisbursement>,
    /// Lifetime yield harvested from this tier's neuron (split 50% lottery
    /// pot / 50% treasury at distribution).
    pub total_yield_e8s: u64,
}

impl Default for StakingPool {
    fn default() -> Self {
        StakingPool {
            neuron_id: None,
            nonce: 0,
            total_staked_e8s: 0,
            bootstrap: StakingBootstrap::NotStarted,
            pending_refresh_e8s: 0,
            pending_maturity: vec![],
            total_yield_e8s: 0,
        }
    }
}

/// STAKES key: one stake record per (tier, user).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct StakeKey {
    pub tier: u8,
    pub user: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserStake {
    pub amount_e8s: u64,
    pub staked_at: u64,
    pub last_action_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum UnstakeStatus {
    /// Neuron split off; StartDissolving not yet confirmed (sweep retries).
    SplitDone,
    /// Dissolving; disbursable once `dissolve_eta` passes.
    Dissolving,
    /// ICP disbursed to the user's wallet. Terminal.
    Disbursed,
    /// Merged back into a tier pool neuron at the user's request. Terminal.
    Merged,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct PendingUnstake {
    pub id: u64,
    pub user: Principal,
    pub tier: StakeTier,
    pub amount_e8s: u64,
    pub split_neuron_id: u64,
    pub status: UnstakeStatus,
    pub created_at: u64,
    /// Nanosecond timestamp when the split neuron finishes dissolving (the
    /// tier's full term).
    pub dissolve_eta: u64,
    pub disburse_block: Option<u64>,
    /// Treasury fee reimbursement (0.0003 ICP) — makes the cycle zero-loss.
    /// Set when the refund transfer lands; the sweep retries until it does.
    #[serde(default)]
    pub fee_refund_block: Option<u64>,
    /// Tier the dissolving neuron was merged back into (status == Merged).
    #[serde(default)]
    pub merged_into: Option<StakeTier>,
    /// What the split child actually holds. Some(amount) since the treasury
    /// started fronting the split fee (the child holds exactly the requested
    /// amount); None for legacy unstakes where the NNS took the split fee
    /// out of the child (child = amount − 0.0001).
    #[serde(default)]
    pub child_e8s: Option<u64>,
    pub settled_at: Option<u64>,
}

/// What the dissolving child neuron holds, across both unstake generations.
fn unstake_child_e8s(p: &PendingUnstake) -> u64 {
    p.child_e8s.unwrap_or_else(|| p.amount_e8s.saturating_sub(ICP_FEE_E8S))
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LosslessVote {
    pub proposal_id: u64,
    pub principal: Principal,
    pub stance: Stance,
    /// Stake snapshot at cast time — later stake changes don't retro-apply.
    pub weight_e8s: u64,
    pub cast_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum YieldStatus {
    InProgress,
    Done,
}

/// Saga journal for one yield distribution: the shared yield inbox (fed by
/// all three tier neurons) is drained 50% to the lottery prize pot / 50% to
/// the treasury. Persisted per-leg block indices make a retry skip completed
/// transfers (same idempotency as `settle_burn_split`).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct YieldDistribution {
    pub id: u64,
    /// Inbox balance this distribution drains (includes the 2 transfer fees).
    pub amount_e8s: u64,
    pub lottery_amount_e8s: u64,
    pub treasury_amount_e8s: u64,
    pub lottery_block: Option<u64>,
    pub treasury_block: Option<u64>,
    pub status: YieldStatus,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

/// The caller's stake in one tier (part of UserStakeInfo).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserTierStake {
    pub tier: StakeTier,
    pub amount_e8s: u64,
    /// amount × the tier's term multiplier — the voting power this position
    /// contributes.
    pub weight_e8s: u64,
    pub staked_at: u64,
    pub last_action_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct UserStakeInfo {
    pub tiers: Vec<UserTierStake>,
    /// Sum of the caller's stakes across tiers.
    pub total_staked_e8s: u64,
    /// Sum of amount × multiplier across tiers — the caller's voting power.
    pub total_weight_e8s: u64,
}

/// Public state of one tier's pooled neuron.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TierPoolInfo {
    pub tier: StakeTier,
    pub dissolve_delay_secs: u64,
    pub weight_multiplier: u64,
    /// Daily lottery tickets a staker in this tier collects.
    pub daily_tickets: u64,
    pub neuron_id: Option<u64>,
    pub total_staked_e8s: u64,
    pub staker_count: u64,
    pub bootstrap: StakingBootstrap,
    pub pending_refresh_e8s: u64,
    pub pending_maturity: Vec<MaturityDisbursement>,
    pub total_yield_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct StakingPoolInfo {
    pub pools: Vec<TierPoolInfo>,
    pub total_staked_e8s: u64,
    pub min_stake_e8s: u64,
    pub min_unstake_e8s: u64,
    /// Lifetime yield harvested across all tiers (split 50/50 lottery pot /
    /// treasury at distribution).
    pub total_yield_e8s: u64,
}

impl_storable!(StakingPool);
impl_storable!(StakeKey);
impl_storable!(UserStake);
impl_storable!(PendingUnstake);
impl_storable!(LosslessVote);
impl_storable!(YieldDistribution);

/// Local/dev-only simulation of the NNS neuron lifecycle, driven by the same
/// rejected-call fallback as `cast_nns_vote` (F-102 posture: mainnet never
/// reaches it). Heap state — reset on upgrade — acceptable for local dev.
#[derive(Default)]
struct MockNeuronState {
    stake_e8s: u64,
    /// Configured dissolve delay (set by the mock IncreaseDissolveDelay,
    /// inherited by split children) — drives the mock dissolve clock.
    delay_secs: u64,
    dissolving: bool,
    dissolve_eta: u64,
    maturity_e8s: u64,
    /// Mock mirror of the NNS visibility flag (set by SetVisibility).
    public: bool,
}

struct MockGovernance {
    neurons: std::collections::HashMap<u64, MockNeuronState>,
    next_id: u64,
}

impl Default for MockGovernance {
    fn default() -> Self {
        MockGovernance {
            neurons: std::collections::HashMap::new(),
            next_id: MOCK_NEURON_ID_BASE,
        }
    }
}

thread_local! {
    // One pool per StakeTier, keyed by `StakeTier::idx()`. (This region held
    // the old single-pool cell — restructured 2026-06-10 before any deploy
    // carried staking state, so no migration applies.)
    static STAKING_POOLS: RefCell<StableBTreeMap<u8, StakingPool, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(19))))
    });

    static STAKES: RefCell<StableBTreeMap<StakeKey, UserStake, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(20))))
    });

    static PENDING_UNSTAKES: RefCell<StableBTreeMap<u64, PendingUnstake, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(21))))
    });

    static NEXT_UNSTAKE_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(22)), 1u64))
    });

    static LOSSLESS_VOTES: RefCell<StableBTreeMap<CommitmentKey, LosslessVote, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(23))))
    });

    static YIELD_DISTRIBUTIONS: RefCell<StableBTreeMap<u64, YieldDistribution, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(24))))
    });

    static NEXT_YIELD_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(25)), 1u64))
    });

    static STAKING_BUSY: RefCell<bool> = const { RefCell::new(false) };

    static MOCK_GOV: RefCell<MockGovernance> = RefCell::new(MockGovernance::default());
}

/// Serializes every operation that touches the pooled neuron or share
/// accounting (stake, unstake, the sweep). Share attribution depends on
/// neuron mutations never interleaving across await points.
pub struct StakingLock;

impl StakingLock {
    pub fn new() -> Result<Self, String> {
        STAKING_BUSY.with(|b| {
            let mut busy = b.borrow_mut();
            if *busy {
                return Err("STAKING_BUSY".to_string());
            }
            *busy = true;
            Ok(StakingLock)
        })
    }
}

impl Drop for StakingLock {
    fn drop(&mut self) {
        STAKING_BUSY.with(|b| *b.borrow_mut() = false);
    }
}

fn require_lossless_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_LOSSLESS_VOTING) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

fn tier_pool(tier: StakeTier) -> StakingPool {
    STAKING_POOLS
        .with(|m| m.borrow().get(&tier.idx()))
        .unwrap_or_default()
}

fn set_tier_pool(tier: StakeTier, pool: StakingPool) {
    STAKING_POOLS.with(|m| {
        m.borrow_mut().insert(tier.idx(), pool);
    });
}

fn stake_key(tier: StakeTier, user: Principal) -> StakeKey {
    StakeKey { tier: tier.idx(), user }
}

/// The caller's total voting weight: Σ stake × term multiplier over tiers.
fn user_voting_weight(user: Principal) -> u64 {
    // Voting power = total ICP staked ÷ 10 (10 staked ICP = 1 burned ICP of
    // weight). The term multiplier scales lottery tickets, not voting power.
    let total: u64 = StakeTier::all().iter().fold(0u64, |acc, &tier| {
        let amount = STAKES
            .with(|m| m.borrow().get(&stake_key(tier, user)))
            .map(|s| s.amount_e8s)
            .unwrap_or(0);
        acc.saturating_add(amount)
    });
    staked_voting_power(total)
}

/// True when the user holds a stake in any tier (the lottery eligibility gate).
fn user_has_stake(user: Principal) -> bool {
    StakeTier::all()
        .iter()
        .any(|&tier| STAKES.with(|m| m.borrow().get(&stake_key(tier, user)).is_some()))
}

fn staking_audit(event_type: &str, user: Principal, amount_e8s: u64, ref_id: u64) {
    let entry = AuditLogEntry {
        timestamp: current_time(),
        event_type: event_type.to_string(),
        proposal_id: ref_id,
        user,
        amount_e8s,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
}

/// Governance neuron-staking (sub)account: sha256(0x0c · "neuron-stake" ·
/// controller · nonce). ICP sent here with memo == nonce is claimable via
/// ClaimOrRefresh{MemoAndController}.
fn neuron_staking_subaccount(controller: Principal, nonce: u64) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update([0x0c]);
    hasher.update(b"neuron-stake");
    hasher.update(controller.as_slice());
    hasher.update(nonce.to_be_bytes());
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&hasher.finalize());
    sub
}

/// The 28-byte SHA-224 account-identifier hash WITHOUT the CRC32 prefix —
/// the form governance's `Disburse.to_account` expects.
fn account_id_hash28(owner: Principal, subaccount: &[u8; 32]) -> Vec<u8> {
    use sha2::Digest;
    let mut hasher = sha2::Sha224::new();
    hasher.update(b"\x0Aaccount-id");
    hasher.update(owner.as_slice());
    hasher.update(&subaccount[..]);
    hasher.finalize().to_vec()
}

// ── manage_neuron plumbing ──

enum GovOutcome {
    Response(CommandResponse),
    /// Local dev only: the call was rejected by the stub network — drive the
    /// mock state machine instead (same posture as cast_nns_vote / F-102).
    LocalFallback,
}

#[cfg(target_arch = "wasm32")]
async fn call_manage_neuron(neuron_id: Option<u64>, command: Command) -> Result<GovOutcome, String> {
    let nns_gov = Principal::from_text(NNS_GOVERNANCE_ID).unwrap();
    let args = ManageNeuron {
        id: neuron_id.map(|id| NeuronId { id }),
        command: Some(command),
        neuron_id_or_subaccount: None,
    };
    let response: Result<(ManageNeuronResponse,), _> =
        ic_cdk::call(nns_gov, "manage_neuron", (args,)).await;
    match response {
        Ok((res,)) => match res.command {
            Some(CommandResponse::Error(err)) => {
                Err(format!("NNS error {}: {}", err.error_type, err.error_message))
            }
            Some(cmd) => Ok(GovOutcome::Response(cmd)),
            None => Err("No command response from NNS".to_string()),
        },
        Err((code, msg)) => {
            let is_local = CONFIG.with(|cell| cell.borrow().get().is_local);
            if is_local
                && (code == ic_cdk::api::call::RejectionCode::DestinationInvalid
                    || code == ic_cdk::api::call::RejectionCode::CanisterError
                    || code == ic_cdk::api::call::RejectionCode::CanisterReject)
            {
                Ok(GovOutcome::LocalFallback)
            } else {
                Err(format!("NNS call rejected (code {:?}): {}", code, msg))
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_MANAGE_NEURON: RefCell<Option<Result<CommandResponse, String>>> =
        const { RefCell::new(None) };
}

#[cfg(not(target_arch = "wasm32"))]
fn set_mock_manage_neuron(res: Option<Result<CommandResponse, String>>) {
    TEST_MOCK_MANAGE_NEURON.with(|cell| {
        *cell.borrow_mut() = res;
    });
}

/// Host tests: an explicit mock response wins; otherwise fall through to the
/// mock state machine so unit tests exercise the full local flow.
#[cfg(not(target_arch = "wasm32"))]
async fn call_manage_neuron(_neuron_id: Option<u64>, _command: Command) -> Result<GovOutcome, String> {
    let mock = TEST_MOCK_MANAGE_NEURON.with(|cell| cell.borrow().clone());
    match mock {
        Some(res) => res.map(GovOutcome::Response),
        None => Ok(GovOutcome::LocalFallback),
    }
}

/// Claim the pool neuron (first stake) or refresh its cached stake after a
/// top-up. `mock_amount_e8s` only feeds the local fallback, which cannot read
/// the real staking account.
async fn gov_claim_or_refresh(
    nonce: u64,
    mock_amount_e8s: u64,
    existing_neuron: Option<u64>,
) -> Result<u64, String> {
    let cmd = Command::ClaimOrRefresh(ClaimOrRefreshCmd {
        by: Some(By::MemoAndController(MemoAndController {
            controller: Some(get_canister_id()),
            memo: nonce,
        })),
    });
    match call_manage_neuron(None, cmd).await? {
        GovOutcome::Response(CommandResponse::ClaimOrRefresh(r)) => r
            .refreshed_neuron_id
            .map(|n| n.id)
            .ok_or_else(|| "CLAIM_NO_NEURON_ID".to_string()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => Ok(mock_claim_or_refresh(existing_neuron, mock_amount_e8s)),
    }
}

fn mock_claim_or_refresh(existing: Option<u64>, amount_e8s: u64) -> u64 {
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let id = existing.unwrap_or_else(|| {
            g.next_id += 1;
            g.next_id
        });
        let neuron = g.neurons.entry(id).or_default();
        neuron.stake_e8s = neuron.stake_e8s.saturating_add(amount_e8s);
        id
    })
}

async fn gov_increase_dissolve_delay(neuron_id: u64, additional_secs: u32) -> Result<(), String> {
    let cmd = Command::Configure(ConfigureCmd {
        operation: Some(Operation::IncreaseDissolveDelay(IncreaseDissolveDelay {
            additional_dissolve_delay_seconds: additional_secs,
        })),
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Configure(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => {
            MOCK_GOV.with(|g| {
                if let Some(n) = g.borrow_mut().neurons.get_mut(&neuron_id) {
                    n.delay_secs = n.delay_secs.saturating_add(additional_secs as u64);
                }
            });
            Ok(())
        }
    }
}

/// Make the neuron public on the NNS (visibility = 2). Auditability is part
/// of the staking promise: anyone can verify the pool neurons on the
/// dashboard. Idempotent — safe to re-run on every bootstrap retry.
async fn gov_set_visibility(neuron_id: u64) -> Result<(), String> {
    let cmd = Command::Configure(ConfigureCmd {
        operation: Some(Operation::SetVisibility(SetVisibilityOp {
            visibility: Some(NEURON_VISIBILITY_PUBLIC),
        })),
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Configure(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => {
            MOCK_GOV.with(|g| {
                if let Some(n) = g.borrow_mut().neurons.get_mut(&neuron_id) {
                    n.public = true;
                }
            });
            Ok(())
        }
    }
}

async fn gov_follow(neuron_id: u64, topic: i32, leader_id: u64) -> Result<(), String> {
    let cmd = Command::Follow(FollowCmd {
        topic,
        followees: vec![NeuronId { id: leader_id }],
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Follow(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => Ok(()),
    }
}

/// Follow the leader on the catch-all topic plus the two reward-bearing topics
/// it excludes, so the pool neuron never misses voting rewards.
async fn gov_follow_all_topics(neuron_id: u64, leader_id: u64) -> Result<(), String> {
    for topic in [TOPIC_CATCH_ALL, TOPIC_GOVERNANCE, TOPIC_SNS_AND_NEURONS_FUND] {
        gov_follow(neuron_id, topic, leader_id).await?;
    }
    Ok(())
}

async fn gov_split(neuron_id: u64, amount_e8s: u64) -> Result<u64, String> {
    let cmd = Command::Split(SplitCmd {
        amount_e8s,
        memo: None,
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Split(r)) => r
            .created_neuron_id
            .map(|n| n.id)
            .ok_or_else(|| "SPLIT_NO_NEURON_ID".to_string()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_split(neuron_id, amount_e8s),
    }
}

fn mock_split(parent_id: u64, amount_e8s: u64) -> Result<u64, String> {
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let parent = g
            .neurons
            .get_mut(&parent_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        if parent.stake_e8s < amount_e8s {
            return Err("MOCK_INSUFFICIENT_STAKE".to_string());
        }
        parent.stake_e8s -= amount_e8s;
        let parent_delay = parent.delay_secs;
        g.next_id += 1;
        let child_id = g.next_id;
        g.neurons.insert(
            child_id,
            MockNeuronState {
                // The real NNS charges the transfer fee out of the split amount.
                stake_e8s: amount_e8s.saturating_sub(ICP_FEE_E8S),
                // A split child inherits the parent's dissolve delay.
                delay_secs: parent_delay,
                ..Default::default()
            },
        );
        Ok(child_id)
    })
}

async fn gov_start_dissolving(neuron_id: u64) -> Result<(), String> {
    let cmd = Command::Configure(ConfigureCmd {
        operation: Some(Operation::StartDissolving(EmptyRecord {})),
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Configure(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_start_dissolving(neuron_id),
    }
}

fn mock_start_dissolving(neuron_id: u64) -> Result<(), String> {
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let neuron = g
            .neurons
            .get_mut(&neuron_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        if !neuron.dissolving {
            let delay_ns = neuron.delay_secs.saturating_mul(1_000_000_000);
            neuron.dissolving = true;
            neuron.dissolve_eta = current_time().saturating_add(delay_ns);
        }
        Ok(())
    })
}

fn mock_stop_dissolving(neuron_id: u64) -> Result<(), String> {
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let neuron = g
            .neurons
            .get_mut(&neuron_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        neuron.dissolving = false;
        neuron.dissolve_eta = 0;
        Ok(())
    })
}

async fn gov_stop_dissolving(neuron_id: u64) -> Result<(), String> {
    let cmd = Command::Configure(ConfigureCmd {
        operation: Some(Operation::StopDissolving(EmptyRecord {})),
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Configure(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_stop_dissolving(neuron_id),
    }
}

/// Merge `source_id`'s stake into `target_id` (same controller — both ours).
/// Governance moves the source stake minus one ledger fee into the target.
async fn gov_merge(target_id: u64, source_id: u64) -> Result<(), String> {
    let cmd = Command::Merge(MergeCmd {
        source_neuron_id: Some(NeuronId { id: source_id }),
    });
    match call_manage_neuron(Some(target_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Merge(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_merge(target_id, source_id),
    }
}

fn mock_merge(target_id: u64, source_id: u64) -> Result<(), String> {
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let source_stake = {
            let source = g
                .neurons
                .get_mut(&source_id)
                .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
            if source.dissolving {
                return Err("MOCK_SOURCE_DISSOLVING".to_string());
            }
            let st = source.stake_e8s;
            source.stake_e8s = 0;
            st
        };
        let target = g
            .neurons
            .get_mut(&target_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        // The real NNS charges the transfer fee out of the merged amount.
        target.stake_e8s = target
            .stake_e8s
            .saturating_add(source_stake.saturating_sub(ICP_FEE_E8S));
        Ok(())
    })
}

/// Disburse a fully-dissolved split neuron to the user's main ICP account.
/// Governance rejects if the neuron hasn't finished dissolving — callers just
/// retry on the next sweep tick.
async fn gov_disburse(neuron_id: u64, owner: Principal) -> Result<u64, String> {
    let cmd = Command::Disburse(DisburseCmd {
        to_account: Some(GovAccountIdentifier {
            hash: account_id_hash28(owner, &[0u8; 32]),
        }),
        amount: None, // full stake
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::Disburse(r)) => Ok(r.transfer_block_height),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_disburse(neuron_id, owner).await,
    }
}

async fn mock_disburse(neuron_id: u64, owner: Principal) -> Result<u64, String> {
    let stake = MOCK_GOV.with(|g| {
        let g = g.borrow();
        let neuron = g
            .neurons
            .get(&neuron_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        if !neuron.dissolving {
            return Err("MOCK_NOT_DISSOLVING".to_string());
        }
        if current_time() < neuron.dissolve_eta {
            return Err("MOCK_NOT_DISSOLVED_YET".to_string());
        }
        Ok(neuron.stake_e8s)
    })?;
    let block = if stake > ICP_FEE_E8S {
        let ledger_id = CONFIG.with(|c| c.borrow().get().ledger_canister_id);
        let dest = LedgerAccount {
            owner,
            subaccount: None,
        };
        call_ledger_transfer(
            ledger_id,
            Some(MOCK_STAKE_SUBACCOUNT),
            dest,
            stake - ICP_FEE_E8S,
            Some(ICP_FEE_E8S),
        )
        .await?
    } else {
        0
    };
    MOCK_GOV.with(|g| {
        g.borrow_mut().neurons.remove(&neuron_id);
    });
    Ok(block)
}

/// Disburse 100% of the pool neuron's maturity to the yield inbox. The real
/// NNS mints the ICP ~7 days later; the local mock transfers immediately from
/// the canister's own funds (faucet-style) so the distribution runs for real.
async fn gov_disburse_maturity(neuron_id: u64) -> Result<(), String> {
    let cmd = Command::DisburseMaturity(DisburseMaturityCmd {
        percentage_to_disburse: 100,
        to_account: Some(GovAccount {
            owner: Some(get_canister_id()),
            subaccount: Some(YIELD_INBOX_SUBACCOUNT.to_vec()),
        }),
        to_account_identifier: None,
    });
    match call_manage_neuron(Some(neuron_id), cmd).await? {
        GovOutcome::Response(CommandResponse::DisburseMaturity(_)) => Ok(()),
        GovOutcome::Response(_) => Err("UNEXPECTED_NNS_RESPONSE".to_string()),
        GovOutcome::LocalFallback => mock_disburse_maturity(neuron_id).await,
    }
}

async fn mock_disburse_maturity(neuron_id: u64) -> Result<(), String> {
    let amount = MOCK_GOV.with(|g| {
        g.borrow()
            .neurons
            .get(&neuron_id)
            .map(|n| n.maturity_e8s)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())
    })?;
    if amount == 0 {
        return Ok(());
    }
    let ledger_id = CONFIG.with(|c| c.borrow().get().ledger_canister_id);
    let dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(YIELD_INBOX_SUBACCOUNT),
    };
    call_ledger_transfer(ledger_id, None, dest, amount, Some(ICP_FEE_E8S)).await?;
    MOCK_GOV.with(|g| {
        if let Some(n) = g.borrow_mut().neurons.get_mut(&neuron_id) {
            n.maturity_e8s = 0;
        }
    });
    Ok(())
}

/// Current unstaked maturity on the pool neuron. The canister is the neuron's
/// controller, so `get_full_neuron` is permitted on mainnet; locally and in
/// host tests the mock neuron is the source of truth.
async fn staking_neuron_maturity(neuron_id: u64) -> Result<u64, String> {
    let is_local = CONFIG.with(|c| c.borrow().get().is_local);
    if is_local || cfg!(not(target_arch = "wasm32")) {
        return Ok(MOCK_GOV.with(|g| {
            g.borrow()
                .neurons
                .get(&neuron_id)
                .map(|n| n.maturity_e8s)
                .unwrap_or(0)
        }));
    }
    get_full_neuron(neuron_id)
        .await
        .map(|n| n.maturity_e8s_equivalent)
}

// ── Stake ──

/// The caller's stake-escrow subaccount. Fund it with amount + 0.0001 ICP fee,
/// then call `stake(amount)`.
#[ic_cdk::query]
fn get_stake_deposit_address() -> LedgerAccount {
    let caller = get_caller();
    if caller == Principal::anonymous() {
        panic!("Anonymous principal is not allowed");
    }
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_subaccount(&caller, STAKE_SEED)),
    }
}

#[ic_cdk::update]
async fn stake(amount_e8s: u64, tier: StakeTier) -> Result<(), String> {
    require_authenticated()?;
    require_lossless_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;
    let _lock = StakingLock::new()?;

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let mut pool = tier_pool(tier);

    // The first stake into a tier creates its neuron, so it must clear the
    // NNS 1 ICP minimum; afterwards the configured minimum applies.
    let min = if pool.neuron_id.is_none() {
        ONE_ICP_E8S
    } else {
        config.min_stake_e8s
    };
    if amount_e8s < min {
        return Err("BELOW_MINIMUM".to_string());
    }
    if amount_e8s > MAX_COMMIT_E8S {
        return Err("EXCEEDS_GLOBAL_CAP".to_string());
    }
    // Whole-ICP only: keeps every stake, ticket grant and neuron amount an
    // integer number of ICP (owner decision 2026-06-12).
    if amount_e8s % ONE_ICP_E8S != 0 {
        return Err("WHOLE_ICP_ONLY".to_string());
    }

    let sub = derive_subaccount(&caller, STAKE_SEED);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(config.ledger_canister_id, escrow.clone()).await?;
    // Zero-loss: the user deposits exactly `amount` — no fee padding.
    if balance < amount_e8s {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // The treasury covers the escrow→staking-account transfer fee: top the
    // escrow up by one fee so the user's full amount stakes. Fails loudly
    // (before any state change) if the treasury can't cover it.
    call_ledger_transfer(
        config.ledger_canister_id,
        Some(TREASURY_SUBACCOUNT),
        escrow,
        ICP_FEE_E8S,
        Some(ICP_FEE_E8S),
    )
    .await
    .map_err(|e| format!("TREASURY_FEE_COVER: {}", e))?;

    // Fix the claim nonce at the tier's very first stake — the governance
    // staking account is derived from it and must never change afterwards.
    // (+idx keeps the three tiers' nonces distinct even within one tick.)
    if pool.nonce == 0 {
        pool.nonce = current_time() + tier.idx() as u64;
        set_tier_pool(tier, pool.clone());
    }

    // Escrow → staking account (point of no return). Mainnet: legacy transfer
    // with memo == nonce to the governance staking account. Local: park the
    // funds in MOCK_STAKE_SUBACCOUNT so a mock disburse can really pay back.
    if config.is_local || cfg!(not(target_arch = "wasm32")) {
        let dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(MOCK_STAKE_SUBACCOUNT),
        };
        call_ledger_transfer(
            config.ledger_canister_id,
            Some(sub),
            dest,
            amount_e8s,
            Some(ICP_FEE_E8S),
        )
        .await
        .map_err(|e| format!("STAKE_TRANSFER_FAILED: {}", e))?;
    } else {
        let gov = Principal::from_text(NNS_GOVERNANCE_ID).unwrap();
        let staking_sub = neuron_staking_subaccount(get_canister_id(), pool.nonce);
        call_ledger_legacy_transfer(
            config.ledger_canister_id,
            Some(sub),
            account_id_bytes(gov, &staking_sub),
            amount_e8s,
            ICP_FEE_E8S,
            pool.nonce,
        )
        .await
        .map_err(|e| format!("STAKE_TRANSFER_FAILED: {}", e))?;
    }

    // Credit the share immediately — the funds have left the user's escrow.
    let now = current_time();
    let key = stake_key(tier, caller);
    STAKES.with(|m| {
        let mut s = m.borrow().get(&key).unwrap_or(UserStake {
            amount_e8s: 0,
            staked_at: now,
            last_action_at: now,
        });
        s.amount_e8s = s.amount_e8s.checked_add(amount_e8s).unwrap_or(u64::MAX);
        s.last_action_at = now;
        m.borrow_mut().insert(key, s);
    });
    pool.total_staked_e8s = pool.total_staked_e8s.checked_add(amount_e8s).unwrap_or(u64::MAX);
    pool.pending_refresh_e8s = pool
        .pending_refresh_e8s
        .checked_add(amount_e8s)
        .unwrap_or(u64::MAX);
    set_tier_pool(tier, pool);
    staking_audit("stake", caller, amount_e8s, tier.idx() as u64);

    // Best-effort claim/refresh + bootstrap; the sweep repairs any failure.
    if let Err(e) = advance_staking_bootstrap().await {
        canister_print(&format!("stake: bootstrap deferred to sweep: {}", e));
    }
    Ok(())
}

/// Drive every tier's pool-neuron state machine forward: claim/refresh
/// pending stake, then (once) set the tier's dissolve delay and follow the
/// leader on all topics. Callers must hold the StakingLock. Returns the first
/// error but still attempts every tier.
async fn advance_staking_bootstrap() -> Result<(), String> {
    let mut first_err: Option<String> = None;
    for tier in StakeTier::all() {
        if let Err(e) = advance_tier_bootstrap(tier).await {
            if first_err.is_none() {
                first_err = Some(format!("{:?}: {}", tier, e));
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

async fn advance_tier_bootstrap(tier: StakeTier) -> Result<(), String> {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let mut pool = tier_pool(tier);

    if pool.pending_refresh_e8s > 0 && pool.nonce != 0 {
        let id =
            gov_claim_or_refresh(pool.nonce, pool.pending_refresh_e8s, pool.neuron_id).await?;
        pool.pending_refresh_e8s = 0;
        if pool.neuron_id.is_none() {
            pool.neuron_id = Some(id);
            pool.bootstrap = StakingBootstrap::Claimed;
        }
        set_tier_pool(tier, pool.clone());
    }

    let neuron_id = match pool.neuron_id {
        Some(id) => id,
        None => return Ok(()),
    };

    if pool.bootstrap == StakingBootstrap::Claimed {
        let delay = u32::try_from(tier.dissolve_delay_secs()).unwrap_or(u32::MAX);
        gov_increase_dissolve_delay(neuron_id, delay).await?;
        pool.bootstrap = StakingBootstrap::DelaySet;
        set_tier_pool(tier, pool.clone());
    }
    if pool.bootstrap == StakingBootstrap::DelaySet {
        // Public on the NNS the moment it exists — the sweep retries this
        // step (with the follows) until both land.
        gov_set_visibility(neuron_id).await?;
        gov_follow_all_topics(neuron_id, config.primary_neuron_id).await?;
        pool.bootstrap = StakingBootstrap::Ready;
        set_tier_pool(tier, pool.clone());
    }
    Ok(())
}

// ── Unstake ──

/// Inject `amount` from the treasury into a tier's pool neuron: transfer to
/// the neuron's governance staking account, then refresh so the stake lands
/// immediately (unstake refuses to run with a refresh pending). On refresh
/// failure the funds are parked in pending_refresh for the sweep to absorb,
/// and the caller aborts (retryable).
async fn fund_pool_neuron_from_treasury(
    config: &Config,
    pool: &mut StakingPool,
    tier: StakeTier,
    amount: u64,
) -> Result<(), String> {
    if config.is_local || cfg!(not(target_arch = "wasm32")) {
        let dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(MOCK_STAKE_SUBACCOUNT),
        };
        call_ledger_transfer(
            config.ledger_canister_id,
            Some(TREASURY_SUBACCOUNT),
            dest,
            amount,
            Some(ICP_FEE_E8S),
        )
        .await
        .map_err(|e| format!("TREASURY_FEE_COVER: {}", e))?;
    } else {
        let gov = Principal::from_text(NNS_GOVERNANCE_ID).unwrap();
        let staking_sub = neuron_staking_subaccount(get_canister_id(), pool.nonce);
        call_ledger_legacy_transfer(
            config.ledger_canister_id,
            Some(TREASURY_SUBACCOUNT),
            account_id_bytes(gov, &staking_sub),
            amount,
            ICP_FEE_E8S,
            pool.nonce,
        )
        .await
        .map_err(|e| format!("TREASURY_FEE_COVER: {}", e))?;
    }
    match gov_claim_or_refresh(pool.nonce, amount, pool.neuron_id).await {
        Ok(_) => Ok(()),
        Err(e) => {
            pool.pending_refresh_e8s = pool.pending_refresh_e8s.saturating_add(amount);
            set_tier_pool(tier, pool.clone());
            Err(format!("FEE_COVER_REFRESH_DEFERRED: {}", e))
        }
    }
}

/// Split `amount_e8s` off the tier's pool neuron and start dissolving it; the
/// sweep disburses to the caller's wallet once the tier's full term passes.
/// Returns the pending-unstake id. The user nets amount − 0.0002 ICP (split +
/// disburse fees).
#[ic_cdk::update]
async fn unstake(amount_e8s: u64, tier: StakeTier) -> Result<u64, String> {
    require_authenticated()?;
    require_lossless_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;
    let _lock = StakingLock::new()?;

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let mut pool = tier_pool(tier);
    let neuron_id = pool.neuron_id.ok_or("POOL_NOT_READY")?;
    if pool.bootstrap != StakingBootstrap::Ready {
        return Err("POOL_NOT_READY".to_string());
    }
    if pool.pending_refresh_e8s > 0 {
        return Err("REFRESH_PENDING".to_string());
    }

    let key = stake_key(tier, caller);
    let mut stake = STAKES
        .with(|m| m.borrow().get(&key))
        .ok_or("NO_STAKE")?;
    if amount_e8s > stake.amount_e8s {
        return Err("EXCEEDS_STAKE".to_string());
    }
    if amount_e8s < config.min_unstake_e8s {
        return Err("BELOW_MINIMUM".to_string());
    }
    if amount_e8s % ONE_ICP_E8S != 0 {
        return Err("WHOLE_ICP_ONLY".to_string());
    }
    // The pool neuron must keep ≥ 1 ICP after the split (NNS minimum stake).
    // The last ~1 ICP of shares can only exit after someone else stakes.
    if pool.total_staked_e8s.saturating_sub(amount_e8s) < ONE_ICP_E8S {
        return Err("POOL_FLOOR".to_string());
    }

    // Treasury fronts the split fee: inject one fee into the pool neuron,
    // then split amount+fee — the NNS charges its fee from the split, so the
    // child ends up holding EXACTLY the requested amount and the user's
    // remaining stake decreases by exactly that amount (no 0.0001 haircut).
    fund_pool_neuron_from_treasury(&config, &mut pool, tier, ICP_FEE_E8S).await?;

    // Split is the point of no return — a clean failure means nothing moved
    // (the injected fee at worst leaves the neuron 0.0001 over-funded).
    let split_neuron_id = gov_split(neuron_id, amount_e8s.saturating_add(ICP_FEE_E8S))
        .await
        .map_err(|e| format!("SPLIT_FAILED: {}", e))?;

    let now = current_time();
    stake.amount_e8s -= amount_e8s;
    stake.last_action_at = now;
    if stake.amount_e8s == 0 {
        STAKES.with(|m| {
            m.borrow_mut().remove(&key);
        });
    } else {
        STAKES.with(|m| {
            m.borrow_mut().insert(key, stake);
        });
    }
    pool.total_staked_e8s = pool.total_staked_e8s.saturating_sub(amount_e8s);
    set_tier_pool(tier, pool);

    // Fully unstaked across every tier → lottery eligibility ends NOW:
    // current-round tickets are void, no future drawing can pick them.
    if !user_has_stake(caller) {
        void_current_round_tickets(caller);
    }

    let id = NEXT_UNSTAKE_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let delay_ns = tier.dissolve_delay_secs().saturating_mul(1_000_000_000);
    let mut pending = PendingUnstake {
        id,
        user: caller,
        tier,
        amount_e8s,
        split_neuron_id,
        status: UnstakeStatus::SplitDone,
        created_at: now,
        dissolve_eta: now.saturating_add(delay_ns),
        disburse_block: None,
        fee_refund_block: None,
        merged_into: None,
        child_e8s: Some(amount_e8s),
        settled_at: None,
    };
    // Best-effort StartDissolving; the sweep retries (and re-stamps the ETA).
    if gov_start_dissolving(split_neuron_id).await.is_ok() {
        pending.status = UnstakeStatus::Dissolving;
    }
    PENDING_UNSTAKES.with(|m| {
        m.borrow_mut().insert(id, pending);
    });
    staking_audit("unstake_split", caller, amount_e8s, id);
    Ok(id)
}

/// Merge a still-dissolving unstake neuron back into any tier pool — the
/// "changed my mind" path. The dissolve is stopped, the child's stake (minus
/// one ledger fee charged by governance on merge) joins the chosen tier, and
/// the user's stake there resumes earning weight and tickets immediately.
///
/// The platform's main neurons are merge TARGETS only, never sources: the
/// source must be a child tracked in PENDING_UNSTAKES, and is additionally
/// checked against every platform neuron id before any governance call.
#[ic_cdk::update]
async fn merge_unstake(unstake_id: u64, target_tier: StakeTier) -> Result<(), String> {
    require_authenticated()?;
    require_lossless_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;
    let _lock = StakingLock::new()?;

    let mut pending = PENDING_UNSTAKES
        .with(|m| m.borrow().get(&unstake_id))
        .ok_or("UNSTAKE_NOT_FOUND")?;
    if pending.user != caller {
        return Err("NOT_YOUR_UNSTAKE".to_string());
    }
    if !matches!(pending.status, UnstakeStatus::SplitDone | UnstakeStatus::Dissolving) {
        return Err("NOT_MERGEABLE".to_string());
    }
    let now = current_time();
    if now >= pending.dissolve_eta {
        // Fully dissolved — the sweep is about to disburse it; let it pay out.
        return Err("ALREADY_DISSOLVED".to_string());
    }

    let mut pool = tier_pool(target_tier);
    let target_neuron = pool.neuron_id.ok_or("POOL_NOT_READY")?;
    if pool.bootstrap != StakingBootstrap::Ready {
        return Err("POOL_NOT_READY".to_string());
    }

    // Hard guard: never let a platform neuron be the merge source.
    let source = pending.split_neuron_id;
    let mut platform_ids: Vec<u64> = [StakeTier::SixMonths, StakeTier::OneYear, StakeTier::TwoYears]
        .iter()
        .filter_map(|t| tier_pool(*t).neuron_id)
        .collect();
    if let Some(ea) = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().neuron_id) {
        platform_ids.push(ea);
    }
    if platform_ids.contains(&source) {
        return Err("SOURCE_IS_PLATFORM_NEURON".to_string());
    }

    // A dissolving neuron can't merge — stop the dissolve first. Both calls
    // are idempotent-safe: a failure after StopDissolving leaves the child
    // intact (not dissolving) and the unstake mergeable/retryable; the
    // dissolve clock only matters again if the user abandons the merge.
    gov_stop_dissolving(source)
        .await
        .map_err(|e| format!("STOP_DISSOLVE_FAILED: {}", e))?;
    // Governance charges one fee on merge — the treasury fronts it into the
    // target neuron so the user's FULL child amount restakes (keeps holdings
    // whole-ICP and the cycle zero-loss).
    fund_pool_neuron_from_treasury(&CONFIG.with(|c| c.borrow().get().clone()), &mut pool, target_tier, ICP_FEE_E8S).await?;
    gov_merge(target_neuron, source)
        .await
        .map_err(|e| format!("MERGE_FAILED: {}", e))?;

    let credited = unstake_child_e8s(&pending);
    pending.status = UnstakeStatus::Merged;
    pending.merged_into = Some(target_tier);
    pending.settled_at = Some(now);
    PENDING_UNSTAKES.with(|m| {
        m.borrow_mut().insert(unstake_id, pending);
    });

    let key = stake_key(target_tier, caller);
    let mut stake = STAKES.with(|m| m.borrow().get(&key)).unwrap_or(UserStake {
        amount_e8s: 0,
        staked_at: now,
        last_action_at: now,
    });
    stake.amount_e8s = stake.amount_e8s.saturating_add(credited);
    stake.last_action_at = now;
    STAKES.with(|m| {
        m.borrow_mut().insert(key, stake);
    });
    pool.total_staked_e8s = pool.total_staked_e8s.saturating_add(credited);
    set_tier_pool(target_tier, pool);

    staking_audit("unstake_merge", caller, credited, unstake_id);
    Ok(())
}

// ── Lossless voting ──

/// Cast a free vote with the caller's staked weight. NO ICP moves and nothing
/// is escrowed — this only bumps the proposal's staked-weight tallies. It
/// therefore has nothing to refund at settlement: the cutoff path only
/// settles burned COMMITMENTS, never LOSSLESS_VOTES. The weight joins the
/// adopt/reject balance of power AND can carry the proposal to its threshold;
/// one immutable vote per user per proposal, snapshotted at cast time.
#[ic_cdk::update]
fn cast_lossless_vote(proposal_id: u64, stance: Stance) -> Result<(), String> {
    require_authenticated()?;
    require_lossless_enabled()?;
    let caller = get_caller();

    // Weight = total staked ICP ÷ 10 (see staked_voting_power).
    let weight = user_voting_weight(caller);
    if weight == 0 {
        return Err("NO_STAKE".to_string());
    }

    let key = CommitmentKey {
        proposal_id,
        principal: caller,
    };
    if LOSSLESS_VOTES.with(|m| m.borrow().get(&key).is_some()) {
        return Err("ALREADY_VOTED".to_string());
    }

    let proposal = PROPOSALS.with(|map| map.borrow().get(&proposal_id));
    let mut proposal = match proposal {
        Some(p) => p,
        None => return Err("PROPOSAL_NOT_FOUND".to_string()),
    };
    if proposal.status != "open" && proposal.status != "met" {
        return Err("VOTING_CLOSED".to_string());
    }
    let now = current_time();
    if now >= proposal.deadline.saturating_sub(3_600_000_000_000) {
        return Err("VOTING_CLOSED".to_string());
    }

    if proposal.first_stance.is_none() {
        proposal.first_stance = Some(stance.clone());
    }
    if stance == Stance::Adopt {
        proposal.lossless_adopt_e8s = proposal
            .lossless_adopt_e8s
            .checked_add(weight)
            .ok_or("POT_OVERFLOW")?;
    } else {
        proposal.lossless_reject_e8s = proposal
            .lossless_reject_e8s
            .checked_add(weight)
            .ok_or("POT_OVERFLOW")?;
    }

    // Staked conviction counts toward the threshold too: when the combined
    // staked weight reaches the burn-ICP threshold the proposal is met.
    if proposal.status == "open" && proposal_threshold_met(&proposal) {
        proposal.status = "met".to_string();
    }

    LOSSLESS_VOTES.with(|m| {
        m.borrow_mut().insert(
            key,
            LosslessVote {
                proposal_id,
                principal: caller,
                stance,
                weight_e8s: weight,
                cast_at: now,
            },
        );
    });
    PROPOSALS.with(|map| {
        map.borrow_mut().insert(proposal_id, proposal);
    });
    staking_audit("lossless_vote", caller, weight, proposal_id);
    Ok(())
}

// ── Sweep: bootstrap repair, unstakes, maturity, yield ──

/// One pass of the staking machinery, run on the 5-minute timer. Skips the
/// tick entirely if a user call currently holds the lock.
async fn staking_sweep() {
    let _lock = match StakingLock::new() {
        Ok(l) => l,
        Err(_) => return,
    };

    if let Err(e) = advance_staking_bootstrap().await {
        canister_print(&format!("staking_sweep: bootstrap: {}", e));
    }
    process_pending_unstakes().await;
    harvest_staking_maturity().await;
    distribute_yield_inbox().await;
}

async fn process_pending_unstakes() {
    let now = current_time();

    let ledger_id = CONFIG.with(|c| c.borrow().get().ledger_canister_id);
    let open: Vec<PendingUnstake> = PENDING_UNSTAKES.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|u| u.status != UnstakeStatus::Disbursed || u.fee_refund_block.is_none())
            .collect()
    });

    for mut unstake in open {
        match unstake.status {
            UnstakeStatus::SplitDone => {
                if gov_start_dissolving(unstake.split_neuron_id).await.is_ok() {
                    let delay_ns =
                        unstake.tier.dissolve_delay_secs().saturating_mul(1_000_000_000);
                    unstake.status = UnstakeStatus::Dissolving;
                    unstake.dissolve_eta = now.saturating_add(delay_ns);
                    PENDING_UNSTAKES.with(|m| {
                        m.borrow_mut().insert(unstake.id, unstake);
                    });
                }
            }
            UnstakeStatus::Dissolving if now >= unstake.dissolve_eta => {
                match gov_disburse(unstake.split_neuron_id, unstake.user).await {
                    Ok(block) => {
                        unstake.disburse_block = Some(block);
                        unstake.status = UnstakeStatus::Disbursed;
                        unstake.settled_at = Some(now);
                        let user = unstake.user;
                        let amount = unstake.amount_e8s;
                        let id = unstake.id;
                        PENDING_UNSTAKES.with(|m| {
                            m.borrow_mut().insert(id, unstake.clone());
                        });
                        staking_audit("unstake_disbursed", user, amount, id);
                        record_payout(user, PayoutType::UnstakeDisbursement, IdeaToken::ICP, amount, id);
                        // Zero-loss: reimburse all cycle fees from the
                        // treasury right away (retried below if it fails).
                        settle_unstake_fee_refund(ledger_id, &mut unstake).await;
                    }
                    Err(e) => {
                        // Not dissolved yet, or transient — retry next tick.
                        canister_print(&format!(
                            "unstake {} disburse pending: {}",
                            unstake.id, e
                        ));
                    }
                }
            }
            UnstakeStatus::Disbursed if unstake.fee_refund_block.is_none() => {
                settle_unstake_fee_refund(ledger_id, &mut unstake).await;
            }
            _ => {}
        }
    }
}

/// Pay the user back every fee the stake/unstake cycle cost them, from the
/// treasury. Legacy unstakes: deposit + split + disburse = 0.0003 ICP. Since
/// the treasury began fronting the split fee at unstake (child_e8s set), the
/// refund is deposit + disburse = 0.0002 ICP. Idempotent via the persisted
/// block index; the sweep retries until the transfer lands.
async fn settle_unstake_fee_refund(ledger_id: Principal, unstake: &mut PendingUnstake) {
    if unstake.fee_refund_block.is_some() {
        return;
    }
    let refund = if unstake.child_e8s.is_some() {
        2 * ICP_FEE_E8S
    } else {
        STAKE_FEE_REIMBURSEMENT_E8S
    };
    let dest = LedgerAccount { owner: unstake.user, subaccount: None };
    match call_ledger_transfer(
        ledger_id,
        Some(TREASURY_SUBACCOUNT),
        dest,
        refund,
        Some(ICP_FEE_E8S),
    )
    .await
    {
        Ok(b) => {
            unstake.fee_refund_block = Some(b);
            PENDING_UNSTAKES.with(|m| {
                m.borrow_mut().insert(unstake.id, unstake.clone());
            });
            staking_audit("unstake_fee_refund", unstake.user, refund, unstake.id);
        }
        Err(e) => {
            canister_print(&format!("unstake {} fee refund pending: {}", unstake.id, e));
        }
    }
}

/// Harvest matured yield from every tier's neuron into the shared yield
/// inbox (each tier is independent — one failing doesn't block the others).
async fn harvest_staking_maturity() {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    for tier in StakeTier::all() {
        let mut pool = tier_pool(tier);
        let neuron_id = match pool.neuron_id {
            Some(id) if pool.bootstrap == StakingBootstrap::Ready => id,
            _ => continue,
        };

        let maturity = match staking_neuron_maturity(neuron_id).await {
            Ok(m) => m,
            Err(e) => {
                canister_print(&format!("maturity check failed ({:?}): {}", tier, e));
                continue;
            }
        };
        if maturity < config.maturity_threshold_e8s {
            continue;
        }

        if let Err(e) = gov_disburse_maturity(neuron_id).await {
            canister_print(&format!("disburse_maturity failed ({:?}): {}", tier, e));
            continue;
        }
        let now = current_time();
        // Local mocks mint instantly; the real NNS takes ~7 days.
        let expected_at = if config.is_local || cfg!(not(target_arch = "wasm32")) {
            now
        } else {
            now.saturating_add(MATURITY_MINT_DELAY_NANOS)
        };
        pool.pending_maturity.push(MaturityDisbursement {
            amount_e8s: maturity,
            initiated_at: now,
            expected_at,
        });
        if pool.pending_maturity.len() > MAX_PENDING_MATURITY {
            pool.pending_maturity.remove(0);
        }
        pool.total_yield_e8s = pool.total_yield_e8s.saturating_add(maturity);
        set_tier_pool(tier, pool);
        staking_audit("yield_harvest", get_canister_id(), maturity, neuron_id);
    }
}

async fn distribute_yield_inbox() {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());

    // Resume an unfinished distribution before opening a new one — its share
    // of the inbox balance is already earmarked by the persisted amounts.
    let unfinished: Option<YieldDistribution> = YIELD_DISTRIBUTIONS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .find(|d| d.status == YieldStatus::InProgress)
    });
    if let Some(mut dist) = unfinished {
        if let Err(e) = settle_yield_split(&mut dist).await {
            canister_print(&format!("yield distribution {} retry failed: {}", dist.id, e));
        }
        YIELD_DISTRIBUTIONS.with(|m| {
            m.borrow_mut().insert(dist.id, dist);
        });
        return;
    }

    let inbox = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(YIELD_INBOX_SUBACCOUNT),
    };
    let balance = match call_ledger_balance(config.ledger_canister_id, inbox).await {
        Ok(b) => b,
        Err(_) => return,
    };
    if balance < YIELD_MIN_DISTRIBUTION_E8S {
        return;
    }

    let spendable = balance - 2 * ICP_FEE_E8S;
    let lottery_amt = spendable / 2;
    let treasury_amt = spendable - lottery_amt;

    let id = NEXT_YIELD_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let mut dist = YieldDistribution {
        id,
        amount_e8s: balance,
        lottery_amount_e8s: lottery_amt,
        treasury_amount_e8s: treasury_amt,
        lottery_block: None,
        treasury_block: None,
        status: YieldStatus::InProgress,
        created_at: current_time(),
        completed_at: None,
    };
    // Persist the journal before any transfer so a trap can't lose the plan.
    YIELD_DISTRIBUTIONS.with(|m| {
        m.borrow_mut().insert(id, dist.clone());
    });
    if let Err(e) = settle_yield_split(&mut dist).await {
        canister_print(&format!("yield distribution {} incomplete: {}", id, e));
    }
    YIELD_DISTRIBUTIONS.with(|m| {
        m.borrow_mut().insert(id, dist);
    });
}

/// 50% → lottery prize pot, 50% → treasury. Idempotent via per-leg block
/// indices, like `settle_burn_split`.
async fn settle_yield_split(dist: &mut YieldDistribution) -> Result<(), String> {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;

    if dist.lottery_block.is_none() && dist.lottery_amount_e8s > 0 {
        let dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(LOTTERY_SUBACCOUNT),
        };
        let b = call_ledger_transfer(
            ledger_id,
            Some(YIELD_INBOX_SUBACCOUNT),
            dest,
            dist.lottery_amount_e8s,
            Some(ICP_FEE_E8S),
        )
        .await
        .map_err(|e| format!("YIELD_LOTTERY_XFER: {}", e))?;
        dist.lottery_block = Some(b);
        // Persist the leg immediately — a panic before the caller's insert
        // must never lose a completed transfer (double-pay risk).
        YIELD_DISTRIBUTIONS.with(|m| {
            m.borrow_mut().insert(dist.id, dist.clone());
        });
    }

    if dist.treasury_block.is_none() && dist.treasury_amount_e8s > 0 {
        let dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(TREASURY_SUBACCOUNT),
        };
        let b = call_ledger_transfer(
            ledger_id,
            Some(YIELD_INBOX_SUBACCOUNT),
            dest,
            dist.treasury_amount_e8s,
            Some(ICP_FEE_E8S),
        )
        .await
        .map_err(|e| format!("YIELD_TREASURY_XFER: {}", e))?;
        dist.treasury_block = Some(b);
        YIELD_DISTRIBUTIONS.with(|m| {
            m.borrow_mut().insert(dist.id, dist.clone());
        });
    }

    // Both legs done: close out and retire pending-maturity entries whose
    // mint window has passed.
    let now = current_time();
    dist.status = YieldStatus::Done;
    dist.completed_at = Some(now);
    for tier in StakeTier::all() {
        let mut pool = tier_pool(tier);
        let before = pool.pending_maturity.len();
        pool.pending_maturity.retain(|m| m.expected_at > now);
        if pool.pending_maturity.len() != before {
            set_tier_pool(tier, pool);
        }
    }
    let distributed = dist
        .lottery_amount_e8s
        .saturating_add(dist.treasury_amount_e8s);
    staking_audit("yield_distribution", get_canister_id(), distributed, dist.id);
    Ok(())
}

// ── Queries ──

#[ic_cdk::query]
fn get_my_stake() -> UserStakeInfo {
    let caller = get_caller();
    let mut tiers = Vec::new();
    let mut total = 0u64;
    let mut weight = 0u64;
    for tier in StakeTier::all() {
        if let Some(s) = STAKES.with(|m| m.borrow().get(&stake_key(tier, caller))) {
            // Voting power = staked ICP ÷ 10 (10 staked = 1 burned of weight).
            let w = staked_voting_power(s.amount_e8s);
            tiers.push(UserTierStake {
                tier,
                amount_e8s: s.amount_e8s,
                weight_e8s: w,
                staked_at: s.staked_at,
                last_action_at: s.last_action_at,
            });
            total = total.saturating_add(s.amount_e8s);
            weight = weight.saturating_add(w);
        }
    }
    let _ = weight; // per-tier sum kept for the rows; the headline total uses
    // the same single-division formula as the cast-time weight.
    UserStakeInfo {
        tiers,
        total_staked_e8s: total,
        total_weight_e8s: staked_voting_power(total),
    }
}

#[ic_cdk::query]
fn get_staking_pool_info() -> StakingPoolInfo {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ticket_base = config.lottery_tickets_per_day;
    let mut pools = Vec::new();
    let mut total_staked = 0u64;
    let mut total_yield = 0u64;
    for tier in StakeTier::all() {
        let pool = tier_pool(tier);
        let staker_count = STAKES.with(|m| {
            m.borrow()
                .iter()
                .filter(|e| e.key().tier == tier.idx())
                .count() as u64
        });
        total_staked = total_staked.saturating_add(pool.total_staked_e8s);
        total_yield = total_yield.saturating_add(pool.total_yield_e8s);
        pools.push(TierPoolInfo {
            tier,
            dissolve_delay_secs: tier.dissolve_delay_secs(),
            weight_multiplier: tier.weight_multiplier(),
            daily_tickets: ticket_base.saturating_mul(tier.weight_multiplier()),
            neuron_id: pool.neuron_id,
            total_staked_e8s: pool.total_staked_e8s,
            staker_count,
            bootstrap: pool.bootstrap,
            pending_refresh_e8s: pool.pending_refresh_e8s,
            pending_maturity: pool.pending_maturity,
            total_yield_e8s: pool.total_yield_e8s,
        });
    }
    StakingPoolInfo {
        pools,
        total_staked_e8s: total_staked,
        min_stake_e8s: config.min_stake_e8s,
        min_unstake_e8s: config.min_unstake_e8s,
        total_yield_e8s: total_yield,
    }
}

#[ic_cdk::query]
fn list_my_pending_unstakes() -> Vec<PendingUnstake> {
    let caller = get_caller();
    PENDING_UNSTAKES.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|u| u.user == caller)
            .collect()
    })
}

#[ic_cdk::query]
fn get_my_lossless_votes() -> Vec<LosslessVote> {
    let caller = get_caller();
    LOSSLESS_VOTES.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|v| v.principal == caller)
            .collect()
    })
}

#[ic_cdk::query]
fn list_yield_distributions() -> Vec<YieldDistribution> {
    YIELD_DISTRIBUTIONS.with(|m| m.borrow().iter().map(|e| e.value()).collect())
}

// ── Admin & dev ──

/// Admin: tune the staking parameters. Pass null to leave a value unchanged.
/// (Dissolve delays are fixed per tier — 6 months / 1 year / 2 years — and
/// not configurable.)
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_staking_config(
    min_stake_e8s: Option<u64>,
    min_unstake_e8s: Option<u64>,
    maturity_threshold_e8s: Option<u64>,
) -> Result<(), String> {
    CONFIG.with(|cell| {
        let mut config = cell.borrow().get().clone();
        if let Some(m) = min_stake_e8s {
            if m == 0 {
                return Err("INVALID_MIN_STAKE".to_string());
            }
            config.min_stake_e8s = m;
        }
        if let Some(m) = min_unstake_e8s {
            // Floor is exactly 1 ICP: the treasury fronts the split fee, so
            // the child neuron holds the full requested amount (NNS minimum).
            if m < ONE_ICP_E8S {
                return Err("INVALID_MIN_UNSTAKE".to_string());
            }
            config.min_unstake_e8s = m;
        }
        if let Some(m) = maturity_threshold_e8s {
            if m < 105_000_000 {
                return Err("INVALID_MATURITY_THRESHOLD".to_string());
            }
            config.maturity_threshold_e8s = m;
        }
        cell.borrow_mut().set(config);
        Ok(())
    })
}

fn require_local_dev() -> Result<(), String> {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    if !config.is_local
        || config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
    {
        return Err("DEV_ONLY".to_string());
    }
    Ok(())
}

/// Local-dev: run one staking sweep pass immediately (instead of waiting for
/// the 5-minute timer).
#[ic_cdk::update]
async fn dev_run_staking_sweep() -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    staking_sweep().await;
    Ok(())
}

/// Local-dev: make a pending unstake disbursable right now (clears both the
/// record's ETA and the mock neuron's dissolve clock).
#[ic_cdk::update]
fn dev_fast_forward_dissolve(unstake_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    let mut unstake = PENDING_UNSTAKES
        .with(|m| m.borrow().get(&unstake_id))
        .ok_or("UNSTAKE_NOT_FOUND")?;
    let now = current_time();
    unstake.dissolve_eta = now;
    PENDING_UNSTAKES.with(|m| {
        m.borrow_mut().insert(unstake_id, unstake.clone());
    });
    MOCK_GOV.with(|g| {
        if let Some(n) = g.borrow_mut().neurons.get_mut(&unstake.split_neuron_id) {
            n.dissolve_eta = now;
        }
    });
    Ok(())
}

/// Local-dev: credit simulated maturity to one tier's mock pool neuron so
/// the yield harvest + distribution can be exercised end-to-end.
#[ic_cdk::update]
fn dev_add_mock_maturity(amount_e8s: u64, tier: StakeTier) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    let pool = tier_pool(tier);
    let neuron_id = pool.neuron_id.ok_or("POOL_NOT_READY")?;
    MOCK_GOV.with(|g| {
        let mut g = g.borrow_mut();
        let neuron = g
            .neurons
            .get_mut(&neuron_id)
            .ok_or_else(|| "MOCK_NEURON_NOT_FOUND".to_string())?;
        neuron.maturity_e8s = neuron.maturity_e8s.saturating_add(amount_e8s);
        Ok(())
    })
}

// ==========================================
// 14. Lossless Lottery (Powerball-style) + Payout History
// ==========================================
//
// Every signed-in user collects tickets daily (admin-tunable, default 10).
// Draws copy the American Powerball: jackpot odds of 1 in 292,201,338 per
// ticket, three draws a week (Mon/Wed/Sat nights US Eastern — fixed here as
// the corresponding Tue/Thu/Sun 03:00 UTC instants). Tickets accumulate
// across draws until someone wins, then the round restarts. The prize pool is
// the staking-yield lottery pot (LOTTERY_SUBACCOUNT): a winner takes 80%, the
// remaining 20% seeds the next round. Feature-flagged via FLAG_LOSSLESS_LOTTERY
// (ships dark). Payout history records every ICP/token payout the site makes
// to a user (lottery wins, unstake disbursements, upvote shares, refunds).

/// Powerball jackpot odds: 5-of-69 white balls + 1-of-26 red ball.
/// Dynamic-odds cadence: every draw has a 1-in-N chance of crowning a winner
/// REGARDLESS of how many tickets exist (the denominator scales with the
/// ticket supply). With 3 draws/week (≈13/month) and N = 13, a jackpot lands
/// about once a month in expectation, and the chance of at least one winner
/// within 3 months is 1 − (12/13)^39 ≈ 96%. Replaces the original fixed
/// Powerball denominator (292,201,338), which made wins effectively
/// impossible at launch-scale ticket counts.
const LOTTERY_DRAWS_PER_WIN: u64 = 13;

/// A drawing only actually runs when the pot holds at least this much (50
/// ICP). The countdown always ticks; the pot check happens at the scheduled
/// moment — too small, and the drawing rolls over to the next slot (no
/// randomness consumed, no draw record). Forced dev draws bypass the gate.
const LOTTERY_MIN_POT_E8S: u64 = 5_000_000_000;

/// The ticket-space size for a draw: total × 13, so P(some ticket wins) is
/// exactly 1/13 and every ticket inside the winning range is equally likely
/// — i.e. each user's win chance is their stake-weighted share of tickets.
fn lottery_odds_denominator(total_tickets: u64) -> u64 {
    total_tickets.max(1).saturating_mul(LOTTERY_DRAWS_PER_WIN)
}
/// Winner takes 80% of the pot; 20% stays for the next drawing.
const LOTTERY_WINNER_SHARE_PCT: u64 = 80;
/// Draw instant within a draw day (≈ Powerball's 22:59 US Eastern the night
/// before, expressed in UTC).
const LOTTERY_DRAW_HOUR_UTC: u64 = 3;
const SECS_PER_DAY: u64 = 86_400;
/// Keep the most recent draws only (3/week — ~3 years of history).
const MAX_LOTTERY_DRAWS_KEPT: u64 = 500;
/// Cap a single payout-history response.
const MAX_PAYOUTS_RETURNED: usize = 200;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LotteryState {
    /// Bumps by one each time a jackpot is actually won; ticket entries from
    /// older rounds are dead and lazily reset on the user's next claim.
    pub round: u64,
    /// Tickets issued in the current round (kept in lockstep with claims).
    pub total_tickets: u64,
    /// Nanosecond timestamp of the next scheduled draw (0 = not yet scheduled).
    pub next_draw_at: u64,
    pub draws_held: u64,
    pub last_winner: Option<Principal>,
    pub last_win_at: Option<u64>,
    /// Lifetime ICP e8s actually paid out to winners (net of the ledger fee).
    pub total_paid_e8s: u64,
}

impl Default for LotteryState {
    fn default() -> Self {
        LotteryState {
            round: 1,
            total_tickets: 0,
            next_draw_at: 0,
            draws_held: 0,
            last_winner: None,
            last_win_at: None,
            total_paid_e8s: 0,
        }
    }
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TicketEntry {
    pub round: u64,
    pub count: u64,
    /// UTC epoch-day of the most recent claim (one claim per day).
    pub last_claim_day: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum DrawStatus {
    /// A winner was drawn but the prize transfer hasn't succeeded yet; the
    /// 5-minute timer retries until it lands. Tickets are already reset.
    PayoutPending,
    Done,
}

/// Journal for one drawing — persisted before the prize transfer so a trap
/// can't lose (or double-pay) a win. Same idempotency pattern as
/// `settle_burn_split` / `settle_yield_split`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LotteryDraw {
    pub id: u64,
    pub round: u64,
    pub drawn_at: u64,
    pub total_tickets: u64,
    /// Lottery-pot balance at draw time.
    pub pot_e8s: u64,
    /// The random index in [0, total_tickets × 13); a ticket wins when
    /// this lands below `total_tickets`.
    pub winning_ticket: Option<u64>,
    pub winner: Option<Principal>,
    /// Gross 80% prize (the winner nets this minus one ledger fee).
    pub prize_e8s: u64,
    pub payout_block: Option<u64>,
    pub status: DrawStatus,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutType {
    LotteryWin,
    UnstakeDisbursement,
    IdeaUpvoteShare,
    CommitmentRefund,
    /// 25% of a settled burn, split among the top pool neurons' owners.
    PoolReward,
    /// A claimed monthly Early Adopter yield share.
    EarlyAdopterYield,
}

/// One payout the site made to a user, in the token's smallest unit. Drives
/// the "Payout history" page.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Payout {
    pub id: u64,
    pub user: Principal,
    pub payout_type: PayoutType,
    pub token: IdeaToken,
    pub amount: u64,
    pub created_at: u64,
    /// Source record id (draw id, unstake id, upvote id, proposal id).
    pub ref_id: u64,
}

/// Everything the Lottery page needs in one call (update — it reads the pot
/// balance from the ledger).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LotteryInfo {
    pub enabled: bool,
    pub round: u64,
    pub next_draw_at: u64,
    pub total_tickets: u64,
    pub my_tickets: u64,
    pub claimed_today: bool,
    /// Whether the caller holds any stake (the eligibility gate).
    pub eligible: bool,
    /// True when the caller is an admin — admins never hold tickets.
    pub admin_excluded: bool,
    /// Base daily grant for a 6-month staker (admin-tunable).
    pub tickets_per_day: u64,
    /// The caller's actual daily grant across their staked tiers (0 = not
    /// staked / not eligible).
    pub my_daily_tickets: u64,
    pub pot_e8s: u64,
    pub odds_denominator: u64,
    /// Drawings only run when the pot holds at least this much (rolls over
    /// otherwise). The countdown still ticks below the line.
    pub min_pot_e8s: u64,
    pub draws_held: u64,
    pub last_winner: Option<Principal>,
    pub last_win_at: Option<u64>,
    pub total_paid_e8s: u64,
}

impl_storable!(LotteryState);
impl_storable!(TicketEntry);
impl_storable!(LotteryDraw);
impl_storable!(Payout);

thread_local! {
    // Memory IDs 26–31 (mini golf) and 32–33 (AI reviewer) are reserved by
    // their plan docs — the lottery starts at 34.
    static LOTTERY_TICKETS: RefCell<StableBTreeMap<Principal, TicketEntry, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(34))))
    });

    static LOTTERY_STATE: RefCell<StableCell<LotteryState, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(35)), LotteryState::default()))
    });

    static LOTTERY_DRAWS: RefCell<StableBTreeMap<u64, LotteryDraw, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(36))))
    });

    static NEXT_DRAW_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(37)), 1u64))
    });

    static PAYOUTS: RefCell<StableBTreeMap<u64, Payout, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(38))))
    });

    static NEXT_PAYOUT_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(39)), 1u64))
    });

    static LOTTERY_BUSY: RefCell<bool> = const { RefCell::new(false) };

    #[cfg(not(target_arch = "wasm32"))]
    static TEST_MOCK_RAND: RefCell<u64> = const { RefCell::new(u64::MAX) };
}

/// Serializes draws (timer tick vs. dev trigger) the same way StakingLock
/// serializes neuron operations.
struct LotteryLock;

impl LotteryLock {
    fn new() -> Result<Self, String> {
        LOTTERY_BUSY.with(|b| {
            let mut busy = b.borrow_mut();
            if *busy {
                return Err("LOTTERY_BUSY".to_string());
            }
            *busy = true;
            Ok(LotteryLock)
        })
    }
}

impl Drop for LotteryLock {
    fn drop(&mut self) {
        LOTTERY_BUSY.with(|b| *b.borrow_mut() = false);
    }
}

fn lottery_state() -> LotteryState {
    LOTTERY_STATE.with(|c| c.borrow().get().clone())
}

fn set_lottery_state(state: LotteryState) {
    LOTTERY_STATE.with(|c| {
        c.borrow_mut().set(state);
    });
}

fn require_lottery_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_LOSSLESS_LOTTERY) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

/// Next draw instant strictly after `now_nanos`. Draw days are Tue/Thu/Sun in
/// UTC (= Powerball's Mon/Wed/Sat nights US Eastern), at 03:00 UTC.
fn next_draw_after(now_nanos: u64) -> u64 {
    let today = now_nanos / 1_000_000_000 / SECS_PER_DAY;
    for offset in 0..=7 {
        let day = today + offset;
        // 1970-01-01 was a Thursday, so (day + 4) % 7 gives 0 = Sunday.
        let dow = (day + 4) % 7;
        if matches!(dow, 0 | 2 | 4) {
            let t = (day * SECS_PER_DAY + LOTTERY_DRAW_HOUR_UTC * 3600) * 1_000_000_000;
            if t > now_nanos {
                return t;
            }
        }
    }
    // Unreachable (a draw day always occurs within the next 7 days), but
    // never trap inside the timer.
    now_nanos + 2 * SECS_PER_DAY * 1_000_000_000
}

fn record_payout(user: Principal, payout_type: PayoutType, token: IdeaToken, amount: u64, ref_id: u64) {
    let id = NEXT_PAYOUT_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    PAYOUTS.with(|m| {
        m.borrow_mut().insert(id, Payout {
            id,
            user,
            payout_type,
            token,
            amount,
            created_at: current_time(),
            ref_id,
        });
    });
}

#[cfg(target_arch = "wasm32")]
async fn lottery_random_u64() -> Result<u64, String> {
    let response: Result<(Vec<u8>,), _> =
        ic_cdk::call(Principal::management_canister(), "raw_rand", ()).await;
    match response {
        Ok((bytes,)) if bytes.len() >= 8 => {
            Ok(u64::from_le_bytes(bytes[..8].try_into().unwrap()))
        }
        Ok(_) => Err("RAW_RAND_TOO_SHORT".to_string()),
        Err((code, msg)) => Err(format!("raw_rand failed (code {:?}): {}", code, msg)),
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn lottery_random_u64() -> Result<u64, String> {
    Ok(TEST_MOCK_RAND.with(|c| *c.borrow()))
}

/// Uniform owner lookup for a winning ticket index within the current round:
/// tickets are implicitly ordered by the stable map's principal order.
fn find_ticket_owner(round: u64, index: u64) -> Option<Principal> {
    LOTTERY_TICKETS.with(|m| {
        let mut cumulative = 0u64;
        for entry in m.borrow().iter() {
            let t = entry.value();
            if t.round != round {
                continue;
            }
            cumulative = cumulative.saturating_add(t.count);
            if index < cumulative {
                return Some(*entry.key());
            }
        }
        None
    })
}

/// Timer hook: retry an unfinished prize payout first, then hold a draw once
/// the scheduled instant passes.
async fn lottery_draw_check() {
    if !feature_enabled(FLAG_LOSSLESS_LOTTERY) {
        return;
    }
    let _lock = match LotteryLock::new() {
        Ok(l) => l,
        Err(_) => return,
    };

    let pending: Option<LotteryDraw> = LOTTERY_DRAWS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .find(|d| d.status == DrawStatus::PayoutPending)
    });
    if let Some(mut draw) = pending {
        if let Err(e) = settle_lottery_payout(&mut draw).await {
            canister_print(&format!("lottery draw {} payout retry failed: {}", draw.id, e));
        }
        LOTTERY_DRAWS.with(|m| {
            m.borrow_mut().insert(draw.id, draw);
        });
        return;
    }

    let mut state = lottery_state();
    let now = current_time();
    if state.next_draw_at == 0 {
        state.next_draw_at = next_draw_after(now);
        set_lottery_state(state);
        return;
    }
    if now < state.next_draw_at {
        return;
    }
    run_lottery_draw(None).await;
}

/// Hold one drawing. `forced_winning_ticket` is the local-dev override; live
/// draws take 8 bytes from `raw_rand`. The schedule is advanced and persisted
/// BEFORE any await so a failure can never double-draw the same slot.
async fn run_lottery_draw(forced_winning_ticket: Option<u64>) {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let now = current_time();
    let mut state = lottery_state();

    // The countdown always advances to the next slot — whether or not this
    // drawing actually runs is decided right now, at the scheduled moment.
    state.next_draw_at = next_draw_after(now.max(state.next_draw_at));
    set_lottery_state(state.clone());

    let pot_account = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(LOTTERY_SUBACCOUNT),
    };
    let pot_e8s = call_ledger_balance(config.ledger_canister_id, pot_account)
        .await
        .unwrap_or(0);

    // Last-minute go/no-go: below the minimum pot the drawing rolls over —
    // no randomness, no draw record, draws_held untouched.
    if forced_winning_ticket.is_none() && pot_e8s < LOTTERY_MIN_POT_E8S {
        canister_print(&format!(
            "lottery drawing skipped: pot {} e8s below the {} e8s minimum — rolls over",
            pot_e8s, LOTTERY_MIN_POT_E8S
        ));
        return;
    }

    let mut state = lottery_state();
    state.draws_held += 1;
    set_lottery_state(state.clone());

    let winning_ticket = match forced_winning_ticket {
        Some(t) => t,
        None => match lottery_random_u64().await {
            // Modulo bias over 2^64 is negligible at these denominators.
            Ok(r) => r % lottery_odds_denominator(state.total_tickets),
            Err(e) => {
                canister_print(&format!("lottery draw skipped, no randomness: {}", e));
                return;
            }
        },
    };

    // A win needs a hit ticket AND a prize big enough to actually transfer —
    // otherwise the drawing rolls over (tickets keep accumulating).
    let prize_e8s = pot_e8s.saturating_mul(LOTTERY_WINNER_SHARE_PCT) / 100;
    let winner = if winning_ticket < state.total_tickets && prize_e8s > ICP_FEE_E8S {
        find_ticket_owner(state.round, winning_ticket)
    } else {
        None
    };

    let id = NEXT_DRAW_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    });
    let mut draw = LotteryDraw {
        id,
        round: state.round,
        drawn_at: now,
        total_tickets: state.total_tickets,
        pot_e8s,
        winning_ticket: Some(winning_ticket),
        winner,
        prize_e8s: if winner.is_some() { prize_e8s } else { 0 },
        payout_block: None,
        status: if winner.is_some() { DrawStatus::PayoutPending } else { DrawStatus::Done },
    };
    LOTTERY_DRAWS.with(|m| {
        m.borrow_mut().insert(id, draw.clone());
    });

    if let Some(winner) = winner {
        // The win is final the moment the draw record persists: restart the
        // round (tickets reset) regardless of when the transfer lands.
        let mut state = lottery_state();
        state.round += 1;
        state.total_tickets = 0;
        state.last_winner = Some(winner);
        state.last_win_at = Some(now);
        set_lottery_state(state);

        if let Err(e) = settle_lottery_payout(&mut draw).await {
            canister_print(&format!("lottery draw {} payout pending: {}", id, e));
        }
        LOTTERY_DRAWS.with(|m| {
            m.borrow_mut().insert(id, draw);
        });
    }

    // Prune ancient draws so the history map stays bounded.
    LOTTERY_DRAWS.with(|m| {
        let mut m = m.borrow_mut();
        while m.len() > MAX_LOTTERY_DRAWS_KEPT {
            let oldest = m.iter().next().map(|e| *e.key());
            match oldest {
                Some(k) => {
                    m.remove(&k);
                }
                None => break,
            }
        }
    });
}

/// Transfer 80% of the pot (minus one ledger fee) to the winner. Idempotent:
/// the persisted block index makes a retry skip the transfer.
async fn settle_lottery_payout(draw: &mut LotteryDraw) -> Result<(), String> {
    let winner = draw.winner.ok_or("NO_WINNER")?;
    let net_prize = draw.prize_e8s.saturating_sub(ICP_FEE_E8S);
    if draw.payout_block.is_none() {
        let ledger_id = CONFIG.with(|c| c.borrow().get().ledger_canister_id);
        let dest = LedgerAccount { owner: winner, subaccount: None };
        let b = call_ledger_transfer(
            ledger_id,
            Some(LOTTERY_SUBACCOUNT),
            dest,
            net_prize,
            Some(ICP_FEE_E8S),
        )
        .await
        .map_err(|e| format!("LOTTERY_PRIZE_XFER: {}", e))?;
        draw.payout_block = Some(b);
        // Persist the block index immediately — a panic before the caller's
        // insert must never let a retry re-pay the prize.
        LOTTERY_DRAWS.with(|m| {
            m.borrow_mut().insert(draw.id, draw.clone());
        });
    }
    draw.status = DrawStatus::Done;

    let mut state = lottery_state();
    state.total_paid_e8s = state.total_paid_e8s.saturating_add(net_prize);
    set_lottery_state(state);
    record_payout(winner, PayoutType::LotteryWin, IdeaToken::ICP, net_prize, draw.id);
    staking_audit("lottery_win", winner, net_prize, draw.id);
    Ok(())
}

// ── User endpoints ──

fn is_admin_principal(user: Principal) -> bool {
    CONFIG.with(|c| c.borrow().get().admins.contains(&user))
}

/// Zero out the user's current-round tickets the moment they become
/// ineligible (full unstake, or promotion to admin). Eligibility is a LIVE
/// requirement: no stake → no shot at the next drawing, even with tickets
/// already claimed this round. Keeps `last_claim_day` so re-staking the same
/// day can't double-claim the daily grant.
fn void_current_round_tickets(user: Principal) {
    let mut state = lottery_state();
    if let Some(mut entry) = LOTTERY_TICKETS.with(|m| m.borrow().get(&user)) {
        if entry.round == state.round && entry.count > 0 {
            state.total_tickets = state.total_tickets.saturating_sub(entry.count);
            entry.count = 0;
            LOTTERY_TICKETS.with(|m| {
                m.borrow_mut().insert(user, entry);
            });
            set_lottery_state(state);
        }
    }
}

/// Tickets the user collects per login day: the base grant × the term
/// multiplier, summed over every tier they hold a stake in (6mo = 1×,
/// 1y = 2×, 2y = 4× — i.e. 5/10/20 at the default base of 5). Zero when
/// not staked: staking is the lottery eligibility gate. Admins are excluded
/// outright — the house never holds tickets.
fn user_daily_tickets(user: Principal) -> u64 {
    if is_admin_principal(user) {
        return 0;
    }
    let base = CONFIG.with(|c| c.borrow().get().lottery_tickets_per_day);
    // Stake-weighted: base × term multiplier × whole ICP staked in the tier
    // (1 ICP for 6 months = base/day; 500 ICP for 2 years = base × 4 × 500).
    // Sub-1-ICP stakes still earn one base unit so small stakers participate.
    StakeTier::all().iter().fold(0u64, |acc, &tier| {
        let staked_e8s = STAKES
            .with(|m| m.borrow().get(&stake_key(tier, user)))
            .map(|s| s.amount_e8s)
            .unwrap_or(0);
        if staked_e8s > 0 {
            let whole_icp = (staked_e8s / ONE_ICP_E8S).max(1);
            acc.saturating_add(
                base.saturating_mul(tier.weight_multiplier()).saturating_mul(whole_icp),
            )
        } else {
            acc
        }
    })
}

/// Credit today's tickets (once per UTC day). Requires an active stake —
/// the grant scales with the staked tiers (see `user_daily_tickets`). The
/// frontend calls this on login / page load; returns the caller's
/// current-round ticket count.
#[ic_cdk::update]
fn claim_daily_tickets() -> Result<u64, String> {
    require_authenticated()?;
    require_lottery_enabled()?;
    let caller = get_caller();
    if is_admin_principal(caller) {
        return Err("ADMINS_EXCLUDED".to_string());
    }
    let now = current_time();
    let today = now / 1_000_000_000 / SECS_PER_DAY;
    let per_day = user_daily_tickets(caller);
    if per_day == 0 {
        return Err("NOT_STAKED".to_string());
    }

    let mut state = lottery_state();
    let mut entry = LOTTERY_TICKETS
        .with(|m| m.borrow().get(&caller))
        .unwrap_or(TicketEntry { round: state.round, count: 0, last_claim_day: 0 });
    if entry.round != state.round {
        // Stale tickets from a finished round die here.
        entry = TicketEntry { round: state.round, count: 0, last_claim_day: entry.last_claim_day };
    }
    if entry.last_claim_day >= today {
        return Err("ALREADY_CLAIMED_TODAY".to_string());
    }
    entry.count = entry.count.saturating_add(per_day);
    entry.last_claim_day = today;
    state.total_tickets = state.total_tickets.saturating_add(per_day);
    if state.next_draw_at == 0 {
        state.next_draw_at = next_draw_after(now);
    }
    LOTTERY_TICKETS.with(|m| {
        m.borrow_mut().insert(caller, entry.clone());
    });
    set_lottery_state(state);
    Ok(entry.count)
}

/// Update (not query): reads the live pot balance from the ledger. Safe for
/// anonymous callers — `my_tickets` is simply 0.
#[ic_cdk::update]
async fn get_lottery_info() -> LotteryInfo {
    let caller = get_caller();
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let enabled = feature_enabled(FLAG_LOSSLESS_LOTTERY);
    let state = lottery_state();
    let today = current_time() / 1_000_000_000 / SECS_PER_DAY;

    let pot_e8s = if enabled {
        let pot_account = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(LOTTERY_SUBACCOUNT),
        };
        call_ledger_balance(config.ledger_canister_id, pot_account)
            .await
            .unwrap_or(0)
    } else {
        0
    };

    let entry = LOTTERY_TICKETS.with(|m| m.borrow().get(&caller));
    let (my_tickets, claimed_today) = match entry {
        Some(t) => (
            if t.round == state.round { t.count } else { 0 },
            t.last_claim_day >= today,
        ),
        None => (0, false),
    };
    let my_daily_tickets = user_daily_tickets(caller);

    LotteryInfo {
        enabled,
        round: state.round,
        next_draw_at: state.next_draw_at,
        total_tickets: state.total_tickets,
        my_tickets,
        claimed_today,
        eligible: my_daily_tickets > 0,
        admin_excluded: is_admin_principal(caller),
        tickets_per_day: config.lottery_tickets_per_day,
        my_daily_tickets,
        pot_e8s,
        odds_denominator: lottery_odds_denominator(state.total_tickets),
        min_pot_e8s: LOTTERY_MIN_POT_E8S,
        draws_held: state.draws_held,
        last_winner: state.last_winner,
        last_win_at: state.last_win_at,
        total_paid_e8s: state.total_paid_e8s,
    }
}

/// Most recent drawings, newest first (capped at 50).
#[ic_cdk::query]
fn list_lottery_draws() -> Vec<LotteryDraw> {
    LOTTERY_DRAWS.with(|m| {
        m.borrow().iter().rev().take(50).map(|e| e.value()).collect()
    })
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxDirection {
    In,
    Out,
}

/// One row of the Profile page's transaction history: everything the user
/// paid the site (escrow deposits, fees, stakes) and everything the site
/// paid them (the payout records), unified and newest-first.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TransactionRecord {
    pub direction: TxDirection,
    /// Machine-readable kind: payout-type names for In ("LotteryWin", …);
    /// audit event names for Out ("deposit", "idea_post", "stake", …).
    pub kind: String,
    pub token: IdeaToken,
    pub amount: u64,
    pub timestamp: u64,
    pub ref_id: u64,
}

const MAX_TX_RETURNED: usize = 200;
/// How far back in the audit log a transaction query scans (newest entries).
const TX_AUDIT_SCAN: u64 = 2_000;

/// The caller's full transaction history — spends AND payouts. Out legs come
/// from the audit log (ICP flows: commits, idea posts, pool fees, stake
/// lockups) plus the token-typed upvote/funding journals; In legs are the
/// payout records. Newest first, capped.
#[ic_cdk::query]
fn get_my_transactions() -> Vec<TransactionRecord> {
    let caller = get_caller();
    let mut txs: Vec<TransactionRecord> = Vec::new();

    // In: every payout the site made to the caller.
    PAYOUTS.with(|m| {
        for e in m.borrow().iter() {
            let p = e.value();
            if p.user == caller {
                txs.push(TransactionRecord {
                    direction: TxDirection::In,
                    kind: format!("{:?}", p.payout_type),
                    token: p.token,
                    amount: p.amount,
                    timestamp: p.created_at,
                    ref_id: p.ref_id,
                });
            }
        }
    });

    // Out (ICP): from the audit log's recent window. "stake" is a lockup,
    // not a spend — it's included so the history nets out against the
    // matching UnstakeDisbursement.
    AUDIT_LOG.with(|log| {
        let log = log.borrow();
        let len = log.len();
        let start = len.saturating_sub(TX_AUDIT_SCAN);
        for idx in start..len {
            let Some(entry) = log.get(idx) else { continue };
            if entry.user != caller {
                continue;
            }
            if matches!(
                entry.event_type.as_str(),
                "deposit" | "add_commitment" | "idea_post" | "pool_register" | "stake"
            ) {
                txs.push(TransactionRecord {
                    direction: TxDirection::Out,
                    kind: entry.event_type.clone(),
                    token: IdeaToken::ICP,
                    amount: entry.amount_e8s,
                    timestamp: entry.timestamp,
                    ref_id: entry.proposal_id,
                });
            }
        }
    });

    // Out (token-typed): upvotes and project fundings carry their own token.
    IDEA_UPVOTES.with(|m| {
        for e in m.borrow().iter() {
            let uv = e.value();
            if uv.voter == caller {
                txs.push(TransactionRecord {
                    direction: TxDirection::Out,
                    kind: "idea_upvote".to_string(),
                    token: uv.token,
                    amount: uv.amount,
                    timestamp: uv.created_at,
                    ref_id: uv.idea_id,
                });
            }
        }
    });
    PROJECT_FUNDINGS.with(|m| {
        for e in m.borrow().iter() {
            let f = e.value();
            if f.funder == caller {
                txs.push(TransactionRecord {
                    direction: TxDirection::Out,
                    kind: "project_fund".to_string(),
                    token: f.token,
                    amount: f.amount,
                    timestamp: f.created_at,
                    ref_id: f.project_id,
                });
            }
        }
    });

    txs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    txs.truncate(MAX_TX_RETURNED);
    txs
}

/// The caller's payout history, newest first (capped).
#[ic_cdk::query]
fn get_my_payouts() -> Vec<Payout> {
    let caller = get_caller();
    PAYOUTS.with(|m| {
        m.borrow()
            .iter()
            .rev()
            .filter(|e| e.value().user == caller)
            .take(MAX_PAYOUTS_RETURNED)
            .map(|e| e.value())
            .collect()
    })
}

/// The last 10 winning drawings, newest first — the public winners board.
#[ic_cdk::query]
fn list_recent_winners() -> Vec<LotteryDraw> {
    LOTTERY_DRAWS.with(|m| {
        m.borrow()
            .iter()
            .rev()
            .filter(|e| e.value().winner.is_some())
            .take(10)
            .map(|e| e.value())
            .collect()
    })
}

/// The lottery prize-pot account. Anyone may top it up (sweeten the pot) by
/// transferring ICP here — the funds become part of the next jackpots.
#[ic_cdk::query]
fn get_lottery_pot_address() -> LedgerAccount {
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(LOTTERY_SUBACCOUNT),
    }
}

// ── Admin & dev ──

/// Admin: tune how many tickets a daily login credits.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_lottery_config(tickets_per_day: Option<u64>) -> Result<(), String> {
    CONFIG.with(|cell| {
        let mut config = cell.borrow().get().clone();
        if let Some(t) = tickets_per_day {
            if !(1..=10_000).contains(&t) {
                return Err("INVALID_TICKETS_PER_DAY".to_string());
            }
            config.lottery_tickets_per_day = t;
        }
        cell.borrow_mut().set(config);
        Ok(())
    })
}

/// Local-dev: hold a drawing immediately. `force_win` rigs the winning ticket
/// to index 0 so the full payout path can be exercised without 1-in-292M luck.
#[ic_cdk::update]
async fn dev_run_lottery_draw(force_win: bool) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    require_lottery_enabled()?;
    let _lock = LotteryLock::new()?;
    if force_win && lottery_state().total_tickets == 0 {
        return Err("NO_TICKETS".to_string());
    }
    run_lottery_draw(if force_win { Some(0) } else { None }).await;
    Ok(())
}

/// Local-dev: seed a varied set of mock payout records for the caller so the
/// Profile page has realistic data. No-op if the caller already has payouts.
#[ic_cdk::update]
fn dev_seed_payouts() -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    let caller = get_caller();
    let already = PAYOUTS.with(|m| m.borrow().iter().any(|e| e.value().user == caller));
    if already {
        return Ok(());
    }
    let now = current_time();
    let day = 86_400u64 * 1_000_000_000;
    let seeds: [(PayoutType, IdeaToken, u64, u64, u64); 6] = [
        (PayoutType::LotteryWin, IdeaToken::ICP, 399_990_000, 1, 1),
        (PayoutType::UnstakeDisbursement, IdeaToken::ICP, 150_000_000, 2, 3),
        (PayoutType::IdeaUpvoteShare, IdeaToken::CkBTC, 2_500, 7, 5),
        (PayoutType::IdeaUpvoteShare, IdeaToken::ICP, 5_000_000, 4, 8),
        (PayoutType::CommitmentRefund, IdeaToken::ICP, 200_000_000, 9, 12),
        (PayoutType::PoolReward, IdeaToken::ICP, 49_990_000, 3, 16),
    ];
    for (payout_type, token, amount, ref_id, days_ago) in seeds {
        let id = NEXT_PAYOUT_ID.with(|c| {
            let id = *c.borrow().get();
            c.borrow_mut().set(id + 1);
            id
        });
        PAYOUTS.with(|m| {
            m.borrow_mut().insert(id, Payout {
                id,
                user: caller,
                payout_type,
                token,
                amount,
                created_at: now.saturating_sub(days_ago * day),
                ref_id,
            });
        });
    }
    Ok(())
}

/// Local-dev: promote the caller to admin with one click (drives the admin
/// console / How-it-works flows in local testing). Hard-blocked off the local
/// network by `require_local_dev` — this can never run in production.
#[ic_cdk::update]
fn dev_become_admin() -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    let caller = get_caller();
    CONFIG.with(|cell| {
        let mut config = cell.borrow().get().clone();
        if !config.admins.contains(&caller) {
            config.admins.push(caller);
            cell.borrow_mut().set(config);
        }
    });
    void_current_round_tickets(caller);
    Ok(())
}

/// Local-dev: wipe the proposals and their vote/commitment journals, then
/// reseed the mock set — so you can vote on fresh proposals again. Returns
/// the number of proposals seeded. Never available off the local network.
#[ic_cdk::update]
fn dev_reset_proposals() -> Result<u64, String> {
    require_authenticated()?;
    require_local_dev()?;

    let pids: Vec<u64> = PROPOSALS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
    PROPOSALS.with(|m| {
        let mut m = m.borrow_mut();
        for id in &pids {
            m.remove(id);
        }
    });
    VOTES.with(|m| {
        let mut m = m.borrow_mut();
        for id in &pids {
            m.remove(id);
        }
    });
    let ckeys: Vec<CommitmentKey> = COMMITMENTS.with(|m| m.borrow().iter().map(|e| e.key().clone()).collect());
    COMMITMENTS.with(|m| {
        let mut m = m.borrow_mut();
        for k in ckeys {
            m.remove(&k);
        }
    });
    let lkeys: Vec<CommitmentKey> = LOSSLESS_VOTES.with(|m| m.borrow().iter().map(|e| e.key().clone()).collect());
    LOSSLESS_VOTES.with(|m| {
        let mut m = m.borrow_mut();
        for k in lkeys {
            m.remove(&k);
        }
    });

    seed_mock_proposals();
    Ok(PROPOSALS.with(|m| m.borrow().len()))
}

// ==========================================
// 16. Dapp Explorer (paid directory listings)
// ==========================================
//
// A public 3×3 directory of ICP-ecosystem dapps. Admins curate permanent
// listings for free; anyone else pays $1 (USD) per day of visibility — 1 to
// 3650 days — in ICP, ckBTC, ckETH or ckUSDC. USD conversion comes from the
// Exchange Rate Canister (XRC) on mainnet (ckUSDC is pinned at $1); locally
// it falls back to admin-tunable static rates. Community listings stay
// hidden until an admin approves them; a rejection refunds the payment from
// the treasury (minus one ledger fee).

const MAINNET_CKUSDC_LEDGER: &str = "xevnm-gaaaa-aaaar-qafnq-cai";
const MAINNET_CKUSDT_LEDGER: &str = "cngnf-vqaaa-aaaar-qag4q-cai";
/// Exchange Rate Canister (mainnet system canister).
const XRC_CANISTER: &str = "uf6dk-hyaaa-aaaaq-qaaaq-cai";
/// Cycles each XRC call must carry.
const XRC_CALL_CYCLES: u128 = 1_000_000_000;

/// $1.00 per day of visibility, expressed in USD e8s (8 decimals).
const EXPLORER_PRICE_PER_DAY_USD_E8S: u64 = 100_000_000;
const USD_E8S_PER_USD: u64 = 100_000_000;
const EXPLORER_MIN_DAYS: u64 = 1;
const EXPLORER_MAX_DAYS: u64 = 3650;
const MAX_DAPPS: u64 = 500;
const MAX_PENDING_DAPPS_PER_USER: usize = 3;
/// A quoted price is honoured for 15 minutes — long enough to deposit, short
/// enough that a rate move can't be gamed.
const EXPLORER_QUOTE_TTL_NANOS: u64 = 15 * 60 * 1_000_000_000;
/// Cached XRC rates refresh after 10 minutes.
const EXPLORER_RATE_TTL_NANOS: u64 = 10 * 60 * 1_000_000_000;
const MAX_DAPP_NAME_LEN: usize = 60;
const MAX_DAPP_URL_LEN: usize = 300;
const MAX_DAPP_DESC_LEN: usize = 280;
const DAY_NANOS: u64 = 86_400 * 1_000_000_000;

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExplorerToken {
    ICP,
    CkBTC,
    CkETH,
    CkUSDC,
    CkUSDT,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DappStatus {
    /// Community submission awaiting admin review — never shown publicly.
    Pending,
    Approved,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct DappListing {
    pub id: u64,
    pub submitter: Principal,
    pub name: String,
    pub url: String,
    pub description: String,
    /// True for paid community submissions (badged in the UI); false for
    /// admin-curated listings.
    pub community: bool,
    pub status: DappStatus,
    pub created_at: u64,
    pub approved_at: Option<u64>,
    /// None = permanent (admin listings). Community listings expire
    /// `days` after approval and are then deleted by the sweep.
    pub expires_at: Option<u64>,
    pub days: u64,
    pub token: Option<ExplorerToken>,
    /// Amount paid in `token`'s smallest unit (0 for admin listings).
    pub amount_paid: u64,
}

/// A locked price for one caller: deposit `amount` (+ one ledger fee) on the
/// token's ledger, then call `submit_dapp` before `expires_at`.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ExplorerQuote {
    pub token: ExplorerToken,
    pub days: u64,
    pub amount: u64,
    /// USD value of one whole token at quote time (e8s).
    pub rate_usd_e8s: u64,
    pub usd_total_e8s: u64,
    pub created_at: u64,
    pub expires_at: u64,
}

/// Everything the Explorer UI needs in one query.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ExplorerInfo {
    pub enabled: bool,
    pub icp_ledger: Principal,
    pub ckbtc_ledger: Principal,
    pub cketh_ledger: Principal,
    pub ckusdc_ledger: Principal,
    pub ckusdt_ledger: Principal,
    pub fee_icp_e8s: u64,
    pub fee_ckbtc_sats: u64,
    pub fee_cketh_wei: u64,
    pub fee_ckusdc_micro: u64,
    pub fee_ckusdt_micro: u64,
    pub price_per_day_usd_e8s: u64,
    pub min_days: u64,
    pub max_days: u64,
    pub quote_ttl_nanos: u64,
}

impl_storable!(DappListing);
impl_storable!(ExplorerQuote);

thread_local! {
    static DAPPS: RefCell<StableBTreeMap<u64, DappListing, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(40))))
    });

    static NEXT_DAPP_ID: RefCell<StableCell<u64, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(41)), 1u64))
    });

    static EXPLORER_QUOTES: RefCell<StableBTreeMap<Principal, ExplorerQuote, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(42))))
    });

    // Transient USD-rate cache [(rate_e8s, fetched_at); one slot per token].
    // Heap-only on purpose: rates are refetched after an upgrade.
    static EXPLORER_USD_RATES: RefCell<[(u64, u64); 5]> = const { RefCell::new([(0, 0); 5]) };
}

fn require_explorer_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_EXPLORER) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

fn explorer_token_index(token: ExplorerToken) -> usize {
    match token {
        ExplorerToken::ICP => 0,
        ExplorerToken::CkBTC => 1,
        ExplorerToken::CkETH => 2,
        ExplorerToken::CkUSDC => 3,
        ExplorerToken::CkUSDT => 4,
    }
}

fn explorer_token_decimals(token: ExplorerToken) -> u32 {
    match token {
        ExplorerToken::ICP | ExplorerToken::CkBTC => 8,
        ExplorerToken::CkETH => 18,
        ExplorerToken::CkUSDC | ExplorerToken::CkUSDT => 6,
    }
}

/// Underlying-asset symbol the XRC quotes (chain-key tokens track 1:1).
fn explorer_xrc_symbol(token: ExplorerToken) -> &'static str {
    match token {
        ExplorerToken::ICP => "ICP",
        ExplorerToken::CkBTC => "BTC",
        ExplorerToken::CkETH => "ETH",
        ExplorerToken::CkUSDC => "USDC",
        ExplorerToken::CkUSDT => "USDT",
    }
}

/// Static fallback rates for local dev / before the first XRC fetch —
/// same approximate June-2026 levels as the idea-board minimums.
fn default_usd_rate_e8s(token: ExplorerToken) -> u64 {
    match token {
        ExplorerToken::ICP => 500_000_000,            // $5
        ExplorerToken::CkBTC => 10_000_000_000_000,   // $100k
        ExplorerToken::CkETH => 300_000_000_000,      // $3k
        ExplorerToken::CkUSDC | ExplorerToken::CkUSDT => USD_E8S_PER_USD, // $1
    }
}

/// Per-token ledger — ICP/ckBTC/ckETH delegate to the idea-board resolution
/// (mainnet hard-pinned, local overrides); ckUSDC mirrors that pattern.
fn explorer_token_ledger(token: ExplorerToken, config: &Config) -> Principal {
    match token {
        ExplorerToken::ICP => token_ledger(IdeaToken::ICP, config),
        ExplorerToken::CkBTC => token_ledger(IdeaToken::CkBTC, config),
        ExplorerToken::CkETH => token_ledger(IdeaToken::CkETH, config),
        ExplorerToken::CkUSDC => {
            if config.is_local {
                config.ckusdc_ledger_canister_id.unwrap_or(config.ledger_canister_id)
            } else {
                Principal::from_text(MAINNET_CKUSDC_LEDGER).unwrap()
            }
        }
        ExplorerToken::CkUSDT => {
            if config.is_local {
                config.ckusdt_ledger_canister_id.unwrap_or(config.ledger_canister_id)
            } else {
                Principal::from_text(MAINNET_CKUSDT_LEDGER).unwrap()
            }
        }
    }
}

fn explorer_token_fee(token: ExplorerToken, config: &Config) -> u64 {
    match token {
        ExplorerToken::ICP => token_fee(IdeaToken::ICP, config),
        ExplorerToken::CkBTC => token_fee(IdeaToken::CkBTC, config),
        ExplorerToken::CkETH => token_fee(IdeaToken::CkETH, config),
        // Canonical ckUSDC/ckUSDT fee is 0.01 (10_000 micro); the ICP test
        // ledger fallback charges the same 10_000 (in e8s) — one value fits.
        ExplorerToken::CkUSDC | ExplorerToken::CkUSDT => 10_000,
    }
}

/// Caller-bound deposit subaccount for Explorer listing fees. Domain-
/// separated from the proposal and idea escrows.
fn derive_explorer_subaccount(user: &Principal) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_explorer_v1");
    hasher.update(user.as_slice());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

fn validate_dapp_text(name: &str, url: &str, description: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > MAX_DAPP_NAME_LEN {
        return Err("INVALID_NAME".to_string());
    }
    if description.is_empty() || description.chars().count() > MAX_DAPP_DESC_LEN {
        return Err("INVALID_DESCRIPTION".to_string());
    }
    if url.len() > MAX_DAPP_URL_LEN
        || !url.starts_with("https://")
        || url.len() <= "https://".len()
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("INVALID_URL".to_string());
    }
    Ok(())
}

/// days × $1/day converted into the token's smallest unit at `rate_usd_e8s`
/// (USD per whole token). Returns (token amount, USD total in e8s).
fn explorer_quote_amount(days: u64, rate_usd_e8s: u64, decimals: u32) -> Result<(u64, u64), String> {
    if !(EXPLORER_MIN_DAYS..=EXPLORER_MAX_DAYS).contains(&days) {
        return Err("INVALID_DAYS".to_string());
    }
    if rate_usd_e8s == 0 {
        return Err("RATE_UNAVAILABLE".to_string());
    }
    let usd_total = (days as u128) * (EXPLORER_PRICE_PER_DAY_USD_E8S as u128);
    let scale = 10u128.pow(decimals);
    let amount = usd_total.saturating_mul(scale) / (rate_usd_e8s as u128);
    let amount = u64::try_from(amount).map_err(|_| "AMOUNT_OVERFLOW".to_string())?;
    if amount == 0 {
        return Err("AMOUNT_TOO_SMALL".to_string());
    }
    Ok((amount, usd_total as u64))
}

// ── XRC plumbing (wasm only; unit tests use the static fallback rates) ──

#[cfg(target_arch = "wasm32")]
mod xrc {
    use super::*;

    #[derive(CandidType, Deserialize)]
    pub struct Asset {
        pub symbol: String,
        pub class: AssetClass,
    }

    #[derive(CandidType, Deserialize)]
    pub enum AssetClass {
        Cryptocurrency,
        FiatCurrency,
    }

    #[derive(CandidType, Deserialize)]
    pub struct GetExchangeRateRequest {
        pub base_asset: Asset,
        pub quote_asset: Asset,
        pub timestamp: Option<u64>,
    }

    /// Width-subtyped: the wire record carries more fields; candid drops them.
    #[derive(CandidType, Deserialize)]
    pub struct ExchangeRateMetadata {
        pub decimals: u32,
    }

    #[derive(CandidType, Deserialize)]
    pub struct ExchangeRate {
        pub rate: u64,
        pub metadata: ExchangeRateMetadata,
    }

    #[derive(CandidType, Deserialize, Debug)]
    pub enum ExchangeRateError {
        AnonymousPrincipalNotAllowed,
        Pending,
        CryptoBaseAssetNotFound,
        CryptoQuoteAssetNotFound,
        StablecoinRateNotFound,
        StablecoinRateTooFewRates,
        StablecoinRateZeroRate,
        ForexInvalidTimestamp,
        ForexBaseAssetNotFound,
        ForexQuoteAssetNotFound,
        ForexAssetsNotFound,
        RateLimited,
        NotEnoughCycles,
        FailedToAcceptCycles,
        InconsistentRatesReceived,
        Other { code: u32, description: String },
    }

    #[derive(CandidType, Deserialize)]
    pub enum GetExchangeRateResult {
        Ok(ExchangeRate),
        Err(ExchangeRateError),
    }
}

#[cfg(target_arch = "wasm32")]
async fn fetch_xrc_usd_rate_e8s(symbol: &str) -> Result<u64, String> {
    let canister = Principal::from_text(XRC_CANISTER).unwrap();
    let req = xrc::GetExchangeRateRequest {
        base_asset: xrc::Asset {
            symbol: symbol.to_string(),
            class: xrc::AssetClass::Cryptocurrency,
        },
        quote_asset: xrc::Asset {
            symbol: "USD".to_string(),
            class: xrc::AssetClass::FiatCurrency,
        },
        timestamp: None,
    };
    let response: Result<(xrc::GetExchangeRateResult,), _> =
        ic_cdk::api::call::call_with_payment128(canister, "get_exchange_rate", (req,), XRC_CALL_CYCLES).await;
    match response {
        Ok((xrc::GetExchangeRateResult::Ok(rate),)) => {
            let denom = 10u128
                .checked_pow(rate.metadata.decimals)
                .ok_or_else(|| "XRC_DECIMALS_OVERFLOW".to_string())?;
            let e8s = (rate.rate as u128).saturating_mul(USD_E8S_PER_USD as u128) / denom;
            let e8s = u64::try_from(e8s).map_err(|_| "XRC_RATE_OVERFLOW".to_string())?;
            if e8s == 0 {
                return Err("XRC_ZERO_RATE".to_string());
            }
            Ok(e8s)
        }
        Ok((xrc::GetExchangeRateResult::Err(err),)) => Err(format!("XRC_ERROR: {:?}", err)),
        Err((code, msg)) => Err(format!("XRC call failed (code {:?}): {}", code, msg)),
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn fetch_xrc_usd_rate_e8s(_symbol: &str) -> Result<u64, String> {
    Err("XRC unavailable off-chain".to_string())
}

/// Current USD value (e8s) of one whole token. ckUSDC is pinned at $1.
/// Local (and unit tests): cached admin-set rate, else the static default —
/// never a remote call. Mainnet: 10-min-TTL cache over the XRC; a fetch
/// failure falls back to the stale cached value when one exists.
async fn explorer_usd_rate_e8s(token: ExplorerToken, config: &Config) -> Result<u64, String> {
    if token == ExplorerToken::CkUSDC || token == ExplorerToken::CkUSDT {
        return Ok(USD_E8S_PER_USD);
    }
    let idx = explorer_token_index(token);
    let now = current_time();
    let (cached_rate, cached_at) = EXPLORER_USD_RATES.with(|r| r.borrow()[idx]);
    if config.is_local || !cfg!(target_arch = "wasm32") {
        return Ok(if cached_rate > 0 { cached_rate } else { default_usd_rate_e8s(token) });
    }
    if cached_rate > 0 && now < cached_at.saturating_add(EXPLORER_RATE_TTL_NANOS) {
        return Ok(cached_rate);
    }
    match fetch_xrc_usd_rate_e8s(explorer_xrc_symbol(token)).await {
        Ok(rate) => {
            EXPLORER_USD_RATES.with(|r| r.borrow_mut()[idx] = (rate, now));
            Ok(rate)
        }
        Err(e) => {
            if cached_rate > 0 {
                Ok(cached_rate)
            } else {
                Err(e)
            }
        }
    }
}

fn dapp_is_live(d: &DappListing, now: u64) -> bool {
    d.status == DappStatus::Approved && d.expires_at.map(|x| now <= x).unwrap_or(true)
}

/// Sweep pass: drop approved community listings whose paid window has lapsed.
fn delete_expired_dapps() {
    let now = current_time();
    let expired: Vec<u64> = DAPPS.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| {
                let d = e.value();
                matches!(d.expires_at, Some(x) if now > x)
            })
            .map(|e| *e.key())
            .collect()
    });
    DAPPS.with(|m| {
        let mut m = m.borrow_mut();
        for id in expired {
            m.remove(&id);
        }
    });
}

fn next_dapp_id() -> u64 {
    NEXT_DAPP_ID.with(|c| {
        let id = *c.borrow().get();
        c.borrow_mut().set(id + 1);
        id
    })
}

fn log_dapp_event(event_type: &str, dapp_id: u64, user: Principal, amount: u64) {
    let entry = AuditLogEntry {
        timestamp: current_time(),
        event_type: event_type.to_string(),
        proposal_id: dapp_id,
        user,
        amount_e8s: amount,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
}

/// Admin-curated cards. Real ecosystem content (not local mocks), so this
/// seeds on every network. Per-entry insert-if-missing (matched by name) so
/// entries added later still land on already-populated directories at
/// post_upgrade without duplicating existing cards.
fn seed_default_dapps() {
    let owner = CONFIG.with(|c| {
        c.borrow().get().admins.first().copied().unwrap_or_else(Principal::anonymous)
    });
    let now = current_time();
    let samples: [(&str, &str, &str); 8] = [
        (
            "idGeek 2.0",
            "https://xdtth-dyaaa-aaaah-qc73q-cai.raw.icp0.io/",
            "Secure, automated and decentralized marketplace for buying and selling Internet Identities with their linked assets — including SNS neurons — executed entirely by smart contracts on the Internet Computer.",
        ),
        (
            "Liquidium",
            "https://liquidium.fi/",
            "Cross-chain lending protocol: supply Bitcoin and borrow stablecoins without selling your holdings. Chain Fusion collateral across chains, auto-compounded yield for lenders, no lock-ups, fully non-custodial.",
        ),
        (
            "ICPSwap",
            "https://app.icpswap.com/",
            "The Internet Computer's leading decentralized exchange: swap, provide concentrated liquidity, and farm across ICP, ckBTC, ckETH and stablecoin pools — every order book, position and fee settled fully on-chain.",
        ),
        (
            "OISY Wallet",
            "https://oisy.com/",
            "Browser-based multi-chain wallet powered by Chain Fusion: hold and send BTC, ETH, SOL, ICP and ERC-20 tokens from one interface — no extension, no seed phrase, secured by Internet Identity and threshold cryptography.",
        ),
        (
            "OpenChat",
            "https://oc.app/",
            "Fully on-chain messaging that feels like your favorite chat app: communities, channels, and instant crypto transfers in-chat. Governed by its own SNS DAO — the flagship proof that social runs on the Internet Computer.",
        ),
        (
            "Partyhats",
            "https://partyhats.xyz/",
            "Fully on-chain casino with no house edge: burn PARTY tokens to play mines and other provably-fair games, provide liquidity on PartyDEX to earn yield, and trade ICP Party Hat NFTs — every bet and payout settled by smart contracts on the Internet Computer.",
        ),
        (
            "Dyvr",
            "https://dyvr.com/",
            "Emerging Internet Computer dapp — visit the site for the latest on what Dyvr is building on ICP.",
        ),
        (
            "onicai",
            "https://www.onicai.com/",
            "AI-as-a-Service platform pioneering on-chain artificial intelligence: run large language models entirely inside ICP canisters, compete in incentivized AI tournaments via funnAI, and build with open-source GGUF tooling — no off-chain inference required.",
        ),
    ];
    let existing: Vec<String> = DAPPS.with(|m| m.borrow().iter().map(|e| e.value().name.clone()).collect());
    for (name, url, description) in samples {
        if existing.iter().any(|n| n == name) {
            continue;
        }
        let id = next_dapp_id();
        DAPPS.with(|m| {
            m.borrow_mut().insert(id, DappListing {
                id,
                submitter: owner,
                name: name.to_string(),
                url: url.to_string(),
                description: description.to_string(),
                community: false,
                status: DappStatus::Approved,
                created_at: now,
                approved_at: Some(now),
                expires_at: None,
                days: 0,
                token: None,
                amount_paid: 0,
            });
        });
    }
}

#[ic_cdk::query]
fn get_explorer_info() -> ExplorerInfo {
    let config = CONFIG.with(|c| c.borrow().get().clone());
    ExplorerInfo {
        enabled: feature_enabled(FLAG_EXPLORER),
        icp_ledger: explorer_token_ledger(ExplorerToken::ICP, &config),
        ckbtc_ledger: explorer_token_ledger(ExplorerToken::CkBTC, &config),
        cketh_ledger: explorer_token_ledger(ExplorerToken::CkETH, &config),
        ckusdc_ledger: explorer_token_ledger(ExplorerToken::CkUSDC, &config),
        ckusdt_ledger: explorer_token_ledger(ExplorerToken::CkUSDT, &config),
        fee_icp_e8s: explorer_token_fee(ExplorerToken::ICP, &config),
        fee_ckbtc_sats: explorer_token_fee(ExplorerToken::CkBTC, &config),
        fee_cketh_wei: explorer_token_fee(ExplorerToken::CkETH, &config),
        fee_ckusdc_micro: explorer_token_fee(ExplorerToken::CkUSDC, &config),
        fee_ckusdt_micro: explorer_token_fee(ExplorerToken::CkUSDT, &config),
        price_per_day_usd_e8s: EXPLORER_PRICE_PER_DAY_USD_E8S,
        min_days: EXPLORER_MIN_DAYS,
        max_days: EXPLORER_MAX_DAYS,
        quote_ttl_nanos: EXPLORER_QUOTE_TTL_NANOS,
    }
}

/// All live (approved, unexpired) listings: admin-curated first in curation
/// order, then community listings in approval order.
#[ic_cdk::query]
fn list_dapps() -> Vec<DappListing> {
    let now = current_time();
    let mut dapps: Vec<DappListing> = DAPPS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|d| dapp_is_live(d, now))
            .collect()
    });
    dapps.sort_by_key(|d| (d.community, d.approved_at.unwrap_or(d.created_at), d.id));
    dapps
}

/// The caller's own submissions in every state — lets the UI show "pending
/// admin approval" and time remaining.
#[ic_cdk::query]
fn list_my_dapp_submissions() -> Vec<DappListing> {
    let caller = get_caller();
    let mut dapps: Vec<DappListing> = DAPPS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|d| d.community && d.submitter == caller)
            .collect()
    });
    dapps.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    dapps
}

/// Admin: the approval queue, oldest first.
#[ic_cdk::query(guard = "require_admin")]
fn list_pending_dapps() -> Vec<DappListing> {
    let mut dapps: Vec<DappListing> = DAPPS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|d| d.status == DappStatus::Pending)
            .collect()
    });
    dapps.sort_by_key(|d| (d.created_at, d.id));
    dapps
}

/// The caller's deposit account for Explorer listing fees. Fund it on the
/// quoted token's ledger with `quote.amount` + one transfer fee, then call
/// `submit_dapp`.
#[ic_cdk::query]
fn get_explorer_deposit_address() -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_explorer_subaccount(&caller)),
    }
}

/// Price `days` of visibility in `token` at the live USD rate and lock that
/// price for the caller for 15 minutes. An update (not a query) because the
/// mainnet path may refresh the rate via the XRC.
#[ic_cdk::update]
async fn get_explorer_quote(token: ExplorerToken, days: u64) -> Result<ExplorerQuote, String> {
    require_authenticated()?;
    require_explorer_enabled()?;
    let caller = get_caller();
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let rate = explorer_usd_rate_e8s(token, &config).await?;
    let (amount, usd_total_e8s) = explorer_quote_amount(days, rate, explorer_token_decimals(token))?;
    let now = current_time();
    let quote = ExplorerQuote {
        token,
        days,
        amount,
        rate_usd_e8s: rate,
        usd_total_e8s,
        created_at: now,
        expires_at: now.saturating_add(EXPLORER_QUOTE_TTL_NANOS),
    };
    EXPLORER_QUOTES.with(|m| {
        m.borrow_mut().insert(caller, quote.clone());
    });
    Ok(quote)
}

/// Submit a community listing. Requires a fresh quote for the same token +
/// days (get_explorer_quote) and the quoted amount (+ one ledger fee)
/// deposited on get_explorer_deposit_address. The payment moves to the
/// treasury immediately; the listing stays Pending — invisible to the
/// public — until an admin approves it. Rejection refunds from the treasury.
#[ic_cdk::update]
async fn submit_dapp(
    name: String,
    url: String,
    description: String,
    token: ExplorerToken,
    days: u64,
) -> Result<u64, String> {
    require_authenticated()?;
    require_explorer_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let name = name.trim().to_string();
    let url = url.trim().to_string();
    let description = description.trim().to_string();
    validate_dapp_text(&name, &url, &description)?;
    if !(EXPLORER_MIN_DAYS..=EXPLORER_MAX_DAYS).contains(&days) {
        return Err("INVALID_DAYS".to_string());
    }

    let quota_err = DAPPS.with(|m| {
        let m = m.borrow();
        if m.len() >= MAX_DAPPS {
            return Some("DAPP_QUOTA_REACHED");
        }
        let pending_by_caller = m
            .iter()
            .filter(|e| {
                let d = e.value();
                d.submitter == caller && d.status == DappStatus::Pending
            })
            .count();
        if pending_by_caller >= MAX_PENDING_DAPPS_PER_USER {
            return Some("TOO_MANY_PENDING_DAPPS");
        }
        None
    });
    if let Some(e) = quota_err {
        return Err(e.to_string());
    }

    // The stored quote locks the price so a rate move between depositing and
    // submitting can't invalidate the payment.
    let now = current_time();
    let quote = EXPLORER_QUOTES
        .with(|m| m.borrow().get(&caller))
        .ok_or_else(|| "NO_QUOTE".to_string())?;
    if quote.token != token || quote.days != days {
        return Err("QUOTE_MISMATCH".to_string());
    }
    if now > quote.expires_at {
        return Err("QUOTE_EXPIRED".to_string());
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = explorer_token_ledger(token, &config);
    let fee = explorer_token_fee(token, &config);
    let sub = derive_explorer_subaccount(&caller);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    if balance < quote.amount.saturating_add(fee) {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }
    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    call_ledger_transfer(ledger_id, Some(sub), treasury_dest, quote.amount, Some(fee))
        .await
        .map_err(|e| format!("FEE_TRANSFER_FAILED: {}", e))?;

    let id = next_dapp_id();
    DAPPS.with(|m| {
        m.borrow_mut().insert(id, DappListing {
            id,
            submitter: caller,
            name,
            url,
            description,
            community: true,
            status: DappStatus::Pending,
            created_at: now,
            approved_at: None,
            expires_at: None, // set when an admin approves
            days,
            token: Some(token),
            amount_paid: quote.amount,
        });
    });
    EXPLORER_QUOTES.with(|m| {
        m.borrow_mut().remove(&caller);
    });
    log_dapp_event("dapp_submit", id, caller, quote.amount);
    Ok(id)
}

/// Admin: approve a pending community listing. Its paid `days` window starts
/// now.
#[ic_cdk::update(guard = "require_admin")]
fn admin_approve_dapp(id: u64) -> Result<(), String> {
    let now = current_time();
    DAPPS.with(|m| {
        let mut m = m.borrow_mut();
        let mut d = m.get(&id).ok_or_else(|| "DAPP_NOT_FOUND".to_string())?;
        if d.status != DappStatus::Pending {
            return Err("NOT_PENDING".to_string());
        }
        d.status = DappStatus::Approved;
        d.approved_at = Some(now);
        d.expires_at = Some(now.saturating_add(d.days.saturating_mul(DAY_NANOS)));
        m.insert(id, d);
        Ok(())
    })?;
    log_dapp_event("dapp_approve", id, get_caller(), 0);
    Ok(())
}

/// Admin: reject a pending community listing. The payment is refunded from
/// the treasury (minus one ledger fee), then the listing is deleted.
/// The listing is REMOVED before the refund transfer (and restored if it
/// fails) so a concurrent second reject — or an interleaved approve — can't
/// refund the same payment twice across the await (review 2026-06-11).
#[ic_cdk::update(guard = "require_admin")]
async fn admin_reject_dapp(id: u64) -> Result<(), String> {
    let listing = DAPPS
        .with(|m| m.borrow().get(&id))
        .ok_or_else(|| "DAPP_NOT_FOUND".to_string())?;
    if listing.status != DappStatus::Pending {
        return Err("NOT_PENDING".to_string());
    }
    // Claim the listing before any await: concurrent callers now see
    // DAPP_NOT_FOUND instead of double-refunding.
    DAPPS.with(|m| {
        m.borrow_mut().remove(&id);
    });
    let config = CONFIG.with(|c| c.borrow().get().clone());
    if let Some(token) = listing.token {
        let fee = explorer_token_fee(token, &config);
        let refund = listing.amount_paid.saturating_sub(fee);
        if refund > 0 {
            let ledger_id = explorer_token_ledger(token, &config);
            let dest = LedgerAccount { owner: listing.submitter, subaccount: None };
            if let Err(e) = call_ledger_transfer(ledger_id, Some(TREASURY_SUBACCOUNT), dest, refund, Some(fee)).await {
                // Refund failed — put the listing back so the reject can be
                // retried (nothing has been paid out).
                DAPPS.with(|m| {
                    m.borrow_mut().insert(id, listing.clone());
                });
                return Err(format!("REFUND_FAILED: {}", e));
            }
        }
    }
    log_dapp_event("dapp_reject", id, listing.submitter, listing.amount_paid);
    Ok(())
}

/// Admin: add a permanent curated listing (no payment, no badge, no expiry).
#[ic_cdk::update(guard = "require_admin")]
fn admin_add_dapp(name: String, url: String, description: String) -> Result<u64, String> {
    let name = name.trim().to_string();
    let url = url.trim().to_string();
    let description = description.trim().to_string();
    validate_dapp_text(&name, &url, &description)?;
    let at_quota = DAPPS.with(|m| m.borrow().len() >= MAX_DAPPS);
    if at_quota {
        return Err("DAPP_QUOTA_REACHED".to_string());
    }
    let now = current_time();
    let id = next_dapp_id();
    let caller = get_caller();
    DAPPS.with(|m| {
        m.borrow_mut().insert(id, DappListing {
            id,
            submitter: caller,
            name,
            url,
            description,
            community: false,
            status: DappStatus::Approved,
            created_at: now,
            approved_at: Some(now),
            expires_at: None,
            days: 0,
            token: None,
            amount_paid: 0,
        });
    });
    log_dapp_event("dapp_admin_add", id, caller, 0);
    Ok(id)
}

/// Admin: remove any listing outright (no refund — use admin_reject_dapp for
/// pending submissions that should get their payment back).
#[ic_cdk::update(guard = "require_admin")]
fn admin_remove_dapp(id: u64) -> Result<(), String> {
    let existed = DAPPS.with(|m| m.borrow_mut().remove(&id)).is_some();
    if !existed {
        return Err("DAPP_NOT_FOUND".to_string());
    }
    log_dapp_event("dapp_remove", id, get_caller(), 0);
    Ok(())
}

/// Admin: point ckUSDC (or the other tokens) at locally deployed test
/// ledgers. Local-only — mainnet ledgers are hard-pinned.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_explorer_ledger(token: ExplorerToken, ledger: Principal) -> Result<(), String> {
    if ledger == Principal::anonymous() {
        return Err("INVALID_LEDGER".to_string());
    }
    CONFIG.with(|cell| {
        let mut cfg = cell.borrow().get().clone();
        if !cfg.is_local {
            return Err("MAINNET_LEDGERS_PINNED".to_string());
        }
        match token {
            ExplorerToken::ICP => return Err("ICP_LEDGER_FIXED".to_string()),
            ExplorerToken::CkBTC => cfg.ckbtc_ledger_canister_id = Some(ledger),
            ExplorerToken::CkETH => cfg.cketh_ledger_canister_id = Some(ledger),
            ExplorerToken::CkUSDC => cfg.ckusdc_ledger_canister_id = Some(ledger),
            ExplorerToken::CkUSDT => cfg.ckusdt_ledger_canister_id = Some(ledger),
        }
        cell.borrow_mut().set(cfg);
        Ok(())
    })
}

/// Which pay-first deposit escrow to reclaim from.
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug)]
pub enum EscrowKind {
    Explorer,
    Arcade,
    EarlyAdopter,
}

/// Withdraw the caller's remaining balance from one of their pay-first
/// deposit subaccounts (Explorer listing / Arcade customization / Early Adopter
/// stake). These accounts are funded right before a paid action; if that
/// action then fails — expired quote, listing quota, closed membership — the
/// deposit would otherwise be stranded with no recovery path (review
/// 2026-06-11). Only ever touches the caller's own derived subaccount, and
/// the shared CallerGuard makes it mutually exclusive with the paid actions.
/// Deliberately NOT feature-flag-gated: stranded funds must stay recoverable
/// even after a kill switch.
#[ic_cdk::update]
async fn reclaim_escrow(kind: EscrowKind, token: ExplorerToken) -> Result<u64, String> {
    require_authenticated()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;
    let sub = match kind {
        EscrowKind::Explorer => derive_explorer_subaccount(&caller),
        EscrowKind::Arcade => derive_arcade_subaccount(&caller),
        EscrowKind::EarlyAdopter => derive_early_adopter_subaccount(&caller),
    };
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = explorer_token_ledger(token, &config);
    let fee = explorer_token_fee(token, &config);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    if balance <= fee {
        return Err("NOTHING_TO_RECLAIM".to_string());
    }
    let amount = balance - fee;
    let dest = LedgerAccount { owner: caller, subaccount: None };
    call_ledger_transfer(ledger_id, Some(sub), dest, amount, Some(fee))
        .await
        .map_err(|e| format!("RECLAIM_FAILED: {}", e))?;
    let entry = AuditLogEntry {
        timestamp: current_time(),
        event_type: "escrow_reclaim".to_string(),
        proposal_id: 0,
        user: caller,
        amount_e8s: amount,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
    Ok(amount)
}

/// Admin: seed/override a token's USD rate (e8s per whole token). The local
/// network has no XRC so this is the only knob there; on mainnet it acts as
/// an emergency seed that the next successful XRC refresh overwrites.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_usd_rate(token: ExplorerToken, rate_usd_e8s: u64) -> Result<(), String> {
    if rate_usd_e8s == 0 {
        return Err("INVALID_RATE".to_string());
    }
    let idx = explorer_token_index(token);
    let now = current_time();
    EXPLORER_USD_RATES.with(|r| r.borrow_mut()[idx] = (rate_usd_e8s, now));
    Ok(())
}

// ==========================================
// 17. Arcade (skill games, participation-gated)
// ==========================================
//
// A section of one-player skill games — first title: "Mini Golf Gold", a
// 9-hole mini golf game. Playing is free, but it's a reward for protocol
// participation: everyone signed-in may play hole 1; finishing a round (and
// landing on the leaderboard) requires an active stake OR a vote cast in the
// last 30 days. Each game keys its own all-time leaderboard (`game` string)
// so future titles — and a cross-game combined board — slot in without a
// migration. Ranking: fewest total strokes, ties broken by fastest time.
// The low-poly golfer is customizable (hair / skin / outfit palettes) for a
// $1 fee per change, payable in any supported token, paid to the treasury.

/// $1 (USD e8s) per character change — payable in any supported token at
/// the live oracle rate (stables pinned at $1).
const ARCADE_CUSTOMIZE_FEE_USD_E8S: u64 = 100_000_000;
/// "Voted recently" window for full access.
const ARCADE_VOTE_WINDOW_NANOS: u64 = 30 * DAY_NANOS;
const ARCADE_GAME_MINIGOLF: &str = "minigolf";
const MINIGOLF_HOLES: usize = 9;
const MINIGOLF_MAX_STROKES_PER_HOLE: u8 = 12;
/// Wall-clock sanity bounds for a submitted round.
const MINIGOLF_MIN_MILLIS: u64 = 20_000; // nobody putts 9 holes in <20 s
const MINIGOLF_MAX_MILLIS: u64 = 2 * 60 * 60 * 1000; // 2 h
const ARCADE_LEADERBOARD_LIMIT: usize = 100;
// Palette sizes — the frontend mirrors these (index = palette entry).
const CHARACTER_HAIR_OPTIONS: u8 = 6;
const CHARACTER_SKIN_OPTIONS: u8 = 6;
const CHARACTER_OUTFIT_OPTIONS: u8 = 8;

/// Palette indices for the low-poly golfer (defaults are all 0).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArcadeCharacter {
    pub hair: u8,
    pub skin: u8,
    pub outfit: u8,
}

/// One leaderboard slot per (game, player) — insert-if-better keeps only the
/// player's best round.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ArcadeScoreKey {
    pub game: String,
    pub player: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeScore {
    pub game: String,
    pub player: Principal,
    pub strokes: u32,
    pub millis: u64,
    pub per_hole: Vec<u8>,
    pub submitted_at: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeLeaderboardRow {
    pub rank: u32,
    pub player: Principal,
    pub strokes: u32,
    pub millis: u64,
    pub submitted_at: u64,
}

/// Everything the Arcade UI needs in one caller-aware query.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeInfo {
    pub enabled: bool,
    /// Caller may finish full rounds + submit scores (stake or recent vote).
    pub full_access: bool,
    pub has_stake: bool,
    pub voted_recently: bool,
    /// $1.00 in USD e8s — convert with get_arcade_customize_quote.
    pub customize_fee_usd_e8s: u64,
    pub my_character: Option<ArcadeCharacter>,
    pub hair_options: u8,
    pub skin_options: u8,
    pub outfit_options: u8,
}

impl_storable!(ArcadeCharacter);
impl_storable!(ArcadeScoreKey);
impl_storable!(ArcadeScore);

thread_local! {
    static ARCADE_SCORES: RefCell<StableBTreeMap<ArcadeScoreKey, ArcadeScore, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(43))))
    });

    static ARCADE_CHARACTERS: RefCell<StableBTreeMap<Principal, ArcadeCharacter, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(44))))
    });

    // Locked $1 customization quotes per caller (same shape as Explorer
    // quotes; days is always 1 here).
    static ARCADE_QUOTES: RefCell<StableBTreeMap<Principal, ExplorerQuote, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(50))))
    });
}

fn require_arcade_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_ARCADE) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

/// Full access = active stake in any tier OR a vote (staked or burn commit)
/// within the last 30 days. Everyone else is limited to hole 1.
fn arcade_access(user: Principal) -> (bool, bool) {
    let has_stake = user_has_stake(user);
    if has_stake {
        // Access is already decided — skip the full-history scans below
        // (they grow with every vote/commit ever made; see
        // house-keeping/review-2026-06-11.md for the indexed follow-up).
        return (true, false);
    }
    let cutoff = current_time().saturating_sub(ARCADE_VOTE_WINDOW_NANOS);
    let voted_recently = LOSSLESS_VOTES.with(|m| {
        m.borrow().iter().any(|e| {
            let v = e.value();
            v.principal == user && v.cast_at >= cutoff
        })
    }) || COMMITMENTS.with(|m| {
        m.borrow().iter().any(|e| {
            let c = e.value();
            c.principal == user && c.created_at >= cutoff
        })
    });
    (has_stake, voted_recently)
}

/// True when `a` beats `b`: fewer strokes, ties broken by faster time, then
/// by earlier submission.
fn arcade_score_beats(a: (u32, u64, u64), b: (u32, u64, u64)) -> bool {
    a < b
}

/// Caller-bound deposit subaccount for arcade fees (character customization).
fn derive_arcade_subaccount(user: &Principal) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_arcade_v1");
    hasher.update(user.as_slice());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

#[ic_cdk::query]
fn get_arcade_info() -> ArcadeInfo {
    let caller = get_caller();
    let (has_stake, voted_recently) = if caller == Principal::anonymous() {
        (false, false)
    } else {
        arcade_access(caller)
    };
    ArcadeInfo {
        enabled: feature_enabled(FLAG_ARCADE),
        full_access: has_stake || voted_recently,
        has_stake,
        voted_recently,
        customize_fee_usd_e8s: ARCADE_CUSTOMIZE_FEE_USD_E8S,
        my_character: ARCADE_CHARACTERS.with(|m| m.borrow().get(&caller)),
        hair_options: CHARACTER_HAIR_OPTIONS,
        skin_options: CHARACTER_SKIN_OPTIONS,
        outfit_options: CHARACTER_OUTFIT_OPTIONS,
    }
}

/// The caller's deposit account for arcade fees. Fund it on the ICP ledger
/// with `customize_fee + 0.0001 ICP`, then call `customize_character`.
#[ic_cdk::query]
fn get_arcade_deposit_address() -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_arcade_subaccount(&caller)),
    }
}

/// Price the $1 customization in `token` at the live oracle rate and lock
/// it for the caller for 15 minutes (same pattern as Explorer quotes).
#[ic_cdk::update]
async fn get_arcade_customize_quote(token: ExplorerToken) -> Result<ExplorerQuote, String> {
    require_authenticated()?;
    require_arcade_enabled()?;
    let caller = get_caller();
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let rate = explorer_usd_rate_e8s(token, &config).await?;
    // 1 "day" at $1/day == exactly $1 — reuse the Explorer conversion.
    let (amount, usd_total_e8s) = explorer_quote_amount(1, rate, explorer_token_decimals(token))?;
    let now = current_time();
    let quote = ExplorerQuote {
        token,
        days: 1,
        amount,
        rate_usd_e8s: rate,
        usd_total_e8s,
        created_at: now,
        expires_at: now.saturating_add(EXPLORER_QUOTE_TTL_NANOS),
    };
    ARCADE_QUOTES.with(|m| {
        m.borrow_mut().insert(caller, quote.clone());
    });
    Ok(quote)
}

/// Change the golfer's look (palette indices) for $1, paid in any supported
/// token (ICP / ckBTC / ckETH / ckUSDC / ckUSDT) at the quoted rate.
#[ic_cdk::update]
async fn customize_character(hair: u8, skin: u8, outfit: u8, token: ExplorerToken) -> Result<(), String> {
    require_authenticated()?;
    require_arcade_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    if hair >= CHARACTER_HAIR_OPTIONS || skin >= CHARACTER_SKIN_OPTIONS || outfit >= CHARACTER_OUTFIT_OPTIONS {
        return Err("INVALID_CHARACTER_OPTION".to_string());
    }
    let now = current_time();
    let quote = ARCADE_QUOTES
        .with(|m| m.borrow().get(&caller))
        .ok_or_else(|| "NO_QUOTE".to_string())?;
    if quote.token != token {
        return Err("QUOTE_MISMATCH".to_string());
    }
    if now > quote.expires_at {
        return Err("QUOTE_EXPIRED".to_string());
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = explorer_token_ledger(token, &config);
    let fee = explorer_token_fee(token, &config);
    let sub = derive_arcade_subaccount(&caller);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    if balance < quote.amount.saturating_add(fee) {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }
    let treasury_dest = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    call_ledger_transfer(ledger_id, Some(sub), treasury_dest, quote.amount, Some(fee))
        .await
        .map_err(|e| format!("FEE_TRANSFER_FAILED: {}", e))?;

    ARCADE_CHARACTERS.with(|m| {
        m.borrow_mut().insert(caller, ArcadeCharacter { hair, skin, outfit });
    });
    ARCADE_QUOTES.with(|m| {
        m.borrow_mut().remove(&caller);
    });

    let entry = AuditLogEntry {
        timestamp: now,
        event_type: "arcade_customize".to_string(),
        proposal_id: 0,
        user: caller,
        amount_e8s: quote.amount,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
    Ok(())
}

/// Submit a finished round. Requires full access (the hole-1 preview can't
/// produce a 9-hole score). Insert-if-better per (game, player); returns the
/// caller's resulting 1-based rank on that game's board.
#[ic_cdk::update]
fn submit_arcade_score(game: String, millis: u64, per_hole: Vec<u8>) -> Result<u32, String> {
    require_authenticated()?;
    require_arcade_enabled()?;
    let caller = get_caller();

    if game != ARCADE_GAME_MINIGOLF {
        return Err("UNKNOWN_GAME".to_string());
    }
    let (has_stake, voted_recently) = arcade_access(caller);
    if !has_stake && !voted_recently {
        return Err("PARTICIPATION_REQUIRED".to_string());
    }
    if per_hole.len() != MINIGOLF_HOLES {
        return Err("INVALID_HOLE_COUNT".to_string());
    }
    if per_hole.iter().any(|&s| s == 0 || s > MINIGOLF_MAX_STROKES_PER_HOLE) {
        return Err("INVALID_STROKES".to_string());
    }
    if !(MINIGOLF_MIN_MILLIS..=MINIGOLF_MAX_MILLIS).contains(&millis) {
        return Err("INVALID_TIME".to_string());
    }
    let strokes: u32 = per_hole.iter().map(|&s| s as u32).sum();

    let now = current_time();
    let key = ArcadeScoreKey { game: game.clone(), player: caller };
    // The caller's best after this submission — tracked here so the rank
    // computation below doesn't re-read the row it just wrote.
    let (improved, best) = ARCADE_SCORES.with(|m| {
        let mut m = m.borrow_mut();
        let prev = m.get(&key).map(|p| (p.strokes, p.millis, p.submitted_at));
        let keep_new = match prev {
            Some(p) => arcade_score_beats((strokes, millis, now), p),
            None => true,
        };
        if keep_new {
            m.insert(key.clone(), ArcadeScore {
                game: game.clone(),
                player: caller,
                strokes,
                millis,
                per_hole,
                submitted_at: now,
            });
        }
        (keep_new, if keep_new { (strokes, millis, now) } else { prev.unwrap() })
    });

    if improved {
        let entry = AuditLogEntry {
            timestamp: now,
            event_type: "arcade_score".to_string(),
            proposal_id: strokes as u64,
            user: caller,
            amount_e8s: 0,
        };
        AUDIT_LOG.with(|log| {
            let _ = log.borrow_mut().append(&entry);
        });
    }

    // Current rank (count of entries that beat the caller's best, +1).
    let rank = ARCADE_SCORES.with(|m| {
        m.borrow()
            .iter()
            .filter(|e| {
                let s = e.value();
                s.game == game && arcade_score_beats((s.strokes, s.millis, s.submitted_at), best)
            })
            .count() as u32
            + 1
    });
    Ok(rank)
}

// ── Course editor (admin-built voxel hole layouts) ──
//
// Mini Golf Gold holes are 22×14 tile grids ("voxels" — each cell renders as
// a flat-shaded cube). The 9 defaults ship in the frontend; admins can
// override any hole from the Admin console (admin_set_arcade_hole). The game
// merges on-chain overrides over the built-ins at load, so an edited hole is
// live for every player immediately and survives upgrades.

const ARCADE_GRID_W: u8 = 22;
const ARCADE_GRID_H: u8 = 14;
/// Cell palette: 0 void, 1 grass, 2 wall, 3 sand, 4 water, 5..8 slope
/// (N/S/E/W), 9 post. Mirrored by the frontend engine.
const ARCADE_MAX_CELL: u8 = 9;
const ARCADE_WALKABLE: [u8; 5] = [1, 5, 6, 7, 8];
const MAX_ARCADE_BARS: usize = 2;
const MAX_ARCADE_HOLE_NAME: usize = 40;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeBarDef {
    /// Pivot cell (grid coords).
    pub cx: u8,
    pub cy: u8,
    pub len_cells: u8,
    /// Angular speed, milliradians per second.
    pub speed_mrad: u32,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeHoleDef {
    pub name: String,
    pub par: u8,
    pub w: u8,
    pub h: u8,
    /// Row-major cell types, w×h entries.
    pub cells: Vec<u8>,
    pub tee_x: u8,
    pub tee_y: u8,
    pub cup_x: u8,
    pub cup_y: u8,
    pub bars: Vec<ArcadeBarDef>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ArcadeCourseEntry {
    pub index: u8,
    pub hole: ArcadeHoleDef,
}

impl_storable!(ArcadeHoleDef);

thread_local! {
    static ARCADE_COURSE: RefCell<StableBTreeMap<u8, ArcadeHoleDef, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(45))))
    });
}

fn validate_arcade_hole(hole: &ArcadeHoleDef) -> Result<(), String> {
    if hole.name.is_empty() || hole.name.chars().count() > MAX_ARCADE_HOLE_NAME {
        return Err("INVALID_HOLE_NAME".to_string());
    }
    if !(2..=6).contains(&hole.par) {
        return Err("INVALID_PAR".to_string());
    }
    if hole.w != ARCADE_GRID_W || hole.h != ARCADE_GRID_H {
        return Err("INVALID_GRID_SIZE".to_string());
    }
    if hole.cells.len() != (hole.w as usize) * (hole.h as usize) {
        return Err("INVALID_CELL_COUNT".to_string());
    }
    if hole.cells.iter().any(|&c| c > ARCADE_MAX_CELL) {
        return Err("INVALID_CELL_TYPE".to_string());
    }
    let cell_at = |x: u8, y: u8| hole.cells[(y as usize) * (hole.w as usize) + (x as usize)];
    for (x, y, label) in [(hole.tee_x, hole.tee_y, "TEE"), (hole.cup_x, hole.cup_y, "CUP")] {
        if x >= hole.w || y >= hole.h {
            return Err(format!("{}_OUT_OF_BOUNDS", label));
        }
        if !ARCADE_WALKABLE.contains(&cell_at(x, y)) {
            return Err(format!("{}_NOT_ON_GREEN", label));
        }
    }
    if hole.tee_x == hole.cup_x && hole.tee_y == hole.cup_y {
        return Err("TEE_EQUALS_CUP".to_string());
    }
    if hole.bars.len() > MAX_ARCADE_BARS {
        return Err("TOO_MANY_BARS".to_string());
    }
    for bar in &hole.bars {
        if bar.cx >= hole.w || bar.cy >= hole.h || bar.len_cells == 0 || bar.len_cells > 6 || bar.speed_mrad > 10_000 {
            return Err("INVALID_BAR".to_string());
        }
    }
    Ok(())
}

/// On-chain hole overrides (built-in defaults live in the frontend; only
/// admin-edited holes are stored). Public so the game can merge at load.
#[ic_cdk::query]
fn get_arcade_course() -> Vec<ArcadeCourseEntry> {
    ARCADE_COURSE.with(|m| {
        m.borrow()
            .iter()
            .map(|e| ArcadeCourseEntry { index: *e.key(), hole: e.value() })
            .collect()
    })
}

/// Admin: replace one hole's voxel layout (0-based index). Validated so a
/// typo can't ship an unplayable grid.
#[ic_cdk::update(guard = "require_admin")]
fn admin_set_arcade_hole(index: u8, hole: ArcadeHoleDef) -> Result<(), String> {
    if index as usize >= MINIGOLF_HOLES {
        return Err("INVALID_HOLE_INDEX".to_string());
    }
    validate_arcade_hole(&hole)?;
    ARCADE_COURSE.with(|m| {
        m.borrow_mut().insert(index, hole);
    });
    log_dapp_event("arcade_hole_edit", index as u64, get_caller(), 0);
    Ok(())
}

/// Admin: drop one hole's override, reverting it to the built-in layout.
#[ic_cdk::update(guard = "require_admin")]
fn admin_reset_arcade_hole(index: u8) -> Result<(), String> {
    let existed = ARCADE_COURSE.with(|m| m.borrow_mut().remove(&index)).is_some();
    if !existed {
        return Err("NO_OVERRIDE".to_string());
    }
    log_dapp_event("arcade_hole_reset", index as u64, get_caller(), 0);
    Ok(())
}

/// Top 100 for one game: fewest strokes, fastest time, earliest submission.
#[ic_cdk::query]
fn get_arcade_leaderboard(game: String) -> Vec<ArcadeLeaderboardRow> {
    let mut scores: Vec<ArcadeScore> = ARCADE_SCORES.with(|m| {
        m.borrow()
            .iter()
            .map(|e| e.value())
            .filter(|s| s.game == game)
            .collect()
    });
    scores.sort_by_key(|s| (s.strokes, s.millis, s.submitted_at));
    scores
        .into_iter()
        .take(ARCADE_LEADERBOARD_LIMIT)
        .enumerate()
        .map(|(i, s)| ArcadeLeaderboardRow {
            rank: i as u32 + 1,
            player: s.player,
            strokes: s.strokes,
            millis: s.millis,
            submitted_at: s.submitted_at,
        })
        .collect()
}

// ==========================================
// 18. Early Adopters (permanent stake, monthly yield shares)
// ==========================================
//
// Early adopters stake ICP into a single platform-owned 2-year neuron.
// THE STAKE IS PERMANENT — there is deliberately NO unstake method anywhere
// in this section, and the UI states it in bold before anyone commits.
//
// Every ~month (30-day periods) the neuron's collected yield is settled:
//   • a month that yields under 500 ICP is restaked into the neuron in
//     full — nothing pays out, the principal compounds for everyone;
//   • otherwise the first 1,000 ICP of the month's yield goes to the
//     treasury (a 500–1,000 ICP month is entirely treasury's);
//   • the excess above 1,000 ICP joins the share pool and is split across
//     all early adopters IN PROPORTION TO THEIR STAKED ICP — but only when at
//     least 100 ICP is available to split; otherwise the pool rolls over
//     to the next month;
//   • an early adopter must claim their share before the NEXT monthly
//     settlement — unclaimed shares are forfeited to the treasury then.

/// 1,000 ICP — the treasury's monthly cut comes first.
const EARLY_ADOPTER_TREASURY_CUT_E8S: u64 = 100_000_000_000;
/// 2,000 ICP — once a settled month's yield reaches this, membership closes
/// PERMANENTLY: no new early adopters, ever. Existing early adopters can still top
/// up at any time.
const EARLY_ADOPTER_CLOSE_YIELD_E8S: u64 = 200_000_000_000;
/// 500 ICP — a month that yields less than this is restaked into the neuron
/// (compounding everyone's future yield) instead of being paid out at all.
const EARLY_ADOPTER_RESTAKE_BELOW_E8S: u64 = 50_000_000_000;
/// 2 years — the early adopter neuron's dissolve delay.
const EARLY_ADOPTER_DISSOLVE_SECS: u32 = 63_115_200;
/// 100 ICP — minimum distributable pot; below this it rolls over.
const EARLY_ADOPTER_MIN_DISTRIBUTION_E8S: u64 = 10_000_000_000;
/// 1 ICP minimum buy-in.
const MIN_EARLY_ADOPTER_STAKE_E8S: u64 = 100_000_000;
/// Settlement period: 30-day months indexed from the Unix epoch.
const EARLY_ADOPTER_PERIOD_NANOS: u64 = 30 * DAY_NANOS;
const MAX_EARLY_ADOPTERS: u64 = 10_000;

/// The platform neuron's stake account (locally a plain subaccount; mainnet
/// integration will pin a real 2-year neuron — same canary path as staking).
const EARLY_ADOPTER_NEURON_SUBACCOUNT: [u8; 32] = [5u8; 32];
/// Where neuron yield lands between settlements.
const EARLY_ADOPTER_YIELD_SUBACCOUNT: [u8; 32] = [6u8; 32];
/// Allocated-but-unclaimed shares + rollover live here.
const EARLY_ADOPTER_SHARE_POOL_SUBACCOUNT: [u8; 32] = [7u8; 32];

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopter {
    pub user: Principal,
    pub staked_e8s: u64,
    pub joined_at: u64,
    pub last_stake_at: u64,
    /// Current unclaimed share (e8s). Zeroed (→ treasury) at each settlement.
    pub claimable_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopterState {
    pub total_staked_e8s: u64,
    /// Pool e8s carried forward because a month's pot was under 100 ICP.
    pub rollover_e8s: u64,
    /// Last settled 30-day period index (epoch-based).
    pub last_processed_month: u64,
    pub total_yield_e8s: u64,
    pub total_distributed_e8s: u64,
    pub total_expired_e8s: u64,
    /// Latched true the first time a month's yield reaches 2,000 ICP —
    /// membership never reopens (existing early adopters may still top up).
    #[serde(default)]
    pub membership_closed: bool,
    /// ── Neuron bootstrap (same lifecycle as the staking tiers) ──
    /// Claim nonce, fixed at the first stake.
    #[serde(default)]
    pub nonce: u64,
    #[serde(default)]
    pub neuron_id: Option<u64>,
    /// Stake (and restaked yield) not yet claimed/refreshed into the neuron.
    #[serde(default)]
    pub pending_refresh_e8s: u64,
    /// 0 NotStarted → 1 Claimed → 2 DelaySet → 3 Ready (following the
    /// primary voting neuron on all topics — it votes on NNS proposals).
    #[serde(default)]
    pub bootstrap: u8,
    /// Lifetime yield restaked into the neuron (sub-500-ICP months).
    #[serde(default)]
    pub total_restaked_e8s: u64,
    /// In-flight settlement journal (None when no settlement is mid-run).
    #[serde(default)]
    pub pending_job: Option<EarlyAdopterJob>,
}

/// Settlement journal: the month's amounts are computed ONCE from the inbox
/// snapshot and each ledger leg is flagged as it lands, so a retry resumes
/// where it failed instead of re-routing the remaining balance — re-routing
/// double-dipped the treasury's 1,000 ICP cut and could mis-restake the
/// early adopters' pot (review 2026-06-11). Unclaimed shares are also zeroed
/// synchronously at job creation, which closes the window where a claim
/// landing mid-settlement double-spent the share pool.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopterJob {
    pub month: u64,
    pub started_at: u64,
    pub yield_e8s: u64,
    pub expired_e8s: u64,
    pub restake_e8s: u64,
    pub treasury_cut_e8s: u64,
    pub excess_net_e8s: u64,
    pub expired_done: bool,
    pub restake_done: bool,
    pub cut_done: bool,
    pub pool_done: bool,
}

/// One monthly settlement — drives the yield + share-pool charts.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopterRound {
    pub month: u64,
    pub settled_at: u64,
    pub yield_e8s: u64,
    pub treasury_e8s: u64,
    /// Total allocated to early adopters this round (proportional to stake).
    pub distributed_e8s: u64,
    /// Yield restaked into the neuron (months under 500 ICP).
    #[serde(default)]
    pub restaked_e8s: u64,
    pub early_adopter_count: u64,
    /// Unclaimed shares from the PREVIOUS round forfeited to the treasury.
    pub expired_e8s: u64,
    pub rollover_after_e8s: u64,
    /// Share-pool balance after this settlement (unclaimed + rollover).
    pub share_pool_after_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopterInfo {
    pub enabled: bool,
    /// True once any month's yield has reached `close_threshold_e8s` —
    /// permanently; new members are rejected, existing ones may top up.
    pub membership_closed: bool,
    pub close_threshold_e8s: u64,
    /// Months yielding under this are restaked into the neuron.
    pub restake_threshold_e8s: u64,
    pub total_restaked_e8s: u64,
    /// The early adopter neuron (None until the first claim lands).
    pub neuron_id: Option<u64>,
    /// True once the neuron follows the primary voting neuron on all topics
    /// (bootstrap Ready) — it then votes on every NNS proposal the leader does.
    pub follows_primary_neuron: bool,
    pub primary_neuron_id: u64,
    pub min_stake_e8s: u64,
    pub treasury_cut_e8s: u64,
    pub min_distribution_e8s: u64,
    pub period_nanos: u64,
    pub early_adopter_count: u64,
    pub total_staked_e8s: u64,
    pub rollover_e8s: u64,
    /// Live share-pool ledger balance (unclaimed shares + rollover).
    pub share_pool_e8s: u64,
    pub total_yield_e8s: u64,
    pub total_distributed_e8s: u64,
    /// Nanosecond timestamp when the next settlement can run.
    pub next_distribution_at: u64,
    pub my_staked_e8s: u64,
    pub my_claimable_e8s: u64,
    pub fee_e8s: u64,
}

impl_storable!(EarlyAdopter);
impl_storable!(EarlyAdopterState);
impl_storable!(EarlyAdopterRound);

thread_local! {
    static EARLY_ADOPTERS: RefCell<StableBTreeMap<Principal, EarlyAdopter, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(46))))
    });

    static EARLY_ADOPTER_STATE: RefCell<StableCell<EarlyAdopterState, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(47)), EarlyAdopterState {
            total_staked_e8s: 0,
            rollover_e8s: 0,
            last_processed_month: 0,
            total_yield_e8s: 0,
            total_distributed_e8s: 0,
            total_expired_e8s: 0,
            membership_closed: false,
            nonce: 0,
            neuron_id: None,
            pending_refresh_e8s: 0,
            bootstrap: 0,
            total_restaked_e8s: 0,
            pending_job: None,
        }))
    });

    static EARLY_ADOPTER_ROUNDS: RefCell<StableBTreeMap<u64, EarlyAdopterRound, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(48))))
    });
}

fn require_early_adopters_enabled() -> Result<(), String> {
    if !feature_enabled(FLAG_EARLY_ADOPTERS) {
        return Err("FEATURE_DISABLED".to_string());
    }
    Ok(())
}

fn early_adopter_month(now: u64) -> u64 {
    now / EARLY_ADOPTER_PERIOD_NANOS
}

fn derive_early_adopter_subaccount(user: &Principal) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"proof_of_burn_early_adopter_v1");
    hasher.update(user.as_slice());
    let result = hasher.finalize();
    let mut sub = [0u8; 32];
    sub.copy_from_slice(&result);
    sub
}

/// Pure month routing (unit-tested): where does this month's yield go?
/// Returns (restaked, treasury_cut, excess_net).
/// • Under 500 ICP: the whole month is restaked into the neuron — it
///   compounds everyone's future yield instead of paying out.
/// • Otherwise the first 1,000 ICP is the treasury's and the excess (net of
///   the one ledger fee burned moving it into the share pool — found by
///   local e2e) feeds the distribution pot.
fn early_adopter_route_yield(yield_e8s: u64, fee: u64) -> (u64, u64, u64) {
    if yield_e8s < EARLY_ADOPTER_RESTAKE_BELOW_E8S {
        return (yield_e8s, 0, 0);
    }
    let treasury_cut = yield_e8s.min(EARLY_ADOPTER_TREASURY_CUT_E8S);
    let excess = yield_e8s.saturating_sub(treasury_cut);
    let excess_net = if excess > fee { excess - fee } else { 0 };
    (0, treasury_cut, excess_net)
}

/// Pure pot allocation (unit-tested): split `pot` across early adopters in
/// proportion to their staked ICP. Returns the per-founder shares and the
/// integer-division dust left over. Pots under 100 ICP allocate nothing.
fn early_adopter_allocate(pot: u64, stakes: &[(Principal, u64)]) -> (Vec<(Principal, u64)>, u64) {
    let total: u128 = stakes.iter().map(|(_, s)| *s as u128).sum();
    if total == 0 || pot < EARLY_ADOPTER_MIN_DISTRIBUTION_E8S {
        return (Vec::new(), pot);
    }
    let mut shares = Vec::with_capacity(stakes.len());
    let mut allocated: u64 = 0;
    for (user, stake) in stakes {
        let share = ((pot as u128) * (*stake as u128) / total) as u64;
        if share > 0 {
            shares.push((*user, share));
            allocated = allocated.saturating_add(share);
        }
    }
    (shares, pot - allocated)
}

#[ic_cdk::query]
fn get_early_adopter_info() -> EarlyAdopterInfo {
    let caller = get_caller();
    let state = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().clone());
    let me = EARLY_ADOPTERS.with(|m| m.borrow().get(&caller));
    let unclaimed: u64 = EARLY_ADOPTERS.with(|m| {
        m.borrow().iter().map(|e| e.value().claimable_e8s).sum()
    });
    let config = CONFIG.with(|c| c.borrow().get().clone());
    EarlyAdopterInfo {
        enabled: feature_enabled(FLAG_EARLY_ADOPTERS),
        membership_closed: state.membership_closed,
        close_threshold_e8s: EARLY_ADOPTER_CLOSE_YIELD_E8S,
        restake_threshold_e8s: EARLY_ADOPTER_RESTAKE_BELOW_E8S,
        total_restaked_e8s: state.total_restaked_e8s,
        neuron_id: state.neuron_id,
        follows_primary_neuron: state.bootstrap >= 3,
        primary_neuron_id: config.primary_neuron_id,
        min_stake_e8s: MIN_EARLY_ADOPTER_STAKE_E8S,
        treasury_cut_e8s: EARLY_ADOPTER_TREASURY_CUT_E8S,
        min_distribution_e8s: EARLY_ADOPTER_MIN_DISTRIBUTION_E8S,
        period_nanos: EARLY_ADOPTER_PERIOD_NANOS,
        early_adopter_count: EARLY_ADOPTERS.with(|m| m.borrow().len()),
        total_staked_e8s: state.total_staked_e8s,
        rollover_e8s: state.rollover_e8s,
        share_pool_e8s: state.rollover_e8s.saturating_add(unclaimed),
        total_yield_e8s: state.total_yield_e8s,
        total_distributed_e8s: state.total_distributed_e8s,
        next_distribution_at: (state.last_processed_month + 1) * EARLY_ADOPTER_PERIOD_NANOS,
        my_staked_e8s: me.as_ref().map(|c| c.staked_e8s).unwrap_or(0),
        my_claimable_e8s: me.as_ref().map(|c| c.claimable_e8s).unwrap_or(0),
        fee_e8s: 10_000,
    }
}

/// One row of the public early adopter roster.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EarlyAdopterPublic {
    pub user: Principal,
    pub staked_e8s: u64,
    pub joined_at: u64,
    /// True when this early adopter is a platform admin — rendered as the
    /// "FOUNDER" tag (the team has its own ICP locked in the same neuron).
    pub is_admin: bool,
}

/// The full early adopter roster, largest stake first.
#[ic_cdk::query]
fn list_early_adopters() -> Vec<EarlyAdopterPublic> {
    let admins = CONFIG.with(|c| c.borrow().get().admins.clone());
    let mut roster: Vec<EarlyAdopterPublic> = EARLY_ADOPTERS.with(|m| {
        m.borrow()
            .iter()
            .map(|e| {
                let c = e.value();
                EarlyAdopterPublic {
                    user: c.user,
                    staked_e8s: c.staked_e8s,
                    joined_at: c.joined_at,
                    is_admin: admins.contains(&c.user),
                }
            })
            .collect()
    });
    roster.sort_by(|a, b| b.staked_e8s.cmp(&a.staked_e8s).then(a.joined_at.cmp(&b.joined_at)));
    roster
}

/// Settlement history, oldest first (chart data: yield per month + share
/// pool balance after each settlement).
#[ic_cdk::query]
fn list_early_adopter_rounds() -> Vec<EarlyAdopterRound> {
    let mut rounds: Vec<EarlyAdopterRound> =
        EARLY_ADOPTER_ROUNDS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
    rounds.sort_by_key(|r| r.month);
    rounds
}

/// The caller's deposit account for becoming (or topping up as) a
/// early adopter. Fund it with `amount + 0.0001 ICP`, then call
/// `early_adopter_stake(amount)`.
#[ic_cdk::query]
fn get_early_adopter_deposit_address() -> LedgerAccount {
    let caller = get_caller();
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_early_adopter_subaccount(&caller)),
    }
}

/// Stake into the platform's 2-year early adopter neuron. PERMANENT: there is
/// no unstake path, by design — the principal can never be withdrawn.
#[ic_cdk::update]
async fn early_adopter_stake(amount_e8s: u64) -> Result<(), String> {
    require_authenticated()?;
    require_early_adopters_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    if amount_e8s < MIN_EARLY_ADOPTER_STAKE_E8S {
        return Err("BELOW_MIN_STAKE".to_string());
    }
    let is_member = EARLY_ADOPTERS.with(|m| m.borrow().get(&caller).is_some());
    // Once a month's yield has hit 2,000 ICP, the founders' table is full —
    // forever. Existing early adopters may still top up at any time.
    if !is_member {
        let closed = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().membership_closed);
        if closed {
            return Err("MEMBERSHIP_CLOSED".to_string());
        }
        let at_quota = EARLY_ADOPTERS.with(|m| m.borrow().len() >= MAX_EARLY_ADOPTERS);
        if at_quota {
            return Err("EARLY_ADOPTER_QUOTA_REACHED".to_string());
        }
    }

    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let sub = derive_early_adopter_subaccount(&caller);
    let escrow = LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(sub),
    };
    let balance = call_ledger_balance(ledger_id, escrow).await?;
    // checked_add: a hostile amount near u64::MAX must not wrap past the
    // deposit check (house pattern — same as upvote_idea).
    let required = amount_e8s.checked_add(10_000).ok_or("INVALID_AMOUNT")?;
    if balance < required {
        return Err("INSUFFICIENT_DEPOSIT".to_string());
    }

    // Fix the claim nonce at the very first stake — the governance staking
    // account derives from it (offset +9 keeps clear of the tier nonces).
    let nonce = EARLY_ADOPTER_STATE.with(|c| {
        let mut s = c.borrow().get().clone();
        if s.nonce == 0 {
            s.nonce = current_time() + 9;
            c.borrow_mut().set(s.clone());
        }
        s.nonce
    });

    // Escrow → the neuron's stake. Mainnet: legacy transfer with memo ==
    // nonce to the governance staking account (claimable). Local: park in
    // the early adopter neuron subaccount (mock governance claims from there).
    if config.is_local || cfg!(not(target_arch = "wasm32")) {
        let neuron_dest = LedgerAccount {
            owner: get_canister_id(),
            subaccount: Some(EARLY_ADOPTER_NEURON_SUBACCOUNT),
        };
        call_ledger_transfer(ledger_id, Some(sub), neuron_dest, amount_e8s, Some(10_000))
            .await
            .map_err(|e| format!("STAKE_TRANSFER_FAILED: {}", e))?;
    } else {
        let gov = Principal::from_text(NNS_GOVERNANCE_ID).unwrap();
        let staking_sub = neuron_staking_subaccount(get_canister_id(), nonce);
        call_ledger_legacy_transfer(
            ledger_id,
            Some(sub),
            account_id_bytes(gov, &staking_sub),
            amount_e8s,
            10_000,
            nonce,
        )
        .await
        .map_err(|e| format!("STAKE_TRANSFER_FAILED: {}", e))?;
    }

    let now = current_time();
    EARLY_ADOPTERS.with(|m| {
        let mut m = m.borrow_mut();
        let mut entry = m.get(&caller).unwrap_or(EarlyAdopter {
            user: caller,
            staked_e8s: 0,
            joined_at: now,
            last_stake_at: now,
            claimable_e8s: 0,
        });
        entry.staked_e8s = entry.staked_e8s.saturating_add(amount_e8s);
        entry.last_stake_at = now;
        m.insert(caller, entry);
    });
    EARLY_ADOPTER_STATE.with(|c| {
        let mut s = c.borrow().get().clone();
        s.total_staked_e8s = s.total_staked_e8s.saturating_add(amount_e8s);
        s.pending_refresh_e8s = s.pending_refresh_e8s.saturating_add(amount_e8s);
        // The very first stake anchors the settlement clock to "now" so the
        // first month isn't instantly due.
        if s.last_processed_month == 0 {
            s.last_processed_month = early_adopter_month(now);
        }
        c.borrow_mut().set(s);
    });

    let entry = AuditLogEntry {
        timestamp: now,
        event_type: "early_adopter_stake".to_string(),
        proposal_id: 0,
        user: caller,
        amount_e8s,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });

    // Best-effort claim + bootstrap (dissolve delay, follow the primary
    // voting neuron); the sweep repairs any failure.
    if let Err(e) = advance_early_adopter_bootstrap().await {
        canister_print(&format!("early_adopter_stake: bootstrap deferred to sweep: {}", e));
    }
    Ok(())
}

/// Drive the early adopter neuron's state machine: claim/refresh pending stake,
/// then (once) set the 2-year dissolve delay, go public, and FOLLOW THE
/// PRIMARY VOTING NEURON on all topics — from then on it votes on every NNS
/// proposal the leader votes on. Mirrors `advance_tier_bootstrap`.
async fn advance_early_adopter_bootstrap() -> Result<(), String> {
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let mut state = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().clone());

    if state.pending_refresh_e8s > 0 && state.nonce != 0 {
        let id = gov_claim_or_refresh(state.nonce, state.pending_refresh_e8s, state.neuron_id).await?;
        state.pending_refresh_e8s = 0;
        if state.neuron_id.is_none() {
            state.neuron_id = Some(id);
            state.bootstrap = 1; // Claimed
        }
        EARLY_ADOPTER_STATE.with(|c| { c.borrow_mut().set(state.clone()); });
    }

    let neuron_id = match state.neuron_id {
        Some(id) => id,
        None => return Ok(()),
    };

    if state.bootstrap == 1 {
        gov_increase_dissolve_delay(neuron_id, EARLY_ADOPTER_DISSOLVE_SECS).await?;
        state.bootstrap = 2; // DelaySet
        EARLY_ADOPTER_STATE.with(|c| { c.borrow_mut().set(state.clone()); });
    }
    if state.bootstrap == 2 {
        gov_set_visibility(neuron_id).await?;
        gov_follow_all_topics(neuron_id, config.primary_neuron_id).await?;
        state.bootstrap = 3; // Ready — following the primary neuron
        EARLY_ADOPTER_STATE.with(|c| { c.borrow_mut().set(state.clone()); });
    }
    Ok(())
}

/// Claim the caller's current monthly share. Shares not claimed before the
/// next settlement are forfeited to the treasury.
#[ic_cdk::update]
async fn claim_early_adopter_yield() -> Result<u64, String> {
    require_authenticated()?;
    require_early_adopters_enabled()?;
    let caller = get_caller();
    let _guard = CallerGuard::new(caller)?;

    let claimable = EARLY_ADOPTERS
        .with(|m| m.borrow().get(&caller))
        .map(|c| c.claimable_e8s)
        .unwrap_or(0);
    if claimable <= 10_000 {
        return Err("NOTHING_TO_CLAIM".to_string());
    }
    // Zero the share BEFORE the transfer (no double-claim across await); on
    // transfer failure it is restored.
    EARLY_ADOPTERS.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(mut c) = m.get(&caller) {
            c.claimable_e8s = 0;
            m.insert(caller, c);
        }
    });
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let net = claimable - 10_000;
    let dest = LedgerAccount { owner: caller, subaccount: None };
    let transfer = call_ledger_transfer(
        config.ledger_canister_id,
        Some(EARLY_ADOPTER_SHARE_POOL_SUBACCOUNT),
        dest,
        net,
        Some(10_000),
    )
    .await;
    if let Err(e) = transfer {
        EARLY_ADOPTERS.with(|m| {
            let mut m = m.borrow_mut();
            if let Some(mut c) = m.get(&caller) {
                c.claimable_e8s = claimable;
                m.insert(caller, c);
            }
        });
        return Err(format!("CLAIM_TRANSFER_FAILED: {}", e));
    }
    record_payout(caller, PayoutType::EarlyAdopterYield, IdeaToken::ICP, net, 0);
    let entry = AuditLogEntry {
        timestamp: current_time(),
        event_type: "early_adopter_claim".to_string(),
        proposal_id: 0,
        user: caller,
        amount_e8s: net,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
    Ok(net)
}

/// Run (or resume) one monthly settlement: expire unclaimed shares →
/// treasury, route the month's yield (<500 restake / 1,000 cut / excess →
/// pot), then split the pot in proportion to stake. All amounts are
/// journaled in EarlyAdopterState.pending_job before any transfer, and every
/// completed leg is flagged, so a retry after a failed transfer resumes
/// exactly where it stopped — it never re-reads the inbox and re-routes.
async fn early_adopter_run_settlement(now: u64) -> Result<(), String> {
    let config = CONFIG.with(|c| c.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let fee = 10_000u64;
    let canister = get_canister_id();
    let treasury = LedgerAccount { owner: canister, subaccount: Some(TREASURY_SUBACCOUNT) };

    // 0. Load the in-flight job, or open a new one from the inbox snapshot.
    let mut job = match EARLY_ADOPTER_STATE.with(|c| c.borrow().get().pending_job.clone()) {
        Some(job) => job,
        None => {
            let inbox = LedgerAccount { owner: canister, subaccount: Some(EARLY_ADOPTER_YIELD_SUBACCOUNT) };
            let yield_e8s = call_ledger_balance(ledger_id, inbox).await?;
            let (restaked, treasury_cut, excess_net) = early_adopter_route_yield(yield_e8s, fee);
            // Snapshot + zero the expiring shares in ONE synchronous block:
            // from this instant claims return NOTHING_TO_CLAIM, so a claim
            // racing the settlement can't double-spend the share pool.
            let expired = EARLY_ADOPTERS.with(|m| {
                let mut m = m.borrow_mut();
                let keys: Vec<Principal> = m.iter().map(|e| *e.key()).collect();
                let mut total = 0u64;
                for k in keys {
                    if let Some(mut c) = m.get(&k) {
                        if c.claimable_e8s > 0 {
                            total = total.saturating_add(c.claimable_e8s);
                            c.claimable_e8s = 0;
                            m.insert(k, c);
                        }
                    }
                }
                total
            });
            let job = EarlyAdopterJob {
                month: early_adopter_month(now),
                started_at: now,
                yield_e8s,
                expired_e8s: expired,
                restake_e8s: restaked,
                treasury_cut_e8s: treasury_cut,
                excess_net_e8s: excess_net,
                expired_done: false,
                restake_done: false,
                cut_done: false,
                pool_done: false,
            };
            EARLY_ADOPTER_STATE.with(|c| {
                let mut s = c.borrow().get().clone();
                s.pending_job = Some(job.clone());
                c.borrow_mut().set(s);
            });
            job
        }
    };
    let persist_job = |job: &EarlyAdopterJob| {
        EARLY_ADOPTER_STATE.with(|c| {
            let mut s = c.borrow().get().clone();
            s.pending_job = Some(job.clone());
            c.borrow_mut().set(s);
        });
    };

    // 1. Forfeit the expired shares (share pool → treasury).
    if !job.expired_done {
        if job.expired_e8s > 0 {
            let pool_acc = LedgerAccount { owner: canister, subaccount: Some(EARLY_ADOPTER_SHARE_POOL_SUBACCOUNT) };
            let pool_balance = call_ledger_balance(ledger_id, pool_acc).await?;
            let amt = job.expired_e8s.min(pool_balance).saturating_sub(fee);
            if amt > 0 {
                call_ledger_transfer(ledger_id, Some(EARLY_ADOPTER_SHARE_POOL_SUBACCOUNT), treasury.clone(), amt, Some(fee))
                    .await
                    .map_err(|e| format!("EXPIRE_TRANSFER_FAILED: {}", e))?;
            }
        }
        job.expired_done = true;
        persist_job(&job);
    }

    // 2. Route the month's yield: restake (<500), treasury cut, pot excess.
    if !job.restake_done {
        if job.restake_e8s > fee {
            let neuron_acc = LedgerAccount { owner: canister, subaccount: Some(EARLY_ADOPTER_NEURON_SUBACCOUNT) };
            call_ledger_transfer(ledger_id, Some(EARLY_ADOPTER_YIELD_SUBACCOUNT), neuron_acc, job.restake_e8s - fee, Some(fee))
                .await
                .map_err(|e| format!("RESTAKE_TRANSFER_FAILED: {}", e))?;
        }
        job.restake_done = true;
        persist_job(&job);
    }
    if !job.cut_done {
        if job.treasury_cut_e8s > fee {
            call_ledger_transfer(ledger_id, Some(EARLY_ADOPTER_YIELD_SUBACCOUNT), treasury, job.treasury_cut_e8s - fee, Some(fee))
                .await
                .map_err(|e| format!("TREASURY_CUT_FAILED: {}", e))?;
        }
        job.cut_done = true;
        persist_job(&job);
    }
    if !job.pool_done {
        if job.excess_net_e8s > 0 {
            let pool = LedgerAccount { owner: canister, subaccount: Some(EARLY_ADOPTER_SHARE_POOL_SUBACCOUNT) };
            call_ledger_transfer(ledger_id, Some(EARLY_ADOPTER_YIELD_SUBACCOUNT), pool, job.excess_net_e8s, Some(fee))
                .await
                .map_err(|e| format!("POOL_TRANSFER_FAILED: {}", e))?;
        }
        job.pool_done = true;
        persist_job(&job);
    }

    // 3. Finalize (runs exactly once — the job is cleared at the end):
    // allocate shares in proportion to each early adopter's staked ICP.
    let state = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().clone());
    let n = EARLY_ADOPTERS.with(|m| m.borrow().len());
    let pot = job.excess_net_e8s.saturating_add(state.rollover_e8s);
    let stakes: Vec<(Principal, u64)> = EARLY_ADOPTERS.with(|m| {
        m.borrow().iter().map(|e| (*e.key(), e.value().staked_e8s)).collect()
    });
    let (shares, new_rollover) = early_adopter_allocate(pot, &stakes);
    let allocated: u64 = shares.iter().map(|(_, s)| *s).sum();
    EARLY_ADOPTERS.with(|m| {
        let mut m = m.borrow_mut();
        for (user, share) in &shares {
            if let Some(mut c) = m.get(user) {
                c.claimable_e8s = *share;
                m.insert(*user, c);
            }
        }
    });

    // 4. Persist the round + state and close the job.
    let month = job.month;
    let yield_e8s = job.yield_e8s;
    let unclaimed_now: u64 = EARLY_ADOPTERS.with(|m| m.borrow().iter().map(|e| e.value().claimable_e8s).sum());
    EARLY_ADOPTER_ROUNDS.with(|m| {
        m.borrow_mut().insert(month, EarlyAdopterRound {
            month,
            settled_at: now,
            yield_e8s,
            treasury_e8s: job.treasury_cut_e8s,
            distributed_e8s: allocated,
            restaked_e8s: job.restake_e8s,
            early_adopter_count: n,
            expired_e8s: job.expired_e8s,
            rollover_after_e8s: new_rollover,
            share_pool_after_e8s: new_rollover.saturating_add(unclaimed_now),
        });
    });
    let newly_closed = !state.membership_closed && yield_e8s >= EARLY_ADOPTER_CLOSE_YIELD_E8S;
    EARLY_ADOPTER_STATE.with(|c| {
        let mut s = c.borrow().get().clone();
        s.rollover_e8s = new_rollover;
        s.last_processed_month = month.max(s.last_processed_month);
        s.total_yield_e8s = s.total_yield_e8s.saturating_add(yield_e8s);
        s.total_distributed_e8s = s.total_distributed_e8s.saturating_add(allocated);
        s.total_expired_e8s = s.total_expired_e8s.saturating_add(job.expired_e8s);
        if job.restake_e8s > 0 {
            s.total_restaked_e8s = s.total_restaked_e8s.saturating_add(job.restake_e8s);
            // Restaked yield must be claim/refreshed into the neuron too.
            s.pending_refresh_e8s = s.pending_refresh_e8s.saturating_add(job.restake_e8s.saturating_sub(fee));
        }
        if newly_closed {
            s.membership_closed = true;
        }
        s.pending_job = None;
        c.borrow_mut().set(s);
    });
    if newly_closed {
        let entry = AuditLogEntry {
            timestamp: now,
            event_type: "early_adopter_membership_closed".to_string(),
            proposal_id: month,
            user: get_canister_id(),
            amount_e8s: yield_e8s,
        };
        AUDIT_LOG.with(|log| {
            let _ = log.borrow_mut().append(&entry);
        });
    }
    let entry = AuditLogEntry {
        timestamp: now,
        event_type: "early_adopter_settlement".to_string(),
        proposal_id: month,
        user: get_canister_id(),
        amount_e8s: yield_e8s,
    };
    AUDIT_LOG.with(|log| {
        let _ = log.borrow_mut().append(&entry);
    });
    Ok(())
}

/// Sweep hook: settle once whenever a new 30-day period has started (no-op
/// until the first early adopter exists).
async fn early_adopter_settlement_check() {
    if !feature_enabled(FLAG_EARLY_ADOPTERS) {
        return;
    }
    let has_members = EARLY_ADOPTERS.with(|m| !m.borrow().is_empty());
    if !has_members {
        return;
    }
    // Repair the neuron bootstrap (claim restaked yield, follow the leader).
    if let Err(e) = advance_early_adopter_bootstrap().await {
        canister_print(&format!("early_adopter bootstrap retry failed: {}", e));
    }
    let now = current_time();
    let state = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().clone());
    // Run when a new period starts, and ALSO whenever a journaled settlement
    // is mid-flight (a leg failed) so it resumes promptly.
    if early_adopter_month(now) > state.last_processed_month || state.pending_job.is_some() {
        if let Err(e) = early_adopter_run_settlement(now).await {
            canister_print(&format!("early_adopter settlement failed (will retry next sweep): {}", e));
        }
    }
}

/// Local-dev: where to send mock yield (the neuron's maturity inbox).
#[ic_cdk::query]
fn get_early_adopter_yield_inbox_address() -> LedgerAccount {
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(EARLY_ADOPTER_YIELD_SUBACCOUNT),
    }
}

/// Local-dev: force a settlement now regardless of the period clock.
#[ic_cdk::update]
async fn dev_run_early_adopter_settlement() -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    early_adopter_run_settlement(current_time()).await
}

/// Local-dev: jump the page to a significant preset state (VISUAL ONLY —
/// model state is rewritten, ledger balances are not, so claims won't pay).
/// 0 = fresh & open (empty everything), 1 = open with members + a varied
/// 6-month history + a claimable share for the caller, 2 = membership
/// closed (same history plus the 2,000+ ICP month that latched it).
#[ic_cdk::update]
fn dev_set_early_adopter_preset(preset: u8) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    if preset > 2 {
        return Err("UNKNOWN_PRESET".to_string());
    }
    let caller = get_caller();
    let now = current_time();
    let month_now = early_adopter_month(now);
    const ICP_E8S: u64 = 100_000_000;

    // Wipe model state.
    let members: Vec<Principal> = EARLY_ADOPTERS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
    EARLY_ADOPTERS.with(|m| { let mut m = m.borrow_mut(); for k in members { m.remove(&k); } });
    let months: Vec<u64> = EARLY_ADOPTER_ROUNDS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
    EARLY_ADOPTER_ROUNDS.with(|m| { let mut m = m.borrow_mut(); for k in months { m.remove(&k); } });
    let mut state = EarlyAdopterState {
        total_staked_e8s: 0,
        rollover_e8s: 0,
        last_processed_month: month_now,
        total_yield_e8s: 0,
        total_distributed_e8s: 0,
        total_expired_e8s: 0,
        membership_closed: false,
        nonce: 0,
        neuron_id: None,
        pending_refresh_e8s: 0,
        bootstrap: 0,
        total_restaked_e8s: 0,
        pending_job: None,
    };

    if preset >= 1 {
        // Members: the caller + three fixtures with varied stakes.
        let fixtures = [
            (caller, 500 * ICP_E8S, 0u64),
            (Principal::from_text("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe").unwrap(), 1200 * ICP_E8S, 1),
            (Principal::from_text("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae").unwrap(), 250 * ICP_E8S, 2),
            (Principal::from_text("i3ptn-w5i4d-zwvvn-kxgy4-zkx5d-ukatp-3jbje-vtb6d-y5zmj-kpj33-xae").unwrap(), 50 * ICP_E8S, 3),
        ];
        let total: u64 = fixtures.iter().map(|(_, s, _)| *s).sum();
        for (user, staked, months_ago) in fixtures {
            EARLY_ADOPTERS.with(|m| {
                m.borrow_mut().insert(user, EarlyAdopter {
                    user,
                    staked_e8s: staked,
                    joined_at: now.saturating_sub((months_ago + 2) * EARLY_ADOPTER_PERIOD_NANOS),
                    last_stake_at: now.saturating_sub(months_ago * EARLY_ADOPTER_PERIOD_NANOS),
                    // The caller gets a juicy unclaimed share to exercise Claim.
                    claimable_e8s: if user == caller { 75 * ICP_E8S } else { 0 },
                });
            });
        }
        state.total_staked_e8s = total;
        state.rollover_e8s = 42 * ICP_E8S;
        state.neuron_id = Some(990_001);
        state.bootstrap = 3; // Ready — following the primary neuron
        state.nonce = 7;

        // Six months of varied history: restake, treasury-only, payouts…
        let mk = |months_ago: u64, yield_icp: u64, treasury: u64, dist: u64, restake: u64, expired: u64, roll: u64| EarlyAdopterRound {
            month: month_now.saturating_sub(months_ago),
            settled_at: now.saturating_sub(months_ago * EARLY_ADOPTER_PERIOD_NANOS),
            yield_e8s: yield_icp * ICP_E8S,
            treasury_e8s: treasury * ICP_E8S,
            distributed_e8s: dist * ICP_E8S,
            restaked_e8s: restake * ICP_E8S,
            early_adopter_count: 4,
            expired_e8s: expired * ICP_E8S,
            rollover_after_e8s: roll * ICP_E8S,
            share_pool_after_e8s: (roll + dist / 2) * ICP_E8S,
        };
        let mut rounds = vec![
            mk(5, 320, 0, 0, 320, 0, 0),       // quiet month → fully restaked
            mk(4, 700, 700, 0, 0, 0, 0),       // mid band → all treasury
            mk(3, 1250, 1000, 250, 0, 0, 0),   // first payout month
            mk(2, 480, 0, 0, 480, 0, 0),       // restaked again
            mk(1, 1800, 1000, 758, 0, 120, 42),// big month + an expired share
        ];
        if preset == 2 {
            rounds.push(mk(0, 2400, 1000, 1358, 0, 0, 84)); // the month that closed the table
            state.membership_closed = true;
        }
        state.total_yield_e8s = rounds.iter().map(|r| r.yield_e8s).sum();
        state.total_distributed_e8s = rounds.iter().map(|r| r.distributed_e8s).sum();
        state.total_restaked_e8s = rounds.iter().map(|r| r.restaked_e8s).sum();
        state.total_expired_e8s = rounds.iter().map(|r| r.expired_e8s).sum();
        EARLY_ADOPTER_ROUNDS.with(|m| {
            let mut m = m.borrow_mut();
            for r in rounds {
                m.insert(r.month, r);
            }
        });
    }

    EARLY_ADOPTER_STATE.with(|c| { c.borrow_mut().set(state); });
    Ok(())
}

// ==========================================
// 19. Social profile (Twitter/X handle)
// ==========================================
//
// Users attach their X handle on the Profile page; the dapp uses it for
// social features around proposal sharing. Stored bare (no leading @).

thread_local! {
    static TWITTER_HANDLES: RefCell<StableBTreeMap<Principal, String, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(49))))
    });
}

fn valid_twitter_handle(h: &str) -> bool {
    (1..=15).contains(&h.len()) && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Set (or clear, with an empty string) the caller's X handle. A leading @
/// is stripped; X's own rules apply (1–15 chars, [A-Za-z0-9_]).
#[ic_cdk::update]
fn set_twitter_handle(handle: String) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let handle = handle.trim().trim_start_matches('@').to_string();
    if handle.is_empty() {
        TWITTER_HANDLES.with(|m| { m.borrow_mut().remove(&caller); });
        return Ok(());
    }
    if !valid_twitter_handle(&handle) {
        return Err("INVALID_HANDLE".to_string());
    }
    TWITTER_HANDLES.with(|m| { m.borrow_mut().insert(caller, handle); });
    Ok(())
}

#[ic_cdk::query]
fn get_my_twitter_handle() -> Option<String> {
    TWITTER_HANDLES.with(|m| m.borrow().get(&get_caller()))
}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests {
    use super::*;

    // ── Helpers ────────────────────────────────────────────────────────────────

    fn p(text: &str) -> Principal { Principal::from_text(text).unwrap() }
    fn anon() -> Principal { Principal::anonymous() }

    fn sample_commitment(proposal_id: u64, principal: Principal, amount: u64, status: CommitmentStatus) -> Commitment {
        Commitment {
            proposal_id,
            principal,
            amount_e8s: amount,
            status,
            created_at: 0,
            stance: Stance::Adopt,
            subaccount: derive_subaccount(&principal, proposal_id),
            settled_at: None,
            cmc_block_index: None,
            treasury_block: None,
            frontend_cmc_block: None,
        }
    }

    fn sample_proposal(id: u64, status: &str, threshold: u64, committed: u64) -> Proposal {
        Proposal {
            id,
            nns_proposal_id: Some(id),
            title: format!("Test proposal {}", id),
            summary: format!("Summary for proposal {}", id),
            category: "Governance".to_string(),
            status: status.to_string(),
            deadline: u64::MAX,
            threshold_e8s: threshold,
            total_committed_e8s: committed,
            adopt_pot_e8s: committed,
            reject_pot_e8s: 0,
            total_burned_e8s: None,
            vote_executed_at: None,
            first_stance: Some(Stance::Adopt),
            pool_distributed: false,
            lossless_adopt_e8s: 0,
            lossless_reject_e8s: 0,
        }
    }

    // ── PB-090: Access control & commit validation ─────────────────────────────

    #[test]
    fn test_derive_subaccount_deterministic() {
        let p1 = p("2vxsx-fae");
        let p2 = p("rrkah-fqaaa-aaaaa-aaaaq-cai");

        let s1a = derive_subaccount(&p1, 138402);
        let s1b = derive_subaccount(&p1, 138402);
        let s2  = derive_subaccount(&p2, 138402);
        let s1c = derive_subaccount(&p1, 138388);

        assert_eq!(s1a, s1b, "same inputs must be deterministic");
        assert_ne!(s1a, s2,  "different principals → different subaccounts");
        assert_ne!(s1a, s1c, "different proposal IDs → different subaccounts");
    }

    #[test]
    fn test_derive_subaccount_always_32_bytes() {
        let principal = p("2vxsx-fae");
        let sub = derive_subaccount(&principal, 0);
        assert_eq!(sub.len(), 32);
    }

    #[test]
    fn test_commit_validation_below_minimum() {
        // MIN_COMMIT_E8S is 100_000_000 (1 ICP)
        assert!(99_999_999 < MIN_COMMIT_E8S);
        assert!(100_000_000 >= MIN_COMMIT_E8S);
    }

    #[test]
    fn test_commit_validation_exceeds_global_cap() {
        assert!(MAX_COMMIT_E8S > 0);
        assert!(MAX_COMMIT_E8S < u64::MAX);
        // A commit at exactly the cap should be under u64::MAX (no overflow risk)
        let fee: u64 = 530_000;
        assert!(MAX_COMMIT_E8S.checked_add(fee).is_some());
    }

    #[test]
    fn test_mainnet_neuron_is_pinned() {
        // On mainnet (is_local = false) the configured neuron is forced to the
        // pinned production neuron, regardless of what init_args requested.
        assert_eq!(
            resolve_primary_neuron_id(false, 4821667),
            MAINNET_PRIMARY_NEURON_ID
        );
        assert_eq!(resolve_primary_neuron_id(false, 0), MAINNET_PRIMARY_NEURON_ID);
        // The pinned value is the agreed production leader neuron.
        assert_eq!(MAINNET_PRIMARY_NEURON_ID, 17_802_688_826_615_984_104);
    }

    #[test]
    fn test_local_neuron_honours_init_arg() {
        // Locally, the requested neuron id passes through unchanged.
        assert_eq!(resolve_primary_neuron_id(true, 4821667), 4821667);
        assert_eq!(resolve_primary_neuron_id(true, 999), 999);
    }

    #[test]
    fn test_quota_constants_reasonable() {
        assert!(MAX_COMMITMENTS_PER_USER >= 5,  "at least 5 commitment slots");
        assert!(MAX_COMMITMENTS_PER_USER <= 100, "not so many it fills storage");
        assert!(MAX_PROPOSALS >= 10,   "at least 10 proposals");
        assert!(MAX_PROPOSALS <= 10000, "sane upper bound");
    }

    #[test]
    fn test_commitment_status_pending_filter() {
        // Simulate the quota-check filter used in commit()
        let caller = p("2vxsx-fae");
        let commitments = vec![
            sample_commitment(1, caller, 100_000_000, CommitmentStatus::Pending),
            sample_commitment(2, caller, 100_000_000, CommitmentStatus::Burned),   // not counted
            sample_commitment(3, caller, 100_000_000, CommitmentStatus::Returned), // not counted
            sample_commitment(4, caller, 100_000_000, CommitmentStatus::Pending),
        ];
        let active_count = commitments.iter()
            .filter(|c| c.principal == caller && c.status == CommitmentStatus::Pending)
            .count();
        assert_eq!(active_count, 2);
    }

    #[test]
    fn test_threshold_met_logic() {
        let proposal = sample_proposal(1, "open", 500_000_000_000, 600_000_000_000);
        let met = proposal.total_committed_e8s >= proposal.threshold_e8s;
        assert!(met);
    }

    #[test]
    fn test_threshold_not_met_logic() {
        let proposal = sample_proposal(1, "open", 500_000_000_000, 100_000_000_000);
        let met = proposal.total_committed_e8s >= proposal.threshold_e8s;
        assert!(!met);
    }

    #[test]
    fn test_vote_direction_majority_adopt() {
        assert_eq!(decide_vote_choice(300, 100, Some(Stance::Reject)), 1, "adopt majority → Yes");
    }

    #[test]
    fn test_vote_direction_majority_reject() {
        assert_eq!(decide_vote_choice(100, 300, Some(Stance::Adopt)), 2, "reject majority → No");
    }

    #[test]
    fn test_settlement_split_math() {
        // PB-125: 50% treasury, 25% backend, 25% frontend; remainder to frontend.
        for amount in [100_000_000u64, 4_500_000_000, 7, 1_000_000_001] {
            let treasury = amount / 2;
            let backend = amount / 4;
            let frontend = amount - treasury - backend;
            assert_eq!(treasury + backend + frontend, amount, "split must sum to amount");
            assert_eq!(treasury, amount / 2);
            // frontend gets the rounding remainder, so it's >= backend.
            assert!(frontend >= backend);
        }
        // Exact case: 100 ICP → 50 / 25 / 25.
        let a = 10_000_000_000u64;
        assert_eq!(a / 2, 5_000_000_000);
        assert_eq!(a / 4, 2_500_000_000);
        assert_eq!(a - a / 2 - a / 4, 2_500_000_000);
    }

    #[test]
    fn test_vote_tie_break_uses_first_stance() {
        // Equal pots → the first stance committed wins.
        assert_eq!(decide_vote_choice(500, 500, Some(Stance::Adopt)), 1, "tie + first Adopt → Yes");
        assert_eq!(decide_vote_choice(500, 500, Some(Stance::Reject)), 2, "tie + first Reject → No");
        assert_eq!(decide_vote_choice(0, 0, None), 2, "no commits / unset → No");
    }

    #[test]
    fn test_fee_math_no_overflow() {
        // Deposit = target + 520_000; ensure no overflow at max commit
        let max = MAX_COMMIT_E8S;
        let fee: u64 = 520_000;
        let deposit = max.checked_add(fee);
        assert!(deposit.is_some(), "deposit must not overflow for max commit");
    }

    // ── PB-091: Upgrade persistence — Storable roundtrips ─────────────────────

    #[test]
    fn test_storable_config_roundtrip() {
        let config = Config {
            primary_neuron_id: 12345,
            admins: vec![anon(), p("2vxsx-fae")],
            default_threshold: 500_000_000_000,
            ai_price_e8s: 5_000_000,
            ledger_canister_id: p("ryjl3-tyaaa-aaaaa-aaaba-cai"),
            is_local: false,
            frontend_canister_id: None,
            pool_initiation_fee_e8s: 12_500_000_000,
            ckbtc_ledger_canister_id: None,
            cketh_ledger_canister_id: None,
            ckusdc_ledger_canister_id: None,
            ckusdt_ledger_canister_id: None,
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
            min_stake_e8s: default_min_stake_e8s(),
            min_unstake_e8s: default_min_unstake_e8s(),
            maturity_threshold_e8s: default_maturity_threshold_e8s(),
            lottery_tickets_per_day: default_lottery_tickets_per_day(),
        };
        let bytes = config.to_bytes();
        let decoded = Config::from_bytes(bytes);
        assert_eq!(decoded.primary_neuron_id, config.primary_neuron_id);
        assert_eq!(decoded.admins, config.admins);
        assert_eq!(decoded.default_threshold, config.default_threshold);
        assert_eq!(decoded.ai_price_e8s, config.ai_price_e8s);
        assert_eq!(decoded.ledger_canister_id, config.ledger_canister_id);
        assert_eq!(decoded.is_local, config.is_local);
    }

    #[test]
    fn test_storable_proposal_roundtrip() {
        let proposal = Proposal {
            id: 138402,
            nns_proposal_id: Some(138402),
            title: "Enable new subnet type".to_string(),
            summary: "Enable a new subnet type for testing".to_string(),
            category: "SubnetManagement".to_string(),
            status: "open".to_string(),
            deadline: 1_750_000_000_000_000_000,
            threshold_e8s: 500_000_000_000,
            total_committed_e8s: 200_000_000_000,
            adopt_pot_e8s: 150_000_000_000,
            reject_pot_e8s: 50_000_000_000,
            total_burned_e8s: None,
            vote_executed_at: Some(1_749_000_000_000_000_000),
            first_stance: Some(Stance::Adopt),
            pool_distributed: false,
            lossless_adopt_e8s: 0,
            lossless_reject_e8s: 0,
        };
        let bytes = proposal.to_bytes();
        let decoded = Proposal::from_bytes(bytes);
        assert_eq!(decoded.id, proposal.id);
        assert_eq!(decoded.title, proposal.title);
        assert_eq!(decoded.status, proposal.status);
        assert_eq!(decoded.threshold_e8s, proposal.threshold_e8s);
        assert_eq!(decoded.total_committed_e8s, proposal.total_committed_e8s);
        assert_eq!(decoded.vote_executed_at, proposal.vote_executed_at);
        assert_eq!(decoded.pool_distributed, proposal.pool_distributed);
    }

    #[test]
    fn test_storable_commitment_roundtrip() {
        let principal = p("2vxsx-fae");
        let commitment = Commitment {
            proposal_id: 9999,
            principal,
            amount_e8s: 5_000_000_000,
            status: CommitmentStatus::Burned,
            created_at: 1_700_000_000_000_000_000,
            stance: Stance::Reject,
            subaccount: derive_subaccount(&principal, 9999),
            settled_at: Some(1_700_001_000_000_000_000),
            cmc_block_index: Some(123_456),
            treasury_block: Some(123_455),
            frontend_cmc_block: Some(123_457),
        };
        let bytes = commitment.to_bytes();
        let decoded = Commitment::from_bytes(bytes);
        assert_eq!(decoded.proposal_id, commitment.proposal_id);
        assert_eq!(decoded.principal, commitment.principal);
        assert_eq!(decoded.amount_e8s, commitment.amount_e8s);
        assert_eq!(decoded.status, commitment.status);
        assert_eq!(decoded.stance, commitment.stance);
        assert_eq!(decoded.subaccount, commitment.subaccount);
        assert_eq!(decoded.settled_at, commitment.settled_at);
        assert_eq!(decoded.cmc_block_index, commitment.cmc_block_index);
    }

    #[test]
    fn test_storable_vote_record_roundtrip() {
        let vr = VoteRecord {
            proposal_id: 42,
            vote: Vote::No,
            icp_burned_e8s: 1_234_567_890,
            decided_at: 1_700_000_000_000_000_000,
            nns_outcome: Some("rejected".to_string()),
        };
        let bytes = vr.to_bytes();
        let decoded = VoteRecord::from_bytes(bytes);
        assert_eq!(decoded.proposal_id, vr.proposal_id);
        assert_eq!(decoded.icp_burned_e8s, vr.icp_burned_e8s);
        assert_eq!(decoded.nns_outcome, vr.nns_outcome);
    }

    #[test]
    fn test_storable_user_neuron_state_roundtrip() {
        let state = UserNeuronState {
            neuron_id: 4_821_667,
            is_following: true,
            verified_at: 1_700_000_000_000_000_000,
            cached_stake_e8s: 10_000_000_000,
        };
        let bytes = state.to_bytes();
        let decoded = UserNeuronState::from_bytes(bytes);
        assert_eq!(decoded.neuron_id, state.neuron_id);
        assert_eq!(decoded.is_following, state.is_following);
        assert_eq!(decoded.cached_stake_e8s, state.cached_stake_e8s);
    }

    #[test]
    fn test_storable_user_aggregates_roundtrip() {
        let agg = UserAggregates {
            total_committed_escrow: 5_000_000_000,
            total_burned: 3_000_000_000,
            proposals_joined: 7,
        };
        let bytes = agg.to_bytes();
        let decoded = UserAggregates::from_bytes(bytes);
        assert_eq!(decoded.total_committed_escrow, agg.total_committed_escrow);
        assert_eq!(decoded.total_burned, agg.total_burned);
        assert_eq!(decoded.proposals_joined, agg.proposals_joined);
    }

    #[test]
    fn test_storable_audit_log_entry_roundtrip() {
        let entry = AuditLogEntry {
            timestamp: 1_700_000_000_000_000_000,
            event_type: "burn".to_string(),
            proposal_id: 138402,
            user: p("2vxsx-fae"),
            amount_e8s: 1_000_000_000,
        };
        let bytes = entry.to_bytes();
        let decoded = AuditLogEntry::from_bytes(bytes);
        assert_eq!(decoded.timestamp, entry.timestamp);
        assert_eq!(decoded.event_type, entry.event_type);
        assert_eq!(decoded.proposal_id, entry.proposal_id);
        assert_eq!(decoded.user, entry.user);
        assert_eq!(decoded.amount_e8s, entry.amount_e8s);
    }

    #[test]
    fn test_commitment_key_storable_roundtrip() {
        let key = CommitmentKey {
            proposal_id: 77777,
            principal: p("2vxsx-fae"),
        };
        let bytes = key.to_bytes();
        let decoded = CommitmentKey::from_bytes(bytes);
        assert_eq!(decoded.proposal_id, key.proposal_id);
        assert_eq!(decoded.principal, key.principal);
    }

    // ── PB-113: Arithmetic & input hardening ───────────────────────────────────

    #[test]
    fn test_overflow_checks_pot_saturates() {
        // F-105: the commit() pot arithmetic must use checked_add — a wrap
        // would mis-attribute the user's commitment to the wrong pot. The
        // overflow path clamps to the original value (signaling overflow)
        // and the caller receives a `POT_OVERFLOW` error.
        let mut proposal = sample_proposal(1, "open", 500_000_000_000, 0);
        proposal.adopt_pot_e8s = u64::MAX;
        let res = proposal.adopt_pot_e8s.checked_add(1);
        assert!(res.is_none(), "u64::MAX + 1 must be detected as overflow");
    }

    #[test]
    fn test_overflow_checks_total_saturates() {
        // F-105: total_committed_e8s must be checked.
        let total = u64::MAX;
        let res = total.checked_add(1);
        assert!(res.is_none(), "u64::MAX + 1 must be detected as overflow");
    }

    #[test]
    fn test_deadline_must_be_above_cutoff() {
        // F-106: a deadline at-or-below `now + cutoff` is rejected.
        let now: u64 = 1_750_000_000_000_000_000;
        let cutoff = CUTOFF_NANOS;
        // exactly `now + cutoff` is rejected (<=)
        let exactly_at_cutoff = now.checked_add(cutoff).unwrap();
        assert!(exactly_at_cutoff <= now + cutoff, "boundary should be rejected");
        // one nanosecond past the cutoff is accepted
        let just_past = now.checked_add(cutoff).and_then(|v| v.checked_add(1)).unwrap();
        assert!(just_past > now + cutoff, "past-cutoff should be accepted");
    }

    #[test]
    fn test_cmc_block_index_defaults_to_none() {
        // PB-111: a fresh commitment has no CMC block index — Phase A
        // performs the transfer and persists the index.
        let c = sample_commitment(1, p("2vxsx-fae"), 100_000_000, CommitmentStatus::Pending);
        assert!(c.cmc_block_index.is_none(), "new commitment must have no block index");
    }

    #[test]
    fn test_cmc_block_index_persists_on_retry() {
        // PB-111: after Phase A succeeds, the block index is stored so a
        // retry that only needs Phase B can skip the transfer.
        let mut c = sample_commitment(1, p("2vxsx-fae"), 100_000_000, CommitmentStatus::FailedBurn);
        c.cmc_block_index = Some(987_654_321);
        assert_eq!(c.cmc_block_index, Some(987_654_321));

        // A second transfer must NOT happen: the retry function checks for
        // Some(_) and skips Phase A. We assert the decision logic here.
        let skip_phase_a = c.cmc_block_index.is_some();
        assert!(skip_phase_a, "retry must skip Phase A when block index is Some");
    }

    #[test]
    fn test_cutoff_constant_matches_commit_check() {
        // The CUTOFF_NANOS in admin_set_proposal_deadline must match the
        // literal used in commit()/proposal_sync_sweep. Drift would let an
        // admin-set deadline pass the validation but trip the commit cutoff.
        assert_eq!(CUTOFF_NANOS, 3_600_000_000_000);
    }

    #[test]
    fn test_is_local_field_serialised() {
        // PB-110: Config.is_local must roundtrip through Storable so the
        // F-101/F-102 mainnet gate survives a canister upgrade.
        let local = Config {
            is_local: true,
            ..Config {
                primary_neuron_id: 1,
                admins: vec![],
                default_threshold: 0,
                ai_price_e8s: 0,
                ledger_canister_id: Principal::anonymous(),
                is_local: false,
                frontend_canister_id: None,
                pool_initiation_fee_e8s: 0,
                ckbtc_ledger_canister_id: None,
                cketh_ledger_canister_id: None,
                ckusdc_ledger_canister_id: None,
            ckusdt_ledger_canister_id: None,
                min_upvote_icp_e8s: None,
                min_upvote_ckbtc_e8s: None,
                min_upvote_cketh_wei: None,
                min_stake_e8s: default_min_stake_e8s(),
                min_unstake_e8s: default_min_unstake_e8s(),
                maturity_threshold_e8s: default_maturity_threshold_e8s(),
                lottery_tickets_per_day: default_lottery_tickets_per_day(),
            }
        };
        let mainnet = Config {
            is_local: false,
            ..local.clone()
        };
        assert_eq!(Config::from_bytes(local.to_bytes()).is_local, true);
        assert_eq!(Config::from_bytes(mainnet.to_bytes()).is_local, false);
    }

    #[test]
    fn test_pool_initiation_fee_config() {
        // Assert default initiation fee (125 ICP = 12_500_000_000 e8s)
        assert_eq!(default_pool_initiation_fee_e8s(), 12_500_000_000);

        // Simulate an old Config structure by serializing a struct
        // without the new field.
        #[derive(serde::Serialize)]
        struct OldConfig {
            primary_neuron_id: u64,
            admins: Vec<Principal>,
            default_threshold: u64,
            ai_price_e8s: u64,
            ledger_canister_id: Principal,
            is_local: bool,
            frontend_canister_id: Option<Principal>,
        }

        let old = OldConfig {
            primary_neuron_id: 12345,
            admins: vec![Principal::anonymous()],
            default_threshold: 500_000_000_000,
            ai_price_e8s: 5_000_000,
            ledger_canister_id: Principal::anonymous(),
            is_local: false,
            frontend_canister_id: None,
        };

        let mut buf = Vec::new();
        ciborium::into_writer(&old, &mut buf).unwrap();
        let decoded: Config = ciborium::from_reader(buf.as_slice()).unwrap();

        // Assert that the decoded Config gets the default initiation fee
        assert_eq!(decoded.pool_initiation_fee_e8s, 12_500_000_000);
    }

    #[test]
    fn test_neuron_helpers() {
        let n = Neuron {
            id: Some(NeuronId { id: 12345 }),
            controller: Some(Principal::anonymous()),
            hot_keys: vec![Principal::management_canister()],
            cached_neuron_stake_e8s: 100_000_000,
            maturity_e8s_equivalent: 0,
            voting_power: Some(100_000_000),
            deciding_voting_power: None,
            followees: vec![(
                TOPIC_GOVERNANCE,
                Followees {
                    followees: vec![NeuronId { id: 4821667 }],
                },
            )],
        };

        // Test hotkey checks
        assert!(neuron_has_hotkey(&n, Principal::management_canister()));
        assert!(!neuron_has_hotkey(&n, Principal::anonymous()));

        // Test follow checks
        assert!(neuron_follows(&n, 4821667, TOPIC_GOVERNANCE));
        assert!(!neuron_follows(&n, 99999, TOPIC_GOVERNANCE));
        assert!(!neuron_follows(&n, 4821667, 3)); // different topic
    }

    #[test]
    fn test_neuron_candid_compatibility() {
        let n = Neuron {
            id: Some(NeuronId { id: 12345 }),
            controller: Some(Principal::anonymous()),
            hot_keys: vec![Principal::anonymous()],
            cached_neuron_stake_e8s: 100_000_000,
            maturity_e8s_equivalent: 0,
            voting_power: Some(100_000_000),
            deciding_voting_power: None,
            followees: vec![(
                TOPIC_GOVERNANCE,
                Followees {
                    followees: vec![NeuronId { id: 4821667 }],
                },
            )],
        };
        let bytes = candid::encode_one(&n).unwrap();
        let decoded: Neuron = candid::decode_one(&bytes).unwrap();
        assert_eq!(decoded.cached_neuron_stake_e8s, 100_000_000);
        assert!(neuron_has_hotkey(&decoded, Principal::anonymous()));
        assert!(neuron_follows(&decoded, 4821667, TOPIC_GOVERNANCE));
    }

    #[test]
    fn test_registration_address_distinction() {
        let caller = Principal::anonymous();
        let proposal_id = 12345u64;

        let commit_sub = derive_subaccount(&caller, proposal_id);
        let reg_sub = derive_subaccount(&caller, REGISTRATION_SEED);

        assert_ne!(commit_sub, reg_sub, "Registration subaccount must differ");
    }

    #[test]
    fn test_pool_neuron_storable_roundtrip() {
        let neuron = PoolNeuron {
            neuron_id: 12345,
            registered_by: Principal::anonymous(),
            voting_power: 500_000_000,
            status: PoolStatus::Active,
            created_at: 1000,
            activated_at: Some(1010),
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        let bytes = neuron.to_bytes();
        let decoded = PoolNeuron::from_bytes(bytes);
        assert_eq!(decoded.neuron_id, neuron.neuron_id);
        assert_eq!(decoded.voting_power, neuron.voting_power);
        assert_eq!(decoded.status, neuron.status);
    }

    #[test]
    fn test_recompute_pool_info() {
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map.borrow().iter().map(|e| *e.key()).collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // Insert a mix of Active, Draft, and Inactive neurons
        POOL_NEURONS.with(|map| {
            let mut m = map.borrow_mut();
            m.insert(1, PoolNeuron {
                neuron_id: 1,
                registered_by: Principal::anonymous(),
                voting_power: 1000,
                status: PoolStatus::Active,
                created_at: 0,
                activated_at: None,
                treasury_block: None,
                backend_cmc_block: None,
                frontend_cmc_block: None,
            });
            m.insert(2, PoolNeuron {
                neuron_id: 2,
                registered_by: Principal::anonymous(),
                voting_power: 5000,
                status: PoolStatus::Draft,
                created_at: 0,
                activated_at: None,
                treasury_block: None,
                backend_cmc_block: None,
                frontend_cmc_block: None,
            });
            m.insert(3, PoolNeuron {
                neuron_id: 3,
                registered_by: Principal::anonymous(),
                voting_power: 2000,
                status: PoolStatus::Active,
                created_at: 0,
                activated_at: None,
                treasury_block: None,
                backend_cmc_block: None,
                frontend_cmc_block: None,
            });
            m.insert(4, PoolNeuron {
                neuron_id: 4,
                registered_by: Principal::anonymous(),
                voting_power: 10000,
                status: PoolStatus::Inactive,
                created_at: 0,
                activated_at: None,
                treasury_block: None,
                backend_cmc_block: None,
                frontend_cmc_block: None,
            });
        });

        // Run recompute
        recompute_pool_info();

        // Check values in CACHED_POOL_INFO
        CACHED_POOL_INFO.with(|cell| {
            let info = cell.borrow();
            assert_eq!(info.active_count, 2, "Only Active count");
            assert_eq!(info.total_pool_voting_power, 3000, "Only Active VP");
            assert!(info.updated_at > 0);
        });
    }

    // ── PB-115: Global stats type & overflow posture ─────────────────────────

    #[test]
    fn test_global_stats_overflow_clamps() {
        // F-105: sums across the entire PROPOSALS / VOTES maps must clamp
        // to u64::MAX on overflow rather than wrapping (release build traps
        // under overflow-checks = true, so this is a defensive fallback).
        let mut tvl: u64 = 0;
        let proposals = [
            sample_proposal(1, "open",  500_000_000_000, 400_000_000_000),
            sample_proposal(2, "met",   500_000_000_000, 600_000_000_000),
            sample_proposal(3, "voted", 500_000_000_000, 100_000_000_000), // not counted
        ];
        for p in &proposals {
            if p.status == "open" || p.status == "met" {
                tvl = tvl.checked_add(p.total_committed_e8s).unwrap_or(u64::MAX);
            }
        }
        assert_eq!(tvl, 1_000_000_000_000, "open+met total only");

        // Saturate
        let big: u64 = u64::MAX;
        assert_eq!(big.checked_add(1).unwrap_or(u64::MAX), u64::MAX);
    }

    #[test]
    fn test_global_stats_excludes_settled_proposals_from_tvl() {
        // TVL = escrow *currently locked*. Once a proposal is settled /
        // voted / failed / abstained, the funds have been burned or
        // refunded and must not be counted toward TVL.
        let statuses = ["open", "met", "voted", "failed", "abstained", "settled"];
        for s in statuses {
            let p = sample_proposal(1, s, 500_000_000_000, 100_000_000_000);
            let counts = p.status == "open" || p.status == "met";
            if s == "open" || s == "met" {
                assert!(counts, "status {} should count toward TVL", s);
            } else {
                assert!(!counts, "status {} must not count toward TVL", s);
            }
        }
    }

    #[test]
    fn test_global_stats_default_is_zero() {
        // An empty canister returns zeroes — there's no PROPOSALS / VOTES
        // data in the test environment (those maps are seeded via init
        // and we don't call seed_mock_proposals here).
        let stats = GlobalStats {
            tvl_e8s: 0,
            total_burned_e8s: 0,
            pending_burn_e8s: 0,
            votes_cast: 0,
            followers_count: 0,
        };
        assert_eq!(stats.tvl_e8s, 0);
        assert_eq!(stats.total_burned_e8s, 0);
        assert_eq!(stats.votes_cast, 0);
        assert_eq!(stats.followers_count, 0);
    }

    #[test]
    fn test_nns_topic_label_mapping() {
        assert_eq!(nns_topic_label(1), "Neuron Management");
        assert_eq!(nns_topic_label(2), "Exchange Rate");
        assert_eq!(nns_topic_label(3), "Network Economics");
        assert_eq!(nns_topic_label(4), "Governance");
        assert_eq!(nns_topic_label(5), "Node Admin");
        assert_eq!(nns_topic_label(6), "Participant Management");
        assert_eq!(nns_topic_label(7), "Subnet Management");
        assert_eq!(nns_topic_label(8), "Network Canister Management");
        assert_eq!(nns_topic_label(9), "KYC");
        assert_eq!(nns_topic_label(10), "Node Provider Rewards");
        assert_eq!(nns_topic_label(12), "IC OS Version Deployment");
        assert_eq!(nns_topic_label(13), "IC OS Version Election");
        assert_eq!(nns_topic_label(14), "SNS & Neurons' Fund");
        assert_eq!(nns_topic_label(15), "API Boundary Node Management");
        assert_eq!(nns_topic_label(99), "Governance");
    }

    #[test]
    fn test_crc32_expected_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
        assert_eq!(crc32(b""), 0x00000000);
        assert_eq!(crc32(b"a"), 0xE8B7BE43);
    }

    #[test]
    fn test_to_hex_formatting() {
        assert_eq!(to_hex(&[]), "");
        assert_eq!(to_hex(&[0x00]), "00");
        assert_eq!(to_hex(&[0x01, 0x02, 0x0a, 0xff]), "01020aff");
    }

    #[test]
    fn test_account_id_hex_formatting() {
        let owner = Principal::anonymous();
        let subaccount = [0u8; 32];
        let addr = account_id_hex(owner, &subaccount);
        assert_eq!(
            addr.len(),
            64,
            "address must be exactly 64 hex characters"
        );
        assert!(
            addr.chars().all(|c| c.is_ascii_hexdigit()),
            "address must contain only hex characters"
        );
        let addr2 = account_id_hex(owner, &subaccount);
        assert_eq!(addr, addr2, "account_id_hex must be deterministic");
    }

    #[test]
    fn test_frontend_canister_id_resolution() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());

        CONFIG.with(|c| {
            let mut cell = c.borrow_mut();
            let mut cfg = cell.get().clone();
            cfg.is_local = true;
            cfg.frontend_canister_id = None;
            let _ = cell.set(cfg);
        });
        assert_eq!(
            frontend_canister_id(),
            Principal::from_text("a2cb4-hh777-77775-aaaba-cai").unwrap()
        );

        CONFIG.with(|c| {
            let mut cell = c.borrow_mut();
            let mut cfg = cell.get().clone();
            cfg.is_local = false;
            cfg.frontend_canister_id = None;
            let _ = cell.set(cfg);
        });
        assert_eq!(
            frontend_canister_id(),
            Principal::from_text("kyclk-5qaaa-aaaap-quthq-cai").unwrap()
        );

        let override_principal = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        CONFIG.with(|c| {
            let mut cell = c.borrow_mut();
            let mut cfg = cell.get().clone();
            cfg.frontend_canister_id = Some(override_principal);
            let _ = cell.set(cfg);
        });
        assert_eq!(frontend_canister_id(), override_principal);

        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_create_pool_draft_flow() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());
        let caller = Principal::from_slice(&[1; 29]);
        set_mock_caller(caller);

        // 1. is_local = true path
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.is_local = true;
            cfg.primary_neuron_id = 123;
            let _ = c.borrow_mut().set(cfg);
        });

        // Clear existing map
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map
                .borrow()
                .iter()
                .map(|e| *e.key())
                .collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        let res = create_pool_draft(12345).await;
        assert!(res.is_ok());

        // Verify draft created
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&12345).unwrap());
        assert_eq!(pn.neuron_id, 12345);
        assert_eq!(pn.status, PoolStatus::Draft);
        assert_eq!(pn.voting_power, 10_000_000_000);

        // 2. is_local = false path
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.is_local = false;
            let _ = c.borrow_mut().set(cfg);
        });

        // Set mock neuron: fails
        set_mock_neuron(Err("Some NNS error".to_string()));
        let res = create_pool_draft(54321).await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Some NNS error"));

        // Set mock neuron: succeeds but missing hotkey
        let mut mock_n = Neuron {
            id: None,
            controller: None,
            hot_keys: vec![],
            cached_neuron_stake_e8s: 0,
            maturity_e8s_equivalent: 0,
            voting_power: Some(50_000_000_000),
            deciding_voting_power: None,
            followees: vec![],
        };
        set_mock_neuron(Ok(mock_n.clone()));
        let res = create_pool_draft(54321).await;
        assert_eq!(res.unwrap_err(), "HOTKEY_MISSING");

        // Set mock neuron: has hotkey but not following leader
        mock_n.hot_keys.push(get_canister_id());
        set_mock_neuron(Ok(mock_n.clone()));
        let res = create_pool_draft(54321).await;
        assert_eq!(res.unwrap_err(), "NOT_FOLLOWING");

        // Set mock neuron: has hotkey and follows leader
        let leader_id = CONFIG.with(|c| c.borrow().get().primary_neuron_id);
        mock_n.followees.push((
            TOPIC_GOVERNANCE,
            Followees {
                followees: vec![NeuronId {
                    id: leader_id,
                }],
            },
        ));
        set_mock_neuron(Ok(mock_n.clone()));
        let res = create_pool_draft(54321).await;
        assert!(res.is_ok());

        // Verify draft created with live voting power
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&54321).unwrap());
        assert_eq!(pn.neuron_id, 54321);
        assert_eq!(pn.status, PoolStatus::Draft);
        assert_eq!(pn.voting_power, 50_000_000_000);

        // Re-call overwrite
        mock_n.voting_power = Some(60_000_000_000);
        set_mock_neuron(Ok(mock_n.clone()));
        let res = create_pool_draft(54321).await;
        assert!(res.is_ok());
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&54321).unwrap());
        assert_eq!(pn.voting_power, 60_000_000_000);

        // Test ALREADY_REGISTERED
        // Try to register under a different caller principal
        // Wait, since caller principal is anonymous by default in native tests,
        // it registers 54321 as registered_by = Principal::anonymous().
        // To test ALREADY_REGISTERED, we can mock it directly in the map or
        // we can just check if registering works when same caller, and doesn't when different.
        // Let's manually insert a draft with a different principal to simulate it:
        POOL_NEURONS.with(|map| {
            let mut m = map.borrow_mut();
            if let Some(mut pn) = m.get(&54321) {
                pn.registered_by = Principal::management_canister();
                m.insert(54321, pn);
            }
        });
        let res = create_pool_draft(54321).await;
        assert_eq!(res.unwrap_err(), "ALREADY_REGISTERED");

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_finalize_pool_registration_flow() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());
        let caller = Principal::from_slice(&[1; 29]);
        set_mock_caller(caller);

        // Clear existing map
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map
                .borrow()
                .iter()
                .map(|e| *e.key())
                .collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // 1. Err NO_DRAFT when no draft exists
        let res = finalize_pool_registration(9999).await;
        assert_eq!(res.unwrap_err(), "NO_DRAFT");

        // Create a draft first
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.is_local = true;
            cfg.pool_initiation_fee_e8s = 10_000_000_000; // 100 ICP
            let _ = c.borrow_mut().set(cfg);
        });

        let res = create_pool_draft(9999).await;
        assert!(res.is_ok());

        // 2. Err INSUFFICIENT_DEPOSIT when balance is low
        set_mock_ledger_balance(10_000_000_000);
        let res = finalize_pool_registration(9999).await;
        assert_eq!(res.unwrap_err(), "INSUFFICIENT_DEPOSIT");

        // 3. Success when balance is sufficient (on local)
        set_mock_ledger_balance(10_000_030_000);
        let res = finalize_pool_registration(9999).await;
        assert!(res.is_ok());

        // Verify neuron status is Active
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&9999).unwrap());
        assert_eq!(pn.status, PoolStatus::Active);
        assert_eq!(pn.activated_at.is_some(), true);
        // All three split transfers recorded their block indices.
        assert!(pn.treasury_block.is_some());
        assert!(pn.backend_cmc_block.is_some());
        assert!(pn.frontend_cmc_block.is_some());

        // 4. Saga idempotency: simulate a trap after the transfers completed but
        // before the status flip (reset to Draft, keep the block indices). A retry
        // must SKIP every transfer — prove it by making any transfer attempt error.
        POOL_NEURONS.with(|map| {
            let mut p = map.borrow().get(&9999).unwrap();
            p.status = PoolStatus::Draft;
            map.borrow_mut().insert(9999, p);
        });
        set_mock_ledger_transfer(Err("transfer must not be called on retry".to_string()));
        let res = finalize_pool_registration(9999).await;
        assert!(res.is_ok(), "retry should skip completed transfers, not double-spend");
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&9999).unwrap());
        assert_eq!(pn.status, PoolStatus::Active);
        set_mock_ledger_transfer(Ok(1)); // restore default

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_cancel_and_unregister_flow() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());
        let caller = Principal::from_slice(&[1; 29]);
        let other_caller = Principal::from_slice(&[2; 29]);
        set_mock_caller(caller);

        // Clear existing map
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map
                .borrow()
                .iter()
                .map(|e| *e.key())
                .collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // 1. Setup local config & draft
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.is_local = true;
            cfg.pool_initiation_fee_e8s = 10_000_000_000;
            let _ = c.borrow_mut().set(cfg);
        });

        let res = create_pool_draft(9999).await;
        assert!(res.is_ok());

        // 2. Reject cancel by unauthorized caller
        set_mock_caller(other_caller);
        let res = cancel_pool_draft(9999);
        assert_eq!(res.unwrap_err(), "UNAUTHORIZED");

        // Restore owner caller
        set_mock_caller(caller);

        // 3. Successfully cancel draft
        let res = cancel_pool_draft(9999);
        assert!(res.is_ok());
        // Verify it was removed
        assert!(POOL_NEURONS.with(|map| map.borrow().get(&9999)).is_none());

        // 4. Create again and finalize to active
        let res = create_pool_draft(9999).await;
        assert!(res.is_ok());

        set_mock_ledger_balance(10_000_030_000);
        let res = finalize_pool_registration(9999).await;
        assert!(res.is_ok());

        // Status should be Active
        let pn = POOL_NEURONS.with(|map| map.borrow().get(&9999).unwrap());
        assert_eq!(pn.status, PoolStatus::Active);

        // Try to cancel active draft -> invalid state
        let res = cancel_pool_draft(9999);
        assert_eq!(res.unwrap_err(), "INVALID_STATE");

        // 5. Reject unregister by unauthorized caller
        set_mock_caller(other_caller);
        let res = unregister_leader_neuron(9999);
        assert_eq!(res.unwrap_err(), "UNAUTHORIZED");

        // Restore owner caller
        set_mock_caller(caller);

        // 6. Successfully unregister Active neuron -> Inactive
        let res = unregister_leader_neuron(9999);
        assert!(res.is_ok());

        let pn = POOL_NEURONS.with(|map| map.borrow().get(&9999).unwrap());
        assert_eq!(pn.status, PoolStatus::Inactive);

        // Try to unregister again -> invalid state
        let res = unregister_leader_neuron(9999);
        assert_eq!(res.unwrap_err(), "INVALID_STATE");

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_pool_queries() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());
        let caller = Principal::from_slice(&[1; 29]);
        let other_caller = Principal::from_slice(&[2; 29]);
        set_mock_caller(caller);

        // Clear existing map
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map
                .borrow()
                .iter()
                .map(|e| *e.key())
                .collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // 1. get_my_pool_neuron on empty -> None
        assert!(get_my_pool_neuron().is_none());

        // 2. get_my_pool_neuron for anonymous -> None
        set_mock_caller(Principal::anonymous());
        assert!(get_my_pool_neuron().is_none());
        set_mock_caller(caller);

        // 3. Create draft
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.is_local = true;
            cfg.pool_initiation_fee_e8s = 10_000_000_000;
            let _ = c.borrow_mut().set(cfg);
        });

        let res = create_pool_draft(9999).await;
        assert!(res.is_ok());

        // get_my_pool_neuron -> Draft
        let my_n = get_my_pool_neuron().unwrap();
        assert_eq!(my_n.neuron_id, 9999);
        assert_eq!(my_n.status, PoolStatus::Draft);

        // 4. get_pool_info -> totals should be 0 because Draft is not Active
        let info = get_pool_info();
        assert_eq!(info.total_pool_voting_power, 0);
        assert_eq!(info.active_count, 0);
        assert_eq!(info.active_neurons.len(), 0);

        // 5. Finalize registration -> Active
        set_mock_ledger_balance(10_000_030_000);
        let res = finalize_pool_registration(9999).await;
        assert!(res.is_ok());

        // get_my_pool_neuron -> Active
        let my_n = get_my_pool_neuron().unwrap();
        assert_eq!(my_n.status, PoolStatus::Active);

        // 6. get_pool_info -> total VP and active count should be updated
        let info = get_pool_info();
        assert_eq!(info.total_pool_voting_power, 10_000_000_000);
        assert_eq!(info.active_count, 1);
        assert_eq!(info.active_neurons.len(), 1);
        assert_eq!(info.active_neurons[0].neuron_id, 9999);
        assert_eq!(info.active_neurons[0].rank, 1);

        // 7. Add another active neuron with more VP to test sorting & ranking
        // Create draft as other caller
        set_mock_caller(other_caller);
        let res = create_pool_draft(8888).await;
        assert!(res.is_ok());

        // Update its VP to be higher (200 ICP)
        POOL_NEURONS.with(|map| {
            let mut pn = map.borrow().get(&8888).unwrap();
            pn.voting_power = 20_000_000_000;
            map.borrow_mut().insert(8888, pn);
        });

        // Finalize other caller's neuron
        set_mock_ledger_balance(10_000_030_000);
        let res = finalize_pool_registration(8888).await;
        assert!(res.is_ok());

        // get_pool_info -> total VP: 300 ICP, active count: 2, sorted by VP desc
        let info = get_pool_info();
        assert_eq!(info.total_pool_voting_power, 30_000_000_000);
        assert_eq!(info.active_count, 2);
        assert_eq!(info.active_neurons.len(), 2);

        // First should be 8888 (higher VP) with rank 1
        assert_eq!(info.active_neurons[0].neuron_id, 8888);
        assert_eq!(info.active_neurons[0].voting_power, 20_000_000_000);
        assert_eq!(info.active_neurons[0].rank, 1);

        // Second should be 9999 (lower VP) with rank 2
        assert_eq!(info.active_neurons[1].neuron_id, 9999);
        assert_eq!(info.active_neurons[1].voting_power, 10_000_000_000);
        assert_eq!(info.active_neurons[1].rank, 2);

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_pool_rewards_distribution() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());
        let caller = Principal::from_slice(&[1; 29]);
        set_mock_caller(caller);

        // Clear proposals
        PROPOSALS.with(|map| {
            let keys: Vec<u64> = map.borrow().iter().map(|e| *e.key()).collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // Clear pool neurons
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map.borrow().iter().map(|e| *e.key()).collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // 1. Seed a proposal that is settled
        let p = Proposal {
            id: 12345,
            title: "Test Proposal".to_string(),
            summary: "Summary".to_string(),
            category: "governance".to_string(),
            deadline: 0,
            nns_proposal_id: Some(12345),
            status: "settled".to_string(),
            threshold_e8s: 10_000_000_000,
            total_committed_e8s: 100_000_000_000,
            adopt_pot_e8s: 100_000_000_000,
            reject_pot_e8s: 0,
            vote_executed_at: Some(0),
            total_burned_e8s: Some(100_000_000_000),
            first_stance: Some(Stance::Adopt),
            pool_distributed: false,
            lossless_adopt_e8s: 0,
            lossless_reject_e8s: 0,
        };
        PROPOSALS.with(|map| map.borrow_mut().insert(12345, p));

        // 2. Empty pool -> no distribution
        let res = distribute_pool_rewards(12345).await;
        assert!(res.is_ok());
        let p_after = PROPOSALS.with(|map| map.borrow().get(&12345).unwrap());
        assert!(p_after.pool_distributed);

        // Reset distributed
        PROPOSALS.with(|map| {
            let mut p = map.borrow().get(&12345).unwrap();
            p.pool_distributed = false;
            map.borrow_mut().insert(12345, p);
        });

        // 3. Setup active pool neurons (say 2 active neurons)
        let n1 = PoolNeuron {
            neuron_id: 1111,
            registered_by: Principal::from_slice(&[11; 29]),
            voting_power: 10_000_000_000,
            status: PoolStatus::Active,
            created_at: 0,
            activated_at: Some(0),
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        let n2 = PoolNeuron {
            neuron_id: 2222,
            registered_by: Principal::from_slice(&[22; 29]),
            voting_power: 20_000_000_000,
            status: PoolStatus::Active,
            created_at: 0,
            activated_at: Some(0),
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        POOL_NEURONS.with(|map| {
            map.borrow_mut().insert(1111, n1);
            map.borrow_mut().insert(2222, n2);
        });

        set_mock_ledger_transfer(Ok(123));

        let res = distribute_pool_rewards(12345).await;
        assert!(res.is_ok());

        let p_after = PROPOSALS.with(|map| map.borrow().get(&12345).unwrap());
        assert!(p_after.pool_distributed);

        // 4. Test Idempotency: second call does nothing (returns Ok immediately)
        set_mock_ledger_transfer(Err("should not be called again".to_string()));
        let res = distribute_pool_rewards(12345).await;
        assert!(res.is_ok());

        // Restore mock ledger transfer
        set_mock_ledger_transfer(Ok(1));

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    #[tokio::test]
    async fn test_pool_refresh_and_inactivation() {
        let original_cfg = CONFIG.with(|c| c.borrow().get().clone());

        // Clear pool neurons
        POOL_NEURONS.with(|map| {
            let keys: Vec<u64> = map.borrow().iter().map(|e| *e.key()).collect();
            let mut m = map.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });

        // 1. Seed draft and active neurons
        let draft = PoolNeuron {
            neuron_id: 1111,
            registered_by: Principal::from_slice(&[11; 29]),
            voting_power: 10_000_000_000,
            status: PoolStatus::Draft,
            created_at: 0,
            activated_at: None,
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        let active1 = PoolNeuron {
            neuron_id: 2222,
            registered_by: Principal::from_slice(&[22; 29]),
            voting_power: 20_000_000_000,
            status: PoolStatus::Active,
            created_at: 0,
            activated_at: Some(0),
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        let active2 = PoolNeuron {
            neuron_id: 3333,
            registered_by: Principal::from_slice(&[33; 29]),
            voting_power: 30_000_000_000,
            status: PoolStatus::Active,
            created_at: 0,
            activated_at: Some(0),
            treasury_block: None,
            backend_cmc_block: None,
            frontend_cmc_block: None,
        };
        POOL_NEURONS.with(|map| {
            map.borrow_mut().insert(1111, draft);
            map.borrow_mut().insert(2222, active1);
            map.borrow_mut().insert(3333, active2);
        });

        recompute_pool_info();

        // Check starting state
        let info = get_pool_info();
        assert_eq!(info.active_count, 2);
        assert_eq!(info.total_pool_voting_power, 50_000_000_000);

        // 2. Setup mock neuron responses
        // 2222: active, updated voting power
        let n2222 = Neuron {
            id: Some(NeuronId { id: 2222 }),
            controller: Some(Principal::from_slice(&[22; 29])),
            cached_neuron_stake_e8s: 25_000_000_000,
            maturity_e8s_equivalent: 0,
            voting_power: Some(25_000_000_000),
            deciding_voting_power: None,
            hot_keys: vec![get_canister_id()],
            followees: vec![(
                TOPIC_GOVERNANCE,
                Followees {
                    followees: vec![NeuronId {
                        id: original_cfg.primary_neuron_id,
                    }],
                },
            )],
        };
        set_mock_neuron_for_id(2222, Ok(n2222));

        // 3333: active, but follow broken
        let n3333 = Neuron {
            id: Some(NeuronId { id: 3333 }),
            controller: Some(Principal::from_slice(&[33; 29])),
            cached_neuron_stake_e8s: 30_000_000_000,
            maturity_e8s_equivalent: 0,
            voting_power: Some(30_000_000_000),
            deciding_voting_power: None,
            hot_keys: vec![get_canister_id()],
            followees: vec![], // no follow
        };
        set_mock_neuron_for_id(3333, Ok(n3333));

        // Run refresh
        refresh_pool_neurons().await;

        // Verify updates
        let info = get_pool_info();
        assert_eq!(info.active_count, 1);
        assert_eq!(info.total_pool_voting_power, 25_000_000_000);

        // Verify draft was untouched
        let d = POOL_NEURONS.with(|map| map.borrow().get(&1111).unwrap());
        assert_eq!(d.status, PoolStatus::Draft);

        // Verify 3333 is Inactive
        let a2 = POOL_NEURONS.with(|map| map.borrow().get(&3333).unwrap());
        assert_eq!(a2.status, PoolStatus::Inactive);

        // 3. Test resilience to single get_full_neuron failure
        // 2222: NNS failure
        set_mock_neuron_for_id(2222, Err("NNS offline".to_string()));

        // Reactivate 3333
        let mut a2_act = a2.clone();
        a2_act.status = PoolStatus::Active;
        POOL_NEURONS.with(|map| map.borrow_mut().insert(3333, a2_act));

        // Mock 3333 to be active and valid
        let n3333_valid = Neuron {
            id: Some(NeuronId { id: 3333 }),
            controller: Some(Principal::from_slice(&[33; 29])),
            cached_neuron_stake_e8s: 30_000_000_000,
            maturity_e8s_equivalent: 0,
            voting_power: Some(30_000_000_000),
            deciding_voting_power: None,
            hot_keys: vec![get_canister_id()],
            followees: vec![(
                TOPIC_GOVERNANCE,
                Followees {
                    followees: vec![NeuronId {
                        id: original_cfg.primary_neuron_id,
                    }],
                },
            )],
        };
        set_mock_neuron_for_id(3333, Ok(n3333_valid));

        // Run refresh
        refresh_pool_neurons().await;

        // 2222 failed to refresh but should stay Active
        // 3333 successfully refreshed and stays Active
        let info = get_pool_info();
        assert_eq!(info.active_count, 2);

        // Restore config
        CONFIG.with(|c| {
            let _ = c.borrow_mut().set(original_cfg);
        });
    }

    // ── Idea Board & feature flags ─────────────────────────────────────────────

    #[test]
    fn test_split_upvote_75_25() {
        for amount in [1_000_000u64, 4_000_000, 7, 1_000_000_001, MAX_UPVOTE_UNITS] {
            let (treasury, poster) = split_upvote(amount);
            assert_eq!(treasury + poster, amount, "split must sum to amount");
            // Treasury never exceeds 75%; poster takes the rounding remainder.
            assert!(treasury <= amount / 4 * 3 + 3);
            assert!(poster >= amount - treasury);
        }
        // Exact case: 1 ICP → 0.75 / 0.25.
        assert_eq!(split_upvote(100_000_000), (75_000_000, 25_000_000));
    }

    #[test]
    fn test_idea_expiry_window() {
        let last = 1_700_000_000_000_000_000u64;
        assert!(!idea_is_expired(last, last));
        assert!(!idea_is_expired(last, last + IDEA_EXPIRY_NANOS));
        assert!(idea_is_expired(last, last + IDEA_EXPIRY_NANOS + 1));
        // saturating: a recent upvote near u64::MAX never wraps into expired
        assert!(!idea_is_expired(u64::MAX - 1, u64::MAX));
    }

    #[test]
    fn test_validate_idea_text_limits() {
        assert!(validate_idea_text("t", "d", "").is_ok());
        assert!(validate_idea_text("", "d", "").is_err());
        assert!(validate_idea_text("t", "", "").is_err());
        assert!(validate_idea_text(&"x".repeat(MAX_IDEA_TITLE_LEN), "d", "").is_ok());
        assert!(validate_idea_text(&"x".repeat(MAX_IDEA_TITLE_LEN + 1), "d", "").is_err());
        assert!(validate_idea_text("t", &"x".repeat(MAX_IDEA_DESCRIPTION_LEN + 1), "").is_err());
        assert!(validate_idea_text("t", "d", &"x".repeat(MAX_IDEA_DETAIL_LEN + 1)).is_err());
    }

    #[test]
    fn test_feature_flag_default_and_override() {
        // idea_board defaults ON; unknown flags default OFF.
        assert!(feature_enabled(FLAG_IDEA_BOARD));
        assert!(!feature_enabled("nonexistent_future_feature"));

        // Admin override wins over the default.
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().insert(FLAG_IDEA_BOARD.to_string(), 0u8);
        });
        assert!(!feature_enabled(FLAG_IDEA_BOARD));
        assert!(require_idea_board_enabled().is_err());

        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().insert(FLAG_IDEA_BOARD.to_string(), 1u8);
        });
        assert!(feature_enabled(FLAG_IDEA_BOARD));

        // list merges known defaults with stored overrides, no duplicates.
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().insert("future_thing".to_string(), 1u8);
        });
        let flags = list_feature_flags();
        assert_eq!(flags.iter().filter(|f| f.key == FLAG_IDEA_BOARD).count(), 1);
        assert!(flags.iter().any(|f| f.key == "future_thing" && f.enabled));

        // cleanup for other tests on this thread
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().remove(&FLAG_IDEA_BOARD.to_string());
            m.borrow_mut().remove(&"future_thing".to_string());
        });
    }

    #[test]
    fn test_flag_key_validation() {
        assert!(valid_flag_key("idea_board"));
        assert!(valid_flag_key("v2_board_3"));
        assert!(!valid_flag_key(""));
        assert!(!valid_flag_key("Has-Caps"));
        assert!(!valid_flag_key("has space"));
        assert!(!valid_flag_key(&"x".repeat(MAX_FLAG_KEY_LEN + 1)));
    }

    #[test]
    fn test_idea_subaccount_domain_separated() {
        let user = p("2vxsx-fae");
        let idea_sub = derive_idea_subaccount(&user, 42);
        let escrow_sub = derive_subaccount(&user, 42);
        assert_ne!(idea_sub, escrow_sub, "idea escrow must not collide with proposal escrow");
        assert_eq!(idea_sub, derive_idea_subaccount(&user, 42), "deterministic");
        assert_ne!(idea_sub, derive_idea_subaccount(&user, 43));
    }

    #[test]
    fn test_storable_idea_roundtrip() {
        let idea = Idea {
            id: 7,
            poster: p("2vxsx-fae"),
            title: "Burn more ICP".to_string(),
            description: "A thing".to_string(),
            detail: "Long detail".to_string(),
            created_at: 1,
            last_upvote_at: 2,
            upvote_count: 3,
            views: 9,
            total_icp_e8s: 4,
            total_ckbtc_e8s: 5,
            total_cketh_wei: 6,
        };
        let decoded = Idea::from_bytes(idea.to_bytes());
        assert_eq!(decoded.id, idea.id);
        assert_eq!(decoded.poster, idea.poster);
        assert_eq!(decoded.title, idea.title);
        assert_eq!(decoded.views, idea.views);
        assert_eq!(decoded.total_cketh_wei, idea.total_cketh_wei);
    }

    #[test]
    fn test_storable_idea_upvote_roundtrip() {
        let uv = IdeaUpvote {
            id: 1,
            idea_id: 7,
            voter: p("2vxsx-fae"),
            token: IdeaToken::CkBTC,
            amount: 123_456,
            status: UpvoteStatus::FailedPayout,
            created_at: 9,
            treasury_block: Some(11),
            poster_block: None,
        };
        let decoded = IdeaUpvote::from_bytes(uv.to_bytes());
        assert_eq!(decoded.token, uv.token);
        assert_eq!(decoded.status, uv.status);
        assert_eq!(decoded.treasury_block, Some(11));
        assert_eq!(decoded.poster_block, None);
    }

    // ── Dapp Explorer ──────────────────────────────────────────────────────

    #[test]
    fn test_explorer_quote_amount_math() {
        // ICP at $5: 1 day = $1 = 0.2 ICP.
        assert_eq!(explorer_quote_amount(1, 500_000_000, 8).unwrap(), (20_000_000, 100_000_000));
        // ckUSDC at $1: 3650 days = $3650 = 3650 ckUSDC (6 decimals).
        assert_eq!(
            explorer_quote_amount(3650, USD_E8S_PER_USD, 6).unwrap(),
            (3_650_000_000, 365_000_000_000)
        );
        // ckETH at $3k: 1 day ≈ 0.000333… ckETH in wei.
        let (wei, _) = explorer_quote_amount(1, 300_000_000_000, 18).unwrap();
        assert_eq!(wei, 333_333_333_333_333);
        // Bounds.
        assert!(explorer_quote_amount(0, 500_000_000, 8).is_err());
        assert!(explorer_quote_amount(3651, 500_000_000, 8).is_err());
        assert!(explorer_quote_amount(1, 0, 8).is_err());
    }

    #[test]
    fn test_validate_dapp_text() {
        assert!(validate_dapp_text("My Dapp", "https://example.com", "A fine dapp.").is_ok());
        assert!(validate_dapp_text("", "https://example.com", "d").is_err());
        assert!(validate_dapp_text(&"x".repeat(61), "https://example.com", "d").is_err());
        assert!(validate_dapp_text("n", "http://example.com", "d").is_err(), "https only");
        assert!(validate_dapp_text("n", "https://", "d").is_err(), "host required");
        assert!(validate_dapp_text("n", "https://exa mple.com", "d").is_err(), "no whitespace");
        assert!(validate_dapp_text("n", "https://example.com", "").is_err());
        assert!(validate_dapp_text("n", "https://example.com", &"x".repeat(281)).is_err());
    }

    #[test]
    fn test_seed_default_dapps_idempotent_and_listed_first() {
        clear_dapps();
        seed_default_dapps();
        seed_default_dapps(); // re-run inserts nothing new
        let listed = list_dapps();
        assert_eq!(listed.len(), 5);
        assert_eq!(listed[0].name, "idGeek 2.0");
        assert_eq!(listed[1].name, "Liquidium");
        assert_eq!(listed[2].name, "ICPSwap");
        assert_eq!(listed[3].name, "OISY Wallet");
        assert_eq!(listed[4].name, "OpenChat");
        assert!(listed.iter().all(|d| !d.community && d.expires_at.is_none()));
    }

    #[test]
    fn test_seed_default_dapps_backfills_missing_on_populated_directory() {
        clear_dapps();
        seed_default_dapps();
        // Simulate a directory seeded before the newer curated entries existed.
        let icpswap_id = list_dapps().iter().find(|d| d.name == "ICPSwap").unwrap().id;
        DAPPS.with(|m| { m.borrow_mut().remove(&icpswap_id); });
        assert_eq!(list_dapps().len(), 4);
        seed_default_dapps();
        let listed = list_dapps();
        assert_eq!(listed.len(), 5, "missing curated entry is backfilled");
        assert_eq!(listed.iter().filter(|d| d.name == "ICPSwap").count(), 1, "no duplicates");
    }

    #[tokio::test]
    async fn test_submit_dapp_full_flow_and_approval_gating() {
        clear_dapps();
        let user = p("p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe");
        let admin = p("gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe");
        let mut cfg = test_config(true);
        cfg.admins = vec![admin];
        CONFIG.with(|c| { c.borrow_mut().set(cfg); });
        set_mock_caller(user);

        // No quote yet → submit refused.
        let err = submit_dapp("D".into(), "https://d.app".into(), "desc".into(), ExplorerToken::ICP, 30)
            .await
            .unwrap_err();
        assert_eq!(err, "NO_QUOTE");

        // Quote 30 days in ICP at the local default rate ($5): $30 = 6 ICP.
        let quote = get_explorer_quote(ExplorerToken::ICP, 30).await.unwrap();
        assert_eq!(quote.amount, 600_000_000);
        assert_eq!(quote.usd_total_e8s, 3_000_000_000);

        // Token/days must match the quote.
        let err = submit_dapp("D".into(), "https://d.app".into(), "desc".into(), ExplorerToken::CkBTC, 30)
            .await
            .unwrap_err();
        assert_eq!(err, "QUOTE_MISMATCH");

        // Underfunded escrow refused; funded escrow accepted.
        set_mock_ledger_balance(quote.amount); // missing the fee
        let err = submit_dapp("D".into(), "https://d.app".into(), "desc".into(), ExplorerToken::ICP, 30)
            .await
            .unwrap_err();
        assert_eq!(err, "INSUFFICIENT_DEPOSIT");
        set_mock_ledger_balance(quote.amount + 10_000);
        set_mock_ledger_transfer(Ok(7));
        let id = submit_dapp("D".into(), "https://d.app".into(), "desc".into(), ExplorerToken::ICP, 30)
            .await
            .unwrap();

        // Pending: hidden from the public list, visible to the submitter,
        // queued for the admin.
        assert!(list_dapps().iter().all(|d| d.id != id));
        assert_eq!(list_my_dapp_submissions().len(), 1);
        assert_eq!(list_my_dapp_submissions()[0].status, DappStatus::Pending);
        // The quote is consumed — a second submit needs a new one.
        let err = submit_dapp("E".into(), "https://e.app".into(), "desc".into(), ExplorerToken::ICP, 30)
            .await
            .unwrap_err();
        assert_eq!(err, "NO_QUOTE");

        // Approval makes it public with the paid window applied, badged.
        set_mock_caller(admin);
        admin_approve_dapp(id).unwrap();
        let listed = list_dapps();
        let mine = listed.iter().find(|d| d.id == id).expect("approved listing is public");
        assert!(mine.community, "community submissions carry the badge flag");
        let expires = mine.expires_at.expect("paid listings expire");
        assert_eq!(expires - mine.approved_at.unwrap(), 30 * DAY_NANOS);
        assert_eq!(admin_approve_dapp(id).unwrap_err(), "NOT_PENDING");
        clear_dapps();
    }

    #[tokio::test]
    async fn test_reject_dapp_refunds_and_deletes() {
        clear_dapps();
        let user = p("p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_caller(user);
        let quote = get_explorer_quote(ExplorerToken::CkUSDC, 5).await.unwrap();
        assert_eq!(quote.amount, 5_000_000); // $5 at 6 decimals
        set_mock_ledger_balance(quote.amount + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let id = submit_dapp("D".into(), "https://d.app".into(), "desc".into(), ExplorerToken::CkUSDC, 5)
            .await
            .unwrap();

        // A failed refund keeps the listing for a retry.
        set_mock_ledger_transfer(Err("ledger down".into()));
        assert!(admin_reject_dapp(id).await.is_err());
        assert_eq!(list_pending_dapps().len(), 1);

        set_mock_ledger_transfer(Ok(2));
        admin_reject_dapp(id).await.unwrap();
        assert!(DAPPS.with(|m| m.borrow().get(&id)).is_none());
        clear_dapps();
    }

    #[test]
    fn test_expired_dapps_hidden_and_swept() {
        clear_dapps();
        let now = current_time();
        let id = next_dapp_id();
        DAPPS.with(|m| {
            m.borrow_mut().insert(id, DappListing {
                id,
                submitter: p("2vxsx-fae"),
                name: "Old".into(),
                url: "https://old.app".into(),
                description: "d".into(),
                community: true,
                status: DappStatus::Approved,
                created_at: now.saturating_sub(2 * DAY_NANOS),
                approved_at: Some(now.saturating_sub(2 * DAY_NANOS)),
                expires_at: Some(now.saturating_sub(DAY_NANOS)),
                days: 1,
                token: Some(ExplorerToken::ICP),
                amount_paid: 20_000_000,
            });
        });
        assert!(list_dapps().is_empty(), "expired listings never render");
        delete_expired_dapps();
        assert!(DAPPS.with(|m| m.borrow().get(&id)).is_none(), "sweep deletes them");
    }

    // ── Arcade ─────────────────────────────────────────────────────────────

    fn enable_arcade_flag() {
        FEATURE_FLAGS.with(|m| { m.borrow_mut().insert(FLAG_ARCADE.to_string(), 1); });
    }

    fn clear_arcade() {
        let keys: Vec<ArcadeScoreKey> = ARCADE_SCORES.with(|m| m.borrow().iter().map(|e| e.key().clone()).collect());
        ARCADE_SCORES.with(|m| { let mut m = m.borrow_mut(); for k in keys { m.remove(&k); } });
        let chars: Vec<Principal> = ARCADE_CHARACTERS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
        ARCADE_CHARACTERS.with(|m| { let mut m = m.borrow_mut(); for k in chars { m.remove(&k); } });
        let quotes: Vec<Principal> = ARCADE_QUOTES.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
        ARCADE_QUOTES.with(|m| { let mut m = m.borrow_mut(); for k in quotes { m.remove(&k); } });
    }

    #[test]
    fn test_arcade_access_gate() {
        let nobody = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        let staker = p("gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe");
        let voter = p("p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe");
        let now = current_time();

        assert_eq!(arcade_access(nobody), (false, false), "no stake, no vote → hole 1 only");

        STAKES.with(|m| {
            m.borrow_mut().insert(
                StakeKey { tier: 0, user: staker },
                UserStake { amount_e8s: 100_000_000, staked_at: now, last_action_at: now },
            );
        });
        let (has_stake, _) = arcade_access(staker);
        assert!(has_stake, "any active stake unlocks the full round");

        // A vote inside the 30-day window counts; an older one doesn't.
        LOSSLESS_VOTES.with(|m| {
            m.borrow_mut().insert(
                CommitmentKey { proposal_id: 901, principal: voter },
                LosslessVote { proposal_id: 901, principal: voter, stance: Stance::Adopt, weight_e8s: 1, cast_at: now },
            );
        });
        assert_eq!(arcade_access(voter).1, true, "fresh staked vote unlocks");
        LOSSLESS_VOTES.with(|m| {
            m.borrow_mut().insert(
                CommitmentKey { proposal_id: 901, principal: voter },
                LosslessVote { proposal_id: 901, principal: voter, stance: Stance::Adopt, weight_e8s: 1, cast_at: now.saturating_sub(31 * DAY_NANOS) },
            );
        });
        assert_eq!(arcade_access(voter).1, false, "31-day-old vote does not");

        // Cleanup so other tests see a clean slate.
        STAKES.with(|m| { m.borrow_mut().remove(&StakeKey { tier: 0, user: staker }); });
        LOSSLESS_VOTES.with(|m| { m.borrow_mut().remove(&CommitmentKey { proposal_id: 901, principal: voter }); });
    }

    #[test]
    fn test_submit_arcade_score_gating_and_ranking() {
        clear_arcade();
        enable_arcade_flag();
        let now = current_time();
        let alice = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        let bob = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });

        // Ineligible players can't land on the leaderboard.
        set_mock_caller(alice);
        let err = submit_arcade_score("minigolf".into(), 120_000, vec![3; 9]).unwrap_err();
        assert_eq!(err, "PARTICIPATION_REQUIRED");

        // Stake both players in.
        for u in [alice, bob] {
            STAKES.with(|m| {
                m.borrow_mut().insert(
                    StakeKey { tier: 0, user: u },
                    UserStake { amount_e8s: 100_000_000, staked_at: now, last_action_at: now },
                );
            });
        }

        // Validation: game key, hole count, stroke bounds, time bounds.
        assert_eq!(submit_arcade_score("pacman".into(), 120_000, vec![3; 9]).unwrap_err(), "UNKNOWN_GAME");
        assert_eq!(submit_arcade_score("minigolf".into(), 120_000, vec![3; 8]).unwrap_err(), "INVALID_HOLE_COUNT");
        assert_eq!(submit_arcade_score("minigolf".into(), 120_000, vec![0; 9]).unwrap_err(), "INVALID_STROKES");
        assert_eq!(submit_arcade_score("minigolf".into(), 120_000, vec![13; 9]).unwrap_err(), "INVALID_STROKES");
        assert_eq!(submit_arcade_score("minigolf".into(), 1_000, vec![3; 9]).unwrap_err(), "INVALID_TIME");

        // Alice: 27 strokes. Bob: 27 strokes but faster → rank 1 on time tiebreak.
        assert_eq!(submit_arcade_score("minigolf".into(), 200_000, vec![3; 9]).unwrap(), 1);
        set_mock_caller(bob);
        assert_eq!(submit_arcade_score("minigolf".into(), 150_000, vec![3; 9]).unwrap(), 1);

        // Worse later round doesn't overwrite Bob's best.
        assert_eq!(submit_arcade_score("minigolf".into(), 100_000, vec![4; 9]).unwrap(), 1);
        let board = get_arcade_leaderboard("minigolf".into());
        assert_eq!(board.len(), 2);
        assert_eq!(board[0].player, bob);
        assert_eq!(board[0].strokes, 27);
        assert_eq!(board[0].millis, 150_000);
        assert_eq!(board[1].player, alice);

        // A genuinely better round (fewer strokes) replaces and re-ranks.
        set_mock_caller(alice);
        assert_eq!(submit_arcade_score("minigolf".into(), 300_000, vec![2; 9]).unwrap(), 1);
        let board = get_arcade_leaderboard("minigolf".into());
        assert_eq!(board[0].player, alice);
        assert_eq!(board[0].strokes, 18);

        for u in [alice, bob] {
            STAKES.with(|m| { m.borrow_mut().remove(&StakeKey { tier: 0, user: u }); });
        }
        clear_arcade();
    }

    // ── Early Adopters ────────────────────────────────────────────────────────

    fn clear_early_adopters() {
        let keys: Vec<Principal> = EARLY_ADOPTERS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
        EARLY_ADOPTERS.with(|m| { let mut m = m.borrow_mut(); for k in keys { m.remove(&k); } });
        let months: Vec<u64> = EARLY_ADOPTER_ROUNDS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
        EARLY_ADOPTER_ROUNDS.with(|m| { let mut m = m.borrow_mut(); for k in months { m.remove(&k); } });
        EARLY_ADOPTER_STATE.with(|c| {
            c.borrow_mut().set(EarlyAdopterState {
                total_staked_e8s: 0, rollover_e8s: 0, last_processed_month: 0,
                total_yield_e8s: 0, total_distributed_e8s: 0, total_expired_e8s: 0,
                membership_closed: false, nonce: 0, neuron_id: None,
                pending_refresh_e8s: 0, bootstrap: 0, total_restaked_e8s: 0,
                pending_job: None,
            });
        });
    }

    fn enable_early_adopters_flag() {
        FEATURE_FLAGS.with(|m| { m.borrow_mut().insert(FLAG_EARLY_ADOPTERS.to_string(), 1); });
    }

    const ICP: u64 = 100_000_000;

    #[test]
    fn test_early_adopter_route_yield_rules() {
        // Under 500 ICP: the whole month restakes into the neuron.
        assert_eq!(early_adopter_route_yield(499 * ICP, 0), (499 * ICP, 0, 0));
        assert_eq!(early_adopter_route_yield(1, 0), (1, 0, 0));
        // 500..1,000: all treasury, nothing to the pot.
        assert_eq!(early_adopter_route_yield(500 * ICP, 0), (0, 500 * ICP, 0));
        assert_eq!(early_adopter_route_yield(999 * ICP, 0), (0, 999 * ICP, 0));
        assert_eq!(early_adopter_route_yield(1000 * ICP, 0), (0, 1000 * ICP, 0));
        // Above 1,000: treasury keeps 1,000, the excess feeds the pot.
        assert_eq!(early_adopter_route_yield(1150 * ICP, 0), (0, 1000 * ICP, 150 * ICP));
        // The pot is net of the ledger fee burned moving it into the pool —
        // otherwise the final claim is one fee short (caught by local e2e).
        assert_eq!(early_adopter_route_yield(1200 * ICP, 10_000), (0, 1000 * ICP, 200 * ICP - 10_000));
        // Excess at or below one fee doesn't move.
        assert_eq!(early_adopter_route_yield(1000 * ICP + 9_000, 10_000), (0, 1000 * ICP, 0));
    }

    #[test]
    fn test_early_adopter_allocate_is_proportional_to_stake() {
        let a = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        let b = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        // 10 vs 30 staked → 25% / 75% of the pot.
        let stakes = vec![(a, 10 * ICP), (b, 30 * ICP)];
        let (shares, dust) = early_adopter_allocate(200 * ICP, &stakes);
        assert_eq!(shares, vec![(a, 50 * ICP), (b, 150 * ICP)]);
        assert_eq!(dust, 0);
        // Pots under 100 ICP allocate nothing — everything rolls over.
        let (none, roll) = early_adopter_allocate(99 * ICP, &stakes);
        assert!(none.is_empty());
        assert_eq!(roll, 99 * ICP);
        // Integer dust stays in the pool.
        let stakes3 = vec![(a, 1 * ICP), (b, 2 * ICP)];
        let (shares3, dust3) = early_adopter_allocate(100 * ICP + 1, &stakes3);
        let total: u64 = shares3.iter().map(|(_, s)| *s).sum();
        assert_eq!(total + dust3, 100 * ICP + 1);
        assert!(shares3[1].1 == shares3[0].1 * 2 || shares3[1].1 == shares3[0].1 * 2 + 1);
        // No stake → nothing allocated.
        assert_eq!(early_adopter_allocate(500 * ICP, &[]).0.len(), 0);
    }

    #[tokio::test]
    async fn test_early_adopter_stake_is_permanent_and_validated() {
        clear_early_adopters();
        enable_early_adopters_flag();
        let user = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_caller(user);

        // Below the 1 ICP minimum.
        assert_eq!(early_adopter_stake(ICP - 1).await.unwrap_err(), "BELOW_MIN_STAKE");
        // Underfunded escrow.
        set_mock_ledger_balance(2 * ICP); // needs 2 ICP + fee
        assert_eq!(early_adopter_stake(2 * ICP).await.unwrap_err(), "INSUFFICIENT_DEPOSIT");
        // Funded: stake lands and accumulates.
        set_mock_ledger_balance(2 * ICP + 10_000);
        set_mock_ledger_transfer(Ok(1));
        early_adopter_stake(2 * ICP).await.unwrap();
        early_adopter_stake(2 * ICP).await.unwrap();
        let info = get_early_adopter_info();
        assert_eq!(info.my_staked_e8s, 4 * ICP);
        assert_eq!(info.early_adopter_count, 1);
        assert_eq!(info.total_staked_e8s, 4 * ICP);
        // The settlement clock anchored to "now" — next run is a month out.
        assert!(info.next_distribution_at > current_time());
        clear_early_adopters();
    }

    #[tokio::test]
    async fn test_early_adopter_settlement_allocates_claims_and_expires() {
        clear_early_adopters();
        enable_early_adopters_flag();
        let alice = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        let bob = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_ledger_transfer(Ok(1));
        // Alice stakes 10, Bob 30 → shares must be 25% / 75%.
        set_mock_caller(alice);
        set_mock_ledger_balance(10 * ICP + 10_000);
        early_adopter_stake(10 * ICP).await.unwrap();
        set_mock_caller(bob);
        set_mock_ledger_balance(30 * ICP + 10_000);
        early_adopter_stake(30 * ICP).await.unwrap();

        // The neuron bootstraps and follows the primary voting neuron.
        let info = get_early_adopter_info();
        assert!(info.neuron_id.is_some(), "neuron claimed at first stake");
        assert!(info.follows_primary_neuron, "follows the leader on all topics");

        // Month 1: 1,200 ICP yield in the inbox → 1,000 treasury; the 200
        // excess (net of one pool-transfer fee) splits 25/75 by stake.
        let pot = 200 * ICP - 10_000;
        let alice_share = pot / 4;
        let bob_share = (pot as u128 * 3 / 4) as u64;
        set_mock_ledger_balance(1200 * ICP); // inbox balance read
        early_adopter_run_settlement(current_time()).await.unwrap();
        set_mock_caller(alice);
        assert_eq!(get_early_adopter_info().my_claimable_e8s, alice_share);
        set_mock_caller(bob);
        assert_eq!(get_early_adopter_info().my_claimable_e8s, bob_share);
        let rounds = list_early_adopter_rounds();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].yield_e8s, 1200 * ICP);
        assert_eq!(rounds[0].treasury_e8s, 1000 * ICP);
        assert_eq!(rounds[0].distributed_e8s, alice_share + bob_share);
        assert_eq!(rounds[0].restaked_e8s, 0);
        assert_eq!(rounds[0].early_adopter_count, 2);

        // Alice claims; Bob doesn't.
        set_mock_caller(alice);
        let net = claim_early_adopter_yield().await.unwrap();
        assert_eq!(net, alice_share - 10_000);
        assert_eq!(claim_early_adopter_yield().await.unwrap_err(), "NOTHING_TO_CLAIM");

        // Month 2 settles with low yield (50 ICP — under 500, so the whole
        // month RESTAKES into the neuron) and Bob's unclaimed share is
        // forfeited to the treasury.
        set_mock_ledger_balance(50 * ICP);
        early_adopter_run_settlement(current_time() + EARLY_ADOPTER_PERIOD_NANOS).await.unwrap();
        set_mock_caller(bob);
        assert_eq!(get_early_adopter_info().my_claimable_e8s, 0, "unclaimed share expired");
        let rounds = list_early_adopter_rounds();
        assert_eq!(rounds.len(), 2);
        let r2 = rounds.iter().find(|r| r.expired_e8s > 0).expect("expiry recorded");
        assert_eq!(r2.expired_e8s, bob_share);
        assert_eq!(r2.treasury_e8s, 0, "sub-500 months pay the treasury nothing");
        assert_eq!(r2.restaked_e8s, 50 * ICP, "sub-500 months compound into the neuron");
        assert_eq!(r2.distributed_e8s, 0);
        assert_eq!(get_early_adopter_info().total_restaked_e8s, 50 * ICP);

        // Month 3: 700 ICP — between the thresholds → all treasury.
        set_mock_ledger_balance(700 * ICP);
        early_adopter_run_settlement(current_time() + 2 * EARLY_ADOPTER_PERIOD_NANOS).await.unwrap();
        let rounds = list_early_adopter_rounds();
        let r3 = rounds.iter().find(|r| r.treasury_e8s == 700 * ICP).expect("mid-band month");
        assert_eq!(r3.restaked_e8s, 0);
        assert_eq!(r3.distributed_e8s, 0);
        clear_early_adopters();
    }

    #[tokio::test]
    async fn test_early_adopter_settlement_resumes_journal_without_rerouting() {
        clear_early_adopters();
        enable_early_adopters_flag();
        let alice = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        let bob = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_ledger_transfer(Ok(1));
        set_mock_caller(alice);
        set_mock_ledger_balance(10 * ICP + 10_000);
        early_adopter_stake(10 * ICP).await.unwrap();
        set_mock_caller(bob);
        set_mock_ledger_balance(30 * ICP + 10_000);
        early_adopter_stake(30 * ICP).await.unwrap();

        // A 1,600 ICP month whose treasury-cut transfer fails mid-flight.
        set_mock_ledger_balance(1600 * ICP);
        set_mock_ledger_transfer(Err("ledger down".into()));
        assert!(early_adopter_run_settlement(current_time()).await.is_err());
        let job = EARLY_ADOPTER_STATE.with(|c| c.borrow().get().pending_job.clone()).expect("journal persisted");
        assert_eq!(job.yield_e8s, 1600 * ICP);
        assert_eq!(job.treasury_cut_e8s, 1000 * ICP);
        assert_eq!(job.excess_net_e8s, 600 * ICP - 10_000);
        assert!(job.expired_done && job.restake_done && !job.cut_done);

        // Resume with the inbox apparently drained (the pre-fix code re-read
        // it and re-routed, double-dipping the treasury): the journal's
        // amounts must be used instead.
        set_mock_ledger_balance(0);
        set_mock_ledger_transfer(Ok(2));
        early_adopter_run_settlement(current_time()).await.unwrap();
        assert!(EARLY_ADOPTER_STATE.with(|c| c.borrow().get().pending_job.is_none()), "journal closed");
        let rounds = list_early_adopter_rounds();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].yield_e8s, 1600 * ICP, "original month, not the re-read remainder");
        assert_eq!(rounds[0].treasury_e8s, 1000 * ICP, "cut taken exactly once");
        assert_eq!(rounds[0].restaked_e8s, 0, "remainder NOT mis-restaked");
        let pot = 600 * ICP - 10_000;
        assert_eq!(rounds[0].distributed_e8s, pot / 4 + (pot as u128 * 3 / 4) as u64);

        // Once a settlement opens, prior claims are already expired: a claim
        // racing the next month's settlement gets NOTHING_TO_CLAIM instead
        // of double-spending the share pool.
        set_mock_ledger_balance(50 * ICP);
        set_mock_ledger_transfer(Err("ledger down".into()));
        assert!(early_adopter_run_settlement(current_time() + EARLY_ADOPTER_PERIOD_NANOS).await.is_err());
        set_mock_caller(alice);
        assert_eq!(claim_early_adopter_yield().await.unwrap_err(), "NOTHING_TO_CLAIM");
        set_mock_ledger_transfer(Ok(3));
        early_adopter_run_settlement(current_time() + EARLY_ADOPTER_PERIOD_NANOS).await.unwrap();
        let rounds = list_early_adopter_rounds();
        let r2 = rounds.iter().find(|r| r.expired_e8s > 0).expect("expiry recorded");
        assert_eq!(r2.expired_e8s, pot / 4 + (pot as u128 * 3 / 4) as u64);
        clear_early_adopters();
    }

    #[tokio::test]
    async fn test_reclaim_escrow_returns_stranded_deposits() {
        let user = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_caller(user);
        // Nothing deposited → nothing to reclaim.
        set_mock_ledger_balance(0);
        assert_eq!(reclaim_escrow(EscrowKind::Explorer, ExplorerToken::ICP).await.unwrap_err(), "NOTHING_TO_RECLAIM");
        // A stranded 5 ICP deposit (e.g. quote expired) comes back minus one fee.
        set_mock_ledger_balance(5 * ICP);
        set_mock_ledger_transfer(Ok(9));
        assert_eq!(reclaim_escrow(EscrowKind::Explorer, ExplorerToken::ICP).await.unwrap(), 5 * ICP - 10_000);
        assert_eq!(reclaim_escrow(EscrowKind::Arcade, ExplorerToken::CkUSDT).await.unwrap(), 5 * ICP - 10_000);
        assert_eq!(reclaim_escrow(EscrowKind::EarlyAdopter, ExplorerToken::ICP).await.unwrap(), 5 * ICP - 10_000);
    }

    #[tokio::test]
    async fn test_early_adopter_membership_closes_at_2000_yield_but_topups_continue() {
        clear_early_adopters();
        enable_early_adopters_flag();
        let alice = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        let bob = p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_ledger_transfer(Ok(1));
        set_mock_caller(alice);
        set_mock_ledger_balance(5 * ICP + 10_000);
        early_adopter_stake(5 * ICP).await.unwrap();

        // A 1,999 ICP month keeps the doors open.
        set_mock_ledger_balance(1999 * ICP);
        early_adopter_run_settlement(current_time()).await.unwrap();
        assert!(!get_early_adopter_info().membership_closed);

        // A 2,000 ICP month latches the table shut — permanently.
        set_mock_ledger_balance(2000 * ICP);
        early_adopter_run_settlement(current_time() + EARLY_ADOPTER_PERIOD_NANOS).await.unwrap();
        assert!(get_early_adopter_info().membership_closed);

        // New members are turned away…
        set_mock_caller(bob);
        set_mock_ledger_balance(5 * ICP + 10_000);
        assert_eq!(early_adopter_stake(5 * ICP).await.unwrap_err(), "MEMBERSHIP_CLOSED");
        // …even after a later low-yield month (the latch never reopens).
        set_mock_ledger_balance(10 * ICP);
        early_adopter_run_settlement(current_time() + 2 * EARLY_ADOPTER_PERIOD_NANOS).await.unwrap();
        set_mock_caller(bob);
        set_mock_ledger_balance(5 * ICP + 10_000);
        assert_eq!(early_adopter_stake(5 * ICP).await.unwrap_err(), "MEMBERSHIP_CLOSED");

        // …but an existing early adopter can always add more.
        set_mock_caller(alice);
        set_mock_ledger_balance(3 * ICP + 10_000);
        early_adopter_stake(3 * ICP).await.unwrap();
        assert_eq!(get_early_adopter_info().my_staked_e8s, 8 * ICP);
        assert_eq!(get_early_adopter_info().early_adopter_count, 1);
        clear_early_adopters();
    }

    #[test]
    fn test_twitter_handle_set_validate_clear() {
        let user = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        set_mock_caller(user);
        // Leading @ and whitespace are normalised away.
        set_twitter_handle("  @icp_builder ".into()).unwrap();
        assert_eq!(get_my_twitter_handle(), Some("icp_builder".to_string()));
        // X's rules: 1–15 chars, alphanumeric + underscore only.
        assert_eq!(set_twitter_handle("way_too_long_for_twitter".into()).unwrap_err(), "INVALID_HANDLE");
        assert_eq!(set_twitter_handle("bad-dash".into()).unwrap_err(), "INVALID_HANDLE");
        assert_eq!(set_twitter_handle("has space".into()).unwrap_err(), "INVALID_HANDLE");
        // Failed updates leave the old handle in place.
        assert_eq!(get_my_twitter_handle(), Some("icp_builder".to_string()));
        // Empty clears it.
        set_twitter_handle("".into()).unwrap();
        assert_eq!(get_my_twitter_handle(), None);
    }

    fn valid_test_hole() -> ArcadeHoleDef {
        // 22×14 all-grass field ringed by wall cells.
        let (w, h) = (22u8, 14u8);
        let mut cells = vec![1u8; (w as usize) * (h as usize)];
        for x in 0..w as usize {
            cells[x] = 2;
            cells[(h as usize - 1) * w as usize + x] = 2;
        }
        for y in 0..h as usize {
            cells[y * w as usize] = 2;
            cells[y * w as usize + w as usize - 1] = 2;
        }
        ArcadeHoleDef {
            name: "Test Hole".into(),
            par: 3,
            w, h, cells,
            tee_x: 10, tee_y: 11,
            cup_x: 10, cup_y: 2,
            bars: vec![],
        }
    }

    #[test]
    fn test_arcade_course_editor_validation_and_roundtrip() {
        let admin = p("gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe");
        let mut cfg = test_config(true);
        cfg.admins = vec![admin];
        CONFIG.with(|c| { c.borrow_mut().set(cfg); });
        set_mock_caller(admin);

        // Reject the obviously broken layouts.
        assert_eq!(admin_set_arcade_hole(9, valid_test_hole()).unwrap_err(), "INVALID_HOLE_INDEX");
        let mut bad = valid_test_hole();
        bad.par = 7;
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "INVALID_PAR");
        let mut bad = valid_test_hole();
        bad.cells.pop();
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "INVALID_CELL_COUNT");
        let mut bad = valid_test_hole();
        bad.cells[30] = 10;
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "INVALID_CELL_TYPE");
        let mut bad = valid_test_hole();
        bad.tee_x = 0; // on the wall ring
        bad.tee_y = 0;
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "TEE_NOT_ON_GREEN");
        let mut bad = valid_test_hole();
        bad.cup_x = bad.tee_x;
        bad.cup_y = bad.tee_y;
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "TEE_EQUALS_CUP");
        let mut bad = valid_test_hole();
        bad.bars = vec![ArcadeBarDef { cx: 30, cy: 7, len_cells: 3, speed_mrad: 1900 }];
        assert_eq!(admin_set_arcade_hole(0, bad).unwrap_err(), "INVALID_BAR");

        // A valid hole persists, lists, and resets.
        let mut hole = valid_test_hole();
        hole.bars = vec![ArcadeBarDef { cx: 11, cy: 7, len_cells: 3, speed_mrad: 1900 }];
        admin_set_arcade_hole(3, hole).unwrap();
        let course = get_arcade_course();
        assert_eq!(course.len(), 1);
        assert_eq!(course[0].index, 3);
        assert_eq!(course[0].hole.name, "Test Hole");
        assert_eq!(course[0].hole.bars.len(), 1);
        admin_reset_arcade_hole(3).unwrap();
        assert!(get_arcade_course().is_empty());
        assert_eq!(admin_reset_arcade_hole(3).unwrap_err(), "NO_OVERRIDE");
    }

    #[tokio::test]
    async fn test_customize_character_payment_and_palette() {
        clear_arcade();
        enable_arcade_flag();
        let user = p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe");
        CONFIG.with(|c| { c.borrow_mut().set(test_config(true)); });
        set_mock_caller(user);

        // Palette indices are bounds-checked.
        assert_eq!(customize_character(6, 0, 0, ExplorerToken::ICP).await.unwrap_err(), "INVALID_CHARACTER_OPTION");
        assert_eq!(customize_character(0, 6, 0, ExplorerToken::ICP).await.unwrap_err(), "INVALID_CHARACTER_OPTION");
        assert_eq!(customize_character(0, 0, 8, ExplorerToken::ICP).await.unwrap_err(), "INVALID_CHARACTER_OPTION");

        // A fresh matching quote is required.
        assert_eq!(customize_character(2, 3, 4, ExplorerToken::ICP).await.unwrap_err(), "NO_QUOTE");

        // $1 in ICP at the local default rate ($5/ICP) = 0.2 ICP.
        let quote = get_arcade_customize_quote(ExplorerToken::ICP).await.unwrap();
        assert_eq!(quote.amount, 20_000_000);
        assert_eq!(quote.usd_total_e8s, ARCADE_CUSTOMIZE_FEE_USD_E8S);
        assert_eq!(customize_character(2, 3, 4, ExplorerToken::CkBTC).await.unwrap_err(), "QUOTE_MISMATCH");

        // Underfunded escrow refused.
        set_mock_ledger_balance(quote.amount); // missing the fee
        assert_eq!(customize_character(2, 3, 4, ExplorerToken::ICP).await.unwrap_err(), "INSUFFICIENT_DEPOSIT");
        assert!(ARCADE_CHARACTERS.with(|m| m.borrow().get(&user)).is_none());

        // Funded: $1 of ICP moves to the treasury and the look persists.
        set_mock_ledger_balance(quote.amount + 10_000);
        set_mock_ledger_transfer(Ok(5));
        customize_character(2, 3, 4, ExplorerToken::ICP).await.unwrap();
        let c = ARCADE_CHARACTERS.with(|m| m.borrow().get(&user)).unwrap();
        assert_eq!((c.hair, c.skin, c.outfit), (2, 3, 4));
        // The quote is consumed.
        assert_eq!(customize_character(1, 1, 1, ExplorerToken::ICP).await.unwrap_err(), "NO_QUOTE");

        // Stables are pinned at $1 — 1 ckUSDT == 1_000_000 micro.
        let usdt = get_arcade_customize_quote(ExplorerToken::CkUSDT).await.unwrap();
        assert_eq!(usdt.amount, 1_000_000);
        assert_eq!(usdt.rate_usd_e8s, USD_E8S_PER_USD);
        clear_arcade();
    }

    fn clear_dapps() {
        let ids: Vec<u64> = DAPPS.with(|m| m.borrow().iter().map(|e| *e.key()).collect());
        DAPPS.with(|m| {
            let mut m = m.borrow_mut();
            for id in ids {
                m.remove(&id);
            }
        });
        EXPLORER_QUOTES.with(|m| {
            let keys: Vec<Principal> = m.borrow().iter().map(|e| *e.key()).collect();
            let mut m = m.borrow_mut();
            for k in keys {
                m.remove(&k);
            }
        });
    }

    fn test_config(is_local: bool) -> Config {
        Config {
            primary_neuron_id: 1,
            admins: vec![],
            default_threshold: 200_000_000,
            ai_price_e8s: 5_000_000,
            ledger_canister_id: p("ryjl3-tyaaa-aaaaa-aaaba-cai"),
            is_local,
            frontend_canister_id: None,
            pool_initiation_fee_e8s: 12_500_000_000,
            ckbtc_ledger_canister_id: None,
            cketh_ledger_canister_id: None,
            ckusdc_ledger_canister_id: None,
            ckusdt_ledger_canister_id: None,
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
            min_stake_e8s: default_min_stake_e8s(),
            min_unstake_e8s: default_min_unstake_e8s(),
            maturity_threshold_e8s: default_maturity_threshold_e8s(),
            lottery_tickets_per_day: default_lottery_tickets_per_day(),
        }
    }

    #[test]
    fn test_token_economics_value_aligned() {
        let mainnet = test_config(false);

        // Exchange-rate alignment: minimums must NOT be a flat per-token
        // number — each token's min reflects its unit value.
        let min_icp = token_min_upvote(IdeaToken::ICP, &mainnet);
        let min_btc = token_min_upvote(IdeaToken::CkBTC, &mainnet);
        let min_eth = token_min_upvote(IdeaToken::CkETH, &mainnet);
        assert!(min_btc < min_icp, "a ckBTC sat is worth far more than an ICP e8");
        assert_ne!(min_icp, min_eth);

        // The 25% poster share at the minimum must clear the ledger fee on
        // every real ledger (mainnet, and local with dedicated test ledgers).
        let mut local_with_ledgers = test_config(true);
        local_with_ledgers.ckbtc_ledger_canister_id = Some(p("2vxsx-fae"));
        local_with_ledgers.cketh_ledger_canister_id = Some(p("2vxsx-fae"));
        for cfg in [&mainnet, &local_with_ledgers] {
            for token in [IdeaToken::ICP, IdeaToken::CkBTC, IdeaToken::CkETH] {
                let min = token_min_upvote(token, cfg);
                let fee = token_fee(token, cfg);
                let (_, poster) = split_upvote(min);
                assert!(
                    poster > fee,
                    "poster share {} must exceed fee {} ({:?}, local={})",
                    poster, fee, token, cfg.is_local
                );
            }
        }

        // Admin overrides win over the defaults.
        let mut tuned = test_config(false);
        tuned.min_upvote_icp_e8s = Some(40_000_000);
        tuned.min_upvote_ckbtc_e8s = Some(2_000);
        tuned.min_upvote_cketh_wei = Some(660_000_000_000_000);
        assert_eq!(token_min_upvote(IdeaToken::ICP, &tuned), 40_000_000);
        assert_eq!(token_min_upvote(IdeaToken::CkBTC, &tuned), 2_000);
        assert_eq!(token_min_upvote(IdeaToken::CkETH, &tuned), 660_000_000_000_000);
    }

    #[test]
    fn test_token_ledger_resolution() {
        // Mainnet: canonical ledgers hard-pinned; overrides ignored.
        let mut mainnet = test_config(false);
        mainnet.ckbtc_ledger_canister_id = Some(p("2vxsx-fae"));
        assert_eq!(
            token_ledger(IdeaToken::CkBTC, &mainnet),
            p(MAINNET_CKBTC_LEDGER)
        );
        assert_eq!(
            token_ledger(IdeaToken::CkETH, &mainnet),
            p(MAINNET_CKETH_LEDGER)
        );
        assert_eq!(token_ledger(IdeaToken::ICP, &mainnet), mainnet.ledger_canister_id);

        // Local without overrides: fall back to the ICP test ledger, with
        // that ledger's 10_000 fee.
        let local = test_config(true);
        assert_eq!(token_ledger(IdeaToken::CkBTC, &local), local.ledger_canister_id);
        assert_eq!(token_fee(IdeaToken::CkBTC, &local), 10_000);

        // Local with dedicated ledgers: overrides apply, canonical fees apply.
        let mut local_cfg = test_config(true);
        let ckbtc = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        local_cfg.ckbtc_ledger_canister_id = Some(ckbtc);
        assert_eq!(token_ledger(IdeaToken::CkBTC, &local_cfg), ckbtc);
        assert_eq!(token_fee(IdeaToken::CkBTC, &local_cfg), 10);
    }

    #[tokio::test]
    async fn test_post_idea_validation_quota_and_fee() {
        let caller = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(caller);
        set_mock_ledger_transfer(Ok(5));

        // Posting fee unpaid → rejected, nothing stored.
        set_mock_ledger_balance(IDEA_POST_FEE_E8S); // missing the ledger fee
        assert_eq!(
            post_idea("Unpaid".into(), "Desc".into(), "".into()).await.unwrap_err(),
            "INSUFFICIENT_DEPOSIT"
        );
        assert!(IDEAS.with(|m| m.borrow().is_empty()));

        // happy path (fee escrow funded)
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        let id = post_idea("Title".into(), "Desc".into(), "Detail".into()).await.unwrap();
        let idea = IDEAS.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(idea.poster, caller);
        assert_eq!(idea.views, 0);
        assert_eq!(idea.last_upvote_at, idea.created_at);

        // invalid title (validated before the fee is touched)
        assert_eq!(
            post_idea("   ".into(), "Desc".into(), "".into()).await.unwrap_err(),
            "INVALID_TITLE"
        );

        // per-user active quota
        for i in 0..MAX_ACTIVE_IDEAS_PER_USER {
            let _ = post_idea(format!("Idea {}", i), "Desc".into(), "".into()).await;
        }
        assert_eq!(
            post_idea("One too many".into(), "Desc".into(), "".into()).await.unwrap_err(),
            "TOO_MANY_ACTIVE_IDEAS"
        );

        // anonymous rejected
        set_mock_caller(anon());
        assert!(post_idea("T".into(), "D".into(), "".into()).await.is_err());

        // disabled flag rejected
        set_mock_caller(caller);
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().insert(FLAG_IDEA_BOARD.to_string(), 0u8);
        });
        assert_eq!(
            post_idea("T".into(), "D".into(), "".into()).await.unwrap_err(),
            "FEATURE_DISABLED"
        );
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().remove(&FLAG_IDEA_BOARD.to_string());
        });
    }

    #[tokio::test]
    async fn test_projects_fund_flow() {
        let funder = p("ryjl3-tyaaa-aaaaa-aaaba-cai");

        // admin_add_project is guard-gated on-chain; exercise the body's
        // validation rules through a direct insert + the public flows.
        assert!(validate_idea_text("Project X", "Build it", "Detail").is_ok());
        let now = current_time();
        let project_id = 71u64;
        PROJECTS.with(|m| {
            m.borrow_mut().insert(project_id, Project {
                id: project_id,
                title: "Project X".into(),
                description: "Build it".into(),
                detail: "Detail".into(),
                created_at: now,
                goal_icp_e8s: 100_000_000_000,
                goal_ckbtc_e8s: 0,
                goal_cketh_wei: 0,
                raised_icp_e8s: 0,
                raised_ckbtc_e8s: 0,
                raised_cketh_wei: 0,
                funding_count: 0,
                accept_icp: true,
                accept_ckbtc: true,
                accept_cketh: true,
            });
        });
        assert!(list_projects().iter().any(|pr| pr.id == project_id));

        set_mock_caller(funder);
        set_mock_ledger_transfer(Ok(9));

        // Below minimum / unknown project / insufficient deposit
        set_mock_ledger_balance(10_000_000_000);
        assert_eq!(
            fund_project(project_id, IdeaToken::ICP, 1).await.unwrap_err(),
            "BELOW_MINIMUM"
        );
        assert_eq!(
            fund_project(999_999, IdeaToken::ICP, 100_000_000).await.unwrap_err(),
            "PROJECT_NOT_FOUND"
        );
        set_mock_ledger_balance(100);
        assert_eq!(
            fund_project(project_id, IdeaToken::ICP, 100_000_000).await.unwrap_err(),
            "INSUFFICIENT_DEPOSIT"
        );

        // Happy path: 100% to treasury, raised totals + count bump.
        set_mock_ledger_balance(10_000_000_000);
        fund_project(project_id, IdeaToken::ICP, 100_000_000).await.unwrap();
        let pr = PROJECTS.with(|m| m.borrow().get(&project_id)).unwrap();
        assert_eq!(pr.raised_icp_e8s, 100_000_000);
        assert_eq!(pr.funding_count, 1);

        // Failed transfer journals FailedPayout; sweep retry settles it.
        set_mock_ledger_transfer(Err("down".into()));
        assert!(fund_project(project_id, IdeaToken::CkBTC, 1_000_000).await.is_err());
        set_mock_ledger_transfer(Ok(10));
        retry_failed_fundings().await;
        let pr = PROJECTS.with(|m| m.borrow().get(&project_id)).unwrap();
        assert_eq!(pr.raised_ckbtc_e8s, 1_000_000);
        assert_eq!(pr.funding_count, 2);
        assert!(PROJECT_FUNDINGS.with(|m| {
            m.borrow().iter().all(|e| e.value().status == UpvoteStatus::Settled)
        }));

        // Orphan path: funding fails, project removed → funder refunded.
        set_mock_ledger_transfer(Err("down".into()));
        assert!(fund_project(project_id, IdeaToken::ICP, 100_000_000).await.is_err());
        PROJECTS.with(|m| { m.borrow_mut().remove(&project_id); });
        set_mock_ledger_transfer(Ok(11));
        retry_failed_fundings().await;
        assert!(PROJECT_FUNDINGS.with(|m| {
            m.borrow().iter().all(|e| e.value().status == UpvoteStatus::Settled)
        }));
    }

    #[tokio::test]
    async fn test_admin_update_project_and_crypto_toggles() {
        let admin = p("gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe");
        CONFIG.with(|c| {
            let mut cfg = c.borrow().get().clone();
            cfg.admins = vec![admin];
            c.borrow_mut().set(cfg);
        });
        set_mock_caller(admin);

        // 1. Add project with all tokens accepted
        let project_id = admin_add_project(
            "Project A".into(),
            "Desc A".into(),
            "Detail A".into(),
            100_000,
            200_000,
            300_000,
            true,
            true,
            true,
        ).unwrap();

        let pr = PROJECTS.with(|m| m.borrow().get(&project_id)).unwrap();
        assert_eq!(pr.title, "Project A");
        assert!(pr.accept_icp);
        assert!(pr.accept_ckbtc);
        assert!(pr.accept_cketh);

        // 2. Update goals and disable CkBTC/CkETH
        admin_update_project(
            project_id,
            "Project A Updated".into(),
            "Desc A".into(),
            "Detail A".into(),
            500_000,
            0,
            0,
            true,
            false,
            false,
        ).unwrap();

        let pr = PROJECTS.with(|m| m.borrow().get(&project_id)).unwrap();
        assert_eq!(pr.title, "Project A Updated");
        assert_eq!(pr.goal_icp_e8s, 500_000);
        assert!(pr.accept_icp);
        assert!(!pr.accept_ckbtc);
        assert!(!pr.accept_cketh);

        // 3. Verify funding validation
        let funder = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(funder);
        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Ok(12));

        // ICP is accepted
        assert!(fund_project(project_id, IdeaToken::ICP, 100_000_000).await.is_ok());

        // CkBTC is disabled/rejected
        assert_eq!(
            fund_project(project_id, IdeaToken::CkBTC, 1_000_000).await.unwrap_err(),
            "TOKEN_NOT_ACCEPTED"
        );
    }

    #[tokio::test]
    async fn test_upvote_idea_flow() {
        let poster = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let voter = p("ryjl3-tyaaa-aaaaa-aaaba-cai");

        set_mock_caller(poster);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let idea_id = post_idea("Upvotable".into(), "Desc".into(), "".into()).await.unwrap();

        set_mock_caller(voter);
        set_mock_ledger_transfer(Ok(42));

        // Insufficient deposit
        set_mock_ledger_balance(100);
        assert_eq!(
            upvote_idea(idea_id, IdeaToken::ICP, 100_000_000).await.unwrap_err(),
            "INSUFFICIENT_DEPOSIT"
        );

        // Below the value-aligned minimum (default 0.2 ICP)
        assert_eq!(
            upvote_idea(idea_id, IdeaToken::ICP, DEFAULT_MIN_UPVOTE_ICP_E8S - 1).await.unwrap_err(),
            "BELOW_MINIMUM"
        );

        // Unknown idea
        set_mock_ledger_balance(10_000_000_000);
        assert_eq!(
            upvote_idea(999_999, IdeaToken::ICP, 100_000_000).await.unwrap_err(),
            "IDEA_NOT_FOUND"
        );

        // Happy path
        upvote_idea(idea_id, IdeaToken::ICP, 100_000_000).await.unwrap();
        let idea = IDEAS.with(|m| m.borrow().get(&idea_id)).unwrap();
        assert_eq!(idea.upvote_count, 1);
        assert_eq!(idea.total_icp_e8s, 100_000_000);

        let settled = IDEA_UPVOTES.with(|m| {
            m.borrow().iter().map(|e| e.value())
                .find(|u| u.idea_id == idea_id && u.voter == voter)
        }).unwrap();
        assert_eq!(settled.status, UpvoteStatus::Settled);
        assert_eq!(settled.treasury_block, Some(42));
        assert_eq!(settled.poster_block, Some(42));

        // ckBTC totals tracked separately (min is 1_000 sats)
        upvote_idea(idea_id, IdeaToken::CkBTC, 1_000_000).await.unwrap();
        let idea = IDEAS.with(|m| m.borrow().get(&idea_id)).unwrap();
        assert_eq!(idea.total_ckbtc_e8s, 1_000_000);
        assert_eq!(idea.total_icp_e8s, 100_000_000);
        assert_eq!(idea.upvote_count, 2);
    }

    #[tokio::test]
    async fn test_record_idea_view() {
        let caller1 = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let caller2 = p("ryjl3-tyaaa-aaaaa-aaaba-cai");

        set_mock_caller(caller1);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let id = post_idea("Viewable".into(), "Desc".into(), "".into()).await.unwrap();

        // Caller 1 views -> view count = 1
        record_idea_view(id).unwrap();
        // Caller 1 views again -> view count still 1
        record_idea_view(id).unwrap();
        assert_eq!(IDEAS.with(|m| m.borrow().get(&id)).unwrap().views, 1);

        // Caller 2 views -> view count = 2
        set_mock_caller(caller2);
        record_idea_view(id).unwrap();
        assert_eq!(IDEAS.with(|m| m.borrow().get(&id)).unwrap().views, 2);

        assert_eq!(record_idea_view(999_999).unwrap_err(), "IDEA_NOT_FOUND");
        set_mock_caller(anon());
        assert!(record_idea_view(id).is_err());
    }

    #[tokio::test]
    async fn test_upvote_failed_payout_is_retried() {
        let poster = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let voter = p("ryjl3-tyaaa-aaaaa-aaaba-cai");

        set_mock_caller(poster);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let idea_id = post_idea("Retry me".into(), "Desc".into(), "".into()).await.unwrap();

        set_mock_caller(voter);
        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Err("ledger down".to_string()));

        assert!(upvote_idea(idea_id, IdeaToken::ICP, 100_000_000).await.is_err());

        // Journaled as FailedPayout, idea untouched.
        let uv = IDEA_UPVOTES.with(|m| {
            m.borrow().iter().map(|e| e.value())
                .find(|u| u.idea_id == idea_id)
        }).unwrap();
        assert_eq!(uv.status, UpvoteStatus::FailedPayout);
        assert!(uv.treasury_block.is_none());
        let idea = IDEAS.with(|m| m.borrow().get(&idea_id)).unwrap();
        assert_eq!(idea.upvote_count, 0);

        // Sweep retry settles it once the ledger recovers.
        set_mock_ledger_transfer(Ok(77));
        retry_failed_upvotes().await;

        let uv = IDEA_UPVOTES.with(|m| m.borrow().get(&uv.id)).unwrap();
        assert_eq!(uv.status, UpvoteStatus::Settled);
        assert_eq!(uv.treasury_block, Some(77));
        assert_eq!(uv.poster_block, Some(77));
        let idea = IDEAS.with(|m| m.borrow().get(&idea_id)).unwrap();
        assert_eq!(idea.upvote_count, 1);
        assert_eq!(idea.total_icp_e8s, 100_000_000);
    }

    #[tokio::test]
    async fn test_orphaned_upvote_refunds_voter() {
        let poster = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let voter = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(poster);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let idea_id = post_idea("Doomed idea".into(), "Desc".into(), "".into()).await.unwrap();

        // Upvote fails mid-saga, journaled as FailedPayout.
        set_mock_caller(voter);
        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Err("ledger down".to_string()));
        assert!(upvote_idea(idea_id, IdeaToken::ICP, 100_000_000).await.is_err());

        // The idea expires and is deleted before the retry succeeds.
        IDEAS.with(|m| { m.borrow_mut().remove(&idea_id); });

        // Retry refunds the voter's escrow and closes the journal entry.
        set_mock_ledger_transfer(Ok(88));
        retry_failed_upvotes().await;

        let uv = IDEA_UPVOTES.with(|m| {
            m.borrow().iter().map(|e| e.value())
                .find(|u| u.idea_id == idea_id && u.voter == voter)
        }).unwrap();
        assert_eq!(uv.status, UpvoteStatus::Settled);
        // No payout blocks: the funds went back to the voter, not the split.
        assert!(uv.treasury_block.is_none());
        assert!(uv.poster_block.is_none());
    }

    #[tokio::test]
    async fn test_expired_idea_rejected_then_deleted() {
        let poster = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(poster);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let idea_id = post_idea("Old idea".into(), "Desc".into(), "".into()).await.unwrap();

        // Age the idea past the 30-day window.
        IDEAS.with(|m| {
            let mut idea = m.borrow().get(&idea_id).unwrap();
            idea.last_upvote_at = current_time() - IDEA_EXPIRY_NANOS - 1;
            idea.created_at = idea.last_upvote_at;
            m.borrow_mut().insert(idea_id, idea);
        });

        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        assert_eq!(
            upvote_idea(idea_id, IdeaToken::ICP, 100_000_000).await.unwrap_err(),
            "IDEA_EXPIRED"
        );

        // list_ideas omits it even before the sweep...
        assert!(list_ideas().into_iter().all(|i| i.id != idea_id));
        // ...and the sweep DELETES it (expired = gone).
        delete_expired_ideas();
        assert!(IDEAS.with(|m| m.borrow().get(&idea_id)).is_none());
    }

    #[tokio::test]
    async fn test_admin_remove_idea() {
        let poster = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(poster);
        set_mock_ledger_balance(IDEA_POST_FEE_E8S + 10_000);
        set_mock_ledger_transfer(Ok(1));
        let idea_id = post_idea("Idea to remove".into(), "Desc".into(), "".into()).await.unwrap();
        assert!(IDEAS.with(|m| m.borrow().get(&idea_id)).is_some());

        // Remove the idea (guard isn't executed in unit tests, so we test core logic)
        assert!(admin_remove_idea(idea_id).is_ok());
        assert!(IDEAS.with(|m| m.borrow().get(&idea_id)).is_none());
        assert!(list_ideas().into_iter().all(|i| i.id != idea_id));

        // Removing non-existent idea -> Err
        assert_eq!(
            admin_remove_idea(999_999u64).unwrap_err(),
            "IDEA_NOT_FOUND"
        );
    }

    // ── Lossless Voting (pooled staking) ────────────────────────────────────────

    /// Local config with a non-mainnet ledger so the dev helpers work and the
    /// stake transfer takes the mock (MOCK_STAKE_SUBACCOUNT) path.
    fn install_staking_test_config() {
        let mut config = test_config(true);
        config.ledger_canister_id = p("a5dhi-k7777-77775-aaabq-cai");
        CONFIG.with(|cell| {
            cell.borrow_mut().set(config);
        });
    }

    #[test]
    fn test_staking_storable_roundtrips() {
        let pool = StakingPool {
            neuron_id: Some(42),
            nonce: 7,
            total_staked_e8s: 123,
            bootstrap: StakingBootstrap::Ready,
            pending_refresh_e8s: 5,
            pending_maturity: vec![MaturityDisbursement {
                amount_e8s: 1,
                initiated_at: 2,
                expected_at: 3,
            }],
            total_yield_e8s: 9,
        };
        let decoded = StakingPool::from_bytes(pool.to_bytes());
        assert_eq!(decoded.neuron_id, Some(42));
        assert_eq!(decoded.bootstrap, StakingBootstrap::Ready);
        assert_eq!(decoded.pending_maturity.len(), 1);

        let unstake = PendingUnstake {
            id: 1,
            user: p("2vxsx-fae"),
            tier: StakeTier::OneYear,
            amount_e8s: 100,
            split_neuron_id: 990_002,
            status: UnstakeStatus::Dissolving,
            created_at: 1,
            dissolve_eta: 2,
            disburse_block: None,
            fee_refund_block: None,
            merged_into: None,
            child_e8s: None,
            settled_at: None,
        };
        let decoded = PendingUnstake::from_bytes(unstake.to_bytes());
        assert_eq!(decoded.status, UnstakeStatus::Dissolving);
        assert_eq!(decoded.tier, StakeTier::OneYear);

        let vote = LosslessVote {
            proposal_id: 9,
            principal: p("2vxsx-fae"),
            stance: Stance::Reject,
            weight_e8s: 55,
            cast_at: 1,
        };
        let decoded = LosslessVote::from_bytes(vote.to_bytes());
        assert_eq!(decoded.weight_e8s, 55);

        let dist = YieldDistribution {
            id: 3,
            amount_e8s: 1_000_000,
            lottery_amount_e8s: 490_000,
            treasury_amount_e8s: 490_000,
            lottery_block: None,
            treasury_block: Some(11),
            status: YieldStatus::InProgress,
            created_at: 1,
            completed_at: None,
        };
        let decoded = YieldDistribution::from_bytes(dist.to_bytes());
        assert_eq!(decoded.treasury_block, Some(11));
        assert_eq!(decoded.status, YieldStatus::InProgress);
    }

    #[test]
    fn test_stake_tier_terms_and_multipliers() {
        assert_eq!(StakeTier::SixMonths.dissolve_delay_secs(), 15_778_800);
        assert_eq!(StakeTier::OneYear.dissolve_delay_secs(), 31_557_600);
        assert_eq!(StakeTier::TwoYears.dissolve_delay_secs(), 63_115_200);
        // Weight (and ticket) multipliers are proportional to the term.
        assert_eq!(StakeTier::SixMonths.weight_multiplier(), 1);
        assert_eq!(StakeTier::OneYear.weight_multiplier(), 2);
        assert_eq!(StakeTier::TwoYears.weight_multiplier(), 4);
    }

    #[test]
    fn test_neuron_staking_subaccount_deterministic() {
        let c = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let a = neuron_staking_subaccount(c, 7);
        let b = neuron_staking_subaccount(c, 7);
        let other_nonce = neuron_staking_subaccount(c, 8);
        let other_controller = neuron_staking_subaccount(p("2vxsx-fae"), 7);
        assert_eq!(a, b);
        assert_ne!(a, other_nonce);
        assert_ne!(a, other_controller);
        // 28-byte governance account-id hash, distinct from the 32-byte form.
        let h = account_id_hash28(c, &[0u8; 32]);
        assert_eq!(h.len(), 28);
        assert_eq!(&account_id_bytes(c, &[0u8; 32])[4..], &h[..]);
    }

    #[tokio::test]
    async fn test_stake_credits_share_and_bootstraps_neuron() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // First stake below 1 ICP is rejected even though min_stake is 0.1.
        assert_eq!(
            stake(50_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "BELOW_MINIMUM"
        );

        stake(200_000_000, StakeTier::SixMonths).await.unwrap();
        let pool = tier_pool(StakeTier::SixMonths);
        assert_eq!(pool.total_staked_e8s, 200_000_000);
        assert_eq!(pool.pending_refresh_e8s, 0, "claim ran inline");
        assert_eq!(pool.bootstrap, StakingBootstrap::Ready);
        let neuron_id = pool.neuron_id.expect("neuron created");
        assert!(neuron_id > MOCK_NEURON_ID_BASE);
        assert_eq!(
            MOCK_GOV.with(|g| g.borrow().neurons.get(&neuron_id).unwrap().stake_e8s),
            200_000_000
        );
        // The mock neuron's dissolve delay matches the tier's term.
        assert_eq!(
            MOCK_GOV.with(|g| g.borrow().neurons.get(&neuron_id).unwrap().delay_secs),
            StakeTier::SixMonths.dissolve_delay_secs()
        );
        // Bootstrap published the neuron on the (mock) NNS.
        assert!(
            MOCK_GOV.with(|g| g.borrow().neurons.get(&neuron_id).unwrap().public),
            "pool neurons are public the moment they're configured"
        );

        // Second stake from another user: min is now 0.1 ICP and tops up the
        // same tier neuron.
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(bob);
        assert_eq!(
            stake(5_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "BELOW_MINIMUM"
        );
        // Fractional stakes are rejected; top up with a whole ICP instead.
        assert_eq!(
            stake(10_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "WHOLE_ICP_ONLY"
        );
        stake(100_000_000, StakeTier::SixMonths).await.unwrap();
        let pool = tier_pool(StakeTier::SixMonths);
        assert_eq!(pool.total_staked_e8s, 300_000_000);
        assert_eq!(pool.neuron_id, Some(neuron_id), "one pooled neuron per tier");
        assert_eq!(
            MOCK_GOV.with(|g| g.borrow().neurons.get(&neuron_id).unwrap().stake_e8s),
            300_000_000
        );
        assert_eq!(
            STAKES.with(|m| m.borrow().get(&stake_key(StakeTier::SixMonths, alice)).unwrap().amount_e8s),
            200_000_000
        );
        assert_eq!(
            STAKES.with(|m| m.borrow().get(&stake_key(StakeTier::SixMonths, bob)).unwrap().amount_e8s),
            100_000_000
        );

        // A different tier gets its own neuron (first stake ≥ 1 ICP again).
        assert_eq!(
            stake(10_000_000, StakeTier::TwoYears).await.unwrap_err(),
            "BELOW_MINIMUM"
        );
        stake(100_000_000, StakeTier::TwoYears).await.unwrap();
        let pool_2y = tier_pool(StakeTier::TwoYears);
        let neuron_2y = pool_2y.neuron_id.expect("2y neuron created");
        assert_ne!(neuron_2y, neuron_id, "tiers never share a neuron");
        assert_eq!(
            MOCK_GOV.with(|g| g.borrow().neurons.get(&neuron_2y).unwrap().delay_secs),
            StakeTier::TwoYears.dissolve_delay_secs()
        );
        // 6-month pool untouched by the 2-year stake.
        assert_eq!(tier_pool(StakeTier::SixMonths).total_staked_e8s, 300_000_000);

        // Insufficient escrow is rejected before any state change.
        set_mock_ledger_balance(0);
        assert_eq!(
            stake(100_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "INSUFFICIENT_DEPOSIT"
        );
    }

    #[tokio::test]
    async fn test_stake_bootstrap_resumes_via_sweep() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(10_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // Make the claim fail: the share is still credited and the refresh
        // stays pending for the sweep.
        set_mock_manage_neuron(Some(Err("governance unavailable".to_string())));
        stake(200_000_000, StakeTier::OneYear).await.unwrap();
        let pool = tier_pool(StakeTier::OneYear);
        assert_eq!(pool.total_staked_e8s, 200_000_000);
        assert_eq!(pool.pending_refresh_e8s, 200_000_000);
        assert_eq!(pool.bootstrap, StakingBootstrap::NotStarted);
        assert!(pool.neuron_id.is_none());

        // Unstake is blocked until the pool is ready.
        assert_eq!(
            unstake(110_000_000, StakeTier::OneYear).await.unwrap_err(),
            "POOL_NOT_READY"
        );

        // Governance comes back: the sweep repairs claim + delay + follows.
        set_mock_manage_neuron(None);
        staking_sweep().await;
        let pool = tier_pool(StakeTier::OneYear);
        assert_eq!(pool.pending_refresh_e8s, 0);
        assert_eq!(pool.bootstrap, StakingBootstrap::Ready);
        assert!(pool.neuron_id.is_some());
    }

    #[tokio::test]
    async fn test_merge_unstake_back_into_tier() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(500_000_000, StakeTier::SixMonths).await.unwrap(); // 5 ICP
        stake(200_000_000, StakeTier::OneYear).await.unwrap(); // bootstrap 1y pool

        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();
        let pool_1y_before = tier_pool(StakeTier::OneYear).total_staked_e8s;

        // Validation gauntlet.
        assert_eq!(merge_unstake(999, StakeTier::OneYear).await.unwrap_err(), "UNSTAKE_NOT_FOUND");
        let bob = p("p2brp-aweqp-cxzia-sgqhq-poq4q-bxk6a-pyqz7-djize-23g7c-ejuz3-nqe");
        set_mock_caller(bob);
        assert_eq!(merge_unstake(id, StakeTier::OneYear).await.unwrap_err(), "NOT_YOUR_UNSTAKE");
        set_mock_caller(alice);
        assert_eq!(merge_unstake(id, StakeTier::TwoYears).await.unwrap_err(), "POOL_NOT_READY");

        // Happy path: merge the dissolving 6mo child into the 1-YEAR pool.
        merge_unstake(id, StakeTier::OneYear).await.unwrap();
        let pending = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pending.status, UnstakeStatus::Merged);
        assert_eq!(pending.merged_into, Some(StakeTier::OneYear));
        // Treasury fronts BOTH the split and merge fees — the full unstaked
        // amount restakes (whole-ICP invariant).
        let credited = 200_000_000;
        let key = stake_key(StakeTier::OneYear, alice);
        assert_eq!(
            STAKES.with(|m| m.borrow().get(&key)).unwrap().amount_e8s,
            200_000_000 + credited
        );
        assert_eq!(
            tier_pool(StakeTier::OneYear).total_staked_e8s,
            pool_1y_before + credited
        );
        // Mock governance agrees: child drained, 1y neuron grew.
        let child_stake = MOCK_GOV.with(|g| g.borrow().neurons.get(&pending.split_neuron_id).unwrap().stake_e8s);
        assert_eq!(child_stake, 0);

        // Terminal — a merged unstake can't merge (or disburse) again.
        assert_eq!(merge_unstake(id, StakeTier::OneYear).await.unwrap_err(), "NOT_MERGEABLE");
    }

    #[tokio::test]
    async fn test_merge_unstake_never_consumes_platform_neurons() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(500_000_000, StakeTier::SixMonths).await.unwrap();
        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();

        // Corrupt the record so the "child" IS the 6-month platform neuron —
        // the guard must refuse before any governance call.
        let main_id = tier_pool(StakeTier::SixMonths).neuron_id.unwrap();
        let mut pending = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        pending.split_neuron_id = main_id;
        PENDING_UNSTAKES.with(|m| { m.borrow_mut().insert(id, pending); });
        assert_eq!(
            merge_unstake(id, StakeTier::SixMonths).await.unwrap_err(),
            "SOURCE_IS_PLATFORM_NEURON"
        );
        // Platform neuron untouched in the mock.
        let main_stake = MOCK_GOV.with(|g| g.borrow().neurons.get(&main_id).unwrap().stake_e8s);
        assert!(main_stake > 0);
    }

    #[tokio::test]
    async fn test_unstake_validation_and_dissolve_flow() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(500_000_000, StakeTier::SixMonths).await.unwrap(); // 5 ICP

        // Validation gauntlet (tier must match the stake's tier, too).
        assert_eq!(
            unstake(600_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "EXCEEDS_STAKE"
        );
        assert_eq!(
            unstake(50_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "BELOW_MINIMUM"
        );
        // Fractional amounts are rejected outright.
        assert_eq!(
            unstake(420_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "WHOLE_ICP_ONLY"
        );
        // 5 − 5 = 0 remainder < 1 ICP pool floor.
        assert_eq!(
            unstake(500_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "POOL_FLOOR"
        );
        // No stake in a different tier.
        assert_eq!(
            unstake(200_000_000, StakeTier::TwoYears).await.unwrap_err(),
            "POOL_NOT_READY"
        );

        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();
        let pending = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pending.status, UnstakeStatus::Dissolving);
        assert_eq!(pending.amount_e8s, 200_000_000);
        assert_eq!(pending.tier, StakeTier::SixMonths);
        // The mock dissolve clock runs the tier's full 6-month term.
        let child_eta = MOCK_GOV.with(|g| {
            g.borrow().neurons.get(&pending.split_neuron_id).unwrap().dissolve_eta
        });
        assert_eq!(
            child_eta,
            current_time() + StakeTier::SixMonths.dissolve_delay_secs() * 1_000_000_000
        );
        assert_eq!(
            STAKES.with(|m| m.borrow().get(&stake_key(StakeTier::SixMonths, alice)).unwrap().amount_e8s),
            300_000_000
        );
        assert_eq!(tier_pool(StakeTier::SixMonths).total_staked_e8s, 300_000_000);
        // Treasury fronts the split fee — the child holds the FULL amount.
        assert_eq!(
            MOCK_GOV.with(|g| g
                .borrow()
                .neurons
                .get(&pending.split_neuron_id)
                .unwrap()
                .stake_e8s),
            200_000_000
        );
        assert_eq!(pending.child_e8s, Some(200_000_000));

        // Not dissolved yet → the sweep leaves it pending.
        staking_sweep().await;
        let pending = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pending.status, UnstakeStatus::Dissolving);
        assert!(pending.disburse_block.is_none());

        // Fast-forward the dissolve and sweep again → disbursed.
        dev_fast_forward_dissolve(id).unwrap();
        staking_sweep().await;
        let pending = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pending.status, UnstakeStatus::Disbursed);
        assert!(pending.disburse_block.is_some());
        assert!(pending.settled_at.is_some());
        // The mock split neuron is gone after disburse.
        assert!(MOCK_GOV.with(|g| !g.borrow().neurons.contains_key(&pending.split_neuron_id)));

        // Unstaking the full remainder is allowed only down to the pool floor.
        assert_eq!(
            unstake(300_000_000, StakeTier::SixMonths).await.unwrap_err(),
            "POOL_FLOOR"
        );
        assert!(unstake(200_000_000, StakeTier::SixMonths).await.is_ok());
    }

    #[tokio::test]
    async fn test_lossless_vote_weight_and_immutability() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let pid = 555_001u64;
        PROPOSALS.with(|m| {
            m.borrow_mut()
                .insert(pid, sample_proposal(pid, "open", 200_000_000, 0));
        });
        // sample_proposal pre-sets first_stance — clear it to test the
        // first-lossless-vote tie-break path.
        PROPOSALS.with(|m| {
            let mut prop = m.borrow().get(&pid).unwrap();
            prop.first_stance = None;
            m.borrow_mut().insert(pid, prop);
        });

        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // No stake → no vote.
        set_mock_caller(bob);
        assert_eq!(
            cast_lossless_vote(pid, Stance::Adopt).unwrap_err(),
            "NO_STAKE"
        );

        // Alice: 3 ICP in the 6-month tier → weight 3 ICP (1× multiplier).
        set_mock_caller(alice);
        stake(300_000_000, StakeTier::SixMonths).await.unwrap();
        cast_lossless_vote(pid, Stance::Reject).unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.lossless_reject_e8s, 30_000_000, "3 ICP staked ÷ 10");
        assert_eq!(prop.lossless_adopt_e8s, 0);
        assert_eq!(prop.first_stance, Some(Stance::Reject));
        // Burn pots untouched. Staked weight = 3 ICP ÷ 10 = 0.3 ICP, below
        // the 2 ICP threshold, so it stays open here.
        assert_eq!(prop.total_committed_e8s, 0);
        assert_eq!(prop.status, "open");

        // One immutable vote per user per proposal.
        assert_eq!(
            cast_lossless_vote(pid, Stance::Adopt).unwrap_err(),
            "ALREADY_VOTED"
        );

        // Weight was snapshotted: staking more does not retro-apply.
        stake(100_000_000, StakeTier::SixMonths).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.lossless_reject_e8s, 30_000_000);

        // Bob: 1 ICP in the 2-year tier → weight 0.1 ICP (1 ICP ÷ 10; the
        // term only scales lottery tickets, not voting power).
        set_mock_caller(bob);
        stake(100_000_000, StakeTier::TwoYears).await.unwrap();
        assert_eq!(user_voting_weight(bob), 10_000_000);
        cast_lossless_vote(pid, Stance::Adopt).unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.lossless_adopt_e8s, 10_000_000);

        // Combined-pot decision: lossless weight can flip the direction even
        // though the burn pots alone would say otherwise.
        let vote = decide_vote_choice(
            prop.adopt_pot_e8s.saturating_add(prop.lossless_adopt_e8s),
            prop.reject_pot_e8s.saturating_add(prop.lossless_reject_e8s),
            prop.first_stance.clone(),
        );
        assert_eq!(vote, 2, "30M reject (alice) vs 10M adopt (bob) → reject");
    }

    #[tokio::test]
    async fn test_lossless_vote_closed_proposals() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(200_000_000, StakeTier::SixMonths).await.unwrap();

        assert_eq!(
            cast_lossless_vote(404_404, Stance::Adopt).unwrap_err(),
            "PROPOSAL_NOT_FOUND"
        );

        let pid = 555_002u64;
        PROPOSALS.with(|m| {
            m.borrow_mut()
                .insert(pid, sample_proposal(pid, "voted", 1, 1));
        });
        assert_eq!(
            cast_lossless_vote(pid, Stance::Adopt).unwrap_err(),
            "VOTING_CLOSED"
        );

        // Within the 1-hour cutoff window → closed.
        let pid2 = 555_003u64;
        let mut near = sample_proposal(pid2, "open", 1, 0);
        near.deadline = current_time() + 1_000_000_000; // 1s from "now"
        PROPOSALS.with(|m| {
            m.borrow_mut().insert(pid2, near);
        });
        assert_eq!(
            cast_lossless_vote(pid2, Stance::Adopt).unwrap_err(),
            "VOTING_CLOSED"
        );
    }

    #[tokio::test]
    async fn test_yield_harvest_and_distribution_split() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(200_000_000, StakeTier::SixMonths).await.unwrap();
        stake(200_000_000, StakeTier::TwoYears).await.unwrap();

        // Below the threshold: nothing happens.
        dev_add_mock_maturity(50_000_000, StakeTier::SixMonths).unwrap();
        harvest_staking_maturity().await;
        assert!(tier_pool(StakeTier::SixMonths).pending_maturity.is_empty());

        // Cross the 1.05 ICP threshold on BOTH tiers: each neuron's maturity
        // is harvested into the same shared inbox.
        dev_add_mock_maturity(60_000_000, StakeTier::SixMonths).unwrap();
        dev_add_mock_maturity(110_000_000, StakeTier::TwoYears).unwrap();
        harvest_staking_maturity().await;
        let pool_6m = tier_pool(StakeTier::SixMonths);
        let pool_2y = tier_pool(StakeTier::TwoYears);
        assert_eq!(pool_6m.pending_maturity.len(), 1);
        assert_eq!(pool_6m.pending_maturity[0].amount_e8s, 110_000_000);
        assert_eq!(pool_6m.total_yield_e8s, 110_000_000);
        assert_eq!(pool_2y.pending_maturity.len(), 1);
        assert_eq!(pool_2y.total_yield_e8s, 110_000_000);

        // Distribute: 50% lottery pot / 50% treasury, single shared pot.
        set_mock_ledger_balance(220_000_000);
        distribute_yield_inbox().await;
        let dists = list_yield_distributions();
        assert_eq!(dists.len(), 1);
        let d = &dists[0];
        let spendable = 220_000_000 - 2 * ICP_FEE_E8S;
        assert_eq!(d.lottery_amount_e8s, spendable / 2);
        assert_eq!(d.treasury_amount_e8s, spendable - spendable / 2);
        assert_eq!(d.lottery_amount_e8s + d.treasury_amount_e8s, spendable);
        assert_eq!(d.status, YieldStatus::Done);

        assert!(
            tier_pool(StakeTier::SixMonths).pending_maturity.is_empty(),
            "retired after arrival"
        );
        assert!(tier_pool(StakeTier::TwoYears).pending_maturity.is_empty());
        // Pool info aggregates the lifetime yield across tiers.
        assert_eq!(get_staking_pool_info().total_yield_e8s, 220_000_000);
    }

    #[tokio::test]
    async fn test_yield_saga_idempotent_retry() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(10_000_000);
        set_mock_ledger_transfer(Err("ledger down".to_string()));

        // Open a distribution whose first transfer fails: journal persists
        // with no completed legs.
        distribute_yield_inbox().await;
        let d = YIELD_DISTRIBUTIONS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(d.status, YieldStatus::InProgress);
        assert!(d.lottery_block.is_none());

        // Pretend the lottery leg already completed in an earlier attempt;
        // with the ledger still down, only the treasury leg should be
        // attempted — and a retry must NOT re-run the completed transfer.
        let mut d = d;
        d.lottery_block = Some(77);
        YIELD_DISTRIBUTIONS.with(|m| {
            m.borrow_mut().insert(1, d);
        });
        distribute_yield_inbox().await; // resumes the in-progress journal
        let d = YIELD_DISTRIBUTIONS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(d.lottery_block, Some(77), "completed leg untouched");
        assert_eq!(d.status, YieldStatus::InProgress, "treasury leg still failing");

        // Ledger recovers: the retry finishes only the missing leg.
        set_mock_ledger_transfer(Ok(99));
        distribute_yield_inbox().await;
        let d = YIELD_DISTRIBUTIONS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(d.lottery_block, Some(77));
        assert_eq!(d.treasury_block, Some(99));
        assert_eq!(d.status, YieldStatus::Done);

        // No second distribution was opened while one was in progress.
        assert_eq!(list_yield_distributions().len(), 1);
    }

    #[test]
    fn test_admin_set_staking_config_validation() {
        install_staking_test_config();
        assert_eq!(
            admin_set_staking_config(Some(0), None, None).unwrap_err(),
            "INVALID_MIN_STAKE"
        );
        // Exactly 1 ICP is the new floor (treasury fronts the split fee).
        admin_set_staking_config(None, Some(ONE_ICP_E8S), None).unwrap();
        assert_eq!(
            admin_set_staking_config(None, Some(ONE_ICP_E8S - 1), None).unwrap_err(),
            "INVALID_MIN_UNSTAKE"
        );
        assert_eq!(
            admin_set_staking_config(None, None, Some(1)).unwrap_err(),
            "INVALID_MATURITY_THRESHOLD"
        );
        admin_set_staking_config(Some(20_000_000), None, None).unwrap();
        let config = CONFIG.with(|c| c.borrow().get().clone());
        assert_eq!(config.min_stake_e8s, 20_000_000);
    }

    // ── Lossless lottery ────────────────────────────────────────────────────

    fn enable_lottery() {
        FEATURE_FLAGS.with(|m| {
            m.borrow_mut().insert(FLAG_LOSSLESS_LOTTERY.to_string(), 1);
        });
    }

    /// Seed a stake record directly (lottery tests don't exercise the full
    /// stake flow — that's covered by the staking tests).
    fn seed_stake(tier: StakeTier, user: Principal, amount_e8s: u64) {
        STAKES.with(|m| {
            m.borrow_mut().insert(
                stake_key(tier, user),
                UserStake { amount_e8s, staked_at: 1, last_action_at: 1 },
            );
        });
    }

    #[test]
    fn test_next_draw_after_powerball_cadence() {
        // The mocked clock (1_700_000_000s) is Tuesday 2023-11-14 22:13 UTC —
        // a draw day, but past 03:00, so the next draw is Thursday 03:00.
        let now = 1_700_000_000_000_000_000u64;
        let thu = (19_677 * SECS_PER_DAY + 3 * 3600) * 1_000_000_000;
        assert_eq!(next_draw_after(now), thu);
        // From the Thursday draw instant itself, strictly next is Sunday.
        let sun = (19_680 * SECS_PER_DAY + 3 * 3600) * 1_000_000_000;
        assert_eq!(next_draw_after(thu), sun);
        // Early on a draw day (Tue 02:00) the same day's 03:00 draw is next.
        let tue_2am = (19_675 * SECS_PER_DAY + 2 * 3600) * 1_000_000_000;
        assert_eq!(next_draw_after(tue_2am), (19_675 * SECS_PER_DAY + 3 * 3600) * 1_000_000_000);
    }

    #[test]
    fn test_claim_daily_tickets_once_per_day_and_round_reset() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);

        // Flag is OFF by default — the lottery ships dark.
        assert_eq!(claim_daily_tickets().unwrap_err(), "FEATURE_DISABLED");
        enable_lottery();

        // Staking is the eligibility gate: no stake → no tickets.
        assert_eq!(claim_daily_tickets().unwrap_err(), "NOT_STAKED");

        // 6-month staker: base grant × 1 = 5/day.
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        assert_eq!(user_daily_tickets(alice), 5);
        assert_eq!(claim_daily_tickets().unwrap(), 5);
        let state = lottery_state();
        assert_eq!(state.total_tickets, 5);
        assert!(state.next_draw_at > 0, "first claim schedules the draw");
        assert_eq!(claim_daily_tickets().unwrap_err(), "ALREADY_CLAIMED_TODAY");

        // Bob holds 1y + 2y stakes: (2 + 4) × base = 30/day.
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(bob);
        seed_stake(StakeTier::OneYear, bob, 100_000_000);
        seed_stake(StakeTier::TwoYears, bob, 100_000_000);
        assert_eq!(user_daily_tickets(bob), 30);
        assert_eq!(claim_daily_tickets().unwrap(), 30);
        assert_eq!(lottery_state().total_tickets, 35);

        // Simulate a win: round restarts, old tickets die lazily.
        let mut state = lottery_state();
        state.round += 1;
        state.total_tickets = 0;
        set_lottery_state(state);

        // Same-day reclaim is still blocked (the daily grant was consumed).
        assert_eq!(claim_daily_tickets().unwrap_err(), "ALREADY_CLAIMED_TODAY");

        // Next day: the stale entry resets to the new round, count starts over.
        let today = 1_700_000_000 / SECS_PER_DAY;
        LOTTERY_TICKETS.with(|m| {
            let mut e = m.borrow().get(&bob).unwrap();
            e.last_claim_day = today - 1;
            m.borrow_mut().insert(bob, e);
        });
        assert_eq!(claim_daily_tickets().unwrap(), 30, "count reset, not 60");
        let e = LOTTERY_TICKETS.with(|m| m.borrow().get(&bob).unwrap());
        assert_eq!(e.round, 2);
        assert_eq!(lottery_state().total_tickets, 30);

        // Admin retunes the daily grant.
        assert_eq!(
            admin_set_lottery_config(Some(0)).unwrap_err(),
            "INVALID_TICKETS_PER_DAY"
        );
        admin_set_lottery_config(Some(25)).unwrap();
        assert_eq!(
            CONFIG.with(|c| c.borrow().get().lottery_tickets_per_day),
            25
        );
    }

    #[test]
    fn test_find_ticket_owner_round_scoped() {
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        LOTTERY_TICKETS.with(|m| {
            let mut m = m.borrow_mut();
            m.insert(alice, TicketEntry { round: 1, count: 5, last_claim_day: 0 });
            m.insert(bob, TicketEntry { round: 2, count: 3, last_claim_day: 0 });
        });
        // Round 2 only sees bob's 3 tickets, regardless of map order.
        assert_eq!(find_ticket_owner(2, 0), Some(bob));
        assert_eq!(find_ticket_owner(2, 2), Some(bob));
        assert_eq!(find_ticket_owner(2, 3), None);
        // Round 1 only sees alice's 5.
        assert_eq!(find_ticket_owner(1, 4), Some(alice));
        assert_eq!(find_ticket_owner(1, 5), None);
    }

    #[tokio::test]
    async fn test_lottery_draw_pays_winner_and_resets_round() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        claim_daily_tickets().unwrap();
        set_mock_ledger_balance(1_000_000_000); // 10 ICP pot
        set_mock_ledger_transfer(Ok(7));

        run_lottery_draw(Some(0)).await;

        let draw = LOTTERY_DRAWS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(draw.status, DrawStatus::Done);
        assert_eq!(draw.winner, Some(alice));
        assert_eq!(draw.prize_e8s, 800_000_000, "winner takes 80%");
        assert_eq!(draw.payout_block, Some(7));
        assert_eq!(draw.total_tickets, 5);

        let state = lottery_state();
        assert_eq!(state.round, 2, "round restarts after a win");
        assert_eq!(state.total_tickets, 0);
        assert_eq!(state.last_winner, Some(alice));
        assert_eq!(state.draws_held, 1);
        assert_eq!(state.total_paid_e8s, 800_000_000 - ICP_FEE_E8S);

        let payouts: Vec<Payout> =
            PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert_eq!(payouts.len(), 1);
        assert_eq!(payouts[0].user, alice);
        assert_eq!(payouts[0].payout_type, PayoutType::LotteryWin);
        assert_eq!(payouts[0].amount, 800_000_000 - ICP_FEE_E8S);
        // get_my_payouts is caller-scoped.
        assert_eq!(get_my_payouts().len(), 1);
        set_mock_caller(p("ryjl3-tyaaa-aaaaa-aaaba-cai"));
        assert_eq!(get_my_payouts().len(), 0);
    }

    #[tokio::test]
    async fn test_lottery_draw_no_winner_rolls_over() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        claim_daily_tickets().unwrap();
        set_mock_ledger_balance(1_000_000_000);
        set_mock_ledger_transfer(Ok(7));

        // Winning index way above the 5 issued tickets: nobody wins.
        run_lottery_draw(Some(999_999)).await;

        let draw = LOTTERY_DRAWS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(draw.status, DrawStatus::Done);
        assert_eq!(draw.winner, None);
        assert_eq!(draw.prize_e8s, 0);

        let state = lottery_state();
        assert_eq!(state.round, 1, "no win — round keeps going");
        assert_eq!(state.total_tickets, 5, "tickets carry to the next draw");
        assert_eq!(state.draws_held, 1);
        assert!(state.next_draw_at > 1_700_000_000_000_000_000);
        assert!(PAYOUTS.with(|m| m.borrow().is_empty()));
    }

    #[tokio::test]
    async fn test_lottery_payout_retry_is_idempotent() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        claim_daily_tickets().unwrap();
        set_mock_ledger_balance(1_000_000_000);
        set_mock_ledger_transfer(Err("LEDGER_DOWN".to_string()));

        run_lottery_draw(Some(0)).await;

        let draw = LOTTERY_DRAWS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(draw.status, DrawStatus::PayoutPending);
        assert_eq!(draw.payout_block, None);
        // The win itself is final even though the transfer failed.
        assert_eq!(lottery_state().round, 2);
        assert!(PAYOUTS.with(|m| m.borrow().is_empty()), "no payout recorded yet");

        // Ledger recovers; the next timer tick settles the pending payout.
        set_mock_ledger_transfer(Ok(9));
        lottery_draw_check().await;

        let draw = LOTTERY_DRAWS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(draw.status, DrawStatus::Done);
        assert_eq!(draw.payout_block, Some(9));
        let payouts: Vec<Payout> =
            PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert_eq!(payouts.len(), 1, "paid exactly once");
        assert_eq!(lottery_state().total_paid_e8s, 800_000_000 - ICP_FEE_E8S);

        // A second tick finds nothing pending and doesn't double-pay.
        lottery_draw_check().await;
        assert_eq!(
            PAYOUTS.with(|m| m.borrow().len()),
            1
        );
    }

    // ════════════════════════════════════════════════════════════════════
    // Value-transfer exhaustive coverage (review hardening, 2026-06-10):
    // the full burn/commit lifecycle, settlement splits, refunds, retries,
    // pool rewards/registration, admin endpoints and dev guards — all against
    // the mocked ledger so every branch that moves ICP is exercised natively.
    // ════════════════════════════════════════════════════════════════════

    fn follow_as(user: Principal) {
        set_mock_caller(user);
        confirm_follow().unwrap();
    }

    fn open_proposal(pid: u64, threshold: u64) {
        PROPOSALS.with(|m| {
            m.borrow_mut().insert(pid, sample_proposal(pid, "open", threshold, 0));
        });
        // sample_proposal pre-fills pots/first_stance; zero them for a clean slate.
        PROPOSALS.with(|m| {
            let mut p = m.borrow().get(&pid).unwrap();
            p.adopt_pot_e8s = 0;
            p.first_stance = None;
            m.borrow_mut().insert(pid, p);
        });
    }

    #[tokio::test]
    async fn test_commit_validation_gauntlet() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let pid = 700_001u64;
        open_proposal(pid, 300_000_000);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // Must hold a registered, following neuron first.
        set_mock_caller(alice);
        assert_eq!(commit(pid, Stance::Adopt, 200_000_000).await.unwrap_err(), "NEURON_NOT_REGISTERED");
        USER_NEURONS.with(|m| {
            m.borrow_mut().insert(alice, UserNeuronState {
                neuron_id: 7, is_following: false, verified_at: 1, cached_stake_e8s: 0,
            });
        });
        assert_eq!(commit(pid, Stance::Adopt, 200_000_000).await.unwrap_err(), "NOT_FOLLOWING");
        follow_as(alice);

        // Amount bounds.
        assert_eq!(commit(pid, Stance::Adopt, MIN_COMMIT_E8S - 1).await.unwrap_err(), "BELOW_MINIMUM");
        assert_eq!(commit(pid, Stance::Adopt, MAX_COMMIT_E8S + 1).await.unwrap_err(), "EXCEEDS_GLOBAL_CAP");

        // Proposal must exist and be open.
        assert_eq!(commit(999_999, Stance::Adopt, 200_000_000).await.unwrap_err(), "PROPOSAL_NOT_FOUND");
        PROPOSALS.with(|m| {
            m.borrow_mut().insert(700_002, sample_proposal(700_002, "voted", 1, 1));
        });
        assert_eq!(commit(700_002, Stance::Adopt, 200_000_000).await.unwrap_err(), "COMMITMENT_CLOSED");

        // Escrow must hold amount + 540_000 (protocol fee + 4 ledger fees).
        set_mock_ledger_balance(200_000_000);
        assert_eq!(commit(pid, Stance::Adopt, 200_000_000).await.unwrap_err(), "INSUFFICIENT_DEPOSIT");
        set_mock_ledger_balance(200_540_000);

        // Success: fee charged, pot credited, commitment journaled.
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.adopt_pot_e8s, 200_000_000);
        assert_eq!(prop.total_committed_e8s, 200_000_000);
        assert_eq!(prop.first_stance, Some(Stance::Adopt));
        assert_eq!(prop.status, "open", "below threshold stays open");
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::Pending);
        assert_eq!(c.amount_e8s, 200_000_000);
        let agg = USER_AGGREGATES.with(|m| m.borrow().get(&alice)).unwrap();
        assert_eq!(agg.total_committed_escrow, 200_000_000);
        assert_eq!(agg.proposals_joined, 1);

        // One commitment per user per proposal.
        assert_eq!(commit(pid, Stance::Reject, 200_000_000).await.unwrap_err(), "ALREADY_COMMITTED");

        // A second user crossing the threshold flips the proposal to met.
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        follow_as(bob);
        commit(pid, Stance::Reject, 150_000_000).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "met");
        assert_eq!(prop.reject_pot_e8s, 150_000_000);
        assert_eq!(prop.first_stance, Some(Stance::Adopt), "first stance is sticky");
    }

    #[tokio::test]
    async fn test_commit_deadline_cutoff_window() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        let pid = 700_010u64;
        let mut near = sample_proposal(pid, "open", 1_000_000_000, 0);
        near.deadline = current_time() + 1_000; // deep inside the 1h cutoff
        PROPOSALS.with(|m| { m.borrow_mut().insert(pid, near); });
        assert_eq!(commit(pid, Stance::Adopt, 200_000_000).await.unwrap_err(), "COMMITMENT_CLOSED");
    }

    #[tokio::test]
    async fn test_add_to_commitment_flow() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        let pid = 700_020u64;
        open_proposal(pid, 500_000_000);

        assert_eq!(add_to_commitment(pid, 100_000_000).await.unwrap_err(), "NO_EXISTING_COMMITMENT");
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();

        assert_eq!(add_to_commitment(pid, MIN_COMMIT_E8S - 1).await.unwrap_err(), "BELOW_MINIMUM");

        // Escrow must cover the NEW total + the 30k settlement reserve.
        set_mock_ledger_balance(250_000_000);
        assert_eq!(add_to_commitment(pid, 100_000_000).await.unwrap_err(), "INSUFFICIENT_DEPOSIT");
        set_mock_ledger_balance(300_030_000);
        add_to_commitment(pid, 100_000_000).await.unwrap();

        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.amount_e8s, 300_000_000);
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.adopt_pot_e8s, 300_000_000);
        assert_eq!(prop.total_committed_e8s, 300_000_000);
        assert_eq!(prop.status, "open");

        // Top up across the threshold: flips to met.
        set_mock_ledger_balance(100_000_000_000);
        add_to_commitment(pid, 200_000_000).await.unwrap();
        assert_eq!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().status, "met");
    }

    #[tokio::test]
    async fn test_cutoff_voted_burns_and_splits() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(11));
        let pid = 700_030u64;
        open_proposal(pid, 200_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap(); // meets threshold

        process_proposal_cutoff(pid).await.unwrap();

        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "settled");
        assert_eq!(prop.total_burned_e8s, Some(200_000_000));
        assert!(prop.vote_executed_at.is_some());
        assert!(prop.pool_distributed, "reward distribution ran (no members → no-op)");

        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::Burned);
        assert!(c.treasury_block.is_some() && c.cmc_block_index.is_some() && c.frontend_cmc_block.is_some());

        // The vote record reflects the adopt majority.
        let vote = VOTES.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(vote.vote, Vote::Yes);
        assert_eq!(vote.icp_burned_e8s, 200_000_000);

        // Aggregates moved from escrow to burned.
        let agg = USER_AGGREGATES.with(|m| m.borrow().get(&alice)).unwrap();
        assert_eq!(agg.total_committed_escrow, 0);
        assert_eq!(agg.total_burned, 200_000_000);
    }

    #[tokio::test]
    async fn test_cutoff_unmet_refunds_commitments() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(3));
        let pid = 700_040u64;
        open_proposal(pid, 10_000_000_000); // unreachable threshold
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();

        process_proposal_cutoff(pid).await.unwrap();

        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "abstained");
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::Returned, "threshold unmet → money back");
        // Refund lands in the payout history.
        let payouts: Vec<Payout> = PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert!(payouts.iter().any(|po| po.user == alice
            && po.payout_type == PayoutType::CommitmentRefund
            && po.amount == 200_000_000));
    }

    #[tokio::test]
    async fn test_cutoff_vote_failure_never_burns() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        let pid = 700_050u64;
        open_proposal(pid, 200_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();

        // F-102: the NNS rejects the vote → commitments MUST be refunded,
        // never burned, no matter that the threshold was met.
        set_mock_nns_vote(Err("governance rejected".to_string()));
        process_proposal_cutoff(pid).await.unwrap();

        // The transient "failed" status is finalized to "abstained" once the
        // refunds settle — the key invariant is NO vote record and NO burn.
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "abstained");
        assert!(VOTES.with(|m| m.borrow().get(&pid)).is_none(), "no vote record");
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::Returned);
    }

    #[tokio::test]
    async fn test_failed_burn_settlement_is_retried_idempotently() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        let pid = 700_060u64;
        open_proposal(pid, 200_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();

        // Ledger dies before settlement: the commitment parks as FailedBurn.
        set_mock_ledger_transfer(Err("ledger down".to_string()));
        process_proposal_cutoff(pid).await.unwrap();
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::FailedBurn);
        assert!(c.treasury_block.is_none());

        // Simulate a partially-completed earlier attempt: treasury leg done.
        let mut c2 = c.clone();
        c2.treasury_block = Some(70);
        COMMITMENTS.with(|m| { m.borrow_mut().insert(key.clone(), c2); });

        // Ledger recovers: the retry completes ONLY the missing legs.
        set_mock_ledger_transfer(Ok(71));
        retry_failed_settlements().await;
        let c = COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap();
        assert_eq!(c.status, CommitmentStatus::Burned);
        assert_eq!(c.treasury_block, Some(70), "completed leg never re-runs");
        assert_eq!(c.cmc_block_index, Some(71));
        assert_eq!(c.frontend_cmc_block, Some(71));
    }

    #[tokio::test]
    async fn test_failed_refund_is_retried() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        let pid = 700_070u64;
        open_proposal(pid, 10_000_000_000);
        commit(pid, Stance::Reject, 200_000_000).await.unwrap();

        set_mock_ledger_transfer(Err("ledger down".to_string()));
        process_proposal_cutoff(pid).await.unwrap();
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        assert_eq!(
            COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap().status,
            CommitmentStatus::FailedRefund
        );

        set_mock_ledger_transfer(Ok(5));
        retry_failed_settlements().await;
        assert_eq!(
            COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap().status,
            CommitmentStatus::Returned
        );
    }

    #[tokio::test]
    async fn test_distribute_pool_rewards_pays_top_members_once() {
        install_staking_test_config();
        let m1 = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let m2 = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let pid = 700_080u64;
        let mut prop = sample_proposal(pid, "settled", 1, 0);
        prop.total_burned_e8s = Some(400_000_000); // pool share = 100M
        prop.pool_distributed = false;
        PROPOSALS.with(|m| { m.borrow_mut().insert(pid, prop); });

        for (i, owner) in [(1u64, m1), (2u64, m2)] {
            POOL_NEURONS.with(|m| {
                m.borrow_mut().insert(i, PoolNeuron {
                    neuron_id: i,
                    registered_by: owner,
                    voting_power: 1_000 * i,
                    status: PoolStatus::Active,
                    created_at: 1,
                    activated_at: Some(1),
                    treasury_block: None,
                    backend_cmc_block: None,
                    frontend_cmc_block: None,
                });
            });
        }
        set_mock_ledger_transfer(Ok(8));

        distribute_pool_rewards(pid).await.unwrap();
        assert!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().pool_distributed);
        // 100M / 2 members − ledger fee each, recorded as PoolReward payouts.
        let payouts: Vec<Payout> = PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        let rewards: Vec<&Payout> = payouts.iter().filter(|po| po.payout_type == PayoutType::PoolReward).collect();
        assert_eq!(rewards.len(), 2);
        assert!(rewards.iter().all(|po| po.amount == 50_000_000 - 10_000));

        // Second call is a no-op (idempotent guard).
        distribute_pool_rewards(pid).await.unwrap();
        let count = PAYOUTS.with(|m| m.borrow().iter()
            .filter(|e| e.value().payout_type == PayoutType::PoolReward).count());
        assert_eq!(count, 2, "never double-pays");
    }

    #[tokio::test]
    async fn test_pool_draft_finalize_cancel_refund() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        create_pool_draft(8_000_001).await.unwrap();
        // First-come binding: someone else cannot claim the same neuron id.
        set_mock_caller(bob);
        assert_eq!(create_pool_draft(8_000_001).await.unwrap_err(), "ALREADY_REGISTERED");

        // Owner finalizes: fee split executes, neuron activates.
        set_mock_caller(alice);
        finalize_pool_registration(8_000_001).await.unwrap();
        let pn = POOL_NEURONS.with(|m| m.borrow().get(&8_000_001)).unwrap();
        assert_eq!(pn.status, PoolStatus::Active);
        assert!(pn.treasury_block.is_some());

        // Cancel only works on drafts.
        assert!(cancel_pool_draft(8_000_001).is_err());
        create_pool_draft(8_000_002).await.unwrap();
        cancel_pool_draft(8_000_002).unwrap();
        assert!(POOL_NEURONS.with(|m| m.borrow().get(&8_000_002)).is_none());

        // Registration escrow refund: balance above one fee comes back.
        refund_registration().await.unwrap();
        set_mock_ledger_balance(5_000);
        assert_eq!(refund_registration().await.unwrap_err(), "NOTHING_TO_REFUND");
    }

    #[test]
    fn test_admin_endpoint_validation() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");

        // add/remove admin.
        assert!(add_admin(Principal::anonymous()).is_err());
        add_admin(alice).unwrap();
        assert!(CONFIG.with(|c| c.borrow().get().admins.contains(&alice)));
        add_admin(alice).unwrap(); // idempotent
        assert_eq!(CONFIG.with(|c| c.borrow().get().admins.len()), 1);
        assert_eq!(remove_admin(alice).unwrap_err(), "Cannot remove the last admin");

        // Deadline: must clear the 1h cutoff window.
        let pid = 700_090u64;
        PROPOSALS.with(|m| { m.borrow_mut().insert(pid, sample_proposal(pid, "open", 1, 0)); });
        assert_eq!(admin_set_proposal_deadline(pid, 0).unwrap_err(), "INVALID_DEADLINE");
        assert_eq!(
            admin_set_proposal_deadline(pid, current_time()).unwrap_err(),
            "DEADLINE_BELOW_CUTOFF"
        );
        let good = current_time() + 2 * CUTOFF_NANOS;
        admin_set_proposal_deadline(pid, good).unwrap();
        assert_eq!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().deadline, good);
        assert!(admin_set_proposal_deadline(999_999_999, good).is_err());

        // Threshold: bounds + live open/met recompute.
        assert_eq!(admin_set_default_threshold(1).unwrap_err(), "THRESHOLD_BELOW_MIN_COMMIT");
        assert_eq!(
            admin_set_default_threshold(MAX_COMMIT_E8S + 1).unwrap_err(),
            "THRESHOLD_ABOVE_MAX"
        );
        let pid2 = 700_091u64;
        PROPOSALS.with(|m| {
            m.borrow_mut().insert(pid2, sample_proposal(pid2, "open", 500_000_000, 300_000_000));
        });
        admin_set_default_threshold(250_000_000).unwrap();
        let p2 = PROPOSALS.with(|m| m.borrow().get(&pid2)).unwrap();
        assert_eq!(p2.threshold_e8s, 250_000_000);
        assert_eq!(p2.status, "met", "lowering the bar flips it to met");

        // Frontend canister + pool fee.
        assert!(admin_set_frontend_canister(Principal::anonymous()).is_err());
        admin_set_frontend_canister(alice).unwrap();
        assert_eq!(CONFIG.with(|c| c.borrow().get().frontend_canister_id), Some(alice));
        assert!(admin_set_pool_fee(0).is_err());
        admin_set_pool_fee(42).unwrap();
        assert_eq!(CONFIG.with(|c| c.borrow().get().pool_initiation_fee_e8s), 42);
    }

    #[tokio::test]
    async fn test_admin_withdraw_treasury_and_lottery_admin() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_ledger_transfer(Ok(2));
        admin_withdraw_treasury(alice, 1_000_000).await.unwrap();
        set_mock_ledger_transfer(Err("ledger down".to_string()));
        assert!(admin_withdraw_treasury(alice, 1_000_000).await.is_err());

        // Lottery base grant bounds.
        assert_eq!(admin_set_lottery_config(Some(10_001)).unwrap_err(), "INVALID_TICKETS_PER_DAY");
        admin_set_lottery_config(None).unwrap(); // no-op accepted
    }

    #[tokio::test]
    async fn test_dev_endpoint_guards_block_mainnet_shape() {
        // Mainnet-shaped config: is_local = false AND canonical ICP ledger.
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(false)); });
        set_mock_caller(p("rrkah-fqaaa-aaaaa-aaaaq-cai"));
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        assert!(dev_faucet().await.is_err());
        assert!(dev_faucet_token(IdeaToken::ICP).await.is_err());
        assert!(dev_seed_pool_neuron(1, 1).is_err());
        assert_eq!(dev_run_staking_sweep().await.unwrap_err(), "DEV_ONLY");
        assert_eq!(dev_fast_forward_dissolve(1).unwrap_err(), "DEV_ONLY");
        assert_eq!(dev_add_mock_maturity(1, StakeTier::SixMonths).unwrap_err(), "DEV_ONLY");
        FEATURE_FLAGS.with(|m| { m.borrow_mut().insert(FLAG_LOSSLESS_LOTTERY.to_string(), 1); });
        assert_eq!(dev_run_lottery_draw(false).await.unwrap_err(), "DEV_ONLY");

        // is_local=true but the ledger is still the canonical mainnet one
        // (mis-wired config) — faucets must STILL refuse.
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(true)); });
        assert!(dev_faucet().await.is_err());
        assert!(dev_seed_pool_neuron(1, 1).is_err());

        // Properly local (test ledger): faucet works.
        install_staking_test_config();
        dev_faucet().await.unwrap();
        dev_seed_pool_neuron(9_000_001, 77).unwrap();
        assert!(POOL_NEURONS.with(|m| m.borrow().get(&9_000_001)).is_some());
    }

    #[tokio::test]
    async fn test_get_lottery_info_states() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(500_000_000);

        // Flag off: dark — no pot reads, nothing enabled.
        let info = get_lottery_info().await;
        assert!(!info.enabled);
        assert_eq!(info.pot_e8s, 0);
        assert!(!info.eligible);

        // Flag on, not staked: eligible=false, grant 0.
        enable_lottery();
        let info = get_lottery_info().await;
        assert!(info.enabled);
        assert_eq!(info.pot_e8s, 500_000_000);
        assert!(!info.eligible);
        assert_eq!(info.my_daily_tickets, 0);

        // Stake-weighted: 1 ICP 6mo (base×1×1) + 1 ICP 2y (base×4×1) = 25/day.
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        seed_stake(StakeTier::TwoYears, alice, 100_000_000);
        let info = get_lottery_info().await;
        assert!(info.eligible);
        assert_eq!(info.my_daily_tickets, 25);
        // Bigger stake → proportionally more tickets (500 ICP 2y = base×4×500).
        seed_stake(StakeTier::TwoYears, alice, 50_000_000_000);
        let info = get_lottery_info().await;
        assert_eq!(info.my_daily_tickets, 5 + 5 * 4 * 500);
        // Dynamic odds: the denominator is total_tickets × 13 (min 13).
        assert_eq!(lottery_odds_denominator(0), 13);
        assert_eq!(lottery_odds_denominator(1), 13);
        assert_eq!(lottery_odds_denominator(10_000), 130_000);
    }

    #[test]
    fn test_eligibility_tiers_and_queries() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");

        set_mock_caller(Principal::anonymous());
        assert_eq!(get_eligibility().tier, 0);

        set_mock_caller(alice);
        assert_eq!(get_eligibility().tier, 1, "signed in, not following");
        confirm_follow().unwrap();
        assert_eq!(get_eligibility().tier, 2, "following, no commits");
        USER_AGGREGATES.with(|m| {
            m.borrow_mut().insert(alice, UserAggregates {
                total_committed_escrow: 5, total_burned: 0, proposals_joined: 1,
            });
        });
        let e = get_eligibility();
        assert_eq!(e.tier, 3);
        assert!(e.following && e.has_committed && e.authenticated);

        // Deposit address helpers shape-check.
        let acc = get_deposit_address(1);
        assert_eq!(acc.owner, get_canister_id());
        assert!(acc.subaccount.is_some());
        let reg = get_registration_address();
        assert_ne!(reg.subaccount, acc.subaccount);
        let stake_acc = get_stake_deposit_address();
        assert_ne!(stake_acc.subaccount, reg.subaccount);
    }

    #[test]
    fn test_global_stats_and_audit_log_paging() {
        install_staking_test_config();
        PROPOSALS.with(|m| {
            m.borrow_mut().insert(1, sample_proposal(1, "open", 10, 7));
            m.borrow_mut().insert(2, sample_proposal(2, "met", 10, 12));
            m.borrow_mut().insert(3, sample_proposal(3, "settled", 10, 12));
        });
        VOTES.with(|m| {
            m.borrow_mut().insert(3, VoteRecord {
                proposal_id: 3, vote: Vote::Yes, icp_burned_e8s: 12,
                decided_at: 1, nns_outcome: None,
            });
        });
        let stats = get_global_stats();
        assert_eq!(stats.tvl_e8s, 19, "open + met escrow only");
        assert_eq!(stats.total_burned_e8s, 12);
        assert_eq!(stats.votes_cast, 1);

        for i in 0..5u64 {
            staking_audit("unit_test", p("2vxsx-fae"), i, i);
        }
        let page = get_audit_log(0, 2);
        assert_eq!(page.len(), 2);
        let rest = get_audit_log(2, 1_000_000);
        assert!(rest.len() >= 3, "limit is capped, not rejected");
        assert!(get_audit_log(1_000_000_000, 10).is_empty());

        // list_active filters terminal statuses.
        assert_eq!(list_active_proposals().len(), 2);
        assert!(list_all_proposals().len() >= 3);
        assert!(get_proposal(3).is_some());
        assert!(get_proposal(404_404_404).is_none());
    }

    #[tokio::test]
    async fn test_unstake_disbursement_records_payout() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(500_000_000, StakeTier::SixMonths).await.unwrap();
        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();
        dev_fast_forward_dissolve(id).unwrap();
        staking_sweep().await;
        let payouts: Vec<Payout> = PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert!(payouts.iter().any(|po| po.user == alice
            && po.payout_type == PayoutType::UnstakeDisbursement
            && po.amount == 200_000_000));
    }

    #[test]
    fn test_get_full_neuron_wire_compat() {
        // Regression for the prod maturity-sweep failure: governance's Neuron
        // record no longer has `voting_power` (only `deciding_voting_power :
        // opt nat64`). A wire-shaped Neuron WITHOUT voting_power must decode,
        // and the helper must read the modern field.
        #[derive(CandidType)]
        struct WireNeuron {
            id: Option<NeuronId>,
            controller: Option<Principal>,
            hot_keys: Vec<Principal>,
            cached_neuron_stake_e8s: u64,
            maturity_e8s_equivalent: u64,
            deciding_voting_power: Option<u64>,
            followees: Vec<(i32, Followees)>,
        }
        let bytes = candid::encode_one(WireNeuron {
            id: Some(NeuronId { id: 42 }),
            controller: Some(Principal::anonymous()),
            hot_keys: vec![],
            cached_neuron_stake_e8s: 100_000_000,
            maturity_e8s_equivalent: 5,
            deciding_voting_power: Some(123_456),
            followees: vec![],
        })
        .unwrap();
        let neuron: Neuron = candid::decode_one(&bytes)
            .expect("Neuron without legacy voting_power must decode");
        assert_eq!(neuron_voting_power(&neuron), 123_456);

        // Local mock still uses the legacy field — the helper falls back.
        let legacy = Neuron {
            id: Some(NeuronId { id: 1 }),
            controller: None,
            hot_keys: vec![],
            cached_neuron_stake_e8s: 0,
            maturity_e8s_equivalent: 0,
            voting_power: Some(777),
            deciding_voting_power: None,
            followees: vec![],
        };
        assert_eq!(neuron_voting_power(&legacy), 777);
    }

    #[test]
    fn test_cmc_notify_wire_compat() {
        // Regression for the mainnet trap on proposal 142135: our args must
        // decode as the CMC's exact arg type (block_index : nat64). Encoding
        // `nat` there is rejected by the CMC's decoder ("Subtyping error:
        // TypeInner::Nat64").
        #[derive(CandidType, Deserialize)]
        struct WireArg {
            block_index: u64,
            canister_id: Principal,
        }
        let bytes = candid::encode_one(NotifyTopUpArgs {
            canister_id: Principal::anonymous(),
            block_index: 7,
        })
        .unwrap();
        let wire: WireArg = candid::decode_one(&bytes).unwrap();
        assert_eq!(wire.block_index, 7);

        // Every response variant the real CMC can produce (cmc.did) must
        // decode into our NotifyTopUpResult — the old enum couldn't decode
        // Processing / InvalidTransaction / TransactionTooOld(nat64) /
        // Refunded.block_index at all.
        #[derive(CandidType)]
        enum WireErr {
            Refunded { block_index: Option<u64>, reason: String },
            Processing,
            TransactionTooOld(u64),
            InvalidTransaction(String),
            Other { error_code: u64, error_message: String },
        }
        #[derive(CandidType)]
        enum WireRes {
            Ok(candid::Nat),
            Err(WireErr),
        }
        let wire_responses = [
            WireRes::Ok(candid::Nat::from(5_000_000u64)),
            WireRes::Err(WireErr::Refunded { block_index: Some(9), reason: "bad memo".into() }),
            WireRes::Err(WireErr::Processing),
            WireRes::Err(WireErr::TransactionTooOld(3)),
            WireRes::Err(WireErr::InvalidTransaction("x".into())),
            WireRes::Err(WireErr::Other { error_code: 1, error_message: "y".into() }),
        ];
        for wire in wire_responses {
            let bytes = candid::encode_one(wire).unwrap();
            let decoded: NotifyTopUpResult = candid::decode_one(&bytes)
                .expect("real CMC response variant must decode");
            drop(decoded);
        }

        // "TPUP" little-endian — the memo the CMC requires on the transfer.
        assert_eq!(MEMO_TOP_UP, 1_347_768_404);
    }

    #[test]
    fn test_notify_top_up_endpoint_and_flags() {
        install_staking_test_config();
        let res = notify_top_up(NotifyTopUpArgs {
            canister_id: get_canister_id(),
            block_index: 1,
        });
        assert!(matches!(res, NotifyTopUpResult::Ok(_)), "local always acks");
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(false)); });
        let res = notify_top_up(NotifyTopUpArgs {
            canister_id: get_canister_id(),
            block_index: 1,
        });
        assert!(matches!(res, NotifyTopUpResult::Err(NotifyError::InvalidTransaction(_))));

        // Flag-key validation.
        assert_eq!(admin_set_feature_flag("BAD KEY".to_string(), true).unwrap_err(), "INVALID_FLAG_KEY");
        assert_eq!(admin_set_feature_flag("".to_string(), true).unwrap_err(), "INVALID_FLAG_KEY");
        admin_set_feature_flag("future_feature".to_string(), true).unwrap();
        assert!(feature_enabled("future_feature"));
    }


    #[test]
    fn test_seed_mocks_populate_once() {
        install_staking_test_config();
        assert!(PROPOSALS.with(|m| m.borrow().is_empty()));
        seed_mock_proposals();
        let n = PROPOSALS.with(|m| m.borrow().len());
        assert!(n > 0, "local dev gets mock proposals");
        seed_mock_proposals();
        assert_eq!(PROPOSALS.with(|m| m.borrow().len()), n, "seeding is idempotent");

        seed_mock_ideas();
        let i = IDEAS.with(|m| m.borrow().len());
        assert!(i > 0);
        seed_mock_ideas();
        assert_eq!(IDEAS.with(|m| m.borrow().len()), i);
    }

    #[tokio::test]
    async fn test_proposal_sync_sweep_processes_due_proposals() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // A met proposal whose deadline is inside the cutoff window.
        let pid = 710_001u64;
        open_proposal(pid, 100_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();
        PROPOSALS.with(|m| {
            let mut prop = m.borrow().get(&pid).unwrap();
            prop.deadline = current_time() + 1_000;
            m.borrow_mut().insert(pid, prop);
        });

        // A settled proposal with rewards still undistributed.
        let pid2 = 710_002u64;
        let mut settled = sample_proposal(pid2, "settled", 1, 0);
        settled.total_burned_e8s = Some(0);
        settled.pool_distributed = false;
        PROPOSALS.with(|m| { m.borrow_mut().insert(pid2, settled); });

        proposal_sync_sweep().await;

        assert_eq!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().status, "settled");
        assert!(PROPOSALS.with(|m| m.borrow().get(&pid2)).unwrap().pool_distributed);
    }

    #[tokio::test]
    async fn test_cycle_topup_two_phase() {
        install_staking_test_config();

        // Healthy cycles: nothing moves.
        set_mock_cycles(10_000_000_000_000);
        set_mock_ledger_balance(50_000_000_000);
        set_mock_ledger_transfer(Err("must not be called".to_string()));
        cycle_topup_check().await;
        assert!(LAST_TOPUP_BLOCK.with(|c| c.borrow().is_none()));

        // Low cycles + funded treasury: Phase A transfers, Phase B notifies
        // (host mock acks), and the block clears for the next evaluation.
        set_mock_cycles(1_000_000_000_000);
        set_mock_ledger_transfer(Ok(31));
        cycle_topup_check().await;
        assert!(LAST_TOPUP_BLOCK.with(|c| c.borrow().is_none()), "cleared after success");

        // Low cycles but a dust treasury: skipped entirely.
        set_mock_ledger_balance(1_000);
        set_mock_ledger_transfer(Err("must not be called".to_string()));
        cycle_topup_check().await;
        assert!(LAST_TOPUP_BLOCK.with(|c| c.borrow().is_none()));
        assert!(get_cycle_balance() > 0);
    }

    #[tokio::test]
    async fn test_admin_trigger_sweep_runs_all_passes() {
        install_staking_test_config();
        set_mock_ledger_balance(0);
        set_mock_ledger_transfer(Ok(1));
        admin_trigger_sweep().await.unwrap();
    }

    #[test]
    fn test_admin_token_ledger_and_min_upvote() {
        install_staking_test_config();
        let ledger = p("aaaaa-aa");

        assert_eq!(admin_set_token_ledger(IdeaToken::CkBTC, Principal::anonymous()).unwrap_err(), "INVALID_LEDGER");
        assert_eq!(admin_set_token_ledger(IdeaToken::ICP, ledger).unwrap_err(), "ICP_LEDGER_FIXED");
        admin_set_token_ledger(IdeaToken::CkBTC, ledger).unwrap();
        admin_set_token_ledger(IdeaToken::CkETH, ledger).unwrap();
        let cfg = CONFIG.with(|c| c.borrow().get().clone());
        assert_eq!(cfg.ckbtc_ledger_canister_id, Some(ledger));
        assert_eq!(cfg.cketh_ledger_canister_id, Some(ledger));

        // Mainnet pins the canonical ledgers — overrides rejected.
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(false)); });
        assert_eq!(admin_set_token_ledger(IdeaToken::CkBTC, ledger).unwrap_err(), "MAINNET_LEDGERS_PINNED");
        let resolved = token_ledger(IdeaToken::CkBTC, &CONFIG.with(|c| c.borrow().get().clone()));
        assert_eq!(resolved, Principal::from_text(MAINNET_CKBTC_LEDGER).unwrap());

        assert_eq!(admin_set_min_upvote(IdeaToken::ICP, 0).unwrap_err(), "INVALID_MINIMUM");
        assert_eq!(admin_set_min_upvote(IdeaToken::ICP, MAX_UPVOTE_UNITS + 1).unwrap_err(), "INVALID_MINIMUM");
        admin_set_min_upvote(IdeaToken::CkETH, 42).unwrap();
        assert_eq!(CONFIG.with(|c| c.borrow().get().min_upvote_cketh_wei), Some(42));
    }

    #[tokio::test]
    async fn test_dev_faucet_token_local_happy_path() {
        install_staking_test_config();
        set_mock_caller(p("rrkah-fqaaa-aaaaa-aaaaq-cai"));
        set_mock_ledger_transfer(Ok(1));
        for token in [IdeaToken::ICP, IdeaToken::CkBTC, IdeaToken::CkETH] {
            dev_faucet_token(token).await.unwrap();
        }
    }

    #[tokio::test]
    async fn test_finalize_pool_registration_rejections() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        assert_eq!(finalize_pool_registration(8_100_000).await.unwrap_err(), "NO_DRAFT");
        create_pool_draft(8_100_001).await.unwrap();
        set_mock_caller(bob);
        assert_eq!(finalize_pool_registration(8_100_001).await.unwrap_err(), "NO_DRAFT");
        set_mock_caller(alice);
        finalize_pool_registration(8_100_001).await.unwrap();
        // Already active → no double registration.
        assert_eq!(finalize_pool_registration(8_100_001).await.unwrap_err(), "NO_DRAFT");

        // Pool info reflects the active membership.
        let info = get_pool_info();
        assert!(info.active_count >= 1);
        set_mock_caller(alice);
        assert!(get_my_pool_neuron().is_some());

        // Unregister deactivates (the record is kept as Inactive so it can
        // re-finalize later without paying the fee again).
        unregister_leader_neuron(8_100_001).unwrap();
        assert_eq!(
            POOL_NEURONS.with(|m| m.borrow().get(&8_100_001)).unwrap().status,
            PoolStatus::Inactive
        );
        assert_eq!(unregister_leader_neuron(8_100_001).unwrap_err(), "INVALID_STATE");
    }

    #[tokio::test]
    async fn test_caller_scoped_queries_roundtrip() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // Commitments query.
        let pid = 720_001u64;
        open_proposal(pid, 1_000_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();
        let mine = get_my_commitments();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].amount_e8s, 200_000_000);

        // Stake + pending unstakes + lossless votes queries.
        stake(300_000_000, StakeTier::OneYear).await.unwrap();
        let my = get_my_stake();
        assert_eq!(my.total_staked_e8s, 300_000_000);
        assert_eq!(my.total_weight_e8s, 30_000_000, "voting power = stake ÷ 10");
        assert_eq!(my.tiers.len(), 1);
        let _uid = unstake(100_000_000, StakeTier::OneYear).await.unwrap();
        assert_eq!(list_my_pending_unstakes().len(), 1);
        cast_lossless_vote(pid, Stance::Adopt).unwrap();
        assert_eq!(get_my_lossless_votes().len(), 1);

        // Vote history.
        VOTES.with(|m| {
            m.borrow_mut().insert(pid, VoteRecord {
                proposal_id: pid, vote: Vote::Yes, icp_burned_e8s: 1,
                decided_at: 1, nns_outcome: None,
            });
        });
        assert!(!list_vote_history().is_empty());

        // Board info reflects local ledger fallbacks.
        let info = get_idea_board_info();
        assert!(info.enabled);
        assert_eq!(info.post_fee_e8s, IDEA_POST_FEE_E8S);

        // require_admin: rejected for non-admins, accepted once added.
        assert!(require_admin().is_err());
        CONFIG.with(|cell| {
            let mut cfg = cell.borrow().get().clone();
            cfg.admins.push(alice);
            cell.borrow_mut().set(cfg);
        });
        assert!(require_admin().is_ok());

        // Per-target deposit addresses are distinct.
        let a = get_idea_deposit_address(1);
        let b = get_project_deposit_address(1);
        assert_ne!(a.subaccount, b.subaccount);
        let id_text = get_caller_principal();
        assert_eq!(id_text, alice);
    }

    #[tokio::test]
    async fn test_unstake_split_done_recovers_via_sweep() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(500_000_000, StakeTier::SixMonths).await.unwrap();

        // Make StartDissolving fail at unstake time: the record parks as
        // SplitDone (split itself succeeded via the mock fallback).
        set_mock_manage_neuron(Some(Err("gov down".to_string())));
        // gov_split also goes through manage_neuron → it would fail too, so
        // run the split first with gov up, then…
        set_mock_manage_neuron(None);
        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();
        let mut pu = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        // Force the SplitDone state to exercise the sweep recovery branch.
        pu.status = UnstakeStatus::SplitDone;
        PENDING_UNSTAKES.with(|m| { m.borrow_mut().insert(id, pu); });

        staking_sweep().await;
        let pu = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pu.status, UnstakeStatus::Dissolving, "sweep restarts the dissolve");
        assert!(pu.dissolve_eta >= current_time() + StakeTier::SixMonths.dissolve_delay_secs() * 1_000_000_000);
    }

    #[tokio::test]
    async fn test_dev_lottery_draw_local_real_odds() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::SixMonths, alice, 100_000_000);
        claim_daily_tickets().unwrap();
        set_mock_ledger_transfer(Ok(1));

        // Pot below the 50 ICP minimum: the drawing rolls over — countdown
        // advances but no draw record is created and draws_held is untouched.
        set_mock_ledger_balance(1_000_000_000);
        let before_next = lottery_state().next_draw_at;
        dev_run_lottery_draw(false).await.unwrap();
        assert_eq!(list_lottery_draws().len(), 0, "below-minimum pot skips the drawing");
        assert_eq!(lottery_state().draws_held, 0);
        assert!(lottery_state().next_draw_at >= before_next, "countdown advanced");

        // Pot at the minimum: the real-odds path runs off the mocked entropy
        // (u64::MAX % denominator ≫ 5 tickets → rolls over).
        set_mock_ledger_balance(5_000_000_000);
        dev_run_lottery_draw(false).await.unwrap();
        let draw = LOTTERY_DRAWS.with(|m| m.borrow().get(&1)).unwrap();
        assert_eq!(draw.winner, None);
        assert_eq!(list_lottery_draws().len(), 1);

        // force_win without tickets in a fresh round errors cleanly.
        LOTTERY_TICKETS.with(|m| { m.borrow_mut().remove(&alice); });
        let mut st = lottery_state();
        st.total_tickets = 0;
        set_lottery_state(st);
        assert_eq!(dev_run_lottery_draw(true).await.unwrap_err(), "NO_TICKETS");
    }


    #[tokio::test]
    async fn test_admins_are_excluded_from_the_lottery() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::TwoYears, alice, 100_000_000);

        // Staked and eligible as a normal user…
        assert_eq!(user_daily_tickets(alice), 20);

        // …but the moment they become an admin, the house holds no tickets.
        CONFIG.with(|cell| {
            let mut cfg = cell.borrow().get().clone();
            cfg.admins.push(alice);
            cell.borrow_mut().set(cfg);
        });
        assert_eq!(user_daily_tickets(alice), 0);
        assert_eq!(claim_daily_tickets().unwrap_err(), "ADMINS_EXCLUDED");
        set_mock_ledger_balance(0);
        let info = get_lottery_info().await;
        assert!(info.admin_excluded);
        assert!(!info.eligible);
        assert_eq!(info.my_daily_tickets, 0);
    }

    #[test]
    fn test_list_recent_winners_filters_and_caps() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        // 15 winning draws + interleaved no-win draws.
        for i in 1..=30u64 {
            let won = i % 2 == 0;
            LOTTERY_DRAWS.with(|m| {
                m.borrow_mut().insert(i, LotteryDraw {
                    id: i,
                    round: 1,
                    drawn_at: i,
                    total_tickets: 5,
                    pot_e8s: 100,
                    winning_ticket: Some(0),
                    winner: if won { Some(alice) } else { None },
                    prize_e8s: if won { 80 } else { 0 },
                    payout_block: None,
                    status: DrawStatus::Done,
                });
            });
        }
        let winners = list_recent_winners();
        assert_eq!(winners.len(), 10, "capped at the last 10 winners");
        assert!(winners.iter().all(|d| d.winner.is_some()));
        assert_eq!(winners[0].id, 30, "newest first");
        assert_eq!(winners[9].id, 12);

        // Pot address is the canonical lottery subaccount.
        let pot = get_lottery_pot_address();
        assert_eq!(pot.owner, get_canister_id());
        assert_eq!(pot.subaccount, Some(LOTTERY_SUBACCOUNT));
    }

    #[test]
    fn test_dev_become_admin_local_only() {
        // Mainnet-shaped config: hard-blocked.
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(false)); });
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        assert_eq!(dev_become_admin().unwrap_err(), "DEV_ONLY");

        // Local: one click, idempotent.
        install_staking_test_config();
        dev_become_admin().unwrap();
        assert!(CONFIG.with(|c| c.borrow().get().admins.contains(&alice)));
        dev_become_admin().unwrap();
        assert_eq!(
            CONFIG.with(|c| c.borrow().get().admins.iter().filter(|a| **a == alice).count()),
            1
        );
        assert!(require_admin().is_ok(), "freshly minted admin passes the guard");
    }


    #[tokio::test]
    async fn test_stake_unstake_cycle_is_zero_loss() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_transfer(Ok(1));

        // Zero-loss deposit: escrow holding EXACTLY the amount is enough —
        // the treasury fronts the transfer fee.
        set_mock_ledger_balance(500_000_000);
        stake(500_000_000, StakeTier::SixMonths).await.unwrap();
        assert_eq!(tier_pool(StakeTier::SixMonths).total_staked_e8s, 500_000_000);

        // Unstake → fast-forward → one sweep pass disburses AND reimburses
        // every fee from the treasury.
        let id = unstake(200_000_000, StakeTier::SixMonths).await.unwrap();
        dev_fast_forward_dissolve(id).unwrap();
        staking_sweep().await;
        let pu = PENDING_UNSTAKES.with(|m| m.borrow().get(&id)).unwrap();
        assert_eq!(pu.status, UnstakeStatus::Disbursed);
        assert!(pu.fee_refund_block.is_some(), "treasury reimbursed the cycle fees");

        // If the refund transfer fails at disburse time, the sweep retries it.
        let id2 = unstake(100_000_000, StakeTier::SixMonths).await.unwrap();
        dev_fast_forward_dissolve(id2).unwrap();
        set_mock_ledger_transfer(Err("treasury hiccup".to_string()));
        staking_sweep().await;
        // Disburse itself failed too (same mocked ledger) — recover both.
        set_mock_ledger_transfer(Ok(9));
        staking_sweep().await;
        let pu2 = PENDING_UNSTAKES.with(|m| m.borrow().get(&id2)).unwrap();
        assert_eq!(pu2.status, UnstakeStatus::Disbursed);
        assert_eq!(pu2.fee_refund_block, Some(9));
    }

    #[test]
    fn test_dev_seed_payouts_local_only_and_idempotent() {
        CONFIG.with(|cell| { cell.borrow_mut().set(test_config(false)); });
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        assert_eq!(dev_seed_payouts().unwrap_err(), "DEV_ONLY");

        install_staking_test_config();
        dev_seed_payouts().unwrap();
        set_mock_caller(alice);
        let mine = get_my_payouts();
        assert_eq!(mine.len(), 6, "varied mock history seeded");
        assert!(mine.iter().any(|p| p.payout_type == PayoutType::LotteryWin));
        assert!(mine.iter().any(|p| p.token == IdeaToken::CkBTC));

        // Re-seeding never duplicates.
        dev_seed_payouts().unwrap();
        assert_eq!(get_my_payouts().len(), 6);
    }


    #[tokio::test]
    async fn test_full_unstake_voids_tickets_immediately() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(bob);
        seed_stake(StakeTier::SixMonths, bob, 100_000_000);
        claim_daily_tickets().unwrap(); // bob: 5 tickets keep the round alive

        // A third staker keeps the 1-year pool above the 1 ICP floor so
        // alice can fully exit.
        let carol = p("2vxsx-fae");
        let carol = Principal::self_authenticating(carol.as_slice());
        set_mock_caller(carol);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(200_000_000, StakeTier::OneYear).await.unwrap();

        set_mock_caller(alice);
        stake(300_000_000, StakeTier::OneYear).await.unwrap();
        // Stake-weighted: 3 ICP × 1y multiplier (2×) × base 5 = 30/day.
        assert_eq!(claim_daily_tickets().unwrap(), 30);
        assert_eq!(lottery_state().total_tickets, 35);

        // Partial unstake: still staked → tickets stay live.
        unstake(100_000_000, StakeTier::OneYear).await.unwrap();
        assert_eq!(
            LOTTERY_TICKETS.with(|m| m.borrow().get(&alice)).unwrap().count,
            30,
            "partial unstake keeps tickets"
        );

        // Unstake the rest: eligibility ends NOW — tickets void, pool total
        // shrinks, no future drawing can pick her.
        unstake(200_000_000, StakeTier::OneYear).await.unwrap();
        let entry = LOTTERY_TICKETS.with(|m| m.borrow().get(&alice)).unwrap();
        assert_eq!(entry.count, 0, "full unstake voids current-round tickets");
        assert_eq!(lottery_state().total_tickets, 5, "only bob's tickets remain");
        assert_eq!(find_ticket_owner(lottery_state().round, 4), Some(bob));
        assert_eq!(find_ticket_owner(lottery_state().round, 5), None);

        // The daily-claim clock survives the void: re-staking the same day
        // does NOT mint a fresh grant.
        set_mock_ledger_balance(100_000_000_000);
        stake(100_000_000, StakeTier::SixMonths).await.unwrap();
        assert_eq!(claim_daily_tickets().unwrap_err(), "ALREADY_CLAIMED_TODAY");
    }

    #[test]
    fn test_admin_promotion_voids_tickets() {
        install_staking_test_config();
        enable_lottery();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        seed_stake(StakeTier::TwoYears, alice, 100_000_000);
        assert_eq!(claim_daily_tickets().unwrap(), 20);
        assert_eq!(lottery_state().total_tickets, 20);

        add_admin(alice).unwrap();
        assert_eq!(
            LOTTERY_TICKETS.with(|m| m.borrow().get(&alice)).unwrap().count,
            0,
            "the house holds no tickets — promotion voids them"
        );
        assert_eq!(lottery_state().total_tickets, 0);
    }


    #[tokio::test]
    async fn test_get_my_transactions_merges_spends_and_payouts() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        follow_as(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // Out legs: a commitment, an idea post, an upvote (token-typed) and
        // a stake lockup.
        let pid = 730_001u64;
        open_proposal(pid, 10_000_000_000);
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();
        let idea = post_idea("Tx history".into(), "d".into(), "".into()).await.unwrap();
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(bob);
        upvote_idea(idea, IdeaToken::CkBTC, 5_000).await.unwrap();
        set_mock_caller(alice);
        stake(200_000_000, StakeTier::SixMonths).await.unwrap();

        // In leg: the commitment refunds when the proposal misses.
        process_proposal_cutoff(pid).await.unwrap();

        let txs = get_my_transactions();
        let kind = |k: &str| txs.iter().find(|t| t.kind == k);
        let dep = kind("deposit").expect("commit escrow recorded");
        assert_eq!(dep.direction, TxDirection::Out);
        assert_eq!(dep.amount, 200_000_000);
        let post = kind("idea_post").expect("idea post fee recorded");
        assert_eq!(post.amount, IDEA_POST_FEE_E8S);
        let st = kind("stake").expect("stake lockup recorded");
        assert_eq!(st.direction, TxDirection::Out);
        assert_eq!(st.amount, 200_000_000);
        let refund = kind("CommitmentRefund").expect("refund payout recorded");
        assert_eq!(refund.direction, TxDirection::In);
        assert_eq!(refund.amount, 200_000_000);
        // Newest-first ordering.
        for w in txs.windows(2) {
            assert!(w[0].timestamp >= w[1].timestamp);
        }

        // Bob's view: only his token-typed upvote spend.
        set_mock_caller(bob);
        let bobs = get_my_transactions();
        let uv = bobs.iter().find(|t| t.kind == "idea_upvote").expect("upvote spend");
        assert_eq!(uv.direction, TxDirection::Out);
        assert_eq!(uv.token, IdeaToken::CkBTC);
        assert_eq!(uv.amount, 5_000);
        assert!(bobs.iter().all(|t| t.kind != "deposit"), "caller-scoped");
    }


    #[tokio::test]
    async fn test_staked_weight_meets_threshold_and_settles() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        // Voting power = stake ÷ 10: 30 ICP staked = 3 ICP of weight.
        stake(3_000_000_000, StakeTier::TwoYears).await.unwrap();

        // Threshold 5 ICP: 3 ICP of staked weight is NOT enough on its own.
        let pid = 740_001u64;
        open_proposal(pid, 500_000_000);
        cast_lossless_vote(pid, Stance::Adopt).unwrap();
        assert_eq!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().status, "open");

        // A second staker (20 ICP → 2 ICP weight) pushes COMBINED weight
        // (3 + 2 = 5 ICP) to the 5 ICP threshold → met, no burn.
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_caller(bob);
        stake(2_000_000_000, StakeTier::OneYear).await.unwrap();
        cast_lossless_vote(pid, Stance::Reject).unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "met", "combined staked weight ≥ threshold");
        assert_eq!(prop.total_committed_e8s, 0, "no burn needed");

        // Cutoff: the vote fires on staked conviction alone. Adopt (3 ICP)
        // beats reject (2 ICP); nothing burns because nothing was committed.
        process_proposal_cutoff(pid).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "settled");
        assert_eq!(prop.total_burned_e8s, Some(0));
        let vote = VOTES.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(vote.vote, Vote::Yes, "staked adopt majority carried it");
    }


    #[tokio::test]
    async fn test_staked_vote_moves_no_icp_and_has_nothing_to_refund() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        stake(300_000_000, StakeTier::SixMonths).await.unwrap(); // 0.3 VP

        let pid = 760_001u64;
        open_proposal(pid, 10_000_000_000); // unreachable threshold → will miss

        // From here ANY ledger transfer would be a bug for a staked voter:
        // make every transfer fail so a stray one surfaces loudly.
        set_mock_ledger_transfer(Err("staked votes must not move ICP".to_string()));
        cast_lossless_vote(pid, Stance::Adopt).unwrap();

        // No escrow / commitment exists for the staked voter.
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        assert!(COMMITMENTS.with(|m| m.borrow().get(&key)).is_none());

        // Settlement of a missed proposal: nothing to refund, no transfer
        // attempted (the Err mock is never hit), no payout recorded.
        process_proposal_cutoff(pid).await.unwrap();
        assert_eq!(PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().status, "abstained");
        assert!(PAYOUTS.with(|m| m.borrow().is_empty()), "staked voters get nothing back");
        // The immutable vote record persists though it moved zero ICP.
        assert_eq!(get_my_lossless_votes().len(), 1);
    }

    #[tokio::test]
    async fn test_staked_vote_then_burn_commit_same_proposal() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        follow_as(alice);
        stake(1_000_000_000, StakeTier::SixMonths).await.unwrap(); // 10 ICP → 1 VP

        let pid = 760_002u64;
        open_proposal(pid, 500_000_000); // 5 ICP threshold

        // 1) Free staked ADOPT first (1 ICP of weight; below threshold).
        cast_lossless_vote(pid, Stance::Adopt).unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.lossless_adopt_e8s, 100_000_000);
        assert_eq!(prop.total_committed_e8s, 0);
        assert_eq!(prop.status, "open");

        // 2) Then burn-commit ADOPT with wallet ICP — a separate escrow,
        //    independent of the staked tally.
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.adopt_pot_e8s, 200_000_000, "burn pot independent of staked tally");
        assert_eq!(prop.lossless_adopt_e8s, 100_000_000, "staked tally unchanged by the burn");
        assert_eq!(prop.total_committed_e8s, 200_000_000);

        // 3) Add more burn after the initial commitment → crosses threshold.
        add_to_commitment(pid, 300_000_000).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.total_committed_e8s, 500_000_000);
        assert_eq!(prop.lossless_adopt_e8s, 100_000_000, "top-up doesn't touch staked tally");
        assert_eq!(prop.status, "met");

        // Settle: the burn is spent; the staked vote moved nothing and is
        // NOT refunded — the user keeps both records, only the burn settles.
        process_proposal_cutoff(pid).await.unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "settled");
        assert_eq!(prop.total_burned_e8s, Some(500_000_000));
        let key = CommitmentKey { proposal_id: pid, principal: alice };
        assert_eq!(
            COMMITMENTS.with(|m| m.borrow().get(&key)).unwrap().status,
            CommitmentStatus::Burned
        );
        assert_eq!(get_my_lossless_votes().len(), 1, "staked vote record retained");
        let payouts: Vec<Payout> = PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert!(
            payouts.iter().all(|po| po.payout_type != PayoutType::CommitmentRefund),
            "a settled burn is not refunded, and the staked side never had escrow"
        );
    }

    #[tokio::test]
    async fn test_burn_then_staked_vote_opposite_stances_both_tally() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        set_mock_caller(alice);
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));
        follow_as(alice);
        stake(2_000_000_000, StakeTier::SixMonths).await.unwrap(); // 20 ICP → 2 VP

        let pid = 760_005u64;
        open_proposal(pid, 1_000_000_000); // 10 ICP threshold

        // Burn ADOPT then cast a staked REJECT — a user is free to hedge.
        // The two land on opposite sides of the balance of power.
        commit(pid, Stance::Adopt, 300_000_000).await.unwrap();
        cast_lossless_vote(pid, Stance::Reject).unwrap();
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.adopt_pot_e8s, 300_000_000);
        assert_eq!(prop.lossless_reject_e8s, 200_000_000);
        // first_stance is the burn ADOPT (it came first).
        assert_eq!(prop.first_stance, Some(Stance::Adopt));
        // Threshold not met (burn 3 ICP, staked 2 ICP — neither path reaches 10).
        assert_eq!(prop.status, "open");
    }

    #[tokio::test]
    async fn test_unmet_refunds_burners_not_staked_voters() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(7));

        // Alice burns 2 ICP.
        follow_as(alice);
        let pid = 760_003u64;
        open_proposal(pid, 10_000_000_000); // unreachable threshold
        commit(pid, Stance::Adopt, 200_000_000).await.unwrap();

        // Bob stakes and casts a free staked vote — no escrow.
        set_mock_caller(bob);
        stake(500_000_000, StakeTier::OneYear).await.unwrap();
        cast_lossless_vote(pid, Stance::Reject).unwrap();

        process_proposal_cutoff(pid).await.unwrap();

        // Alice's burn is refunded; bob has nothing to refund.
        let akey = CommitmentKey { proposal_id: pid, principal: alice };
        assert_eq!(
            COMMITMENTS.with(|m| m.borrow().get(&akey)).unwrap().status,
            CommitmentStatus::Returned
        );
        let payouts: Vec<Payout> = PAYOUTS.with(|m| m.borrow().iter().map(|e| e.value()).collect());
        assert_eq!(
            payouts.iter().filter(|po| po.payout_type == PayoutType::CommitmentRefund).count(),
            1,
            "exactly one refund — the burner's"
        );
        assert!(payouts.iter().all(|po| po.user != bob), "staked voter gets no payout");
        let bkey = CommitmentKey { proposal_id: pid, principal: bob };
        assert!(
            COMMITMENTS.with(|m| m.borrow().get(&bkey)).is_none(),
            "no escrow ever existed for the staked voter"
        );
    }

    #[tokio::test]
    async fn test_lossless_first_vote_sets_tiebreak_stance() {
        install_staking_test_config();
        let alice = p("rrkah-fqaaa-aaaaa-aaaaq-cai");
        let bob = p("ryjl3-tyaaa-aaaaa-aaaba-cai");
        set_mock_ledger_balance(100_000_000_000);
        set_mock_ledger_transfer(Ok(1));

        set_mock_caller(alice);
        stake(1_000_000_000, StakeTier::SixMonths).await.unwrap(); // 1 VP
        let pid = 760_004u64;
        open_proposal(pid, 50_000_000); // 0.5 ICP threshold
        cast_lossless_vote(pid, Stance::Reject).unwrap(); // first stance = reject

        set_mock_caller(bob);
        stake(1_000_000_000, StakeTier::OneYear).await.unwrap(); // 1 VP
        cast_lossless_vote(pid, Stance::Adopt).unwrap();

        // 1 VP adopt vs 1 VP reject → exact tie; first stance (reject) wins.
        let prop = PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(prop.status, "met");
        assert_eq!(prop.first_stance, Some(Stance::Reject));
        process_proposal_cutoff(pid).await.unwrap();
        let vote = VOTES.with(|m| m.borrow().get(&pid)).unwrap();
        assert_eq!(vote.vote, Vote::No, "tie broken by first stance = reject");
        // Pure staked settlement: nothing burned, nothing refunded.
        assert_eq!(prop_burned(pid), 0);
        assert!(PAYOUTS.with(|m| m.borrow().is_empty()));
    }

    fn prop_burned(pid: u64) -> u64 {
        PROPOSALS.with(|m| m.borrow().get(&pid)).unwrap().total_burned_e8s.unwrap_or(0)
    }

}
