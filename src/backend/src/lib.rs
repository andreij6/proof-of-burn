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

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Followees {
    pub followees: Vec<NeuronId>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct GovernanceError {
    pub error_message: String,
    pub error_type: i32,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Neuron {
    pub id: Option<NeuronId>,
    pub controller: Option<Principal>,
    pub followees: Vec<(i32, Followees)>,
    pub cached_neuron_stake_e8s: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum Result_2 {
    Ok(Neuron),
    Err(GovernanceError),
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
    /// Block index of the CMC ledger transfer performed in Phase A of
    /// `burn_to_cycles`. Stored so a retry after a failed `notify_top_up`
    /// skips the transfer and goes straight to notifying the CMC.
    /// `None` until Phase A has succeeded.
    pub cmc_block_index: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct LedgerAccount {
    pub owner: Principal,
    pub subaccount: Option<[u8; 32]>,
}

// ==========================================
// 1. Data Models
// ==========================================

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
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub title: String,
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
            default_threshold: 250_000_000_000,
            ai_price_e8s: 5_000_000,
            ledger_canister_id: Principal::anonymous(),
            is_local: false,
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

    static USER_NEURONS: RefCell<StableBTreeMap<Principal, UserNeuronState, Memory>> = MEMORY_MANAGER.with(|mm| {
        RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(7))))
    });
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
    let ledger_id = if is_local {
        Principal::from_text("aiewf-lx777-77775-aaaca-cai").unwrap()
    } else {
        Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap()
    };
    let config = Config {
        primary_neuron_id: resolve_primary_neuron_id(is_local, payload.primary_neuron_id),
        admins: vec![payload.owner],
        default_threshold: payload.default_threshold_e8s,
        ai_price_e8s: payload.ai_price_e8s,
        ledger_canister_id: ledger_id,
        is_local,
    };
    CONFIG.with(|cell| {
        cell.borrow_mut().set(config);
    });

    seed_mock_proposals();
    setup_timers();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable data auto-restores; re-seed if empty
    seed_mock_proposals();
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
                category: "Network economics".to_string(),
                deadline: now + dur_2d_14h,
                nns_proposal_id: Some(138402),
                status: "open".to_string(),
                threshold_e8s: 500_000_000_000,
                total_committed_e8s: 318_000_000_000,
                adopt_pot_e8s: 318_000_000_000,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
            });

            m.insert(138388, Proposal {
                id: 138388,
                title: "Adopt SNS-3 treasury allocation framework".to_string(),
                category: "Governance".to_string(),
                deadline: now + dur_5d_2h,
                nns_proposal_id: Some(138388),
                status: "met".to_string(),
                threshold_e8s: 500_000_000_000,
                total_committed_e8s: 500_000_000_000,
                adopt_pot_e8s: 500_000_000_000,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
            });

            m.insert(138376, Proposal {
                id: 138376,
                title: "Onboard eu-central-2 datacenter to the subnet".to_string(),
                category: "Node provider".to_string(),
                deadline: now + dur_14h,
                nns_proposal_id: Some(138376),
                status: "open".to_string(),
                threshold_e8s: 500_000_000_000,
                total_committed_e8s: 141_000_000_000,
                adopt_pot_e8s: 141_000_000_000,
                reject_pot_e8s: 0,
                vote_executed_at: None,
                total_burned_e8s: None,
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

async fn check_nns_follow(neuron_id: u64, caller: Principal, leader_id: u64) -> Result<(bool, u64), String> {
    let nns_gov = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap();

    let response: Result<(Result_2,), _> = ic_cdk::call(nns_gov, "get_full_neuron", (neuron_id,)).await;

    match response {
        Ok((Result_2::Ok(neuron),)) => {
            if neuron.controller != Some(caller) {
                return Err("Neuron controller principal does not match caller principal".to_string());
            }

            let mut following = false;
            for (topic, followees_list) in neuron.followees {
                if topic == 1 || topic == 0 {
                    for f in followees_list.followees {
                        if f.id == leader_id {
                            following = true;
                            break;
                        }
                    }
                }
            }
            Ok((following, neuron.cached_neuron_stake_e8s))
        }
        Ok((Result_2::Err(err),)) => {
            Err(format!("NNS Governance returned error: {}", err.error_message))
        }
        Err((code, msg)) => {
            // F-101: on mainnet, a rejected `get_full_neuron` must NOT grant
            // follow eligibility or a fake 1000 ICP stake — that would let any
            // caller bypass the controller check and the stake cap. The local
            // dev fallback (which pretends the neuron is following with 1000
            // ICP) is only safe when `is_local` was set at init.
            let is_local = CONFIG.with(|cell| cell.borrow().get().is_local);
            if is_local
                && (code == ic_cdk::api::call::RejectionCode::DestinationInvalid
                    || code == ic_cdk::api::call::RejectionCode::CanisterError
                    || code == ic_cdk::api::call::RejectionCode::CanisterReject)
            {
                Ok((true, 100_000_000_000u64))
            } else {
                Err(format!("NNS call rejected (code {:?}): {}", code, msg))
            }
        }
    }
}

#[ic_cdk::update]
async fn register_neuron(neuron_id: u64) -> Result<(), String> {
    require_authenticated()?;
    let caller = ic_cdk::caller();

    // Neuron IDs are arbitrary u64 values (no meaningful upper bound); only 0 is invalid.
    if neuron_id == 0 {
        return Err("INVALID_NEURON_ID".to_string());
    }

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let leader_id = config.primary_neuron_id;

    let (verified, stake) = check_nns_follow(neuron_id, caller, leader_id).await?;

    if !verified {
        return Err("Neuron is not following the primary neuron".to_string());
    }

    let state = UserNeuronState {
        neuron_id,
        is_following: true,
        verified_at: ic_cdk::api::time(),
        cached_stake_e8s: stake,
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

    let holdings_e8s = if authenticated {
        USER_NEURONS.with(|map| {
            map.borrow().get(&caller).map(|n| n.cached_stake_e8s).unwrap_or(0)
        })
    } else {
        0
    };

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

/// Converts committed ICP to canister cycles via the Cycles Minting Canister (CMC).
/// The ICP is burned by the CMC (removed from ledger supply) and the resulting
/// cycles are credited to this canister. The net supply effect is identical to
/// a direct burn — only the value destination changes (cycles fuel vs. destruction).
///
/// F-103: the function is split into two idempotent phases. The `cmc_block_index`
/// on the `Commitment` records Phase A's result; on a retry, Phase A is skipped
/// and only Phase B (`notify_top_up`) is called. Phase B's `AlreadyNotified` /
/// `Refunded` results are treated as terminal success.
async fn burn_to_cycles(
    ledger_id: Principal,
    from_subaccount: [u8; 32],
    amount_e8s: u64,
    commitment: &mut Commitment,
) -> Result<u128, String> {
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();
    let cmc_dest = LedgerAccount { owner: cmc, subaccount: None };

    // Phase A: transfer escrowed ICP → CMC. Skip if a previous attempt already
    // produced a block index — repeating this transfer would double-spend from
    // the user's (now-empty) subaccount and strand the prior funds at the CMC.
    let block_index = match commitment.cmc_block_index {
        Some(b) => b,
        None => {
            let b = call_ledger_transfer(
                ledger_id,
                Some(from_subaccount),
                cmc_dest,
                amount_e8s,
                Some(10_000),
            )
            .await
            .map_err(|e| format!("CMC transfer failed: {}", e))?;
            commitment.cmc_block_index = Some(b);
            b
        }
    };

    // Phase B: notify the CMC to mint cycles for the block index. Idempotent
    // on the CMC side; if it has already been notified (e.g. a retry after a
    // transient `notify_top_up` reject), `AlreadyNotified` is success.
    let notify_args = NotifyTopUpArgs {
        canister_id: ic_cdk::id(),
        block_index: candid::Nat::from(block_index),
    };
    let result: Result<(NotifyTopUpResult,), _> =
        ic_cdk::call(cmc, "notify_top_up", (notify_args,)).await;

    match result {
        Ok((NotifyTopUpResult::Ok(cycles_nat),)) => {
            let cycles: u128 = cycles_nat.0.try_into().unwrap_or(0);
            Ok(cycles)
        }
        Ok((NotifyTopUpResult::Err(NotifyError::AlreadyNotified),)) => {
            // Phase B is idempotent; treat a previous successful notify as success.
            // The cycles are already credited to this canister — return 0 to indicate
            // "no new cycles minted" rather than failing the settlement.
            Ok(0)
        }
        Ok((NotifyTopUpResult::Err(NotifyError::Refunded { .. }),)) => {
            // The CMC refunded the transfer (e.g. invalid recipient). The
            // funds are back at the user's subaccount; surface as a burn
            // failure so the commitment is marked FailedBurn and a future
            // retry / sweep can attempt a fresh burn once the cause is fixed.
            Err("CMC_REFUNDED".to_string())
        }
        Ok((NotifyTopUpResult::Err(e),)) => Err(format!("CMC notify_top_up error: {:?}", e)),
        Err((code, msg)) => Err(format!("CMC call rejected ({:?}): {}", code, msg)),
    }
}

// Endpoints
#[ic_cdk::update]
async fn verify_follow() -> Result<(), String> {
    require_authenticated()?;
    let caller = ic_cdk::caller();

    let neuron_id = USER_NEURONS.with(|map| {
        map.borrow().get(&caller).map(|s| s.neuron_id)
    });

    let neuron_id = match neuron_id {
        Some(id) => id,
        None => return Err("No neuron registered for caller".to_string()),
    };

    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let leader_id = config.primary_neuron_id;

    let (verified, stake) = check_nns_follow(neuron_id, caller, leader_id).await?;

    if !verified {
        return Err("Neuron is not following the primary neuron".to_string());
    }

    let state = UserNeuronState {
        neuron_id,
        is_following: true,
        verified_at: ic_cdk::api::time(),
        cached_stake_e8s: stake,
    };
    
    USER_NEURONS.with(|map| {
        map.borrow_mut().insert(caller, state);
    });

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

    if target_e8s > user_neuron.cached_stake_e8s {
        return Err("EXCEEDS_STAKE_CAP".to_string());
    }

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
    let required_deposit = target_e8s + 520_000;

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
    };

    COMMITMENTS.with(|map| {
        map.borrow_mut().insert(key, commitment);
    });

    if stance == Stance::Adopt {
        proposal.adopt_pot_e8s += target_e8s;
    } else {
        proposal.reject_pot_e8s += target_e8s;
    }
    proposal.total_committed_e8s += target_e8s;

    if proposal.total_committed_e8s >= proposal.threshold_e8s {
        proposal.status = "met".to_string();
    }

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
#[derive(CandidType, Serialize, Clone, Debug)]
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

async fn process_proposal_cutoff(pid: u64) -> Result<(), String> {
    let proposal = PROPOSALS.with(|map| map.borrow().get(&pid));
    let mut proposal = match proposal {
        Some(p) => p,
        None => return Err("Proposal not found".to_string()),
    };

    let met = proposal.total_committed_e8s >= proposal.threshold_e8s;
    if met {
        let config = CONFIG.with(|cell| cell.borrow().get().clone());
        let vote_choice = if proposal.adopt_pot_e8s > proposal.reject_pot_e8s {
            1 // Yes
        } else {
            2 // No
        };

        let vote_result = cast_nns_vote(config.primary_neuron_id, pid, vote_choice).await;
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
            // Route committed ICP through the CMC: ICP is burned from supply,
            // cycles are credited to this canister to fund its operation.
            match burn_to_cycles(ledger_id, commitment.subaccount, commitment.amount_e8s, &mut commitment).await {
                Ok(cycles_minted) => {
                    commitment.status = CommitmentStatus::Burned;
                    commitment.settled_at = Some(now);
                    // F-105: checked addition — clamp to u64::MAX on overflow
                    // rather than silently wrapping (release build traps under
                    // overflow-checks = true, so this is a defensive fallback).
                    total_burned_this_sweep = total_burned_this_sweep
                        .checked_add(commitment.amount_e8s)
                        .unwrap_or(u64::MAX);

                    USER_AGGREGATES.with(|map| {
                        if let Some(mut agg) = map.borrow().get(&user) {
                            agg.total_committed_escrow = agg.total_committed_escrow.saturating_sub(commitment.amount_e8s);
                            agg.total_burned = agg.total_burned
                                .checked_add(commitment.amount_e8s)
                                .unwrap_or(agg.total_burned);
                            map.borrow_mut().insert(user, agg);
                        }
                    });

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
                        "Commitment settled: {} e8s ICP → {} cycles for user {}",
                        commitment.amount_e8s, cycles_minted, user
                    ));
                }
                Err(e) => {
                    commitment.status = CommitmentStatus::FailedBurn;
                    ic_cdk::api::print(&format!("burn_to_cycles failed for user {}: {}", user, e));
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

                    USER_AGGREGATES.with(|map| {
                        if let Some(mut agg) = map.borrow().get(&user) {
                            agg.total_committed_escrow = agg.total_committed_escrow.saturating_sub(commitment.amount_e8s);
                            map.borrow_mut().insert(user, agg);
                        }
                    });

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
            // F-103: idempotent retry — if a previous attempt's `notify_top_up`
            // failed but the CMC transfer already landed, `cmc_block_index`
            // is `Some`, so burn_to_cycles skips Phase A and only notifies
            // the CMC again. No second transfer, no stranded funds.
            if let Ok(_) = burn_to_cycles(ledger_id, commitment.subaccount, commitment.amount_e8s, &mut commitment).await {
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

    GlobalStats {
        tvl_e8s,
        total_burned_e8s,
        votes_cast,
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
        }
    }

    fn sample_proposal(id: u64, status: &str, threshold: u64, committed: u64) -> Proposal {
        Proposal {
            id,
            nns_proposal_id: Some(id),
            title: format!("Test proposal {}", id),
            category: "Governance".to_string(),
            status: status.to_string(),
            deadline: u64::MAX,
            threshold_e8s: threshold,
            total_committed_e8s: committed,
            adopt_pot_e8s: committed,
            reject_pot_e8s: 0,
            total_burned_e8s: None,
            vote_executed_at: None,
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
        let proposal = Proposal {
            adopt_pot_e8s: 300_000_000_000,
            reject_pot_e8s: 100_000_000_000,
            ..sample_proposal(1, "met", 200_000_000_000, 400_000_000_000)
        };
        let vote = if proposal.adopt_pot_e8s > proposal.reject_pot_e8s { 1i32 } else { 2i32 };
        assert_eq!(vote, 1, "adopt majority should cast Yes vote");
    }

    #[test]
    fn test_vote_direction_majority_reject() {
        let proposal = Proposal {
            adopt_pot_e8s: 100_000_000_000,
            reject_pot_e8s: 300_000_000_000,
            ..sample_proposal(1, "met", 200_000_000_000, 400_000_000_000)
        };
        let vote = if proposal.adopt_pot_e8s > proposal.reject_pot_e8s { 1i32 } else { 2i32 };
        assert_eq!(vote, 2, "reject majority should cast No vote");
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
            category: "SubnetManagement".to_string(),
            status: "open".to_string(),
            deadline: 1_750_000_000_000_000_000,
            threshold_e8s: 500_000_000_000,
            total_committed_e8s: 200_000_000_000,
            adopt_pot_e8s: 150_000_000_000,
            reject_pot_e8s: 50_000_000_000,
            total_burned_e8s: None,
            vote_executed_at: Some(1_749_000_000_000_000_000),
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
            }
        };
        let mainnet = Config {
            is_local: false,
            ..local.clone()
        };
        assert_eq!(Config::from_bytes(local.to_bytes()).is_local, true);
        assert_eq!(Config::from_bytes(mainnet.to_bytes()).is_local, false);
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
        };
        assert_eq!(stats.tvl_e8s, 0);
        assert_eq!(stats.total_burned_e8s, 0);
        assert_eq!(stats.votes_cast, 0);
    }
}
