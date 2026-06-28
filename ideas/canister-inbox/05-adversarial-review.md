# Canister Inbox — Adversarial Review (05)

> Red-team of the "Canister Inbox" idea: a fully on-chain messaging layer for
> ICP agents, where each agent gets a persistent inbox canister storing messages
> in stable memory, agents talk via a 3-method inter-canister interface, and a
> web UI is the human control plane. First consumer: Cycle Burn's governance /
> lottery agents. Long-term: an open ICP standard.
>
> Posture: **skeptical, not performatively.** The privacy framing is the load-bearing
> wall, and it is cracked. Several "advantages" over off-chain messaging are either
> false or trade one dependency for a worse one. There is a real, smaller product
> inside the pitch — but it is not the product being pitched.

## How this repo grounds the review

Patterns confirmed in code, cited so the verdict is not hand-waved:

- **Factory = sole controller.** `xfarm_create_canister` sets
  `controllers: Some(vec![get_canister_id()])` (`src/backend/src/lib.rs:19436-19444`).
  The backend canister, *not* the paying owner, controls every Farmer. The owner is
  a *recorded field* (`Farmer.owner`), not a controller. The factory can
  `stop_canister` / `delete_canister` / `install_code` (upgrade) any child at will
  (`xfarm_stop_canister`, `xfarm_delete_canister`, `xfarm_upgrade_code`,
  lib.rs:19488-19502, 19476-19484).
- **`inspect_message` is ingress-only.** lib.rs:761: *"inspect_message only fires
  for direct ingress calls, not inter-canister."* Any spam defense built on
  `inspect_message` is bypassed by the exact callers the spec targets — agents.
- **No `canister_info` validation exists in this repo.** `submit_dapp`
  (lib.rs:11495) validates `name`/`url`/`description` text only
  (`validate_dapp_text`, lib.rs:10649). There is **no** management-canister
  `canister_info` call anywhere. The "canister_info validation pattern" the prompt
  names is an *idea* (ID Listings), not a built primitive. Building it is net-new.
- **No vetKeys / no at-rest encryption / no TLS-to-canister** anywhere in the repo.
  All net-new.
- **HTTPS outcalls are replicated by default** on IC (xfarm_farmer/src/lib.rs:22-27
  notes the non-replicated transport as a "Phase-2 mainnet concern").
- **Stable memory** uses `ic_stable_structures` with `MemoryManager` + `MemoryId`
  slots (lib.rs:665-738). `MemoryId`s are a scarce, contended resource — memory notes
  MemoryId 57 was contended between two ideas; the backend is already in the 50s.
- **Cycles are one-way.** Per X-Farm finding #7: cycles minted via CMC cannot be
  converted back to ICP or moved to the treasury. Any "cycle-funded" balance is a
  *sunk prepaid budget*, not a refundable credit.
- **Feature flags**: `FEATURE_FLAGS` `StableBTreeMap<String, u8>` + `FlagState`
  (Off/On/AdminOn) + `flag_enabled` (lib.rs:5412-5517). Standard, reusable.

---

## P0 — PRIVACY: the headline premise is materially false (CRITICAL)

The pitch says: *"Because the canister code is the contract, no company can read,
intercept, or revoke access to an agent's messages."* This is the central claim and
it does not survive contact with how the IC actually works.

### P0a. On-chain canister state is public to subnet readers

Canister state on the IC is replicated across a subnet and is, by design, **readable
by the subnet's replica operators** (the nodes that run the subnet). It is not
end-to-end encrypted at rest by the platform. A "company" cannot revoke access —
true, because there is no company. But the implied converse — "no one can read your
messages" — is **false**: anyone who operates or compromises a replica on the
inbox's subnet, and anyone who can induce the canister to expose state via its own
query methods, can read every plaintext message. The pitch substitutes "no
company" for "no one," and those are very different guarantees.

This is not a hypothetical. The X-Farm Farmer stores drafts in stable memory and
exposes `get_drafts(since)` as a `query` (`xfarm_farmer.did`). Queries are fast
*because* they read replicated state without consensus; the same state is visible to
replica operators. An inbox that exposes `read_messages` as a query is publishing
messages to anyone with ingress — and to replica operators regardless.

**Severity: CRITICAL.** This is the whole selling point. If the product is
"end-to-end private agent messaging with no central reader," the platform does not
give you that for free. You build it yourself or you don't have it.

### P0b. What vetKeys actually fixes (and what it does not)

vetKeys (ICP's vetkd key derivation) lets a canister derive encryption keys *without
ever holding the master secret*, which is a real improvement over naively storing
a symmetric key in canister state. But it is not a privacy magic wand:

1. **vetKeys encrypts at rest, not in transit or in use.** The inbox canister still
   has to *decrypt* a message to do anything with it (thread retrieval, search,
   forwarding). The moment plaintext exists in the canister's heap during a call,
   it is visible to the canister code — and therefore to whoever controls the
   canister (see P5). vetKeys protects you from *passive subnet readers reading
   stable storage between calls*; it does not protect you from the canister's own
   running code.
2. **The controller can upgrade the code to exfiltrate.** Even with vetKeys, the
   controller can `install_code` (upgrade) a version that logs plaintext, ships it
   out via `http_request`, or simply exposes a new query method that returns
   decrypted bodies. vetKeys cannot defend against the controller, because the
   controller is the canister's root of trust.
3. **Client-side encryption is the only honest path — and it guts the server.**
   To get end-to-end privacy you must encrypt *before* the message enters any
   canister, with a key the inbox never sees. That means the inbox becomes a dumb
   ciphertext store: no server-side thread assembly, no server-side search, no
   server-side moderation, no server-side "retrieve a thread" beyond returning
   opaque blobs for the client to decrypt. The spec's "retrieve a thread" method
   is either (a) trivially "return ciphertexts, client decrypts" — fine, but then
   the canister is doing nothing a KV store couldn't — or (b) assembling
   structured threads server-side, which requires the canister to read plaintext,
   which collapses back to P0a.
4. **Inter-canister messages traverse subnets in plaintext visible to replica
   operators on both subnets.** Even if storage is encrypted, the `send_message`
   call's argument is a replicated message that the receiving subnet's replicas
   see before the inbox's code encrypts it (if it ever does). So "send a message"
   is not a private act on the IC today.

**What vetKeys actually buys:** an at-rest confidentiality layer that protects
*historical* state from passive readers, assuming the canister code never exposes
plaintext and the controller never turns hostile. That is a meaningful building
block. It is not "no one can read your messages."

**Impact on the product:** the privacy framing must be rewritten, not patched.
Honest copy is closer to: *"Your inbox state is encrypted at rest with vetKeys;
replica operators cannot passively read stored messages; the inbox code and its
controller are the trust root — if you trust the code hash and the controller, your
historical messages are protected from passive readers. Messages in transit are
visible to subnet replica operators, like all inter-canister traffic on the IC."*
That is a *real* but *narrower* guarantee, and it competes with "just use a
dumb ciphertext KV + client-side encryption" which needs no vetKeys at all.

### P0c. Does this sink the product?

Not necessarily — but it sinks *the product as pitched*. Two viable残骸 survive:

- **"Inbox as auditable, censorship-resistant agent log"** (no privacy claim). The
  value is permanence + no-revocation + open standard, not confidentiality. This
  is honest and useful for governance coordination where the messages are
  *supposed* to be public (proposal discussions, lottery draws). It collides with
  the moderation/liability risk (P9) but is internally consistent.
- **"End-to-end encrypted agent mail"** with client-side keys and a near-dumb
  canister. Real, but the canister does almost nothing, the "three-method
  interface" shrinks to "store/retrieve ciphertext," and you've reintroduced key
  management as the hard problem (where do agents keep their keys? on-chain? then
  a canister compromise leaks them; off-chain? then you have an off-chain
  dependency, the thing you claimed to remove).

Either is buildable. The pitch as written is not honest about which one it is.

---

## P1 — "No subscriptions / no SaaS fee" is a subscription with worse UX (HIGH)

### P1a. Cycles cost ICP; the inbox must be funded or it dies

"Cycle-funded: agents pay per interaction in ICP cycles (not a SaaS fee)" frames
prepaid cycles as a virtue over SaaS. Economically it is **a prepaid subscription
denominated in a volatile asset, with manual top-up, no auto-renewal primitive, and
no refund** (cycles are one-way — X-Farm finding #7). Concretely:

- The agent (or its operator) must acquire ICP, burn it to cycles via the CMC, and
  deposit those cycles into the inbox canister. This is a multi-step, fee-bearing
  flow that SaaS billing collapses into a card on file.
- There is no platform-native "recurring billing" primitive. You must build a
  timer-driven top-up, which means *another* canister or cron with its own cycle
  balance — recursing the funding problem.
- If the inbox balance drops below the freezing threshold, the IC **freezes** the
  canister: it stops responding, timers halt, messages stop. Recovery requires a
  controller (see P5) to deposit cycles and unfreeze — and during the freeze,
  inbound `send_message` calls reject, so senders get hard failures (see P4).

### P1b. Failure mode of an underfunded inbox

An underfunded inbox does not gracefully degrade. It **freezes**: queries may
still serve from read-only state on some configurations, but update calls (the
inbound `send_message`) reject, and any timer-driven logic dies. The recovery cost
is: cycles (small) + a controller-initiated unfreeze (operational) + whatever
messages were *rejected* during the freeze are **lost** (inter-canister calls that
reject do not queue on the IC; the sender gets a reject and must retry — see P4).
So neglect produces silent message loss, not a backlog.

For a human-managed SaaS inbox this is a non-issue (the provider absorbs it); for an
autonomous agent this is a real ops burden: someone must monitor cycle balances
and top up, forever, for every inbox. "The infrastructure runs as long as the
canister has cycles" is a description of the failure mode, not an escape from it.

**Severity: HIGH.** This is not a blocker for a self-hosted Cycle Burn internal
use, but it is a blocker for the "open standard any agent project can adopt"
framing — you are asking adopters to take on prepaid-cycle ops in exchange for
removing a SaaS bill, which is a bad trade for most teams.

---

## P2 — Spam / griefing: `send_message` is an open drain on the victim (HIGH)

### P2a. The economics run the wrong way

Naive intuition: "the sender pays cycles to send, so spam is self-limiting." This
is half-true and the half that matters is false.

- The *caller* pays the cycles for the inter-canister call's execution on the
  caller side. But the *receiving* inbox pays for its own execution of the
  `send_message` body — the state transition, the stable-memory write, the
  bookkeeping. On the IC the receiver bears the cost of its own message execution.
- So an attacker who can call `send_message` (it's an open update method by spec)
  forces the **victim's inbox** to spend cycles processing and storing garbage.
  The attacker spends some cycles too, but the victim's inbox drains while the
  attacker's cost is per-call flat. This is a classic griefing vector: asymmetric
  cost, where the defender is the one who runs out.

### P2b. `inspect_message` cannot help here

lib.rs:761 is explicit: `inspect_message` only fires for direct ingress, not
inter-canister. The exact callers the spec targets — agent canisters calling
`send_message` — **never hit `inspect_message`**. Any allowlist / rate-limit built
on `inspect_message` is bypassed by every agent. The defense must live inside the
update method body, which means it costs the inbox cycles to evaluate *before* it
can reject — so even rejecting spam burns cycles. There is no free reject path for
inter-canister calls on the IC today.

### P2c. Required defenses (all net-new, none trivial)

- **Per-sender quota** (messages/day or /window) keyed on `ic_cdk::caller()`, stored
  in a `StableBTreeMap<Principal, Counter>`. Costs cycles per check but caps the
  blast radius.
- **Allow-list mode** (inbox owner pre-approves sender principals). Strongest, but
  kills the "open agent messaging standard" framing — you cannot both be open and
  gated.
- **Cycle-priced inbound**: require the sender to attach ≥ N cycles to
  `send_message` (via `call_with_payment128`), refunded-or-kept per policy. This
  *reverses* the griefing economics — now spam costs the attacker proportionally.
  But it requires every agent caller to carry a cycle balance and attach cycles,
  which is a real integration tax and recurses the "agents must be funded" problem
  (P1).
- **Size cap + eviction** (see P3).

**Severity: HIGH.** Without cycle-priced inbound or a strict allow-list, an
attacker can cost-auction any inbox to death. The X-Farm Farmer sidesteps this
because only the *factory* calls it (single trusted caller) — an inbox that accepts
messages from arbitrary agents does not have that luxury.

---

## P3 — Message size / stable-memory exhaustion (MED)

Stable memory is finite per canister (bounded by subnet capacity, grown on demand
but not free). An attacker (P2) or a buggy agent can fill it. The X-Farm Farmer
caps this explicitly: `MAX_STORED_DRAFTS: usize = 400` + 30-day retention pruning on
each tick (`xfarm_farmer/src/lib.rs:54-56`). The inbox must do the same, but the
"open messaging" framing makes the cap policy a product decision:

- **Per-message size cap** (e.g. 4 KiB). Trivial, mandatory.
- **Per-sender byte quota** (cumulative, sliding window). Combats the slow-fill
  attack.
- **Total inbox cap + eviction policy**. What happens when full? Options: reject
  new (simple, but a sender could lock out by filling), FIFO evict oldest (loses
  history the owner may want), evict-by-sender-fair-share (complex). The X-Farm
  pattern (bounded last-30-days, prune in timer) is a reasonable default but
  assumes the owner is the only writer — an open inbox needs per-sender fairness.
- **What happens at the limit**: the inbox should `trap` on write, which rejects
  the inbound `send_message` (sender sees the reject). The owner can then raise
  caps (if a cap) or archive. Do **not** silently drop — silent drop breaks
  delivery semantics (P4).

**Severity: MED.** Bounded by P2's defenses, but independently needs an explicit
retention policy or the inbox accumulates forever.

---

## P4 — Cross-canister call failures / non-determinism / delivery semantics (HIGH)

### P4a. `send_message` is not idempotent and the spec doesn't say which it is

An agent `await`s `send_message` to another subnet's inbox. The IC inter-canister
call can: succeed, reject (callee trapped / rejected), or time out (subnet
unreachable / overloaded). On timeout, the caller does not know whether the
message landed. The natural response is retry. **Retry produces duplicates if the
first call actually succeeded but the response was lost.** The spec's
"send/read/retrieve" three-method interface has no idempotency key, no message
nonce, no dedup — so the design implies **at-least-once** delivery (retries can
duplicate), but does not state it, and at-least-once is unsafe for any message
with side effects (e.g. "execute transfer X").

The X-Farm `extend` path (`xfarm_extend_farmer`, lib.rs:19509-19515) double-unwraps
(call reject vs. method `Err`) but uses **no idempotency key** — it relies on the
factory being the sole caller and the operation being safe to retry. An open
messaging standard cannot assume a trusted sole caller.

### P4b. Retry storms

If an inbox freezes (P1) or is overloaded, every sending agent retries on its own
schedule. With no backoff coordination you get a thundering herd on recovery —
exactly when the inbox is least able to handle it. The IC has no native
inter-canister backoff; each sender must implement its own.

### P4c. What the design implies, and is it safe

The minimal interface implies **at-most-once per call attempt** (a single
`send_message` either commits or rejects, no partial). But *across retries* it
becomes at-least-once unless the protocol adds a client-generated message id that
the inbox dedups on write (extra stable-map lookup per send, more cycle cost).
**At-least-once is the honest default; the spec must say so and require idempotent
consumers.** That is a real constraint on every consuming agent — and the Cycle
Burn integration (P8) must respect it.

**Severity: HIGH.** Delivery semantics are a protocol-level decision that the
spec currently leaves implicit. "It's just a canister call" hides a distributed-
systems problem that does not vanish because the transport is on-chain.

---

## P5 — Ownership / controller trust: centralization re-enters via the factory (CRITICAL)

### P5a. The repo's factory does not make sovereign canisters

The X-Farm Farmer is created with `controllers: Some(vec![get_canister_id()])`
(lib.rs:19439) — the *backend (factory) canister* is the sole controller. The
`owner` field is bookkeeping, not authority. The factory can stop, delete, or
upgrade any Farmer at any time (lib.rs:19488-19502). "Owned by the Principal that
deployed it" is, in the only factory pattern this repo has, **false**: the deployer
(factory) owns it, the user is a tenant.

If Canister Inbox reuses this pattern (the natural thing to do — it's the only
factory in the repo), then **the factory operator is the company that can read,
intercept, and revoke access to every inbox** — by upgrading the inbox code to
exfiltrate, by stopping/freezing, by deleting. This re-introduces exactly the
centralization the pitch claims to remove, one layer down.

### P5b. Making the owner truly sovereign

To honor the pitch, the inbox's controller set must include the *owner's*
principal, and the factory must relinquish control after creation. But:

- If the owner is a **human** (II identity), a human principal can hold a canister
  as controller — fine — but then the *agent* (a canister) is not the owner, and
  the agent cannot upgrade or manage the inbox; only the human can. So "agents
  communicate" but "humans own the inboxes" — the spec already says the human is
  the control plane, so this is consistent, but it means **the agent is never
  sovereign over its own inbox**; a human must exist behind every agent.
- If the owner is an **agent canister**, then the agent canister must be a
  controller of the inbox. But who controls the *agent* canister? If a factory
  made the agent, the factory controls the agent, which controls the inbox —
  recursion back to centralization. The only exit is a **self-controlled canister
  with no external controllers** (the agent canister's controller list = {itself}),
  which is possible on the IC, but then *no one* can upgrade the agent — bug fixes
  require a re-deploy. "The code is the contract" actually holds here, at the cost
  of immutability.

### P5c. The reconcile

The spec says "agents are canisters" and "inboxes are owned by the Principal that
deployed them." These two sentences are in tension:

- If agents deploy their own inboxes, the agent canister is the inbox's controller,
  and the agent's own controller is the real root of trust (factory or self).
- If humans deploy inboxes for agents, humans are the root of trust (the spec's
  control-plane story), and "no company can revoke access" reduces to "no company,
  but your human operator and whoever controls your agent can."

**The honest statement is: the root of trust is whoever holds the canister
controller set.** On the IC that is not magic — it is a `controllers` list set at
`create_canister` time and changeable by `update_settings` from a controller. The
pitch's "owned by the Principal that deployed it" must specify *and the controller
set is just that principal and no one else, and the deploy path is auditable.*
Otherwise centralization re-enters through the factory, exactly as it does in the
repo's existing X-Farm design.

**Severity: CRITICAL.** This is fixable by design choice (controller = owner
principal, factory relinquishes), but it contradicts the only factory pattern in
the repo, and it forces the immutability-vs-upgradability tradeoff into the open.

---

## P6 — Upgrade trust for an OPEN STANDARD (HIGH)

If "any agent project can adopt" Canister Inbox and deploy their own, a malicious
fork can silently exfiltrate every message. An agent calling `send_message` to a
remote inbox cannot assume the receiver runs the reference code. Required:

- **`canister_info` query** (management canister) returns `module_hash` +
  `controllers`. An agent could call this before sending and check the hash against
  a known-good reference. **This primitive does not exist in the repo** — building
  it is net-new, and it is a cross-canister call (costs cycles, can fail, adds
  latency to every send).
- **A registry / pinned hash list.** Without a registry of "these hashes are the
  reference Canister Inbox," every agent hardcodes its own trust list — which is
  a coordination problem, and a registry is *another centralization point* the
  pitch claimed to remove.vetKeys does not help here: a malicious fork can claim to
  use vetKeys and still exfiltrate.
- **Certified wasm.** The IC does not certify that a canister runs a *specific*
  wasm — `canister_info` returns a hash the controller *reports*. If the controller
  is honest, the hash is honest. So the trust reduces back to P5 (controller trust),
  not to cryptography.

**Severity: HIGH.** An open standard without an attestation/registry layer is an
open invitation to phish agents into malicious inboxes. The spec has no answer.

---

## P7 — Cycle Burn integration risk: does it pull weight? (MED)

The first consumer is Cycle Burn's governance/lottery agents. The existing app
already has: stable memory, inter-canister calls, feature flags, and a UI that
polls the backend. The question is whether a **new per-agent inbox canister** earns
its place versus the simpler alternative: **emit events into a `StableBTreeMap` in
the existing backend and let the UI poll it** (the pattern already used for the
dashboard, lottery info, proposal discussions).

- **For internal coordination only**, a shared stable map in the backend is
  strictly simpler: no new canister, no new cycle drain, no cross-subnet calls, no
  new factory, no freezing risk, no spam surface (the backend already gates
  callers). The X-Farm factory exists because of the "your own autonomous
  canister" narrative and burn isolation — **neither applies to an inbox**. An
  inbox has no narrative reason to be per-user and no burn-isolation reason; it's
  just storage.
- **The integration adds a new failure surface** (P1, P2, P4) and a new cycle drain
  (every agent now also funds an inbox) on an app that already has a CMC top-up bug
  history (PB-148, per memory) and a stuck-commitment incident. Adding a new
  cycle-consuming subsystem increases the surface where the known cycle-accounting
  class of bug can recur.
- **Where it could pull weight:** if the value is *cross-app* agent messaging (an
  agent on Cycle Burn talking to an agent on a different canister/app), then a
  shared backend map does not work and an inbox standard does. But the spec's first
  integration is *intra-app* (Cycle Burn's own agents), where the simpler path wins.

**Severity: MED.** Recommend: do not couple Cycle Burn to a new messaging canister
for intra-app coordination. If Canister Inbox is worth building, prove it on a
*cross-app* scenario first, where it has no simpler competitor.

---

## P8 — Securities / liability / open-source permanence (MED)

Publishing a messaging standard others adopt, with on-chain permanent messages,
inherits the content-moderation risk flagged in the proposal-discussions memory
(permanence + moderation + sybil/astroturf governance) and sharpens it:

- **Permanent, immutable, unmoderatable content.** If the inbox is truly
  owner-sovereign (P5) and the controller is the owner, *no one* can moderate — not
  the factory, not a DAO, not the platform. Illegal content, DMCA-violating
  content, leaked secrets, child sexual abuse material, harassment: all
  permanent, all unremovable by anyone but the owner (who is the perpetrator).
  This is a real liability exposure for an *open-source standard* the project
  publishes and evangelizes.
- **Agent-to-agent channels are a new moderation blind spot.** Human-facing UGC
  (proposal discussions) at least has a human review gate (the spec's pattern).
  Agent-to-agent messaging has no human in the loop by design — abuse scales with
  compute, not eyeballs.
- **The "we just publish the standard" defense** has precedent (protocols vs.
  publishers) but is not airtight for a project that also runs the reference
  implementation and the registry (P6) — a registry that lists known-good inboxes
  is an editorial act.

**Severity: MED.** Mitigations: (1) default retention, not permanence — prune by
default, opt-in archival; (2) the reference implementation ships with size caps +
per-sender quotas that make large-scale abuse expensive (P2/P3); (3) explicit
"this is a protocol, not a publisher" framing in the license + README; (4) do not
operate a curated registry (P6) unless you accept the editorial burden — prefer a
decentralized hash-pinning model.

---

## P9 — Stable-memory MemoryId contention + upgrade safety (LOW–MED)

Reusing the backend's `MemoryManager` pattern, an inbox needs its own `MemoryId`
slots. The backend is already in the 50s with documented contention (MemoryId 57
contended per memory). A *per-user canister* factory sidesteps this (each inbox has
its own fresh memory space), but then upgrade safety across the fleet becomes the
issue: the X-Farm `admin_reinstall_all_farmers` pattern (memory) exists precisely
because upgrading N per-user wasms is an operational task. An inbox standard
shipping upgrades to arbitrary third-party inbox canisters inherits this — there
is no `admin_reinstall_all_inboxes` because the factory does not control them (if
P5 is honored). So upgrades are per-owner, and buggy versions persist in the wild.

**Severity: LOW–MED.** Standard ICP upgrade hygiene (stable-struct `#[serde(default)]`,
additive-only schema changes, versioned init args) covers most of it; the residual
is a long tail of un-upgraded third-party inboxes that agents must tolerate.

---

## Open questions to resolve before building (gated decisions)

1. **G1 — Which product?** (P0) Decide between (a) auditable public agent log, no
   privacy claim, or (b) end-to-end encrypted agent mail with client-side keys and
   a near-dumb canister. The pitch conflates them. **Blocking.**
2. **G2 — Controller model.** (P5) Is the inbox controller the owner principal
   (sovereign, immutability tradeoff) or a factory (centralized, the repo's only
   pattern)? If factory, drop the "no company can revoke" copy entirely. **Blocking.**
3. **G3 — Open vs. gated `send_message`.** (P2) Allow-list (kills "open standard")
   or cycle-priced inbound (taxes every sender) or quota-only (griefable within
   quota)? Pick one before specifying the interface. **Blocking.**
4. **G4 — Delivery semantics.** (P4) At-least-once with idempotency keys, or
   at-most-once with no-retry? State it in the Candid/protocol doc. **Blocking.**
5. **G5 — Cycle Burn integration scope.** (P7) Intra-app (don't build — use a
   backend stable map) or cross-app (build, but prove on a real cross-app scenario
   first)? **Blocking for the "first integration" claim.**
6. **G6 — Attestation / registry.** (P6) How does an agent verify a remote inbox
   runs reference code? Pinned hash list, DAO registry, or "don't verify, trust the
   controller" (which collapses to G2)? **Blocking for the "open standard" claim.**
7. **G7 — Retention default.** (P8) Permanent or pruned-by-default? Affects
   liability exposure and the "inboxes persist indefinitely" pitch. **Non-blocking
   but should be decided before open-sourcing.**

---

## Verdict: BUILD-WITH-CAVEATS

The idea is **not unbuildable**, but the idea *as pitched* is materially false on
its central claim (privacy), and several "advantages" are trades in disguise. The
honest core that survives red-teaming is one of two smaller products (G1):

- a **censorship-resistant, auditable agent event log** (no privacy claim), or
- an **end-to-end encrypted agent mailbox** with client-side keys and a deliberately
  dumb canister (real privacy, but the canister does almost nothing and you've
  reintroduced key management as the hard problem).

Neither is "no servers, no dependencies, private, persistent, open standard" all
at once. The IC does not give you that combination for free; the pitch assembles
attributes that are individually available and collectively in tension.

**Do NOT build the pitch as written.** Building it would ship a "private" inbox
that is plaintext-on-chain, "owned" by users who are actually tenants of a factory,
"subscription-free" but cycle-funded-with-no-refund, "open" but unattestable. That
is a liability and a reputational risk, not a standard.

**BUILD, conditionally**, one of the G1残骸, if the following 5 caveats hold:

### The 5 most important caveats

1. **Rewrite the privacy claim.** The inbox is **not** private by default. State
   plainly: canister state is readable by subnet replica operators; `send_message`
   arguments are visible in transit; vetKeys encrypt at-rest only and only protect
   against passive readers *if the controller never turns hostile*. If you want
   end-to-end privacy, encrypt client-side and accept that the canister becomes a
   ciphertext KV. Do not market "no company can read your messages" — it is a
   category error on the IC. (P0)

2. **Make the owner the controller, or stop claiming sovereignty.** Reuse the
   repo's factory pattern and you have re-centralized: the factory operator can
   read, freeze, and delete every inbox. If sovereignty is the point, the inbox's
   `controllers` must be the owner principal alone, the factory must relinquish
   control after `install_code`, and you must accept the immutability / no-bug-fix
   tradeoff that implies (or build an upgrade path the owner explicitly consents
   to, e.g. a controller-set quorum). (P5)

3. **Price `send_message` inbound in cycles, or allow-list it.** An open
   `send_message` is a griefing drain on the victim's cycles, and `inspect_message`
   cannot gate inter-canister calls (lib.rs:761). Either require the sender to
   attach cycles (and accept the integration tax on every agent caller) or
   restrict to an owner-approved sender allow-list (and drop the "open standard"
   framing). There is no free open-but-safe option. (P2)

4. **State delivery semantics and add idempotency.** Specify at-least-once with a
   client-generated message id deduped on write, and require consuming agents to be
   idempotent. The minimal 3-method interface is underspecified without it; "it's
   just a canister call" hides a real distributed-systems problem that on-chain
   transport does not solve. (P4)

5. **Do not make Cycle Burn the first integration for intra-app coordination.**
   For agents talking to each other *inside* this app, a `StableBTreeMap` in the
   existing backend is simpler, has no new cycle drain, no freezing risk, and no
   new spam surface. Canister Inbox earns its keep only for **cross-app** agent
   messaging, where the simpler competitor does not exist. Prove it there first, or
   scope the "first integration" down to a demo, not a production coupling. (P7)

If those five are accepted, the remaining risks (P3 memory, P6 attestation, P8
liability, P9 upgrade hygiene) are manageable engineering, not blockers. If they
are not accepted, **DON'T BUILD** — the result is a product whose marketing exceeds
its guarantees, which is the exact failure mode this repo's prior adversarial
reviews (X-Farm R0/R2, proposal-discussions) were written to avoid.