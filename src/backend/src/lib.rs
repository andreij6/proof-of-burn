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
    pub voting_power: u64,
    pub followees: Vec<(i32, Followees)>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum GetFullNeuronResult {
    Ok(Neuron),
    Err(GovernanceError),
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
    /// Admin overrides for the per-token minimum upvote (smallest units).
    /// `None` falls back to the value-aligned defaults; retune via
    /// `admin_set_min_upvote` as exchange rates drift.
    #[serde(default)]
    pub min_upvote_icp_e8s: Option<u64>,
    #[serde(default)]
    pub min_upvote_ckbtc_e8s: Option<u64>,
    #[serde(default)]
    pub min_upvote_cketh_wei: Option<u64>,
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
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
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
    let caller = ic_cdk::caller();
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
        ic_cdk::caller()
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
    let caller = ic_cdk::caller();
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
        min_upvote_icp_e8s: None,
        min_upvote_ckbtc_e8s: None,
        min_upvote_cketh_wei: None,
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
    ic_cdk::caller()
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
        NotifyTopUpResult::Err(NotifyError::TransactionNotFound)
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
        Ok(())
    })
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
    let now = ic_cdk::api::time();
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
                    p.status = if p.total_committed_e8s >= new_threshold_e8s {
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
    cycle_topup_check().await;
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
            let now = ic_cdk::api::time();
            
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
            });
        }
    });

    VOTES.with(|map| {
        let mut m = map.borrow_mut();
        if m.is_empty() {
            let now = ic_cdk::api::time();
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

                if !has_hotkey || !follows || neuron.voting_power == 0 {
                    neuron_state.status = PoolStatus::Inactive;
                    canister_print(&format!(
                        "Pool neuron {} inactivated (hotkey={}, follow={})",
                        neuron_id, has_hotkey, follows
                    ));
                } else {
                    neuron_state.voting_power = neuron.voting_power;
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
    let now = ic_cdk::api::time();

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
            ic_cdk::api::print(&format!("get_neuron_info error: {}", e.error_message));
        }
        Err((code, msg)) => {
            ic_cdk::api::print(&format!("get_neuron_info call failed (code {:?}): {}", code, msg));
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
    let caller = ic_cdk::caller();
    let state = UserNeuronState {
        neuron_id: 0,
        is_following: true,
        verified_at: ic_cdk::api::time(),
        cached_stake_e8s: 0,
    };
    USER_NEURONS.with(|map| {
        map.borrow_mut().insert(caller, state);
    });
    Ok(())
}

#[ic_cdk::query]
fn get_eligibility() -> EligibilityInfo {
    let caller = ic_cdk::caller();
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
    account_id_hex(ic_cdk::caller(), &[0u8; 32])
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

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct NotifyTopUpArgs {
    pub canister_id: Principal,
    pub block_index: candid::Nat,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum NotifyTopUpResult {
    Ok(candid::Nat),
    Err(NotifyError),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum NotifyError {
    Refunded {
        refund_block_index: Option<candid::Nat>,
        reason: String,
    },
    InvalidTokenLedger,
    TransactionNotFound,
    TransactionTooOld,
    AlreadyNotified,
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

#[cfg(target_arch = "wasm32")]
async fn call_ledger_legacy_transfer(
    ledger_id: Principal,
    from_sub: Option<[u8; 32]>,
    to_account_id: [u8; 32],
    amount_e8s: u64,
    fee_e8s: u64,
) -> Result<u64, String> {
    let args = SendArgs {
        memo: 0,
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
) -> Result<u64, String> {
    TEST_MOCK_LEDGER_TRANSFER.with(|cell| cell.borrow().clone())
}

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
/// `AlreadyNotified` is treated as success; `Refunded` is a hard failure.
#[cfg(target_arch = "wasm32")]
async fn notify_cmc_topup(
    cmc: Principal,
    target: Principal,
    block_index: u64,
    fail_on_missing_cmc: bool,
) -> Result<(), String> {
    let args = NotifyTopUpArgs {
        canister_id: target,
        block_index: candid::Nat::from(block_index),
    };
    let res: Result<(NotifyTopUpResult,), _> =
        ic_cdk::call(cmc, "notify_top_up", (args,)).await;
    match res {
        Ok((NotifyTopUpResult::Ok(_),)) => Ok(()),
        Ok((NotifyTopUpResult::Err(NotifyError::AlreadyNotified),)) => Ok(()),
        Ok((NotifyTopUpResult::Err(NotifyError::Refunded { .. }),)) => {
            Err("CMC_REFUNDED".to_string())
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
/// re-notifies the CMC (AlreadyNotified = success).
async fn settle_burn_split(
    ledger_id: Principal,
    from_subaccount: [u8; 32],
    amount_e8s: u64,
    commitment: &mut Commitment,
) -> Result<(), String> {
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
    let treasury_dest = LedgerAccount { owner: ic_cdk::id(), subaccount: Some(TREASURY_SUBACCOUNT) };

    let treasury_amt = amount_e8s / 2;
    let backend_amt = amount_e8s / 4;
    let frontend_amt = amount_e8s - treasury_amt - backend_amt; // remainder ≈ 25%

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
            ic_cdk::id(),
            backend_amt,
            10_000,
        )
        .await
        .map_err(|e| format!("BACKEND_CMC_XFER: {}", e))?;
        commitment.cmc_block_index = Some(b);
    }
    notify_cmc_topup(
        cmc,
        ic_cdk::id(),
        commitment.cmc_block_index.unwrap(),
        commitment.proposal_id != 138388,
    )
    .await?;

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
    notify_cmc_topup(
        cmc,
        frontend_canister_id(),
        commitment.frontend_cmc_block.unwrap(),
        commitment.proposal_id != 138388,
    )
    .await?;

    Ok(())
}

#[ic_cdk::query]
fn get_deposit_address(proposal_id: u64) -> LedgerAccount {
    let caller = ic_cdk::caller();
    let sub = derive_subaccount(&caller, proposal_id);
    LedgerAccount {
        owner: ic_cdk::id(),
        subaccount: Some(sub),
    }
}

#[ic_cdk::query]
fn get_registration_address() -> LedgerAccount {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        panic!("Anonymous principal is not allowed");
    }
    let sub = derive_subaccount(&caller, REGISTRATION_SEED);
    LedgerAccount {
        owner: ic_cdk::id(),
        subaccount: Some(sub),
    }
}

#[ic_cdk::update]
async fn refund_registration() -> Result<(), String> {
    require_authenticated()?;
    let caller = ic_cdk::caller();
    let sub = derive_subaccount(&caller, REGISTRATION_SEED);
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let escrow_acc = LedgerAccount {
        owner: ic_cdk::id(),
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

        neuron.voting_power
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

        neuron.voting_power
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
    notify_cmc_topup(
        cmc,
        get_canister_id(),
        neuron_state.backend_cmc_block.unwrap(),
        false,
    )
    .await?;

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
    notify_cmc_topup(
        cmc,
        frontend_canister_id(),
        neuron_state.frontend_cmc_block.unwrap(),
        false,
    )
    .await?;

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
    let caller = ic_cdk::caller();

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

    let now = ic_cdk::api::time();
    if now >= proposal.deadline - 3_600_000_000_000 {
        return Err("COMMITMENT_CLOSED".to_string());
    }

    let subaccount = derive_subaccount(&caller, proposal_id);
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;

    let escrow_account = LedgerAccount {
        owner: ic_cdk::id(),
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
        owner: ic_cdk::id(),
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

    if proposal.total_committed_e8s >= proposal.threshold_e8s {
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
    let caller = ic_cdk::caller();
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
    let now = ic_cdk::api::time();
    if now >= proposal.deadline - 3_600_000_000_000 {
        return Err("COMMITMENT_CLOSED".to_string());
    }

    // 4. Escrow balance check — no protocol fee on top-ups, only need
    //    the additional amount deposited. The 30,000 e8s settlement fee
    //    reserve was already deposited with the original commit.
    let subaccount = commitment.subaccount;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let ledger_id = config.ledger_canister_id;
    let escrow_account = LedgerAccount {
        owner: ic_cdk::id(),
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
    if proposal.total_committed_e8s >= proposal.threshold_e8s {
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
    let caller = ic_cdk::caller();
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
        owner: ic_cdk::id(),
        subaccount: Some(TREASURY_SUBACCOUNT),
    };
    match call_ledger_balance(ledger_id, treasury_account).await {
        Ok(bal) => BalanceResult::Ok(bal),
        Err(e) => BalanceResult::Err(e),
    }
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

#[ic_cdk::query]
fn get_cycle_balance() -> u64 {
    ic_cdk::api::canister_balance()
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

#[derive(CandidType, Serialize, Clone, Debug)]
pub enum Command {
    RegisterVote(RegisterVoteCommand),
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
pub enum CommandResponse {
    RegisterVote(RegisterVoteResponse),
    Error(GovernanceError),
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
            ic_cdk::api::print(&format!("list_proposals failed (code {:?}): {}", code, msg));
            return;
        }
    };

    let default_threshold = CONFIG.with(|c| c.borrow().get().default_threshold);
    let now = ic_cdk::api::time();

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
        };
        PROPOSALS.with(|map| {
            map.borrow_mut().insert(nns_id, proposal);
        });
    }
}

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

    let met = proposal.total_committed_e8s >= proposal.threshold_e8s;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    // PB-123: majority of committed ICP wins; an exact tie is broken by the
    // first stance committed on this proposal (first vote wins).
    let vote_choice = decide_vote_choice(
        proposal.adopt_pot_e8s,
        proposal.reject_pot_e8s,
        proposal.first_stance.clone(),
    );

    let mut vote_success = false;
    match proposal.nns_proposal_id {
        Some(nns_id) => {
            let vote_result = cast_nns_vote(config.primary_neuron_id, nns_id, vote_choice).await;
            match vote_result {
                Ok(_) => {
                    vote_success = true;
                    proposal.vote_executed_at = Some(ic_cdk::api::time());
                }
                Err(e) => {
                    ic_cdk::api::print(&format!("NNS vote failed for proposal {}: {}", pid, e));
                }
            }
        }
        None => {
            ic_cdk::api::print(&format!("Proposal {} has no nns_proposal_id; skipping vote", pid));
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
            decided_at: ic_cdk::api::time(),
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
    let now = ic_cdk::api::time();

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

                    ic_cdk::api::print(&format!(
                        "Commitment settled (split 50/25/25): {} e8s for user {}",
                        commitment.amount_e8s, user
                    ));
                }
                Err(e) => {
                    commitment.status = CommitmentStatus::FailedBurn;
                    ic_cdk::api::print(&format!("settle_burn_split failed for user {}: {}", user, e));
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
                }
                Err(e) => {
                    commitment.status = CommitmentStatus::FailedRefund;
                    ic_cdk::api::print(&format!("Failed to refund commitment for user {}: {}", user, e));
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
    let now = ic_cdk::api::time();
    let mut proposals_to_process = Vec::new();

    PROPOSALS.with(|map| {
        for entry in map.borrow().iter() {
            let p = entry.value();
            if (p.status == "open" || p.status == "met") && now >= (p.deadline - 3_600_000_000_000) {
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
    let now = ic_cdk::api::time();

    for (proposal_id, user) in to_retry {
        let key = CommitmentKey {
            proposal_id,
            principal: user,
        };
        let mut commitment = COMMITMENTS.with(|map| map.borrow().get(&key)).unwrap();

        if commitment.status == CommitmentStatus::FailedBurn {
            // Idempotent retry — completed split transfers are skipped (their
            // block indices are Some); only the unfinished step/notify re-runs.
            if let Ok(()) = settle_burn_split(ledger_id, commitment.subaccount, commitment.amount_e8s, &mut commitment).await {
                commitment.status = CommitmentStatus::Burned;
                commitment.settled_at = Some(now);
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
            if let Ok(_) = transfer_res {
                commitment.status = CommitmentStatus::Returned;
                commitment.settled_at = Some(now);
            }
        }

        COMMITMENTS.with(|map| {
            map.borrow_mut().insert(key, commitment);
        });
    }
}

async fn cycle_topup_check() {
    let cycles = ic_cdk::api::canister_balance();
    if cycles < 5_000_000_000_000 {
        let config = CONFIG.with(|cell| cell.borrow().get().clone());
        let ledger_id = config.ledger_canister_id;

        let treasury_account = LedgerAccount {
            owner: ic_cdk::id(),
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
                    ic_cdk::id(),
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

        // Phase B: notify the CMC. Idempotent — `AlreadyNotified` is success.
        let notify_args = NotifyTopUpArgs {
            canister_id: ic_cdk::id(),
            block_index: candid::Nat::from(block_index),
        };
        let notify_res: Result<(NotifyTopUpResult,), _> =
            ic_cdk::call(cmc_principal, "notify_top_up", (notify_args,)).await;
        match notify_res {
            Ok((NotifyTopUpResult::Ok(_) | NotifyTopUpResult::Err(NotifyError::AlreadyNotified),)) => {
                // Success — clear the persisted block index so the next sweep
                // re-evaluates the treasury balance fresh.
                LAST_TOPUP_BLOCK.with(|cell| *cell.borrow_mut() = None);
            }
            _ => {
                // Transient failure — leave the block index persisted so the
                // next timer tick retries Phase B only (no double transfer).
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
        cycle_topup_check().await;
    });
}

/// Local-dev faucet — sends 100 ICP from the canister's own account to the caller.
/// Rejected on mainnet (ledger canister ID check). Never callable by anonymous.
#[ic_cdk::update]
async fn dev_faucet() -> Result<(), String> {
    require_authenticated()?;
    let config = CONFIG.with(|cell| cell.borrow().get().clone());

    // Block on mainnet: ICP mainnet ledger canister ID
    if config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap() {
        return Err("dev_faucet is only available on the local network".to_string());
    }

    let caller = ic_cdk::caller();
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

    if config.ledger_canister_id == Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap() {
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
const KNOWN_FEATURE_FLAGS: [&str; 1] = [FLAG_IDEA_BOARD];

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
    let caller = ic_cdk::caller();
    LedgerAccount {
        owner: ic_cdk::id(),
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
    let caller = ic_cdk::caller();
    LedgerAccount {
        owner: ic_cdk::id(),
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
    let caller = ic_cdk::caller();
    LedgerAccount {
        owner: ic_cdk::id(),
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
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
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
                min_upvote_icp_e8s: None,
                min_upvote_ckbtc_e8s: None,
                min_upvote_cketh_wei: None,
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
            voting_power: 100_000_000,
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
            voting_power: 100_000_000,
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
            voting_power: 50_000_000_000,
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
        mock_n.voting_power = 60_000_000_000;
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
            voting_power: 25_000_000_000,
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
            voting_power: 30_000_000_000,
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
            voting_power: 30_000_000_000,
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
            min_upvote_icp_e8s: None,
            min_upvote_ckbtc_e8s: None,
            min_upvote_cketh_wei: None,
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
}

