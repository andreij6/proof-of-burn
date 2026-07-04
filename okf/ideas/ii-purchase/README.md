---
type: idea
title: "II Purchase — crowdfund discounted idgeek II-anchor+neuron bundles, fold neurons in"
tags: [ideas, ii-purchase]
timestamp: 2026-06-24T01:48:50-04:00
---

# II Purchase — crowdfund discounted idgeek II-anchor+neuron bundles, fold neurons in

Scope an idea (NOT built): a funding page that raises ICP, programmatically purchases
**Internet Identity anchors that bundle NNS neurons** (the idgeek product) at a discount,
and folds the acquired neurons into the app's neuron syndicate or lottery-neuron pool —
without an admin withdrawing from treasury and buying manually. idgeek ships a
contract-validation feature ("prove the sale contract is real, not a scam"); this idea
reuses it to vet each target before funds move.

## The one-line summary

> Users + the treasury crowdfund ICP toward a listed idgeek II-anchor+neuron bundle. The
> canister validates the idgeek sale contract on-chain (`canister_info` module-hash +
> controllers vs admin-pinned expected values — the geekfactory method, reused from
> `/ideas/id-listings/02-validation-method.md`), then settles the purchase through idgeek's
> sale contract. The acquired neuron is folded into the syndicate (hotkey + follow) or the
> lottery pool (canister-as-controller + disburse maturity). **The whole idea hinges on one
> unconfirmed fact: whether idgeek's sale contract can settle by transferring/spawning the
> neuron with `new_controller = <our canister>`** — because an NNS neuron's controller is
> **immutable** (set at creation, never reassigned; confirmed against `governance.did` in
> `/ideas/nueron-sale/01-icp-research.md`). If idgeek only hands over the II anchor
> credentials (a human login), the canister cannot operate the neuron and the last mile
> is forced back to a human operator — the manual flow the user wants to escape.

## The load-bearing gate (read this first)

The app can fully control a neuron **only if the canister is its controller**. The app's
two existing neuron-control paths both rely on that:

- **Syndicate** (`create_pool_draft`, `lib.rs:2661`): an *external* neuron joins by adding
  the canister as a **hotkey** and **following** the primary leader. Both are `Configure`
  operations — and `Configure` is controller-only. The syndicate does **not** require the
  canister to be the controller; it requires the *controller* (the II-anchor holder) to run
  two `Configure` ops. So a syndicate fold of a purchased neuron needs whoever ends up
  holding the II anchor to configure it — a human action, not a canister action.
- **Lottery neuron** (Early Adopter model, `admin_fund_early_adopter_neuron`,
  `lib.rs:3660` + `gov_disburse_maturity`, `lib.rs:7939`): the canister **is** the
  controller (the neuron was created with `MemoAndController { controller = <canister> }`),
  so the canister can disburse maturity → lottery. This requires the neuron to be *created*
  with the canister as controller; you cannot make an existing neuron's controller become
  the canister (immutable).

NNS controller immutability means **there is no on-chain way to hand over an existing
neuron to the canister.** The only ways the canister becomes a neuron's controller are at
neuron *creation*: `ClaimOrRefresh { By::MemoAndController { controller } }`, or
`Spawn` / `DisburseToNeuron` with `new_controller: opt <canister>` (all in
`governance.did`, enumerated in `/ideas/nueron-sale/01-icp-research.md` §1).

**Therefore the programmatic-purchase question reduces to:** does idgeek's sale contract,
at settlement, spawn/transfer the bundled neuron with `new_controller = <buyer principal>`
(where the buyer is our canister)? If **yes** → fully programmatic (canister receives a
neuron it controls, folds into the lottery pool, done). If **no** — idgeek only hands over
the II anchor credential to a human buyer → the canister can never be the controller, and a
syndicate fold still needs a human to run the two `Configure` ops on the anchor. That is
the semi-manual operator model, not the programmatic one requested.

idgeek's backend is a JS-rendered SPA with no public Candid spec (candidate
`cocmv-eiaaa-aaaah-qdbxq-cai`, UNCONFIRMED). **This gate cannot be resolved by reading
code — it requires probing idgeek's sale contract (test purchase on mainnet, or asking
the operator).** Resolve it before building anything.

## Files

- `01-overview.md` — what / why / the two architecture paths (programmatic vs
  semi-manual) / options considered / the immutability constraint / reuse map / net-new
- `02-impl.md` — backend (funding registry + target + validation + escrow settlement) +
  frontend (funding page) + the two fold paths, gated on the resolution of the load-bearing
  gate. MemoryId **103** is next free (conflicts with the FCM idea — first built wins).
- `03-risks-gates.md` — the gate, controller-immutability wall, scam/discount validation,
  II-anchor custody risk, crowdfunding refund, build gates, open questions

## Status / recommendation

**Do not build until the load-bearing gate is resolved.** The programmatic path the user
asked for exists **only if** idgeek's sale contract supports `new_controller = buyer` at
settlement. That is unconfirmed and unconfirmable from public sources. The honest
deliverable of this scoping is: (a) a crisp statement of the gate, (b) a programmatic
architecture *conditional on the gate resolving yes*, (c) a semi-manual fallback that is
honest about the last mile being human, and (d) reuse of the idgeek `canister_info`
validation method to satisfy the "validate that a contract is valid and not a scam"
requirement. Sizing depends on the gate: **MEDIUM** if programmatic, **MEDIUM** still if
semi-manual (the human step is cheap; the crowdfund + validation + fold plumbing is the
bulk either way). Rides a new `ii_purchase` flag (dark by default). Related:
[[project-id-listings-idea]], [[project-neuron-sale-idea]], [[project-proof-of-burn]].