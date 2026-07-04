---
type: idea
title: "Minting Flow — Build Spec (PB-304)"
tags: [ideas, course-nft]
timestamp: 2026-06-13T22:37:20-04:00
---

# Minting Flow — Build Spec (PB-304)

> `mint_course_nft(course_data, name)` end-to-end: the confirmation dialog,
> server-side re-validation, the **0.5 ICP** fee collected + split **50/25/25**,
> the **two-canister mint saga** (backend → `course_nft.mint`), auto-listing,
> and draft cleanup. Read [00-overview-and-architecture.md](00-overview-and-architecture.md) first.

Depends on [PB-301](01-coursenft-canister-icrc7.md) (the ICRC-7 canister) and
[PB-303](03-minigolf-engine-and-course-format.md) (the `CourseDataV1` schema +
validator). Hands off to [PB-305](05-marketplace.md) (marketplace listing).
Editor + drafts are [PB-302](02-course-editor.md).

---

## Part A — Design / UX

### A.1 Trigger

Inside the editor (PB-302), the **Mint as NFT** button is enabled only once all
client-side validation passes. Clicking it opens the **mint confirmation dialog**
(this spec). The dialog is a portaled modal styled like `ui.tsx`'s `MoreInfo`
modal (overlay + `.card .col`, `--surface`/`--border-hi`, `--elev-3`).

### A.2 Confirmation dialog contents

A read-only summary so the user knows exactly what they are about to burn 0.5 ICP
to create:

- **Header**: "Mint this course as an NFT".
- **Course name** + **theme** (with Custom colors shown as swatches).
- **Par total** + **difficulty badge** (Easy ≤27 · Medium 28–44 · Hard ≥45).
- **Hole-by-hole summary**: a compact 9-row list — `#`, hole name (or "Hole N"),
  par. Use the `Chip` primitive for par/difficulty.
- **Fee disclosure** (verbatim economics, D-locked): "Minting burns **0.5 ICP**.
  It splits 50% to the treasury, 25% to backend cycles, 25% to frontend cycles.
  Non-refundable. Your course is auto-listed in the marketplace and starts
  earning lottery tickets when players reach hole 2." Link a `<MoreInfo>` for the
  full loop.
- **Buttons**: `Cancel` (closes, returns to editor unchanged) and
  `Confirm & Mint` (`Btn variant="primary"`).

### A.3 Mint progress + outcome

On Confirm the dialog enters a **busy state** with stepped status so a multi-call
saga doesn't look frozen:

1. "Charging 0.5 ICP…" (fee collection)
2. "Minting your course NFT…" (`course_nft.mint`)
3. "Listing in the marketplace…" (auto-list)

On **success**: the dialog closes, the local draft is cleared, and the user is
routed to their **new listing** in the marketplace (PB-305), with a toast
"Course minted — token #<id>."

On **failure**: the dialog shows the specific error (mapped from the Result
variant, A.5) and a **Retry** button. Because the saga is idempotent (B.4), retry
**never double-charges**: if the fee was already collected the retry resumes at
the mint/list step. The editor state is preserved so the user loses nothing.

### A.4 Fee payment UX (escrow-subaccount deposit — see B.3 for the why)

The repo collects its own-canister ICP fees via a **per-action escrow
subaccount**, not ICRC-2 approve (approve is only used for *ck-token* ledgers in
the Dapp Explorer / featured-slot path). The mint follows the same pattern:

1. Frontend calls `get_mint_deposit_address()` → a `LedgerAccount` (the backend
   canister + a subaccount derived from the caller).
2. Frontend transfers **0.5 ICP** there from the user's wallet (the existing
   commit-flow deposit UI / `call_icrc1_transfer` path the editor already imports
   for the arcade persona fee).
3. Frontend calls `mint_course_nft(course_data, name)`. The backend verifies the
   escrow balance covers `MINT_FEE_E8S` and proceeds.

This mirrors `commit` / pool-registration exactly, so the wallet UX, account-id
display, and "deposit then call" rhythm are already familiar and reuse existing
components.

### A.5 Result variants (surfaced as friendly copy)

`mint_course_nft` returns `Result_mint = variant { Ok : nat64; Err : MintError }`
where `nat64` is the new `token_id`. `MintError` (rendered to copy in the dialog):

| Variant | Cause | Dialog copy |
|---|---|---|
| `NotAuthenticated` | anon / Tier <2 | "Sign in to mint a course." |
| `InvalidCourse : text` | server-side `CourseDataV1` validation failed (detail in text) | "This course isn't valid: <detail>." |
| `InsufficientDeposit : record { needed; found }` | escrow < 0.5 ICP + fee | "Deposit 0.5 ICP first, then mint." |
| `FeeSettlementFailed : text` | a split leg failed (CMC/treasury) | "Couldn't process the fee — Retry." (saga safe to retry) |
| `MintCallFailed : text` | `course_nft.mint` inter-canister failure | "Mint failed after charging — Retry." (no re-charge) |
| `AlreadyMinting` | a concurrent mint for this caller is in flight | "A mint is already in progress." |

---

## Part B — Implementation

### B.1 Section & constants (`src/backend/src/lib.rs`)

Under the `// ===== 20. Course NFT marketplace =====` banner (shared with PB-302/305):

```rust
const MINT_FEE_E8S: u64 = 50_000_000;            // 0.5 ICP
const COURSE_NFT_HOLES: usize = 9;               // exactly 9, enforced here too
const MAX_COURSE_DATA_BYTES: usize = 24 * 1024;  // at-mint blob cap (≤ draft cap; PB-303 owns final number)
```

`course_nft` canister id is read from `CONFIG` (add a `course_nft_canister:
Option<Principal>` field, `#[serde(default)]`, set via an existing
`admin_set_*`-style config setter and by `deploy-local.sh`). The backend
principal is the **allowlisted minter** in the `course_nft` `NftConfig` (PB-301).

### B.2 Server-side validation (independent of the client)

The backend decodes the CBOR `course_data` and runs the **full `CourseDataV1`
validator owned by PB-303** — never trusting the client (overview §6, §8):

```rust
fn validate_course_data_for_mint(bytes: &[u8]) -> Result<CourseDataV1, MintError> {
    if bytes.len() > MAX_COURSE_DATA_BYTES {
        return Err(MintError::InvalidCourse("DATA_TOO_LARGE".into()));
    }
    let course: CourseDataV1 = decode_course_data(bytes)        // PB-303 CBOR decode
        .map_err(|e| MintError::InvalidCourse(format!("DECODE: {e}")))?;
    if course.holes.len() != COURSE_NFT_HOLES {                  // exactly 9
        return Err(MintError::InvalidCourse("NOT_NINE_HOLES".into()));
    }
    validate_course_v1(&course)                                  // PB-303: per-hole
        .map_err(MintError::InvalidCourse)?;                     // tee/cup/par/elements/pairs/bounds
    Ok(course)
}
```

`validate_course_v1` is the same routine the editor mirrors in TS and is shaped
like the existing `validate_arcade_hole` (one tee, one cup, par ∈ 2..=5, cells in
bounds, paired tunnels/ramps balanced, element count per hole bounded). This is
the trust boundary — client validation in PB-302 is convenience only.

`par_total` is computed server-side from the validated course (`holes.iter().map(par).sum()`),
never taken from the client.

### B.3 Fee collection: escrow-subaccount deposit (decision + justification)

**Chosen: escrow-subaccount deposit, not ICRC-2 approve.**

Justification — match how the repo already collects its own ICP fees:
- `settle_burn_split` (lib.rs ~2254) and pool registration both pull funds from a
  **per-action subaccount** derived via `derive_subaccount(caller, id)` and gate
  settlement on a **balance check** of that subaccount. The split legs transfer
  *out of* that subaccount; the **treasury fronts the ledger fees** when the
  zero-fee escrow is short (the 142135 post-mortem pattern). Reusing this means
  `settle_burn_split` works **verbatim** on the mint escrow. (Review O1 — buffering the
  25%/25% cycle legs into a batched CMC top-up is deferred as a *protocol-wide*
  optimization against `settle_burn_split`, not adopted per-feature here; see
  [00 §9](00-overview-and-architecture.md).)
- ICRC-2 approve in this repo is reserved for **ck-token** ledgers
  (`call_icrc2_approve`, Dapp Explorer multi-token + the PB-308 featured slot).
  Using approve for ICP here would be a second, parallel collection mechanism for
  the same asset — avoidable complexity.

Mint escrow subaccount = `derive_subaccount(&caller, MINT_ESCROW_TAG)` where
`MINT_ESCROW_TAG` is a fixed sentinel id distinct from any proposal id (e.g.
`u64::MAX - 304`), so a user's mint escrow never collides with a commit escrow.

```rust
#[ic_cdk::query(guard = "require_authenticated")]
fn get_mint_deposit_address() -> LedgerAccount {
    LedgerAccount {
        owner: get_canister_id(),
        subaccount: Some(derive_subaccount(&get_caller(), MINT_ESCROW_TAG)),
    }
}
```

### B.4 Mint saga state + ordering (idempotent, two-canister)

Atomicity risk (overview §8): the mint spans an ICP charge (3 split legs) **and**
an inter-canister `course_nft.mint`. A partial failure must never double-charge
or lose provenance. Model it on `Commitment` + `settle_burn_split`: a persisted
per-caller saga record whose block-index fields make every leg idempotent.

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MintSaga {
    pub caller: Principal,
    pub course_data: Vec<u8>,         // validated bytes, stored so a retry re-mints the same course
    pub name: String,
    pub par_total: u8,
    pub fee_e8s: u64,                 // = MINT_FEE_E8S, recorded for provenance
    // --- fee split idempotency (reused by settle_burn_split) ---
    pub treasury_block: Option<u64>,
    pub cmc_block_index: Option<u64>,
    pub frontend_cmc_block: Option<u64>,
    // --- mint idempotency ---
    pub minted_token_id: Option<u64>, // set once course_nft.mint succeeds
    pub listed: bool,                 // set once auto-list succeeds (PB-305)
    pub started_at: u64,
}
impl_storable!(MintSaga);

thread_local! {
    static MINT_SAGAS: RefCell<StableBTreeMap<Principal, MintSaga, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableBTreeMap::init(mm.borrow().get(MemoryId::new(83)))));  // claims reserved id 83
}
```

> **MemoryId 83** is claimed from the overview's reserved 83–89 band; update the
> overview §5 table in the same change. `#[serde(default)]` on any later field.

`settle_burn_split` takes a `&mut Commitment` today. Either (a) add a small
generic seam so it accepts the three `Option<u64>` block fields + a
`proposal_id`-equivalent tag, or (b) reuse `Commitment` directly by constructing
one for the mint with `proposal_id = MINT_ESCROW_TAG`. **Prefer (b)** — zero new
settlement code, and the CMC notify guard already special-cases by id. The saga
record above then only needs the three block fields mirrored back from the
`Commitment` after each attempt.

#### Strict step order (each step skipped if its idempotency marker is set)

1. **Guard & validate** — `require_authenticated`; reject Tier <2; if a
   `MINT_SAGAS[caller]` exists and is incomplete, **resume it** (treat the new
   call as a retry of the same course); else validate `course_data` (B.2), compute
   `par_total`, persist a fresh `MintSaga`.
2. **Verify deposit** — balance of the mint escrow subaccount ≥ `MINT_FEE_E8S`
   (+ the fee headroom `settle_burn_split` expects). Else `InsufficientDeposit`.
3. **Charge (split 50/25/25)** — run `settle_burn_split(ICP_LEDGER, mint_sub,
   MINT_FEE_E8S, &mut commitment)`. It is internally idempotent per leg; persist
   the three returned block indices into the saga after each leg. On error →
   `FeeSettlementFailed` (retry-safe: settled legs are not redone).
4. **Mint the token** — only after all three fee legs are recorded. If
   `saga.minted_token_id.is_none()`, call `course_nft.mint(MintArgs { to: caller,
   name, course_data, par_total, mint_fee_e8s: MINT_FEE_E8S, created_at:
   current_time() })` (PB-301 signature). On success store `minted_token_id`. On
   inter-canister failure → `MintCallFailed` (fee already charged; retry resumes
   here, never re-charging because step 3's markers are set).
   - **Idempotency on the NFT side**: pass an idempotency key (caller +
     `started_at`) so a retry that actually minted but lost the reply does not
     mint twice (PB-301 dedupes on this key). If PB-301 cannot dedupe, the
     backend instead re-reads via `icrc7_tokens_of(caller)`/last-id before
     re-minting — but the idempotency key is the preferred contract.
5. **Auto-list** — create the `COURSE_LISTINGS` (MemoryId 77, PB-305) entry for
   `minted_token_id` (listed, no sale price, cached owner/par/theme/play_count=0),
   set `saga.listed = true`. Hand-off detail (price model, card fields) is PB-305;
   this step just inserts the initial listed row so the course appears immediately.
6. **Finalize** — `clear_course_draft(caller)` (PB-302), remove the `MintSaga`
   record, `log_dapp_event("course_mint", token_id, caller, MINT_FEE_E8S)`, return
   `Ok(token_id)`.

Ordering guarantees:
- Charge **before** mint → a course is never minted free.
- Mint **before** list → a listing always references a real token.
- Draft cleared **last** → a mid-saga failure leaves the draft intact for retry
  (PB-302 A.7).
- Every external effect keyed by an idempotency marker → retry is safe and
  exactly-once in effect.

### B.5 Endpoint signature

```rust
#[ic_cdk::update(guard = "require_authenticated")]
async fn mint_course_nft(course_data: Vec<u8>, name: String) -> Result<u64, MintError> { ... }
```

Concurrency: take a per-caller in-flight guard (a `RefCell<HashSet<Principal>>`
or a `minting` flag on the saga) so two simultaneous calls return `AlreadyMinting`
rather than racing the escrow — same spirit as `LotteryLock`.

### B.6 `course_nft.mint` contract (consumed here, defined by PB-301)

```candid
type MintArgs = record {
  to            : principal;
  name          : text;
  course_data   : blob;
  par_total     : nat8;
  mint_fee_e8s  : nat64;
  created_at    : nat64;
  idempotency_key : blob;     // caller || started_at; PB-301 dedupes
};
mint : (MintArgs) -> (variant { Ok : nat64; Err : text });   // minter-guarded
```

The `creator` is set by `course_nft` to `to` (the caller) and is immutable
(drives the permanent royalty in PB-307). `play_count` / `tickets_distributed`
start at 0 (PB-306 increments).

### B.7 `backend.did` (hand-maintained, lockstep)

```candid
type MintError = variant {
  NotAuthenticated;
  InvalidCourse : text;
  InsufficientDeposit : record { needed : nat64; found : nat64 };
  FeeSettlementFailed : text;
  MintCallFailed : text;
  AlreadyMinting;
};
type MintResult = variant { Ok : nat64; Err : MintError };

service : {
  get_mint_deposit_address : () -> (LedgerAccount) query;
  mint_course_nft : (blob, text) -> (MintResult);
}
```

`LedgerAccount` already exists in the `.did`. Regenerate frontend bindings after
the edit (never hand-edit `src/bindings`). Add `course_nft_canister` to the
`Config` record if exposed via `get_config`.

### B.8 Frontend

In PB-302's `arcade/coursenft/`:
- `MintDialog.tsx` — the confirmation modal (A.2), busy stepper (A.3), error
  mapping (A.5). Reuses `Btn`, `Chip`, `MoreInfo`, the modal pattern.
- `mintClient.ts` — `get_mint_deposit_address` → deposit 0.5 ICP via the existing
  ICP-transfer helper the arcade already uses for the persona fee → `mint_course_nft`.
  Decode `MintResult`/opt fields via the `__kind__` wrapper; `token_id` is a
  `bigint`. On `Ok`, call PB-305's "go to my listing" navigation.

---

## Acceptance criteria

1. With 0.5 ICP deposited to the mint escrow, a valid 9-hole course mints: the
   fee splits 50% treasury / 25% backend cycles / 25% frontend cycles, a token is
   minted to the caller with `name`, `course_data`, server-computed `par_total`,
   and `mint_fee_e8s = 50_000_000`, the course is auto-listed, and the draft is
   cleared.
2. The backend **rejects** an 8- or 10-hole course and any course failing
   `validate_course_v1`, even if the client bypassed validation, returning
   `InvalidCourse` with a reason — **before** charging.
3. Minting without a funded escrow returns `InsufficientDeposit` and charges
   nothing.
4. Killing the process after the fee splits but before `course_nft.mint`, then
   re-calling `mint_course_nft`, **does not re-charge** and completes the mint
   (idempotent resume); a token is minted exactly once.
5. A failed `course_nft.mint` returns `MintCallFailed`; retry succeeds without a
   second charge and without minting two tokens (idempotency key honored).
6. Two concurrent calls from one caller → one proceeds, the other gets
   `AlreadyMinting`; no double charge.
7. `cargo build -p backend` + `npx tsc -b` clean; `.did` ↔ bindings in sync.

## Test plan

**Backend unit (`cargo test -p backend --lib`, native mock seam per overview §6)**
- `validate_course_data_for_mint`: 9 valid → Ok with correct `par_total`; 8/10
  holes → `NOT_NINE_HOLES`; oversized blob → `DATA_TOO_LARGE`; a per-hole
  validation failure (missing cup) → `InvalidCourse` with PB-303's reason.
- Fee split: with the ledger/CMC mocks (as `settle_burn_split` tests already do),
  assert treasury/backend/frontend amounts = 50/25/25 of `MINT_FEE_E8S` and that
  a second run with block indices already set performs no new transfers.
- Saga idempotency: simulate failure after split (markers set, `minted_token_id`
  None) → re-entry skips the charge and proceeds to mint; simulate failure after
  mint (`minted_token_id` set, `listed` false) → re-entry skips charge+mint and
  only lists.
- Concurrency guard returns `AlreadyMinting`.

**Local integration (PocketIC, `.claude/skills/run-tests`)**
- Deploy backend + `course_nft` in PocketIC with the backend allowlisted as
  minter. Fund a test identity, deposit 0.5 ICP to `get_mint_deposit_address`,
  call `mint_course_nft`; assert `icrc7_owner_of(token_id) == caller`,
  `icrc7_token_metadata` carries `course_data`/`par_total`/`mint_fee_e8s`, a
  `COURSE_LISTINGS` row exists, and `get_my_course_draft` is now `None`.
- Force `course_nft.mint` to trap once (test hook), confirm the second call
  resumes without re-charging (compare treasury balance deltas).

**Manual (`.claude/skills/icp-local-deploy`)**
- `bash scripts/deploy-local.sh` (extended to install `course_nft`). In the
  editor build a valid course, click Mint, deposit 0.5 ICP, Confirm; watch the
  stepper, land on the new marketplace listing, confirm the draft is gone.
- Mint with an underfunded escrow → friendly `InsufficientDeposit` copy.

## Out of scope
- The editor, validation UI, and draft autosave → **PB-302**.
- The `course_nft` canister internals (`mint`, dedupe, metadata storage,
  minter allowlist) → **PB-301**.
- `CourseDataV1` schema, `validate_course_v1`, CBOR codec → **PB-303**.
- Marketplace listing UI, card fields, random ordering, filters, and the price
  model → **PB-305** (this spec only inserts the initial listed row).
- Resale/royalty split (`buy_course_nft`) → **PB-307**.
- Play-to-earn ticket crediting → **PB-306**.

## Dependencies
- **PB-301** (hard): `course_nft.mint(MintArgs)` + idempotency-key dedupe +
  backend-as-minter allowlist.
- **PB-303** (hard): `CourseDataV1`, `validate_course_v1`, `decode_course_data`,
  `par` accessor.
- **PB-302** (hard): supplies the validated `course_data` + name and the draft to
  clear on success.
- **PB-305** (hand-off): `COURSE_LISTINGS` (MemoryId 77) auto-list row + "go to my
  listing" navigation.
- Reuses existing: `settle_burn_split`, `derive_subaccount`, `Commitment`,
  `call_ledger_balance`, treasury/CMC plumbing, `log_dapp_event`.
