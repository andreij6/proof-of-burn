# Duplication Review — 2026-06-19

**Scope:** consolidation candidates for easier maintenance. **List only — nothing fixed.**
**Method:** read-only exploration pass over `src/backend/src/lib.rs` (~26k lines, single file) and `src/frontend/src/*`.
**Caveat:** line numbers are from the exploration pass and drift with edits; treat as locators, not anchors. Verify with `grep` before acting on any cluster.

Ranked within each section by maintenance impact (highest first). Cross-cutting overlaps are noted (e.g. backend B1/B2/B4 share the same underlying pattern; frontend F1/F12/F13 are one escrow flow split into three clusters).

---

## Backend — `src/backend/src/lib.rs`

### B1. 50/25/25 split + CMC top-up saga *(highest impact — money-movement, drift-critical)*
Same three-leg "treasury cut + backend CMC top-up + frontend CMC top-up" with `CMC_REFUNDED → drop block → retry`, implemented separately:
- `lib.rs:2481-2583` — `settle_burn_split` (Commitment)
- `lib.rs:2773-2860` — `finalize_pool_registration` (PoolNeuron; same math + same legs)
- `lib.rs:8770-8797` — `settle_lottery_payout` Leg 2
- `lib.rs:16067-16098` — `settle_course_sale` Legs 3 & 4
- **Suggest:** `async fn cmc_topup_leg(ledger, escrow_sub, target, amt, fee) -> Result<u64,_>` + `fn split_50_25_25(amt) -> (u64,u64,u64)`; generalize via a trait exposing `treasury_block / backend_cmc_block / frontend_cmc_block` so burn + registration share one body.

### B2. Idempotent per-leg transfer + persist-after-each-leg
`if leg_block.is_none() { transfer; leg_block = Some(b); persist(); }` repeated per leg across: `2518-2580`, `2784-2860`, `5699-5709`, `7794-7824`, `7951-7991`, `8751-8797`, `12421-12468`, `16043-16108`. Underlies B1 and B3 — single biggest copy-paste drift source.
- **Suggest:** generic `async fn idempotent_leg(ledger, from_sub, dest, amt, fee, block_field: &mut Option<u64>, persist: impl FnOnce()) -> Result<u64,_>`. The persist closure is the only per-call-site variable.

### B3. Treasury fee-cover / escrow-shortfall top-up (~5 inline copies)
Helper `refundable_with_treasury_cover` exists (`2445-2478`) but is bypassed inline at `2497-2515`, `7305-7316`, `7471-7490`, `16032-16040`, `16132-16140`. Pattern: `balance = call_ledger_balance(escrow); if balance < required { shortfall = required - balance; transfer(TREASURY_SUBACCOUNT → escrow, shortfall) }` → map_err `"TREASURY_FEE_COVER"`/`"REFUND_FEE_COVER"`.
- **Suggest:** `async fn treasury_cover_shortfall(ledger, escrow_acct, required, fee) -> Result<(),_>`; call it everywhere; retire `refundable_with_treasury_cover` in favor of the same primitive.

### B4. Inline `AuditLogEntry` append blocks (~56 sites)
`AuditLogEntry { timestamp, event_type, proposal_id, user, amount_e8s }` + `AUDIT_LOG.with(|l| l.borrow_mut().append(&e))` at (non-exhaustive) `1155, 2699, 2880, 2956, 3006, 3186, 3290, 4336, 4394, 5648, 5777, 5836, 6108, 6193, 6225, 11182, 11531, 11595, 11671, 12289, 12499, 13339, 13939, 13955, 14543`. Helpers `staking_audit` (`6790`) and `log_dapp_event` (`10156`) already show the pattern.
- **Suggest:** `fn audit(event_type: &str, proposal_id: u64, user: Principal, amount_e8s: u64)`; replace ~56 blocks. Some sites use `proposal_id: 0` as a dummy — a helper makes that explicit.

### B5. `derive_*_subaccount` (7 near-identical copies)
`lib.rs:1818, 5456, 5871, 9637, 10723, 11408, 12077` — same `sha256(domain_tag || user || opt u64) → [u8;32]`, differing only in tag string / optional id.
- **Suggest:** `fn derive_subaccount_seeded(tag: &[u8], user: &Principal, id: Option<u64>) -> [u8;32]`; keep named wrappers as thin calls if readability matters.

### B6. `require_*_enabled` feature-flag guards (8 copies)
`lib.rs:5252, 6745, 8476, 9553, 11336, 11351, 12066, 13046` — all `if !feature_visible(FLAG, caller) { Err("FEATURE_DISABLED") }`.
- **Suggest:** `fn require_feature_enabled(flag: &str) -> Result<(),_>`; the 8 wrappers become one-liners or are dropped.

### B7. CMC principal literal inlined (~10 sites)
`Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap()` at `2195, 2269, 2304, 2487, 2774, 4611, 4636, 8773, 16068, 17592`.
- **Suggest:** `const CMC_ID` + `fn cmc_principal()` (mirrors `NNS_GOVERNANCE_ID` at `6390`); removes per-call `unwrap` + typo risk.

### B8. `gov_*` ManageNeuron match-dispatch boilerplate (~9 functions)
`lib.rs:6898, 6932, 6955, 6975, 6996, 7039, 7079, 7092, 7133, 7188` — build `Command` → `call_manage_neuron` → `match { Expected => transform, _ => Err("UNEXPECTED_NNS_RESPONSE"), LocalFallback => mock_*() }`.
- **Suggest:** `gov_configure!(neuron_id, op, mock_fn)` macro, or `async fn gov_configure_cmd(neuron_id, op, mock: impl FnOnce() -> Result<T>)` centralizing the match arms; each `gov_*` supplies only command + mock fallback.

### B9. Admin withdraw/fund boilerplate (4–6 functions)
`lib.rs:3571-3586, 3591-3615, 3619-3633, 3637-3660, ~5792` — `to==anon? / amount==0? / config.clone() / treasury_floor_check / call_ledger_transfer(TREASURY_SUBACCOUNT → dest)`.
- **Suggest:** `validate_admin_transfer_dest(to, amount) -> Result<(),_>` + `async fn admin_treasury_out(ledger, dest, amount, fee, override_floor) -> Result<(),_>`; the 4–6 admin fns collapse to a few lines each.

### B10. `next_*_id` stable counter pattern
Inline at `5623-5627`, `6295-6299`; named helpers `next_dapp_id` (`10148`), `next_featured_id` (`10713`), payout block (`8504`). Same shape across `NEXT_IDEA/UPVOTE/PROJECT/FUNDING/UNSTAKE/YIELD/DRAW/SESSION_ID`.
- **Suggest:** `fn next_id(cell: &RefCell<StableCell<u64,Memory>>) -> u64`; replace inline blocks + per-module helpers.

### B11. Near-duplicate `*Info` candid structs (shared multi-token ledger+fee prefix)
`IdeaBoardInfo` (`5108`) and `ExplorerInfo` (`9512`) share `enabled, icp_ledger, ckbtc_ledger, cketh_ledger, fee_*`; `LotteryInfo` (`8374`), `FeaturedInfo` (`10692`), `ArcadeInfo` (`11290`), `EarlyAdopterInfo` (`12001`), `StakingPoolInfo` (`6637`) all start `enabled + config snapshot`.
- **Suggest:** extract `TokenLedgerFees { … }` embedded in each `*Info`. ⚠️ Changes the candid interface — bundle with a `.did` update + frontend regeneration. Lower priority than the runtime clusters.

### B12. `StableBTreeMap` init + `impl_storable!` boilerplate (low priority)
~54 `thread_local!` init blocks + ~63 `impl_storable!` invocations.
- **Suggest:** `stable_map!(NAME, Type, mem_id)` macro emitting both. Cosmetic, no drift risk.

---

## Frontend — `src/frontend/src/*`

### F1. Ledger transfer + Err-kind parser + bigint-safe stringify *(highest impact)*
~8–15 line block (create ledger actor → `icrc1_transfer` → parse `__kind__==='Err'` with `BadFee`/`InsufficientFunds`/`TooOld` branches → throw) duplicated near-verbatim at `App.tsx:881, 1449, 1514, 1625, 1772`; `IdeaBoard.tsx:335, 390`; `Explorer.tsx:360, 491`; `Arcade.tsx:325`; `Staking.tsx:162, 198`; `Admin.tsx:254, 357`; `Payouts.tsx:635, 679`; `CourseEditor.tsx:586`; `CourseMarketplace.tsx:816, 940`.
- **Suggest:** `describeTransferError(err, {decimals,label})` + `payEscrow({actor,to,amount})` that throws a typed `TransferError`. Each call site → 1–2 lines.

### F2. bigint-safe JSON.stringify replacer (~16 inline copies)
`(_k,v) => typeof v==='bigint' ? v.toString() : v` at `App.tsx:953,1454,1533,1644,1785`; `Admin.tsx:256,359`; `Arcade.tsx:336`; `Payouts.tsx:637,665,685`; `Explorer.tsx:368,502`; `IdeaBoard.tsx:350,401`; `Staking.tsx:167,203`; `CourseEditor.tsx:591`; `CourseMarketplace.tsx:822,946`.
- **Suggest:** one `stringifyCandid(err)` in `candid.ts`.

### F3. `createLedgerActor(…, { agentOptions: { host, identity, rootKey } })` (20+ sites)
`App.tsx:779,877,948,987,1314,1446,1510,1606,1769`; `Admin.tsx:201,253,356`; `Explorer.tsx:261,326,359,488`; `IdeaBoard.tsx:248,332,387`; `Staking.tsx:158,194`; `Arcade.tsx:322`; `CourseEditor.tsx:585`; `Payouts.tsx:604,634,678`.
- **Suggest:** `mkLedgerActor(env, identity, id)` factory (or `useLedgerActor(id)` hook) in `ledger.ts`.

### F4. Per-token metadata table redefined 5×
Same ICP/ckBTC/ckETH/ckUSDC/ckUSDT literals at `IdeaBoard.tsx:28-36`, `Explorer.tsx:33-39`, `Arcade.tsx:146-152`, `Payouts.tsx:84-90`, `tokens.ts:13-19`; plus `switch(token){fee lookup}` at `IdeaBoard.tsx:49-66`, `Explorer.tsx:41-61`, `Arcade.tsx:154-164`, `App.tsx:628-665`.
- **Suggest:** single `TOKEN_META` table + `tokenMeta(token, info)` in `tokens.ts`; delete the four local copies.

### F5. Number formatters (ICP/USD/token/VP) duplicated
`ui.tsx:265` `fmtICP`; `tokens.ts:46` `fmtUsd`; `Faucet.tsx:56-63` re-defines `fmtUsd/fmtIcp` (ignoring `ui.tsx`); `Explorer.tsx:63` `fmtUSD`; `IdeaBoard.tsx:83-91` `fmtTokenAmount`; `App.tsx:297-303` `fmtFlipAmount`; inline `/1e8 toLocaleString` at `App.tsx:299`, `Explorer.tsx:64`, `tokens.ts:42`.
- **Suggest:** one `format.ts` with `fmtICP/fmtUsd/fmtToken(units,decimals)/fmtPct/fmtVP`; re-export from `ui.tsx` for back-compat; delete local copies.

### F6. `refreshAll` / `fetchX` query boilerplate (~15 functions)
`App.tsx:680-855` all `if(!actor)return; try{setX(await actor.M())}catch{console.error("Failed to fetch X:",e)}`; same shape + `useEffect([actor,signedIn,isAdmin])` at `Explorer.tsx:195-219`, `IdeaBoard.tsx:218-234`, `Arcade.tsx:222-240`, `Staking.tsx:103-121`, plus `Lottery/Payouts/Casino/Faucet` refresh.
- **Suggest:** `useCandidQuery(name, fn, deps)` and/or `useRefreshAll(name, fetcher, deps)` wrapping try/catch, the `console.error("Failed to fetch …")` log, and the loading flag.

### F7. Modal overlay + card scaffolding
`MODAL_OVERLAY`/`MODAL_CARD` at `IdeaBoard.tsx:122-132`, `Explorer.tsx:85-95`, `Arcade.tsx:52-56`; `ModalShell` at `CourseEditor.tsx:640-658` and `CourseMarketplace.tsx:1132-1150` (identical except `maxWidth`/`height`); inline fixed-overlay blocks at `App.tsx:3352,3416,3472,3605,3670,3702,3938,4152,4305,4388`, `CourseEditor.tsx:643`, `CourseMarketplace.tsx:1135`, `CoursePlay.tsx:206`.
- **Suggest:** one `<Modal title onClose children maxWidth>` in `ui.tsx` (portaled; overlay+card+close-row built-in); replace both `ModalShell` copies and all inline overlays.

### F8. `LABEL_STYLE` constant
Identical object at `IdeaBoard.tsx:134`, `Explorer.tsx:97-99`, `Arcade.tsx:47-50`; inlined at `Explorer.tsx:430,433,443,824,917`, `Admin.tsx:116,383`, `Casino.tsx:457,462`, `Landing.tsx:496`, `CourseMarketplace.tsx:1155`.
- **Suggest:** export `LABEL_STYLE` + `<Label>` from `ui.tsx`.

### F9. `card` style constant
`Staking.tsx:312-315`, `Payouts.tsx:229-232`, `Lottery.tsx:210-213`, `Casino.tsx:270` (variant); re-inlined in `App.tsx:2250,2466,2520`, `Explorer.tsx:870,900`, `AboutUs.tsx:16`, `Dashboard.tsx:42`.
- **Suggest:** `<Card>` primitive / `CARD` style export in `ui.tsx`.

### F10. Inline error/notice banner (~20 sites)
`(error||notice) && <div …border var(--ember)/var(--sprout)…>` at `Admin.tsx:468-478`, `Staking.tsx:391-401`, `Lottery.tsx:278-288`, `Payouts.tsx:692-701`; red/green banner family in `App.tsx:3446,3449,3563,3568,3833,3893,3965,3976,4177,4188`, `IdeaBoard.tsx:943,1013,1253,1323`, `Casino.tsx:512`, `Faucet.tsx:298`, `CourseMarketplace.tsx:375`.
- **Suggest:** `<Banner tone="error|success|warn">` in `ui.tsx`; replace ~20 inline banners.

### F11. `Stat`/`StatCard`/inline stat tile
`Faucet.tsx:387-394` `Stat`; `Admin.tsx:107-119` `StatCard`; inline tile `App.tsx:2250,2466,2520`, `Payouts.tsx:300,304`, `Staking.tsx:616,677`.
- **Suggest:** one `<StatTile label value sub tone>` in `ui.tsx` (the Admin `StatCard` shape is already the most general).

### F12. 2-step "deposit to escrow → finalize on backend" submit flow
Full validate → `setBusy/setErr` → `get_*_deposit_address` → ledger transfer → parse Err → `actor.<finalize>()` → `setStep("Step 1/2…")` → `refreshAll` → `catch/finally` replicated at `App.tsx:1444-1480, 1503-1564, 1598-1672, 1766-1800`; `IdeaBoard.tsx:325-368, 385-410`; `Explorer.tsx:351-382, 478-510`; `Arcade.tsx:318-342`; `CourseMarketplace.tsx:810-833, 931-957`; `Staking.tsx:155-175, 191-210`; `CourseEditor.tsx:580-595`.
- **Suggest:** `useEscrowPay({ addressFn, finalizeFn, label, refresh })` → `{ busy, step, error, success, run }`. Each page supplies its two backend calls; the hook owns the ledger actor, transfer, error parsing, step copy, refresh. Subsumes F13.

### F13. "Step 1/2" / "Step 2/2" step-copy
Literal `setStep("Step 1/2: …")` / `"Step 2/2: …"` in all F12 flows (`App.tsx:1445/1456, 1509/1538, 1624/1648/1652`; `IdeaBoard.tsx:331/354, 385/405`; `Explorer.tsx:357/371, 486/506`; `CourseMarketplace.tsx:814/824, 938/948`; `Arcade.tsx:320/339`).
- **Suggest:** fold into `useEscrowPay` as `stepLabel(n,total,msg)`.

### F14. `opt<T>` candid-option decoder + inline equivalents
Defined once `Casino.tsx:29-34`; re-implemented inline as `=== undefined` / `?? null` / `length?[0]:null` checks 20+ times in `App.tsx` + `Explorer`/`IdeaBoard`/`CourseMarketplace`.
- **Suggest:** move `opt<T>` to `candid.ts`; replace inline optional-decoding checks.

### F15. `inputStyle` + `burn-input` className
`inputStyle` identical at `Admin.tsx:442`, `Payouts.tsx:541`; `className="burn-input"` ~64 occurrences across the codebase.
- **Suggest:** `<Input>` component / `INPUT_STYLE` export in `ui.tsx`.

### F16. `hexToBytes` / `isValidAccountId`
`App.tsx:334-344` and a second identical `hexToBytes` at `crashMath.ts:39`.
- **Suggest:** move to `encoding.ts` / `candid.ts`; import from both.

### F17. Principal reformatting workaround (minor)
`formatPrincipal(Principal.fromText(r.p.user.toString()))` at `Casino.tsx:587, 616` — round-tripping a Principal through text because `formatPrincipal` (`ui.tsx:269-274`) only accepts `Principal | null`.
- **Suggest:** widen `formatPrincipal` to accept `Principal | string | null`; drop the `fromText(…toString())` dance.

### F18. Per-page form-state boilerplate (minor)
`const [busy,err,done,step] = useState…` + `useErrorImpression(error, '<page>')` repeated at `CoursePlay.tsx:173-175`, `CourseEditor.tsx:561-563`, `CourseMarketplace.tsx:679/745/799/896/1034`, `Admin.tsx:123-126`, `Casino.tsx:77-79`, `Staking.tsx:98-101`, `Lottery.tsx:55`, `Faucet.tsx:79`, `Payouts.tsx:544`.
- **Suggest:** `useAsyncForm(name)` → `{ busy, error, setError, step, setStep, done, setDone, run }` + wired `useErrorImpression`.

---

## Highest-leverage targets
- **Backend:** B1 + B2 + B3 (all money-movement, drift-prone) → then B4, B5, B6 (mechanical, high-frequency).
- **Frontend:** F1 + F12 (the two escrow/transfer flows) → then the shared-module quick wins: `candid.ts` (F2/F14/F16), `format.ts` (F5), `tokens.ts` (F4), `ledger.ts` (F3), and the `ui.tsx` primitives `Modal`/`Banner`/`StatTile`/`Card`/`Label`/`Input` (F7–F11, F15).

## Cross-reference notes for the reviewing AI
- The frontend-dev skill (`/.claude/skills/frontend-dev/SKILL.md`) currently says **"copy an existing page, don't compose from scratch"** (line ~25) and "Reuse, don't reinvent (shared primitives in `ui.tsx`)" (line ~75). The first instruction *propagates* the duplication in F1/F7/F10/F12; the second only lists `fmtICP`/`formatPrincipal`. After extracting the shared modules, the skill must be updated to mandate them, or new pages will re-invent the same blocks.
- The backend-canister-dev skill (`/.claude/skills/backend-canister-dev/SKILL.md`, ~75 lines) has a "Conventions" section — the natural home for the extracted primitives (B1/B2/B3/B4/B5/B6/B7/B10).
- Verification after any consolidation: `cargo test` (backend), `npm test` + `npm run build` (frontend), and a grep sweep confirming no surviving inline copies of each consolidated pattern.