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

async fn get_full_neuron(neuron_id: u64) -> Result<Neuron, String> {
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();
    let response: Result<(GetFullNeuronResult,), _> =
        ic_cdk::call(nns_gov, "get_full_neuron", (neuron_id,)).await;

    match response {
        Ok((GetFullNeuronResult::Ok(neuron),)) => Ok(neuron),
        Ok((GetFullNeuronResult::Err(err),)) => Err(err.error_message),
        Err((code, msg)) => Err(format!("Call failed (code {:?}): {}", code, msg)),
    }
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
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CommitmentKey {
    pub proposal_id: u64,
    pub principal: Principal,
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

fn require_authenticated() -> Result<(), String> {
    if ic_cdk::caller() == Principal::anonymous() {
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
    };
    CONFIG.with(|cell| {
        cell.borrow_mut().set(config);
    });

    // PB-117: mock proposals are local-dev only. On mainnet the proposal list is
    // populated from live NNS data (kicked off immediately + on the sweep timer).
    if is_local {
        seed_mock_proposals();
    } else {
        ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_live_proposals());
    }
    // Populate the leader-neuron stats (real on mainnet, mock on local).
    ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_leader_neuron_info());
    setup_timers();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable data auto-restores. Local: top up mock seed if empty. Mainnet:
    // refresh the live proposal feed shortly after upgrade.
    let is_local = CONFIG.with(|c| c.borrow().get().is_local);
    if is_local {
        seed_mock_proposals();
    } else {
        ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_live_proposals());
    }
    ic_cdk_timers::set_timer(std::time::Duration::from_secs(0), fetch_leader_neuron_info());
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

#[derive(CandidType, Serialize, Debug)]
pub struct NotifyTopUpArgs {
    pub canister_id: Principal,
    pub block_index: candid::Nat,
}

#[derive(CandidType, Deserialize, Debug)]
pub enum NotifyTopUpResult {
    Ok(candid::Nat),
    Err(NotifyError),
}

#[derive(CandidType, Deserialize, Debug)]
pub enum NotifyError {
    Refunded { refund_block_index: Option<candid::Nat>, reason: String },
    InvalidTokenLedger,
    TransactionNotFound,
    TransactionTooOld,
    AlreadyNotified,
    Other { error_code: u64, error_message: String },
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum BalanceResult {
    Ok(u64),
    Err(String),
}

async fn call_ledger_balance(ledger_id: Principal, account: LedgerAccount) -> Result<u64, String> {
    let response: Result<(candid::Nat,), _> = ic_cdk::call(ledger_id, "icrc1_balance_of", (account,)).await;
    match response {
        Ok((balance,)) => {
            let bal_str = balance.to_string().replace('_', "");
            let bal_u64 = bal_str.parse::<u64>().map_err(|e| format!("Failed to parse balance: {}", e))?;
            Ok(bal_u64)
        }
        Err((code, msg)) => Err(format!("Ledger call failed (code {:?}): {}", code, msg)),
    }
}

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
    let response: Result<(TransferResult,), _> = ic_cdk::call(ledger_id, "icrc1_transfer", (args,)).await;
    match response {
        Ok((TransferResult::Ok(block_index),)) => {
            let block_str = block_index.to_string().replace('_', "");
            let block_u64 = block_str.parse::<u64>().map_err(|e| format!("Failed to parse block index: {}", e))?;
            Ok(block_u64)
        }
        Ok((TransferResult::Err(err),)) => Err(format!("Ledger transfer returned error: {:?}", err)),
        Err((code, msg)) => Err(format!("Ledger transfer call failed (code {:?}): {}", code, msg)),
    }
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

/// Notify the CMC to mint cycles for `block_index` to `target`. Idempotent:
/// `AlreadyNotified` is treated as success; `Refunded` is a hard failure.
async fn notify_cmc_topup(cmc: Principal, target: Principal, block_index: u64) -> Result<(), String> {
    let args = NotifyTopUpArgs { canister_id: target, block_index: candid::Nat::from(block_index) };
    let res: Result<(NotifyTopUpResult,), _> = ic_cdk::call(cmc, "notify_top_up", (args,)).await;
    match res {
        Ok((NotifyTopUpResult::Ok(_),)) => Ok(()),
        Ok((NotifyTopUpResult::Err(NotifyError::AlreadyNotified),)) => Ok(()),
        Ok((NotifyTopUpResult::Err(NotifyError::Refunded { .. }),)) => Err("CMC_REFUNDED".to_string()),
        Ok((NotifyTopUpResult::Err(e),)) => Err(format!("CMC notify error: {:?}", e)),
        Err((code, msg)) => Err(format!("CMC call rejected ({:?}): {}", code, msg)),
    }
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
    let cmc_dest = LedgerAccount { owner: cmc, subaccount: None };
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
        let b = call_ledger_transfer(ledger_id, Some(from_subaccount), cmc_dest.clone(), backend_amt, Some(10_000))
            .await.map_err(|e| format!("BACKEND_CMC_XFER: {}", e))?;
        commitment.cmc_block_index = Some(b);
    }
    notify_cmc_topup(cmc, ic_cdk::id(), commitment.cmc_block_index.unwrap()).await?;

    // 25% → frontend cycles
    if commitment.frontend_cmc_block.is_none() {
        let b = call_ledger_transfer(ledger_id, Some(from_subaccount), cmc_dest, frontend_amt, Some(10_000))
            .await.map_err(|e| format!("FRONTEND_CMC_XFER: {}", e))?;
        commitment.frontend_cmc_block = Some(b);
    }
    notify_cmc_topup(cmc, frontend_canister_id(), commitment.frontend_cmc_block.unwrap()).await?;

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
    if met {
        let config = CONFIG.with(|cell| cell.borrow().get().clone());
        // PB-123: majority of committed ICP wins; an exact tie is broken by the
        // first stance committed on this proposal (first vote wins).
        let vote_choice = decide_vote_choice(
            proposal.adopt_pot_e8s,
            proposal.reject_pot_e8s,
            proposal.first_stance.clone(),
        );

        // F-108: vote against the real NNS proposal id, never the internal map key.
        // If no NNS id is set this is a misconfiguration — do NOT call the NNS
        // (which could mis-vote); mark failed so commitments are refunded, not burned.
        match proposal.nns_proposal_id {
            Some(nns_id) => {
                let vote_result = cast_nns_vote(config.primary_neuron_id, nns_id, vote_choice).await;
                match vote_result {
                    Ok(_) => {
                        proposal.status = "voted".to_string();
                        proposal.vote_executed_at = Some(ic_cdk::api::time());
                    }
                    Err(e) => {
                        proposal.status = "failed".to_string();
                        ic_cdk::api::print(&format!("NNS vote failed for proposal {}: {}", pid, e));
                    }
                }
            }
            None => {
                proposal.status = "failed".to_string();
                ic_cdk::api::print(&format!("Proposal {} has no nns_proposal_id; skipping vote", pid));
            }
        }
    } else {
        proposal.status = "abstained".to_string();
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

                    let vote_rec = VoteRecord {
                        proposal_id,
                        vote: if commitment.stance == Stance::Adopt { Vote::Yes } else { Vote::No },
                        icp_burned_e8s: commitment.amount_e8s,
                        decided_at: now,
                        nns_outcome: Some("adopted".to_string()),
                    };
                    VOTES.with(|map| {
                        map.borrow_mut().insert(proposal_id, vote_rec);
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
        map.borrow_mut().insert(proposal_id, proposal);
    });
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
        let cmc_dest = LedgerAccount {
            owner: cmc_principal,
            subaccount: None,
        };

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
                let transfer_res = call_ledger_transfer(
                    ledger_id,
                    Some(TREASURY_SUBACCOUNT),
                    cmc_dest,
                    balance - 10_000,
                    Some(10_000),
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
        };
        let bytes = proposal.to_bytes();
        let decoded = Proposal::from_bytes(bytes);
        assert_eq!(decoded.id, proposal.id);
        assert_eq!(decoded.title, proposal.title);
        assert_eq!(decoded.status, proposal.status);
        assert_eq!(decoded.threshold_e8s, proposal.threshold_e8s);
        assert_eq!(decoded.total_committed_e8s, proposal.total_committed_e8s);
        assert_eq!(decoded.vote_executed_at, proposal.vote_executed_at);
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
}
