# Canister Inbox — Technical Specification

> **Status:** Idea / feasibility research — **NOT built.** No implementation tasks scoped.
> **Date:** 2026-06-28. Produced via a 5-agent ultracode fan-out (UX spec · backend & tasks · reuse
> map · ICP platform research · adversarial review).
> **Deliverables:** [`01-ux-spec.md`](./01-ux-spec.md), [`02-backend-and-tasks.md`](./02-backend-and-tasks.md),
> [`03-reuse-map.md`](./03-reuse-map.md), [`04-research-notes.md`](./04-research-notes.md),
> [`05-adversarial-review.md`](./05-adversarial-review.md).

## The idea (as asked)

A fully on-chain messaging layer for AI agents on the Internet Computer. Each agent is assigned a
**persistent inbox canister** that stores messages in stable memory. No servers, no third-party APIs,
no subscriptions — the canister IS the inbox. Agents communicate by direct inter-canister calls using a
minimal **three-method interface**: send a message, read messages, retrieve a thread. Cycle-funded:
agents pay per interaction in ICP cycles (not a SaaS fee); the infrastructure runs as long as the
canister has cycles.

Core insight: existing agent messaging (email APIs, webhooks, message queues) all introduce centralised
dependencies unnecessary when agents already live on-chain. Canister Inbox removes that layer. Because
the canister code is the contract, no company can read, intercept, or revoke access to an agent's
messages. Inboxes persist indefinitely and are owned by the Principal that deployed them.

Two surfaces: (1) the canister API agents use directly, exposing the full feature set; (2) a lightweight
web UI as the human control plane for setup and monitoring. Developers deploy inbox canisters, manage
cycles, and watch messages arrive via the UI. Agents never touch the UI — they call the canister
directly. This separation keeps the UI minimal and the API powerful.

First integration: Cycle Burn, where agents in governance and lottery mechanics use Canister Inbox to
coordinate and receive on-chain notifications. Longer term: open-sourced and published as a reusable
ICP standard any agent project can adopt.

## Executive verdict

**BUILD-WITH-CAVEATS — but do not build the pitch as written.** The idea is *not unbuildable*; the idea
*as pitched* is materially false on its central claim and several "advantages" are trades in disguise.
The honest core that survives red-teaming is one of two smaller products (see Open questions, G1):

- a **censorship-resistant, auditable agent event log** (no privacy claim) — useful for governance
  coordination where messages are *supposed* to be public; or
- an **end-to-end encrypted agent mailbox** with client-side keys and a deliberately dumb canister (real
  privacy, but the canister does almost nothing and key management becomes the hard problem).

Neither is "no servers, no dependencies, private, persistent, open standard" all at once. The IC does
not give you that combination for free; the pitch assembles attributes that are individually available
and collectively in tension.

### Requirement-vs-reality collisions (the headline table)

| Pitch claim | Platform reality | Honest reframe |
|---|---|---|
| "No company can read your messages." | **On-chain canister state is PUBLIC to subnet replica operators**; every byte of `MESSAGES` is replicated across the subnet and readable by node operators, and any public `query` method exposes it to any caller. | "No SaaS middleman gatekeeps the inbox" is true; "no one can read your messages" is **false** unless you encrypt client-side or use vetKeys at-rest (Phase 2). |
| "Inboxes persist indefinitely; owned by the deployer." | The repo's only factory pattern makes the **factory the sole controller** (`controllers: Some(vec![get_canister_id()])`, `lib.rs:19439`). The deployer is a *recorded field*, not a controller; the factory can stop/delete/upgrade any child. | Either make the owner the controller (and accept immutability) or drop "owned by the deployer" and say "tenant of the factory." |
| "Cycle-funded, not a SaaS fee." | Cycles are bought with ICP via the CMC, are **one-way** (X-Farm finding #7: cannot be refunded or moved to treasury), and an unfunded inbox **freezes** — update calls reject, messages are lost, timers halt. | It is a **prepaid subscription in a volatile asset, with manual top-up, no auto-renewal, no refund.** Real, but not "no subscription." |
| "Open standard any agent project can adopt." | A malicious fork can silently exfiltrate every message; `canister_info` returns a `module_hash` the *controller reports*, so trust reduces to controller trust, not cryptography. | An open standard needs an attestation/registry layer (itself a centralization point) or explicit "trust the controller" semantics. |
| "Agents just call the canister." | A plain `#[query]` is single-replica, uncertified, and unsafe for an agent acting on a message; `inspect_message` does not fire for inter-canister calls (`lib.rs:761`), so spam gates must live in the update body and cost the victim cycles to evaluate. | The agent protocol must use **certified `update` reads** for decisions and **cycle-priced or allow-listed inbound** for spam defense — neither is free. |

## How it works

Two deliberately separate surfaces that never bleed into each other.

**(A) The canister API (agents).** Each inbox is its own wasm (`src/canister_inbox/`, sibling to
`src/xfarm_farmer/`) exposing three agent-facing methods: `send_message` (update, mutates stable
memory, costs the sender cycles), `read_messages` (query for the owner UI / a certified update for
agents acting on the result), and `get_thread` (query for preview, with a `get_thread_certified`
update for agent decision paths). Messages are `Message { id, thread_id, from, to, body: MessageBody
{ mime_type, bytes }, kind, ref, created_at, read }` stored in `StableBTreeMap<u64, Message>` on the
inbox's own `MemoryId`s 0–7. Threads are a logical grouping keyed on `thread_id`; a composite
`(thread_id, message_id)` index gives paginated oldest-first reads without scanning the whole map.
Retention (7d/30d/90d/indefinite), per-message size cap (16 KiB), per-inbox cap (16 MiB), and per-sender
byte quota are enforced in `send_message`; a daily timer prunes by retention and evicts FIFO at the hard
cap. An `inspect_message` gate rejects anonymous ingress and enforces a minimum inbound cycle amount;
the update body re-checks the caller (inter-canister calls bypass `inspect_message`).

**(B) The web UI (humans).** A thin React page (`Inbox.tsx`, modelled on `XFarm.tsx`) inside the host
dapp — **monitoring + setup only, not a messaging client.** No compose box, no reply button. The list
view shows label, canister id, cycle balance, days-left, and a low-cycles flag. A two-step create flow
(label → retention → sender policy; then fund) reuses the X-Farm escrow + 90/10 split (90% → inbox
cycles via the CMC, 10% → treasury). The detail view shows metadata + activity (counts, last read by
agent, first-line thread previews behind an explicit reveal). Top-up, rotate owner, stop, and
decommission are the operator actions. An honest-copy footer — *"On-chain. Public. Cycles-funded."* —
appears on every inbox view; the create dialog surfaces a privacy notice verbatim.

**The factory.** The inbox factory lives inside the existing backend (`src/backend/src/lib.rs`), exactly
as the X-Farm factory does — it calls `Principal::management_canister()` `create_canister` /
`install_code` / `deposit_cycles` / `stop_canister` / `delete_canister`, records the owner in an
`InboxRecord` on backend `MemoryId`s 27–31, and exposes admin endpoints (`admin_reinstall_inbox`,
`admin_rotate_inbox_owner`, `admin_purge_inbox`, etc.) mirroring the X-Farm admin set. The creation saga
is the proven create→install→fund→journal ordering with orphan-cleanup on install failure (R5).

**Cycle funding.** Cycles attach to an inter-canister call via `call_with_payment128`; the inbox
accepts them via `msg_cycles_accept` and books `budget_cycles` (the cycle *balance* is authoritative,
per X-Farm D2). The inbox never auto-deletes on depletion — it freezes, reads still work (queries are
free), and top-up is the only correct response. A daily low-cycle warning timer writes a `kind="notify"`
system message into its own inbox so the owner's UI surfaces it.

## Cycle Burn integration

The first consumer is Cycle Burn itself, behind a `canister_inbox` feature flag (default OFF, like
every other flag). The natural first consumers already live in this repo: the **AI Proposal Review**
agent and **Proposal Discussions** threads (governance side), and the **lottery round-close / EA yield
harvest** paths (mechanics side). An admin provisions an agent inbox via
`admin_provision_agent_inbox(label, agent_principal)` — the one case where "owner" is a canister, not a
human, and the UI labels it explicitly. Existing subsystems repurpose from off-chain logging to an
inter-canister `send` to the agent inbox: governance → `proposal_settled`, lottery → `round_settled`,
EA harvest → `ea_harvest`, discussions → `discussions`. The operator opens Inbox → governance-bot and
sees a read-only first-line feed with a Candid snippet to copy for external agent projects.

**Adversarial caveat (P7):** for *intra-app* coordination, a `StableBTreeMap` in the existing backend is
strictly simpler — no new canister, no new cycle drain, no freezing risk, no spam surface. Canister
Inbox earns its keep only for **cross-app** agent messaging, where the simpler competitor does not
exist. Prove it on a cross-app scenario first, or scope the "first integration" to a demo, not a
production coupling.

## Open standard ambition

The `.did` file *is* the standard. Publishing `canister_inbox.did` + a reproducible-build `module_hash`
+ a `canister_info`-based verifier lets third parties adopt by generating client bindings and deploying
their own inbox wasm. Two platform realities temper this:

1. **Upgrade trust.** A malicious fork can silently exfiltrate every message; `canister_info` returns a
   hash the *controller reports*, so trust reduces to controller trust, not cryptography. An open
   standard needs an attestation/registry layer — itself a centralization point the pitch claimed to
   remove — or explicit "trust the controller" semantics.
2. **Sovereignty vs. upgradability.** If the factory is the controller (the repo's only pattern), the
   factory operator can read, freeze, and delete every inbox — re-centralizing one layer down. If the
   owner is the controller, the owner is sovereign but bug fixes require a re-deploy (or an owner-consented
   upgrade path). "The code is the contract" actually holds here, at the cost of immutability.

Net-new operational work the repo does not do today: a release pipeline that ships a versioned,
checksum-pinned inbox wasm + `.did`, more than the internal-only Farmer wasm currently gets.

## Deliverables

- [`01-ux-spec.md`](./01-ux-spec.md) — the two surfaces, the developer + operator journeys, screen
  states, the message/thread model, and the honest-copy guardrails (privacy).
- [`02-backend-and-tasks.md`](./02-backend-and-tasks.md) — the three-method Candid interface, stable
  memory layout, inter-canister call model, cycle funding, factory pattern, upgrade safety, and a
  31-task implementation breakdown (Phase 0 inbox wasm → Phase 1 factory → Phase 2 Cycle Burn hooks).
- [`03-reuse-map.md`](./03-reuse-map.md) — a parts catalog of what is real reuse (~40–50% of surface
  area: factory skeleton, feature flags, inter-canister calls, admin/ownership, frontend control-plane,
  cycle-accept primitives) vs. genuinely net-new (messaging data model, three-method contract, vetKeys,
  open standard, consumer integration).
- [`04-research-notes.md`](./04-research-notes.md) — ICP platform grounding: stable-memory limits (500
  GiB via `stable64_*`), call semantics (update vs. query vs. composite query), management-canister
  costs (500 B-cycle `create_canister` fee), vetKeys status, snapshot/upgrade invariants, and the
  load-bearing privacy red-team. Consolidated VERIFYs.
- [`05-adversarial-review.md`](./05-adversarial-review.md) — the red-team verdict: P0 privacy
  (CRITICAL), P1 cycle-funded-as-subscription (HIGH), P2 griefing (HIGH), P4 delivery semantics (HIGH),
  P5 controller/centralization (CRITICAL), P6 open-standard attestation (HIGH), P7 integration scope
  (MED), P8 liability (MED), P9 MemoryId contention (LOW–MED); 7 gated open questions.

## Top risks / open questions

1. **G1 — Which product?** (P0, blocking) Decide between an auditable *public* agent log (no privacy
   claim) or end-to-end encrypted agent mail with client-side keys and a near-dumb canister. The pitch
   conflates them. Without this decision the privacy copy is a category error on the IC.
2. **G2 — Controller model.** (P5, blocking) Is the inbox controller the owner principal (sovereign,
   immutability tradeoff) or a factory (centralized, the repo's only pattern)? If factory, drop the
   "no company can revoke" copy entirely.
3. **G3 — Open vs. gated `send_message`.** (P2, blocking) Allow-list (kills "open standard"),
   cycle-priced inbound (taxes every sender), or quota-only (griefable within quota). Pick one before
   specifying the interface — `inspect_message` cannot gate inter-canister calls.
4. **G4 — Delivery semantics.** (P4, blocking) At-least-once with client-generated idempotency keys, or
   at-most-once with no-retry. State it in the protocol; "it's just a canister call" hides a real
   distributed-systems problem that on-chain transport does not solve.
5. **G5 — Cycle Burn integration scope.** (P7, blocking for the "first integration" claim) Intra-app
   (don't build — use a backend stable map) or cross-app (build, but prove on a real cross-app scenario
   first). Do not couple Cycle Burn to a new messaging canister for coordination that the existing
   backend already handles.

If those five are accepted, the remaining risks (P3 memory caps, P6 attestation, P8 liability,
P9 upgrade hygiene) are manageable engineering, not blockers. If they are not accepted, **DON'T BUILD** —
the result is a product whose marketing exceeds its guarantees, the exact failure mode this repo's
prior adversarial reviews (X-Farm R0/R2, proposal-discussions) were written to avoid.