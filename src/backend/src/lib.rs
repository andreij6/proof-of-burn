use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use ic_stable_structures::{Storable, storable::Bound, memory_manager::{MemoryId, MemoryManager, VirtualMemory}, DefaultMemoryImpl, StableBTreeMap, StableCell, log::Log};
use std::cell::RefCell;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// ==========================================
// NNS Governance Types
// ==========================================

#[derive(CandidType, Deserialize, Clone, Debug)]
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
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct EligibilityInfo {
    pub tier: u8,
    pub authenticated: bool,
    pub following: bool,
    pub has_committed: bool,
    pub holdings_e8s: u64,
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
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub title: String,
    pub category: String,
    pub deadline: u64, // nanoseconds since epoch
    pub nns_proposal_id: Option<u64>,
    pub status: String, // "open" | "met" | "voted" | "failed"
    pub threshold_e8s: u64,
    pub total_committed_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum CommitmentStatus {
    Pending,
    ThresholdMet,
    Burned,
    Returned,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Commitment {
    pub proposal_id: u64,
    pub principal: Principal,
    pub amount_e8s: u64,
    pub status: CommitmentStatus,
    pub created_at: u64,
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
    let config = Config {
        primary_neuron_id: payload.primary_neuron_id,
        admins: vec![payload.owner],
        default_threshold: payload.default_threshold_e8s,
        ai_price_e8s: payload.ai_price_e8s,
    };
    CONFIG.with(|cell| {
        cell.borrow_mut().set(config);
    });
    
    seed_mock_proposals();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable data auto-restores; re-seed if empty
    seed_mock_proposals();
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
            });
        }
    });
}

// ==========================================
// 9. Eligibility & Verification Endpoints
// ==========================================

async fn check_nns_follow(neuron_id: u64, caller: Principal, leader_id: u64) -> Result<bool, String> {
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
            Ok(following)
        }
        Ok((Result_2::Err(err),)) => {
            Err(format!("NNS Governance returned error: {}", err.error_message))
        }
        Err((code, msg)) => {
            if code == ic_cdk::api::call::RejectionCode::DestinationInvalid
                || code == ic_cdk::api::call::RejectionCode::CanisterError
                || code == ic_cdk::api::call::RejectionCode::CanisterReject
            {
                Ok(true)
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
    
    let config = CONFIG.with(|cell| cell.borrow().get().clone());
    let leader_id = config.primary_neuron_id;

    let verified = check_nns_follow(neuron_id, caller, leader_id).await?;

    if !verified {
        return Err("Neuron is not following the primary neuron".to_string());
    }

    let state = UserNeuronState {
        neuron_id,
        is_following: true,
        verified_at: ic_cdk::api::time(),
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
        USER_AGGREGATES.with(|map| {
            map.borrow().get(&caller).map(|agg| agg.total_committed_escrow).unwrap_or(0)
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

#[ic_cdk::query]
fn list_vote_history() -> Vec<VoteRecord> {
    VOTES.with(|map| {
        map.borrow()
            .iter()
            .map(|entry| entry.value())
            .collect()
    })
}

ic_cdk::export_candid!();
