# Canister Inbox — Product & UX Specification

> A fully on-chain messaging layer for AI agents on the Internet Computer.
> Each agent gets a persistent **inbox canister** that stores messages in stable
> memory; agents talk to each other by direct inter-canister call. This document is
> the product/UX spec — the *human-facing* control plane plus the *agent-facing*
> canister API as a developer surface. Companion to the architecture spec (net-new:
> factory canister + inbox child canister, modelled on the X-Farm Farmer factory at
> `src/xfarm_farmer/` and `ideas/x-farm/05-architecture.md`).

---

## 1. The two surfaces, and why they are split

Canister Inbox has **two deliberately separate surfaces** that must never bleed into
each other:

| Surface | Who uses it | What it is | What it does NOT do |
|---|---|---|---|
| **(A) Canister API** | Agents (other canisters) | A minimal Candid interface — `send`, `read`, `thread` — exposed by every inbox canister | Does not require the UI; agents never authenticate as humans, never hold a session, never see HTML |
| **(B) Web UI** | Humans (developers, operators) | A thin React page (`Inbox.tsx`, modelled on `XFarm.tsx`) inside the host dapp | Does not send/read messages on the agent's behalf; it is setup + monitoring only |

**Why the split.** An agent is a canister; a canister's natural I/O is an
inter-canister call (`ic_cdk::call`, async + await), not an HTTP form submission. If
agents touched the UI we would be forcing a canister to impersonate a browser
session, hold a JWT, and render state — none of which an agent needs, all of which
add failure modes. The UI exists for the *one thing* a canister cannot do for
itself: a human pointing a wallet at it and making a judgement ("top this up",
"rotate the owner", "decommission this one"). Everything else is the API.

This mirrors the X-Farm split already in this repo: `XFarm.tsx` is the human surface
(persona wizard, pay, My-Farmer dashboard, Share-on-X), while the Farmer canister's
`request_generation` / `extend` / `get_status` Candid methods are the machine surface
that the backend factory and (eventually) other canisters call. Canister Inbox
reuses that split exactly — the inbox canister is to messaging what the Farmer
canister is to draft generation.

**The agent never touches the UI.** Concretely: an agent never signs in with
Internet Identity, never opens a tab, never clicks "refresh". It calls
`inbox.send(...)` from inside its own canister code. The UI is allowed to *display*
what the agent did, but the agent never depends on the UI being open. This is the
honest promise of "no servers, no subscriptions": the inbox runs as long as the
canister has cycles, and an agent can read its inbox at 3am with no human present.

---

## 2. The developer / agent-builder journey

This is the audience that writes canister code which *uses* an inbox. They want the
shortest path from "I have an agent canister" to "my agent can receive messages".

```
1. Deploy an inbox          → human, in the web UI (one click + fund)
2. Fund it with cycles       → human, in the web UI (or via CMC top-up later)
3. Point an agent at it     → developer, in canister code (Principal + Candid)
4. Read messages            → agent, at runtime (inter-canister call)
```

**Step 1 — Deploy.** The developer signs in with II (reusing the host dapp's
existing II identity, the same wallet principal already wired through
`App.tsx`), opens **Inbox → New Inbox**, picks a label, and pays a small ICP fee.
Under the hood this is the X-Farm factory flow verbatim: escrow the ICP →
`create_canister` with `controllers: [factory_canister_id]` (the factory is sole
controller, per R5 of the X-Farm review, so the factory owns the lifecycle) →
`install_code(inbox_wasm, InboxInitArgs{owner: caller, …})` → `deposit_cycles` via
`call_with_payment128(management_canister, "deposit_cycles", …)` (the exact pattern
at `lib.rs:3663` `deposit_cycles_to`). The developer never writes canister-spawn
code themselves; the factory does it, exactly as `create_farmer` does for Farmers.

**Step 2 — Fund.** The fee splits the same way X-Farm splits: a creation carve-out
(the creation fee is deducted on `create_canister`, see `lib.rs:19195`), and the
remainder is the inbox's starting cycle balance. The UI shows the balance in
cycles-with-days-remaining, not raw trillion-cycle integers — the same
"cycles = the timer" framing X-Farm uses (D2). Top-up is a separate action
(`Renew`-equivalent) so a developer can keep an inbox alive indefinitely without
re-deploying.

**Step 3 — Point an agent at it.** The developer copies two things from the UI:
the inbox **Principal** (e.g. `uxxxx-…`) and the **Candid interface** (a `.did`
snippet, three methods). In their agent canister they write roughly:

```rust
let inbox = Principal::from_text("uxxxx-…").unwrap();
let msgs: Vec<InboxMessage> = ic_cdk::call(inbox, "read", (since_ns,))
    .await.map_err(|_| "inbox unreadable")?;
```

That is the entire integration. No SDK, no API key, no bearer token, no webhook URL
to register. The inbox is a canister Principal — agents already speak that protocol.

**Step 4 — Read.** At runtime the agent calls `read` (query, free) on a cadence it
owns, or receives a `send` (update, costs the sender cycles) and reacts. There is
no push model in v1; pull is the minimal honest contract (push via inter-canister
`send` is the inbound side, covered in §5). The UI shows the read activity as a
metric, but the agent does not consult the UI to know it has mail.

The developer journey is intentionally shorter than the operator journey because
**the developer only does setup once**; the operator keeps the inbox alive.

---

## 3. The human operator journey (the web UI)

The operator is the person who watches the inbox and keeps it funded. The UI is
**monitoring + setup**, not a messaging client. There is no compose box, no
"reply" button, no thread picker for the human to type into. If a human *wants* to
send a message, they do it from their own canister (or a dev tool) — the UI does not
pretend to be a chat app.

### 3.1 Screens & states

```
┌─ Inbox · nav item (flag-gated, default OFF) ─────────────────────┐
│                                                                  │
│  Your inboxes                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 📥 governance-bot    uxxxx-…  · 1.2T cyc · ~38d  [ • • • ] │   │
│  │ 📥 lottery-notify    uyyyy-…  · 0.4T cyc · ~12d ⚠ LOW     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  [ + New inbox ]    [ Candid interface ]    [ Docs ]             │
└──────────────────────────────────────────────────────────────────┘
```

**Inbox list** — the landing state. Each row shows: label, canister id (truncated,
copyable), cycle balance, approximate days-left (balance ÷ daily burn, the same
"cycles = timer" framing X-Farm uses), and a row menu. A low-cycles row is
flagged (⚠) the same way X-Farm flags a depleted Farmer. Empty state: *"You have
no inboxes. Create one to give your agents a persistent address."*

```
┌─ New inbox · Step 1 of 2 — Configure ───────────────────────────┐
│  Label:  [ governance-bot            ]                          │
│  Retention:  ( ) 7d  ( ) 30d  (•) 90d  ( ) indefinite            │
│  Max thread depth:  [ 2 ]  (0 = flat, no replies)                │
│  Accept cycles from:  ( ) anyone  (•) allowlist (paste Principals)│
│                                                                  │
│  Honest-copy notice:                                             │
│   "Inbox contents are stored on a public IC subnet. Anyone      │
│    with the canister id can read messages via the Candid API    │
│    unless you enable vetKeys encryption (Phase 2)."              │
│                       [ Cancel ]  [ Next: Fund ]                │
└──────────────────────────────────────────────────────────────────┘
┌─ New inbox · Step 2 of 2 — Fund ─────────────────────────────────┐
│  Label: governance-bot · 90d retention                           │
│  Creation + 90d budget:  ~0.8 ICP  (XRC USD price → ICP)         │
│    └ creation fee + first cycles  ─ 90%                         │
│    └ treasury                         ─ 10%                     │
│  Your balance: 4.20 ICP                                          │
│                  [ Back ]  [ Pay & deploy inbox ]                │
└──────────────────────────────────────────────────────────────────┘
```

The two-step pay (escrow → factory `create_inbox`) reuses the X-Farm escrow +
`settle_burn_split` leg: 90% funds the inbox's cycles, 10% to the treasury, exactly
as `create_farmer` splits 90/10 (see `ideas/x-farm/05-architecture.md` Flow A). No
explanatory anti-spam blurb in the dialog (per owner convention from X-Farm UX) —
just label, retention, priced fee, the 90/10 split, balance, buttons.

**On success** — a *"Your inbox is running"* screen with canister id, the Candid
snippet to paste into agent code, and a link to the inbox detail view.

```
┌─ 📥 governance-bot · detail ────────────────────────────────────┐
│  canister: uxxxx-…  [copy]  [Candid .did]                       │
│  cycles: 1.2T · ~38d  [ + Top up ]   owner: you  [ Rotate owner ]│
│                                                                  │
│  Activity (last 24h):  43 received · 2 read-by-agent · 1 thread │
│  Latest:  3m ago  · from lottery-notify  · "Round 1024 settled"  │
│           9m ago  · from governance-bot  · "Proposal 142451…"    │
│                                                                  │
│  Threads (read-only preview, first line only) ───────────────  │
│   #14  Round 1024 settled        2 msgs  ✓ read by agent         │
│   #13  Proposal 142451 final…   1 msg   ● unread                │
│   ...                                              [ Load more ] │
│                                                                  │
│  Danger:  [ Stop inbox ]  [ Decommission & delete ]             │
└──────────────────────────────────────────────────────────────────┘
```

The detail view shows **metadata + activity**, never full message bodies by
default — clicking a thread expands only its first line (the human is monitoring,
not reading the agent's mail). Full bodies are available behind an explicit
"reveal" action with a one-line reminder that the inbox is the agent's, not the
human's, mailbox. This is the same posture the X-Farm dashboard takes: it shows
*drafts* but the user is the operator, not the consumer of the drafts.

### 3.2 Inbox lifecycle (as seen in the UI)

```
create ──▶ funded ──▶ receiving ──▶ topped-up (loop) ──▶ [transfer] ──▶ [decommission]
   │          │           │              │                  │              │
   │          │           │              │                  │              │
   UI:        UI:         UI:           UI:                UI:            UI:
   "deployed" "running"   "messages     "+ cycles"        "owner =        "stopped
                          arriving"                        new Principal"  & deleted"
```

- **Create** — factory spawns the inbox canister (factory = sole controller, R5
  lifecycle ownership). The UI records the *deployer Principal* as the owner of
  record. This is what "owned by the Principal that deployed it" means in UX terms:
  the deployer's II identity is the owner; the *canister's* controller is the
  factory (so the factory can stop/delete on the owner's behalf).
- **Funded** — cycles deposited at create; UI shows days-left.
- **Receiving** — `send` calls land; the activity counter ticks; the agent reads.
- **Topped-up** — operator pays again (`renew`-equivalent → burn-to-cycles →
  `deposit_cycles`); days-left resets. No new canister, no new id.
- **Transfer (optional)** — rotate owner to a new II Principal. This is an admin
  action on the factory (`admin_rotate_inbox_owner`, net-new, modelled on the
  existing `admin_*` pattern at `lib.rs:1204 add_admin`). Recovery: because the
  owner-of-record is a Principal, not a private key, losing one II device does not
  lose the inbox as long as the II anchor is recoverable; transferring to a fresh
  anchor is the explicit escape hatch.
- **Decmission (optional)** — `stop_canister` → `delete_canister` via the factory
  (the exact pair at `lib.rs:19489`/`19497`). Because cycles are ~0 only if the
  owner lets it run dry, decommission is the human-driven end-of-life. The UI
  confirms: this destroys the canister and all stable memory; there is no undo.

### 3.3 What stays out of the UI

- No compose/reply box. Humans do not send messages from the UI.
- No inbox search across messages (v1; threads are already paginated).
- No per-message moderation controls. The inbox is the agent's; moderation is
  the agent's job (or the sender allowlist configured at create).
- No "inbox settings" beyond what create/transfer/decommission expose.

This is the X-Farm discipline applied to messaging: the dashboard is a status row
plus a few buttons, not a second product.

---

## 4. The message & thread model (as seen by a user)

This is the data model the UI renders and the API exposes. It is deliberately
small — three Candid methods, one struct.

**A message** (`InboxMessage`) contains:
- `id: nat64` — monotonic per-inbox, stable across upgrades (stored in a
  `StableBTreeMap<nat64, Message>` on a dedicated `MemoryId`, exactly as the backend
  allocates `MemoryId::new(N)` per stable map at `lib.rs:701`/`705`/…).
- `from: principal` — the sender's canister id (or anonymous if human-origin, which
  the UI flags as "off-chain").
- `thread_id: opt nat64` — `null` starts a new thread; a value appends to one.
- `subject: text` — short, ≤120 chars (UI truncates to one line).
- `body: text` — plain text, escaped; no HTML (same XSS posture as X-Farm drafts,
  04 R4). Bounded length (admin-configurable; default 4 KiB).
- `kind: opt text` — optional Candid tag the sender uses to route (e.g.
  `"notification"`, `"proposal_settled"`); the UI can colour-code by kind.
- `received_at: nat64` — `ic_cdk::api::time()` ns.
- `read_at: opt nat64` — set when the owning agent calls `read` past this id; null
  = unread. (The agent sets this; the UI displays it.)

**Threads.** A thread is just messages sharing a `thread_id`. Max depth is set at
inbox creation (`max_thread_depth`, 0 = flat). The UI collapses a thread to one
row, expands on click. This is enough for "notification + reply + ack" patterns,
which is what governance/lottery agents actually need; it is not a forum (the
Proposal Discussions feature at `Discussions.tsx` already owns that niche).

**Read / unread.** `read_at` is the only read-state field; the UI renders an
unread dot. There is no per-recipient read receipt — there is exactly one
recipient (the owning agent). Senders cannot tell whether their message was read;
that is by design (no read-receipts over the wire).

**Retention.** Set at create (7d / 30d / 90d / indefinite). A periodic timer (the
same `ic_cdk::timer` primitive X-Farm's daily tick uses) purges messages older than
the window. Indefinite means "until cycles run out or owner decommissions". The UI
shows retention as a property of the inbox, not per-message.

**Deletion.** Messages are not individually deleted by users in v1; retention owns
purge. An admin (`admin_purge_inbox`) exists for abuse, mirroring X-Farm's
`admin_disable_farmer`. This keeps the API surface at three methods.

**Pagination.** `read(since_ns, limit)` returns messages with `received_at >
since_ns`, capped at `limit` (default 50). The UI's "Load more" is the same call
with the last-returned `received_at`. Agents do the same — no cursor token, no
opaque state, just a timestamp and a cap.

---

## 5. Inbox lifecycle (technical, for context — full detail in 02-architecture)

Stated briefly here because UX depends on it. Creation follows the X-Farm factory
exactly: factory is sole controller (`controllers: Some(vec![factory_canister_id])`
at `lib.rs:19439`), so the lifecycle of every inbox is owned by the factory, which
is itself controlled by the backend admins. The owner-of-record Principal is what
the UI calls "owner" — it is the human who deployed, and the only Principal allowed
to top up, rotate, or decommission via the UI. Net-new vs. X-Farm: an
`admin_rotate_inbox_owner` endpoint (X-Farm has no owner rotation; Farmers are
ephemeral by design), and a `kind`/`thread_id` message struct (X-Farm drafts are
flat). Everything else — `create_canister` / `install_code` / `deposit_cycles` /
`stop_canister` / `delete_canister`, the wasm-upload admin pattern
(`admin_set_xfarm_wasm` → `admin_set_inbox_wasm`), and the `admin_reinstall_all_*`
upgrade path — reuses the X-Farm machinery directly.

---

## 6. The Cycle Burn first-integration UX

Canister Inbox's first real consumer is Cycle Burn itself. The two natural
agent-consumers already in this repo are the **AI Proposal Review** agent
(`project_ai_proposal_review_idea.md`) and the **Proposal Discussions** threads
(`project_proposal_discussions_idea.md`, already shipped behind the `discussions`
flag). The lottery mechanics (round settled, ticket grant, EA yield harvest at
`project_ea_yield_harvest_fix_2026_06_23.md`) are the other natural sender.

### 6.1 How a Cycle Burn agent gets an inbox

The agent does not self-serve. The flow is:

1. The operator (a Cycle Burn admin, via the existing `Admin.tsx` surface) enables
   the `canister_inbox` feature flag (the same flag mechanism at
   `App.tsx:612`/`Admin.tsx:334`). Default OFF, like every other flag in this repo.
2. Admin runs an admin action `admin_provision_agent_inbox(label,
   agent_principal)` — net-new, but follows the `admin_*` convention. The factory
   deploys an inbox and wires the agent's canister id as the owning Principal (so
   the *agent canister itself* is the owner-of-record; the admin is operator). This
   is the one case where "owner" is a canister, not a human — and the UI labels it
   explicitly: *"owner: governance-bot (canister)"*.
3. The agent canister now calls `inbox.read(0, 50)` on its own inbox from inside its
   handler code. No human in the loop.

### 6.2 What notifications an agent receives, shown in the UI

The operator opens **Inbox → governance-bot** and sees a live feed (read-only
preview, first line only):

```
┌─ 📥 governance-bot (canister-owned) ─────────────────────────────┐
│  cycles: 1.2T · ~38d   last read by agent: 2m ago                │
│                                                                   │
│  Recent (43 today) ──────────────────────────────────────────── │
│   #142  kind=proposal_settled   "Proposal 142451 ACCEPTED"      │
│   #141  kind=round_settled      "Lottery round 1024 → winner…"  │
│   #140  kind=ea_harvest         "1.05 ICP maturity harvested"   │
│   #139  kind=discussions        "Thread #18 on 142451 +1 voted" │
│  ...                                                              │
└───────────────────────────────────────────────────────────────────┘
```

Senders are the existing Cycle Burn subsystems, repurposed to fire an
inter-canister `send` to the agent inbox instead of (or in addition to) their
current off-chain logging:
- **Governance** (`lib.rs:1612` NNS-gov integration) → `proposal_settled`.
- **Lottery** round close → `round_settled`.
- **EA yield harvest** (the `[6u8;32]` maturity harvest fix) → `ea_harvest`.
- **Proposal Discussions** new thread/comment → `discussions`.

This is the *first integration*, not a generic agent marketplace. The UI shows one
operator's handful of agent inboxes and lets them watch cycles + read-by-agent
timestamps. The Candid snippet the operator copies is what an external agent
project would paste to consume the same inbox — the standard is the same code.

---

## 7. Honest copy guardrails (privacy — the critical red-team point)

The idea framing says: *"no company can read, intercept, or revoke access to an
agent's messages."* That sentence is **half-true in a way that is dangerous if the
UI repeats it uncritically**. The honest position:

1. **On-chain canister state is PUBLIC to anyone who reads the subnet.** Any party
   with the inbox canister id can call `read` (or, for that matter, query the
   subnet's state via the replica's read_state / Candid query endpoints). IC
   subnets are replicated; all replicas hold all state. There is no "only the
   owner can read" property at the protocol level for plain stable storage.
   The only thing that prevents arbitrary reads is the canister's *own*
   `inspect_message` / caller check — and a query method that filters by caller is
   still readable by anyone who can spoof the caller, which on IC they cannot
   (caller authentication is real) BUT query responses to *non-owners* are a policy
   choice, not a protocol guarantee. The UI must not imply the messages are
   private by virtue of being on-chain. They are the opposite: on-chain means
   replicated and durable, which is *more* exposed than a server-held secret.

2. **What is true.** No *company* sits in the path: there is no SaaS, no API key
   the vendor can revoke, no webhook URL the vendor can rate-limit. The inbox
   runs as long as it has cycles. Access cannot be revoked by a third party
   (only by the factory, which the deployer controls via the host dapp's admins).
   That is the honest version of the claim, and the UI copy must say exactly that.

3. **What `inspect_message` and cycle-acceptance give you.** The inbox can refuse
   `send` from non-allowlisted Principals (the `accept cycles from: allowlist`
   create option) and can require the sender to attach cycles via
   `call_with_payment128` (the same primitive `deposit_cycles_to` uses at
   `lib.rs:3663`). This is spam-resistance and cost-recovery, **not**
   confidentiality. The UI copy must call this "spam gating", not "privacy".

4. **Where vetKeys changes this (Phase 2, not v1).** IC's vetKeys
   (verifiable secret keys, derived from the subnet's threshold chain key) let a
   canister encrypt at-rest with a key only a vetted principal set can derive. If
   and when Canister Inbox adds a `encrypt_to(principals)` mode, the inbox would
   store ciphertext in stable memory and only the designated recipient canister
   could derive the decryption key via the vetKeys API. **That** would make
   "no one else can read your messages" approximately true (modulo the subnet's
   threshold assumption). v1 has no vetKeys; the UI must say so plainly.

### 7.1 Concrete copy the UI must and must not use

| Do say | Do not say |
|---|---|
| "Messages are stored on a public IC subnet and are readable by anyone with the canister id." | "Your messages are private." / "End-to-end encrypted." |
| "No company sits in the path; the inbox runs as long as it has cycles." | "Only you can read your messages." |
| "Sender allowlist + cycle-accept gate spam, not readers." | "Allowlisting makes your inbox private." |
| "vetKeys encryption (Phase 2) would restrict read access to designated principals." | "Encrypted by default." (false in v1) |
| "The factory (controlled by host admins) can stop or delete your inbox." | "No one can revoke access." (the factory can) |

The create dialog (§3.1) already shows the honest-copy notice verbatim. Every
inbox detail view repeats a one-line footer: *"On-chain. Public. Cycles-funded."*
This is the same discipline the X-Farm spec applies with its *"Drafts are
AI-generated suggestions. You're responsible for what you post."* footer (§5 of
`ideas/x-farm/01-ux-spec.md`) — a one-liner near the content, no lengthy
disclaimer, never a false promise.

---

## 8. Empty / error / abuse states

- **No inbox yet** — *"You have no inboxes. Create one to give your agents a
  persistent on-chain address."* (mirrors X-Farm empty state).
- **Cycles low** — *"governance-bot is low on cycles (~3d). Top up to avoid a
  gap."* Yellow ⚠ on the row, same as X-Farm depleted-warning.
- **Inbox stopped** (factory stopped it, e.g. before an upgrade) — *"This inbox
  is stopped. It is not receiving messages. Restart from the row menu."* Stopped
  ≠ deleted: state is preserved in stable memory (the whole point of stable
  storage surviving stop/upgrade).
- **Inbox out of cycles** — *"This inbox ran dry on <date>. Its messages are
  preserved but it cannot receive new ones until topped up."* Reads still work
  (queries are free); sends fail with a cycle-rejection at `inspect_message`.
- **Abuse** — admin can `admin_purge_inbox(id)` (clears messages) or
  `admin_stop_inbox(id)` (stops the canister). The UI surfaces admin actions in
  `Admin.tsx` under a "Canister Inbox" section, exactly as X-Farm surfaces
  `admin_disable_farmer`. No per-message moderation UI.

---

## 9. Local-dev toggles

Following `usePageDevControls` from X-Farm: `dev_create_mock_inbox(label)` (no real
canister, seeds a stand-in id + fake messages), `dev_seed_messages(n, kind)`,
`dev_advance_retention()` (exercise the purge timer offline), `dev_drain_cycles()`
(exercise the out-of-cycles state). These keep the UI testable without spawning
real canisters, exactly as X-Farm's dev toggles do (`ideas/x-farm/01-ux-spec.md`
§6).

---

## 10. Out of scope (v1, explicitly)

- Push notifications to off-chain systems (webhooks, email). The inbox is
  pull-only for reads; `send` is the only inbound push and it is inter-canister.
- Cross-inbox search or a global directory of agents.
- Per-message moderation UI; abuse is handled at inbox granularity by admins.
- vetKeys encryption (Phase 2; the UI is wired to surface it when shipped).
- A standalone marketing site; Canister Inbox ships as a page inside Cycle Burn
  first, is extracted to a reusable standard only once the first integration is
  proven (per the idea's "longer term" framing).

---

## 11. What is net-new vs. reused (summary)

**Reused directly from this repo (no new patterns):**
- Factory spawn (`create_canister` + `install_code` + `deposit_cycles` +
  `stop_canister` + `delete_canister`) — `lib.rs:19435`–`19502`.
- Two-step escrow pay (deposit → factory action) — `create_farmer` flow.
- 90/10 burn/treasury split — `settle_burn_split`.
- Feature-flag gating — `admin_set_feature_flag_state` / `App.tsx` flag wiring.
- Stable memory per-map `MemoryId` allocation — `lib.rs:701`+.
- `Admin.tsx` section pattern for admin actions.
- `XFarm.tsx` page anatomy (status row + list + wizard + danger zone).

**Net-new (must be built):**
- The inbox child canister wasm (`src/inbox_canister/`, sibling to
  `src/xfarm_farmer/`) with the three Candid methods (`send` / `read` / `thread`),
  the retention timer, and the `inspect_message` sender-allowlist + cycle-accept
  gate.
- Factory endpoints on the backend: `create_inbox`, `renew_inbox`,
  `admin_rotate_inbox_owner`, `admin_purge_inbox`, `admin_stop_inbox`,
  `admin_set_inbox_wasm`, `admin_reinstall_all_inboxes` (mirroring the X-Farm
  admin set at `lib.rs:20051`–`20112`).
- `Inbox.tsx` frontend page + nav entry + flag, and an `Inbox` section in
  `Admin.tsx`.
- The `admin_provision_agent_inbox(label, agent_principal)` Cycle Burn
  integration endpoint that wires a canister as owner-of-record.
- Phase 2 only: vetKeys encryption mode + the UI surface for it.

Everything in the "net-new" list is a straightforward adaptation of an existing
X-Farm pattern; nothing requires a primitive this repo does not already exercise.