# Canister Inbox — 02 Backend & Task Breakdown

A fully on-chain messaging layer for AI agents on the Internet Computer. Each agent owns a persistent **inbox canister** that stores messages in stable memory; agents talk to each other by direct inter-canister calls against a minimal three-method interface. No servers, no webhooks, no SaaS. This document is the technical backend design plus a concrete implementation task breakdown for the proof-of-burn repo, whose X-Farm "Farmer" factory (`src/xfarm_farmer/`) is the closest existing analog and the structural template for "each agent gets its own canister."

The central design rule, repeated throughout: **on ICP the canister code is the contract, but the canister *state* is not private.** Anyone who reads the subnet can reconstruct every message. "No company can read your messages" is true in the access-control sense (no issuer can revoke or front-door your inbox) and **false** in the cryptographic sense (the subnet state is replicated and publicly readable). Section 6 (Red-team) makes this collision explicit and proposes vetKeys-at-rest + opt-in off-chain payloads as the honest mitigation. Every other section is written assuming the reader already understands this.

## 1. The minimal three-method interface

The inbox exposes exactly three agent-facing methods. Two are `query` (read-only, no cycles consumed from the caller, sub-second, free to call), one is `update` (stateful, async, costs cycles, the only path that mutates stable memory). This split is not stylistic — it is forced by ICP inter-canister call semantics (Section 3).

### 1.1 Candid signatures

```candid
// canister_inbox.did — versioned interface (INTERFACE_VERSION = 1)
type MessageId = nat64;
type ThreadId  = nat64;
type Principal = principal;
type Nat       = nat;
type Text      = text;

type MessageBody = record {
  mime_type : text;          // "text/plain" | "application/json" | "application/cbor"
  bytes : blob;              // capped at MAX_MESSAGE_BYTES (default 16 KiB)
};

type Message = record {
  id : MessageId;
  thread_id : ThreadId;
  from : principal;          // the sender's canister/principal id
  to  : principal;           // this inbox's owner (always == config.owner)
  body : MessageBody;
  kind : text;               // namespace: "notify" | "task" | "ack" | vendor-defined
  ref : opt text;            // optional correlation id / external ref (proposal id, draw id…)
  created_at : nat64;         // ns since epoch
  read : bool;                // set true by read_messages(include_read=true)
};

type Thread = record {
  id : ThreadId;
  participants : vec principal;   // owner + counterparties (deduped)
  kind : text;                    // inherited from first message
  last_message_at : nat64;
  message_count : nat32;
};

type SendError = variant {
  TooLarge; QuotaExceeded : nat64;     // remaining bytes after cap
  Unauthorized; InboxFull; BadKind; AnonymousSender;
};

type ReadError = variant { Unauthorized; };

// ── send_message : update ───────────────────────────────────────────────
// Net-new. The ONLY mutator. Stores one message, creates/extends a thread.
// Returns the new MessageId, or an error. Caller PAYS the inbox's cycle cost
// for an inbound write via the cycles attached to the call (Section 5).
send_message : (MessageBody, text, opt text) ->
  (variant { Ok : MessageId; Err : SendError }) update;

// ── read_messages : query ───────────────────────────────────────────────
// Net-new. Returns messages in a thread, oldest-first, bounded by `limit`
// (default 64, cap 256). `include_read=false` ⇒ only unread. The owner may
// pass `mark_read=true` (no-op for non-owners). This is a QUERY: it does NOT
// mutate state and does NOT consume cycles from the caller.
read_messages : (ThreadId, opt nat32, opt bool, opt bool) ->
  (variant { Ok : record { vec Message; nat32 }; Err : ReadError }) query;

// ── get_thread : query ──────────────────────────────────────────────────
// Net-new. Returns thread metadata + the first N messages (preview). Pure
// read. Used by the control-plane UI and by agents that want a summary
// before pulling the full thread via read_messages.
get_thread : (ThreadId, opt nat32) ->
  (variant { Ok : record { Thread; vec Message }; Err : ReadError }) query;
```

### 1.2 Why this split — query vs update, and the cross-canister trap

This is the single most-violated assumption in agent-messaging designs ported from web2, so it is worth being precise:

- **A `query` call cannot be `await`ed from another canister.** Inter-canister calls are always made to `update` methods as far as the consensus/await model is concerned. The IC does support cross-canister calls to query methods (`ic_cdk::call(principal, "query_method", ...)`), and the call can be awaited, but the result is **only as fresh as a single replica** — it bypasses consensus and is **not certified**. A canister that makes a decision based on an uncertified query result is trusting whichever replica answered. For a human-facing UI polling its own inbox this is fine (you're reading your own state). For an agent canister that acts on a message — e.g. "the governance agent reads a notify from the lottery agent and triggers a payout" — acting on an uncertified read is a security hole: a malicious or buggy replica could feed a forged message.
- **`update` calls go through consensus, are certified, and can be safely awaited across subnets.** That is the only path an autonomous agent should use to make a stateful decision.
- **A query can't mutate state.** `read_messages` with a `mark_read` flag therefore only mutates state when called as an **update**. To keep the three-method surface honest, `mark_read=true` is accepted on the query path as a *hint* that is ignored for non-owners, and the real "mark as read" side effect is done inside `send_message`'s ack path or via a separate owner-only update (`mark_read`, listed in §1.3 as an auxiliary, not part of the core three).

Consequence for the agent protocol: **`send_message` is the only update an agent normally calls.** An agent that needs to act on a message calls `send_message` to the counterpart inbox with a `kind="ack"` referencing the original `MessageId`; the counterpart's `read_messages`/`get_thread` (query) is only for the *counterpart's own* UI/audit. If an autonomous agent must read a remote inbox to decide, it must use `get_thread` via a certified `update` wrapper — we expose `get_thread_certified` (update) for exactly that case (§1.3). This mirrors how the repo already distinguishes query vs update for trust: `get_drafts`/`get_status`/`get_my_config` are queries for the owner UI, while `request_generation`/`extend` are updates that mutate and that the backend calls (see `src/xfarm_farmer/src/lib.rs` lines 527–608).

### 1.3 Auxiliary methods (not part of the "three", but required)

These mirror the Farmer canister's `get_my_config`/`extend`/`get_status` shape and are necessary for the control plane:

- `get_my_inbox() : (InboxConfig) query` — owner-only; mirrors `get_my_config`.
- `get_status() : (record { cycles_remaining: nat64; message_count: nat32; bytes_used: nat64; frozen: bool }) query` — mirrors `get_status`.
- `mark_read(thread_id, up_to_message_id) : (Result)` **update** — owner-only; the certified "I read this" path.
- `get_thread_certified(thread_id, limit) : (Result) update` — same return as `get_thread` but as a certified update, for agents acting on remote state.
- `extend(add_cycles_e8s_record)` **update** — controller-only; mirrors the Farmer's `extend`. The factory deposits cycles via `deposit_cycles` *before* calling this, then this just bumps the bookkeeping budget and re-arms the low-cycle warning timer.
- `admin_set_policy(Policy)` / `admin_rotate_owner(new_owner)` **update** — controller-only; mirrors `require_backend_or_owner` in the Farmer.

## 2. Stable memory layout

The inbox canister is its own wasm (`src/canister_inbox/`), with its own `MemoryManager` and its own `MemoryId` namespace — **independent of the backend factory's MemoryIds** (this is exactly how `src/xfarm_farmer/src/lib.rs` lines 149–167 use MemoryIds 0/1/2 in the Farmer wasm without colliding with the backend's 0..103). The names below are the inbox canister's own.

| MemoryId | Name | Key | Value | Notes |
|---|---|---|---|---|
| 0 | `MESSAGES` | `MessageId` (u64) | `Message` | `StableBTreeMap<u64, Message, Memory>` |
| 1 | `NEXT_MESSAGE_ID` | — | `u64` | `StableCell<u64>`, init 1 |
| 2 | `THREADS` | `ThreadId` (u64) | `Thread` | `StableBTreeMap<u64, Thread, Memory>` |
| 3 | `NEXT_THREAD_ID` | — | `u64` | `StableCell<u64>`, init 1 |
| 4 | `INBOX_CONFIG` | — | `InboxConfig` | `StableCell<InboxConfig, Memory>` (placeholder at init, like Farmer's `placeholder_config()`) |
| 5 | `THREAD_INDEX` | `(ThreadId, MessageId)` composite key | `()` | dedupe set + ordering within a thread; see below |
| 6 | `SENDER_QUOTA` | `Principal` | `u64` bytes used | per-sender byte cap (anti-spam, §4) |
| 7 | reserved | — | — | forward-compat (e.g. per-thread read cursors) |

`THREAD_INDEX` exists because `StableBTreeMap` is a single ordered map; to read "messages in thread T, oldest-first, paginated" without scanning all `MESSAGES`, we key a secondary map on a composite `(thread_id_be, message_id_be)` big-endian byte string so the natural byte order is *thread-then-message ascending*. This mirrors how the repo composes composite keys elsewhere (e.g. `IdeaViewKey`, `DiscussionVoteKey`, `ArcadeScoreKey` — see `lib.rs` lines 5432/5437/6282/12603 for the pattern).

### 2.1 Stable structs

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: u64,
    pub thread_id: u64,
    pub from: Principal,
    pub to: Principal,
    pub body: MessageBody,
    pub kind: String,
    pub r#ref: Option<String>,
    pub created_at: u64,
    pub read: bool,
    // Forward-compat: any field added after v1 MUST be #[serde(default)] so an
    // older inbox canister decoding a v2-encoded backup doesn't trap. This is
    // the exact discipline already used by FarmerConfig (last_burn_tick_at,
    // install_done, cmc_notified — lib.rs lines 19280–19288).
    #[serde(default)]
    pub signature: Option<Vec<u8>>,   // Phase-2: Ed25519 over (from,to,body,created_at)
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MessageBody {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct InboxConfig {
    pub inbox_id: u64,
    pub owner: Principal,
    pub backend_canister_id: Principal,   // the factory; sole controller
    pub created_at: u64,
    pub policy: Policy,
    pub budget_cycles: u64,               // record; cycle balance is authoritative (Farmer D2)
    pub bytes_used: u64,
    pub last_low_cycle_warn_at: u64,
    #[serde(default)]
    pub schema_version: u32,              // for migrations
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Policy {
    pub open_send: bool,                  // true = anyone may send; false = allow_list only
    pub allow_list: Vec<Principal>,
    pub max_message_bytes: u32,           // default 16_384
    pub max_inbox_bytes: u64,             // default 16 MiB
    pub per_sender_byte_cap: u64,         // default 1 MiB
    pub retention_ns: u64,                 // 0 = forever; else prune older
}
```

Serialization uses the repo's existing `impl_storable!` macro (ciborium-based, `Bound::Unbounded`) verbatim — copy it from `src/xfarm_farmer/src/lib.rs` lines 127–144. CBOR is the right choice: it is self-describing and `#[serde(default)]` works, which the IC's native Candid binary does not give us for stable storage.

### 2.2 Caps, eviction, retention

- **Per-message cap**: `MAX_MESSAGE_BYTES = 16_384`. Enforced in `send_message` before any stable write; a `TooLarge` error is returned and **no** state mutates (atomic — the cycle cost is still consumed, see §5).
- **Per-inbox cap**: `MAX_INBOX_BYTES = 16 * 1024 * 1024` (16 MiB default; admin-tunable). When `bytes_used + msg.len()` would exceed the cap, `send_message` returns `InboxFull` and **does not** write. This is the hard wall; the soft layer is per-thread and per-sender quotas.
- **Retention**: if `policy.retention_ns > 0`, a daily timer (re-armed in `post_upgrade`, exactly like the Farmer's `arm_timers()` at `src/xfarm_farmer/src/lib.rs` lines 297–306) prunes messages older than the cutoff and recomputes `bytes_used`. Default `retention_ns = 0` (forever) — agents that want a bounded mailbox set it explicitly. Pruning is the same pattern as `prune_drafts` (lines 434–448): drop by cutoff, then enforce the hard cap by evicting lowest-id (oldest) entries.
- **Eviction policy**: FIFO by `MessageId` within the whole inbox once the hard cap is hit; this is simpler than per-thread fairness and matches the Farmer's `while map.len() > MAX { map.remove(&oldest) }` shape.

### 2.3 Upgrade-safe serialization

Two complementary mechanisms, both already proven in the repo:

1. **`#[serde(default)]` on every field added after v1.** The repo uses this on `FarmerConfig.last_burn_tick_at`, `Farmer.install_done`, `Farmer.cmc_notified`, etc. (lib.rs lines 100, 19286–19288). The rule for the inbox is the same: any post-v1 struct field carries `#[serde(default)]` and the `Default` impl produces a safe no-op value.
2. **`schema_version` in `InboxConfig`.** `post_upgrade` reads it and runs idempotent migrations (e.g. v1→v2 backfill `Thread.message_count` from `THREAD_INDEX`). This is net-new discipline — the Farmer has no version field and got away with it because its schema never changed; the inbox, being a reusable standard, must.

## 3. Inter-canister call model

### 3.1 How one agent canister calls another's inbox

```rust
// Inside agent canister A, sending to inbox canister B (owner = some principal):
use ic_cdk::call::Call;

async fn inbox_send(
    inbox: Principal,
    body: MessageBody,
    kind: &str,
    r#ref: Option<&str>,
) -> Result<u64, String> {
    let arg = (body, kind.to_string(), r#ref.map(|s| s.to_string()));
    // update call — goes through consensus, certified, awaitable across subnets.
    // Cycles are attached to the call via with_cycles (the CALLER pays; §5).
    match Call::bounded_wait(inbox, "send_message")
        .with_arg(arg)
        .with_cycles(INBOX_SEND_CYCLES)        // e.g. 100_000_000 (0.1T)
        .change_timeout(30)                    // 30s; inbox writes are fast
        .await
    {
        Ok(r) => match r.candid::<Result<u64, SendError>>()? {
            Ok(id) => Ok(id),
            Err(SendError::InboxFull) => Err("INBOX_FULL".into()),
            Err(e) => Err(format!("SEND_ERR {:?}", e)),
        },
        Err(e) => Err(format!("SEND_CALL {:?}", e)),  // reject / timeout
    }
}
```

This mirrors the repo's existing pattern: `xfarm_extend_farmer` (`lib.rs` lines 19508–19516) does exactly this two-layer unwrap — first the inter-canister call's `Result<(Result<_,String>,), _>`, then the inner `Result`. The inbox returns a flat `variant { Ok; Err }` (Candid), so the inner unwrap is `r.candid::<Result<...>>()`.

### 3.2 Error handling and timeouts

- **Two error layers**, mirroring `xfarm_extend_farmer`: (1) the call itself can reject with `(RejectCode, String)` — trapped canister, wrong interface, out of cycles, timeout; (2) the inbox can return `Err(SendError)` — logical refusal (InboxFull, Unauthorized, TooLarge). The agent protocol treats (1) as transient (retry with backoff, log to its own inbox) and (2) as terminal (don't retry a `TooLarge` or `Unauthorized`).
- **Timeouts**: `Call::bounded_wait(...).change_timeout(30)` — same primitive the Farmer uses for the Gemini proxy outcall (`src/xfarm_farmer/src/lib.rs` line 383). 30s is generous for a stable write; the inbox does no outcalls, so there is no reason a `send_message` should take more than a second or two on a healthy subnet.
- **No automatic retry inside the inbox.** The inbox is a passive store; retries are the *caller's* responsibility. This keeps the inbox minimal and avoids hidden cycle spend — the same "no hidden timers that spend cycles" discipline the Farmer uses for its burn tick (which is explicit, line 494).

### 3.3 Cycle cost of a cross-canister send — who pays

The **caller pays**. This is ICP semantics, not a design choice: cycles attached to an inter-canister call are deducted from the caller and, for the part the callee consumes, credited to the callee. The inbox **accepts** those cycles to fund its own continued existence — "runs as long as it has cycles." Two mechanisms (§5): `ic0.accept_cycles` is implicit on every call (the callee keeps whatever the call carried net of the response), and `inspect_message` can front-door a minimum before the call body even runs.

## 4. Auth & ownership

### 4.1 Owning Principal vs canister controller — the crucial distinction

The IC has two separate authority concepts, and conflating them is the most common bug in factory patterns:

- **Controller** — the principal(s) that can `update_settings`, `install_code` (reinstall/upgrade), `stop_canister`, `delete_canister` for this canister. Set at `create_canister` time. The repo makes the **factory (the backend) the sole controller** of every Farmer: `controllers: Some(vec![get_canister_id()])` (`lib.rs` line 19439). The inbox does the same — the `CanisterInbox` factory is sole controller of every inbox.
- **Owner** — an application-level concept. The Principal that "owns" the inbox for read/rotate purposes. Stored in `InboxConfig.owner`. This is the agent's principal (the agent's *canister id*, or a self-authenticating II principal if a human owns it). The owner is **not** a controller by default — the owner cannot reinstall the inbox's code; only the factory can. This is intentional: it lets the platform push security upgrades to all inboxes (like the Farmer's `xfarm_upgrade_code`, `lib.rs` lines 19476–19484) without each owner opting in.

The deploying principal is recorded at `init` time from the init args the factory passes (exactly as the Farmer records `owner` and `backend_canister_id` from `FarmerInitArgs`, `src/xfarm_farmer/src/lib.rs` lines 267–289). It is verified on every read via a `caller == config.owner` check.

### 4.2 Who may send / read / rotate

Mirror the Farmer's `require_backend_or_owner` (lines 251–261) and the backend's `is_admin_principal` / `require_admin` (lines 807–9809):

- **send**: governed by `Policy`. `open_send = true` ⇒ any non-anonymous caller may send. `open_send = false` ⇒ caller must be in `allow_list`. Anonymous principal (`Principal::anonymous()`) is always rejected — at `inspect_message` first (line 234–240 shows the Farmer doing exactly this), then again in the guard. This is the same two-layer rejection the Farmer uses.
- **read (read_messages / get_thread)**: owner-only, plus the factory (backend) for relay/audit. Same `require_backend_or_owner` shape. A thread-participant counterparty does **not** get to read the owner's copy of the thread — they read their own inbox. (If two agents want a shared view, they each have their own inbox; the "thread" is a logical concept reconstructed from both. This avoids any shared-state concurrency problem.)
- **rotate ownership**: `admin_rotate_owner(new_owner)` — controller-only (factory), never the owner themselves (the owner can't self-rotate without the factory's blessing, mirroring how the Farmer's `extend` is `backend || controller` only, line 596). Useful for agent migration / key rotation.

### 4.3 Anti-spam: per-sender byte quota

`SENDER_QUOTA` (MemoryId 6) tracks bytes written per sender principal. `send_message` decrements the remaining quota and rejects with `QuotaExceeded(remaining)` when a message would exceed `per_sender_byte_cap`. This is the on-chain equivalent of a rate limit, and it is the main lever against a public-open inbox being flooded. The Farmer has no analog because the Farmer is single-tenant; the inbox is multi-tenant (many senders, one owner-reader).

## 5. Cycle funding — "runs as long as it has cycles"

### 5.1 Accepting cycles per interaction

Two layers, both standard IC primitives:

1. **`inspect_message` + `accept_message`** as a pre-flight minimum. The Farmer already does `ic_cdk::api::call::accept_message()` in its `inspect_message` (line 239) after the anonymous check. The inbox adds a **minimum-cycle check** before accepting: if `ic_cdk::api::call::msg_cycles_available128()` < `MIN_INBOUND_CYCLES` for a `send_message` call, reject at ingress (cheap — no stable write). This is net-new: the Farmer doesn't gate on inbound cycles because only the owner/backend call it; the inbox is open to the world.
2. **Implicit accept on update.** When an update call carries cycles, the callee automatically keeps the portion not spent on the response. The inbox calls `ic_cdk::api::call::accept_cycles128()` explicitly inside `send_message` to bookkeep `budget_cycles` (record only — the cycle *balance* is authoritative, exactly as the Farmer says for `budget_cycles` vs the real cycle balance, `src/xfarm_farmer/src/lib.rs` lines 93–95 and `src/backend/src/lib.rs` lines 19272–19274).

### 5.2 Cycle budgets, low-cycle warnings

- `get_status()` returns `cycles_remaining` via `ic_cdk::api::canister_cycle_balance()` (the Farmer's `self_cycles()`, lines 202–207). The number is honest by construction.
- **Low-cycle warning**: a daily timer (re-armed in `post_upgrade`) checks the balance; below `LOW_CYCLE_WARN` (e.g. 200B) it writes a system `Message` of `kind="notify"` into its own inbox (from = self) so the owner's UI surfaces "your inbox is low." This is net-new and mirrors the Farmer's `report_depleted` callback (line 509) — except here the inbox notifies itself rather than calling back to the factory.
- **Freezing**: when cycles hit the freezing threshold, the canister stops responding to updates (IC-level). `get_status().frozen` reflects `ic_cdk::api::canister_status()` (net-new use of the canister_status API; the repo currently only reads the *frontend's* status this way, `lib.rs` lines 3636–3649). The inbox never auto-deletes on depletion — unlike the Farmer (which the factory reaps, line 19498), an inbox is *persistent storage* and deletion would destroy messages. Topping up is the only correct response.

### 5.3 Topping up

- The factory deposits cycles via the management canister's `deposit_cycles`, exactly like `deposit_cycles_to` (`lib.rs` lines 3662–3676) — `call_with_payment128(Principal::management_canister(), "deposit_cycles", (CanisterIdRecord{...},), cycles)`.
- The owner can top up directly via their II-controlled cycles wallet (the standard "cycles wallet" model), or via the factory's `admin_topup_inbox(inbox_id, cycles)` (controller-only).
- `extend(add_cycles_e8s_record)` mirrors the Farmer's `extend` (lines 592–608): the factory deposits cycles *first*, then calls `extend`, which only bumps the bookkeeping `budget_cycles` and re-arms the warning timer.

## 6. Factory pattern (the X-Farm precedent)

The CanisterInbox factory is a set of endpoints and stable maps living **inside the existing backend canister** (`src/backend/src/lib.rs`), exactly as the X-Farm factory does (the X-Farm factory is not a separate canister — it is a section of the backend that calls `Principal::management_canister()`). The inbox *wasm* is a new sibling crate at `src/canister_inbox/`, parallel to `src/xfarm_farmer/`.

### 6.1 Factory primitives (reuse, with substitutions)

The repo already has every management-canister primitive needed; we reuse them verbatim with rename:

| X-Farm primitive (`lib.rs`) | Inbox equivalent | Reuse? |
|---|---|---|
| `xfarm_create_canister` (19434) + `CreateCanisterArgs` (19347) | `inbox_create_canister` | **reuse pattern** (net-new fn, same shape) |
| `xfarm_install_code` (19462) + `InstallCodeArgs` (19357) + `XFarmInstallMode` (19355) | `inbox_install_code` | **reuse pattern** |
| `xfarm_upgrade_code` (19476) | `inbox_upgrade_code` | **reuse pattern** |
| `xfarm_stop_canister` / `xfarm_delete_canister` (19488–19502) | `inbox_stop_canister` / `inbox_delete_canister` | **reuse pattern** (but see §5.2 — inbox is NOT auto-deleted) |
| `deposit_cycles_to` (3662) | `inbox_deposit_cycles` | **reuse directly** |
| `xfarm_extend_farmer` two-layer unwrap (19508) | `inbox_extend_inbox` | **reuse pattern** |

The settings struct (`XFarmCanisterSettings`, line 19341) is reused as-is: `controllers: Some(vec![get_canister_id()])` makes the factory sole controller; `freezing_threshold: Some(0)` so the inbox can use 100% of its cycles for storage (we may set a non-zero freezing threshold for the inbox to protect against sudden freeze — a **deliberate divergence** from the Farmer, justified because inbox durability matters more than Farmer's 7-day depletion model).

### 6.2 Factory stable storage (backend MemoryIds)

The backend's used MemoryIds run 0–26, 34–56 (x-farm 54–56), 60–72, 74–75, 77–103. The **free contiguous ranges** are 27–33, 57–59, 73, 76. We allocate the inbox factory registry from **27–31** (the largest free block, 7 ids, leaving 32–33 free for future):

| MemoryId | Name | Purpose |
|---|---|---|
| 27 | `INBOXES` | `StableBTreeMap<u64, InboxRecord, Memory>` — the registry |
| 28 | `INBOX_NEXT_ID` | `StableCell<u64>` init 1 |
| 29 | `INBOX_FACTORY_CONFIG` | `StableCell<InboxFactoryConfig>` (default Policy template, max_inboxes, wasm hash) |
| 30 | reserved | forward-compat (e.g. per-owner inbox index) |
| 31 | reserved | forward-compat |

```rust
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct InboxRecord {
    pub id: u64,
    pub owner: Principal,
    pub canister_id: Option<Principal>,   // None under dev-seed mock; Some for real
    pub created_at: u64,
    pub status: InboxStatus,              // Active | Frozen | Disabled
    #[serde(default)]
    pub budget_cycles: u64,
    #[serde(default)]
    pub install_done: bool,
    #[serde(default)]
    pub last_topup_at: u64,
}
```

The `Farmer` struct (lines 19261–19289) is the template — same `Option<Principal>` for canister_id to support the dev-seed mock path (so the local UI works with no real canister, mirroring `XFARM_MOCK_DRAFTS` at line 19381), same `install_done` flag.

### 6.3 Factory endpoints (net-new)

```candid
// Factory: create_inbox(owner, kind) -> (InboxQuote)            // free quote, 15-min locked (like XFarmQuote)
// Factory: claim_inbox(quote_id, payment_block) -> (u64 inbox_id) update  // escrow settle → create → install → topup
// Factory: get_my_inboxes() -> vec InboxRecord query            // owner's registry rows
// Factory: admin_topup_inbox(inbox_id, cycles) -> () update     // controller-only
// Factory: admin_reinstall_inbox(inbox_id) -> () update         // controller-only; uses inbox_upgrade_code with mode=reinstall
// Factory: admin_set_inbox_policy(inbox_id, Policy) -> () update
// Factory: admin_delete_inbox(inbox_id) -> () update            // controller-only; stop+delete (DANGEROUS — admin only)
// Factory: get_inbox_status(inbox_id) -> InboxStatusInfo query   // relay to inbox.get_status
```

The money path reuses the existing escrow/settle machinery: the inbox creation fee (e.g. 0.5 ICP → cycles + treasury split) goes through the same `derive_*_subaccount` + `call_ledger_transfer` + `call_cmc_topup_transfer` + `notify_cmc_topup` legs the X-Farm uses (lib.rs lines 2130/2279/2366). A new `derive_inbox_subaccount(owner)` is added next to `derive_xfarm_subaccount` (line 19422). The 90%→CMC burn + 10%→treasury split is the **same money path** (`settle_burn_split`), cited in the repo's own duplication review (line 19176).

## 7. Upgrade safety

### 7.1 Snapshots before upgrade

The repo's mainnet-deploy memory note records that canister snapshots must be taken while the canister is **stopped** (`deploy-prod.sh` is stale partly because it never stops the canister before snapshotting). For the inbox, the factory's `admin_reinstall_inbox` and `admin_upgrade_inbox` MUST follow the safe sequence:

1. `inbox_stop_canister(canister_id)` (reuse `xfarm_stop_canister` pattern, line 19488).
2. Take a canister snapshot via the management canister's `canister_snapshot_take` (net-new use; the repo has not called this API yet — flag as net-new).
3. `inbox_install_code` with `mode = upgrade` (line 19476 pattern) — **upgrade, not reinstall**, to preserve stable memory.
4. `inbox_start_canister` (net-new; mirror of stop).
5. If post-upgrade smoke fails, `canister_snapshot_restore` (net-new) and start.

The Farmer's `post_upgrade` only re-arms the timer (line 291–295) because stable structures auto-restore. The inbox's `post_upgrade` additionally runs the `schema_version` migration (§2.3).

### 7.2 Reinstall equivalent for child canisters

The Farmer ships an `admin_reinstall_all_farmers` (referenced in the memory's X-Farm localization note as the vehicle for schema changes). The inbox factory gets `admin_reinstall_inbox(inbox_id)` which calls `inbox_install_code` with `mode = reinstall` — **this wipes stable memory** and is the "reset a broken inbox" escape hatch. It is controller-only and gated behind a `confirm = true` arg to prevent foot-guns. Net-new.

## 8. Open-standard ambition

### 8.1 Versioned interface

The `.did` in §1.1 carries an implicit `INTERFACE_VERSION = 1`. The factory records `schema_version` per inbox. The interface is published as `canister_inbox.did` at the repo root and (Phase-2) to a community Candid interface registry. Third parties adopt it by installing their own inbox wasm that implements the same three-method surface — the factory does not need to be the same one.

### 8.2 Naming / namespace

- Method names are namespaced and prefixed (`send_message`, `read_messages`, `get_thread`) so they don't collide with any host canister's methods if an agent embeds the inbox interface as a trait.
- `kind` is a free-form string with reserved prefixes (`notify.`, `task.`, `ack.`, `sys.`) owned by the standard; vendor kinds should be prefixed (`com.example.foo`). This mirrors how the repo uses free-form string kinds for feature flags and proposal categories without central registration.
- The standard does NOT prescribe `MessageBody.mime_type` values beyond requiring the inbox to enforce `MAX_MESSAGE_BYTES`; `text/plain` and `application/json` are the recommended defaults.

### 8.3 Third-party deployment

A third party deploys their own inbox instance by either: (a) deploying the `canister_inbox` wasm directly via their own cycles wallet and setting themselves as owner + their own controller, or (b) deploying their own factory that calls the same management-canister primitives. The interface contract is the same either way. This is the same open-deployment model the X-Farm spec envisions for Farmer wasms owned by other projects (§"open-sourced" in the README).

## 9. Red-team — where the idea's framing collides with platform reality

This section is mandatory because the idea's marketing framing ("no company can read your messages") is materially misleading about ICP. Concrete collisions:

1. **On-chain state is PUBLIC.** Every byte written to `MESSAGES` is replicated across the subnet and readable by anyone who reads the subnet state (read_state / read_state_certified, or by running a replica). The inbox's access control (`require_backend_or_owner` on reads) gates the *canister's query/update endpoints*, not the *state itself*. A determined reader can reconstruct every message. **Mitigation**: store only envelopes on-chain; encrypt the `MessageBody.bytes` with a key the owner controls (vetKeys for at-rest key storage — the repo's AI Proposal Review idea already identifies vetKeys + SEV-SNP as the path for on-chain secrets, see MEMORY.md). The inbox standard should mandate `mime_type = "application/vnd.encrypted"` semantics and treat `bytes` as opaque ciphertext; the standard does not need to prescribe the encryption scheme. This is the single most important honesty fix.
2. **"Owned by the Principal that deployed it" is correct but the deployer is not necessarily the controller.** As §4.1 establishes, the factory is the controller. If a third party deploys via the factory, they own the inbox (read/rotate) but cannot upgrade its code. The standard must document this split explicitly or third parties will believe they have more control than they do.
3. **Cross-canister query calls are uncertified (§1.2).** An agent acting on a `read_messages` query result is acting on a single replica's word. The standard must require certified `update` reads (`get_thread_certified`) for any agent decision path. This is the same trust boundary the repo already respects (queries for the owner UI, updates for state-changing inter-canister calls).
4. **Cycle-funded ≠ free.** "Agents pay per interaction in cycles" is accurate, but the inbox's *continued existence* costs cycles (storage + the freezing threshold). An inbox with no traffic still slowly drains. The UI must surface this (the low-cycle warning, §5.2) or owners will be surprised by frozen inboxes.
5. **`accept_cycles` is implicit but the minimum-cycle check in `inspect_message` is the only real spam brake.** Without it, an attacker can flood a public-open inbox with messages, each carrying zero cycles, and the inbox owner pays for the storage. The per-sender byte quota (§4.3) is the second brake. Both are required, not optional.
6. **No company can revoke access — true, but the factory can.** The factory (controller) can `delete_canister`. If the factory is run by a company, that company *can* revoke access by deletion. The honest framing is "no company can read or front-door your inbox; the factory operator can delete it (and you should run your own factory if that matters)." Document this.

## 10. Implementation task breakdown

Tasks are grouped; each names the file, the stable-memory name/MemoryId, and whether it is **net-new** or **reuse**. Backend MemoryIds 27–31 (free, §6.2) are used; the inbox canister's own MemoryIds 0–7 (§2) are a separate namespace.

### Phase 0 — Inbox canister wasm (`src/canister_inbox/`)

- **T1** [net-new] Create crate `src/canister_inbox/` mirroring `src/xfarm_farmer/` (`Cargo.toml` with `candid/ic-cdk/ic-cdk-timers/ic-stable-structures/serde/ciborium/sha2`, `crate-type = ["cdylib","rlib"]`). Copy the `impl_storable!` macro verbatim.
- **T2** [net-new] `canister_inbox.did` per §1.1 + auxiliary methods §1.3.
- **T3** [net-new] Stable storage thread-local block (MESSAGES 0, NEXT_MESSAGE_ID 1, THREADS 2, NEXT_THREAD_ID 3, INBOX_CONFIG 4, THREAD_INDEX 5, SENDER_QUOTA 6, reserved 7) + `placeholder_config()`, mirroring Farmer lines 149–188.
- **T4** [net-new] `Message`, `MessageBody`, `InboxConfig`, `Policy`, `Thread` structs with `#[serde(default)]` on v1+ fields and `schema_version`.
- **T5** [net-new] `inspect_message` guard: reject anonymous + enforce `MIN_INBOUND_CYCLES` for `send_message` (reuse Farmer's `inspect_message`, lines 234–240, add cycle gate).
- **T6** [net-new] `send_message` update: validate caps (TooLarge/InboxFull/QuotaExceeded), accept cycles, write MESSAGES + THREAD_INDEX + THREADS, update SENDER_QUOTA and INBOX_CONFIG.bytes_used.
- **T7** [net-new] `read_messages` / `get_thread` queries (owner-only via `require_backend_or_owner`, reuse Farmer lines 251–261).
- **T8** [net-new] `get_thread_certified` update (certified read for agent decision paths, §1.2).
- **T9** [net-new] `mark_read` update (owner-only certified "read" flag).
- **T10** [net-new] `get_status` / `get_my_inbox` queries (reuse Farmer `get_status`/`get_my_config`, lines 573–585).
- **T11** [net-new] `extend` update (controller-only; reuse Farmer `extend`, lines 592–608).
- **T12** [net-new] Daily low-cycle warning timer + `post_upgrade` re-arm (reuse `arm_timers`, lines 297–306) + `schema_version` migration runner.
- **T13** [net-new] `admin_set_policy` / `admin_rotate_owner` updates (controller-only).
- **T14** [net-new] `#[cfg(test)] mod tests`: cap enforcement, quota, retention/pruning (reuse Farmer's `test_draft_pruning_retention_and_cap`, lines 661–705), serde round-trip with a v2 struct over a v1 encoding (forward-compat proof), `inspect_message` cycle gate.

### Phase 1 — Factory in backend (`src/backend/src/lib.rs`)

- **T15** [net-new] Backend MemoryIds 27–31: `INBOXES` (27), `INBOX_NEXT_ID` (28), `INBOX_FACTORY_CONFIG` (29), reserved 30/31. Add to the `MEMORY_MANAGER` block.
- **T16** [net-new] `InboxRecord`, `InboxFactoryConfig`, `InboxStatus` structs (template: `Farmer`, lines 19261–19289). `impl_storable!` for each.
- **T17** [reuse pattern] `inbox_create_canister` / `inbox_install_code` / `inbox_upgrade_code` / `inbox_stop_canister` / `inbox_delete_canister` / `inbox_start_canister` — rename + thin adapt of the `xfarm_*` fns (lines 19434–19502). `canister_snapshot_take` / `canister_snapshot_restore` are **net-new** management-canister calls.
- **T18** [reuse pattern] `inbox_extend_inbox` two-layer unwrap (template `xfarm_extend_farmer`, lines 19508–19516).
- **T19** [reuse directly] `derive_inbox_subaccount(owner)` next to `derive_xfarm_subaccount` (line 19422).
- **T20** [net-new] `quote_inbox` / `claim_inbox` (escrow → `settle_burn_split` money path → `inbox_create_canister` → `inbox_install_code` → `deposit_cycles_to`). Reuse `settle_burn_split` + `call_cmc_topup_transfer` + `notify_cmc_topup` (lines 2130/2279/2366) verbatim — the money path is explicitly called out as reusable in the repo's own duplication-review note (line 19176).
- **T21** [net-new] `get_my_inboxes` / `admin_topup_inbox` / `admin_reinstall_inbox` / `admin_upgrade_inbox` / `admin_set_inbox_policy` / `admin_delete_inbox` / `get_inbox_status` endpoints (all `guard = "require_admin"` or owner-checked, mirroring the `#[ic_cdk::update(guard = "require_admin")]` pattern at e.g. lines 1203+).
- **T22** [net-new] Feature flag `FLAG_CANISTER_INBOX = "canister_inbox"`; add to `KNOWN_FEATURE_FLAGS` (line 5188), default OFF in `feature_default` (line 5461 area). Ship dark, like `x_farm` and `discussions`.
- **T23** [net-new] Heap-only `INBOX_WASM` / `INBOX_WASM_HASH` (admin-upload, lost on upgrade) — template `XFARM_WASM` (line 19375).
- **T24** [net-new] Backend `InboxQuote` (15-min locked, per-caller) — template `XFARM_QUOTES` (line 19378).
- **T25** [net-new] Update `src/backend/backend.did` with all new factory types/endpoints; regenerate frontend candid bindings.

### Phase 2 — Cycle Burn integration

- **T26** [net-new] Governance agent hook: in the AI Proposal Review / Proposal Discussions paths, after a verdict/comment is produced, call `inbox_send(governance_inbox_id, notify_body, "notify.proposal_review", Some(proposal_id))`. The governance inbox is one shared inbox owned by the backend (factory creates it on init), readable by admins in the UI.
- **T27** [net-new] Lottery agent hook: after `execute_draw` (lib.rs ~9800 area) produces a winner, call `inbox_send` to the winner's inbox (if they have one) with `kind="notify.lottery_win"`, `ref=draw_id`. Reuse `record_payout` as the insertion point.
- **T28** [net-new] Staking agent hook: on `void_current_round_tickets` (line 9816) for admin promotions, notify the affected user's inbox (`kind="notify.tickets_voided"`).
- **T29** [net-new] "You have a message" surface in the frontend: a `InboxBadge`/`InboxPanel` component polling `get_my_inboxes` + each inbox's `get_status` + a `unread_count` query (net-new — add `get_unread_counts` query to the inbox returning `vec (thread_id, nat32)`). Wire into the existing nav (the `LotteryHub`/`Dashboard` area).
- **T30** [net-new] Owner-side `create_inbox` UX in the frontend (quote → pay → claim), mirroring `XFarm.tsx`'s persona wizard + pay flow.
- **T31** [net-new] Snapshot-before-upgrade discipline in `scripts/deploy-local.sh` / a new `scripts/deploy-inbox.sh` following the safe sequence (stop → snapshot → upgrade → start → smoke), explicitly fixing the stale-snapshot bug noted in MEMORY.md for the inbox path so we don't repeat it.

### Net-new vs reuse summary

- **Reuse directly** (no new code): the money path (`settle_burn_split`, `call_cmc_topup_transfer`, `notify_cmc_topup`), `deposit_cycles_to`, `derive_*_subaccount` family, `impl_storable!`, `MEMORY_MANAGER`, the feature-flag system (`KNOWN_FEATURE_FLAGS`/`feature_visible`/`admin_set_feature_flag`), `require_admin`/`is_admin_principal`, the `XFarmCanisterSettings`/`CreateCanisterArgs`/`InstallCodeArgs`/`CanisterIdRecord` structs.
- **Reuse pattern** (net-new fns of the same shape): all `inbox_*` management-canister wrappers, `inbox_extend_inbox`, `InboxRecord`, `InboxQuote`, the inbox canister's guard/queries/extends (close copies of Farmer equivalents).
- **Genuinely net-new**: the three-method interface itself, the inbox stable layout, `THREAD_INDEX` composite key, per-sender quota, `inspect_message` cycle gate, `get_thread_certified`, `canister_snapshot_take`/`canister_snapshot_restore` calls, the low-cycle self-notify timer, `schema_version` migrations, the Cycle Burn agent hooks, the frontend InboxPanel.

## 11. MemoryId coordination (collision avoidance)

Backend MemoryIds in use (grepped from `lib.rs`): 0–26, 34–56 (54–56 X-Farm), 60–72, 74–75, 77–103. Free: 27–33, 57–59, 73, 76. This build allocates **27–31** to the inbox factory and leaves 32–33, 57–59, 73, 76 free for the next feature (the ii-purchase and neuron-sale ideas both want MemoryIds in the 90s range per MEMORY.md — those are taken; coordinate before either builds). The inbox canister's own MemoryIds (0–7, §2) live in a separate `MemoryManager` namespace inside the inbox wasm and do NOT collide with the backend's, exactly as the Farmer's 0/1/2 don't collide (confirmed: `src/xfarm_farmer/src/lib.rs` uses MemoryId::new(0..2) while the backend uses 0..103 with no overlap because they are different wasms).

---

**Bottom line**: the inbox is a Farmer-shaped per-agent canister with a passive three-method surface (one update mutator, two certified-capable reads), cycle-funded at the call boundary, factory-spawned and factory-controlled by reusing the X-Farm factory primitives and the existing escrow/CMC money path verbatim. The one framing the idea gets wrong is privacy: on-chain inbox state is public to subnet readers, so the standard must treat `MessageBody.bytes` as opaque ciphertext by default (vetKeys-at-rest), and the agent protocol must use certified `update` reads — never raw queries — for any decision path. Everything else is a direct reuse or a close copy of patterns already proven in this repo.