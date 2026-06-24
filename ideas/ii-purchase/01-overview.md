# 01 — Overview

## What

A funding page where users (and the treasury) crowdfund ICP toward a listed idgeek
II-anchor+neuron bundle. The canister:

1. **Validates** the idgeek sale contract on-chain before any funds move — `canister_info`
   returns the contract canister's certified `module_hash` + `controllers`, compared to
   admin-pinned expected values (the "geekfactory method," reused verbatim from
   `ideas/id-listings/02-validation-method.md`). This satisfies the user's "validate that a
   contract is valid and not a scam" requirement, on-chain and trustlessly.
2. **Purchases** the bundle programmatically by settling through idgeek's sale contract
   (the programmatic path the user wants, *conditional on the load-bearing gate — see
   below*).
3. **Folds** the acquired neuron into either the **syndicate** (hotkey + follow, via the
   `create_pool_draft` path) or the **lottery pool** (canister-as-controller + disburse
   maturity, via the Early-Adopter `gov_disburse_maturity` path).

The "discount" angle: idgeek lists II anchors bundled with neurons at varying prices; the
app raises funds to acquire the ones priced below the neuron's stake+age value, capturing
the spread for the lottery/treasury — same economic shape as the existing Dapp-Explorer
"buy a listing at a discount for the treasury" flow, but the asset is a neuron.

## Why

- The lottery jackpot and the syndicate's voting power both grow with **more neurons under
  app influence**. Today the app only grows neurons it creates from fresh stake
  (staking tiers, EA). Acquiring pre-aged neurons at a discount on the open market is a
  faster, cheaper way to add voting power + maturity yield — and idgeek is the only
  on-chain venue selling II anchors bundled with neurons.
- The user explicitly wants this **programmatic** ("i would love to do this in a
  programmatic fashion rather than withdrawing from treasury and buying the identities
  manually"). That desire is the entire reason this is a *scoping* doc and not a one-line
  "admin does it by hand" answer: programmatic purchase requires idgeek's sale contract to
  hand the neuron to the canister, and whether it can is the gate.
- Reuse is strong: the app already has an escrow-based paid-asset saga with treasury +
  cycles fee legs (`buy_course_nft` / `run_buy_saga`), an on-chain idgeek-validation method
  (`canister_info`), and both neuron-fold paths. The *money/escrow* plumbing and the
  *validation* plumbing both exist; only the idgeek-settlement + fold glue is new.

## The decisive constraint → controller immutability

An NNS neuron's `controller` principal is set at creation and **cannot be reassigned**.
Confirmed against the live `governance.did` (full enum list in
`ideas/nueron-sale/01-icp-research.md` §1): no `manage_neuron` `Configure` operation
changes the controller. The only on-chain ways the canister can *become* a neuron's
controller are at neuron **creation**:

- `ClaimOrRefresh { By::MemoAndController { controller: opt <canister>, memo } }` — name
  the canister as controller when claiming a new neuron.
- `Spawn { percentage_to_spawn, new_controller: opt <canister>, nonce }` — controller
  spawns a child neuron with a different controller.
- `DisburseToNeuron { ..., new_controller: opt <canister>, nonce }` — controller disburses
  maturity into a new neuron with a different controller.

You **cannot** take over an existing human-controlled neuron. idgeek sells II anchors
(human login credentials) bundled with neurons whose controller is the II anchor. So:

- The canister cannot `Configure` (add hotkey, set follow, disburse maturity) a purchased
  neuron — only its controller can, and the controller is the II-anchor holder.
- The only way the canister ends up controlling a purchased neuron is if idgeek's sale
  contract, at settlement, **spawns or transfers the neuron with
  `new_controller = <our canister principal>`**. That hands the canister a freshly-created
  child neuron it controls — fully programmatic.

This is the **load-bearing gate**, and it is unconfirmable from public sources: idgeek's
backend is a JS-rendered SPA with no published Candid interface (candidate canister
`cocmv-eiaaa-aaaah-qdbxq-cai`, UNCONFIRMED). It must be resolved by probing the live sale
contract (a test purchase on mainnet, or asking the idgeek operator) before any code is
written.

## Architecture — two paths, decided by the gate

### Path A — programmatic (gate resolves YES)

idgeek's sale contract settles by spawning/transferring the neuron with
`new_controller = <our canister>`. The canister is the buyer principal.

```
 Funding page (users + treasury)            Backend canister                   idgeek sale contract (mainnet)
 ──────────────────────────────             ────────────────                   ──────────────────────────────
 1. pledge ICP toward target listing X
    ────────────────────────────────▶  fund_ii_pledge(listing_id, amount)
                                        escrow subaccount per (caller, listing)
 2. when funded ≥ listing price:
        validate_idgeek_contract()       ─── canister_info(idgeek_cid) ───▶   certified module_hash + controllers
            compare to admin-pinned hash/ctrl  (the geekfactory method)
 3.        settle_ii_purchase(listing_id)
            transfer ICP → idgeek sale contract (buyer = canister)
                                        ─────────────────────────────────▶   sale contract settles:
                                                                              spawns neuron w/
                                                                              new_controller = <canister>
                                        ◀────────────────────────────────   returns created_neuron_id
 4.    fold_acquired_neuron(neuron_id, into: Lottery|Syndicate)
            if Lottery: canister is controller → gov_disburse_maturity → lottery subaccount
            if Syndicate: canister-as-hotkey + follow (canister can Configure its own neuron)
```

Path A is the user's desired flow. The fold is trivial **because the canister is the
controller** of the freshly-spawned neuron — it can `Configure` (add itself as hotkey,
set follow) and `gov_disburse_maturity` freely.

### Path B — semi-manual operator (gate resolves NO)

idgeek's sale contract only hands over the II anchor credential to a human buyer. The
canister cannot be the buyer (it can't hold/operate an II anchor — canisters aren't II
principals). An **admin/operator** (a human with an II identity) is the buyer of record.

```
 Funding page                                Backend canister                  operator (human, II anchor)
 ─────────────                               ────────────────                  ───────────────────────────
 pledge ICP ──▶ fund_ii_pledge                validate_idgeek_contract()
                                              funds accumulate to listing price
                                              admin_release_purchase_funds(listing_id)
                                                transfer treasury ICP ───────────▶ operator buys on idgeek
                                                                                  (manually, with their II)
                                              ◀──────────── operator reports ────  operator takes custody of anchor +
                                                                                       neuron, runs Configure:
                                                                                         add canister as hotkey
                                                                                         follow primary leader
                                              operator reports neuron_id + proof of Configure
                                              admin_confirm_syndicate_fold(neuron_id)
                                                create_pool_draft(neuron_id) ──▶  HOTKEY_MISSING / NOT_FOLLOWING
                                                                                  (asserted on-chain → fold)
```

Path B is **honest**: the last mile is human. The canister still does the valuable parts —
crowdfund, validate, escrow, release funds, and on-chain assert the fold (via the existing
`HOTKEY_MISSING` + `NOT_FOLLOWING` checks in `create_pool_draft`). What it can't do is be
the buyer or run the `Configure` ops. This is *less* manual than "admin withdraws from
treasury and buys" (the funding is still programmatic + escrowed + validated + audited),
but it is **not** the fully programmatic flow the user asked for. Naming this clearly is
the point of the doc.

### Path C — custody canister (rejected for this idea)

A dedicated canister is the permanent controller of a pool of neurons (the WaterNeuron /
neuron-sale model in `ideas/nueron-sale/`). "Ownership" is an internal ledger row, not an
NNS controller. This solves *internal* transfer safely but **does not solve acquisition**:
to bring an idgeek neuron *into* the custody canister's control you still hit the
immutability wall — the custody canister can't become the controller of an existing
human-controlled neuron. Path C is the right architecture for *reselling* app-owned
neurons (the neuron-sale idea), not for *acquiring* external ones. Rejected here.

## Options considered

### A. Fully programmatic via idgeek sale contract (Path A — recommended IF gate is YES)
Above. Matches the user's ask exactly. Only viable if idgeek settles with
`new_controller = buyer`.

### B. Semi-manual operator (Path B — fallback if gate is NO)
Above. Honest about the human last mile. Ships most of the value (crowdfund + validate +
escrow + audit + on-chain fold assert) without depending on idgeek contract behavior.

### C. Custody canister (rejected — solves resale, not acquisition)
See Path C above.

### D. Pure treasury-withdraw + manual buy (the flow the user wants to avoid)
Admin withdraws treasury ICP, buys on idgeek by hand, reports back. Rejected by the user's
explicit request. Noted as the baseline this idea improves on.

## What this is NOT

- **Not a neuron-resale marketplace.** That's `ideas/nueron-sale/` (the app lets users sell
  *app-owned* neurons to each other). This idea is the *acquisition* direction: app buys
  external neurons from idgeek. The two compose (acquire here → resell there) but are
  separate scopes.
- **Not a general idgeek client.** Only the II-anchor+neuron bundle purchase + validation
  flow. idgeek's other features (listing, browsing, seller-side) are out of scope.
- **Not trustless end-to-end if Path B.** Path B trusts the operator to take custody and
  Configure the neuron honestly. The on-chain `create_pool_draft` asserts catch a cheating
  operator *at fold time* (hotkey/follow must be set), but cannot prevent the operator
  from disbursing the neuron's maturity to themselves *before* folding — the same
  buyer-safety problem `ideas/nueron-sale/` spends its adversarial review on. See R3.
- **Not a substitute for resolving the gate.** No amount of code makes idgeek's contract
  support `new_controller` if it doesn't.

## Reuse map

| Need | Reuse | Where |
|---|---|---|
| idgeek contract validation | `canister_info` module-hash + controllers vs pinned | `ideas/id-listings/02-validation-method.md` (on-chain, any-canister-callable) |
| Escrowed paid-asset saga + treasury/cycles fee legs | `buy_course_nft` / `run_buy_saga` | `lib.rs` §11 |
| Per-principal escrow subaccount + CallerGuard + `reclaim_escrow` | generalized reclaim | `lib.rs:11943` (2026-06-20 escrow fix) |
| Syndicate fold + on-chain hotkey/follow assert | `create_pool_draft` / `finalize_pool_registration` | `lib.rs:2661` |
| Lottery-neuron fold (canister-as-controller + disburse) | EA `admin_fund_early_adopter_neuron` + `gov_disburse_maturity` | `lib.rs:3660`, `lib.rs:7939` |
| Spawn-with-new-controller plumbing | `ManageNeuron` `Spawn { new_controller }` types | `lib.rs:3763`, `lib.rs:3883` |
| Feature flag dark-by-default | flag pattern | `lib.rs` §12 (`FLAG_*`) |
| Funding/discount-for-treasury UX | Dapp Explorer paid-listing page | `lib.rs` §16 |

## Net-new (no precedent in the repo)

- The **idgeek sale-contract settlement** integration — calling idgeek's (unconfirmed)
  purchase endpoint with the canister/operator as buyer and consuming the returned
  `created_neuron_id`. This is the only genuinely new external surface, and it is
  **blocked on the gate**.
- The **funding registry** (`Principal → pledges per listing`, `listing → target +
  raised + status`) — a new stable map (MemoryId **103**, next free; conflicts with the
  FCM idea — first built takes 103, second renumbers to 104).
- The **fold dispatcher** (`fold_acquired_neuron(neuron_id, into: Lottery|Syndicate)`) —
  trivial given existing paths, but the routing + audit is new.
- The **admin release + operator-confirm** endpoints for Path B (treasury → operator
  transfer, operator → canister neuron-id report). New, and only built if Path B.

## Sizing

- Path A (programmatic): backend ~180 lines (registry + validation + settlement + fold),
  frontend ~120 lines (funding page). **MEDIUM** — the settlement integration is the
  unknown-size piece (depends on idgeek's actual interface).
- Path B (semi-manual): backend ~140 lines (registry + validation + release + confirm),
  frontend ~100 lines. **MEDIUM** — simpler settlement (no idgeek contract call), but adds
  operator-custody audit surface.
- The validation method (`canister_info` compare) is ~40 lines either way and is the
  cheapest, highest-value piece — it could ship standalone as "validate an idgeek listing"
  even before the purchase flow exists.