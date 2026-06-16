# NNS Neuron Mechanics — Research for Neuron Sale

> Research pass against the latest (2025-2026) official ICP docs, the live governance candid, and the
> DFINITY forum. Authoritative enum/record source:
> `https://github.com/dfinity/ic/blob/master/rs/nns/governance/canister/governance.did`.

## 1. Controller immutability — the load-bearing fact

**There is NO `manage_neuron` command or `Configure` operation to reassign an existing neuron's
controller. The controller is effectively immutable for the life of the neuron.**

Verified against the live candid:

- The `Operation` (Configure) variant contains exactly: `RemoveHotKey`, `AddHotKey`,
  `ChangeAutoStakeMaturity`, `StopDissolving`, `StartDissolving`, `IncreaseDissolveDelay`,
  `SetVisibility`, `JoinCommunityFund`, `LeaveCommunityFund`, `SetDissolveTimestamp`. **None changes the
  controller.**
- The top-level `Command` variant (`Spawn`, `Split`, `Follow`, `ClaimOrRefresh`, `Configure`,
  `RegisterVote`, `Merge`, `DisburseToNeuron`, `MakeProposal`, `StakeMaturity`, `MergeMaturity`,
  `Disburse`, `RefreshVotingPower`, `DisburseMaturity`, `SetFollowing`) has no "set controller" command.
- Official docs: *"The controller is a principal that controls the neuron and which cannot be changed."*

**Nuance — controller can be named at *new-neuron* creation, never reassigned:**

- `ClaimOrRefresh → By::MemoAndController → { controller: opt principal; memo: nat64 }` — the caller can
  name **any** controller (e.g. a canister) for a *newly claimed* neuron.
- `Spawn { percentage_to_spawn; new_controller: opt principal; nonce }` and
  `DisburseToNeuron { ...; new_controller: opt principal; nonce }` let the controller create a **child**
  neuron with a *different* controller.

**Implication:** You cannot sell a neuron by handing over its controller. The only two on-chain
"transfers" are (a) hand over the controlling credential/seed — off-protocol, irreversible,
unenforceable (scam vector), or (b) **custody model** — a canister is the permanent controller and
beneficial ownership is tracked inside the canister.

Sources: [governance.did](https://github.com/dfinity/ic/blob/master/rs/nns/governance/canister/governance.did) ·
[Neuron management](https://internetcomputer.org/docs/building-apps/governing-apps/nns/concepts/neurons/neuron-management) ·
[Neuron Attributes and Commands wiki](https://wiki.internetcomputer.org/wiki/Neuron_Attributes_and_Commands)

## 2. Hotkeys — permission boundary

A hotkey is a **low-privilege, governance-only** principal (practical cap ~10–15; figure uncertain).

**CAN:** read the neuron; `RegisterVote`; `Follow`/`SetFollowing`; `MakeProposal`; refresh voting power
(implicitly, by voting/confirming following).

**CANNOT:** `Configure` anything (so no IncreaseDissolveDelay, Start/StopDissolving, Add/RemoveHotKey,
ChangeAutoStakeMaturity, SetVisibility, Join/LeaveCommunityFund); `Spawn`, `Split`, `Disburse`,
`DisburseToNeuron`, `Merge`, `StakeMaturity`, `MergeMaturity`, `DisburseMaturity`; change the controller
(no one can); add/remove other hotkeys.

**Implication:** a hotkey is safe to grant a buyer for **voting only** (a "voting-power rental" model)
and conveys none of the economic value — it cannot disburse or extract stake/maturity. Suitable as a
future add-on, not as the sale mechanism.

## 3. Canister-controlled neurons

How a canister becomes controller (same staking flow, canister named at creation):

1. Compute the governance staking subaccount from `(canister_principal, memo/nonce)`.
2. Transfer ICP from the canister to that governance subaccount on the ICP ledger.
3. `manage_neuron(ClaimOrRefresh { by = MemoAndController { controller = opt <canister>; memo = <nonce> }})`.

Because the controller can never change, the canister is the permanent owner. This is exactly how
WaterNeuron, SNS DAOs, and ICDevs-style neuron canisters operate.

**Full op set a controlling canister has:** everything a controller can do — `Configure` (all ops),
`Follow`/`SetFollowing`, `RegisterVote`, `MakeProposal`, `Spawn` (with `new_controller`), `Split`,
`Disburse`, `DisburseToNeuron` (with `new_controller`), `Merge`, `StakeMaturity`, `MergeMaturity`,
`DisburseMaturity`, `RefreshVotingPower`, `ClaimOrRefresh`.

**Implication:** a canister-custodied neuron is the only sound marketplace substrate. The canister can
later carve value to a buyer's own principal via `Spawn`/`DisburseToNeuron { new_controller }`.

Sources: [Rosetta staking API](https://internetcomputer.org/docs/defi/rosetta/icp_rosetta/construction_api/staking) ·
[governance.did](https://github.com/dfinity/ic/blob/master/rs/nns/governance/canister/governance.did) ·
[Forum: canisters controlling neurons](https://forum.dfinity.org/t/the-internet-computer-should-allow-canisters-to-control-icp-neurons/24568)

## 4. Disburse / Split / Spawn / Merge / maturity ops

| Operation | Behavior | Resets dissolve delay? | Resets age? |
|---|---|---|---|
| **Disburse** | Requires neuron **fully dissolved** (delay 0). Transfers locked ICP to `to_account`; neuron disappears. KYC-gated. | N/A (gone) | N/A |
| **Split** | New child with `amount_e8s` of stake; child **inherits** dissolve state, **age**, followees. Parent & child must stay ≥ min stake. Child pays ledger fee. | No (inherited) | No (inherited) |
| **Spawn** | Converts **maturity ≥ 1 ICP** into a brand-new neuron (no stake, only maturity); new neuron has **7-day dissolve delay, dissolving**. Can target `new_controller`. | New neuron = 7 days | Fresh |
| **Merge** | Moves stake+age+maturity source→target; resulting delay = **max(src, tgt)**. | Target = greater | Combined |
| **StakeMaturity** | Converts (a %) of maturity into stake **in place**. | No | No |
| **DisburseMaturity** | Pays maturity to an account (modulation/delay window). | No | No |

**Constants:** min neuron stake **1 ICP** (`neuron_minimum_stake_e8s`, governable); min dissolve delay
to vote **6 months**; spawn threshold **≥ 1 ICP maturity**; no dedicated "split fee" beyond the standard
**0.0001 ICP** ledger transaction fee.

**Implication for buyer exit:** `Disburse` destroys the lock value (needs full dissolution).
`Split` + `DisburseToNeuron { new_controller = buyer }` preserves the *split-off* stake but the carved
child's behavior follows the table above. Staying in custody and unstaking via the existing path is the
least lossy exit.

Sources: [Neuron Attributes and Commands wiki](https://wiki.internetcomputer.org/wiki/Neuron_Attributes_and_Commands) ·
[NNS neurons can now be merged](https://medium.com/dfinity/internet-computer-nns-neurons-can-now-be-merged-8b4e44584dc2) ·
[Staking and voting rewards](https://internetcomputer.org/docs/current/tokenomics/nns/nns-staking-voting-rewards)

## 5. What value is actually transferred

Voting power = `stake × dissolve_delay_bonus × age_bonus`.

- **Dissolve-delay bonus:** 1.0× (≤6mo) → 2.0× (8yr). Recreatable by anyone willing to lock — value is
  only "already committed."
- **Age bonus:** 1.0× → 1.25× over **4 years** of *non-dissolving* age; **resets when dissolving
  starts**. The **genuinely non-recreatable** component.
- **Accrued maturity:** unrealized rewards in the neuron — directly valuable.
- **Locked / non-dissolving state** and **genesis/seed neurons** (uniquely aged, cannot be reproduced).

In a custodied sale the buyer is **not** getting the controller — they're buying a canister-tracked
**claim against the neuron's economic outputs** (stake + age bonus + dissolve lock + maturity). Real
transferable value = age bonus + locked position + accrued maturity.

Sources: [Neurons (learn.icp)](https://learn.internetcomputer.org/hc/en-us/articles/34084120668692-Neurons) ·
[Staking and voting rewards](https://internetcomputer.org/docs/current/tokenomics/nns/nns-staking-voting-rewards)

## 6. Periodic confirmation / voting-power decay (released Jan 2025)

To keep voting power and rewards, a neuron must **vote directly or confirm its following at least once
every 6 months** (tracked via `voting_power_refreshed_timestamp_seconds`):

- **Months 0–6:** full power.
- **Months 6–7:** power decays **linearly to zero**.
- **Month 7+:** power = **0** AND **following is fully wiped**.

Refresh via the explicit `RefreshVotingPower` command, by voting, or by re-setting followees. A hotkey
can keep a neuron alive by voting/confirming following (but cannot do stake ops).

**Implication:** the **custody canister must auto-confirm every ≤6 months** for every neuron it holds,
or each one silently decays to zero voting power and loses its followees. This is a hard liveness
obligation for the marketplace timer — beneficial-owner changes off-chain don't touch the NNS clock.

Sources: [Periodic confirmation of following](https://medium.com/dfinity/onchain-governance-improvement-periodic-confirmation-of-following-4c8fd73f578d) ·
[Forum: periodic confirmation API & release plan](https://forum.dfinity.org/t/periodic-confirmation-api-changes-release-plan/37237)

## 7. Precedent & risk

**Built precedent (custody, not controller-transfer):**

- **WaterNeuron** — the leading example: ICP is aggregated into a canister-controlled 6-month neuron;
  depositors get **nICP** (liquid staking token) that trades on ICPSwap. Beneficial ownership is the
  nICP balance, never an NNS controller transfer. This is the proven "tradable neuron value" model.
  ([WaterNeuron docs](https://docs.waterneuron.fi/nicp/overview))
- **SNS neurons** — every SNS DAO holds canister-controlled neurons with internal accounting.
- DFINITY has **discussed** making neuron control more transferable specifically to "enable secondary
  neuron marketplaces without selling the attached Internet Identity" — confirming that *today* the only
  DIY way to sell a key-neuron is to sell the II/seed (the core risk).
  ([Forum 24568](https://forum.dfinity.org/t/the-internet-computer-should-allow-canisters-to-control-icp-neurons/24568))

**Documented risks:**

- **Selling the II/seed** is irreversible and **unenforceable** — the seller keeps a copy and can
  re-take control and disburse after payment. The canonical neuron-sale scam.
- **Controller is supreme & immutable** — whoever holds the controlling key can drain value regardless
  of any off-chain "sale."
- **Custody-canister trust** — risk shifts to the canister's code, upgrade keys, and DAO; bugs/malicious
  upgrades can drain custodied stake.
- **Voting-power decay liveness** (§6) — must be automated.
- **KYC gate on Disburse** and historical seed-neuron sweeps — payout edge cases.

**Bottom line:** the safe marketplace is canister-custody; the sale is an internal ownership flip; the
real value is age + lock + maturity; never build a flow that requires handing over an Internet Identity.

### Flagged uncertainties

- Exact hotkey cap (10 impl vs 15 UI).
- No dedicated "split fee" constant beyond the 0.0001 ICP ledger fee.
- `neuron_minimum_stake_e8s` is governable (currently 1 ICP).
- A few forum primary sources returned 403 to automated fetch; those claims are corroborated via
  Medium/wiki/candid.
