---
type: idea
title: "Canister Inbox — Reuse Map"
tags: [ideas, canister-inbox]
timestamp: 2026-06-28T11:58:57-04:00
---

# Canister Inbox — Reuse Map

Line numbers are anchored to the working tree at HEAD on 2026-06-28 (the in-flight `M src/backend/src/lib.rs` is unrelated to the patterns cited here — verification is via `grep`/`Read`, not the staged diff). Verify before building; the file is ~29,751 lines and shifts.

**Honest framing up front.** Canister Inbox is mostly **net-new infrastructure**. The X-Farm Farmer factory is the one genuinely close analog, and even there the *contract* is different (a per-user inbox storing a messaging data model vs. a per-user tweet drafter). Everything else reused here is a *primitive* (a stable-memory map, a feature flag, an admin guard, a `call_with_payment128` shape) — not application logic. The percentages below reflect that: the highest-reuse item (factory skeleton) is ~55%, and most rows are 20–40%. Treat this doc as a parts catalog, not a recipe.

---

## 1. Factory pattern — the X-Farm Farmer factory (HIGHEST REUSE)

This is the closest existing analog and the single most valuable thing to copy. The backend canister acts as a **factory**: for each paying owner it `create_canister`s a child, `install_code`s a second wasm into it, funds it with cycles, records the owner, and later stops/deletes it. Exactly the lifecycle an "each agent gets an inbox canister" feature needs.

**Factory primitives (management-canister calls), all net-new-to-the-repo-before-X-Farm and now battle-tested:**
- `xfarm_create_canister` — `lib.rs:19435`. Calls `Principal::management_canister()` `create_canister` via `ic_cdk::api::call::call_with_payment128(..., creation_cycles)` (cycles attached to the *call*, not the arg struct — the old bug that sent 0 is called out at `lib.rs:19446–19449`). Sets the factory (this backend) as **sole controller** and `freezing_threshold: 0` via `XFarmCanisterSettings` (`lib.rs:19341`).
- `xfarm_install_code` — `lib.rs:19463`. `install_code` with `mode: install`, passing `FarmerInitArgs` (`lib.rs:19322`) as the candid-encoded `arg`.
- `xfarm_upgrade_code` — `lib.rs:19482`. `install_code` with `mode: upgrade` (preserves stable state across a wasm rollout). Empty `arg` because the child's `post_upgrade` takes none.
- `xfarm_stop_canister` / `xfarm_delete_canister` — `lib.rs:19490 / 19498`. Cleanup pair.
- `xfarm_extend_farmer` — `lib.rs:19499` (inter-canister call *back to the child*, see §7).

**The orchestration saga** (`create_farmer`, `lib.rs:19671–19740`) is the canonical "create → install → fund → journal" ordering with partial-failure recovery:
1. Validate inputs + check `WASM_NOT_UPLOADED` *before* any money moves (`lib.rs:19660`).
2. `create_canister` first; on failure remove the persisted Farmer row and return the error with the deposit untouched (`lib.rs:19680`).
3. `install_code`; **on install failure immediately `delete_canister` the orphan** so it can't accumulate cycles (`lib.rs:19694`, R5).
4. Only after the child exists, move the owner's ICP (treasury leg → burn leg), each journaled so a retry sweep resumes (`lib.rs:19700–19740`).

**Owner registry + per-owner indexing:** `Farmer` struct (`lib.rs:19295`) with `owner: Principal` + `canister_id: Option<Principal>`; stored in `XFARM_FARMERS` (`StableBTreeMap<u64, Farmer>`, `MemoryId::new(54)`, `lib.rs:19366`); `xfarm_farmers_by_owner` (`lib.rs:19399`) for the "list my farmers" query. `XFARM_NEXT_ID` (`MemoryId::new(55)`) for monotonic ids.

**The child canister itself** (`src/xfarm_farmer/src/lib.rs`) is the template for the inbox canister: `thread_local!` stable storage at `lib.rs:149` (`DRAFTS` Map, `NEXT_DRAFT_ID` Cell, `CONFIG` Cell on `MemoryId::new(0/1/2)`), `#[ic_cdk::init]` taking `FarmerInitArgs` (`lib.rs:267`), `#[ic_cdk::post_upgrade]` re-arming the timer (`lib.rs:291`), and `#[ic_cdk::inspect_message]` rejecting anonymous ingress (`lib.rs:234`). The `.did` (`src/xfarm_farmer/xfarm_farmer.did`) is a 4-method query/update service — exactly the shape Canister Inbox's three-method interface wants.

**% reuse estimate for "create per-agent inbox canister": ~55%.** The factory skeleton, the management-canister call shapes, the create→install→fund→journal ordering, the orphan-cleanup discipline, the per-owner registry, and the child-canister file layout are all directly portable. The net-new ~45%: the inbox data model (messages/threads, not drafts), the three-method Candid interface, cycle-accept-per-interaction (§10), and the open-standard verification hook (§6).

---

## 2. Escrow / ledger / ICP transfer (MOSTLY NOT REUSED)

Canister Inbox is **cycle-funded, not ICP-funded** — "agents pay per interaction in cycles, not a SaaS fee." The repo's entire escrow/ledger machinery is ICP-shaped and largely does not transfer. Call it out explicitly so nobody clones `settle_burn_split` expecting a money path.

- `settle_burn_split` (`lib.rs:2505`) — the canonical ICP burn leg (10% treasury / 90% CMC topup), journaled. **Not reused** (no ICP split in Canister Inbox).
- `call_cmc_topup_transfer` + `notify_cmc_topup` (`lib.rs:2279 / 2366`) — burn ICP→cycles via the Cycles Minting Canister. **Reused only if** the inbox factory itself needs to convert a developer's ICP payment into the child's initial cycle balance (the X-Farm model). If Canister Inbox instead requires the developer to top up cycles directly (the cleaner, on-spec path), this is **not reused at all**.
- `reclaim_escrow` + `EscrowKind` enum (`lib.rs:12172 / 12247`) — generalized per-Principal escrow reclamation across 8 `EscrowKind` variants. **Not reused** (no escrow to reclaim; messages aren't money).
- `derive_*_subaccount` family (`lib.rs:1818 / 5456 / 9637`, X-Farm variant at `lib.rs:19396`) — per-caller deterministic subaccounts. **Not reused** (no per-caller ledger accounts).

**The distinction that DOES matter:** **cycle transfer ≠ ICP transfer.** ICP moves via `icrc1_transfer` / `transfer` on the ledger canister (`lib.rs:2146 / 2240`); cycles move via the management canister's `deposit_cycles` (call-with-payment, `lib.rs:3664`) or `withdraw_cycles`, and are accepted inbound via `msg_cycles_accept` (§10). Canister Inbox's "per-interaction payment" is the cycle path, not the ICP path. **% reuse: ~5%** (only the conceptual "journaled, idempotent, retry-safe multi-step transfer" pattern is spiritually reusable).

---

## 3. Feature-flag system (HIGH REUSE — for the control-plane UI and the Cycle Burn integration)

The repo has a clean three-state feature-flag system. Canister Inbox needs gating in two places: (a) the control-plane UI (ship dark, admin-preview), and (b) the Cycle Burn integration (the governance/lottery agent hooks that become the first inbox consumers). Both reuse this verbatim.

- Flag constants: `FLAG_X_FARM` etc. at `lib.rs:5152–5187`; `KNOWN_FEATURE_FLAGS` array `lib.rs:5188`.
- Storage: `FEATURE_FLAGS: StableBTreeMap<String, u8, Memory>` on `MemoryId::new(13)` (`lib.rs:5412`). `1=On, 0=Off, 2=AdminOn`.
- Three-state `FlagState { Off, On, AdminOn }` (`lib.rs:5296`) + `FeatureFlag { key, enabled, state }` (`lib.rs` ~5300).
- Resolution: `feature_default` (`lib.rs:5450`), `feature_state` (`lib.rs:5476`), `feature_enabled` (`lib.rs:5508`, caller-agnostic, timer-safe), `feature_visible` (`lib.rs:5514`, caller-aware — `AdminOn` resolves to `is_admin_principal(caller)` at `lib.rs:5517`).
- Admin setter: `admin_set_feature_flag` guarded by `require_admin` (`lib.rs:5559`).
- Public listing for UI gating: `list_feature_flags` query (`lib.rs:5538`).

To add Canister Inbox: define `pub const FLAG_CANISTER_INBOX: &str = "canister_inbox";`, append to `KNOWN_FEATURE_FLAGS`, set `feature_default(FLAG_CANISTER_INBOX) => false` (ship dark), and gate the inbox endpoints with a `require_canister_inbox_enabled()` mirroring `require_x_farm_enabled` (`lib.rs:19384`). A second `FLAG_INBOX_CB_INTEGRATION` (the Cycle Burn consumer hooks) follows the same pattern as `FLAG_DISCUSSIONS` (`lib.rs:6026`). **% reuse: ~85%.** The system is over-learned for this; near-clone the registration.

---

## 4. canister_info validation (MEDIUM REUSE — for the open-standard "verify this is a real Canister Inbox canister" check)

The Dapp Explorer and the ID Listings idea both need to validate an *external* canister. Canister Inbox's open-standard endgame — "any agent project can adopt this" — needs the same: a verifier asks "is the canister at this principal actually running the Canister Inbox wasm, and who controls it?" The repo has half of this and the other half is net-new.

**What's in the repo (controller-only, insufficient for the open standard):**
- `admin_get_frontend_cycles` (`lib.rs:3636`) calls the management canister's **`canister_status`** with a `CanisterIdRecord` (`lib.rs:3626`) and decodes a minimal `CanisterStatusCycles { cycles: Nat }` (`lib.rs:3625`). This works because the backend is a **controller** of the frontend canister. `canister_status` is controller-gated, so it cannot verify an arbitrary third-party inbox.

**What's net-new (already scoped in the ID Listings idea, NOT built):**
- The management canister's **`canister_info`** is callable by **any canister for any target — NOT controller-gated** — and returns the target's `module_hash` + `controllers` (+ recent change history). This is documented in `/ideas/id-listings/02-validation-method.md:70–73` and `/ideas/id-listings/03-implementation-plan.md:72–93`, with the explicit correction note that the original "must validate off-chain" claim was wrong. `canister_info` is in the pinned `ic-cdk` 0.19 as `canister_info(CanisterInfoRequest) -> CanisterInfoResponse`.
- For Canister Inbox's open standard: admin pins `inbox_expected_module_hash: Vec<u8>` (reproducible-build hash of the published inbox wasm) + optionally `inbox_expected_controllers: Vec<Principal>`. The verifier calls `canister_info(target)` and compares. Mismatch ⇒ "not a real Canister Inbox" / "code drifted."

**% reuse: ~30%.** The pattern shape (`CanisterIdRecord`, subset-decode the reply, error-format `(code, msg)`) copies from `admin_get_frontend_cycles`. The `canister_info` call itself, the pinned-hash comparison, and the public verifier endpoint are net-new. The ID Listings idea already designed this; read it before building.

---

## 5. Inter-canister call patterns already in the repo (HIGH REUSE)

The repo is rich in inter-canister calls — Canister Inbox's agent-to-agent `send` is just one more. Copy the shapes:

- `ic_cdk::call(target, "method", (args,)).await` returning `Result<(T,), (RejectionCode, String)>` — the universal shape. Examples: ledger `icrc1_balance_of` (`lib.rs:1991`), `icrc1_transfer` (`lib.rs:2146`), ledger `transfer` (`lib.rs:2240`), CMC `notify_top_up` (`lib.rs:2377`), NNS `list_proposals` (`lib.rs:4080`), `manage_neuron` (`lib.rs:4187`), `raw_rand` (`lib.rs:9521 / 14691`), XRC `get_exchange_rate` (`lib.rs:10764`), `icrc2_approve` (`lib.rs:10918`), NFT `mint`/`burn`/`custodial_transfer` (`lib.rs:16294 / 16376 / 16325`).
- `call_with_payment128` for cycle-attached calls: `deposit_cycles` (`lib.rs:3664`), XRC (`lib.rs:10764`). This is the exact shape for "agent sends cycles with its `send_message` call."
- `Call::bounded_wait(...)` for deadline-bounded management calls: `http_request` (`lib.rs:4890`). Use this for any inbox call that must not hang the agent.
- **Child→factory callback (the inbox-reporting pattern):** the Farmer canister calls back to the backend `report_depleted` (`src/xfarm_farmer/src/lib.rs:509`), and the backend exposes `report_depleted` as an update (`lib.rs:19904`) that the sweep consumes. This is the precise template for an inbox canister calling back its factory on a lifecycle event (e.g. `inbox_low_cycles`).
- **Rejection-code handling:** the `DestinationInvalid | CanisterError | CanisterReject` triage at `lib.rs:4205–4207 / 7852–7854` — copy for inbox `send` retry/timeout semantics.

**% reuse: ~75%.** The call shapes, cycle-attachment, bounded-wait, and callback pattern are all here. Net-new is the *protocol* on top (the three-method interface, message envelope, threading).

---

## 6. Admin / Principal ownership checks (HIGH REUSE)

Inbox ownership ("owned by the Principal that deployed them") maps directly onto the repo's admin + owner patterns.

- `require_admin` (`lib.rs:830`) — checks `config.admins.contains(&caller)`. Used as a `#[ic_cdk::update(guard = "require_admin")]` on ~30 endpoints (e.g. `lib.rs:1203, 1221, 1239, 3053, 5559`).
- `is_admin_principal(user)` (`lib.rs:9807`) — non-throwing membership check. Used by `feature_visible` (`lib.rs:5517`) and the admin ticket-exclusion guard (`lib.rs:6315`).
- `require_authenticated` (`lib.rs:828`) — rejects `Principal::anonymous()`.
- **Per-canister owner field:** the `Farmer.owner: Principal` pattern (`lib.rs:19295`) + `xfarm_farmers_by_owner` (`lib.rs:19399`) is the template for "list *my* inboxes." The child's `FarmerInitArgs.owner` (`lib.rs:19322`) is set at `install_code` and stored in the child's `FarmerConfig.owner` (`src/xfarm_farmer/src/lib.rs`, the `.did`'s `FarmerConfig`).
- **`inspect_message`** — the backend rejects anonymous ingress at the ingress boundary (`lib.rs:762–774`); the Farmer does the same (`src/xfarm_farmer/src/lib.rs:234–239`). Note the comment at `lib.rs:761`: *inspect_message only fires for direct ingress calls, not inter-canister* — so an inbox must re-check the caller inside every update method, not rely on `inspect_message` alone. This is a load-bearing platform gotcha for an agent-messaging contract.

**% reuse: ~80%.** Ownership is essentially `Farmer.owner` + `require_admin` + an `is_inbox_owner(caller, inbox_id)` check. Net-new is the *authorization policy* for cross-agent sends (does inbox A accept a message from agent B?).

---

## 7. Frontend control-plane UI patterns (HIGH REUSE)

The spec calls for "a lightweight web UI as the human control plane … developers deploy inbox canisters, manage cycles, and watch messages arrive." The repo already has the three exact UI analogs.

- **`src/frontend/src/XFarm.tsx`** — the per-user-canister control-plane UI. Reuse directly: the `refresh` pattern (`XFarm.tsx:187` fan-out `get_xfarm_info / get_xfarm_tiers / list_my_farmers`), the create flow (`get_xfarm_quote` → deposit → `create_farmer` → `refresh`, `XFarm.tsx:214–276`), the per-canister status card, the modal shell (`MODAL_OVERLAY`/`MODAL_CARD` constants), the persona picker, the dev-seed buttons (`dev_seed_farmer`/`dev_seed_drafts`/`dev_clear_farmers`, `XFarm.tsx:294–312`). This is the closest UI analog in the entire repo.
- **`src/frontend/src/Admin.tsx`** — sectioned admin console (7 tabs, `AdminProps`/`SECTIONS` at `Admin.tsx:14–37`). Reuse the **feature-flag table** (the Settings tab renders `featureFlags: FeatureFlag[]` with the three-state cycler), the treasury/cycle-balance display, the `onChanged` re-fetch pattern. The `admin_get_frontend_cycles` + `admin_send_cycles_to_frontend` pair (`lib.rs:3636 / 3654`) is the model for an "inbox cycle balance + top-up" admin control.
- **`src/frontend/src/ui.tsx`** — primitives: `Btn, Chip, Eyebrow, Icon, LiveDot, MoreInfo, Skeleton, fmtICP, formatPrincipal, usePageDevControls`. Use these for a consistent page anatomy (the `frontend-dev` skill enforces this).
- **Bindings:** `src/frontend/src/bindings/backend` (generated candid) — the inbox factory adds its methods to the backend `.did` and regenerates; the inbox *child* gets its own `bindings/inbox` from its published `.did`.

**% reuse: ~70%.** The control-plane skeleton, monitoring primitives, and cycle-management UI are all here. Net-new is the message-list view (the inbox's "watch messages arrive" pane — no existing repo UI renders an on-chain message stream).

---

## 8. Stable memory for messages (PARTIAL REUSE — pattern yes, model no)

The stable-memory *pattern* is heavily reused; the *message data model* is net-new.

- `ic_stable_structures` import + `MemoryManager` + `StableBTreeMap` + `StableCell` + `impl_storable!` macro (`lib.rs:4 / 629 / 669`). Per-feature `MemoryId` allocation across the map (CONFIG=0, PROPOSALS=1, … X-Farm takes 54–56; the audit log uses `Log` on 5/6, `lib.rs:720`). The Farmer child reuses the same shape on `MemoryId::new(0/1/2)` (`src/xfarm_farmer/src/lib.rs:149`).
- **Upgrade safety:** `#[ic_cdk::post_upgrade]` re-arms heap-only state (the Farmer's timer, `src/xfarm_farmer/src/lib.rs:291`); stable state survives without code. Canister snapshots (the repo's deploy scripts use `canister snapshot` per the mainnet-deploy memory note) are the rollback primitive — the inbox factory should snapshot before every inbox-wasm rollout.
- **Bounded history:** the Farmer prunes drafts older than 30 days each tick (`prune_drafts`, `src/xfarm_farmer/src/lib.rs:434`) with `MAX_STORED_DRAFTS = 400`. Copy this exact "bounded last-N retention" for inbox messages — an unbounded inbox is a freezing/DoS liability.

**Net-new message data model:** `Message { id, from: Principal, to: Principal (or inbox_id), thread_id, body: Vec<u8>, created_at, read_at: Option<u64> }` + `Thread { id, participants, last_message_at }` + per-inbox `StableBTreeMap<u64, Message>` and `StableBTreeMap<u64, Thread>`. The body should be bytes (not `String`) because §11 makes it ciphertext. **% reuse: ~35%.**

---

## 9. Cycle-accept-per-interaction (HIGH REUSE — `wallet_receive` is the template)

"Agents pay per interaction in cycles" requires the inbox to *accept cycles on each call*. The repo already does this pattern.

- `wallet_receive` (`lib.rs:3808–3823`): reads `ic_cdk::api::call::msg_cycles_available()` and accepts via `ic_cdk::api::call::msg_cycles_accept(amount)`. This is the exact per-call cycle-payment primitive.
- `deposit_cycles_to` (`lib.rs:3664`) — `call_with_payment128` to the management canister's `deposit_cycles` for outbound cycle movement.
- `canister_cycle_balance()` (`lib.rs:3811`) — `ic_cdk::api::canister_balance()` wrapper; the child reports it via `get_status` (`.did` `Result_3 = record { cycles_remaining; next_generation_at }`). The inbox equivalent reports `(cycles_remaining, message_count, last_received_at)`.
- **`accept_message` boundary:** `ic_cdk::api::call::accept_message()` is used in `inspect_message` (`lib.rs:774`) — distinct from `msg_cycles_accept`. Don't confuse the two: one accepts the *ingress message*, the other accepts the *cycles attached to it*. An inbox wants both — accept the call only if it carries ≥ the per-interaction cycle minimum (enforced in `inspect_message` for direct ingress, re-checked in the update body for inter-canister calls, since `inspect_message` does not fire for inter-canister per `lib.rs:761`).

**% reuse: ~65%.** The accept/measure/balance primitives are all present. Net-new is the *per-method cycle pricing policy* and the refund-on-overpayment semantics (the IC does not auto-refund unaccepted cycles; `msg_cycles_accept(amount)` accepts only what you ask for, the rest is returned).

---

## 10. What is NET-NEW (no existing reuse)

Be explicit so reviewers don't go hunting:

1. **The messaging data model** — `Message`, `Thread`, read receipts, threading, per-inbox indexing. No precedent; the Farmer's `Draft` is a one-way generated artifact, not a bidirectional message.
2. **The three-method Candid interface** (`send_message`, `read_messages`, `retrieve_thread`) and its envelope/auth semantics (who may send to whom, threading keys, optional reply-to). The Farmer's 4-method interface is the closest *shape* but the contract is different.
3. **The open Candid standard** — a published `.did` + a pinned `module_hash` + a `canister_info`-based verifier (§4). The repo has never published a reusable canister standard.
4. **vetKeys at-rest encryption — RED-TEAM POINT.** The spec's claim that "no company can read, intercept, or revoke access to an agent's messages" collides with platform reality: **on-chain canister state is PUBLIC to anyone who reads the subnet** via `read_state` / certified paths (the ID Listings idea leans on exactly this publicity to verify `module_hash`). Without vetKeys encryption of message bodies, "the canister IS the inbox" means "the inbox is world-readable." vetKeys (`ic_vetkey` / the encrypted-maps system canister) provides at-rest key material so only the recipient can decrypt; this is net-new infra the repo has never used. The messaging body must be ciphertext (§8), and the *keying* is the genuinely new work. Flag this loudly in the adversarial review doc.
5. **Cross-agent authorization policy** — who is allowed to `send_message` to a given inbox (allowlist? fee-gated? Principal-pinned?). No precedent.
6. **Cycle-accept-per-interaction accounting + refund semantics** — the *policy* (price table, overpayment handling) is new even though the primitives exist (§9).
7. **The Cycle Burn consumer integration** — wiring the AI Proposal Review + Proposal Discussions agent hooks to read from / post to inboxes. Those hooks live in `lib.rs` (grep `FLAG_DISCUSSIONS`/`discussions` at `lib.rs:6026`) but the inbox-read path is new.

---

## 11. Reuse summary table

| Component | Source location | % reuse | Net-new work |
|---|---|---|---|
| Factory skeleton (create/install/fund/stop/delete) | `lib.rs:19435–19498`, `19671–19740`; `src/xfarm_farmer/` | **55%** | Inbox data model; cycle-accept-per-interaction; open-standard verify hook |
| Escrow / ICP transfer / CMC burn | `lib.rs:2505, 2279, 2366, 12172, 12247` | **~5%** | None reused unless inbox factory converts ICP→cycles; cycle path is §9 not §2 |
| Feature-flag system (UI + integration gating) | `lib.rs:5152–5560`; `FLAG_X_FARM`/`FLAG_DISCUSSIONS` | **85%** | Two new flag keys (`canister_inbox`, `inbox_cb_integration`) |
| `canister_info` external-canister validation | `lib.rs:3625–3644` (status, controller-only); `/ideas/id-listings/02-validation-method.md:70–93` | **30%** | `canister_info` call itself; pinned-hash comparison; public verifier endpoint |
| Inter-canister call shapes + cycle-attached calls + child→factory callback | `lib.rs:1991, 2146, 3664, 4205, 4890, 10764`; `src/xfarm_farmer/src/lib.rs:509` | **75%** | The three-method protocol; message envelope; threading |
| Admin / Principal ownership checks | `lib.rs:830, 9807, 19295, 19399`; `src/xfarm_farmer/src/lib.rs:234` | **80%** | Cross-agent send authorization policy |
| Frontend control-plane UI | `src/frontend/src/XFarm.tsx:187–312`; `src/frontend/src/Admin.tsx:14–37`; `src/frontend/src/ui.tsx` | **70%** | Message-list "watch messages arrive" pane; inbox bindings |
| Stable memory for messages | `lib.rs:4, 629, 669`; `src/xfarm_farmer/src/lib.rs:149, 434` | **35%** | `Message`/`Thread` types; bounded retention; ciphertext bodies |
| Cycle-accept-per-interaction | `lib.rs:3808–3823` (`wallet_receive`); `lib.rs:3664` (`deposit_cycles`) | **65%** | Per-method pricing policy; overpayment/refund semantics |
| **vetKeys at-rest encryption** | (no precedent in repo) | **0%** | Entirely net-new; **critical for the "no one can read your messages" claim** |
| **Open Candid standard + published `.did`** | `src/xfarm_farmer/xfarm_farmer.did` (shape only) | **10%** | Standard `.did`; reproducible-build `module_hash`; verifier |
| **Cycle Burn consumer integration** | `lib.rs:6026` (`FLAG_DISCUSSIONS` hooks) | **20%** | Inbox-read path inside the agent hooks |

**Bottom line:** the factory skeleton, feature flags, inter-canister calls, admin/ownership, frontend control-plane, and cycle-accept primitives are real, grounded reuse (call it ~40–50% of the *surface area*). The other half — the messaging data model, the three-method contract, vetKeys encryption, the open standard, and the consumer integration — is genuinely net-new infra. Build the factory by adapting `create_farmer`; build the inbox child by adapting `src/xfarm_farmer/src/lib.rs`; but budget the vetKeys work and the open-standard `canister_info` verifier as the hard, novel parts, not as clone-and-ship.