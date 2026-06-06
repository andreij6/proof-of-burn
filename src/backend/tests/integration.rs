//! PB-112 — PocketIC integration tests for the Proof of Burn backend.
//!
//! These exercise the *real* backend wasm inside a simulated IC, asserting the
//! canister-boundary behaviour that unit tests can't reach: ingress access
//! control, admin guards, and the public query surface.
//!
//! Prerequisites:
//!   - Build the wasm first:
//!       cargo build --target wasm32-unknown-unknown --release -p backend
//!   - A PocketIC server binary. Point at it with POCKET_IC_BIN, e.g.:
//!       POCKET_IC_BIN=~/.cache/dfinity/versions/<v>/pocket-ic cargo test -p backend --test integration
//!
//! If the wasm or the server binary is absent the tests skip with a message
//! rather than failing, so `cargo test` stays green for contributors who haven't
//! built the wasm.
//!
//! Scope covered here (no external canisters required):
//!   - anonymous ingress is rejected on update methods
//!   - admin guards reject non-admins; owner is admin
//!   - public queries return seeded data and correct anonymous eligibility
//!
//! Out of scope here (needs mock NNS + ICRC ledger + CMC subnets — tracked in
//! PB-112 as the remaining saga coverage): commit→settle→burn/refund end-to-end.

use candid::{encode_args, encode_one, decode_one, CandidType, Principal};
use pocket_ic::PocketIc;
use serde::Deserialize;

const OWNER_TEXT: &str = "gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe";

#[derive(CandidType)]
struct InitPayload {
    owner: Principal,
    primary_neuron_id: u64,
    default_threshold_e8s: u64,
    ai_price_e8s: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct Config {
    primary_neuron_id: u64,
    admins: Vec<Principal>,
    default_threshold: u64,
    ai_price_e8s: u64,
    ledger_canister_id: Principal,
    is_local: bool,
}

#[derive(CandidType, Deserialize, Debug)]
struct EligibilityInfo {
    tier: u8,
    authenticated: bool,
    following: bool,
    has_committed: bool,
    holdings_e8s: u64,
}

#[derive(CandidType, Deserialize, Debug)]
enum UnitResult {
    Ok,
    Err(String),
}

fn wasm_path() -> Option<std::path::PathBuf> {
    // tests run from the crate dir (src/backend); workspace target is ../../target
    let candidates = [
        "../../target/wasm32-unknown-unknown/release/backend.wasm",
        "target/wasm32-unknown-unknown/release/backend.wasm",
    ];
    candidates.iter().map(std::path::PathBuf::from).find(|p| p.exists())
}

/// Returns None (and prints) if the environment can't run PocketIC, so tests skip.
fn setup() -> Option<(PocketIc, Principal)> {
    let wasm = match wasm_path() {
        Some(p) => p,
        None => {
            eprintln!("SKIP: backend.wasm not built — run `cargo build --target wasm32-unknown-unknown --release -p backend`");
            return None;
        }
    };
    // Locate a PocketIC server binary. Prefer POCKET_IC_BIN; otherwise probe the
    // dfx cache. Skip (don't fail) if none is found.
    if std::env::var("POCKET_IC_BIN").is_err() {
        let home = std::env::var("HOME").unwrap_or_default();
        let probes = [
            format!("{home}/.cache/pocket-ic/pocket-ic"),
            format!("{home}/.cache/dfinity/versions/0.29.2/pocket-ic"),
        ];
        match probes.iter().find(|p| std::path::Path::new(p).exists()) {
            Some(bin) => std::env::set_var("POCKET_IC_BIN", bin),
            None => {
                eprintln!("SKIP: no PocketIC server binary (set POCKET_IC_BIN)");
                return None;
            }
        }
    }

    let pic = PocketIc::new();
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let canister = pic.create_canister();
    pic.add_cycles(canister, 4_000_000_000_000);

    let wasm_bytes = std::fs::read(&wasm).expect("read backend wasm");
    let init = InitPayload {
        owner,
        primary_neuron_id: 4821667,
        default_threshold_e8s: 500_000_000_000,
        ai_price_e8s: 5_000_000,
    };
    pic.install_canister(
        canister,
        wasm_bytes,
        encode_one(init).unwrap(),
        None,
    );
    Some((pic, canister))
}

#[test]
fn anonymous_is_rejected_on_updates() {
    let Some((pic, canister)) = setup() else { return };
    // register_neuron is an update; anonymous ingress must be rejected by inspect_message.
    let res = pic.update_call(
        canister,
        Principal::anonymous(),
        "register_neuron",
        encode_one(4821667u64).unwrap(),
    );
    assert!(res.is_err(), "anonymous update must be rejected at ingress");
}

#[test]
fn owner_is_admin_and_config_is_correct() {
    let Some((pic, canister)) = setup() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let reply = pic
        .query_call(canister, owner, "get_config", encode_one(()).unwrap())
        .expect("get_config query");
    let cfg: Config = decode_one(&reply).unwrap();
    assert_eq!(cfg.admins, vec![owner], "owner must be the sole initial admin");
    assert_eq!(cfg.primary_neuron_id, 4821667);
    assert!(cfg.is_local, "owner == dev principal → is_local");
}

#[test]
fn non_admin_cannot_add_admin() {
    let Some((pic, canister)) = setup() else { return };
    let stranger = Principal::from_slice(&[9, 9, 9, 9]);
    let victim = Principal::from_slice(&[1, 2, 3, 4]);
    let res = pic.update_call(
        canister,
        stranger,
        "add_admin",
        encode_one(victim).unwrap(),
    );
    // Either rejected at ingress or returns Err — never Ok.
    if let Ok(bytes) = res {
        let r: UnitResult = decode_one(&bytes).unwrap();
        assert!(matches!(r, UnitResult::Err(_)), "non-admin add_admin must Err");
    }
}

#[test]
fn anonymous_eligibility_is_tier_zero() {
    let Some((pic, canister)) = setup() else { return };
    let reply = pic
        .query_call(
            canister,
            Principal::anonymous(),
            "get_eligibility",
            encode_one(()).unwrap(),
        )
        .expect("get_eligibility query");
    let elig: EligibilityInfo = decode_one(&reply).unwrap();
    assert_eq!(elig.tier, 0);
    assert!(!elig.authenticated);
    assert!(!elig.following);
}

#[test]
fn seeded_proposals_are_listed() {
    let Some((pic, canister)) = setup() else { return };
    let reply = pic
        .query_call(
            canister,
            Principal::anonymous(),
            "list_active_proposals",
            encode_args(()).unwrap(),
        )
        .expect("list_active_proposals query");
    let proposals: Vec<ProposalLite> = decode_one(&reply).expect("decode proposals");
    assert!(!proposals.is_empty(), "init seeds mock proposals");
}

#[derive(CandidType, Deserialize)]
struct ProposalLite {
    id: u64,
    title: String,
    category: String,
    deadline: u64,
    nns_proposal_id: Option<u64>,
    status: String,
    threshold_e8s: u64,
    total_committed_e8s: u64,
    adopt_pot_e8s: u64,
    reject_pot_e8s: u64,
    vote_executed_at: Option<u64>,
    total_burned_e8s: Option<u64>,
}
