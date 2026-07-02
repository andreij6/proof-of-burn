//! course_nft — ICRC-7 NFT ledger for minted mini-golf courses (PB-301).
//!
//! Thin, standards-shaped ICRC-7 token ledger that holds the authoritative
//! ownership + on-chain metadata for every minted mini-golf course. Core ICRC-7
//! only (decision D2): no ICRC-37 (approvals), no ICRC-3 (tx log). The backend
//! is an allowlisted minter/custodian (stored in CONFIG) so it can run
//! marketplace-mediated mints and sales without approval plumbing; token owners
//! can still `icrc7_transfer` their own token directly for gifting/OTC.
//!
//! See `ideas/course-nft/tasks/01-coursenft-canister-icrc7.md` (authoritative,
//! incl. review fixes C1 nat, C2 OwnerTokenKey, C5 batch caps) and
//! `00-overview-and-architecture.md` (§5 MemoryId map, conventions).

use candid::{CandidType, Nat, Principal};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;
use ic_http_certification::{
    utils::add_v2_certificate_header, DefaultCelBuilder, DefaultResponseCertification,
    HttpCertification, HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    HttpResponse as CertHttpResponse, StatusCode, CERTIFICATE_EXPRESSION_HEADER_NAME,
};
use ic_stable_structures::{
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
    storable::Bound,
    DefaultMemoryImpl, StableBTreeMap, StableCell, Storable,
};

type Memory = VirtualMemory<DefaultMemoryImpl>;

// ==========================================
// Validation Constants
// ==========================================

/// Hard byte ceiling for the verbatim `course_data` CBOR blob (A.5). PB-303 sets
/// a tighter editor budget (~24 KiB); this 64 KiB backstop keeps a single-token
/// `icrc7_token_metadata` reply and the `mint` arg well under the 2 MiB cap.
const MAX_COURSE_DATA_BYTES: usize = 65_536;

/// Course name length bounds (`icrc7:name`), matching the editor's rule.
const NAME_MIN_CHARS: usize = 1;
const NAME_MAX_CHARS: usize = 60;

/// par_total = sum of the 9 hole pars (each 2..=5).
const PAR_TOTAL_MIN: u16 = 18;
const PAR_TOTAL_MAX: u16 = 45;

/// Lightweight batch query cap (ids/accounts only): standard ICRC-7 100 ids (C5).
const MAX_QUERY_BATCH_SIZE: usize = 100;

/// Heavy batch cap: `icrc7_token_metadata` embeds the `course_data` blob, so a
/// 100-id batch could reach 6.4 MiB and trap; cap at 25 (25 × 64 KiB = 1.6 MiB) (C5).
const MAX_METADATA_BATCH_SIZE: usize = 25;

const DEFAULT_SYMBOL: &str = "CALCRS";
const DEFAULT_NAME: &str = "Caldera Mini-Golf Courses";
const DEFAULT_DESCRIPTION: &str =
    "Yield-bearing ICRC-7 mini-golf courses on Caldera. Each token carries its \
     own on-chain course layout; the creator keeps a permanent resale royalty.";

// ==========================================
// 1. Data Models
// ==========================================

/// ICRC-7 generic metadata value.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Value {
    Blob(Vec<u8>),
    Text(String),
    Nat(Nat),
    Int(candid::Int),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
}

/// Standard ICRC account. This collection only ever uses the default subaccount.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub owner: Principal,
    pub subaccount: Option<Vec<u8>>,
}

impl Account {
    fn from_owner(owner: Principal) -> Self {
        Account { owner, subaccount: None }
    }
}

/// The authoritative per-token record.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CourseToken {
    pub owner: Principal,
    pub name: String,
    /// Immutable royalty anchor — the original minting user. Survives every transfer.
    pub creator: Principal,
    /// Mint time, ns.
    pub created_at: u64,
    /// Verbatim CourseDataV1 CBOR (PB-303). Stored & returned verbatim; never parsed here.
    pub course_data: Vec<u8>,
    /// Sum of the 9 hole pars (18..=45).
    pub par_total: u16,
    /// Minter-updatable display/provenance counter (monotonic).
    #[serde(default)]
    pub play_count: u64,
    /// Minter-updatable display/provenance counter (monotonic).
    #[serde(default)]
    pub tickets_distributed: u64,
    /// Mint fee paid (provenance), e8s.
    pub mint_fee_e8s: u64,
}

/// Collection metadata + allowlisted minter / admin principals.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NftConfig {
    /// The backend canister principal — the only non-owner that can move a token.
    pub minter: Principal,
    /// Deploy controller; may rotate `minter` (not a back door to move tokens).
    pub admin: Principal,
    pub symbol: String,
    pub name: String,
    pub description: String,
    /// None = uncapped.
    #[serde(default)]
    pub supply_cap: Option<u64>,
}

impl NftConfig {
    fn default_placeholder() -> Self {
        NftConfig {
            minter: Principal::anonymous(),
            admin: Principal::anonymous(),
            symbol: DEFAULT_SYMBOL.to_string(),
            name: DEFAULT_NAME.to_string(),
            description: DEFAULT_DESCRIPTION.to_string(),
            supply_cap: None,
        }
    }
}

/// Composite index key for `OWNER_TOKENS`. See C2 below for why this is hand-rolled.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct OwnerTokenKey {
    pub owner: Principal,
    pub token_id: u64,
}

// ==========================================
// 2. Stable Storage Trait Impls
// ==========================================

/// Mirror the backend's CBOR (ciborium) Storable macro, `Bound::Unbounded`.
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

impl_storable!(CourseToken);
impl_storable!(NftConfig);

/// **C2 — do NOT use `impl_storable!` (CBOR) for this key.**
/// `StableBTreeMap` orders keys by their raw serialized bytes, and CBOR does not
/// preserve lexicographic field order — a CBOR `(Principal, u64)` key yields a
/// broken `range(owner..)`, so `icrc7_tokens_of` returns corrupted/incomplete
/// results. Hand-roll a fixed-width big-endian Storable so the bytes sort by
/// `(owner, token_id)` and the key is `Bounded` (exactly 38 bytes).
impl Storable for OwnerTokenKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let p = self.owner.as_slice(); // <= 29 bytes
        let mut b = Vec::with_capacity(38);
        b.push(p.len() as u8); // [0]    principal length
        b.extend_from_slice(p); // [1..]  principal bytes
        b.resize(30, 0); // pad principal region to 29 (+1 len byte)
        b.extend_from_slice(&self.token_id.to_be_bytes()); // [30..38] big-endian id
        Cow::Owned(b)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let len = bytes[0] as usize;
        let owner = Principal::from_slice(&bytes[1..1 + len]);
        let token_id = u64::from_be_bytes(bytes[30..38].try_into().unwrap());
        OwnerTokenKey { owner, token_id }
    }

    const BOUND: Bound = Bound::Bounded { max_size: 38, is_fixed_size: true };
}

// ==========================================
// 3. Persistent Memory Layout
// ==========================================

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    // 0 — TOKENS
    static TOKENS: RefCell<StableBTreeMap<u64, CourseToken, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(0)))));

    // 1 — OWNER_TOKENS index (range-scanned by owner; see C2)
    static OWNER_TOKENS: RefCell<StableBTreeMap<OwnerTokenKey, (), Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(1)))));

    // 2 — NEXT_TOKEN_ID (token ids start at 1; 0 reserved as "no token")
    static NEXT_TOKEN_ID: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(2)), 1)));

    // 3 — CONFIG (collection metadata + minter/admin)
    static CONFIG: RefCell<StableCell<NftConfig, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(
            mm.borrow().get(MemoryId::new(3)), NftConfig::default_placeholder())));
}

fn config() -> NftConfig {
    CONFIG.with(|c| c.borrow().get().clone())
}

fn put_config(cfg: NftConfig) {
    CONFIG.with(|c| {
        c.borrow_mut().set(cfg);
    });
}

// ==========================================
// 4. Security Guards
// ==========================================

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static TEST_MOCK_CALLER: RefCell<Principal> = RefCell::new(Principal::anonymous());
    /// Off-wasm stand-in for `ic_cdk::api::is_controller`.
    static TEST_MOCK_CONTROLLERS: RefCell<Vec<Principal>> = const { RefCell::new(Vec::new()) };
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
fn set_mock_caller(caller: Principal) {
    TEST_MOCK_CALLER.with(|cell| *cell.borrow_mut() = caller);
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
fn set_mock_controllers(controllers: Vec<Principal>) {
    TEST_MOCK_CONTROLLERS.with(|cell| *cell.borrow_mut() = controllers);
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

fn caller_is_controller(p: &Principal) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::is_controller(p)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        TEST_MOCK_CONTROLLERS.with(|cell| cell.borrow().contains(p))
    }
}

fn now_ns() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::time()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Ingress-level gate: reject anonymous callers on every update before the body
/// runs. Queries stay open. Mirrors the backend's anonymous-ingress gate. There
/// is no public unauthenticated update on this canister.
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

/// Minter-only gate: `mint`, `custodial_transfer`, `bump_play_count`,
/// `add_tickets_distributed`.
fn require_minter() -> Result<(), String> {
    if get_caller() != config().minter {
        return Err("NOT_MINTER".to_string());
    }
    Ok(())
}

/// Admin-or-controller gate: `set_minter`, `set_admin`. Lets the minter be
/// rotated if the backend canister id changes. Not a back door to move tokens.
fn require_admin() -> Result<(), String> {
    let caller = get_caller();
    if caller == config().admin || caller_is_controller(&caller) {
        return Ok(());
    }
    Err("NOT_ADMIN".to_string())
}

// ==========================================
// 5. Init & Post Upgrade
// ==========================================

#[derive(CandidType, Deserialize)]
pub struct InitArgs {
    pub minter: Principal,
    pub admin: Principal,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub supply_cap: Option<u64>,
}

#[ic_cdk::init]
fn init(args: InitArgs) {
    let cfg = NftConfig {
        minter: args.minter,
        admin: args.admin,
        symbol: args.symbol.unwrap_or_else(|| DEFAULT_SYMBOL.to_string()),
        name: args.name.unwrap_or_else(|| DEFAULT_NAME.to_string()),
        description: DEFAULT_DESCRIPTION.to_string(),
        supply_cap: args.supply_cap,
    };
    put_config(cfg);
    // Build the (heap-only) HTTP certification tree and publish its root hash so the
    // HTTP routes verify on the normal gateway domain from the first request.
    rebuild_cert_tree();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable structures auto-restore. The certification tree is HEAP state and is
    // lost across upgrades, so it must be rebuilt from stable storage here (and the
    // root hash re-published) or every HTTP response would fail verification.
    rebuild_cert_tree();
}

// ==========================================
// 6. Admin / Config
// ==========================================

#[ic_cdk::update(guard = "require_admin")]
fn set_minter(new_minter: Principal) -> Result<(), String> {
    let mut cfg = config();
    cfg.minter = new_minter;
    put_config(cfg);
    Ok(())
}

#[ic_cdk::update(guard = "require_admin")]
fn set_admin(new_admin: Principal) -> Result<(), String> {
    let mut cfg = config();
    cfg.admin = new_admin;
    put_config(cfg);
    Ok(())
}

#[ic_cdk::query]
fn get_nft_config() -> NftConfig {
    config()
}

// ==========================================
// 7. Minter (custodial) API
// ==========================================

#[derive(CandidType, Deserialize)]
pub struct MintArgs {
    pub to: Principal,
    pub name: String,
    /// Backend passes the original minting user (immutable royalty anchor).
    pub creator: Principal,
    pub course_data: Vec<u8>,
    pub par_total: u16,
    pub mint_fee_e8s: u64,
}

/// Insert/replace both indices for a token's current owner.
fn index_owner(owner: Principal, token_id: u64) {
    OWNER_TOKENS.with(|m| {
        m.borrow_mut().insert(OwnerTokenKey { owner, token_id }, ());
    });
}

fn unindex_owner(owner: Principal, token_id: u64) {
    OWNER_TOKENS.with(|m| {
        m.borrow_mut().remove(&OwnerTokenKey { owner, token_id });
    });
}

#[ic_cdk::update(guard = "require_minter")]
fn mint(args: MintArgs) -> Result<u64, String> {
    let name_len = args.name.chars().count();
    if name_len < NAME_MIN_CHARS || name_len > NAME_MAX_CHARS {
        return Err(format!(
            "BAD_NAME: must be {}..={} chars",
            NAME_MIN_CHARS, NAME_MAX_CHARS
        ));
    }
    if args.course_data.len() > MAX_COURSE_DATA_BYTES {
        return Err(format!(
            "COURSE_DATA_TOO_LARGE: {} > {} bytes",
            args.course_data.len(),
            MAX_COURSE_DATA_BYTES
        ));
    }
    if args.par_total < PAR_TOTAL_MIN || args.par_total > PAR_TOTAL_MAX {
        return Err(format!(
            "BAD_PAR_TOTAL: must be {}..={}",
            PAR_TOTAL_MIN, PAR_TOTAL_MAX
        ));
    }

    // Supply cap check.
    let cfg = config();
    if let Some(cap) = cfg.supply_cap {
        let supply = TOKENS.with(|t| t.borrow().len());
        if supply >= cap {
            return Err(format!("SUPPLY_CAP_REACHED: cap {}", cap));
        }
    }

    // Allocate the next id. `checked_add` so a (practically unreachable) id-space
    // exhaustion returns an error instead of trapping on overflow.
    let token_id = NEXT_TOKEN_ID.with(|c| {
        let mut cell = c.borrow_mut();
        let id = *cell.get();
        let next = id.checked_add(1).ok_or("ID_SPACE_EXHAUSTED")?;
        cell.set(next);
        Ok::<u64, String>(id)
    })?;

    let token = CourseToken {
        owner: args.to,
        name: args.name,
        creator: args.creator,
        created_at: now_ns(),
        course_data: args.course_data,
        par_total: args.par_total,
        play_count: 0,
        tickets_distributed: 0,
        mint_fee_e8s: args.mint_fee_e8s,
    };

    TOKENS.with(|t| t.borrow_mut().insert(token_id, token));
    index_owner(args.to, token_id);

    // Certify the new token's routes and refresh `/` (total_supply changed).
    certify_token(token_id);
    certify_root();
    publish_certified_data();

    Ok(token_id)
}

#[ic_cdk::update(guard = "require_minter")]
fn custodial_transfer(token_id: u64, to: Principal) -> Result<(), String> {
    let changed = TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let mut token = tokens.get(&token_id).ok_or("NON_EXISTING_TOKEN")?;
        let old_owner = token.owner;
        if old_owner == to {
            return Ok::<bool, String>(false);
        }
        token.owner = to;
        tokens.insert(token_id, token);
        unindex_owner(old_owner, token_id);
        index_owner(to, token_id);
        Ok(true)
    })?;
    // owner changed → `/token/<id>` JSON changed; re-certify just that token.
    if changed {
        certify_token(token_id);
        publish_certified_data();
    }
    Ok(())
}

#[ic_cdk::update(guard = "require_minter")]
fn bump_play_count(token_id: u64, by: u64) -> Result<u64, String> {
    let new = TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let mut token = tokens.get(&token_id).ok_or("NON_EXISTING_TOKEN")?;
        token.play_count = token.play_count.saturating_add(by);
        let new = token.play_count;
        tokens.insert(token_id, token);
        Ok::<u64, String>(new)
    })?;
    // play_count is in `/token/<id>` JSON; re-certify that token.
    certify_token(token_id);
    publish_certified_data();
    Ok(new)
}

#[ic_cdk::update(guard = "require_minter")]
fn add_tickets_distributed(token_id: u64, by: u64) -> Result<u64, String> {
    let new = TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let mut token = tokens.get(&token_id).ok_or("NON_EXISTING_TOKEN")?;
        token.tickets_distributed = token.tickets_distributed.saturating_add(by);
        let new = token.tickets_distributed;
        tokens.insert(token_id, token);
        Ok::<u64, String>(new)
    })?;
    // tickets_distributed is in `/token/<id>` JSON; re-certify that token.
    certify_token(token_id);
    publish_certified_data();
    Ok(new)
}

// ==========================================
// 8. ICRC-7 queries
// ==========================================

/// **C1** — convert an unbounded ICRC-7 `nat` to internal `u64`. Out-of-u64 ids
/// don't exist (so e.g. `icrc7_owner_of` returns None); never trap.
fn nat_to_u64(n: &Nat) -> Option<u64> {
    // `Nat` Display is the plain decimal string; parse into u64, which fails
    // (→ None) for any value exceeding u64::MAX. Dep-free conversion at the edge.
    n.0.to_string().parse::<u64>().ok()
}

fn token_count() -> u64 {
    TOKENS.with(|t| t.borrow().len())
}

#[ic_cdk::query]
fn icrc7_symbol() -> String {
    config().symbol
}

#[ic_cdk::query]
fn icrc7_name() -> String {
    config().name
}

#[ic_cdk::query]
fn icrc7_description() -> Option<String> {
    Some(config().description)
}

#[ic_cdk::query]
fn icrc7_total_supply() -> Nat {
    Nat::from(token_count())
}

/// Alias of `icrc7_total_supply`.
#[ic_cdk::query]
fn icrc7_supply() -> Nat {
    icrc7_total_supply()
}

#[ic_cdk::query]
fn icrc7_supply_cap() -> Option<Nat> {
    config().supply_cap.map(Nat::from)
}

#[ic_cdk::query]
fn icrc7_collection_metadata() -> Vec<(String, Value)> {
    let cfg = config();
    let mut out = vec![
        ("icrc7:name".to_string(), Value::Text(cfg.name)),
        ("icrc7:symbol".to_string(), Value::Text(cfg.symbol)),
        ("icrc7:description".to_string(), Value::Text(cfg.description)),
        ("icrc7:total_supply".to_string(), Value::Nat(Nat::from(token_count()))),
        (
            "icrc7:max_query_batch_size".to_string(),
            Value::Nat(Nat::from(MAX_QUERY_BATCH_SIZE as u64)),
        ),
        (
            "course:max_metadata_batch_size".to_string(),
            Value::Nat(Nat::from(MAX_METADATA_BATCH_SIZE as u64)),
        ),
    ];
    if let Some(cap) = cfg.supply_cap {
        out.push(("icrc7:supply_cap".to_string(), Value::Nat(Nat::from(cap))));
    }
    out
}

#[ic_cdk::query]
fn icrc7_owner_of(ids: Vec<Nat>) -> Vec<Option<Account>> {
    assert!(
        ids.len() <= MAX_QUERY_BATCH_SIZE,
        "BATCH_TOO_LARGE: max {} ids",
        MAX_QUERY_BATCH_SIZE
    );
    TOKENS.with(|t| {
        let tokens = t.borrow();
        ids.iter()
            .map(|id| {
                nat_to_u64(id)
                    .and_then(|id| tokens.get(&id))
                    .map(|tok| Account::from_owner(tok.owner))
            })
            .collect()
    })
}

#[ic_cdk::query]
fn icrc7_balance_of(accs: Vec<Account>) -> Vec<Nat> {
    assert!(
        accs.len() <= MAX_QUERY_BATCH_SIZE,
        "BATCH_TOO_LARGE: max {} accounts",
        MAX_QUERY_BATCH_SIZE
    );
    OWNER_TOKENS.with(|m| {
        let map = m.borrow();
        accs.iter()
            .map(|acc| {
                let start = OwnerTokenKey { owner: acc.owner, token_id: 0 };
                let count = map
                    .range(start..)
                    .take_while(|e| e.key().owner == acc.owner)
                    .count();
                Nat::from(count as u64)
            })
            .collect()
    })
}

#[ic_cdk::query]
fn icrc7_tokens(prev: Option<Nat>, take: Option<Nat>) -> Vec<Nat> {
    let take = take
        .as_ref()
        .and_then(nat_to_u64)
        .map(|t| (t as usize).min(MAX_QUERY_BATCH_SIZE))
        .unwrap_or(MAX_QUERY_BATCH_SIZE);
    // `prev` is the last token id seen; start strictly after it.
    let start = match prev.as_ref() {
        Some(p) => match nat_to_u64(p) {
            Some(v) => v.saturating_add(1),
            // prev beyond u64 → nothing after it.
            None => return Vec::new(),
        },
        None => 0,
    };
    TOKENS.with(|t| {
        t.borrow()
            .range(start..)
            .take(take)
            .map(|e| Nat::from(*e.key()))
            .collect()
    })
}

#[ic_cdk::query]
fn icrc7_tokens_of(acc: Account, prev: Option<Nat>, take: Option<Nat>) -> Vec<Nat> {
    let take = take
        .as_ref()
        .and_then(nat_to_u64)
        .map(|t| (t as usize).min(MAX_QUERY_BATCH_SIZE))
        .unwrap_or(MAX_QUERY_BATCH_SIZE);
    let start_id = match prev.as_ref() {
        Some(p) => match nat_to_u64(p) {
            Some(v) => v.saturating_add(1),
            None => return Vec::new(),
        },
        None => 0,
    };
    OWNER_TOKENS.with(|m| {
        let map = m.borrow();
        let start = OwnerTokenKey { owner: acc.owner, token_id: start_id };
        map.range(start..)
            .take_while(|e| e.key().owner == acc.owner)
            .take(take)
            .map(|e| Nat::from(e.key().token_id))
            .collect()
    })
}

#[ic_cdk::query]
fn icrc7_token_metadata(ids: Vec<Nat>) -> Vec<Option<Vec<(String, Value)>>> {
    assert!(
        ids.len() <= MAX_METADATA_BATCH_SIZE,
        "BATCH_TOO_LARGE: max {} ids for icrc7_token_metadata",
        MAX_METADATA_BATCH_SIZE
    );
    TOKENS.with(|t| {
        let tokens = t.borrow();
        ids.iter()
            .map(|id| {
                nat_to_u64(id)
                    .and_then(|id| tokens.get(&id))
                    .map(|tok| token_metadata_map(&tok))
            })
            .collect()
    })
}

/// Raw `course_data` blobs by id — the backend's `get_course_data` passthrough
/// the Play flow loads a course from (PB-305 B3). Same batch cap as
/// `icrc7_token_metadata` (the blob dominates the reply size either way).
#[ic_cdk::query]
fn course_data_of(ids: Vec<Nat>) -> Vec<Option<Vec<u8>>> {
    assert!(
        ids.len() <= MAX_METADATA_BATCH_SIZE,
        "BATCH_TOO_LARGE: max {} ids for course_data_of",
        MAX_METADATA_BATCH_SIZE
    );
    TOKENS.with(|t| {
        let tokens = t.borrow();
        ids.iter()
            .map(|id| nat_to_u64(id).and_then(|id| tokens.get(&id)).map(|tok| tok.course_data.clone()))
            .collect()
    })
}

/// Build the ICRC-7 `Value` map per the A.3 table.
fn token_metadata_map(tok: &CourseToken) -> Vec<(String, Value)> {
    vec![
        ("icrc7:name".to_string(), Value::Text(tok.name.clone())),
        ("caldera:creator".to_string(), Value::Text(tok.creator.to_text())),
        ("caldera:created_at".to_string(), Value::Nat(Nat::from(tok.created_at))),
        ("caldera:course_data".to_string(), Value::Blob(tok.course_data.clone())),
        ("caldera:par_total".to_string(), Value::Nat(Nat::from(tok.par_total))),
        ("caldera:play_count".to_string(), Value::Nat(Nat::from(tok.play_count))),
        (
            "caldera:tickets_distributed".to_string(),
            Value::Nat(Nat::from(tok.tickets_distributed)),
        ),
        ("caldera:mint_fee_e8s".to_string(), Value::Nat(Nat::from(tok.mint_fee_e8s))),
    ]
}

// ==========================================
// 9. ICRC-7 owner transfer
// ==========================================

#[derive(CandidType, Deserialize)]
pub struct TransferArg {
    pub token_id: Nat,
    pub to: Account,
    pub from_subaccount: Option<Vec<u8>>,
    pub memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize)]
pub enum TransferError {
    NonExistingTokenId,
    Unauthorized,
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    GenericError { error_code: Nat, message: String },
}

type TransferResult = Result<Nat, TransferError>;

#[ic_cdk::update]
fn icrc7_transfer(args: Vec<TransferArg>) -> Vec<Option<TransferResult>> {
    // Update path: must be authenticated (also enforced by inspect_message).
    if require_authenticated().is_err() {
        return args.iter().map(|_| Some(Err(TransferError::Unauthorized))).collect();
    }
    let caller = get_caller();

    let mut changed: Vec<u64> = Vec::new();
    let out = args
        .into_iter()
        .map(|arg| {
            let token_id = match nat_to_u64(&arg.token_id) {
                Some(id) => id,
                None => return Some(Err(TransferError::NonExistingTokenId)),
            };
            let result = TOKENS.with(|t| {
                let mut tokens = t.borrow_mut();
                let mut token = match tokens.get(&token_id) {
                    Some(tok) => tok,
                    None => return Err(TransferError::NonExistingTokenId),
                };
                if token.owner != caller {
                    return Err(TransferError::Unauthorized);
                }
                let old_owner = token.owner;
                let new_owner = arg.to.owner;
                if old_owner != new_owner {
                    token.owner = new_owner;
                    // creator / course_data / counters untouched.
                    tokens.insert(token_id, token);
                    unindex_owner(old_owner, token_id);
                    index_owner(new_owner, token_id);
                    changed.push(token_id);
                }
                Ok(Nat::from(token_id))
            });
            Some(result)
        })
        .collect();
    // Re-certify every token whose owner actually moved (`/token/<id>` JSON changed).
    if !changed.is_empty() {
        for id in changed {
            certify_token(id);
        }
        publish_certified_data();
    }
    out
}

// ==========================================
// 10. Burn (owner-or-minter)
// ==========================================

/// Permanently destroy a token. Callable by the token's **current owner** OR the
/// **minter** (mirrors `icrc7_transfer`'s owner check plus the minter allowlist).
///
/// Burning:
/// - removes the token from `TOKENS`,
/// - removes its `OWNER_TOKENS` index entry,
/// - decrements supply (implicitly, via the `TOKENS` length),
/// - **permanently retires the id**. `NEXT_TOKEN_ID` only ever increases, so a
///   burned id is never re-minted. After burn, `icrc7_owner_of` /
///   `icrc7_token_metadata` / `http_request` for that id return None / 404.
///
/// Anonymous callers are rejected (also enforced by `inspect_message`). Burning a
/// nonexistent / already-burned id returns `NON_EXISTING_TOKEN`.
#[ic_cdk::update]
fn burn(token_id: Nat) -> Result<(), String> {
    require_authenticated()?;
    let caller = get_caller();
    let id = nat_to_u64(&token_id).ok_or("NON_EXISTING_TOKEN")?;

    TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let token = tokens.get(&id).ok_or("NON_EXISTING_TOKEN")?;
        let owner = token.owner;
        // Authorization: current owner OR the configured minter.
        if caller != owner && caller != config().minter {
            return Err("UNAUTHORIZED".to_string());
        }
        tokens.remove(&id);
        unindex_owner(owner, id);
        // NEXT_TOKEN_ID is untouched — the id is retired forever.
        Ok(())
    })?;
    // Drop the burned token's cert entries (its routes now 404 → wildcard) and
    // refresh `/` (total_supply changed).
    decertify_token(id);
    certify_root();
    publish_certified_data();
    Ok(())
}

// ==========================================
// 11. HTTP gateway (per-token & collection JSON) — CERTIFIED (Response Verification v2)
// ==========================================
//
// SECURITY / SCOPE: `http_request` is a `query` — it never mutates state and never
// traps on malformed input (bad paths return a certified 404). All string fields
// are emitted as JSON with proper escaping (no HTML is ever produced) to avoid
// injection. Every response is bounded well under the 2 MiB message cap: per-token
// JSON embeds the build-instructions `course_data` as a parsed JSON object (never
// raw bytes — a blob that doesn't parse as JSON embeds as null, so it can't corrupt
// the document; byte-exact/legacy access stays on the base64
// `/token/<id>/course_data` route), and that blob is itself capped at
// `MAX_COURSE_DATA_BYTES` (64 KiB) by `mint`.
//
// CERTIFICATION (PB-301 hardening): responses are certified with IC Response
// Verification v2 via the official `ic-http-certification` crate, so they verify on
// the NORMAL gateway domain (`<id>.icp0.io` / `<id>.localhost:8000`) — no `.raw.`
// needed. We maintain an `HttpCertificationTree` (heap state) whose root hash is
// published with `certified_data_set`. Content is dynamic, so the tree is patched
// on every mutation (mint / burn / transfers / counter bumps) and rebuilt from
// stable storage in `post_upgrade`. `http_request` attaches the `IC-Certificate` +
// `IC-CertificateExpression` headers for the matched path; unknown / burned ids
// fall through to a certified 404 via a root wildcard entry.
//
// The cert tree is keyed by the request PATH and certifies, per response: the body,
// the status code, and the `Content-Type` + `X-Content-Type-Options` headers (the
// only headers we set besides the certificate machinery). The exact bytes that are
// certified MUST equal the exact bytes served — `build_route_response` is the single
// source of truth used both to certify (at mutation time) and to serve (in the
// query), so the two can never drift.

/// Standard candid HTTP gateway records (`blob` body == `Vec<u8>`).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The fixed, non-certificate headers every response carries. These are the
/// headers the CEL expression certifies (see `CERTIFIED_RESPONSE_HEADERS`), so the
/// served set and the certified set are identical by construction.
fn base_headers(content_type: &str) -> Vec<(String, String)> {
    vec![
        ("Content-Type".to_string(), content_type.to_string()),
        ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
    ]
}

fn http_text(status: u16, content_type: &str, body: Vec<u8>) -> HttpResponse {
    HttpResponse { status_code: status, headers: base_headers(content_type), body }
}

fn json_response(status: u16, json: String) -> HttpResponse {
    http_text(status, "application/json", json.into_bytes())
}

fn json_error(status: u16, message: &str) -> HttpResponse {
    json_response(status, format!("{{\"error\":{}}}", json_string(message)))
}

/// Minimal RFC 8259 string escaper. We only ever embed token `name` and principal
/// text (already ASCII), but escape fully so no field can break the JSON or inject.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Dependency-free standard base64 (RFC 4648) encoder for the raw `course_data`
/// route. Output length is bounded by `MAX_COURSE_DATA_BYTES`.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Strip the query string and any URL fragment, returning just the path. Never
/// panics on malformed input.
fn path_only(url: &str) -> &str {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    &url[..end]
}

/// Collection-level metadata JSON for `GET /`.
fn collection_json() -> String {
    let cfg = config();
    let mut s = String::from("{");
    s.push_str(&format!("\"name\":{},", json_string(&cfg.name)));
    s.push_str(&format!("\"symbol\":{},", json_string(&cfg.symbol)));
    s.push_str(&format!("\"description\":{},", json_string(&cfg.description)));
    s.push_str(&format!("\"total_supply\":{},", token_count()));
    match cfg.supply_cap {
        Some(cap) => s.push_str(&format!("\"supply_cap\":{}", cap)),
        None => s.push_str("\"supply_cap\":null"),
    }
    s.push('}');
    s
}

/// Per-token metadata JSON for `GET /token/<id>`.
fn token_json(id: u64, tok: &CourseToken) -> String {
    let mut s = String::from("{");
    s.push_str(&format!("\"token_id\":{},", id));
    s.push_str(&format!("\"name\":{},", json_string(&tok.name)));
    s.push_str(&format!("\"creator\":{},", json_string(&tok.creator.to_text())));
    s.push_str(&format!("\"owner\":{},", json_string(&tok.owner.to_text())));
    s.push_str(&format!("\"created_at\":{},", tok.created_at));
    s.push_str(&format!("\"par_total\":{},", tok.par_total));
    s.push_str(&format!("\"play_count\":{},", tok.play_count));
    s.push_str(&format!("\"tickets_distributed\":{},", tok.tickets_distributed));
    s.push_str(&format!("\"mint_fee_e8s\":{},", tok.mint_fee_e8s));
    s.push_str(&format!("\"course_data_len\":{},", tok.course_data.len()));
    s.push_str(&format!(
        "\"course_data_url\":{},",
        json_string(&format!("/token/{}/course_data", id))
    ));
    // The full build-instructions document, embedded as a real JSON object so
    // the token page IS the course. Only embedded when the blob parses as JSON
    // (re-serialized compact via serde_json, so a malformed blob can never
    // corrupt this document); legacy CBOR blobs get null and remain readable
    // byte-exact via the base64 `course_data_url` route. Bounded by the
    // MAX_COURSE_DATA_BYTES mint cap.
    s.push_str("\"course\":");
    s.push_str(&course_json_value(&tok.course_data));
    s.push('}');
    s
}

/// The course blob as an embeddable JSON value: compact re-serialization when
/// it parses as JSON, `"null"` otherwise (legacy CBOR / malformed data).
fn course_json_value(course_data: &[u8]) -> String {
    if course_data.first() == Some(&b'{') {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(course_data) {
            if let Ok(compact) = serde_json::to_string(&v) {
                return compact;
            }
        }
    }
    "null".to_string()
}

/// Parse a `u64` token id from a path segment without trapping. Rejects empty,
/// non-digit, and overflowing inputs (→ `None` → 404).
fn parse_id_segment(seg: &str) -> Option<u64> {
    if seg.is_empty() {
        return None;
    }
    seg.parse::<u64>().ok()
}

/// Per-token base64 `course_data` JSON for `GET /token/<id>/course_data`.
fn course_data_json(id: u64, tok: &CourseToken) -> String {
    format!(
        "{{\"token_id\":{},\"course_data_base64\":{}}}",
        id,
        json_string(&base64_encode(&tok.course_data))
    )
}

/// Build the canonical (un-certified) response body for a request method + path.
///
/// **Single source of truth**: this is called both when certifying a route (at
/// mutation time, to compute the hash) and when serving a query (to produce the
/// bytes). Because both go through here, the certified bytes and served bytes are
/// identical by construction — the v2 gateway is unforgiving about any mismatch.
///
/// Returns the bare response (Content-Type + nosniff headers only); the
/// certificate / expression headers are layered on afterwards by `serve_certified`.
fn build_route_response(method: &str, path: &str) -> HttpResponse {
    if method != "GET" && method != "HEAD" {
        return json_error(405, "method not allowed");
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        [] => json_response(200, collection_json()),
        ["token", id_str] => match parse_id_segment(id_str) {
            None => json_error(404, "not found"),
            Some(id) => TOKENS.with(|t| match t.borrow().get(&id) {
                Some(tok) => json_response(200, token_json(id, &tok)),
                None => json_error(404, "not found"),
            }),
        },
        ["token", id_str, "course_data"] => match parse_id_segment(id_str) {
            None => json_error(404, "not found"),
            Some(id) => TOKENS.with(|t| match t.borrow().get(&id) {
                Some(tok) => json_response(200, course_data_json(id, &tok)),
                None => json_error(404, "not found"),
            }),
        },
        _ => json_error(404, "not found"),
    }
}

// ------------------------------------------------------------------
// 11a. Response Verification v2 certification
// ------------------------------------------------------------------

/// Response headers that are folded into the certification hash. Must list exactly
/// the headers `build_route_response` sets (besides the certificate machinery),
/// otherwise the gateway recomputes a different response hash and rejects.
const CERTIFIED_RESPONSE_HEADERS: [&str; 2] = ["Content-Type", "X-Content-Type-Options"];

/// Wildcard path that backs the certified 404 for any unknown / burned route.
const WILDCARD_404_PATH: &str = "";

thread_local! {
    /// The HTTP certification tree. Heap state — **not** persisted across upgrades,
    /// so it is rebuilt from stable storage in `init` / `post_upgrade`.
    static HTTP_TREE: RefCell<HttpCertificationTree> =
        RefCell::new(HttpCertificationTree::default());
}

/// The response-only CEL expression string, identical for every route. Added as the
/// `IC-CertificateExpression` header (certified + served) and hashed into the cert.
fn cel_expr_string() -> String {
    DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            CERTIFIED_RESPONSE_HEADERS.to_vec(),
        ))
        .build()
        .to_string()
}

/// Build the `ic-http-certification` response (with the expression header attached)
/// used to compute the certification hash for a route. Mirrors the bytes/headers of
/// the candid `HttpResponse` from `build_route_response`.
fn cert_response_for(path: &str) -> CertHttpResponse<'static> {
    let r = build_route_response("GET", path);
    let mut headers: Vec<(String, String)> = r.headers;
    headers.push((CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(), cel_expr_string()));
    CertHttpResponse::builder()
        .with_status_code(StatusCode::from_u16(r.status_code).unwrap_or(StatusCode::OK))
        .with_headers(headers)
        .with_body(r.body)
        .build()
}

/// Compute the certification entry (path + cert) for a given tree path string.
/// `tree_path` is the exact request path (e.g. `/token/5`) for normal routes, or
/// `WILDCARD_404_PATH` for the wildcard 404 fallback.
fn insert_cert(tree: &mut HttpCertificationTree, tree_path: &str, is_wildcard: bool) {
    let cel_expr = DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            CERTIFIED_RESPONSE_HEADERS.to_vec(),
        ))
        .build();
    // The wildcard 404 certifies the 404 body; a request to an unknown path is what
    // it answers, so hash the 404 response (any unmatched path yields the same one).
    let response_path = if is_wildcard { "/__unmatched__" } else { tree_path };
    let response = cert_response_for(response_path);
    let certification = HttpCertification::response_only(&cel_expr, &response, None)
        .expect("response_only certification must succeed");
    let path = if is_wildcard {
        HttpCertificationPath::wildcard(WILDCARD_404_PATH)
    } else {
        HttpCertificationPath::exact(tree_path)
    };
    let entry = HttpCertificationTreeEntry::new(&path, &certification);
    tree.insert(&entry);
}

/// Remove the entry (or entries) at an exact path subtree. Used before re-inserting
/// an updated entry: the prior entry was hashed against the OLD body, which is no
/// longer reconstructible after the body changed, so we delete the whole exact-path
/// subtree rather than trying to recompute the old cert key. Safe if absent.
fn delete_exact_cert(tree: &mut HttpCertificationTree, tree_path: &str) {
    tree.delete_by_path(&HttpCertificationPath::exact(tree_path));
}

/// Publish the tree's current root hash as the canister's certified variable.
/// No-op off-wasm (the `certified_data_set` syscall traps outside the IC).
fn publish_certified_data() {
    #[cfg(target_arch = "wasm32")]
    {
        let root = HTTP_TREE.with(|t| t.borrow().root_hash());
        ic_cdk::api::certified_data_set(root);
    }
}

/// Insert/refresh the certification for the collection root (`/`). Its JSON embeds
/// `total_supply`, so it must be refreshed whenever supply changes (mint / burn).
fn certify_root() {
    HTTP_TREE.with(|t| {
        let mut tree = t.borrow_mut();
        // delete-then-insert: the prior `/` entry hashed the old body.
        delete_exact_cert(&mut tree, "/");
        insert_cert(&mut tree, "/", false);
    });
}

/// Insert/refresh the certifications for a single token's two routes
/// (`/token/<id>` and `/token/<id>/course_data`). Called on mint and whenever the
/// token's served JSON changes (owner / play_count / tickets_distributed).
fn certify_token(id: u64) {
    let meta_path = format!("/token/{}", id);
    let blob_path = format!("/token/{}/course_data", id);
    HTTP_TREE.with(|t| {
        let mut tree = t.borrow_mut();
        delete_exact_cert(&mut tree, &meta_path);
        delete_exact_cert(&mut tree, &blob_path);
        insert_cert(&mut tree, &meta_path, false);
        insert_cert(&mut tree, &blob_path, false);
    });
}

/// Remove a burned token's certifications. The routes now 404 (the wildcard covers
/// them); we drop the exact entries so the tree no longer witnesses a 200 for them.
fn decertify_token(id: u64) {
    let meta_path = format!("/token/{}", id);
    let blob_path = format!("/token/{}/course_data", id);
    HTTP_TREE.with(|t| {
        let mut tree = t.borrow_mut();
        delete_exact_cert(&mut tree, &meta_path);
        delete_exact_cert(&mut tree, &blob_path);
    });
}

/// (Re)build the full certification tree from stable storage and publish the root.
/// Idempotent — called from `init`, `post_upgrade`, and reused by tests.
fn rebuild_cert_tree() {
    HTTP_TREE.with(|t| {
        let mut tree = t.borrow_mut();
        tree.clear();
        // wildcard 404 fallback
        insert_cert(&mut tree, WILDCARD_404_PATH, true);
        // collection root
        insert_cert(&mut tree, "/", false);
    });
    // per-token routes
    let ids: Vec<u64> = TOKENS.with(|t| t.borrow().iter().map(|e| *e.key()).collect());
    for id in ids {
        certify_token(id);
    }
    publish_certified_data();
}

#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let path = path_only(&req.url);
    let mut response = build_route_response(&req.method, path);

    // Always advertise the CEL expression (certified + uncertified paths alike).
    response
        .headers
        .push((CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(), cel_expr_string()));

    // `data_certificate()` is only populated inside a (non-replicated) query call.
    // If absent (e.g. replicated context), serve without the cert header rather than
    // trap — the gateway only verifies the query path anyway.
    let data_cert = data_certificate_opt();
    if let Some(cert) = data_cert {
        attach_certificate(&mut response, &req.method, path, &cert);
    }
    response
}

/// `ic_cdk::api::data_certificate()` is unavailable off-wasm; in tests it returns a
/// mock (set via `set_mock_data_certificate`) so the cert-header wiring is exercised.
fn data_certificate_opt() -> Option<Vec<u8>> {
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::data_certificate()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        TEST_MOCK_DATA_CERT.with(|c| c.borrow().clone())
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// Off-wasm stand-in for `data_certificate()`. `None` by default (mirrors a
    /// replicated context); tests set `Some(..)` to mimic a query call.
    static TEST_MOCK_DATA_CERT: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
fn set_mock_data_certificate(cert: Option<Vec<u8>>) {
    TEST_MOCK_DATA_CERT.with(|c| *c.borrow_mut() = cert);
}

/// Attach the `IC-Certificate` header for the matched path, producing a witness from
/// the cert tree. Exact routes (`/`, `/token/<id>`, `/token/<id>/course_data`) use
/// the exact path; everything else (unknown / burned ids → 404) uses the wildcard.
fn attach_certificate(response: &mut HttpResponse, method: &str, path: &str, data_cert: &[u8]) {
    let r404 = build_route_response(method, path).status_code == 404
        || (method != "GET" && method != "HEAD");
    let is_known_exact = !r404 && is_exact_certified_path(path);

    let (cert_path, request_url, response_path) = if is_known_exact {
        (HttpCertificationPath::exact(path), path.to_string(), path.to_string())
    } else {
        (
            HttpCertificationPath::wildcard(WILDCARD_404_PATH),
            path.to_string(),
            "/__unmatched__".to_string(),
        )
    };

    let cel_expr = DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            CERTIFIED_RESPONSE_HEADERS.to_vec(),
        ))
        .build();
    let cert_resp = cert_response_for(&response_path);
    let certification = match HttpCertification::response_only(&cel_expr, &cert_resp, None) {
        Ok(c) => c,
        Err(_) => return,
    };
    let entry = HttpCertificationTreeEntry::new(&cert_path, &certification);

    let witness = HTTP_TREE.with(|t| t.borrow().witness(&entry, &request_url));
    let witness = match witness {
        Ok(w) => w,
        Err(_) => return,
    };
    let expr_path = cert_path.to_expr_path();

    // `add_v2_certificate_header` wants the crate's HttpResponse; layer the header
    // onto a throwaway crate response and copy it back to our candid response.
    let mut tmp = CertHttpResponse::builder().build();
    add_v2_certificate_header(data_cert, &mut tmp, &witness, &expr_path);
    for (k, v) in tmp.headers() {
        response.headers.push((k.clone(), v.clone()));
    }
}

/// Whether `path` is one of the exact routes we keep an exact cert entry for.
fn is_exact_certified_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    matches!(
        segments.as_slice(),
        [] | ["token", _] | ["token", _, "course_data"]
    )
}

ic_cdk::export_candid!();

// ==========================================
// 12. Tests
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    const ADMIN_TEXT: &str =
        "gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe";

    fn p(n: u8) -> Principal {
        // Distinct non-anonymous principals for testing.
        Principal::from_slice(&[n; 29])
    }

    fn admin() -> Principal {
        Principal::from_text(ADMIN_TEXT).unwrap()
    }

    fn minter() -> Principal {
        p(1)
    }

    /// Reset all stable state to a clean per-test fixture: minter = p(1),
    /// admin = ADMIN_TEXT, no supply cap. Caller defaults to the minter.
    fn fresh() {
        TOKENS.with(|t| {
            let mut m = t.borrow_mut();
            let keys: Vec<u64> = m.iter().map(|e| *e.key()).collect();
            for k in keys {
                m.remove(&k);
            }
        });
        OWNER_TOKENS.with(|t| {
            let mut m = t.borrow_mut();
            let keys: Vec<OwnerTokenKey> = m.iter().map(|e| e.key().clone()).collect();
            for k in keys {
                m.remove(&k);
            }
        });
        NEXT_TOKEN_ID.with(|c| {
            c.borrow_mut().set(1);
        });
        put_config(NftConfig {
            minter: minter(),
            admin: admin(),
            symbol: DEFAULT_SYMBOL.to_string(),
            name: DEFAULT_NAME.to_string(),
            description: DEFAULT_DESCRIPTION.to_string(),
            supply_cap: None,
        });
        set_mock_controllers(vec![]);
        set_mock_caller(minter());
        // Start each test from a clean, fully-built certification tree (mirrors what
        // `init` does on the canister). Mutations then patch this tree.
        rebuild_cert_tree();
    }

    /// Current root hash of the HTTP certification tree (the value that, on-canister,
    /// is published via `certified_data_set`). Used by tests to assert the tree
    /// changes on mutation, since `certified_data_set` itself is a no-op off-wasm.
    fn cert_root() -> [u8; 32] {
        HTTP_TREE.with(|t| t.borrow().root_hash())
    }

    fn good_mint(to: Principal, name: &str) -> MintArgs {
        MintArgs {
            to,
            name: name.to_string(),
            creator: to,
            course_data: vec![1, 2, 3, 4],
            par_total: 27,
            mint_fee_e8s: 50_000_000,
        }
    }

    // ---- mint happy path / counters ----

    #[test]
    fn mint_happy_path_and_monotonic_ids() {
        fresh();
        let id1 = mint(good_mint(p(10), "Course A")).unwrap();
        let id2 = mint(good_mint(p(10), "Course B")).unwrap();
        let id3 = mint(good_mint(p(11), "Course C")).unwrap();
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(id3, 3);
        assert_eq!(icrc7_total_supply(), Nat::from(3u64));
        assert_eq!(icrc7_supply(), Nat::from(3u64));
        // owner reflected
        let owners = icrc7_owner_of(vec![Nat::from(1u64), Nat::from(3u64)]);
        assert_eq!(owners[0].as_ref().unwrap().owner, p(10));
        assert_eq!(owners[1].as_ref().unwrap().owner, p(11));
    }

    #[test]
    fn next_token_id_monotonic_after_removal_pattern() {
        fresh();
        for i in 0..5 {
            let id = mint(good_mint(p(10), &format!("C{i}"))).unwrap();
            assert_eq!(id, i + 1);
        }
        // ids never reused / always increasing.
        assert_eq!(NEXT_TOKEN_ID.with(|c| *c.borrow().get()), 6);
    }

    // ---- mint rejects ----

    #[test]
    fn mint_rejects_non_minter() {
        fresh();
        set_mock_caller(p(99));
        // guard would block on-canister; the function itself also enforces nothing,
        // so we test the guard helper directly.
        assert_eq!(require_minter(), Err("NOT_MINTER".to_string()));
    }

    #[test]
    fn mint_rejects_oversize_blob() {
        fresh();
        let mut args = good_mint(p(10), "Course");
        args.course_data = vec![0u8; MAX_COURSE_DATA_BYTES + 1];
        let err = mint(args).unwrap_err();
        assert!(err.starts_with("COURSE_DATA_TOO_LARGE"), "{err}");
    }

    #[test]
    fn mint_accepts_blob_at_ceiling() {
        fresh();
        let mut args = good_mint(p(10), "Course");
        args.course_data = vec![0u8; MAX_COURSE_DATA_BYTES];
        assert!(mint(args).is_ok());
    }

    #[test]
    fn mint_rejects_bad_name_length() {
        fresh();
        // empty
        let err = mint(good_mint(p(10), "")).unwrap_err();
        assert!(err.starts_with("BAD_NAME"), "{err}");
        // too long (61 chars)
        let long = "x".repeat(61);
        let err = mint(good_mint(p(10), &long)).unwrap_err();
        assert!(err.starts_with("BAD_NAME"), "{err}");
        // 60 chars ok
        let ok = "y".repeat(60);
        assert!(mint(good_mint(p(10), &ok)).is_ok());
    }

    #[test]
    fn mint_rejects_bad_par_total() {
        fresh();
        let mut args = good_mint(p(10), "Course");
        args.par_total = 17;
        assert!(mint(args).unwrap_err().starts_with("BAD_PAR_TOTAL"));
        let mut args = good_mint(p(10), "Course");
        args.par_total = 46;
        assert!(mint(args).unwrap_err().starts_with("BAD_PAR_TOTAL"));
        let mut args = good_mint(p(10), "Course");
        args.par_total = 18;
        assert!(mint(args).is_ok());
    }

    #[test]
    fn mint_rejects_over_cap() {
        fresh();
        let mut cfg = config();
        cfg.supply_cap = Some(2);
        put_config(cfg);
        assert!(mint(good_mint(p(10), "A")).is_ok());
        assert!(mint(good_mint(p(10), "B")).is_ok());
        let err = mint(good_mint(p(10), "C")).unwrap_err();
        assert!(err.starts_with("SUPPLY_CAP_REACHED"), "{err}");
        assert_eq!(icrc7_supply_cap(), Some(Nat::from(2u64)));
    }

    // ---- custodial transfer ----

    #[test]
    fn custodial_transfer_moves_owner_and_index() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // before: p(10) owns it
        assert_eq!(icrc7_tokens_of(Account::from_owner(p(10)), None, None), vec![Nat::from(id)]);
        assert!(icrc7_tokens_of(Account::from_owner(p(20)), None, None).is_empty());

        custodial_transfer(id, p(20)).unwrap();

        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(20));
        assert!(icrc7_tokens_of(Account::from_owner(p(10)), None, None).is_empty());
        assert_eq!(icrc7_tokens_of(Account::from_owner(p(20)), None, None), vec![Nat::from(id)]);
        assert_eq!(icrc7_balance_of(vec![Account::from_owner(p(10))]), vec![Nat::from(0u64)]);
        assert_eq!(icrc7_balance_of(vec![Account::from_owner(p(20))]), vec![Nat::from(1u64)]);
    }

    #[test]
    fn custodial_transfer_rejects_non_minter() {
        fresh();
        set_mock_caller(p(99));
        assert_eq!(require_minter(), Err("NOT_MINTER".to_string()));
    }

    #[test]
    fn custodial_transfer_rejects_unknown_id() {
        fresh();
        assert_eq!(custodial_transfer(999, p(20)), Err("NON_EXISTING_TOKEN".to_string()));
    }

    // ---- readers reflect mint -> custodial -> owner transfer ----

    #[test]
    fn readers_reflect_full_transfer_sequence() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // custodial sale to p(20)
        custodial_transfer(id, p(20)).unwrap();
        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(20));
        // owner p(20) gifts to p(30) directly
        set_mock_caller(p(20));
        let res = icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(30)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert!(matches!(res[0], Some(Ok(_))));
        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(30));
        assert_eq!(icrc7_tokens_of(Account::from_owner(p(30)), None, None), vec![Nat::from(id)]);
    }

    // ---- icrc7_transfer auth ----

    #[test]
    fn owner_transfer_succeeds_non_owner_unauthorized() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // non-owner attempt
        set_mock_caller(p(99));
        let res = icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(99)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert!(matches!(res[0], Some(Err(TransferError::Unauthorized))));
        // still owned by p(10)
        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(10));

        // owner succeeds
        set_mock_caller(p(10));
        let res = icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(50)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert!(matches!(res[0], Some(Ok(_))));
    }

    #[test]
    fn owner_transfer_nonexistent_token() {
        fresh();
        set_mock_caller(p(10));
        let res = icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(424242u64),
            to: Account::from_owner(p(50)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert!(matches!(res[0], Some(Err(TransferError::NonExistingTokenId))));
    }

    #[test]
    fn transfer_preserves_creator_and_counters() {
        fresh();
        let mut args = good_mint(p(10), "A");
        args.creator = p(77); // distinct creator
        let id = mint(args).unwrap();
        bump_play_count(id, 5).unwrap();
        add_tickets_distributed(id, 9).unwrap();

        // custodial then owner transfer
        custodial_transfer(id, p(20)).unwrap();
        set_mock_caller(p(20));
        icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(30)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);

        let md = icrc7_token_metadata(vec![Nat::from(id)]);
        let map = md[0].as_ref().unwrap();
        let creator = map.iter().find(|(k, _)| k == "caldera:creator").unwrap();
        assert_eq!(creator.1, Value::Text(p(77).to_text()));
        let pc = map.iter().find(|(k, _)| k == "caldera:play_count").unwrap();
        assert_eq!(pc.1, Value::Nat(Nat::from(5u64)));
        let td = map.iter().find(|(k, _)| k == "caldera:tickets_distributed").unwrap();
        assert_eq!(td.1, Value::Nat(Nat::from(9u64)));
    }

    // ---- metadata mapping ----

    #[test]
    fn metadata_maps_all_a3_keys() {
        fresh();
        let blob = vec![9u8, 8, 7, 6, 5];
        let args = MintArgs {
            to: p(10),
            name: "My Course".to_string(),
            creator: p(11),
            course_data: blob.clone(),
            par_total: 30,
            mint_fee_e8s: 50_000_000,
        };
        let id = mint(args).unwrap();
        let md = icrc7_token_metadata(vec![Nat::from(id)]);
        let map = md[0].as_ref().unwrap();
        let get = |k: &str| map.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());

        assert_eq!(get("icrc7:name"), Some(Value::Text("My Course".to_string())));
        assert_eq!(get("caldera:creator"), Some(Value::Text(p(11).to_text())));
        assert_eq!(get("caldera:course_data"), Some(Value::Blob(blob)));
        assert_eq!(get("caldera:par_total"), Some(Value::Nat(Nat::from(30u64))));
        assert_eq!(get("caldera:play_count"), Some(Value::Nat(Nat::from(0u64))));
        assert_eq!(get("caldera:tickets_distributed"), Some(Value::Nat(Nat::from(0u64))));
        assert_eq!(get("caldera:mint_fee_e8s"), Some(Value::Nat(Nat::from(50_000_000u64))));
        assert!(get("caldera:created_at").is_some());
        // unknown id -> None
        assert!(icrc7_token_metadata(vec![Nat::from(99999u64)])[0].is_none());
    }

    // ---- counters monotonic + minter gated ----

    #[test]
    fn counters_monotonic_and_minter_gated() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        assert_eq!(bump_play_count(id, 3).unwrap(), 3);
        assert_eq!(bump_play_count(id, 2).unwrap(), 5);
        assert_eq!(add_tickets_distributed(id, 10).unwrap(), 10);
        assert_eq!(add_tickets_distributed(id, 5).unwrap(), 15);
        // unknown id
        assert!(bump_play_count(999, 1).is_err());
        assert!(add_tickets_distributed(999, 1).is_err());
        // gate
        set_mock_caller(p(99));
        assert_eq!(require_minter(), Err("NOT_MINTER".to_string()));
    }

    // ---- batch caps (C5) ----

    #[test]
    #[should_panic(expected = "BATCH_TOO_LARGE")]
    fn metadata_batch_over_25_rejected() {
        fresh();
        let ids: Vec<Nat> = (0..26).map(|i| Nat::from(i as u64)).collect();
        let _ = icrc7_token_metadata(ids);
    }

    #[test]
    fn metadata_batch_at_25_ok() {
        fresh();
        let ids: Vec<Nat> = (0..25).map(|i| Nat::from(i as u64)).collect();
        let out = icrc7_token_metadata(ids);
        assert_eq!(out.len(), 25);
    }

    #[test]
    #[should_panic(expected = "BATCH_TOO_LARGE")]
    fn owner_of_batch_over_100_rejected() {
        fresh();
        let ids: Vec<Nat> = (0..101).map(|i| Nat::from(i as u64)).collect();
        let _ = icrc7_owner_of(ids);
    }

    #[test]
    fn light_batch_at_100_ok() {
        fresh();
        let ids: Vec<Nat> = (0..100).map(|i| Nat::from(i as u64)).collect();
        assert_eq!(icrc7_owner_of(ids).len(), 100);
    }

    // ---- C1 nat overflow -> None ----

    #[test]
    fn nat_overflow_owner_of_is_none() {
        fresh();
        let over = Nat::from(u64::MAX) + Nat::from(1u64);
        let res = icrc7_owner_of(vec![over]);
        assert!(res[0].is_none());
    }

    #[test]
    fn nat_to_u64_boundaries() {
        assert_eq!(nat_to_u64(&Nat::from(0u64)), Some(0));
        assert_eq!(nat_to_u64(&Nat::from(u64::MAX)), Some(u64::MAX));
        assert_eq!(nat_to_u64(&(Nat::from(u64::MAX) + Nat::from(1u64))), None);
    }

    // ---- C2 OwnerTokenKey ----

    #[test]
    fn owner_token_key_roundtrip_is_38_bytes() {
        let key = OwnerTokenKey { owner: p(7), token_id: 123_456_789 };
        let bytes = key.to_bytes();
        assert_eq!(bytes.len(), 38, "key must be fixed 38 bytes");
        let back = OwnerTokenKey::from_bytes(Cow::Owned(bytes.to_vec()));
        assert_eq!(back, key);
        // anonymous principal (short) round-trips too
        let key2 = OwnerTokenKey { owner: Principal::anonymous(), token_id: 0 };
        let b2 = key2.to_bytes();
        assert_eq!(b2.len(), 38);
        assert_eq!(OwnerTokenKey::from_bytes(Cow::Owned(b2.to_vec())), key2);
    }

    #[test]
    fn owner_token_key_orders_by_owner_then_id() {
        // bytes must sort by (owner, token_id) so range(owner..) works
        let a = OwnerTokenKey { owner: p(1), token_id: 5 };
        let b = OwnerTokenKey { owner: p(1), token_id: 300 };
        let c = OwnerTokenKey { owner: p(2), token_id: 1 };
        assert!(a.to_bytes() < b.to_bytes());
        assert!(b.to_bytes() < c.to_bytes());
    }

    #[test]
    fn tokens_of_range_isolates_owner_across_byte_boundaries() {
        // C2: mint > 256 tokens interleaved to two owners so token_id high byte
        // varies; assert icrc7_tokens_of returns exactly one owner's ids, in order.
        fresh();
        let owner_a = p(10);
        let owner_b = p(20);
        let mut a_ids = Vec::new();
        let mut b_ids = Vec::new();
        for i in 0..300u64 {
            if i % 2 == 0 {
                let id = mint(good_mint(owner_a, "A")).unwrap();
                a_ids.push(id);
            } else {
                let id = mint(good_mint(owner_b, "B")).unwrap();
                b_ids.push(id);
            }
        }
        assert!(a_ids.len() >= 150 && b_ids.len() >= 150);

        // paginate owner A fully and compare to expected ascending ids
        let mut got_a: Vec<u64> = Vec::new();
        let mut prev: Option<Nat> = None;
        loop {
            let page = icrc7_tokens_of(
                Account::from_owner(owner_a),
                prev.clone(),
                Some(Nat::from(50u64)),
            );
            if page.is_empty() {
                break;
            }
            for n in &page {
                got_a.push(nat_to_u64(n).unwrap());
            }
            prev = page.last().cloned();
        }
        // exactly owner A's ids, ascending, none of B's
        let mut expected_a = a_ids.clone();
        expected_a.sort_unstable();
        assert_eq!(got_a, expected_a);
        for id in &got_a {
            assert!(!b_ids.contains(id), "owner A leaked owner B id {id}");
        }
        // balance matches
        assert_eq!(
            icrc7_balance_of(vec![Account::from_owner(owner_a)]),
            vec![Nat::from(a_ids.len() as u64)]
        );
    }

    // ---- icrc7_tokens pagination ----

    #[test]
    fn icrc7_tokens_paginates() {
        fresh();
        for _ in 0..5 {
            mint(good_mint(p(10), "A")).unwrap();
        }
        let page1 = icrc7_tokens(None, Some(Nat::from(2u64)));
        assert_eq!(page1, vec![Nat::from(1u64), Nat::from(2u64)]);
        let page2 = icrc7_tokens(page1.last().cloned(), Some(Nat::from(2u64)));
        assert_eq!(page2, vec![Nat::from(3u64), Nat::from(4u64)]);
        let page3 = icrc7_tokens(page2.last().cloned(), Some(Nat::from(2u64)));
        assert_eq!(page3, vec![Nat::from(5u64)]);
    }

    // ---- admin / config ----

    #[test]
    fn set_minter_admin_gated() {
        fresh();
        // non-admin, non-controller caller blocked
        set_mock_caller(p(99));
        assert_eq!(require_admin(), Err("NOT_ADMIN".to_string()));
        // admin allowed
        set_mock_caller(admin());
        assert!(require_admin().is_ok());
        set_minter(p(42)).unwrap();
        assert_eq!(config().minter, p(42));
        // controller (even if not the admin principal) allowed
        set_mock_caller(p(55));
        set_mock_controllers(vec![p(55)]);
        assert!(require_admin().is_ok());
        set_admin(p(60)).unwrap();
        assert_eq!(config().admin, p(60));
    }

    // ---- storable round-trip ----

    #[test]
    fn course_token_storable_roundtrip() {
        let tok = CourseToken {
            owner: p(3),
            name: "Round Trip".to_string(),
            creator: p(4),
            created_at: 12345,
            course_data: vec![1, 2, 3, 255, 0],
            par_total: 36,
            play_count: 7,
            tickets_distributed: 11,
            mint_fee_e8s: 50_000_000,
        };
        let bytes = tok.to_bytes();
        let back = CourseToken::from_bytes(Cow::Owned(bytes.to_vec()));
        assert_eq!(back.owner, tok.owner);
        assert_eq!(back.name, tok.name);
        assert_eq!(back.creator, tok.creator);
        assert_eq!(back.created_at, tok.created_at);
        assert_eq!(back.course_data, tok.course_data);
        assert_eq!(back.par_total, tok.par_total);
        assert_eq!(back.play_count, tok.play_count);
        assert_eq!(back.tickets_distributed, tok.tickets_distributed);
        assert_eq!(back.mint_fee_e8s, tok.mint_fee_e8s);
    }

    #[test]
    fn nft_config_storable_roundtrip() {
        let cfg = NftConfig {
            minter: p(1),
            admin: p(2),
            symbol: "CALCRS".to_string(),
            name: "N".to_string(),
            description: "D".to_string(),
            supply_cap: Some(1000),
        };
        let bytes = cfg.to_bytes();
        let back = NftConfig::from_bytes(Cow::Owned(bytes.to_vec()));
        assert_eq!(back.minter, cfg.minter);
        assert_eq!(back.admin, cfg.admin);
        assert_eq!(back.supply_cap, cfg.supply_cap);
    }

    // ---- burn (owner-or-minter) ----

    #[test]
    fn burn_by_owner_removes_token_and_index() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        assert_eq!(icrc7_total_supply(), Nat::from(1u64));
        // owner burns
        set_mock_caller(p(10));
        assert!(burn(Nat::from(id)).is_ok());
        // gone from TOKENS, index, supply
        assert!(icrc7_owner_of(vec![Nat::from(id)])[0].is_none());
        assert!(icrc7_token_metadata(vec![Nat::from(id)])[0].is_none());
        assert!(icrc7_tokens_of(Account::from_owner(p(10)), None, None).is_empty());
        assert_eq!(icrc7_balance_of(vec![Account::from_owner(p(10))]), vec![Nat::from(0u64)]);
        assert_eq!(icrc7_total_supply(), Nat::from(0u64));
    }

    #[test]
    fn burn_by_minter_allowed() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // minter (default caller) burns someone else's token
        set_mock_caller(minter());
        assert!(burn(Nat::from(id)).is_ok());
        assert!(icrc7_owner_of(vec![Nat::from(id)])[0].is_none());
    }

    #[test]
    fn burn_rejects_non_owner_non_minter() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        set_mock_caller(p(99));
        assert_eq!(burn(Nat::from(id)), Err("UNAUTHORIZED".to_string()));
        // token still present
        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(10));
    }

    #[test]
    fn burn_rejects_anonymous() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        set_mock_caller(Principal::anonymous());
        assert_eq!(burn(Nat::from(id)), Err("ANONYMOUS_NOT_ALLOWED".to_string()));
    }

    #[test]
    fn burn_rejects_unknown_and_already_burned() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        set_mock_caller(p(10));
        assert!(burn(Nat::from(id)).is_ok());
        // already burned
        assert_eq!(burn(Nat::from(id)), Err("NON_EXISTING_TOKEN".to_string()));
        // never existed
        assert_eq!(burn(Nat::from(424242u64)), Err("NON_EXISTING_TOKEN".to_string()));
        // out-of-u64 id
        let over = Nat::from(u64::MAX) + Nat::from(1u64);
        assert_eq!(burn(over), Err("NON_EXISTING_TOKEN".to_string()));
    }

    #[test]
    fn burned_id_is_never_reminted_or_transferable() {
        fresh();
        let id1 = mint(good_mint(p(10), "A")).unwrap();
        assert_eq!(id1, 1);
        set_mock_caller(p(10));
        assert!(burn(Nat::from(id1)).is_ok());
        // next mint gets a FRESH id, never reuses 1
        set_mock_caller(minter());
        let id2 = mint(good_mint(p(11), "B")).unwrap();
        assert_eq!(id2, 2, "burned id must never be re-minted");
        // owner-of / metadata for burned id stay None
        assert!(icrc7_owner_of(vec![Nat::from(id1)])[0].is_none());
        // transfer of a burned id -> NonExistingTokenId
        set_mock_caller(p(10));
        let res = icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id1),
            to: Account::from_owner(p(50)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert!(matches!(res[0], Some(Err(TransferError::NonExistingTokenId))));
        // custodial_transfer of a burned id -> error
        set_mock_caller(minter());
        assert_eq!(custodial_transfer(id1, p(50)), Err("NON_EXISTING_TOKEN".to_string()));
    }

    // ---- http_request ----

    fn get(url: &str) -> HttpResponse {
        http_request(HttpRequest {
            method: "GET".to_string(),
            url: url.to_string(),
            headers: vec![],
            body: vec![],
        })
    }

    fn body_str(r: &HttpResponse) -> String {
        String::from_utf8(r.body.clone()).unwrap()
    }

    #[test]
    fn http_collection_root_returns_json() {
        fresh();
        mint(good_mint(p(10), "A")).unwrap();
        let r = get("/");
        assert_eq!(r.status_code, 200);
        assert!(r.headers.iter().any(|(k, v)| k == "Content-Type" && v == "application/json"));
        let b = body_str(&r);
        assert!(b.contains("\"total_supply\":1"), "{b}");
        assert!(b.contains("\"symbol\":\"CALCRS\""), "{b}");
    }

    #[test]
    fn http_token_returns_json_metadata() {
        fresh();
        let mut args = good_mint(p(10), "My \"Course\"");
        args.creator = p(77);
        let id = mint(args).unwrap();
        bump_play_count(id, 4).unwrap();
        let r = get(&format!("/token/{id}"));
        assert_eq!(r.status_code, 200);
        let b = body_str(&r);
        assert!(b.contains(&format!("\"token_id\":{id}")), "{b}");
        // name is JSON-escaped (no injection)
        assert!(b.contains("\"name\":\"My \\\"Course\\\"\""), "{b}");
        assert!(b.contains(&format!("\"creator\":\"{}\"", p(77).to_text())), "{b}");
        assert!(b.contains(&format!("\"owner\":\"{}\"", p(10).to_text())), "{b}");
        assert!(b.contains("\"play_count\":4"), "{b}");
        assert!(b.contains("\"course_data_len\":4"), "{b}");
        // raw blob NOT inlined here
        assert!(!b.contains("course_data_base64"), "{b}");
        // non-JSON blob (the 4-byte fixture) → course embeds as null.
        assert!(b.contains("\"course\":null"), "{b}");
    }

    #[test]
    fn http_token_embeds_course_json() {
        fresh();
        // Build-instructions JSON with odd whitespace/ordering — the embed is a
        // compact re-serialization, so the token page must parse as one JSON
        // document with the course nested inside it.
        let course = "{ \"holes\": [ {\"par\": 3, \"layout\": [\"#T#\", \"#C#\"]} ],\n  \"name\": \"Emb \\\"Test\\\"\", \"format\": \"proof-of-burn/minigolf-course@1\" }";
        let mut args = good_mint(p(10), "Embedded");
        args.course_data = course.as_bytes().to_vec();
        let id = mint(args).unwrap();
        let r = get(&format!("/token/{id}"));
        assert_eq!(r.status_code, 200);
        let doc: serde_json::Value = serde_json::from_str(&body_str(&r)).unwrap();
        assert_eq!(doc["token_id"], serde_json::json!(id));
        assert_eq!(doc["course"]["name"], serde_json::json!("Emb \"Test\""));
        assert_eq!(doc["course"]["format"], serde_json::json!("proof-of-burn/minigolf-course@1"));
        assert_eq!(doc["course"]["holes"][0]["par"], serde_json::json!(3));
        assert_eq!(doc["course"]["holes"][0]["layout"][1], serde_json::json!("#C#"));
    }

    #[test]
    fn http_token_malformed_json_blob_embeds_null() {
        fresh();
        // Starts with '{' but is NOT valid JSON — must never corrupt the token
        // document; it embeds as null and the page still parses.
        let mut args = good_mint(p(10), "Broken");
        args.course_data = b"{\"name\": broken".to_vec();
        let id = mint(args).unwrap();
        let doc: serde_json::Value =
            serde_json::from_str(&body_str(&get(&format!("/token/{id}")))).unwrap();
        assert!(doc["course"].is_null());
        assert_eq!(doc["name"], serde_json::json!("Broken"));
    }

    #[test]
    fn http_course_data_route_returns_base64() {
        fresh();
        let mut args = good_mint(p(10), "A");
        args.course_data = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let id = mint(args).unwrap();
        let r = get(&format!("/token/{id}/course_data"));
        assert_eq!(r.status_code, 200);
        let b = body_str(&r);
        // base64 of DEADBEEF == "3q2+7w=="
        assert!(b.contains("\"course_data_base64\":\"3q2+7w==\""), "{b}");
    }

    #[test]
    fn http_404_for_missing_and_burned() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // missing
        assert_eq!(get("/token/999999").status_code, 404);
        // burn then 404
        set_mock_caller(p(10));
        burn(Nat::from(id)).unwrap();
        assert_eq!(get(&format!("/token/{id}")).status_code, 404);
        assert_eq!(get(&format!("/token/{id}/course_data")).status_code, 404);
    }

    #[test]
    fn http_malformed_paths_never_trap() {
        fresh();
        // these must all return a status, not panic
        assert_eq!(get("/token/").status_code, 404);
        assert_eq!(get("/token/abc").status_code, 404);
        assert_eq!(get("/token/-1").status_code, 404);
        assert_eq!(get("/token/99999999999999999999999999").status_code, 404); // > u64
        assert_eq!(get("/token/1/2/3/4").status_code, 404);
        assert_eq!(get("/nonsense").status_code, 404);
        assert_eq!(get("////").status_code, 200); // collapses to root
        // query string + fragment tolerated
        assert_eq!(get("/?foo=bar").status_code, 200);
        // POST rejected, not trapped
        let r = http_request(HttpRequest {
            method: "POST".to_string(),
            url: "/".to_string(),
            headers: vec![],
            body: vec![],
        });
        assert_eq!(r.status_code, 405);
    }

    #[test]
    fn http_request_does_not_mutate_state() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let supply_before = icrc7_total_supply();
        let _ = get(&format!("/token/{id}"));
        let _ = get("/");
        let _ = get("/token/999");
        assert_eq!(icrc7_total_supply(), supply_before);
        assert_eq!(icrc7_owner_of(vec![Nat::from(id)])[0].as_ref().unwrap().owner, p(10));
    }

    // ---- security invariants ----

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn json_string_escapes_control_and_quotes() {
        assert_eq!(json_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(json_string("\n\t"), "\"\\n\\t\"");
        assert_eq!(json_string("\u{01}"), "\"\\u0001\"");
        // no raw HTML/quote can escape the JSON string context
        assert!(!json_string("</script>\"").contains("\"</script>\""));
    }

    #[test]
    fn creator_is_immutable_across_custodial_and_owner_transfers() {
        fresh();
        let mut args = good_mint(p(10), "A");
        args.creator = p(77);
        let id = mint(args).unwrap();
        let creator_of = |id: u64| -> String {
            let md = icrc7_token_metadata(vec![Nat::from(id)]);
            let map = md[0].clone().unwrap();
            match map.iter().find(|(k, _)| k == "caldera:creator").unwrap().1.clone() {
                Value::Text(t) => t,
                _ => panic!("creator not text"),
            }
        };
        assert_eq!(creator_of(id), p(77).to_text());
        custodial_transfer(id, p(20)).unwrap();
        assert_eq!(creator_of(id), p(77).to_text());
        set_mock_caller(p(20));
        icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(30)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        assert_eq!(creator_of(id), p(77).to_text());
    }

    #[test]
    fn id_allocation_uses_checked_add_no_panic() {
        fresh();
        // Drive NEXT_TOKEN_ID to the very top so checked_add must engage.
        NEXT_TOKEN_ID.with(|c| c.borrow_mut().set(u64::MAX));
        let err = mint(good_mint(p(10), "A")).unwrap_err();
        assert_eq!(err, "ID_SPACE_EXHAUSTED");
    }

    #[test]
    fn counters_saturate_no_overflow() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        bump_play_count(id, u64::MAX).unwrap();
        assert_eq!(bump_play_count(id, 5).unwrap(), u64::MAX);
        add_tickets_distributed(id, u64::MAX).unwrap();
        assert_eq!(add_tickets_distributed(id, 5).unwrap(), u64::MAX);
    }

    // ==========================================
    // HTTP certification (Response Verification v2)
    // ==========================================

    /// Pull the `IC-Certificate` header value off a response, if present.
    fn cert_header(r: &HttpResponse) -> Option<String> {
        r.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("IC-Certificate"))
            .map(|(_, v)| v.clone())
    }

    fn cert_expr_header(r: &HttpResponse) -> Option<String> {
        r.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(CERTIFICATE_EXPRESSION_HEADER_NAME))
            .map(|(_, v)| v.clone())
    }

    /// `http_request` with a mock data certificate present (mimics a query call).
    fn get_certified(url: &str) -> HttpResponse {
        set_mock_data_certificate(Some(vec![1, 2, 3, 4]));
        let r = get(url);
        set_mock_data_certificate(None);
        r
    }

    #[test]
    fn cert_root_changes_on_mint() {
        fresh();
        let before = cert_root();
        mint(good_mint(p(10), "A")).unwrap();
        let after = cert_root();
        assert_ne!(before, after, "minting must change the cert tree root hash");
    }

    #[test]
    fn cert_root_changes_on_burn() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let before = cert_root();
        set_mock_caller(p(10));
        burn(Nat::from(id)).unwrap();
        let after = cert_root();
        assert_ne!(before, after, "burning must change the cert tree root hash");
    }

    #[test]
    fn cert_root_changes_on_transfer() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        // custodial transfer changes the token's owner JSON → cert changes.
        let before = cert_root();
        custodial_transfer(id, p(20)).unwrap();
        let after_custodial = cert_root();
        assert_ne!(before, after_custodial, "custodial transfer must change root");

        // owner (icrc7) transfer also changes it.
        set_mock_caller(p(20));
        icrc7_transfer(vec![TransferArg {
            token_id: Nat::from(id),
            to: Account::from_owner(p(30)),
            from_subaccount: None,
            memo: None,
            created_at_time: None,
        }]);
        let after_owner = cert_root();
        assert_ne!(after_custodial, after_owner, "owner transfer must change root");
    }

    #[test]
    fn cert_root_changes_on_counter_bumps() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let r0 = cert_root();
        bump_play_count(id, 1).unwrap();
        let r1 = cert_root();
        assert_ne!(r0, r1, "play_count bump must change root");
        add_tickets_distributed(id, 1).unwrap();
        let r2 = cert_root();
        assert_ne!(r1, r2, "tickets bump must change root");
    }

    #[test]
    fn http_token_response_carries_certificate_header() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let r = get_certified(&format!("/token/{id}"));
        assert_eq!(r.status_code, 200);
        let ic_cert = cert_header(&r).expect("IC-Certificate header must be present");
        // v2 header shape: certificate=, tree=, expr_path=, version=2.
        assert!(ic_cert.contains("certificate="), "{ic_cert}");
        assert!(ic_cert.contains("tree="), "{ic_cert}");
        assert!(ic_cert.contains("expr_path="), "{ic_cert}");
        assert!(ic_cert.contains("version=2"), "{ic_cert}");
        // expression header advertised too.
        assert!(cert_expr_header(&r).is_some(), "expression header missing");
    }

    #[test]
    fn http_collection_root_carries_certificate_header() {
        fresh();
        mint(good_mint(p(10), "A")).unwrap();
        let r = get_certified("/");
        assert_eq!(r.status_code, 200);
        let ic_cert = cert_header(&r).expect("IC-Certificate header must be present for /");
        assert!(ic_cert.contains("version=2"), "{ic_cert}");
        assert!(cert_expr_header(&r).is_some());
    }

    #[test]
    fn http_course_data_route_carries_certificate_header() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let r = get_certified(&format!("/token/{id}/course_data"));
        assert_eq!(r.status_code, 200);
        assert!(cert_header(&r).is_some(), "course_data route must be certified");
    }

    #[test]
    fn http_unknown_id_returns_certified_404() {
        fresh();
        mint(good_mint(p(10), "A")).unwrap();
        let r = get_certified("/token/999999");
        assert_eq!(r.status_code, 404);
        // the 404 is certified via the wildcard entry.
        let ic_cert = cert_header(&r).expect("unknown-id 404 must carry IC-Certificate");
        assert!(ic_cert.contains("expr_path="), "{ic_cert}");
        assert!(ic_cert.contains("version=2"), "{ic_cert}");
    }

    #[test]
    fn http_burned_id_returns_certified_404() {
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        set_mock_caller(p(10));
        burn(Nat::from(id)).unwrap();
        let r = get_certified(&format!("/token/{id}"));
        assert_eq!(r.status_code, 404);
        assert!(cert_header(&r).is_some(), "burned-id 404 must be certified");
        // the raw blob route for the burned id is also a certified 404.
        let r2 = get_certified(&format!("/token/{id}/course_data"));
        assert_eq!(r2.status_code, 404);
        assert!(cert_header(&r2).is_some());
    }

    #[test]
    fn http_no_certificate_without_data_certificate() {
        // In a replicated/non-query context `data_certificate()` is None; we must
        // still return the body (no trap) but omit the IC-Certificate header.
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        set_mock_data_certificate(None);
        let r = get(&format!("/token/{id}"));
        assert_eq!(r.status_code, 200);
        assert!(cert_header(&r).is_none(), "no cert header without data_certificate");
        // expression header is still advertised.
        assert!(cert_expr_header(&r).is_some());
    }

    #[test]
    fn certified_body_matches_served_body_for_token() {
        // The bytes certified at mutation time must equal the bytes served, or the
        // gateway rejects. Both go through `build_route_response`, so assert equality.
        fresh();
        let id = mint(good_mint(p(10), "A")).unwrap();
        let served = get(&format!("/token/{id}"));
        let certified = cert_response_for(&format!("/token/{id}"));
        assert_eq!(served.body, certified.body().to_vec());
    }

    #[test]
    fn rebuild_cert_tree_is_deterministic() {
        // post_upgrade rebuilds the tree from stable storage; the root hash must be
        // identical to the incrementally-patched tree for the same token set.
        fresh();
        mint(good_mint(p(10), "A")).unwrap();
        mint(good_mint(p(11), "B")).unwrap();
        let incremental = cert_root();
        rebuild_cert_tree();
        let rebuilt = cert_root();
        assert_eq!(incremental, rebuilt, "rebuilt tree must match patched tree");
    }
}
