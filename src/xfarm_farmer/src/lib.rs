//! xfarm_farmer — a per-user autonomous Farmer canister (X-Farm, Stream B).
//!
//! The backend is a factory: for each paying owner it `create_canister`s one of
//! these, `install_code`s this wasm, and tops it up with cycles (90% of the tier
//! price burned to cycles via the CMC). Two DECOUPLED mechanisms then run (owner
//! directive 2026-06-19):
//!   • A BURN-ONLY daily timer (`burn_only_tick`) deliberately spends a per-day
//!     chunk of the cycle budget REGARDLESS of whether the owner views (R9: the
//!     cycle balance IS the 7-day timer). At the floor it calls the backend's
//!     `report_depleted` so the sweep can stop+delete this canister (D2: nothing
//!     to reclaim — cycles are ~0 by design).
//!   • ON-DEMAND generation (`request_generation`, relayed by the backend when the
//!     owner views) — at most ONCE per UTC day it POSTs to the Cloud-Run Gemini
//!     proxy (FROZEN CONTRACT, `POST /v1/tweets`) and stores the bounded
//!     last-30-days of drafts. A same-day repeat view returns stored drafts with no
//!     outcall; a failed call does NOT consume the day (R8 make-good).
//!
//! The backend (factory) is the sole controller of every Farmer. Guards mirror
//! course_nft: anonymous callers rejected at ingress; the backend or the owner
//! may read drafts/status. LOCAL deploys only — mainnet is gated per-deploy.
//!
//! Open design notes (tracked, not blocking the local build):
//!   • HTTPS outcalls to a non-deterministic LLM are replicated by default on the
//!     IC; the spec's intent is non-replicated outcalls. Mitigated by the proxy
//!     returning schema-typed, low-variance output; the non-replicated transport
//!     is a Phase-2 mainnet concern. Local replica can't reach the external proxy
//!     anyway — local UI states use the backend's `dev_seed_*` path.
//!   • Calibrating the no-op burn to deplete in exactly `duration_days` is Phase-2
//!     tuning (R9 #1: small steady chunks; surface `burned_cycles`). Here the
//!     burn tick measures the real cycle delta around a bounded SHA-256 loop, so
//!     `burned_cycles` is honest regardless of the calibration knob.

use candid::{CandidType, Deserialize, Principal};
use serde::Serialize;
use std::borrow::Cow;
use std::cell::RefCell;
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};

type Memory = VirtualMemory<DefaultMemoryImpl>;

const DAY_NS: u64 = 86_400 * 1_000_000_000;
const DAY_SECS: u64 = 86_400;
/// Stop burning + self-report depleted below this cycle floor.
const DEPLETION_FLOOR_CYCLES: u64 = 1_000_000_000_000; // 1T ≈ one more tick of headroom
/// Bounded no-op compute burn per tick (SHA-256 over a rolling buffer). A
/// calibration knob for the 7-day depletion schedule (R9); the real burned amount
/// is measured as the cycle-balance delta, so this only sets the chunk size.
const BURN_ITERATIONS_PER_TICK: u32 = 200_000;
/// Keep drafts from the last 30 days (bounded; older pruned each tick).
const DRAFT_RETENTION_NS: u64 = 30 * DAY_NS;
/// Cap drafts stored per canister (last-30-days × drafts_per_day ceiling).
const MAX_STORED_DRAFTS: usize = 400;

// ==========================================
// 1. Data Models
// ==========================================

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Draft {
    pub id: u64,
    pub text: String,
    pub created_at: u64,
    pub cited_url: Option<String>,
    pub image_url: Option<String>,
}

/// Persisted init args + runtime counters. The factory passes FarmerInitArgs at
/// install; we store it verbatim and add the running totals.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct FarmerConfig {
    pub farmer_id: u64,
    pub owner: Principal,
    pub backend_canister_id: Principal,
    pub tier_id: u32,
    pub persona: String,
    pub drafts_per_day: u32,
    pub duration_days: u32,
    /// ICP e8s the backend directed to cycles (record only; the cycle balance is
    /// authoritative).
    pub budget_cycles: u64,
    pub proxy_url: String,
    pub proxy_bearer: String,
    pub created_at: u64,
    pub last_generation_at: u64,
    #[serde(default)]
    pub last_burn_tick_at: u64,
    pub last_failure_at: u64,
    pub burned_cycles: u64,
    pub depleted: bool,
}

/// The factory's install arg. Field names match the backend's `FarmerInitArgs`
/// (candid decodes by name, not order).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct FarmerInitArgs {
    pub farmer_id: u64,
    pub owner: Principal,
    pub backend_canister_id: Principal,
    pub tier_id: u32,
    pub persona: String,
    pub drafts_per_day: u32,
    pub duration_days: u32,
    pub budget_cycles: u64,
    pub proxy_url: String,
    pub proxy_bearer: String,
}

// ==========================================
// 2. Stable storage
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

impl_storable!(Draft);
impl_storable!(FarmerConfig);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    // 0 — DRAFTS (id → Draft)
    static DRAFTS: RefCell<StableBTreeMap<u64, Draft, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(0)))));
    // 1 — NEXT_DRAFT_ID
    static NEXT_DRAFT_ID: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(1)), 1)));
    // 2 — CONFIG (init args + runtime counters)
    static CONFIG: RefCell<StableCell<FarmerConfig, Memory>> =
        MEMORY_MANAGER.with(|mm| {
            RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(2)), placeholder_config()))
        });

    // Heap-only: the recurring timer id (lost on upgrade; re-armed in post_upgrade).
    static TIMER_ID: RefCell<Option<ic_cdk_timers::TimerId>> = const { RefCell::new(None) };
}

fn placeholder_config() -> FarmerConfig {
    FarmerConfig {
        farmer_id: 0,
        owner: Principal::anonymous(),
        backend_canister_id: Principal::anonymous(),
        tier_id: 0,
        persona: String::new(),
        drafts_per_day: 0,
        duration_days: 7,
        budget_cycles: 0,
        proxy_url: String::new(),
        proxy_bearer: String::new(),
        created_at: 0,
        last_generation_at: 0,
        last_burn_tick_at: 0,
        last_failure_at: 0,
        burned_cycles: 0,
        depleted: false,
    }
}

fn config() -> FarmerConfig {
    CONFIG.with(|c| c.borrow().get().clone())
}
fn put_config(cfg: FarmerConfig) {
    CONFIG.with(|c| c.borrow_mut().set(cfg));
}
fn now_ns() -> u64 {
    #[cfg(target_arch = "wasm32")]
    { ic_cdk::api::time() }
    #[cfg(not(target_arch = "wasm32"))]
    { 0 }
}
fn self_cycles() -> u64 {
    #[cfg(target_arch = "wasm32")]
    { ic_cdk::api::canister_cycle_balance() as u64 }
    #[cfg(not(target_arch = "wasm32"))]
    { 0 }
}

// ==========================================
// 3. Security Guards
// ==========================================

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_CALLER: RefCell<Principal> = RefCell::new(Principal::anonymous());
    static TEST_MOCK_CONTROLLERS: RefCell<Vec<Principal>> = const { RefCell::new(Vec::new()) };
}

fn get_caller() -> Principal {
    #[cfg(target_arch = "wasm32")]
    { ic_cdk::api::caller() }
    #[cfg(not(target_arch = "wasm32"))]
    { TEST_MOCK_CALLER.with(|cell| *cell.borrow()) }
}

fn caller_is_controller(p: &Principal) -> bool {
    #[cfg(target_arch = "wasm32")]
    { ic_cdk::api::is_controller(p) }
    #[cfg(not(target_arch = "wasm32"))]
    { TEST_MOCK_CONTROLLERS.with(|cell| cell.borrow().contains(p)) }
}

/// Reject anonymous callers at ingress on every update.
#[ic_cdk::inspect_message]
fn inspect_message() {
    if get_caller() == Principal::anonymous() {
        ic_cdk::trap("Anonymous callers are not permitted");
    }
    ic_cdk::api::call::accept_message();
}

fn require_authenticated() -> Result<(), String> {
    if get_caller() == Principal::anonymous() {
        return Err("ANONYMOUS_NOT_ALLOWED".to_string());
    }
    Ok(())
}

/// Only the backend (factory, sole controller) or the owner may read drafts /
/// status. Other principals (including other canisters) are rejected.
fn require_backend_or_owner() -> Result<(), String> {
    let caller = get_caller();
    let cfg = config();
    if caller == cfg.backend_canister_id
        || caller == cfg.owner
        || caller_is_controller(&caller)
    {
        return Ok(());
    }
    Err("NOT_AUTHORIZED".to_string())
}

// ==========================================
// 4. Init & Post Upgrade
// ==========================================

#[ic_cdk::init]
fn init(args: FarmerInitArgs) {
    let cfg = FarmerConfig {
        farmer_id: args.farmer_id,
        owner: args.owner,
        backend_canister_id: args.backend_canister_id,
        tier_id: args.tier_id,
        persona: args.persona,
        drafts_per_day: args.drafts_per_day,
        duration_days: args.duration_days,
        budget_cycles: args.budget_cycles,
        proxy_url: args.proxy_url,
        proxy_bearer: args.proxy_bearer,
        created_at: now_ns(),
        last_generation_at: 0,
        last_burn_tick_at: 0,
        last_failure_at: 0,
        burned_cycles: 0,
        depleted: false,
    };
    put_config(cfg);
    arm_timers();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable structures auto-restore; only the heap timer id is lost.
    arm_timers();
}

fn arm_timers() {
    // BURN-ONLY timer (decoupled from generation, owner directive 2026-06-19): the
    // daily tick deliberately burns a chunk of the 7-day budget regardless of whether
    // the owner views — generation is now on-demand via `request_generation`, NOT here.
    // set_timer_interval takes a closure returning a future (ic-cdk-timers 1.0.0 API).
    let id = ic_cdk_timers::set_timer_interval(std::time::Duration::from_secs(DAY_SECS), || async {
        burn_only_tick().await;
    });
    TIMER_ID.with(|t| *t.borrow_mut() = Some(id));
}

// ==========================================
// 5. The daily tick — outcall + burn + depletion
// ==========================================

/// FROZEN CONTRACT request/response (Stream A's proxy). Keep these in lockstep
/// with ideas/x-farm/PARALLEL-WORK.md.
#[derive(Serialize, Clone, Debug)]
struct TweetRequest<'a> {
    drafts_per_day: u32,
    persona: &'a str,
    history: Vec<&'a str>,
    /// FROZEN CONTRACT optional field: enables the proxy's per-caller daily cap +
    /// log attribution. = "farmer-{id}".
    caller_id: String,
}
#[derive(Deserialize, Debug)]
struct TweetItem {
    text: String,
    cited_url: Option<String>,
}
#[derive(Deserialize, Debug)]
struct TweetResponse {
    drafts: Vec<TweetItem>,
}

// Management-canister `http_request` arg structs (inline, like the backend's
// CanisterIdRecord pattern — no vendored ic-management crate).
#[derive(CandidType, Serialize, Deserialize, Clone)]
struct HttpHeader { name: String, value: String }
#[derive(CandidType, Serialize, Clone)]
enum HttpMethod { GET, POST, PUT, DELETE }
#[derive(CandidType, Serialize)]
struct HttpRequestArgs {
    url: String,
    max_response_bytes: Option<u64>,
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
    method: HttpMethod,
    transform: Option<TransformArgs>,
}
#[derive(CandidType, Serialize, Clone)]
struct TransformArgs {
    function: (Principal, String),
    context: Vec<u8>,
}
#[derive(CandidType, Deserialize)]
struct HttpResponse {
    status: u64,
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
}

async fn generate_drafts(cfg: &FarmerConfig) -> Result<TweetResponse, String> {
    if cfg.proxy_url.is_empty() {
        return Err("PROXY_NOT_CONFIGURED".to_string());
    }
    // history = last N draft texts (don't repeat).
    let history: Vec<String> = recent_draft_texts(cfg.drafts_per_day as usize);
    let req = TweetRequest {
        drafts_per_day: cfg.drafts_per_day,
        persona: &cfg.persona,
        history: history.iter().map(|s| s.as_str()).collect(),
        caller_id: format!("farmer-{}", cfg.farmer_id),
    };
    let body = serde_json::to_vec(&req).map_err(|e| format!("ENCODE_REQ: {}", e))?;
    let args = HttpRequestArgs {
        url: format!("{}/v1/tweets", cfg.proxy_url.trim_end_matches('/')),
        max_response_bytes: Some(2048),
        headers: vec![
            HttpHeader { name: "Content-Type".into(), value: "application/json".into() },
            HttpHeader { name: "Authorization".into(), value: format!("Bearer {}", cfg.proxy_bearer) },
        ],
        body,
        method: HttpMethod::POST,
        transform: None,
    };
    let res: Result<(HttpResponse,), _> =
        ic_cdk::call(Principal::management_canister(), "http_request", (args,)).await;
    match res {
        Ok((resp,)) => parse_proxy_response(resp.status, &resp.body),
        Err((code, msg)) => Err(format!("OUTCALL ({:?}): {}", code, msg)),
    }
}

/// Pure: map a proxy HTTP response (status + body) to drafts, or a Failed-day
/// error. Extracted from `generate_drafts` so the parse path + the R8
/// non-2xx→Failed-day trigger are unit-testable without the cdk. A non-2xx
/// status (502/501/401/422) returns `PROXY_STATUS_<n>`, which `daily_tick`'s
/// match arm treats as a Failed day → burn tick SKIPPED (R8 make-good).
fn parse_proxy_response(status: u64, body: &[u8]) -> Result<TweetResponse, String> {
    if status >= 200 && status < 300 {
        serde_json::from_slice::<TweetResponse>(body)
            .map_err(|e| format!("PARSE_DRAFTS: {}", e))
    } else {
        Err(format!("PROXY_STATUS_{}", status)) // 502 etc → Failed day (R8)
    }
}

fn recent_draft_texts(n: usize) -> Vec<String> {
    DRAFTS.with(|m| {
        let map = m.borrow();
        let mut out: Vec<String> = map.iter().rev().take(n).map(|e| e.value().text.clone()).collect();
        out.reverse();
        out
    })
}

fn store_drafts(items: Vec<TweetItem>, created_at: u64) {
    DRAFTS.with(|m| {
        let mut map = m.borrow_mut();
        for item in items {
            let id = NEXT_DRAFT_ID.with(|c| { let v = *c.borrow().get(); c.borrow_mut().set(v + 1); v });
            map.insert(id, Draft {
                id,
                text: item.text,
                created_at,
                cited_url: item.cited_url,
                image_url: None, // D9 premium image wired in Phase-2 (Nano Banana 2).
            });
        }
        prune_drafts(&mut map, created_at);
    });
}

fn prune_drafts(map: &mut StableBTreeMap<u64, Draft, Memory>, now: u64) {
    let cutoff = now.saturating_sub(DRAFT_RETENTION_NS);
    // Drop drafts older than the retention window, then enforce the hard cap.
    let stale: Vec<u64> = map.iter()
        .filter(|e| e.value().created_at < cutoff)
        .map(|e| *e.key())
        .collect();
    for id in stale { map.remove(&id); }
    while map.len() > MAX_STORED_DRAFTS as u64 {
        if let Some(first) = map.iter().next() {
            let id = *first.key();
            map.remove(&id);
        } else { break; }
    }
}

/// R9: a bounded no-op compute burn that spends a per-day chunk of the cycle
/// budget. The real burned amount is the cycle-balance delta around the loop, so
/// `burned_cycles` is honest regardless of the iteration knob.
fn burn_tick() -> u64 {
    use sha2::Digest;
    let before = self_cycles();
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64];
    for i in 0..BURN_ITERATIONS_PER_TICK {
        // i is u32 → 4 bytes; write into the low half of the 64-byte buffer.
        buf[..4].copy_from_slice(&i.to_le_bytes());
        hasher.update(&buf);
        // periodically reset to keep the digest bounded (avoid unbounded state growth)
        if i % 4096 == 0 {
            let _ = hasher.clone().finalize_reset();
        }
    }
    let _ = hasher.finalize();
    before.saturating_sub(self_cycles())
}

/// Same UTC day iff the two ns timestamps fall in the same 86_400s bucket.
fn same_utc_day(a: u64, b: u64) -> bool {
    a / DAY_NS == b / DAY_NS
}

/// All retained drafts (newest pruning already applied on store).
fn all_drafts() -> Vec<Draft> {
    DRAFTS.with(|m| m.borrow().iter().map(|e| e.value().clone()).collect())
}

/// BURN-ONLY daily tick (decoupled from generation — owner directive 2026-06-19).
/// Deliberately spends a chunk of the 7-day budget every day REGARDLESS of whether
/// the owner views (R9). When the balance hits the floor → mark depleted, report to
/// the backend sweep, stop the timer. Generation no longer happens here — it's
/// on-demand via `request_generation`.
async fn burn_only_tick() {
    let mut cfg = config();
    if cfg.depleted { return; }

    let now = now_ns();
    let burned = burn_tick();
    cfg.burned_cycles = cfg.burned_cycles.saturating_add(burned);
    cfg.last_burn_tick_at = now;

    // Depletion check (D2): the cycle balance is the 7-day timer.
    let cycles = self_cycles();
    if cycles <= DEPLETION_FLOOR_CYCLES {
        cfg.depleted = true;
        put_config(cfg.clone());
        // Tell the backend so its sweep can stop+delete this canister.
        let _ = ic_cdk::call::<(u64, u64), (Result<(), String>,)>(
            cfg.backend_canister_id,
            "report_depleted",
            (cfg.farmer_id, cfg.burned_cycles),
        ).await;
        // Stop the recurring timer; nothing left to burn.
        if let Some(id) = TIMER_ID.with(|t| t.borrow_mut().take()) {
            ic_cdk_timers::clear_timer(id);
        }
        return;
    }
    put_config(cfg);
}

/// ON-DEMAND generation (owner directive 2026-06-19): tweets are requested only when
/// the owner views their Farmer, at most ONCE per UTC day. The backend relays the
/// owner's view here. A same-day repeat view returns the stored drafts with NO
/// outcall; a failed proxy call does NOT consume the day (owner can retry).
#[ic_cdk::update]
async fn request_generation(_farmer_id: u64) -> Result<Vec<Draft>, String> {
    require_backend_or_owner()?;
    let mut cfg = config();
    if cfg.depleted {
        return Ok(all_drafts());
    }
    let now = now_ns();
    // Throttle: at most one proxy call per UTC day.
    if cfg.last_generation_at > 0 && same_utc_day(cfg.last_generation_at, now) {
        return Ok(all_drafts());
    }
    match generate_drafts(&cfg).await {
        Ok(resp) => {
            store_drafts(resp.drafts, now);
            cfg.last_generation_at = now;
            put_config(cfg);
            Ok(all_drafts())
        }
        Err(e) => {
            // R8: a failed attempt must NOT consume the day (no last_generation_at set).
            cfg.last_failure_at = now;
            put_config(cfg);
            Err(e)
        }
    }
}

// ==========================================
// 6. Public queries (called by the backend, which proxies them to the owner)
// ==========================================

/// Drafts created at/after `since` (ns). Backend → owner UI.
#[ic_cdk::query]
fn get_drafts(since: u64) -> Result<Vec<Draft>, String> {
    require_backend_or_owner()?;
    Ok(DRAFTS.with(|m| {
        m.borrow().iter()
            .filter(|e| e.value().created_at >= since)
            .map(|e| e.value().clone())
            .collect()
    }))
}

/// (cycles_remaining, next_generation_at) — the live 7-day timer. The `farmer_id`
/// arg is accepted for API symmetry with the backend's inter-canister call.
#[ic_cdk::query]
fn get_status(_farmer_id: u64) -> Result<(u64, u64), String> {
    require_backend_or_owner()?;
    let cfg = config();
    let next_gen = cfg.last_generation_at.saturating_add(DAY_NS);
    Ok((self_cycles(), next_gen))
}

/// The owner's own config snapshot (dashboard status row).
#[ic_cdk::query]
fn get_my_config() -> Result<FarmerConfig, String> {
    require_backend_or_owner()?;
    Ok(config())
}

/// RENEW: extend this Farmer's lifespan after the owner pays again. The backend
/// (factory) deposits the additional cycles via CMC topup BEFORE calling this, so
/// here we only update the budget/duration bookkeeping and RE-ARM the burn timer if
/// depletion had cleared it. Backend/controller-only — the owner can't self-extend
/// without paying (that goes through the backend's `renew_farmer`).
#[ic_cdk::update]
fn extend(add_budget_cycles: u64, add_days: u32) -> Result<(), String> {
    let caller = get_caller();
    let mut cfg = config();
    if caller != cfg.backend_canister_id && !caller_is_controller(&caller) {
        return Err("NOT_BACKEND".to_string());
    }
    cfg.depleted = false;
    cfg.budget_cycles = cfg.budget_cycles.saturating_add(add_budget_cycles);
    cfg.duration_days = cfg.duration_days.saturating_add(add_days);
    put_config(cfg);
    // Re-arm the burn timer if depletion had stopped it (TIMER_ID taken).
    if TIMER_ID.with(|t| t.borrow().is_none()) {
        arm_timers();
    }
    Ok(())
}

ic_cdk::export_candid!();

// =============================================================================
// Tests (host). The daily_tick inter-canister http_request path is a PocketIC
// integration concern; here we cover the pure logic it delegates to: the proxy
// response parse + the R8 non-2xx→Failed-day trigger, and the bounded draft
// store (retention window + hard cap). burn_tick's cycle-delta math is 0 on host
// (self_cycles() is a no-op off-wasm) — its calibration is Phase-2 R9 tuning.
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    fn clear_drafts() {
        DRAFTS.with(|m| {
            let keys: Vec<u64> = m.borrow().iter().map(|e| *e.key()).collect();
            let mut map = m.borrow_mut();
            for k in keys { map.remove(&k); }
        });
        NEXT_DRAFT_ID.with(|c| c.borrow_mut().set(1));
    }

    #[test]
    fn test_proxy_response_parse_and_failed_day_trigger() {
        // 200 with a valid body (cited_url present) → Ok with drafts.
        let body = br#"{"drafts":[{"text":"ICP settled block N, fees burned forever - the thesis holds.","cited_url":"https://dashboard.internetcomputer.org/"}]}"#;
        let resp = parse_proxy_response(200, body).unwrap();
        assert_eq!(resp.drafts.len(), 1);
        assert_eq!(resp.drafts[0].text, "ICP settled block N, fees burned forever - the thesis holds.");
        assert_eq!(resp.drafts[0].cited_url.as_deref(), Some("https://dashboard.internetcomputer.org/"));

        // 200 with a body missing the optional cited_url → Ok (Option deserializes to None).
        let body = br#"{"drafts":[{"text":"gm maxis"}]}"#;
        let resp = parse_proxy_response(200, body).unwrap();
        assert_eq!(resp.drafts[0].cited_url, None);

        // 200 with a malformed body → PARSE_DRAFTS error (a Failed-day trigger).
        let err = parse_proxy_response(200, b"not json").unwrap_err();
        assert!(err.starts_with("PARSE_DRAFTS"), "{}", err);

        // 200 with a body missing the required `drafts` field → PARSE_DRAFTS.
        let err = parse_proxy_response(200, br#"{"oops":1}"#).unwrap_err();
        assert!(err.starts_with("PARSE_DRAFTS"));

        // Non-2xx → PROXY_STATUS_<n> (R8 Failed-day trigger: daily_tick skips burn).
        assert_eq!(parse_proxy_response(502, b"").unwrap_err(), "PROXY_STATUS_502");
        assert_eq!(parse_proxy_response(501, b"").unwrap_err(), "PROXY_STATUS_501");
        assert_eq!(parse_proxy_response(401, b"").unwrap_err(), "PROXY_STATUS_401");
        assert_eq!(parse_proxy_response(422, b"").unwrap_err(), "PROXY_STATUS_422");
    }

    #[test]
    fn test_draft_pruning_retention_and_cap() {
        clear_drafts();
        let now: u64 = 1_000_000_000_000_000_000; // a fixed "now" (ns), well above 31·DAY_NS

        // Retention: a 31-day-old draft is pruned; a 29-day-old draft is retained.
        DRAFTS.with(|m| {
            let mut map = m.borrow_mut();
            map.insert(1, Draft {
                id: 1, text: "stale".into(),
                created_at: now.saturating_sub(31 * DAY_NS),
                cited_url: None, image_url: None,
            });
            map.insert(2, Draft {
                id: 2, text: "inside".into(),
                created_at: now.saturating_sub(29 * DAY_NS),
                cited_url: None, image_url: None,
            });
            prune_drafts(&mut map, now);
            assert!(map.get(&1).is_none(), "31-day-old draft pruned");
            assert!(map.get(&2).is_some(), "29-day-old draft retained");
        });

        // Cap: MAX+5 recent drafts → cap evicts the 5 lowest-id (oldest), keeps
        // exactly MAX, with the newest retained.
        clear_drafts();
        DRAFTS.with(|m| {
            let mut map = m.borrow_mut();
            let total = (MAX_STORED_DRAFTS as u64) + 5;
            for i in 1..=total {
                map.insert(i, Draft {
                    id: i, text: format!("d{}", i), created_at: now,
                    cited_url: None, image_url: None,
                });
            }
            assert_eq!(map.len() as u64, total);
            prune_drafts(&mut map, now);
            assert_eq!(map.len() as usize, MAX_STORED_DRAFTS, "hard cap enforced");
            assert!(map.get(&1).is_none(), "oldest evicted by cap");
            assert!(map.get(&5).is_none(), "5th-oldest evicted by cap");
            assert!(map.get(&6).is_some(), "6th-oldest is the first retained");
            assert!(map.get(&total).is_some(), "newest draft retained");
        });
        clear_drafts();
    }

    #[test]
    fn test_same_utc_day() {
        let day = 100u64 * DAY_NS;
        let one_am = day + 3600 * 1_000_000_000; // 01:00 on day 100
        // +1h → 02:00 same day
        assert!(same_utc_day(one_am, one_am + 3600 * 1_000_000_000));
        // +25h → crosses into day 101
        assert!(!same_utc_day(one_am, one_am + 25 * 3600 * 1_000_000_000));
        // exact day boundary is a different bucket
        assert!(!same_utc_day(day, day.saturating_sub(1)));
    }

    #[test]
    fn test_burn_tick_does_not_trap_on_host() {
        // On host self_cycles() is 0, so the measured delta is 0 — the burn
        // tick's job here is only to NOT panic; the real cycle-delta math runs
        // on-wasm and is calibrated in Phase-2 (R9). Sanity: returns a u64.
        let burned = burn_tick();
        assert_eq!(burned, 0, "host has no cycle balance → delta is 0");
    }
}