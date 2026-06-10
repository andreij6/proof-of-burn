//! PB-112 — PocketIC integration tests for the Cycles of Influence backend.

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
//! Access-control / query coverage (no external canisters required):
//!   - anonymous ingress is rejected on update methods
//!   - admin guards reject non-admins; owner is admin
//!   - public queries return seeded data and correct anonymous eligibility
//!
//! Saga coverage (installs the project's ICRC ledger into PocketIC):
//!   - commit happy-path: deposit → commit → Pending, pots updated
//!   - refund: threshold missed → abstain → exact-target refund, escrow drained
//!   - burn idempotency (PB-111): threshold met → vote → burn; CMC notify fails →
//!     FailedBurn with block index persisted; retry does NOT transfer to the CMC
//!     twice (no double-spend)
//!
//! Burn *success* (a stubbed CMC returning notify Ok) remains future scope.

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
    ledger_canister_id: Option<Principal>,
}

#[derive(CandidType, Deserialize, Debug)]
struct Config {
    primary_neuron_id: u64,
    admins: Vec<Principal>,
    default_threshold: u64,
    ai_price_e8s: u64,
    ledger_canister_id: Principal,
    is_local: bool,
    frontend_canister_id: Option<Principal>,
    pool_initiation_fee_e8s: u64,
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
        ledger_canister_id: None,
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
    // confirm_follow is an update; anonymous ingress must be rejected by inspect_message.
    let res = pic.update_call(
        canister,
        Principal::anonymous(),
        "confirm_follow",
        encode_one(()).unwrap(),
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
    pool_distributed: bool,
}

// ════════════════════════════════════════════════════════════════════════════
// PB-112 — Burn/refund saga against a real ICRC ledger
// ════════════════════════════════════════════════════════════════════════════
// These install the project's ICRC-1 ledger wasm into PocketIC and drive the
// full deposit → commit → settle lifecycle. The backend points at the
// PocketIC-assigned ledger id via InitPayload.ledger_canister_id.
//
// NNS Governance and the CMC do not exist in the PocketIC instance, so:
//   - register_neuron / vote: the is_local mock fallback treats the NNS reject
//     as "following" / "vote cast" (exactly the local-dev behaviour).
//   - burn_to_cycles: the ledger transfer to the CMC account succeeds, but the
//     CMC notify_top_up rejects → FailedBurn. This lets us assert the PB-111
//     idempotency guarantee (a retry does NOT transfer to the CMC twice).
// Burn *success* (a stubbed CMC returning notify Ok) remains future scope.

const CMC_PRINCIPAL: &str = "rkp4c-7iaaa-aaaaa-aaaca-cai";

#[derive(CandidType, Clone)]
struct LAccount {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Clone)]
struct LAccountDe {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}

#[derive(CandidType)]
enum MetadataValue {
    Nat(candid::Nat),
    Int(i64),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(CandidType)]
struct ArchiveOptions {
    num_blocks_to_archive: u64,
    trigger_threshold: u64,
    controller_id: Principal,
}

#[derive(CandidType)]
struct FeatureFlags {
    icrc2: bool,
}

#[derive(CandidType)]
struct LedgerInitArgs {
    minting_account: LAccount,
    transfer_fee: candid::Nat,
    token_symbol: String,
    token_name: String,
    decimals: Option<u8>,
    metadata: Vec<(String, MetadataValue)>,
    initial_balances: Vec<(LAccount, candid::Nat)>,
    archive_options: ArchiveOptions,
    feature_flags: Option<FeatureFlags>,
}

#[derive(CandidType)]
enum LedgerArg {
    Init(LedgerInitArgs),
    Upgrade(Option<()>),
}

#[derive(CandidType)]
struct TransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: LAccount,
    amount: candid::Nat,
    fee: Option<candid::Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
enum TransferError {
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
enum TransferResult {
    Ok(candid::Nat),
    Err(TransferError),
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
enum Stance {
    Adopt,
    Reject,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
enum CommitmentStatus {
    Pending,
    ThresholdMet,
    Burned,
    Returned,
    FailedBurn,
    FailedRefund,
    StuckFunds,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
enum Vote {
    Yes,
    No,
    Abstain,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct VoteRecord {
    proposal_id: u64,
    vote: Vote,
    icp_burned_e8s: u64,
    decided_at: u64,
    nns_outcome: Option<String>,
}

#[derive(CandidType, Deserialize, Debug)]
struct Commitment {
    proposal_id: u64,
    principal: Principal,
    amount_e8s: u64,
    status: CommitmentStatus,
    created_at: u64,
    stance: Stance,
    subaccount: Vec<u8>,
    settled_at: Option<u64>,
    cmc_block_index: Option<u64>,
    treasury_block: Option<u64>,
    frontend_cmc_block: Option<u64>,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
enum PoolStatus {
    Draft,
    Active,
    Inactive,
}

#[derive(CandidType, Deserialize, Debug)]
struct PoolNeuron {
    neuron_id: u64,
    registered_by: Principal,
    voting_power: u64,
    status: PoolStatus,
    created_at: u64,
    activated_at: Option<u64>,
    treasury_block: Option<u64>,
    backend_cmc_block: Option<u64>,
    frontend_cmc_block: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
struct ActivePoolNeuron {
    neuron_id: u64,
    voting_power: u64,
    registered_by: Principal,
    rank: u32,
}

#[derive(CandidType, Deserialize, Debug)]
struct PoolInfo {
    total_pool_voting_power: u64,
    active_count: u64,
    active_neurons: Vec<ActivePoolNeuron>,
}

fn ledger_wasm() -> Option<Vec<u8>> {
    let candidates = [
        "ledger.wasm.gz",
        "src/backend/ledger.wasm.gz",
        "../../src/backend/ledger.wasm.gz",
    ];
    candidates
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
        .map(|p| std::fs::read(p).expect("read ledger wasm"))
}

struct SagaEnv {
    pic: PocketIc,
    backend: Principal,
    ledger: Principal,
    user: Principal,
    minter: Principal,
}

impl SagaEnv {
    /// Mint ICP to an account by transferring from the ledger minting account.
    fn mint(&self, to: Principal, amount_e8s: u64) {
        let xfer = TransferArg {
            from_subaccount: None,
            to: LAccount { owner: to, subaccount: None },
            amount: candid::Nat::from(amount_e8s),
            fee: None, // minting transfers pay no fee
            memo: None,
            created_at_time: None,
        };
        let res = self
            .pic
            .update_call(self.ledger, self.minter, "icrc1_transfer", encode_one(xfer).unwrap())
            .expect("mint call");
        let res: TransferResult = decode_one(&res).unwrap();
        assert!(matches!(res, TransferResult::Ok(_)), "mint failed: {:?}", res);
    }
}

/// Full environment: ICRC ledger (user pre-funded) + backend pointed at it.
fn setup_saga() -> Option<SagaEnv> {
    let wasm = wasm_path()?;
    let lwasm = match ledger_wasm() {
        Some(w) => w,
        None => {
            eprintln!("SKIP: ledger.wasm.gz not found");
            return None;
        }
    };
    if std::env::var("POCKET_IC_BIN").is_err() {
        let home = std::env::var("HOME").unwrap_or_default();
        let probes = [
            format!("{home}/.cache/pocket-ic/pocket-ic"),
            format!("{home}/.cache/dfinity/versions/0.29.2/pocket-ic"),
        ];
        match probes.iter().find(|p| std::path::Path::new(p).exists()) {
            Some(bin) => std::env::set_var("POCKET_IC_BIN", bin),
            None => {
                eprintln!("SKIP: no PocketIC server binary");
                return None;
            }
        }
    }

    let pic = PocketIc::new();
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let user = Principal::from_slice(&[7, 7, 7, 7, 7, 7]);
    let minter = Principal::from_slice(&[1]);

    // Install ICRC ledger at a PocketIC-assigned id, funding the test user.
    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 4_000_000_000_000);
    let ledger_init = LedgerArg::Init(LedgerInitArgs {
        minting_account: LAccount { owner: minter, subaccount: None },
        transfer_fee: candid::Nat::from(10_000u64),
        token_symbol: "ICP".to_string(),
        token_name: "Internet Computer".to_string(),
        decimals: Some(8),
        metadata: vec![],
        initial_balances: vec![(
            LAccount { owner: user, subaccount: None },
            candid::Nat::from(10_000_000_000_000u64), // 100,000 ICP
        )],
        archive_options: ArchiveOptions {
            num_blocks_to_archive: 1000,
            trigger_threshold: 2000,
            controller_id: owner,
        },
        feature_flags: Some(FeatureFlags { icrc2: true }),
    });
    pic.install_canister(ledger, lwasm, encode_one(ledger_init).unwrap(), None);

    // Install backend pointed at that ledger.
    let backend = pic.create_canister();
    // Above the 5T cycle_topup_check floor so auto-topup doesn't sweep the
    // treasury → CMC during settlement and skew the split-balance assertions.
    pic.add_cycles(backend, 50_000_000_000_000);
    let init = InitPayload {
        owner,
        primary_neuron_id: 4821667,
        // 100 ICP threshold — reachable within the 1000 ICP mock stake cap so the
        // burn-path test can actually meet it; refund test commits below it.
        default_threshold_e8s: 10_000_000_000,
        ai_price_e8s: 5_000_000,
        ledger_canister_id: Some(ledger),
    };
    pic.install_canister(backend, std::fs::read(&wasm).unwrap(), encode_one(init).unwrap(), None);

    Some(SagaEnv { pic, backend, ledger, user, minter })
}

fn balance_of(env: &SagaEnv, owner: Principal, sub: Option<Vec<u8>>) -> u64 {
    let acct = LAccount { owner, subaccount: sub };
    let reply = env
        .pic
        .query_call(env.ledger, Principal::anonymous(), "icrc1_balance_of", encode_one(acct).unwrap())
        .expect("balance query");
    let n: candid::Nat = decode_one(&reply).unwrap();
    n.0.try_into().unwrap_or(0)
}

fn my_commitments(env: &SagaEnv) -> Vec<Commitment> {
    let reply = env
        .pic
        .query_call(env.backend, env.user, "get_my_commitments", encode_one(()).unwrap())
        .expect("get_my_commitments");
    decode_one(&reply).unwrap()
}

/// mint → register → deposit escrow → commit, as `user`. Returns the commit Result.
fn do_commit_as(env: &SagaEnv, user: Principal, proposal_id: u64, stance: Stance, target_e8s: u64) -> UnitResult {
    // 0. ensure the user has funds (target + protocol/ledger fees + headroom)
    env.mint(user, target_e8s + 1_000_000);

    // 1. self-attested follow (Option C — no on-chain neuron verification)
    let reg = env
        .pic
        .update_call(env.backend, user, "confirm_follow", encode_one(()).unwrap())
        .expect("confirm_follow call");
    let reg: UnitResult = decode_one(&reg).unwrap();
    assert!(matches!(reg, UnitResult::Ok), "confirm_follow should succeed: {:?}", reg);

    // 2. fetch escrow deposit address
    let reply = env
        .pic
        .query_call(env.backend, user, "get_deposit_address", encode_one(proposal_id).unwrap())
        .expect("get_deposit_address");
    let escrow: LAccountDe = decode_one(&reply).unwrap();

    // 3. user deposits target + 540_000 into escrow (covers the commit fee +
    //    the three settlement-split transfers' ledger fees)
    let deposit = target_e8s + 540_000;
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: escrow.owner, subaccount: escrow.subaccount },
        amount: candid::Nat::from(deposit),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let res = env
        .pic
        .update_call(env.ledger, user, "icrc1_transfer", encode_one(xfer).unwrap())
        .expect("icrc1_transfer call");
    let res: TransferResult = decode_one(&res).unwrap();
    assert!(matches!(res, TransferResult::Ok(_)), "escrow deposit failed: {:?}", res);

    // 4. commit
    let reply = env
        .pic
        .update_call(env.backend, user, "commit", encode_args((proposal_id, stance, target_e8s)).unwrap())
        .expect("commit call");
    decode_one(&reply).unwrap()
}

/// Convenience: commit as the env's default pre-funded user.
fn do_commit(env: &SagaEnv, proposal_id: u64, stance: Stance, target_e8s: u64) -> UnitResult {
    do_commit_as(env, env.user, proposal_id, stance, target_e8s)
}

/// Move past the proposal's 1h commit cutoff and run settlement.
fn trigger_settlement(env: &SagaEnv, proposal_id: u64) {
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let pic_now = env.pic.get_time().as_nanos_since_unix_epoch();
    // deadline just beyond now+cutoff to pass validation, then advance time past it.
    let deadline = pic_now + 3_600_000_000_000 + 60_000_000_000;
    let r = env
        .pic
        .update_call(
            env.backend,
            owner,
            "admin_set_proposal_deadline",
            encode_args((proposal_id, deadline)).unwrap(),
        )
        .expect("set deadline");
    let r: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(r, UnitResult::Ok), "set deadline: {:?}", r);

    env.pic.advance_time(std::time::Duration::from_secs(7200)); // +2h
    env.pic.tick();

    let r = env
        .pic
        .update_call(env.backend, owner, "admin_trigger_sweep", encode_one(()).unwrap())
        .expect("admin_trigger_sweep");
    let _: UnitResult = decode_one(&r).unwrap();
    // Flush any inter-canister settlement messages.
    for _ in 0..5 {
        env.pic.tick();
    }
}

#[test]
fn saga_commit_happy_path() {
    let Some(env) = setup_saga() else { return };
    let target = 50_000_000_000u64; // 500 ICP — meets threshold
    let res = do_commit(&env, 138402, Stance::Adopt, target);
    assert!(matches!(res, UnitResult::Ok), "commit should succeed: {:?}", res);

    let commits = my_commitments(&env);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].amount_e8s, target);
    assert_eq!(commits[0].status, CommitmentStatus::Pending);
    assert_eq!(commits[0].stance, Stance::Adopt);
    assert!(commits[0].cmc_block_index.is_none());
}

#[test]
fn saga_refund_when_threshold_missed() {
    let Some(env) = setup_saga() else { return };
    let target = 100_000_000u64; // 1 ICP — below 138402's 2 ICP threshold (stays unmet → refund)
    let res = do_commit(&env, 138402, Stance::Reject, target);
    assert!(matches!(res, UnitResult::Ok), "commit: {:?}", res);

    // Balance after the escrow deposit, before settlement.
    let mid = balance_of(&env, env.user, None);

    trigger_settlement(&env, 138402);

    let commits = my_commitments(&env);
    assert_eq!(commits[0].status, CommitmentStatus::Returned, "unmet threshold must refund");

    // Refund returns exactly the target to the user (the refund's ledger fee is
    // covered by the extra reserve held in escrow, not the returned amount).
    let after = balance_of(&env, env.user, None);
    assert_eq!(after, mid + target, "refund must return exactly the committed target");

    // Escrow subaccount is fully drained after refund.
    let reply = env
        .pic
        .query_call(env.backend, env.user, "get_deposit_address", encode_one(138402u64).unwrap())
        .expect("get_deposit_address");
    let escrow: LAccountDe = decode_one(&reply).unwrap();
    let escrow_bal = balance_of(&env, escrow.owner, escrow.subaccount);
    // The refund returns the target; the unused settlement-fee reserve (~20_000)
    // remains as dust in the escrow subaccount (sweepable later).
    assert_eq!(escrow_bal, 20_000, "only the unused fee reserve remains after refund");

    // Verify that the proposal status in backend is "abstained"
    let reply = env
        .pic
        .query_call(env.backend, env.user, "list_all_proposals", encode_one(()).unwrap())
        .expect("list_all_proposals");
    let proposals: Vec<ProposalLite> = decode_one(&reply).unwrap();
    let p = proposals.iter().find(|p| p.id == 138402).expect("proposal found");
    assert_eq!(p.status, "abstained", "proposal status must be abstained");

    // Verify that the vote history has recorded the vote choice as Vote::No with 0 ICP burned
    let reply = env
        .pic
        .query_call(env.backend, env.user, "list_vote_history", encode_one(()).unwrap())
        .expect("list_vote_history");
    let vote_history: Vec<VoteRecord> = decode_one(&reply).unwrap();
    let vote_rec = vote_history.iter().find(|r| r.proposal_id == 138402).expect("vote record found");
    assert_eq!(vote_rec.vote, Vote::No, "neuron must vote No as per majority stance Reject");
    assert_eq!(vote_rec.icp_burned_e8s, 0, "icp burned must be 0 for unmet threshold");
}

#[test]
fn saga_burn_is_idempotent_on_cmc_failure() {
    let Some(env) = setup_saga() else { return };
    // Proposal 138402's seeded threshold is 5000 ICP and the per-user stake cap is
    // 1000 ICP, so meeting it requires several committers. 6 × 1000 ICP = 6000 ICP.
    // Proposal 138402 is seeded open against a 2 ICP threshold; two committers
    // (× 1000 ICP, the stake cap) comfortably cross it.
    // Proposal 138402 is seeded open against a 2 ICP threshold; two committers
    // (× 1000 ICP, the stake cap) comfortably cross it.
    let per_user = 100_000_000_000u64; // 1000 ICP (== stake cap, allowed)
    let n_users = 2u64;
    for i in 0..n_users {
        let u = Principal::from_slice(&[0xA0 + i as u8; 16]);
        let res = do_commit_as(&env, u, 138402, Stance::Adopt, per_user);
        assert!(matches!(res, UnitResult::Ok), "commit {i}: {:?}", res);
    }
    let total = per_user * n_users;
    let cmc = Principal::from_text(CMC_PRINCIPAL).unwrap();
    let treasury_sub = Some(vec![1u8; 32]); // TREASURY_SUBACCOUNT

    // First sweep: threshold met → vote (is_local mock Ok) → settle_burn_split:
    // 50% → treasury (ok), 25% → CMC transfer (ok), then notify_top_up rejects
    // (no CMC canister) → FailedBurn before the frontend 25% transfer.
    trigger_settlement(&env, 138402);

    let first_user = Principal::from_slice(&[0xA0; 16]);
    let reply = env
        .pic
        .query_call(env.backend, first_user, "get_my_commitments", encode_one(()).unwrap())
        .expect("get_my_commitments");
    let commits: Vec<Commitment> = decode_one(&reply).unwrap();
    assert_eq!(commits[0].status, CommitmentStatus::FailedBurn, "CMC notify fails → FailedBurn");
    assert!(commits[0].treasury_block.is_some(), "treasury 50% transferred");
    assert!(commits[0].cmc_block_index.is_some(), "backend-cycles 25% transferred");
    assert!(commits[0].frontend_cmc_block.is_none(), "frontend 25% not reached (notify failed first)");

    // 50% reached the treasury; 25% reached the CMC (backend share).
    let treasury_after_first = balance_of(&env, env.backend, treasury_sub.clone());
    
    let principal_to_subaccount = |p: &Principal| {
        let bytes = p.as_slice();
        let mut sub = vec![0u8; 32];
        sub[0] = bytes.len() as u8;
        sub[1..1 + bytes.len()].copy_from_slice(bytes);
        sub
    };
    let backend_sub = Some(principal_to_subaccount(&env.backend));

    let cmc_after_first = balance_of(&env, cmc, backend_sub.clone());
    assert_eq!(cmc_after_first, total / 4, "25% backend share reached the CMC once");
    // treasury = 50% of proceeds + the per-commit protocol fee (500_000 each).
    assert_eq!(treasury_after_first, total / 2 + n_users * 500_000, "50% + protocol fees in treasury");

    // Retry: completed transfers (treasury, backend CMC) are skipped — only the
    // failing notify re-runs. No funds move again.
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let r = env.pic.update_call(env.backend, owner, "admin_trigger_sweep", encode_one(()).unwrap()).expect("sweep2");
    let _: UnitResult = decode_one(&r).unwrap();

    assert_eq!(balance_of(&env, cmc, backend_sub), cmc_after_first, "PB-111: no double CMC transfer on retry");
    assert_eq!(balance_of(&env, env.backend, treasury_sub), treasury_after_first, "no double treasury transfer on retry");
}

// ── admin_set_default_threshold (runtime threshold control) ──────────────────

#[test]
fn admin_can_change_threshold_and_reapply() {
    let Some((pic, canister)) = setup() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();

    // Seeded config default is 2 ICP; 138388 is seeded "met" (2 ICP committed).
    // Raise the threshold to 5 ICP → config updates and 138388 (committed 2 < 5)
    // must flip back to "open".
    let new_threshold = 500_000_000u64; // 5 ICP
    let r = pic
        .update_call(canister, owner, "admin_set_default_threshold", encode_one(new_threshold).unwrap())
        .expect("admin_set_default_threshold");
    let r: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(r, UnitResult::Ok), "owner can set threshold: {:?}", r);

    let cfg: Config = decode_one(
        &pic.query_call(canister, owner, "get_config", encode_one(()).unwrap()).unwrap()
    ).unwrap();
    assert_eq!(cfg.default_threshold, new_threshold, "config default updated");

    let proposals: Vec<ProposalLite> = decode_one(
        &pic.query_call(canister, Principal::anonymous(), "list_active_proposals", encode_args(()).unwrap()).unwrap()
    ).unwrap();
    for p in &proposals {
        assert_eq!(p.threshold_e8s, new_threshold, "open/met proposals re-thresholded");
    }
    let p388 = proposals.iter().find(|p| p.id == 138388).expect("138388 present");
    assert_eq!(p388.status, "open", "previously-met proposal with committed < new threshold flips to open");
}

#[test]
fn non_admin_cannot_change_threshold() {
    let Some((pic, canister)) = setup() else { return };
    let stranger = Principal::from_slice(&[5, 5, 5, 5]);
    let res = pic.update_call(canister, stranger, "admin_set_default_threshold", encode_one(500_000_000u64).unwrap());
    if let Ok(bytes) = res {
        let r: UnitResult = decode_one(&bytes).unwrap();
        assert!(matches!(r, UnitResult::Err(_)), "non-admin set threshold must Err");
    }
}

#[test]
fn threshold_below_min_commit_is_rejected() {
    let Some((pic, canister)) = setup() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    // 0.5 ICP < 1 ICP MIN_COMMIT → rejected.
    let r = pic
        .update_call(canister, owner, "admin_set_default_threshold", encode_one(50_000_000u64).unwrap())
        .expect("call");
    let r: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(r, UnitResult::Err(_)), "sub-min-commit threshold must Err");
}

#[test]
fn admin_set_pool_fee_test() {
    let Some((pic, canister)) = setup() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let stranger = Principal::from_slice(&[5, 5, 5, 5]);

    // 1. Verify default initiation fee on fresh deploy
    let query_res = pic.query_call(
        canister,
        owner,
        "get_config",
        encode_one(()).unwrap()
    ).unwrap();
    let cfg: Config = decode_one(&query_res).unwrap();
    assert_eq!(cfg.pool_initiation_fee_e8s, 12_500_000_000);

    // 2. Reject 0 fee
    let r = pic
        .update_call(
            canister,
            owner,
            "admin_set_pool_fee",
            encode_one(0u64).unwrap()
        )
        .expect("call");
    let r: UnitResult = decode_one(&r).unwrap();
    assert!(
        matches!(r, UnitResult::Err(_)),
        "setting pool fee to 0 must Err"
    );

    // 3. Reject non-admin calls
    let r = pic.update_call(
        canister,
        stranger,
        "admin_set_pool_fee",
        encode_one(10_000_000_000u64).unwrap()
    );
    if let Ok(bytes) = r {
        let r: UnitResult = decode_one(&bytes).unwrap();
        assert!(
            matches!(r, UnitResult::Err(_)),
            "non-admin set pool fee must Err"
        );
    }

    // 4. Owner sets new fee successfully
    let new_fee = 10_000_000_000u64; // 100 ICP
    let r = pic
        .update_call(
            canister,
            owner,
            "admin_set_pool_fee",
            encode_one(new_fee).unwrap()
        )
        .expect("call");
    let r: UnitResult = decode_one(&r).unwrap();
    assert!(
        matches!(r, UnitResult::Ok),
        "owner can set pool fee: {:?}",
        r
    );

    // 5. Verify value updated in config
    let query_res = pic.query_call(
        canister,
        owner,
        "get_config",
        encode_one(()).unwrap()
    ).unwrap();
    let cfg: Config = decode_one(&query_res).unwrap();
    assert_eq!(cfg.pool_initiation_fee_e8s, new_fee);
}

#[test]
fn test_registration_refund_integration() {
    let Some(env) = setup_saga() else { return };

    // 1. Get registration address
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_registration_address",
            encode_one(()).unwrap()
        )
        .expect("get_registration_address");
    let reg_acc: LAccountDe = decode_one(&r).unwrap();

    // 2. Query empty refund -> expect NOTHING_TO_REFUND
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "refund_registration",
            encode_one(()).unwrap()
        )
        .expect("refund_registration empty");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(
        matches!(res, UnitResult::Err(ref msg) if msg == "NOTHING_TO_REFUND"),
        "Empty escrow refund must fail: {:?}",
        res
    );

    // 3. Reject anonymous callers
    let r = env.pic.update_call(
        env.backend,
        Principal::anonymous(),
        "refund_registration",
        encode_one(()).unwrap()
    );
    if let Ok(bytes) = r {
        let res: UnitResult = decode_one(&bytes).unwrap();
        assert!(matches!(res, UnitResult::Err(_)), "Anon refund must fail");
    }

    // 4. Fund the registration address
    // Mint 150 ICP to user first
    env.mint(env.user, 150_000_000_000);

    // Transfer 125 ICP + fee from user to reg_acc
    let deposit_amount = 125_000_000_000u64;
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount {
            owner: reg_acc.owner,
            subaccount: reg_acc.subaccount.clone(),
        },
        amount: candid::Nat::from(deposit_amount),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let res = env
        .pic
        .update_call(
            env.ledger,
            env.user,
            "icrc1_transfer",
            encode_one(xfer).unwrap()
        )
        .expect("deposit transfer");
    let res: TransferResult = decode_one(&res).unwrap();
    assert!(matches!(res, TransferResult::Ok(_)));

    // Verify registration escrow has the funds
    let reg_sub_vec = reg_acc.subaccount.clone();
    assert_eq!(
        balance_of(&env, env.backend, reg_sub_vec.clone()),
        deposit_amount
    );

    // 5. Call refund_registration as user
    let user_bal_before = balance_of(&env, env.user, None);
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "refund_registration",
            encode_one(()).unwrap()
        )
        .expect("refund_registration funded");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(
        matches!(res, UnitResult::Ok),
        "Refund must succeed: {:?}",
        res
    );

    // Escrow must be drained
    assert_eq!(
        balance_of(&env, env.backend, reg_sub_vec),
        0
    );

    // User gets back deposit minus 10_000 fee
    let user_bal_after = balance_of(&env, env.user, None);
    assert_eq!(
        user_bal_after,
        user_bal_before + deposit_amount - 10_000
    );
}

#[test]
fn test_create_pool_draft_integration() {
    let Some(env) = setup_saga() else { return };

    // 1. Success on valid caller
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "create_pool_draft",
            encode_one(12345u64).unwrap()
        )
        .expect("create_pool_draft success");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 2. Reject anonymous callers
    let r = env.pic.update_call(
        env.backend,
        Principal::anonymous(),
        "create_pool_draft",
        encode_one(12345u64).unwrap()
    );
    if let Ok(bytes) = r {
        let res: UnitResult = decode_one(&bytes).unwrap();
        assert!(matches!(res, UnitResult::Err(_)));
    }
}

#[test]
fn test_cancel_and_unregister_integration() {
    let Some(env) = setup_saga() else { return };

    // 1. Create a draft
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "create_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("create_pool_draft");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 2. Cancel the draft
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "cancel_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("cancel_pool_draft");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 3. Create again and finalize it
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "create_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("create_pool_draft");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // Get registration escrow address
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_registration_address",
            encode_one(()).unwrap(),
        )
        .expect("get_registration_address");
    let reg_acc: LAccountDe = decode_one(&r).unwrap();

    // Fund it with 125 ICP + fees
    env.mint(env.user, 150_000_000_000);
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount {
            owner: reg_acc.owner,
            subaccount: reg_acc.subaccount,
        },
        amount: candid::Nat::from(125_000_000_000u64),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let r = env
        .pic
        .update_call(
            env.ledger,
            env.user,
            "icrc1_transfer",
            encode_one(xfer).unwrap(),
        )
        .expect("ledger transfer");
    let xfer_res: TransferResult = decode_one(&r).unwrap();
    assert!(matches!(xfer_res, TransferResult::Ok(_)));

    // Finalize
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "finalize_pool_registration",
            encode_one(9999u64).unwrap(),
        )
        .expect("finalize_pool_registration");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 4. Unregister active leader neuron -> Inactive
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "unregister_leader_neuron",
            encode_one(9999u64).unwrap(),
        )
        .expect("unregister_leader_neuron");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 5. The neuron is now Inactive — `cancel_pool_draft` must allow clearing it
    //    (Draft OR Inactive are removable; Active is not). This backs the
    //    "Clear neuron" action on the Inactive card.
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "cancel_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("cancel_pool_draft on inactive");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok), "clearing an Inactive neuron should succeed: {:?}", res);

    // 6. It is gone entirely.
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_my_pool_neuron",
            encode_one(()).unwrap(),
        )
        .expect("get_my_pool_neuron");
    let my_n: Option<PoolNeuron> = decode_one(&r).unwrap();
    assert!(my_n.is_none(), "cleared Inactive neuron should no longer exist");
}

// Reactivation: an Inactive neuron (left the pool) can be re-activated by paying
// the fee again — `finalize_pool_registration` accepts Draft OR Inactive. Backs
// the "Finish activation" button on the Inactive card.
#[test]
fn test_reactivate_inactive_neuron_integration() {
    let Some(env) = setup_saga() else { return };
    let nid = 4242u64;

    // Helper: fund the registration escrow with one fee and finalize.
    let fund_and_finalize = |env: &SagaEnv| {
        let reg_acc: LAccountDe = decode_one(
            &env.pic
                .query_call(env.backend, env.user, "get_registration_address", encode_one(()).unwrap())
                .unwrap(),
        )
        .unwrap();
        let xfer = TransferArg {
            from_subaccount: None,
            to: LAccount { owner: reg_acc.owner, subaccount: reg_acc.subaccount },
            amount: candid::Nat::from(125_000_000_000u64),
            fee: Some(candid::Nat::from(10_000u64)),
            memo: None,
            created_at_time: None,
        };
        let r = env.pic.update_call(env.ledger, env.user, "icrc1_transfer", encode_one(xfer).unwrap()).expect("ledger transfer");
        let xfer_res: TransferResult = decode_one(&r).unwrap();
        assert!(matches!(xfer_res, TransferResult::Ok(_)));
        let r = env.pic.update_call(env.backend, env.user, "finalize_pool_registration", encode_one(nid).unwrap()).expect("finalize_pool_registration");
        let res: UnitResult = decode_one(&r).unwrap();
        assert!(matches!(res, UnitResult::Ok), "finalize should succeed: {:?}", res);
    };

    // Mint enough for two activations (2 * 125 ICP + fees).
    env.mint(env.user, 300_000_000_000);

    // 1. create -> finalize -> Active
    let r = env.pic.update_call(env.backend, env.user, "create_pool_draft", encode_one(nid).unwrap()).expect("create_pool_draft");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));
    fund_and_finalize(&env);

    // 2. unregister -> Inactive
    let r = env.pic.update_call(env.backend, env.user, "unregister_leader_neuron", encode_one(nid).unwrap()).expect("unregister");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));
    let info: PoolInfo = decode_one(&env.pic.query_call(env.backend, env.user, "get_pool_info", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(info.active_count, 0, "neuron should be Inactive after leaving");

    // 3. re-fund the escrow + finalize again -> Active (reactivation)
    fund_and_finalize(&env);
    let info: PoolInfo = decode_one(&env.pic.query_call(env.backend, env.user, "get_pool_info", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(info.active_count, 1, "neuron should be Active again after reactivation");
    assert_eq!(info.active_neurons[0].neuron_id, nid);
}

#[test]
fn test_pool_queries_integration() {
    let Some(env) = setup_saga() else { return };

    // 1. Initially empty
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_my_pool_neuron",
            encode_one(()).unwrap(),
        )
        .expect("get_my_pool_neuron");
    let my_n: Option<PoolNeuron> = decode_one(&r).unwrap();
    assert!(my_n.is_none());

    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_pool_info",
            encode_one(()).unwrap(),
        )
        .expect("get_pool_info");
    let info: PoolInfo = decode_one(&r).unwrap();
    assert_eq!(info.total_pool_voting_power, 0);
    assert_eq!(info.active_count, 0);
    assert_eq!(info.active_neurons.len(), 0);

    // 2. Create a draft
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "create_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("create_pool_draft");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // get_my_pool_neuron -> returns Draft
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_my_pool_neuron",
            encode_one(()).unwrap(),
        )
        .expect("get_my_pool_neuron");
    let my_n: Option<PoolNeuron> = decode_one(&r).unwrap();
    assert!(my_n.is_some());
    assert_eq!(my_n.unwrap().neuron_id, 9999);

    // 3. Finalize registration
    env.mint(env.user, 150_000_000_000);
    let reg_acc: LAccountDe = decode_one(
        &env.pic
            .query_call(
                env.backend,
                env.user,
                "get_registration_address",
                encode_one(()).unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount {
            owner: reg_acc.owner,
            subaccount: reg_acc.subaccount,
        },
        amount: candid::Nat::from(125_000_000_000u64),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let _ = env
        .pic
        .update_call(
            env.ledger,
            env.user,
            "icrc1_transfer",
            encode_one(xfer).unwrap(),
        )
        .unwrap();

    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "finalize_pool_registration",
            encode_one(9999u64).unwrap(),
        )
        .expect("finalize_pool_registration");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok), "finalize failed: {:?}", res);

    // 4. get_pool_info -> total 100 ICP mock VP, active_count 1
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_pool_info",
            encode_one(()).unwrap(),
        )
        .expect("get_pool_info");
    let info: PoolInfo = decode_one(&r).unwrap();
    assert_eq!(info.total_pool_voting_power, 10_000_000_000);
    assert_eq!(info.active_count, 1);
    assert_eq!(info.active_neurons.len(), 1);
    assert_eq!(info.active_neurons[0].neuron_id, 9999);
    assert_eq!(info.active_neurons[0].rank, 1);
}

#[test]
fn test_pool_rewards_distribution_integration() {
    let Some(env) = setup_saga() else { return };

    // 1. Register a pool neuron
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "create_pool_draft",
            encode_one(9999u64).unwrap(),
        )
        .expect("create_pool_draft");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // Get registration escrow address
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_registration_address",
            encode_one(()).unwrap(),
        )
        .expect("get_registration_address");
    let reg_acc: LAccountDe = decode_one(&r).unwrap();

    // Fund it with 125 ICP + fees
    env.mint(env.user, 150_000_000_000);
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount {
            owner: reg_acc.owner,
            subaccount: reg_acc.subaccount,
        },
        amount: candid::Nat::from(125_000_000_000u64),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let _ = env
        .pic
        .update_call(
            env.ledger,
            env.user,
            "icrc1_transfer",
            encode_one(xfer).unwrap(),
        )
        .unwrap();

    // Finalize
    let r = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "finalize_pool_registration",
            encode_one(9999u64).unwrap(),
        )
        .unwrap();
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok));

    // 2. Commit 10 ICP to proposal 138388 (threshold is 2 ICP)
    let commit_amt = 10_000_000_000u64;
    let committer = Principal::from_slice(&[9, 9, 9, 9, 9, 9]);
    env.mint(committer, 200_000_000_000);

    let res = do_commit_as(&env, committer, 138388, Stance::Adopt, commit_amt);
    assert!(matches!(res, UnitResult::Ok));

    // 3. Trigger proposal settlement (sweeps, settles, and pays pool)
    let bal_before = balance_of(&env, env.user, None);
    trigger_settlement(&env, 138388);

    // 4. Assert proposal is settled and marked distributed
    let r = env
        .pic
        .query_call(
            env.backend,
            env.user,
            "get_proposal",
            encode_one(138388u64).unwrap(),
        )
        .unwrap();
    let proposal: Option<ProposalLite> = decode_one(&r).unwrap();
    assert!(proposal.is_some());
    let p = proposal.unwrap();
    assert_eq!(p.status, "settled");
    assert!(p.pool_distributed);

    // 5. Assert user (the pool neuron owner) received the payout:
    // pool_share = 25% of 10 ICP = 2.5 ICP = 2_500_000_000
    // payout = 2_500_000_000 - 10_000 fee = 2_499_990_000
    let bal_after = balance_of(&env, env.user, None);
    assert_eq!(bal_after, bal_before + 2_499_990_000);
}

// ── Treasury withdrawal: admin-gated movement of real ICP out of the treasury ──
#[test]
fn test_admin_withdraw_treasury_integration() {
    let Some(env) = setup_saga() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let treasury_sub = vec![1u8; 32]; // TREASURY_SUBACCOUNT
    let recipient = Principal::from_slice(&[0x42; 6]);

    // Fund the treasury subaccount directly (minter → {backend, treasury_sub}).
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: env.backend, subaccount: Some(treasury_sub.clone()) },
        amount: candid::Nat::from(10_000_000_000u64), // 100 ICP
        fee: None,
        memo: None,
        created_at_time: None,
    };
    let r = env.pic.update_call(env.ledger, env.minter, "icrc1_transfer", encode_one(xfer).unwrap()).expect("fund treasury");
    assert!(matches!(decode_one::<TransferResult>(&r).unwrap(), TransferResult::Ok(_)));

    // A non-admin must NOT be able to withdraw.
    let stranger = Principal::from_slice(&[9, 9, 9, 9]);
    let res = env.pic.update_call(env.backend, stranger, "admin_withdraw_treasury", encode_args((recipient, 1_000_000_000u64)).unwrap());
    if let Ok(bytes) = res {
        assert!(matches!(decode_one::<UnitResult>(&bytes).unwrap(), UnitResult::Err(_)), "non-admin withdraw must Err");
    }
    assert_eq!(balance_of(&env, recipient, None), 0, "no funds moved on a rejected withdraw");

    // Admin happy path: withdraw 50 ICP.
    let amount = 5_000_000_000u64;
    let r = env.pic.update_call(env.backend, owner, "admin_withdraw_treasury", encode_args((recipient, amount)).unwrap()).expect("withdraw");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok), "admin withdraw should succeed: {:?}", res);
    assert_eq!(balance_of(&env, recipient, None), amount, "recipient received exactly the amount");
    assert_eq!(balance_of(&env, env.backend, Some(treasury_sub)), 10_000_000_000 - amount - 10_000, "treasury debited amount + ledger fee");

    // Edge: zero amount is rejected even for an admin.
    let r = env.pic.update_call(env.backend, owner, "admin_withdraw_treasury", encode_args((recipient, 0u64)).unwrap()).expect("zero");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Err(_)), "zero-amount withdraw must Err");
}

// ── Top up an existing commitment (money movement + state guards) ──
#[test]
fn test_add_to_commitment_integration() {
    let Some(env) = setup_saga() else { return };
    let pid = 138402u64;

    // Initial commit of 5 ICP → Pending.
    let res = do_commit(&env, pid, Stance::Adopt, 500_000_000);
    assert!(matches!(res, UnitResult::Ok), "commit: {:?}", res);

    // Deposit the additional amount (+ buffer) into the same escrow.
    let escrow: LAccountDe = decode_one(
        &env.pic.query_call(env.backend, env.user, "get_deposit_address", encode_one(pid).unwrap()).unwrap(),
    ).unwrap();
    let add = 300_000_000u64; // +3 ICP
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: escrow.owner, subaccount: escrow.subaccount },
        amount: candid::Nat::from(add + 1_000_000),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let r = env.pic.update_call(env.ledger, env.user, "icrc1_transfer", encode_one(xfer).unwrap()).expect("top-up deposit");
    assert!(matches!(decode_one::<TransferResult>(&r).unwrap(), TransferResult::Ok(_)));

    // add_to_commitment → commitment grows by exactly `add`.
    let r = env.pic.update_call(env.backend, env.user, "add_to_commitment", encode_args((pid, add)).unwrap()).expect("add_to_commitment");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok), "add_to_commitment should succeed: {:?}", res);

    let commits = my_commitments(&env);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].amount_e8s, 800_000_000, "commitment grew by the top-up amount");
    assert_eq!(commits[0].status, CommitmentStatus::Pending);

    // Guard: a below-minimum top-up is rejected.
    let r = env.pic.update_call(env.backend, env.user, "add_to_commitment", encode_args((pid, 1u64)).unwrap()).expect("tiny add");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Err(_)), "below-minimum top-up must Err");

    // Guard: no existing commitment for an unrelated proposal.
    let r = env.pic.update_call(env.backend, env.user, "add_to_commitment", encode_args((999_999u64, 200_000_000u64)).unwrap()).expect("add to none");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Err(_)), "top-up with no existing commitment must Err");
}

// ── remove_admin: governance/auth, including the last-admin safeguard ──
#[test]
fn test_remove_admin_integration() {
    let Some(env) = setup_saga() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let second = Principal::from_slice(&[0x55; 6]);

    // Cannot remove the last (sole) admin.
    let r = env.pic.update_call(env.backend, owner, "remove_admin", encode_one(owner).unwrap()).expect("remove last");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Err(_)), "removing the last admin must Err: {:?}", res);

    // Add a second admin.
    let r = env.pic.update_call(env.backend, owner, "add_admin", encode_one(second).unwrap()).expect("add_admin");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));

    // A non-admin cannot remove anyone.
    let stranger = Principal::from_slice(&[9, 9, 9, 9]);
    let res = env.pic.update_call(env.backend, stranger, "remove_admin", encode_one(second).unwrap());
    if let Ok(bytes) = res {
        assert!(matches!(decode_one::<UnitResult>(&bytes).unwrap(), UnitResult::Err(_)), "non-admin remove must Err");
    }

    // Owner removes the second admin → only the owner remains.
    let r = env.pic.update_call(env.backend, owner, "remove_admin", encode_one(second).unwrap()).expect("remove second");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok), "owner can remove a non-last admin");
    let cfg: Config = decode_one(&env.pic.query_call(env.backend, owner, "get_config", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(cfg.admins, vec![owner], "only the owner remains an admin");
}

// ── create_pool_draft first-come binding: B cannot register A's neuron id ──
#[test]
fn test_create_pool_draft_already_registered_integration() {
    let Some(env) = setup_saga() else { return };
    let nid = 5555u64;
    let user_a = env.user;
    let user_b = Principal::from_slice(&[0xBB; 6]);

    let r = env.pic.update_call(env.backend, user_a, "create_pool_draft", encode_one(nid).unwrap()).expect("draft A");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));

    let r = env.pic.update_call(env.backend, user_b, "create_pool_draft", encode_one(nid).unwrap()).expect("draft B");
    let res: UnitResult = decode_one(&r).unwrap();
    match res {
        UnitResult::Err(e) => assert!(e.contains("ALREADY_REGISTERED"), "expected ALREADY_REGISTERED, got: {e}"),
        UnitResult::Ok => panic!("B must not be able to register A's neuron id"),
    }

    // B owns nothing; A still holds the draft.
    let b_n: Option<PoolNeuron> = decode_one(&env.pic.query_call(env.backend, user_b, "get_my_pool_neuron", encode_one(()).unwrap()).unwrap()).unwrap();
    assert!(b_n.is_none(), "B has no pool neuron");
    let a_n: Option<PoolNeuron> = decode_one(&env.pic.query_call(env.backend, user_a, "get_my_pool_neuron", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(a_n.unwrap().neuron_id, nid, "A still owns the draft");
}

// ── finalize_pool_registration requires the fee to actually be deposited ──
#[test]
fn test_finalize_insufficient_deposit_integration() {
    let Some(env) = setup_saga() else { return };
    let nid = 6666u64;
    let r = env.pic.update_call(env.backend, env.user, "create_pool_draft", encode_one(nid).unwrap()).expect("draft");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));

    // Finalize with NOTHING in escrow → INSUFFICIENT_DEPOSIT.
    let r = env.pic.update_call(env.backend, env.user, "finalize_pool_registration", encode_one(nid).unwrap()).expect("finalize empty");
    let res: UnitResult = decode_one(&r).unwrap();
    match res {
        UnitResult::Err(e) => assert!(e.contains("INSUFFICIENT_DEPOSIT"), "expected INSUFFICIENT_DEPOSIT, got: {e}"),
        UnitResult::Ok => panic!("finalize must fail with an empty escrow"),
    }
    let info: PoolInfo = decode_one(&env.pic.query_call(env.backend, env.user, "get_pool_info", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(info.active_count, 0, "no activation without payment");

    // Underfunded (one e8 short of fee + reserve) is also rejected.
    let cfg: Config = decode_one(&env.pic.query_call(env.backend, env.user, "get_config", encode_one(()).unwrap()).unwrap()).unwrap();
    let short = cfg.pool_initiation_fee_e8s + 30_000 - 1;
    let reg: LAccountDe = decode_one(&env.pic.query_call(env.backend, env.user, "get_registration_address", encode_one(()).unwrap()).unwrap()).unwrap();
    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: reg.owner, subaccount: reg.subaccount },
        amount: candid::Nat::from(short),
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let r = env.pic.update_call(env.ledger, env.user, "icrc1_transfer", encode_one(xfer).unwrap()).expect("short deposit");
    assert!(matches!(decode_one::<TransferResult>(&r).unwrap(), TransferResult::Ok(_)));
    let r = env.pic.update_call(env.backend, env.user, "finalize_pool_registration", encode_one(nid).unwrap()).expect("finalize short");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Err(_)), "underfunded finalize must Err: {:?}", res);
}

// ── cancel_pool_draft is owner-scoped: B cannot clear A's neuron ──
#[test]
fn test_cancel_pool_draft_unauthorized_integration() {
    let Some(env) = setup_saga() else { return };
    let nid = 7007u64;
    let user_a = env.user;
    let user_b = Principal::from_slice(&[0xCC; 6]);

    let r = env.pic.update_call(env.backend, user_a, "create_pool_draft", encode_one(nid).unwrap()).expect("draft A");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));

    let r = env.pic.update_call(env.backend, user_b, "cancel_pool_draft", encode_one(nid).unwrap()).expect("cancel B");
    let res: UnitResult = decode_one(&r).unwrap();
    match res {
        UnitResult::Err(e) => assert!(e.contains("UNAUTHORIZED"), "expected UNAUTHORIZED, got: {e}"),
        UnitResult::Ok => panic!("B must not cancel A's draft"),
    }

    // A's draft survives untouched.
    let a_n: Option<PoolNeuron> = decode_one(&env.pic.query_call(env.backend, user_a, "get_my_pool_neuron", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(a_n.unwrap().neuron_id, nid, "A's draft is intact");
}

// ── distribute_pool_rewards guards: no double-spend / premature distribution ──
#[test]
fn test_distribute_pool_rewards_guards_integration() {
    let Some(env) = setup_saga() else { return };

    // Unknown proposal → PROPOSAL_NOT_FOUND.
    let r = env.pic.update_call(env.backend, env.user, "distribute_pool_rewards", encode_one(424_242u64).unwrap()).expect("distribute unknown");
    let res: UnitResult = decode_one(&r).unwrap();
    match res {
        UnitResult::Err(e) => assert!(e.contains("PROPOSAL_NOT_FOUND"), "expected PROPOSAL_NOT_FOUND, got: {e}"),
        UnitResult::Ok => panic!("distribute on an unknown proposal must Err"),
    }

    // Seeded, still-open proposal (not settled) → PROPOSAL_NOT_SETTLED.
    let r = env.pic.update_call(env.backend, env.user, "distribute_pool_rewards", encode_one(138402u64).unwrap()).expect("distribute open");
    let res: UnitResult = decode_one(&r).unwrap();
    match res {
        UnitResult::Err(e) => assert!(e.contains("PROPOSAL_NOT_SETTLED"), "expected PROPOSAL_NOT_SETTLED, got: {e}"),
        UnitResult::Ok => panic!("distribute on an unsettled proposal must Err"),
    }
}

// ── Admin config setters reject non-admins; admin path updates config ──
#[test]
fn test_admin_setters_reject_non_admin_integration() {
    let Some(env) = setup_saga() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let stranger = Principal::from_slice(&[9, 9, 9, 9]);
    let some_canister = Principal::from_slice(&[0xDD; 6]);

    // Non-admin admin_set_frontend_canister rejected.
    let res = env.pic.update_call(env.backend, stranger, "admin_set_frontend_canister", encode_one(some_canister).unwrap());
    if let Ok(bytes) = res {
        assert!(matches!(decode_one::<UnitResult>(&bytes).unwrap(), UnitResult::Err(_)), "non-admin set_frontend must Err");
    }

    // Non-admin admin_set_proposal_deadline rejected.
    let future = env.pic.get_time().as_nanos_since_unix_epoch() + 7_200_000_000_000;
    let res = env.pic.update_call(env.backend, stranger, "admin_set_proposal_deadline", encode_args((138402u64, future)).unwrap());
    if let Ok(bytes) = res {
        assert!(matches!(decode_one::<UnitResult>(&bytes).unwrap(), UnitResult::Err(_)), "non-admin set_deadline must Err");
    }

    // Admin (owner) can set the frontend canister; config reflects it.
    let r = env.pic.update_call(env.backend, owner, "admin_set_frontend_canister", encode_one(some_canister).unwrap()).expect("owner set_frontend");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok), "admin can set the frontend canister");
    let cfg: Config = decode_one(&env.pic.query_call(env.backend, owner, "get_config", encode_one(()).unwrap()).unwrap()).unwrap();
    assert_eq!(cfg.frontend_canister_id, Some(some_canister), "frontend canister id was updated");
}

#[derive(CandidType, Deserialize, Debug)]
struct Idea {
    id: u64,
    poster: Principal,
    title: String,
    description: String,
    detail: String,
    created_at: u64,
    last_upvote_at: u64,
    upvote_count: u64,
    views: u64,
    total_icp_e8s: u64,
    total_ckbtc_e8s: u64,
    total_cketh_wei: u64,
}

// ── admin_remove_idea: admin can remove ideas at any time, non-admins rejected ──
#[test]
fn test_admin_remove_idea_integration() {
    let Some(env) = setup_saga() else { return };
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let stranger = Principal::from_slice(&[9, 9, 9, 9]);

    // Enable the idea board feature flag so posting isn't rejected as disabled
    // (default is enabled, but let's make sure or toggle config)
    let r = env.pic.update_call(env.backend, owner, "admin_set_feature_flag", encode_args(("idea_board".to_string(), true)).unwrap()).expect("enable idea board");
    assert!(matches!(decode_one::<UnitResult>(&r).unwrap(), UnitResult::Ok));

    // 1. Post an idea (we need to fund the post fee address first)
    // Query deposit address
    let r = env.pic.query_call(env.backend, env.user, "get_idea_post_deposit_address", encode_one(()).unwrap()).expect("deposit address");
    let dep_acc: LAccountDe = decode_one(&r).unwrap();

    // Mint ICP to user
    env.mint(env.user, 10_000_000_000); // 100 ICP

    // Transfer post fee + ledger fee from user to dep_acc
    let fee_xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: dep_acc.owner, subaccount: dep_acc.subaccount },
        amount: candid::Nat::from(100_000_000u64 + 10_000u64), // 1 ICP + ledger fee
        fee: Some(candid::Nat::from(10_000u64)),
        memo: None,
        created_at_time: None,
    };
    let r = env.pic.update_call(env.ledger, env.user, "icrc1_transfer", encode_one(fee_xfer).unwrap()).expect("transfer post fee");
    assert!(matches!(decode_one::<TransferResult>(&r).unwrap(), TransferResult::Ok(_)));

    // Call post_idea
    let r = env.pic.update_call(
        env.backend,
        env.user,
        "post_idea",
        encode_args(("IntegrTitle".to_string(), "IntegrDesc".to_string(), "".to_string())).unwrap()
    ).expect("post idea");
    let idea_id: u64 = match decode_one::<Result<u64, String>>(&r).unwrap() {
        Ok(id) => id,
        Err(e) => panic!("failed to post idea: {}", e),
    };

    // Verify it is in list_ideas
    let r = env.pic.query_call(env.backend, env.user, "list_ideas", encode_one(()).unwrap()).expect("list ideas");
    let ideas: Vec<Idea> = decode_one(&r).unwrap();
    assert!(ideas.iter().any(|i| i.id == idea_id));

    // 2. Stranger tries to remove idea -> Err / rejected by guard
    let r = env.pic.update_call(env.backend, stranger, "admin_remove_idea", encode_one(idea_id).unwrap());
    assert!(r.is_err(), "Stranger remove must be rejected by guard");
    if let Err(e) = r {
        assert!(e.to_string().contains("Caller is not an admin"), "Expected 'Caller is not an admin', got: {:?}", e);
    }

    // 3. Admin (owner) removes idea -> Ok
    let r = env.pic.update_call(env.backend, owner, "admin_remove_idea", encode_one(idea_id).unwrap()).expect("admin remove");
    let res: UnitResult = decode_one(&r).unwrap();
    assert!(matches!(res, UnitResult::Ok), "Admin remove must succeed: {:?}", res);

    // Verify it is gone from list_ideas
    let r = env.pic.query_call(env.backend, env.user, "list_ideas", encode_one(()).unwrap()).expect("list ideas 2");
    let ideas: Vec<Idea> = decode_one(&r).unwrap();
    assert!(!ideas.iter().any(|i| i.id == idea_id));
}





// ════════════════════════════════════════════════════════════════════════════
// Lossless Voting (pooled staking) — stake → vote → unstake → yield, against
// the real ICRC ledger. NNS governance is absent in PocketIC, so the backend's
// local mock state machine drives the neuron lifecycle (same code path as
// local dev). Real ManageNeuron wire compatibility needs a mainnet canary.
// ════════════════════════════════════════════════════════════════════════════

#[derive(CandidType, Deserialize, Debug, PartialEq)]
enum StakingBootstrap {
    NotStarted,
    Claimed,
    DelaySet,
    Ready,
}

#[derive(CandidType, Deserialize, Debug, PartialEq)]
enum UnstakeStatus {
    SplitDone,
    Dissolving,
    Disbursed,
}

#[derive(CandidType, Deserialize, Debug, Clone, Copy, PartialEq)]
enum StakeTier {
    SixMonths,
    OneYear,
    TwoYears,
}

#[derive(CandidType, Deserialize, Debug)]
struct TierPoolInfoLite {
    tier: StakeTier,
    dissolve_delay_secs: u64,
    weight_multiplier: u64,
    daily_tickets: u64,
    neuron_id: Option<u64>,
    total_staked_e8s: u64,
    staker_count: u64,
    bootstrap: StakingBootstrap,
}

#[derive(CandidType, Deserialize, Debug)]
struct StakingPoolInfoLite {
    pools: Vec<TierPoolInfoLite>,
    total_staked_e8s: u64,
    total_yield_e8s: u64,
}

impl StakingPoolInfoLite {
    fn tier(&self, tier: StakeTier) -> &TierPoolInfoLite {
        self.pools.iter().find(|p| p.tier == tier).expect("tier present")
    }
}

#[derive(CandidType, Deserialize, Debug)]
struct PendingUnstakeLite {
    id: u64,
    amount_e8s: u64,
    status: UnstakeStatus,
    disburse_block: Option<u64>,
}

#[derive(CandidType, Deserialize, Debug)]
struct ProposalLossless {
    id: u64,
    status: String,
    lossless_adopt_e8s: u64,
    lossless_reject_e8s: u64,
}

#[derive(CandidType, Deserialize, Debug)]
enum NatResult {
    Ok(u64),
    Err(String),
}

/// Deposit `amount` into the caller's stake escrow and call
/// `stake(amount, tier)`.
fn do_stake_as(env: &SagaEnv, user: Principal, amount_e8s: u64, tier: StakeTier) -> UnitResult {
    env.mint(user, amount_e8s + 1_000_000);

    let reply = env
        .pic
        .query_call(env.backend, user, "get_stake_deposit_address", encode_one(()).unwrap())
        .expect("get_stake_deposit_address");
    let escrow: LAccountDe = decode_one(&reply).unwrap();

    let xfer = TransferArg {
        from_subaccount: None,
        to: LAccount { owner: escrow.owner, subaccount: escrow.subaccount },
        amount: candid::Nat::from(amount_e8s + 10_000),
        fee: None,
        memo: None,
        created_at_time: None,
    };
    let res = env
        .pic
        .update_call(env.ledger, user, "icrc1_transfer", encode_one(xfer).unwrap())
        .expect("escrow deposit");
    let res: TransferResult = decode_one(&res).unwrap();
    assert!(matches!(res, TransferResult::Ok(_)), "deposit failed: {:?}", res);

    let reply = env
        .pic
        .update_call(env.backend, user, "stake", encode_args((amount_e8s, tier)).unwrap())
        .expect("stake call");
    decode_one(&reply).unwrap()
}

fn staking_pool_info(env: &SagaEnv) -> StakingPoolInfoLite {
    let reply = env
        .pic
        .query_call(env.backend, Principal::anonymous(), "get_staking_pool_info", encode_one(()).unwrap())
        .expect("get_staking_pool_info");
    decode_one(&reply).unwrap()
}

fn run_staking_sweep(env: &SagaEnv, caller: Principal) {
    let reply = env
        .pic
        .update_call(env.backend, caller, "dev_run_staking_sweep", encode_one(()).unwrap())
        .expect("dev_run_staking_sweep");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Ok), "sweep failed: {:?}", res);
}

#[test]
fn test_stake_unstake_roundtrip_integration() {
    let Some(env) = setup_saga() else { return };

    // Stake 3 ICP into the 1-year tier: the first stake claims the (mock)
    // neuron and bootstraps it.
    let res = do_stake_as(&env, env.user, 300_000_000, StakeTier::OneYear);
    assert!(matches!(res, UnitResult::Ok), "stake failed: {:?}", res);

    let pool = staking_pool_info(&env);
    assert_eq!(pool.total_staked_e8s, 300_000_000);
    let tier = pool.tier(StakeTier::OneYear);
    assert_eq!(tier.total_staked_e8s, 300_000_000);
    assert_eq!(tier.staker_count, 1);
    assert_eq!(tier.bootstrap, StakingBootstrap::Ready);
    assert!(tier.neuron_id.is_some());
    assert_eq!(tier.dissolve_delay_secs, 31_557_600, "1-year term");
    assert_eq!(tier.weight_multiplier, 2);
    assert_eq!(tier.daily_tickets, 10, "1y staker collects 10 tickets/day");
    // The untouched tiers report empty pools.
    assert_eq!(pool.tier(StakeTier::SixMonths).total_staked_e8s, 0);
    assert_eq!(pool.tier(StakeTier::SixMonths).daily_tickets, 5);
    assert_eq!(pool.tier(StakeTier::TwoYears).daily_tickets, 20);

    // The staked ICP physically sits in the local mock stake subaccount.
    assert_eq!(balance_of(&env, env.backend, Some(vec![4u8; 32])), 300_000_000);

    // Unstake 1.5 ICP → split + dissolving.
    let reply = env
        .pic
        .update_call(env.backend, env.user, "unstake", encode_args((150_000_000u64, StakeTier::OneYear)).unwrap())
        .expect("unstake call");
    let res: NatResult = decode_one(&reply).unwrap();
    let unstake_id = match res {
        NatResult::Ok(id) => id,
        NatResult::Err(e) => panic!("unstake failed: {}", e),
    };
    let pool = staking_pool_info(&env);
    assert_eq!(pool.total_staked_e8s, 150_000_000);

    // Sweep before the dissolve delay: still locked.
    run_staking_sweep(&env, env.user);
    let reply = env
        .pic
        .query_call(env.backend, env.user, "list_my_pending_unstakes", encode_one(()).unwrap())
        .expect("list_my_pending_unstakes");
    let pending: Vec<PendingUnstakeLite> = decode_one(&reply).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].status, UnstakeStatus::Dissolving);

    // Fast-forward the dissolve (dev) and sweep: ICP lands in the wallet.
    let before = balance_of(&env, env.user, None);
    let reply = env
        .pic
        .update_call(env.backend, env.user, "dev_fast_forward_dissolve", encode_one(unstake_id).unwrap())
        .expect("dev_fast_forward_dissolve");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Ok), "fast-forward failed: {:?}", res);
    run_staking_sweep(&env, env.user);

    let reply = env
        .pic
        .query_call(env.backend, env.user, "list_my_pending_unstakes", encode_one(()).unwrap())
        .expect("list_my_pending_unstakes 2");
    let pending: Vec<PendingUnstakeLite> = decode_one(&reply).unwrap();
    assert_eq!(pending[0].status, UnstakeStatus::Disbursed);
    assert!(pending[0].disburse_block.is_some());

    // Net payout = amount − split fee − disburse fee.
    let after = balance_of(&env, env.user, None);
    assert_eq!(after - before, 150_000_000 - 20_000, "user receives amount minus 2 fees");
}

#[test]
fn test_lossless_vote_integration() {
    let Some(env) = setup_saga() else { return };

    // Pick a seeded open proposal.
    let reply = env
        .pic
        .query_call(env.backend, Principal::anonymous(), "list_active_proposals", encode_args(()).unwrap())
        .expect("list_active_proposals");
    let proposals: Vec<ProposalLite> = decode_one(&reply).unwrap();
    let pid = proposals
        .iter()
        .find(|p| p.status == "open")
        .expect("seeded open proposal")
        .id;

    // No stake → NO_STAKE.
    let stranger = Principal::from_slice(&[9, 9, 9]);
    let reply = env
        .pic
        .update_call(env.backend, stranger, "cast_lossless_vote", encode_args((pid, Stance::Adopt)).unwrap())
        .expect("cast as stranger");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Err(ref e) if e == "NO_STAKE"), "{:?}", res);

    // Stake 2 ICP in the 2-year tier → the vote carries 4× weight (8 ICP).
    let res = do_stake_as(&env, env.user, 200_000_000, StakeTier::TwoYears);
    assert!(matches!(res, UnitResult::Ok), "stake failed: {:?}", res);
    let reply = env
        .pic
        .update_call(env.backend, env.user, "cast_lossless_vote", encode_args((pid, Stance::Adopt)).unwrap())
        .expect("cast vote");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Ok), "vote failed: {:?}", res);

    let reply = env
        .pic
        .query_call(env.backend, Principal::anonymous(), "get_proposal", encode_one(pid).unwrap())
        .expect("get_proposal");
    let prop: Option<ProposalLossless> = decode_one(&reply).unwrap();
    let prop = prop.expect("proposal exists");
    assert_eq!(prop.lossless_adopt_e8s, 800_000_000, "2 ICP × 4 (2-year multiplier)");
    assert_eq!(prop.lossless_reject_e8s, 0);

    // One vote per user per proposal.
    let reply = env
        .pic
        .update_call(env.backend, env.user, "cast_lossless_vote", encode_args((pid, Stance::Reject)).unwrap())
        .expect("double vote");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Err(ref e) if e == "ALREADY_VOTED"), "{:?}", res);
}

#[test]
fn test_yield_distribution_integration() {
    let Some(env) = setup_saga() else { return };

    let res = do_stake_as(&env, env.user, 200_000_000, StakeTier::SixMonths);
    assert!(matches!(res, UnitResult::Ok), "stake failed: {:?}", res);

    // The local mock "mints" disbursed maturity from the backend's own default
    // account — fund it so the harvest transfer can settle.
    env.mint(env.backend, 1_000_000_000);

    // 2 ICP of simulated maturity (above the 1.05 threshold).
    let reply = env
        .pic
        .update_call(
            env.backend,
            env.user,
            "dev_add_mock_maturity",
            encode_args((200_000_000u64, StakeTier::SixMonths)).unwrap(),
        )
        .expect("dev_add_mock_maturity");
    let res: UnitResult = decode_one(&reply).unwrap();
    assert!(matches!(res, UnitResult::Ok), "mock maturity failed: {:?}", res);

    // One sweep pass runs harvest → inbox → distribution back-to-back
    // (locally the mock mints instantly; on mainnet the 7-day mint delay means
    // the distribution happens on a later tick, off the inbox balance).
    run_staking_sweep(&env, env.user);

    // All neuron yield is split 50% lottery prize pot / 50% treasury.
    let spendable = 200_000_000 - 20_000;
    let treasury = balance_of(&env, env.backend, Some(vec![1u8; 32]));
    let lottery = balance_of(&env, env.backend, Some(vec![3u8; 32]));
    assert_eq!(lottery, spendable / 2, "50% → lottery prize pot");
    assert_eq!(treasury, spendable - spendable / 2, "50% → treasury");
    assert_eq!(balance_of(&env, env.backend, Some(vec![2u8; 32])), 0, "inbox drained");

    let pool = staking_pool_info(&env);
    assert_eq!(pool.total_yield_e8s, 200_000_000, "harvested maturity tracked per tier");
}
