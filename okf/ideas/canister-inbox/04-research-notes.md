---
type: idea
title: "04 — Research Notes: ICP Platform Grounding for Canister Inbox"
tags: [ideas, canister-inbox]
timestamp: 2026-06-28T11:58:57-04:00
---

# 04 — Research Notes: ICP Platform Grounding for Canister Inbox

> Date: 2026-06-28. Scope: ground the Canister Inbox spec in real Internet Computer APIs and
> limits, and flag every place the idea's framing collides with platform reality. Citations
> are to ICP interface docs / canister SDK behaviour and to this repo's working code. Anything
> I could not confirm from a primary source is marked **VERIFY**.

The single load-bearing red-team point, stated up front and revisited throughout: **the
idea's "no company can read your messages" is true in the narrow sense that no SaaS middleman
gatekeeps the inbox, but it is FALSE that "no one can read on-chain state."** On the IC, a
canister's state lives replicated across every node of its subnet; node operators can read
raw memory, and any public `query` method the canister exposes returns its data to any caller.
Without vetKeys encryption the inbox is plain-text on-chain. This is the central design
constraint and it shapes most of the sections below.

---

## 1. Stable memory — where messages must live

**The repo already uses the right primitive.** `src/backend/src/lib.rs:4` imports
`ic_stable_structures::{StableCell, StableBTreeMap, MemoryManager, MemoryId, …}`, and the
whole data model is partitioned across `MemoryId`s (`lib.rs:701,705,709,…`). The X-Farm
Farmer child canister mirrors this exactly: `src/xfarm_farmer/src/lib.rs:37-40` and the
`DRAFTS` map at line 154 (`MemoryId::new(0)`) plus `NEXT_DRAFT_ID` / `CONFIG` cells. This is
the template Canister Inbox copies.

**Limits (from [DFINITY docs](https://docs.internetcomputer.org/languages/rust/stable-structures/) and the [Sept 2025 forum clarification](https://forum.dfinity.org/t/clarification-on-stable-memory-limits-64-gib-base-region-vs-500-gib-canister-resource-limits/57861)):**
- Wasm *heap* (wasm32): 4 GiB. Heap does **not** survive upgrade without explicit
  `pre_upgrade`/`post_upgrade` serialisation. This is why messages must NOT live in a heap
  `BTreeMap` — they would be lost on every upgrade (or risk the ~2 GiB instruction-limit
  serialisation trap that `ic-stable-structures` was designed to avoid).
- **Stable memory: growable to 500 GiB** via the 64-bit-addressed system API
  (`stable64_grow` / `stable64_read` / `stable64_write`), exposed in Rust through the
  `StableMemory` trait ([docs.rs/ic-cdk](https://docs.rs/ic-cdk/latest/ic_cdk/stable/trait.StableMemory.html)).
  Page size is 64 KiB. The older "64 GiB" figure is outdated.
- A Nov 2025 change means growth *beyond* a canister's `memory_allocation` is now
  **best-effort** (subject to subnet free memory + freezing threshold) rather than
  auto-rejected ([forum](https://forum.dfinity.org/t/canister-memory-allocation-does-not-limit-canister-memory-usage/59993)). Storage cost is `max(memory_allocation, memory_usage)`.
- Subnet total capacity: ~2 TiB shared across all canisters on the subnet.

**Practical message-count math at ~2 KiB/message** (Candid-encoded `Message` with a
~256-byte body, sender principal, thread id, timestamps, nonce):
- 1 GiB of stable memory ≈ 524,288 messages.
- 500 GiB ceiling ≈ ~268 M messages per inbox canister — effectively unbounded for an
  agent-inbox workload, which is point-to-point and low-volume. The real ceiling is the
  **cost of storing that state**: stable-memory storage is charged per byte per second
  ([cycle-costs](https://docs.internetcomputer.org/references/cycle-costs/)). A 1 GiB inbox
  costs on the order of ~5–10 XDR/year in storage alone **VERIFY exact rate**; this is the
  honest "no subscription, but you pay cycles" line item the spec must surface.

**Design consequence (confirm in spec):** messages MUST be in `StableBTreeMap` /
`StableCell` (stable memory), never heap. The repo already does this everywhere — reuse the
`MemoryManager` + `MemoryId` partition pattern verbatim. Net-new only: pick `MemoryId`s
that do not collide with the backend's in-use IDs (0-18, 26, 53-58 are taken; see
`lib.rs:701` onwards and `xfarm_farmer` using 0-2). The inbox canister is its own wasm so ID
collisions with the *backend* are not a concern, but if a factory-style inbox ever merges
back into the backend, reserve IDs.

---

## 2. Inter-canister calls — the three-method interface constrained

The spec proposes three methods: `send`, `read`, `retrieve_thread`. Platform call semantics
force a specific shape, and this is where the idea's "agents just call the canister" needs
the most correction.

**Call types and what can be awaited ([IC interface spec](https://docs.internetcomputer.org/references/ic-interface-spec/), [inter-canister calls guide](https://docs.internetcomputer.org/guides/canister-calls/inter-canister-calls/)):**
- **Update methods**: replicated, state-mutating, can `await` calls to *any* canister on
  *any* subnet. ~2 s consensus latency. This is the only call type that can reliably carry a
  cross-canister reply back to the caller.
- **Query methods**: single-replica, read-only, ~200 ms, free, **cannot make any
  inter-canister calls**. Result is node-signed (not subnet-certified).
- **Composite query** (`#[query(composite = true)]` in Rust): can call query/composite-query
  methods of canisters **on the same subnet only**. Cannot cross subnets, cannot call
  updates, cannot be invoked from inside an update.

**Direct implication for the three-method interface:**
- **`send` MUST be an `#[update]`.** It mutates state (appends a message) and must be
  awaitable by the sending agent's canister. The repo's `call_ledger_transfer`
  (`lib.rs:2130`) and `xfarm_extend_farmer` (`lib.rs:19509`) are the working patterns: an
  update that does `ic_cdk::call::<(Args,),(Result,)...>(target, "method", (args,)).await`.
  `send` is no different — it's an update on the inbox canister that the sender awaits.
- **`read` cannot be a plain `#[query]` if agents (other canisters) need to call it.** A
  plain query can be called by an agent only via composite-query (same-subnet) or by
  invoking it as an update (which makes it replicated + chargeable). For cross-subnet agent
  reads you have two real choices:
  1. Make `read` an `#[update]` that returns a `Result<Vec<Message>, …>` — works cross-subnet,
     awaitable, but ~2 s and costs cycles every poll. Honest but heavy.
  2. Make `read` a `#[query(composite = true)]` — fast and free, but only callable by agents
     **on the same subnet**. Fine if the factory pins all inboxes + agents to one subnet;
     useless for an open standard.
  The repo's analog is `get_xfarm_info` / `get_drafts` (`xfarm_farmer.did`: `get_drafts … query`) —
  those are designed to be called by the *backend owner UI*, not by other canisters. For an
  agent-inbox the read path is genuinely harder; the spec should default `read` to an
  **update** for cross-canister use and expose a separate query only for the human control
  plane (UI on the same principal). **Net-new decision; flag in spec.**
- **`retrieve_thread`** — same logic as `read`, scoped to one thread id. Update for agents;
  composite-query or plain query only for same-subnet / UI consumers.

**Cross-subnet latency:** every agent→inbox `send` from a different subnet pays the
inter-subnet round trip. The repo tolerates this for the CMC leg
(`notify_cmc_topup`, `lib.rs:2377`) and ledger transfers (`lib.rs:2146`), both of which are
cross-canister updates that `await`. Latency budget: ~2 s per hop, plus the agent's own
consensus. An agent that polls an inbox every tick will burn cycles on every poll — see §4.

**Call+await pattern in Rust (the exact shape to reuse, from `lib.rs:19509`):**
```rust
let res: Result<(Result<(), String>,), _> =
    ic_cdk::call(cid, "extend", (add_budget, add_days)).await;
match res {
    Ok((Ok(()),)) => Ok(()),
    Ok((Err(e),)) => Err(format!("EXTEND_FAILED: {}", e)),
    Err((c, m)) => Err(format!("EXTEND_CALL ({:?}): {}", c, m)),
}
```
This double-`Result` (outer = call reject, inner = business-logic Err) is the idiomatic
shape and the spec's `send`/`read` should mirror it. **Reuse, not net-new.**

---

## 3. Management canister — factory lifecycle, real costs

The repo already implements the full factory lifecycle for X-Farm Farmers. This is the
closest existing analog and the spec should largely clone it.

**Real Candid signatures (from [IC management canister docs](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/)) the repo already calls:**
- `create_canister : (record { settings : opt canister_settings }) -> (record { canister_id : principal })` — `lib.rs:19435-19452`. Repo passes `controllers: Some(vec![get_canister_id()])` so the **factory is the sole controller** of every child. This is the pattern Canister Inbox should follow: the factory (not the agent owner) controls inbox lifecycle, which lets the factory `stop_canister`/`delete_canister` orphans.
- `install_code : (record { mode; canister_id; wasm_module: vec nat8; arg: vec nat8 }) -> ()` — `lib.rs:19463-19467`. `mode` is `install | reinstall | upgrade`. Init args are passed in `arg` (Candid-encoded `InboxInitArgs`).
- `update_settings : (record { canister_id; settings: canister_settings }) -> ()` — to change controllers. Not yet used in the repo but is the only way to transfer "ownership" of an inbox (see §5).
- `canister_status : (record { canister_id }) -> (record { status; settings; cycles; … })` — `lib.rs:3637-3649` (subset-decoded to read just `cycles`). Returns `cycles: nat`, `status` (`running|stopping|stopped`), module hash, controllers, memory metrics.
- `stop_canister` / `delete_canister` — `lib.rs:19489-19502`. **Order matters:** `delete_canister` requires the canister be `stopped` first, and the caller must be a controller. The repo's deploy-prod snapshot note (MEMORY) confirms a related gotcha: a stopped canister does not auto-start, and `install_code` on a stopped canister fails — you must `start_canister` after a snapshot/deploy.
- `deposit_cycles : (record { canister_id }) -> ()` — cycles attached to the call via `call_with_payment128`; `lib.rs:3662-3672`. This is how the factory funds an inbox's cycle balance post-create.

**Real provisioning cost ([cycle-costs](https://docs.internetcomputer.org/references/cycle-costs/)):**
- `create_canister` charges the **newly created canister** a fee of **500,000,000,000 cycles (500 B)** on a 13-node application subnet — ≈ 0.5 XDR ≈ **~$0.71 USD** at 1 XDR ≈ $1.37. On a 34-node fiduciary subnet it scales to ~1.308 T cycles (~$1.79).
- This 500 B is *deducted from the cycles attached to the `create_canister` call*; the remainder becomes the new canister's initial balance. The repo encodes this exactly: `XFARM_CREATION_CYCLES = 1.5T` (`lib.rs:19198`) and the comment at 19195-19198 explains "500B is the creation FEE (deducted on create); the remainder is the new Farmer's initial balance." **Reuse this constant and comment.**
- `install_code` is a separate, smaller charge per instruction executed during init.
- 1 trillion cycles = 1 XDR ≈ $1.37. So "cycle-funded, no subscription" means the deployer fronts ~$0.71 + initial operating cycles per inbox. It is NOT free; it is just *not a SaaS middleman*. The spec's copy must say "you pay cycles, which you buy with ICP" — not "free."

**Local dev path:** the repo gates `create_canister`/`install_code` behind `#[cfg(target_arch = "wasm32")]` and provides host mocks (`lib.rs:19454-19460`) returning a fixed self-authenticating principal. For local inbox testing, use `provisional_create_canister_with_cycles` (dev-only; can mint arbitrary cycles) **VERIFY whether the repo's local `dfx` flow already exposes this** — the X-Farm path sidesteps it via `dev_seed_farmer` with `canister_id: None` (`lib.rs:19265`), which is the simpler seam.

---

## 4. Cycles — how an inbox actually funds itself

**How a canister accepts cycles:**
- Cycles are attached to an inter-canister *call* via `ic_cdk::api::call::call_with_payment128(principal, method, args, cycles)` — the repo uses this for `create_canister` (`lib.rs:19448`) and `deposit_cycles` (`lib.rs:3664`).
- A canister receives cycles sent with a call via `ic0.canister_cycle_accept` (system API) — the `ic_cdk` equivalent is `ic_cdk::api::call::accept_cycles` / `msg_cycles_accept`. The repo does not currently call this explicitly because it relies on the management canister's implicit crediting for `create_canister`/`deposit_cycles`; an inbox that wants to *charge per `send`* must call it explicitly. **Net-new.**
- `inspect_message` (`lib.rs:762-775`) runs *before* an ingress update is admitted and can gate by `ic_cdk::api::call::method_name()` and caller. The repo already uses it to reject anonymous ingress. Canister Inbox can extend this to reject `send` calls that attach fewer than a minimum cycle amount — **VERIFY** whether `inspect_message` can read the attached cycle amount (the system API exposes `ic0.call_cycles_refunded` / `ic0.call_cycles_available` to a canister; **VERIFY** these are inspect-visible). If not, the gate must live inside the `send` update body, which is slightly less cheap but correct.

**Per-interaction cost (honest numbers from [cycle-costs](https://docs.internetcomputer.org/references/cycle-costs/)):**
- An update call has a fixed per-call overhead (replication + instructions). Roughly: a no-op cross-canister update round trip is on the order of **a few hundred million to ~1 B cycles** depending on payload size and instruction count **VERIFY the exact base fee** — call it ~$0.001–0.002 per `send` at the high end. That is the floor cost an agent pays per message. A `read` update of similar size is comparable.
- A stable-memory write is charged per byte written (the storage line item), separate from execution.
- Cross-subnet calls add a small per-message routing cost on top.

**What "cycle-funded, no subscription" really costs an agent in ICP:** if an agent sends one
message per minute, that's ~1,440 updates/day ≈ ~1.4 T cycles/day ≈ ~1.4 XDR ≈ ~$2/day at the
pessimistic end, **VERIFY with a real benchmark**. At one message per hour it's ~$0.08/day.
The honest framing for the spec: *the inbox runs as long as it has cycles, but cycles are
bought with ICP, so there is a real per-message cost — it is just paid to the subnet (burned
to node operators), not to a SaaS company.* That is the actual differentiator and it should be
the headline, not "no cost."

**`cycle_refundable`:** when a `send` rejects (e.g., inbox full, sender not authorised), the
cycles attached to the call are refunded to the caller by the system
(`ic0.call_cycles_refunded`). The inbox design should rely on this so a failed `send` does
not drain the agent. **VERIFY** the repo uses this implicitly; nothing in `lib.rs` touches
refund accounting explicitly, suggesting it's left to the system default, which is fine.

---

## 5. Controllers vs. owning Principal — making "owner" irrefutable

This is a platform subtlety the idea glosses over and the spec must nail down.

- A canister's **controller** (set via `create_canister`/`update_settings`) is the *only*
  principal that can `install_code`, `update_settings`, `stop`/`delete` it, or read private
  metadata. The controller is a platform concept enforced by the management canister.
- An **"owner principal"** is a *contract-level* concept the canister code defines. The IC
  has no built-in notion of canister ownership beyond controllership. The X-Farm Farmer
  encodes `owner: Principal` in `FarmerInitArgs` (`lib.rs:19324-19337`) and persists it in
  `FarmerConfig` — but the *controller* of every Farmer is the backend factory
  (`lib.rs:19439: controllers: Some(vec![get_canister_id()])`). The owner is a recorded
  field; the factory holds the platform power. **This is exactly the split Canister Inbox wants.**

**Making the owner irrefutable (the pattern to reuse):**
1. At `create_canister` time, record `owner: Principal` in `InboxInitArgs` passed to
   `install_code` (mirrors `FarmerInitArgs.owner`). The owner is captured once, in the
   install arg, signed into the canister's birth state.
2. In every mutating method, verify `ic_cdk::api::caller() == owner` (or a delegated
   authorised-senders set) before acting. The repo's `require_admin`
   (`lib.rs:830-840`) and `feature_visible`/`is_admin_principal` (`lib.rs:5514`) are the
   pattern; Canister Inbox replaces "admin list" with "owner + authorised agent set."
3. `inspect_message` (`lib.rs:762`) can reject unauthorised *ingress* callers before
   admission, but **note the comment at `lib.rs:761`: inspect_message only fires for direct
   ingress, not inter-canister calls.** So an agent canister calling `send` is NOT screened
   by `inspect_message` — the auth check must live inside the `send` update body via
   `ic_cdk::api::caller()`. This is a real platform gotcha the spec must state.

**Transferring ownership:** two steps, in order: (1) the owner calls an
`admin_set_owner`-style update on the inbox that overwrites the stored `owner` field (this is
a contract-level change, no platform effect); (2) the *factory* (the controller) calls
`update_settings` to add the new principal as a controller if the owner should gain platform
power over the inbox. The X-Farm Farmer deliberately does NOT give the owner controller power
— only the factory has it — so the owner cannot self-upgrade or self-delete. Canister Inbox
should make the same choice: owner = contract authority (read, send, set policy); factory =
platform authority (upgrade, delete, cycle top-up). Separation of concerns, and it prevents
a compromised owner principal from bricking the inbox.

---

## 6. vetKeys — the only path to non-plain-text on-chain state

This is the section that decides whether "no one can read your messages" is marketing or
truth.

**What vetKeys is ([ICP vetKeys docs](https://docs.internetcomputer.org/concepts/vetkeys/), [vetKD API](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/), [ic-vetkeys crate](https://github.com/dfinity/vetkeys)):**
- Verifiable Encrypted Threshold Key Deriation. A subnet master key is held in threshold
  shares across nodes; a canister calls `vetkd_derive_key` on the management canister with
  `(input, context, transport_public_key, key_id)` and receives an `encrypted_key` blob,
  encrypted under the caller-supplied transport public key. No single node ever sees the
  raw derived key.
- Production key `key_1` is **live on mainnet** (subnet `pzp6e`, 34-node fiduciary), costs
  ~26 T cycles (~$0.035) per derivation. Test key `test_key_1` on `fuqsr`, ~10 T cycles.
- **Caveat / VERIFY:** the Rust `ic-cdk` docs as of May 2025 still say "vetKD is not yet
  available on mainnet," conflicting with the ICP concept docs and the vetkeys GitHub.
  The repo's own AI Proposal Review spec (`/ideas/ai-proposal-review/02-backend-and-tasks.md:122-129`)
  lists "verify subnet is SEV-SNP-enabled + spike `vetkd_derive_key` round-trip" as a
  pre-build gate (MemoryId 0.2a). **Canister Inbox inherits that gate verbatim.** Do not
  assume vetKeys works end-to-end until a round-trip on mainnet is demonstrated.

**How vetKeys would change the privacy model (sketch):**
1. **Per-thread symmetric keys.** The owner (or a thread creator) derives a symmetric AES
   key per `thread_id`: `vetkd_derive_key(input = thread_id, context = b"canister_inbox_v1", transport_pubkey = owner_ephemeral_pubkey)`. The encrypted key is returned to the owner, who decrypts it client-side with their transport secret.
2. **Encrypted message bodies.** Senders encrypt the message body under the thread's
   symmetric key *before* calling `send`. The inbox stores only ciphertext in stable memory.
   `read` returns ciphertext; only principals who can derive (or be granted) the thread key
   can decrypt.
3. **Decryption gated by owner principal.** Because vetKD derivation is keyed to `input`
   and `context`, and access to the master key is threshold-controlled, only a principal
   the inbox authorises can obtain a usable transport-encrypted key. The inbox canister
   enforces the ACL (`caller == owner || authorised(thread, caller)`) before forwarding the
   `vetkd_derive_key` call — this is the `KeyManager` pattern from `ic-vetkeys`.
4. **Identity-based encryption alternative:** anyone can encrypt a message *to* the owner's
   principal offline (using the published `key_1` master public key) without the owner being
   online; the owner later derives the decryption key. This is the natural fit for an inbox:
   a sender encrypts to `owner` and the inbox just stores opaque ciphertext.

**What vetKeys does NOT fix (be honest):** metadata is still plain-text — `sender`,
`thread_id`, timestamps, message *length* are visible to anyone who can call a public query
or to node operators. vetKeys encrypts *bodies*, not *envelopes*. And vetKeys alone is
insufficient for *in-use* secrecy if a SEV-SNP subnet is not used (the AI-proposal-review
finding at `02-backend-and-tasks.md:118-120`): a node operator on a non-SEV-SNP subnet can
observe the decrypted key in canister RAM at the moment of derivation. So:
- **At-rest secrecy:** vetKeys gives it (stable memory holds only ciphertext).
- **In-use secrecy:** only if the inbox canister runs on a **fully SEV-SNP-enabled subnet**
  (so node hosts cannot read enclave RAM). **VERIFY** which IC subnets are SEV-SNP today;
  the AI-review spec lists this as gate 0.0.

**Recommendation for the spec:** vetKeys is the single biggest net-new dependency. Phase 1
ship plain-text (matching X-Farm's "LOCAL only, dark behind a flag" model) and label the
inbox "metadata + bodies visible to subnet operators and to any caller of public query
methods." Phase 2 add vetKeys for body encryption once the SEV-SNP + round-trip gates clear.
Do NOT ship the "no one can read your messages" copy until Phase 2 is verified.

---

## 7. Canister snapshots + upgrade safety

**Snapshots** (`scripts/deploy-prod.sh:103-112`): the repo takes a pre-upgrade snapshot of
the backend before each mainnet deploy as rollback insurance, via `icp canister snapshot
create backend --replace`. Per the deploy-prod note in MEMORY, the snapshot step requires
the canister be **stopped** (and the script's known bug is that it never stops the canister,
so it dies at the snapshot step). For an inbox canister this matters less (per-user, lower
stakes) but the factory should still snapshot before code upgrades. **Reuse the
stop→snapshot→upgrade→start sequence; do not skip `start_canister`** (a stopped canister
does not auto-start and `install_code` on a stopped canister fails).

**Stable memory across upgrades (the critical invariant):**
- **Stable memory survives `install_code` (mode = upgrade) untouched.** Heap does not.
- This is why every persistent structure in the repo lives in `StableBTreeMap` /
  `StableCell` (see §1). Canister Inbox MUST follow the same rule: messages, thread
  indexes, the owner record, the authorised-senders set — all stable. No heap `BTreeMap`.
- `#[post_upgrade]` (`src/xfarm_farmer/src/lib.rs:292`) re-arms the heap-only timer
  (`ic_cdk_timers::set_timer_interval`, line 302) — timers are heap state lost on upgrade,
  so they must be re-armed in `post_upgrade`. An inbox with a retention sweep timer must do
  the same. The repo's pattern is the reference: keep `TIMER_ID` in a heap `RefCell` (line
  166) and re-arm it in `post_upgrade`.
- The repo uses **EOP-free** (wasm32) stable-structures everywhere, so upgrades are
  serialise-free. If Canister Inbox adopts wasm64/EOP, the upgrade instruction-limit
  concern disappears entirely but a temporary 6 GiB heap cap applies
  ([forum](https://forum.dfinity.org/t/canister-memory-allocation-does-not-limit-canister-memory-usage/59993)).
  **Recommendation: stay on wasm32 + stable-structures like the repo; EOP is not needed.**

---

## 8. Candid as the open standard

The `.did` file *is* the standard. The repo publishes one per canister
(`src/xfarm_farmer/xfarm_farmer.did` is the precedent — it declares `service : (FarmerInitArgs) -> { … }`
and is what other tooling imports). Canister Inbox should publish `inbox.did` with:
- `service : (InboxInitArgs) -> { send : (...) -> (Result); read : (...) -> (Result_…) query?; retrieve_thread : (...) -> (…) query?; get_status : () -> (…) query; }`
- Init args (`InboxInitArgs`) mirroring `FarmerInitArgs` (`xfarm_farmer.did`): `owner`, `factory_canister_id`, `authorised_senders: vec principal`, `retention_days`, `max_messages_per_thread`.

Other projects adopt the standard by generating client bindings from the `.did`
(`dfx generate` / `agent-js` candid tooling) and deploying their own inbox canisters from the
published wasm. The "open standard" claim is credible *because* Candid interfaces are
machine-readable contracts — but it requires publishing the wasm module (not just the
`.did`) so others can `install_code` it. **Net-new operational work:** a release pipeline
that ships a versioned, checksum-pinned inbox wasm + `.did`, which is more than the repo does
today (the Farmer wasm is internal, not published as a standard).

---

## 9. The privacy reality — the load-bearing red-team

Stated once more, crisply, because it overrides product copy:

- **"No company can read your messages" — TRUE**, in the sense that no SaaS vendor
  gatekeeps the inbox. The code is the contract; there is no company-side ACL.
- **"No one can read your messages" — FALSE** unless vetKeys is used. Specifically:
  1. **Node operators** on the inbox's subnet can read raw canister memory (stable + heap)
     because they run the replica. This is honest limitation documented for the poker idea
     (`/ideas/poker/07_security_testing.md:9`: "Hole-card leakage via replica access — node
     providers can read canister memory"). Same applies here, identically.
  2. **Anyone can call a public query method** the inbox exposes. If `read` is a public
     `#[query]`, the whole world can read every message — not just the owner. The spec
     MUST gate `read` by `caller == owner || authorised` and accept that this makes `read`
     an update for cross-canister agents (§2).
  3. **`read_state`** does NOT expose arbitrary canister state — only certified system paths
     (`module_hash`, `controllers`, public metadata) ([HTTPS interface](https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/)).
     So the system state tree is not the leak vector; the canister's own query methods and
     node memory are.
  4. **Certified data** (`ic0.certified_data_*`) is *not* publicly readable via `read_state`;
     it is only available to the canister itself. It does not help here.
- **Implication for product copy:** the honest, defensible claims are (a) *censorship-
  resistant* — no company can revoke access or delete your inbox because no company controls
  it, only the owner principal + factory do; (b) *no middleman fee* — cycles go to the
  subnet, not a vendor; (c) *optionally end-to-end encrypted* via vetKeys (Phase 2). The
  claim "no one can read your messages" must NOT appear in copy unless vetKeys is shipped
  AND the inbox runs on a SEV-SNP subnet.

---

## 10. Reuse map — what already exists vs. net-new

| Capability | Repo source (reuse) | Net-new for Canister Inbox |
|---|---|---|
| Factory: `create_canister`/`install_code`/`deposit_cycles`/`stop`/`delete` | `lib.rs:19435-19502` (X-Farm) | None — clone the wrappers + `#[cfg(wasm32)]` mocks |
| Stable storage partitioning | `lib.rs:4,701-738`; `xfarm_farmer/src/lib.rs:37-165` | Pick inbox-local `MemoryId`s |
| Owner-at-init pattern | `FarmerInitArgs.owner` (`lib.rs:19324`) + `FarmerConfig` persist | `InboxInitArgs` + `InboxConfig` |
| `inspect_message` ingress gate | `lib.rs:762-775` | Extend to reject unauth `send` (ingress only; inter-canister needs in-body check) |
| Inter-canister call+await shape | `lib.rs:19509` (double-`Result`) | Apply to `send`/`read` |
| Feature-flag system | `feature_visible`/`FlagState`/`admin_set_feature_flag_state` (`lib.rs:5501-5590`) | Reuse for the inbox-on/off flag |
| `canister_status` cycle read | `lib.rs:3637-3649` | Reuse for inbox balance UI |
| Cycle funding (`deposit_cycles`) | `lib.rs:3662-3672` | Reuse; add per-`send` cycle charge via `msg_cycles_accept` (net-new) |
| Escrow/per-user subaccount | `derive_*_subaccount` family (`lib.rs:1820,5726,6015,6864`) | Optional: if `send` charges ICP not cycles |
| Frontend control-plane UI | `src/frontend/src` patterns (XFarm.tsx dashboard) | Minimal inbox status + cycle top-up page |
| vetKeys body encryption | None in repo | Entire vetKeys integration (Phase 2) — gated on §6 VERIFYs |
| Published `.did` + wasm standard | `xfarm_farmer.did` exists but not published as standard | Versioned release pipeline (net-new ops) |

---

## Open VERIFYs (consolidated, for the spec author to close)

1. Stable-memory storage cycle rate per byte-second (§1) — pull exact figure from
   [cycle-costs](https://docs.internetcomputer.org/references/cycle-costs/).
2. Whether `inspect_message` can read attached cycle count (§4) — determines if a
   cycle-minimum gate can be pre-admission or must be in-body.
3. `vetkd_derive_key` end-to-end round-trip on mainnet `key_1` (§6) — inherits AI-review
   gate 0.2a; conflicting SDK docs vs. concept docs must be resolved by a spike.
4. Which IC subnets are fully SEV-SNP-enabled today (§6) — inherits AI-review gate 0.0;
   in-use secrecy depends on it.
5. Exact cross-canister update base fee in cycles (§4) — bench a no-op round trip.
6. Whether `provisional_create_canister_with_cycles` is wired into the repo's local `dfx`
   flow, or whether to follow the `dev_seed_*` (`canister_id: None`) seam (§3).

---

## Sources

- [Stable structures | ICP Developer Docs](https://docs.internetcomputer.org/languages/rust/stable-structures/)
- [Stable memory limits clarification (DFINITY forum, Sept 2025)](https://forum.dfinity.org/t/clarification-on-stable-memory-limits-64-gib-base-region-vs-500-gib-canister-resource-limits/57861)
- [Canister memory allocation change (DFINITY forum, Nov 2025)](https://forum.dfinity.org/t/canister-memory-allocation-does-not-limit-canister-memory-usage/59993)
- [StableMemory trait (docs.rs/ic-cdk)](https://docs.rs/ic-cdk/latest/ic_cdk/stable/trait.StableMemory.html)
- [IC management canister | ICP Developer Docs](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/)
- [Cycle costs | ICP Developer Docs](https://docs.internetcomputer.org/references/cycle-costs/)
- [Inter-canister calls guide](https://docs.internetcomputer.org/guides/canister-calls/inter-canister-calls/)
- [Parallel inter-canister calls guide](https://docs.internetcomputer.org/guides/canister-calls/parallel-inter-canister-calls/)
- [IC interface specification](https://docs.internetcomputer.org/references/ic-interface-spec/)
- [HTTPS interface (read_state / query / canister state tree)](https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/)
- [Certification](https://docs.internetcomputer.org/references/ic-interface-spec/certification/)
- [VetKeys | ICP Developer Docs](https://docs.internetcomputer.org/concepts/vetkeys/)
- [vetKD API reference](https://docs.internetcomputer.org/references/ic-interface-spec/management-canister/)
- [dfinity/vetkeys (libraries + examples)](https://github.com/dfinity/vetkeys)
- [vetkd_derive_key (docs.rs/ic-cdk)](https://docs.rs/ic-cdk/latest/ic_cdk/management_canister/fn.vetkd_derive_key.html)
- [Composite queries & inter-canister (DFINITY forum)](https://forum.dfinity.org/t/composite-queries-and-inter-canister/39195)
- [Cross canister query calls (DFINITY forum)](https://forum.dfinity.org/t/cross-canister-query-calls/41138)

Repo code cited (all absolute paths):
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/backend/src/lib.rs` — factory, stable storage, feature flags, inspect_message, inter-canister helpers (lines 4, 760-775, 1820, 2130, 3620-3676, 5152-5590, 19170-19525).
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/xfarm_farmer/src/lib.rs` — per-user child canister template (lines 37-165, 291-303, 494-512).
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/src/xfarm_farmer/xfarm_farmer.did` — Candid interface precedent.
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/ideas/x-farm/05-architecture.md` — factory architecture.
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/ideas/ai-proposal-review/02-backend-and-tasks.md` — vetKeys/SEV-SNP gates (lines 118-129, 161-166).
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/ideas/poker/07_security_testing.md` — "node providers can read canister memory" honest limitation.
- `/Users/andrejones/Desktop/workspace/projects/proof-of-burn/scripts/deploy-prod.sh` — snapshot lifecycle (lines 103-112).