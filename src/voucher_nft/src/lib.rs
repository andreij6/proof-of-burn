// ==========================================
// Stake Voucher NFT (ICRC-7) — okf/ideas/stake-vouchers
// ==========================================
//
// A minimal ICRC-7 collection whose tokens are RECEIPTS on staked ICP held by
// the Cycle Burn backend's pooled neurons (class Backed), or tickets-only
// promo claims (class Promo). The BACKEND canister is the sole minter, burner
// AND transfer authority — the backend's voucher registry is the ownership
// source of truth, and this canister mirrors it so wallets can display the
// tokens. There is deliberately NO holder-callable transfer: every ownership
// move happens through backend endpoints (marketplace / buyback), so the
// registry and the NFT can never disagree (plan §2). Promo tokens are
// additionally SOULBOUND: even the minter cannot transfer them — burn only.
//
// Cloned from course_nft's skeleton (storage macro, guards, owner index,
// ICRC-7 query surface); the HTTP-certification section is intentionally
// dropped — wallets read vouchers via ICRC-7 queries, not the gateway.

use candid::{CandidType, Nat, Principal};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// ==========================================
// Validation Constants
// ==========================================

/// Lightweight batch query cap (ids/accounts only): standard ICRC-7 100 ids.
const MAX_QUERY_BATCH_SIZE: usize = 100;

const DEFAULT_SYMBOL: &str = "CBVCHR";
const DEFAULT_NAME: &str = "Cycle Burn Stake Vouchers";
const DEFAULT_DESCRIPTION: &str =
    "ICRC-7 receipts on ICP staked in Cycle Burn's pooled NNS neurons. Backed \
     vouchers are transferable claims (sellable on the in-app marketplace or \
     instantly bought back by the house); Promo vouchers are soulbound, \
     tickets-only trials. All ownership moves route through the backend.";

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

/// Voucher class — mirrors the backend registry's class byte.
/// 0 = Backed (claim on staked ICP), 1 = Promo (tickets-only, soulbound).
#[derive(CandidType, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoucherClass {
    Backed,
    Promo,
}

/// The authoritative per-token record.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct VoucherToken {
    pub owner: Principal,
    pub class: VoucherClass,
    /// Stake tier index (0 = 6mo, 1 = 1y, 2 = 2y). Promo tokens carry 0.
    pub tier: u8,
    /// Backed: the staked-ICP claim in e8s. Promo: 0.
    pub amount_e8s: u64,
    /// Mint time, ns.
    pub minted_at: u64,
    /// Promo only: ns timestamp after which the voucher stops earning.
    pub expires_at: Option<u64>,
}

/// Collection metadata + allowlisted minter / admin principals.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NftConfig {
    /// The backend canister principal — the ONLY principal that can mint,
    /// burn or move a token.
    pub minter: Principal,
    /// Deploy controller; may rotate `minter` (not a back door to move tokens).
    pub admin: Principal,
    pub symbol: String,
    pub name: String,
    pub description: String,
}

impl NftConfig {
    fn default_placeholder() -> Self {
        NftConfig {
            minter: Principal::anonymous(),
            admin: Principal::anonymous(),
            symbol: DEFAULT_SYMBOL.to_string(),
            name: DEFAULT_NAME.to_string(),
            description: DEFAULT_DESCRIPTION.to_string(),
        }
    }
}

/// Composite index key for `OWNER_TOKENS` (fixed-width big-endian; see the
/// course_nft C2 note — CBOR keys break `range(owner..)` ordering).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct OwnerTokenKey {
    pub owner: Principal,
    pub token_id: u64,
}

// ==========================================
// 2. Stable Storage Trait Impls
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

impl_storable!(VoucherToken);
impl_storable!(NftConfig);

impl Storable for OwnerTokenKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let p = self.owner.as_slice(); // <= 29 bytes
        let mut b = Vec::with_capacity(38);
        b.push(p.len() as u8);
        b.extend_from_slice(p);
        b.resize(30, 0);
        b.extend_from_slice(&self.token_id.to_be_bytes());
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

    // 0 — TOKENS (keyed by the BACKEND-SUPPLIED id: registry id == NFT id)
    static TOKENS: RefCell<StableBTreeMap<u64, VoucherToken, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(0)))));

    // 1 — OWNER_TOKENS index (range-scanned by owner)
    static OWNER_TOKENS: RefCell<StableBTreeMap<OwnerTokenKey, (), Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(1)))));

    // 2 — CONFIG
    static CONFIG: RefCell<StableCell<NftConfig, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(
            mm.borrow().get(MemoryId::new(2)), NftConfig::default_placeholder())));
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
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)]
fn set_mock_caller(caller: Principal) {
    TEST_MOCK_CALLER.with(|cell| *cell.borrow_mut() = caller);
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

/// Ingress-level gate: only the minter (the backend) or the admin ever has a
/// reason to send an update call here — everything else is query-only.
#[cfg(target_arch = "wasm32")]
#[ic_cdk::inspect_message]
fn inspect_message() {
    let caller = ic_cdk::api::caller();
    let cfg = config();
    if caller == cfg.minter || cfg.admin == caller {
        ic_cdk::api::call::accept_message();
    }
    // Anyone else: fall through WITHOUT accepting — the ingress is refused.
    // (inspect_message may only accept or decline; constructing a reject
    // message here violates the IC contract and traps the whole call path.)
}

fn require_minter() -> Result<(), String> {
    if get_caller() == config().minter {
        Ok(())
    } else {
        Err("UNAUTHORIZED: minter only".to_string())
    }
}

fn require_admin() -> Result<(), String> {
    if get_caller() == config().admin {
        Ok(())
    } else {
        Err("UNAUTHORIZED: admin only".to_string())
    }
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
}

#[ic_cdk::init]
fn init(args: InitArgs) {
    put_config(NftConfig {
        minter: args.minter,
        admin: args.admin,
        symbol: args.symbol.unwrap_or_else(|| DEFAULT_SYMBOL.to_string()),
        name: args.name.unwrap_or_else(|| DEFAULT_NAME.to_string()),
        description: DEFAULT_DESCRIPTION.to_string(),
    });
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Stable structures auto-restore; nothing else to rebuild (no cert tree).
}

// ==========================================
// 6. Admin API
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
// 7. Minter (custodial) API — the backend's mirror surface
// ==========================================

#[derive(CandidType, Deserialize)]
pub struct MintArgs {
    /// Backend registry id — the NFT is minted with EXACTLY this id so the
    /// two systems can never disagree about which token is which.
    pub token_id: u64,
    pub to: Principal,
    pub class: VoucherClass,
    pub tier: u8,
    pub amount_e8s: u64,
    pub expires_at: Option<u64>,
}

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
    if args.to == Principal::anonymous() {
        return Err("INVALID_OWNER".to_string());
    }
    if TOKENS.with(|t| t.borrow().contains_key(&args.token_id)) {
        return Err("TOKEN_ID_TAKEN".to_string());
    }
    let token = VoucherToken {
        owner: args.to,
        class: args.class,
        tier: args.tier,
        amount_e8s: args.amount_e8s,
        minted_at: now_ns(),
        expires_at: args.expires_at,
    };
    TOKENS.with(|t| {
        t.borrow_mut().insert(args.token_id, token);
    });
    index_owner(args.to, args.token_id);
    Ok(args.token_id)
}

/// Move a token between owners. Minter-only — holders sell/buy through the
/// backend marketplace, never here. Promo tokens are SOULBOUND: no transfer
/// path exists for them at all (burn only).
#[ic_cdk::update(guard = "require_minter")]
fn custodial_transfer(from: Principal, to: Principal, token_id: u64) -> Result<(), String> {
    TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let mut token = tokens.get(&token_id).ok_or("NON_EXISTING_TOKEN")?;
        if token.class == VoucherClass::Promo {
            return Err("SOULBOUND".to_string());
        }
        if token.owner != from {
            return Err("TRANSFER_ERR: from != owner".to_string());
        }
        if from == to {
            return Ok(());
        }
        token.owner = to;
        tokens.insert(token_id, token);
        unindex_owner(from, token_id);
        index_owner(to, token_id);
        Ok(())
    })
}

/// Burn (minter-only): unwrap, buyback and promo expiry cleanup all burn via
/// the backend. Ids are never re-minted (the backend's next-id only grows).
#[ic_cdk::update(guard = "require_minter")]
fn burn(token_id: u64) -> Result<(), String> {
    TOKENS.with(|t| {
        let mut tokens = t.borrow_mut();
        let token = tokens.get(&token_id).ok_or("NON_EXISTING_TOKEN")?;
        let owner = token.owner;
        tokens.remove(&token_id);
        unindex_owner(owner, token_id);
        Ok(())
    })
}

// ==========================================
// 8. ICRC-7 standard queries
// ==========================================

fn nat_to_u64(n: &Nat) -> Option<u64> {
    use std::convert::TryFrom;
    u64::try_from(n.0.clone()).ok()
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

#[ic_cdk::query]
fn icrc7_supply_cap() -> Option<Nat> {
    None
}

#[ic_cdk::query]
fn icrc7_collection_metadata() -> Vec<(String, Value)> {
    let cfg = config();
    vec![
        ("icrc7:symbol".to_string(), Value::Text(cfg.symbol)),
        ("icrc7:name".to_string(), Value::Text(cfg.name)),
        ("icrc7:description".to_string(), Value::Text(cfg.description)),
        ("icrc7:total_supply".to_string(), Value::Nat(Nat::from(token_count()))),
    ]
}

#[ic_cdk::query]
fn icrc7_owner_of(ids: Vec<Nat>) -> Vec<Option<Account>> {
    ids.iter()
        .take(MAX_QUERY_BATCH_SIZE)
        .map(|id| {
            nat_to_u64(id)
                .and_then(|id| TOKENS.with(|t| t.borrow().get(&id)))
                .map(|tok| Account::from_owner(tok.owner))
        })
        .collect()
}

#[ic_cdk::query]
fn icrc7_balance_of(accs: Vec<Account>) -> Vec<Nat> {
    accs.iter()
        .take(MAX_QUERY_BATCH_SIZE)
        .map(|acc| {
            let start = OwnerTokenKey { owner: acc.owner, token_id: 0 };
            let end = OwnerTokenKey { owner: acc.owner, token_id: u64::MAX };
            let n = OWNER_TOKENS.with(|m| m.borrow().range(start..=end).count());
            Nat::from(n as u64)
        })
        .collect()
}

#[ic_cdk::query]
fn icrc7_tokens(prev: Option<Nat>, take: Option<Nat>) -> Vec<Nat> {
    let take = take
        .as_ref()
        .and_then(nat_to_u64)
        .map(|t| (t as usize).min(MAX_QUERY_BATCH_SIZE))
        .unwrap_or(MAX_QUERY_BATCH_SIZE);
    let start = prev.as_ref().and_then(nat_to_u64).map(|p| p + 1).unwrap_or(0);
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
    let start_id = prev.as_ref().and_then(nat_to_u64).map(|p| p + 1).unwrap_or(0);
    let start = OwnerTokenKey { owner: acc.owner, token_id: start_id };
    let end = OwnerTokenKey { owner: acc.owner, token_id: u64::MAX };
    OWNER_TOKENS.with(|m| {
        m.borrow()
            .range(start..=end)
            .take(take)
            .map(|e| Nat::from(e.key().token_id))
            .collect()
    })
}

fn token_metadata_map(tok: &VoucherToken) -> Vec<(String, Value)> {
    let class = match tok.class {
        VoucherClass::Backed => "backed",
        VoucherClass::Promo => "promo",
    };
    let tier = match tok.tier {
        0 => "6-month",
        1 => "1-year",
        _ => "2-year",
    };
    let mut m = vec![
        ("voucher:class".to_string(), Value::Text(class.to_string())),
        ("voucher:tier".to_string(), Value::Text(tier.to_string())),
        ("voucher:amount_e8s".to_string(), Value::Nat(Nat::from(tok.amount_e8s))),
        ("voucher:minted_at".to_string(), Value::Nat(Nat::from(tok.minted_at))),
    ];
    if let Some(exp) = tok.expires_at {
        m.push(("voucher:expires_at".to_string(), Value::Nat(Nat::from(exp))));
    }
    m
}

#[ic_cdk::query]
fn icrc7_token_metadata(ids: Vec<Nat>) -> Vec<Option<Vec<(String, Value)>>> {
    ids.iter()
        .take(MAX_QUERY_BATCH_SIZE)
        .map(|id| {
            nat_to_u64(id)
                .and_then(|id| TOKENS.with(|t| t.borrow().get(&id)))
                .map(|tok| token_metadata_map(&tok))
        })
        .collect()
}

// ==========================================
// 9. Native unit tests
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Principal {
        Principal::from_text(text).unwrap()
    }

    fn backend() -> Principal {
        p("a2cb4-hh777-77775-aaaba-cai")
    }

    fn alice() -> Principal {
        p("a3x4d-cbe4h-bwmck-2ijqm-tipnj-qc6no-76xwa-cke2a-kkgoa-66ytk-eqe")
    }

    fn bob() -> Principal {
        p("lsx3o-3lihd-6hhv3-lb4tc-gfb3q-gyzu7-wctui-vdigp-htdlc-f5maf-mae")
    }

    fn setup() {
        put_config(NftConfig {
            minter: backend(),
            admin: alice(),
            ..NftConfig::default_placeholder()
        });
        set_mock_caller(backend());
        // Wipe tokens between tests (thread-local stable structures persist
        // within a test thread).
        let ids: Vec<u64> = TOKENS.with(|t| t.borrow().iter().map(|e| *e.key()).collect());
        for id in ids {
            let _ = burn(id);
        }
    }

    fn mint_args(id: u64, to: Principal, class: VoucherClass) -> MintArgs {
        MintArgs { token_id: id, to, class, tier: 0, amount_e8s: 200_000_000, expires_at: None }
    }

    #[test]
    fn test_mint_transfer_burn_lifecycle() {
        setup();
        assert_eq!(mint(mint_args(7, alice(), VoucherClass::Backed)).unwrap(), 7);
        // Backend-supplied id is authoritative; duplicates rejected.
        assert_eq!(mint(mint_args(7, alice(), VoucherClass::Backed)).unwrap_err(), "TOKEN_ID_TAKEN");
        assert_eq!(
            icrc7_owner_of(vec![Nat::from(7u64)]),
            vec![Some(Account::from_owner(alice()))]
        );
        // Transfer moves ownership + index.
        custodial_transfer(alice(), bob(), 7).unwrap();
        assert_eq!(icrc7_tokens_of(Account::from_owner(bob()), None, None), vec![Nat::from(7u64)]);
        assert!(icrc7_tokens_of(Account::from_owner(alice()), None, None).is_empty());
        // Stale `from` rejected (registry desync guard).
        assert!(custodial_transfer(alice(), bob(), 7).unwrap_err().contains("from != owner"));
        // Burn retires the token.
        burn(7).unwrap();
        assert_eq!(icrc7_owner_of(vec![Nat::from(7u64)]), vec![None]);
        assert_eq!(burn(7).unwrap_err(), "NON_EXISTING_TOKEN");
    }

    #[test]
    fn test_promo_is_soulbound_and_metadata_carries_expiry() {
        setup();
        let mut args = mint_args(9, alice(), VoucherClass::Promo);
        args.amount_e8s = 0;
        args.expires_at = Some(123_456);
        mint(args).unwrap();
        assert_eq!(custodial_transfer(alice(), bob(), 9).unwrap_err(), "SOULBOUND");
        let md = icrc7_token_metadata(vec![Nat::from(9u64)]).remove(0).unwrap();
        assert!(md.iter().any(|(k, v)| k == "voucher:class" && *v == Value::Text("promo".into())));
        assert!(md.iter().any(|(k, v)| k == "voucher:expires_at" && *v == Value::Nat(Nat::from(123_456u64))));
        // Promo can still be burned (expiry cleanup path).
        burn(9).unwrap();
    }

    #[test]
    fn test_minter_gate() {
        setup();
        set_mock_caller(bob());
        assert!(require_minter().is_err());
        set_mock_caller(backend());
        assert!(require_minter().is_ok());
    }
}
