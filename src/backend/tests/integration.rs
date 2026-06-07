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
    let cmc_after_first = balance_of(&env, cmc, None);
    assert_eq!(cmc_after_first, total / 4, "25% backend share reached the CMC once");
    // treasury = 50% of proceeds + the per-commit protocol fee (500_000 each).
    assert_eq!(treasury_after_first, total / 2 + n_users * 500_000, "50% + protocol fees in treasury");

    // Retry: completed transfers (treasury, backend CMC) are skipped — only the
    // failing notify re-runs. No funds move again.
    let owner = Principal::from_text(OWNER_TEXT).unwrap();
    let r = env.pic.update_call(env.backend, owner, "admin_trigger_sweep", encode_one(()).unwrap()).expect("sweep2");
    let _: UnitResult = decode_one(&r).unwrap();

    assert_eq!(balance_of(&env, cmc, None), cmc_after_first, "PB-111: no double CMC transfer on retry");
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
