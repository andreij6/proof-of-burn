# PB-301 — CourseNFT canister (core ICRC-7)

> The new `course_nft` canister: a thin, standards-shaped ICRC-7 token ledger
> that holds the authoritative ownership + on-chain metadata for every minted
> mini-golf course. Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md)
> first — this spec inherits decisions **D1–D4**, the shared `course_data` schema,
> the canister's MemoryId space (0–3), and all repo conventions from there.

Decision **D2**: **core ICRC-7 only** — no ICRC-37 (approvals), no ICRC-3 (tx log).
The backend is an **allowlisted minter/custodian** so it can run marketplace-mediated
mints and sales without ICRC-37 approval plumbing; token owners can still
`icrc7_transfer` their own token directly for gifting/OTC.

---

## Part A — Design / behaviour

### A.1 Role in the system

```
backend (marketplace controller)            course_nft (this canister)
─────────────────────────────────          ──────────────────────────────
mint_course_nft()      ───[minter]───────►  mint(to, meta) -> token_id
buy_course_nft()       ───[minter]───────►  custodial_transfer(token_id, to)
record_hole_event()    ───[query]────────►  icrc7_owner_of([id]) -> [opt account]
                       ───[minter]───────►  bump_play_count(id) / add_tickets(id,n)
owner (any wallet)     ─────────────────►  icrc7_transfer(args)   (gift/OTC)
explorers / wallets    ─────────────────►  icrc7_token_metadata / _tokens_of / …
```

- The canister never holds funds and never talks to a ledger. It owns exactly two
  things: **who owns each token** and **the on-chain metadata** (including the
  verbatim `course_data` blob).
- All value movement (mint fee, resale split, featured bids) lives in the
  **backend** (PB-304/305/307/308). This canister just records the resulting
  ownership change when the backend tells it to.

### A.2 Authorization model (the security core of this spec)

There are exactly three trust levels:

| Caller | May call | Notes |
|---|---|---|
| **Minter principal** (the backend, stored in `CONFIG`) | `mint`, `custodial_transfer`, `bump_play_count`, `add_tickets_distributed` | Set once at init; changeable only by an admin principal (see below). This is the only non-owner that can move a token. |
| **Token owner** | `icrc7_transfer` (their own token only) | Direct gifting / OTC. Cannot move a token they don't own. |
| **Anyone (incl. anonymous)** | all `icrc7_*` query methods | Read-only; standards-compliant so any wallet/explorer works. |

- `mint`, `custodial_transfer`, `bump_play_count`, `add_tickets_distributed` are
  guarded by `require_minter()` → traps/errors unless `caller == config.minter`.
- `icrc7_transfer` is guarded by `require_authenticated()` **and** an
  owner-equality check per token id inside the method body.
- An `admin` principal (also in `CONFIG`, the deploy controller) may call
  `set_minter` / `set_admin`. This exists only so the minter can be rotated if
  the backend canister id ever changes; it is **not** a back door to move tokens
  (admin ≠ minter unless explicitly set so).
- Mirror the backend's anonymous-ingress gate: an `#[inspect_message]` hook that
  rejects anonymous callers on every update except none (there is no public
  unauthenticated update here). Queries stay open.

### A.3 Metadata mapping (design-doc table → ICRC-7 `Value` map)

`icrc7_token_metadata` returns the standard `vec opt vec record { text; Value }`.
The design doc's metadata table maps to keys as follows (namespaced custom keys
use the `caldera:` prefix, per ICRC-7 guidance for non-standard fields):

| Design field | ICRC-7 metadata key | `Value` | Mutability |
|---|---|---|---|
| `name` | `icrc7:name` | `Text` | immutable after mint |
| `creator` | `caldera:creator` | `Text` (principal text) | **immutable forever** (royalty anchor) |
| `created_at` | `caldera:created_at` | `Nat` (ns) | immutable |
| `course_data` | `caldera:course_data` | `Blob` (CBOR `CourseDataV1`, PB-303) | immutable after mint |
| `par_total` | `caldera:par_total` | `Nat` | immutable |
| `play_count` | `caldera:play_count` | `Nat` | minter-updatable (`bump_play_count`) |
| `tickets_distributed` | `caldera:tickets_distributed` | `Nat` | minter-updatable (`add_tickets_distributed`) |
| `mint_fee_e8s` | `caldera:mint_fee_e8s` | `Nat` | immutable (provenance) |

Rules:
- **`creator` never changes** — it is the on-chain anchor the backend reads to pay
  the 10% creator royalty on every resale (PB-307). It survives every transfer.
- Only the **minter** may mutate `play_count` / `tickets_distributed`. They are
  monotonic (the setters add, never decrement). The marketplace credits the actual
  lottery tickets (PB-306); these fields are display/provenance counters mirrored
  here so explorers show a course's track record.
- `course_data` is stored verbatim and returned verbatim — this canister does **not**
  parse or validate it (PB-303/PB-304 own validation at mint). It only enforces a
  hard byte ceiling (see A.5) so metadata queries stay under message limits.

### A.4 ICRC-7 surface (which methods, and why these)

Implemented (the D2 core set the overview lists):
`icrc7_collection_metadata`, `icrc7_symbol`, `icrc7_name`, `icrc7_total_supply`
(alias `icrc7_supply`), `icrc7_supply_cap`, `icrc7_owner_of`, `icrc7_balance_of`,
`icrc7_tokens`, `icrc7_tokens_of`, `icrc7_token_metadata`, `icrc7_transfer`.

Custodial extensions (minter-only, non-standard, `caldera_*` prefix to avoid
colliding with any future standard method): `mint`, `custodial_transfer`,
`bump_play_count`, `add_tickets_distributed`, plus admin `set_minter` / `set_admin`
and a `get_nft_config` query.

Owner/minter lifecycle: `burn` (see A.6). HTTP read gateway: `http_request` (see A.7).

**Out** (D2): `icrc37_*` (approvals), `icrc3_*` (tx log), batch-mint, royalty
standard (royalty is enforced by the backend off the immutable `creator` field).

### A.6 Burn (owner-or-minter)

`burn(token_id: nat) -> variant { Ok; Err: text }` permanently destroys a token.

- **Authorization:** callable by the token's **current owner** OR the **minter**
  (mirrors `icrc7_transfer`'s owner-equality check plus the minter allowlist).
  Anonymous callers are rejected (`require_authenticated` + `inspect_message`).
- **Effect:** removes the token from `TOKENS`, removes its `OWNER_TOKENS` index
  entry, and decrements supply (implicitly, via the `TOKENS` length). After burn,
  `icrc7_owner_of` / `icrc7_token_metadata` / `http_request` for that id return
  `null` / 404, and `icrc7_transfer` / `custodial_transfer` of it error.
- **Id retirement:** `NEXT_TOKEN_ID` is **never** decremented, so a burned id is
  **never re-minted** — the id is retired forever (ids only ever increase).
- **Rejections:** burning a nonexistent / already-burned id (and any out-of-`u64`
  id) returns `NON_EXISTING_TOKEN`; a non-owner non-minter caller returns
  `UNAUTHORIZED`. The method never traps on bad input.

### A.7 HTTP read gateway (`http_request`)

A query-only `http_request(HttpRequest) -> HttpResponse` (standard candid records)
gives each token an openable URL serving **JSON** (`Content-Type: application/json`):

| Route | Returns |
|---|---|
| `GET /` | collection metadata: `name`, `symbol`, `description`, `total_supply`, `supply_cap` |
| `GET /token/<id>` | token metadata: `token_id`, `name`, `creator`, `owner`, `created_at`, `par_total`, `play_count`, `tickets_distributed`, `mint_fee_e8s`, `course_data_len`, `course_data_url` |
| `GET /token/<id>/course_data` | the raw blob as `course_data_base64` (standard base64) |

- The per-token JSON does **not** inline the raw `course_data` (it exposes its byte
  length + a separate `/token/<id>/course_data` route); both responses stay well
  under the 2 MiB message cap (the raw blob is capped at 64 KiB by `mint`, A.5).
- **Safety:** query-only (no state mutation); never panics on malformed paths
  (unknown route / non-numeric / out-of-`u64` / extra segments → **404**,
  non-`GET`/`HEAD` → 405); the id is parsed robustly; unknown/burned id → **404**.
  All string fields are emitted as escaped JSON (no HTML is produced) so no field
  can break the document or inject. `X-Content-Type-Options: nosniff` is set.
- Responses are **uncertified** read-only metadata. Certification
  (IC-Certificate header) is intentionally out of scope and documented as a future
  hardening; nothing trust-bearing should be derived from these responses without it.

### A.5 Hard limits

- **`course_data` blob ceiling: 64 KiB** per token (validated in `mint`). PB-303
  sets a tighter editor/CBOR budget (~24 KiB target); 64 KiB is the canister-level
  backstop so a single-token `icrc7_token_metadata` reply and the `mint` arg stay
  well under the 2 MiB message cap.
- **Query batch caps (review C5 — the 2 MiB response limit).** `icrc7_token_metadata`
  embeds the `course_data` blob, so a 100-id batch could reach 100 × 64 KiB = **6.4 MiB
  and trap**. Therefore cap `icrc7_token_metadata` at **≤ 25 ids/call**
  (25 × 64 KiB = 1.6 MiB < 2 MiB). The lightweight methods (`icrc7_owner_of`,
  `icrc7_tokens_of`, `icrc7_tokens`, `icrc7_balance_of`) return only ids/accounts and
  keep the standard **100-id** cap. Advertise both in `icrc7_collection_metadata`:
  `icrc7:max_query_batch_size = 100` plus a course-specific
  `course:max_metadata_batch_size = 25`. Marketplace cards read the cheap cached fields
  (`COURSE_LISTINGS`, PB-305), not the blob; full `course_data` is fetched one token at
  a time (PB-305 `get_course_data`) or in ≤ 25-id metadata batches. Over-cap calls
  return `Err`/trap with a clear `BATCH_TOO_LARGE` message.
- `name` (the `icrc7:name`): 1–60 chars (matches the editor's course-name rule).

### A.8 Security (guarantees)

This canister holds value-bearing ownership records; the following invariants are
enforced and covered by unit tests:

- **Guards match the trust model.** Minter-only: `mint`, `custodial_transfer`,
  `bump_play_count`, `add_tickets_distributed` (`guard = require_minter`).
  Owner-or-minter: `icrc7_transfer` (per-token owner-equality check), `burn`
  (owner-equality OR minter). Admin-or-controller: `set_minter`, `set_admin`.
- **No anonymous updates.** `#[inspect_message]` rejects anonymous callers on every
  update at ingress; update bodies also call `require_authenticated` defensively.
- **No ownership forgery / hijack.** No method lets a caller mint without being the
  minter, move or burn a token they don't own, or set themselves as minter/admin
  without being admin/controller. `creator` is set once at mint and never written
  again (immutable royalty anchor) — verified across custodial + owner transfers.
- **No reuse of burned ids.** `NEXT_TOKEN_ID` is monotonic and only ever increases;
  a burned id is permanently retired and can never be re-minted, re-owned, or
  transferred.
- **No untrusted input can trap the canister (DoS).** ICRC-7 `nat → u64`
  conversions return `None`/errors instead of panicking; batch args are capped
  (100 light / 25 metadata) with a clear `BATCH_TOO_LARGE`; `http_request` handles
  every malformed path gracefully (404/405, never traps) and is query-only;
  responses are bounded under 2 MiB.
- **No integer overflow/underflow.** Id allocation uses `checked_add`
  (`ID_SPACE_EXHAUSTED` on the unreachable wraparound); the monotonic counters use
  `saturating_add`.
- **Upgrade safety.** All stable structures keep their MemoryIds (0–3, no reuse);
  later-added fields carry `#[serde(default)]`; no heap state to rebuild.
- **Out of scope (documented):** HTTP responses are uncertified read-only metadata
  (future hardening); no ICRC-37 approvals / ICRC-3 tx log (D2).

---

## Part B — Implementation

### B.1 Crate layout

New crate `src/course_nft/` (sibling of `src/backend/`), added to the workspace:

```
src/course_nft/
  Cargo.toml          # mirrors src/backend/Cargo.toml deps
  course_nft.did      # hand-maintained candid (lockstep with the Rust surface)
  src/lib.rs          # single-file, section-bannered like the backend
```

`Cargo.toml` (mirror the backend — same versions):

```toml
[package]
name = "course_nft"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
candid = "0.10"
ic-cdk = "0.19"
ic-stable-structures = "0.7"
serde = { version = "1", features = ["derive"] }
ciborium = "0.2"

[dev-dependencies]
pocket-ic = "9"
candid = "0.10"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

Workspace root `Cargo.toml` — add the member:

```toml
[workspace]
members = [
    "src/backend",
    "src/course_nft",
]
resolver = "2"
```

`src/lib.rs` section banners (mirror the backend's `// N. Title` style between
`// ====` rules): `1. Data Models` · `2. Stable Storage Trait Impls` ·
`3. Persistent Memory Layout` · `4. Security Guards` · `5. Init & Post Upgrade` ·
`6. Admin / Config` · `7. Minter (custodial) API` · `8. ICRC-7 queries` ·
`9. ICRC-7 owner transfer` · `10. Tests`.

### B.2 Data models

Reuse the backend's `impl_storable!` macro verbatim (CBOR via `ciborium`,
`Bound::Unbounded`). **Every field that may be added later carries
`#[serde(default)]`** (upgrade safety — same rule as the backend).

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct CourseToken {
    pub owner: Principal,
    pub name: String,
    pub creator: Principal,          // immutable royalty anchor
    pub created_at: u64,             // ns
    pub course_data: Vec<u8>,        // verbatim CourseDataV1 CBOR (PB-303)
    pub par_total: u16,             // sum of 9 hole pars (18..=45)
    #[serde(default)] pub play_count: u64,
    #[serde(default)] pub tickets_distributed: u64,
    pub mint_fee_e8s: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct NftConfig {
    pub minter: Principal,           // the backend canister principal
    pub admin: Principal,            // deploy controller; may rotate minter
    pub symbol: String,             // "CALCRS"
    pub name: String,               // "Caldera Mini-Golf Courses"
    pub description: String,
    #[serde(default)] pub supply_cap: Option<u64>, // None = uncapped
}

impl_storable!(CourseToken);
impl_storable!(NftConfig);
```

`OWNER_TOKENS` uses a composite key so the `(owner, token_id)` prefix range scan
backs `icrc7_tokens_of` / `icrc7_balance_of` cheaply.

> **Correctness (review C2) — do NOT use `impl_storable!` (CBOR) for this key.**
> `StableBTreeMap` orders keys by their raw serialized bytes, and CBOR (`ciborium`,
> what `impl_storable!` emits) does **not** preserve lexicographic field order — a
> CBOR `(Principal, u64)` key yields a broken `range(owner..)`, so `icrc7_tokens_of`
> returns corrupted/incomplete results. Hand-roll a **fixed-width big-endian**
> `Storable` so the bytes sort by `(owner, token_id)` and the key is `Bounded`:

```rust
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct OwnerTokenKey { pub owner: Principal, pub token_id: u64 }

impl Storable for OwnerTokenKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let p = self.owner.as_slice();                 // <= 29 bytes
        let mut b = Vec::with_capacity(38);
        b.push(p.len() as u8);                          // [0]    principal length
        b.extend_from_slice(p);                         // [1..]  principal bytes
        b.resize(30, 0);                                // pad principal region to 29 (+1 len)
        b.extend_from_slice(&self.token_id.to_be_bytes()); // [30..38] big-endian id
        Cow::Owned(b)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let len = bytes[0] as usize;
        let owner = Principal::from_slice(&bytes[1..1 + len]);
        let token_id = u64::from_be_bytes(bytes[30..38].try_into().unwrap());
        Self { owner, token_id }
    }
    const BOUND: Bound = Bound::Bounded { max_size: 38, is_fixed_size: true };
}
```

`icrc7_tokens_of(acc, prev, take)` then scans
`OWNER_TOKENS.range(OwnerTokenKey{owner: acc.owner, token_id: prev.unwrap_or(0)} ..)`
and stops after `take`, returning ids in ascending order. (The repo's existing
composite-key maps use `impl_storable!` only because they never prefix-`range()`;
this map does, so it must not — confirmed: the only `.iter()`/`.range()` uses in
`lib.rs` are full reverse scans, never prefix scans.)

### B.3 Memory layout (this canister's own space — from the overview)

```rust
thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    // 0 — TOKENS
    static TOKENS: RefCell<StableBTreeMap<u64, CourseToken, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(0)))));

    // 1 — OWNER_TOKENS index (range-scanned by owner)
    static OWNER_TOKENS: RefCell<StableBTreeMap<OwnerTokenKey, (), Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableBTreeMap::init(mm.borrow().get(MemoryId::new(1)))));

    // 2 — NEXT_TOKEN_ID
    static NEXT_TOKEN_ID: RefCell<StableCell<u64, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(mm.borrow().get(MemoryId::new(2)), 1)));

    // 3 — CONFIG (collection metadata + minter/admin)
    static CONFIG: RefCell<StableCell<NftConfig, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(StableCell::init(
            mm.borrow().get(MemoryId::new(3)), NftConfig::default_placeholder())));
}
```

Token ids start at **1** (0 reserved as "no token"). MemoryIds 0–3 are this
canister's only allocations; any future structure claims the next id **and updates
the overview's per-canister table** (overview §5).

### B.4 Init & post-upgrade

Init takes the minter (backend) + admin principals:

```rust
#[derive(CandidType, Deserialize)]
pub struct InitArgs {
    pub minter: Principal,        // backend canister id
    pub admin: Principal,         // deploy controller (rotates minter)
    pub symbol: Option<String>,   // default "CALCRS"
    pub name: Option<String>,     // default "Caldera Mini-Golf Courses"
    pub supply_cap: Option<u64>,  // default None
}

#[ic_cdk::init]
fn init(args: InitArgs) { /* write CONFIG from args */ }

#[ic_cdk::post_upgrade]
fn post_upgrade() { /* stable data auto-restores; nothing else to do */ }
```

Stable structures auto-restore on upgrade — no heap state to rebuild. (Contrast
the backend, which re-arms timers; this canister has none.)

### B.5 Minter (custodial) API — Rust + candid

```rust
fn require_minter() -> Result<(), String> {
    if caller() != CONFIG.with(|c| c.borrow().get().minter) {
        return Err("NOT_MINTER".into());
    }
    Ok(())
}

#[derive(CandidType, Deserialize)]
pub struct MintArgs {
    pub to: Principal,
    pub name: String,
    pub creator: Principal,     // backend passes the original minting user
    pub course_data: Vec<u8>,   // CourseDataV1 CBOR
    pub par_total: u16,
    pub mint_fee_e8s: u64,
}

#[ic_cdk::update(guard = "require_minter")]
fn mint(args: MintArgs) -> Result<u64, String>;
// validates: name 1..=60 chars, course_data <= 65536 bytes, par_total 18..=45,
// supply_cap not exceeded. Allocates next id, sets created_at = time(),
// play_count/tickets_distributed = 0, inserts TOKENS + OWNER_TOKENS, bumps NEXT.

#[ic_cdk::update(guard = "require_minter")]
fn custodial_transfer(token_id: u64, to: Principal) -> Result<(), String>;
// marketplace-mediated transfer (sale settlement). Moves owner, rewrites the
// OWNER_TOKENS index (remove old key, insert new). No approval needed.

#[ic_cdk::update(guard = "require_minter")]
fn bump_play_count(token_id: u64, by: u64) -> Result<u64, String>;       // returns new count

#[ic_cdk::update(guard = "require_minter")]
fn add_tickets_distributed(token_id: u64, by: u64) -> Result<u64, String>;
```

Candid (`course_nft.did`):

```candid
type MintArgs = record {
  to : principal; name : text; creator : principal;
  course_data : blob; par_total : nat16; mint_fee_e8s : nat64;
};
mint : (MintArgs) -> (variant { Ok : nat64; Err : text });
custodial_transfer : (nat64, principal) -> (variant { Ok; Err : text });
bump_play_count : (nat64, nat64) -> (variant { Ok : nat64; Err : text });
add_tickets_distributed : (nat64, nat64) -> (variant { Ok : nat64; Err : text });
```

### B.6 ICRC-7 query surface — Rust + candid

Use the ICRC-7 `Value` type (`variant { Blob; Text; Nat; Int; Array; Map }`).

> **Correctness (review C1) — ICRC-7 requires unbounded `nat` for token ids,
> balances and supplies.** Exposing `nat64` makes standard wallets (Plug, Bitfinity)
> and explorers (Yumi, Toniq) fail Candid deserialization — defeating the whole point
> of being standards-readable (decision D2). So the public ICRC-7 surface uses
> `candid::Nat`; convert at the edge with a helper `nat_to_u64(n) -> Option<u64>`
> (None when it exceeds u64 → that id simply doesn't exist, so `icrc7_owner_of`
> returns `None`). **Storage and keys stay `u64`.** The non-standard backend↔nft
> methods (`mint`, `custodial_transfer`, `bump_play_count`, `add_tickets_distributed`)
> are trusted internal calls, not part of the ICRC-7 surface, and keep `nat64`.

```rust
#[ic_cdk::query] fn icrc7_collection_metadata() -> Vec<(String, Value)>;
#[ic_cdk::query] fn icrc7_symbol() -> String;
#[ic_cdk::query] fn icrc7_name() -> String;
#[ic_cdk::query] fn icrc7_total_supply() -> Nat;          // == count of TOKENS
#[ic_cdk::query] fn icrc7_supply() -> Nat { icrc7_total_supply() } // alias
#[ic_cdk::query] fn icrc7_supply_cap() -> Option<Nat>;
#[ic_cdk::query] fn icrc7_owner_of(ids: Vec<Nat>) -> Vec<Option<Account>>;  // <=100 ids
#[ic_cdk::query] fn icrc7_balance_of(accs: Vec<Account>) -> Vec<Nat>;
#[ic_cdk::query] fn icrc7_tokens(prev: Option<Nat>, take: Option<Nat>) -> Vec<Nat>;
#[ic_cdk::query] fn icrc7_tokens_of(acc: Account, prev: Option<Nat>, take: Option<Nat>) -> Vec<Nat>;
#[ic_cdk::query] fn icrc7_token_metadata(ids: Vec<Nat>) -> Vec<Option<Vec<(String, Value)>>>; // <=25 (C5)
```

`Account` is the standard ICRC `record { owner: principal; subaccount: opt blob }`;
this collection only ever uses the default subaccount (`None`). `icrc7_owner_of`
returns `None` for unknown/burned ids. Lightweight batch methods cap at **100 ids**;
`icrc7_token_metadata` caps at **25 ids** (A.5/C5); both return `Err`/trap on oversize,
per ICRC-7.

`icrc7_token_metadata` builds the `Value` map from `CourseToken` exactly per the
A.3 table.

Candid:

```candid
type Account = record { owner : principal; subaccount : opt blob };
type Value = variant { Blob:blob; Text:text; Nat:nat; Int:int; Array:vec Value; Map:vec record{text;Value} };
icrc7_collection_metadata : () -> (vec record { text; Value }) query;
icrc7_total_supply : () -> (nat) query;
icrc7_supply_cap : () -> (opt nat) query;
icrc7_owner_of : (vec nat) -> (vec opt Account) query;
icrc7_balance_of : (vec Account) -> (vec nat) query;
icrc7_tokens : (opt nat, opt nat) -> (vec nat) query;
icrc7_tokens_of : (Account, opt nat, opt nat) -> (vec nat) query;
icrc7_token_metadata : (vec nat) -> (vec opt vec record { text; Value }) query;
```

### B.7 Owner-initiated transfer (`icrc7_transfer`)

Standard ICRC-7 shape; only the owner of each token id may move it.

```rust
#[derive(CandidType, Deserialize)]
pub struct TransferArg {
    pub token_id: Nat,        // standard ICRC-7 nat; convert to u64 internally
    pub to: Account,
    pub from_subaccount: Option<[u8;32]>,
    pub memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
}

#[ic_cdk::update]
fn icrc7_transfer(args: Vec<TransferArg>) -> Vec<Option<TransferResult>>;
// require_authenticated(); per arg: token must exist AND token.owner == caller,
// else TransferError::Unauthorized. On success move owner + rewrite OWNER_TOKENS.
// creator/course_data/counters are untouched.
```

```candid
type TransferArg = record {
  token_id : nat; to : Account;
  from_subaccount : opt blob; memo : opt blob; created_at_time : opt nat64;
};
type TransferError = variant {
  NonExistingTokenId; Unauthorized; TooOld; CreatedInFuture : record { ledger_time : nat64 };
  Duplicate : record { duplicate_of : nat }; GenericError : record { error_code : nat; message : text };
};
icrc7_transfer : (vec TransferArg) -> (vec opt variant { Ok : nat; Err : TransferError });
```

(Owners gifting/OTC trade here bypass the marketplace; the backend reconciles its
cached listing on the next read since `icrc7_owner_of` is the source of truth.)

### B.8 `icp.yaml` + `deploy-local.sh` wiring

`icp.yaml` — add a canister + include it in the `local` environment:

```yaml
  - name: course_nft
    recipe:
      type: "@dfinity/rust@v3.2.0"
      configuration:
        package: course_nft
        candid: src/course_nft/course_nft.did
    settings:
      freezing_threshold: 7776000
    # minter/admin filled by deploy-local.sh after the backend id is known;
    # placeholder uses the local controller for both so a bare `icp deploy` works.
    init_args: '(record { minter = principal "<BACKEND_OR_CONTROLLER>"; admin = principal "gwrne-un4am-3lsx4-7dmak-pnj5y-zxsk2-aalax-2rzyk-k4e23-jgmqy-3qe"; symbol = opt "CALCRS"; name = opt "Caldera Mini-Golf Courses"; supply_cap = null })'
```

Add `course_nft` to the `environments: local: canisters:` list (and **not** to
staging/production — this feature ships dark behind a flag; mainnet wiring is a
later, explicitly-gated change).

`scripts/deploy-local.sh` — extend (after the backend deploy block, step 3):
1. `icp deploy course_nft …` (or include in the existing deploy invocation).
2. Read `COURSE_NFT_ID=$(canister_id course_nft)` and `BACKEND_ID`.
3. Set the real minter to the backend:
   `icp canister call course_nft set_minter "(principal \"$BACKEND_ID\")" --identity "$DEPLOY_IDENTITY"`.
4. Wire the backend at the NFT canister so it can call `mint`/`custodial_transfer`:
   `icp canister call backend admin_set_course_nft_canister "(principal \"$COURSE_NFT_ID\")"`
   (the `admin_set_course_nft_canister` setter is defined in PB-304's backend work;
   this spec only requires the deploy script wire it once both ids exist).
5. Print `COURSE_NFT_ID` in the summary block.

Because `mint`/`custodial_transfer` are minter-gated, the backend must be set as
minter for any end-to-end test; the deploy script is the canonical place this
happens locally.

---

## Acceptance criteria

- New `course_nft` crate compiles to wasm; workspace `cargo build` succeeds; the
  crate is in `Cargo.toml` members.
- `mint` (minter only) creates a token with a fresh monotonic id, records owner +
  metadata, indexes `OWNER_TOKENS`, increments supply; rejects non-minter callers,
  `course_data` > 64 KiB, `name` outside 1–60, `par_total` outside 18–45, and
  over-cap mints.
- `custodial_transfer` (minter only) moves ownership and rewrites the owner index;
  rejects non-minter callers and unknown token ids.
- `icrc7_owner_of` returns the live owner; reflects both `custodial_transfer` and
  `icrc7_transfer`. Unknown ids return `null`.
- `icrc7_transfer` succeeds only for the token's current owner; every other caller
  gets `Unauthorized`; `creator` and the counters are unchanged after a transfer.
- `icrc7_token_metadata` returns every A.3 key with the correct `Value` types;
  `creator` is byte-identical across transfers; `course_data` round-trips verbatim.
- `bump_play_count` / `add_tickets_distributed` are minter-only, monotonic, and
  reflected in subsequent `icrc7_token_metadata`.
- Batch queries reject > 100 ids; `icrc7_tokens_of` paginates by `(prev, take)`.
- Upgrade safety: deploy → mint a token → `--mode upgrade` → token, owner, metadata,
  config, and `NEXT_TOKEN_ID` all survive.

## Test plan

**Rust unit tests** (`src/course_nft/src/lib.rs`, `#[cfg(test)]`, mirror the
backend's `get_caller`/`set_mock_caller` test seam so update guards are testable
off-wasm):
- mint happy path; ids increment; supply increments.
- mint rejects: non-minter, oversize blob, bad name length, bad par_total, over cap.
- `custodial_transfer` moves owner + updates `OWNER_TOKENS`; non-minter rejected;
  unknown id rejected.
- `icrc7_owner_of` / `icrc7_balance_of` / `icrc7_tokens_of` reflect a sequence of
  mint → custodial_transfer → owner `icrc7_transfer`.
- `icrc7_transfer`: owner succeeds; non-owner → `Unauthorized`; non-existent →
  `NonExistingTokenId`; `creator`/counters unchanged afterward.
- `icrc7_token_metadata` key/`Value` mapping matches A.3; verbatim `course_data`.
- `bump_play_count` / `add_tickets_distributed` monotonic + minter-gated.
- batch size cap: > 100 ids rejected on light methods; **> 25 ids rejected on
  `icrc7_token_metadata`** (review C5).
- **(C2) `OwnerTokenKey` ordering:** mint > 256 tokens to two owners interleaved
  (so the high byte of `token_id` varies), then assert `icrc7_tokens_of(ownerA)`
  returns *exactly* ownerA's ids in ascending order and none of ownerB's — this is
  the test a CBOR-encoded key fails. Round-trip `to_bytes`/`from_bytes` and assert
  total length is a fixed 38 bytes.
- **(C1) `nat` boundary:** `icrc7_owner_of([Nat::from(u64::MAX) + 1])` → `None`
  (out-of-u64 id doesn't exist, no trap); `icrc7_total_supply` returns `Nat`.

**Local two-canister integration smoke** (PocketIC, in `src/course_nft` dev-deps,
mirrors the backend's PocketIC tests): install `course_nft` with `minter = backend
principal`; from a stand-in backend principal call `mint` then `custodial_transfer`;
assert `icrc7_owner_of`; from a non-minter principal assert `mint`/`custodial_transfer`
are rejected; from the owner principal call `icrc7_transfer` and assert the new
owner; upgrade the canister and re-assert ownership + metadata.

**Manual local**: `bash scripts/deploy-local.sh` installs `course_nft`, sets the
backend as minter; `icp canister call course_nft icrc7_collection_metadata '()'`
returns the collection; after a PB-304 mint, `icrc7_owner_of` / `icrc7_token_metadata`
return the new course.

## Out of scope

- ICRC-37 approvals, ICRC-3 transaction log, batch mint, royalty standard (D2).
- Mint-fee charging, resale split, featured-slot funds, ticket crediting — all
  backend (PB-304/305/307/308); this canister only mutates ownership + counters.
- `course_data` semantic validation (PB-303/PB-304); this canister enforces only
  the byte ceiling.
- Mainnet/staging wiring of the canister (later, explicitly-gated).
- Frontend (the marketplace UI reads via the backend; PB-305).

## Dependencies

- **Blocks**: PB-304 (minting flow calls `mint`), PB-305 (marketplace reads
  `icrc7_owner_of`/metadata), PB-307 (resale calls `custodial_transfer` + reads
  `creator`), PB-306 (ticket paths call `bump_play_count`/`add_tickets_distributed`).
- **Depends on**: PB-303 only as the producer of the `course_data` CBOR bytes this
  canister stores verbatim (no compile-time coupling — bytes are opaque here).
- **No dependency on** PB-302/308/309/310.
