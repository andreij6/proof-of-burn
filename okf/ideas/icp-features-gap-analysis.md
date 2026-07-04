---
type: idea
title: "ICP Feature Gap Analysis — Cycles of Influence"
tags: [ideas, icp-features-gap-analysis]
timestamp: 2026-06-13T22:37:20-04:00
---

# ICP Feature Gap Analysis — Cycles of Influence
*Generated June 2026 | Cross-referenced against docs.internetcomputer.org*

This report identifies ICP platform features that the app does **not** already use
or plan for, and that would add genuine value. Items already in use (ic-stable-structures,
ICRC-1/2, II, XRC, raw_rand, CMC, timers, NNS governance) and already planned
(vetKeys, LLM canister AI reviewer, chain-key BTC/ETH/USDC/USDT, t-ECDSA, HTTPS outcalls,
SIWE, ICPSwap LP locking) are excluded.

---

## 1. Certified Variables — Tamperproof Query Responses

**What it is:** ICP query calls are answered by a single replica — no consensus.
A malicious or faulty node can return fabricated data. Certified variables solve
this: the canister stores a 32-byte Merkle root hash during update calls, and
query responses include a BLS threshold signature proving the data hasn't been
tampered with. Clients (including the frontend) can verify this signature against
the IC's root public key.

**Concrete use case for COI:** Every value users rely on to make financial
decisions is currently returned via uncertified query calls: the leaderboard
(who burned what), per-proposal commitment tallies, burn totals, the Burn Census
visualization, dapp explorer listing counts (people pay to list — they should be
able to prove the count is real). A single rogue boundary node or replica could
show a user a fake "your 100 ICP committed" response while their funds went
elsewhere. Adding certified variables to at least the leaderboard root, total
burn counter, and per-proposal commitment tree costs one `ic-certified-map`
crate and a Merkle root update on every state-changing update call.

**Rough complexity:** Medium — needs the `ic-certified-map` crate, a
`RbTree` alongside the existing StableBTreeMap for the data you want to certify,
a `certified_data_set` call in every write path, and a `data_certificate()`
return in query responses. Frontend verification uses `@dfinity/certificate-verification`.
Post-upgrade re-certification hook is easy to forget (the security doc already
has a `post_upgrade` section — just add one line).

**Doc:** https://docs.internetcomputer.org/guides/backends/certified-variables.md

---

## 2. Verifiable Credentials (ICP VC Standard) — On-Chain Governance Badges

**What it is:** ICP has a native verifiable credential (VC) protocol mediated
by Internet Identity. A canister can act as a VC issuer: when a user proves
something (age, membership, participation), the canister issues a cryptographically
signed JWT credential. Other ICP apps can request these credentials via II, without
the user's identity being linked across services. The issuer and relying party
only ever see a temporary `id_alias`, never each other's user principal.

**Concrete use case for COI:** FABLE-IDEAS B4 plans Ethereum-side attestations
using t-ECDSA → EAS, which requires Ethereum smart contract infrastructure and
Ethereum users. The ICP VC standard is far simpler to implement and serves the
ICP-native audience today. When a user's proposal commitment is settled and their
ICP is burned, the canister issues a `GovParticipant` credential: `{ "type":
"NNSBurnVoter", "minBurned": X_ICP, "proposalCount": N }`. Other ICP dapps
(SNS projects, DEXes, NFT platforms) can gate features on "has burned ≥ 1 ICP
on NNS governance" — instantly making COI the on-chain proof-of-civic-engagement
layer for all of ICP. This is the "governance passport" narrative without
touching Ethereum.

**Rough complexity:** Medium — implement four Candid endpoints on the backend
(`vc_consent_message`, `derivation_origin`, `prepare_credential`, `get_credential`).
The tricky part is canister signatures for JWTs: `prepare_credential` must update
`certified_data`, and `get_credential` reads back the signature. The vc-playground
reference implementation (Rust) makes this concrete. Frontend change: add an
"Export Credential" button per user profile.

**Doc:** https://docs.internetcomputer.org/guides/authentication/verifiable-credentials.md

---

## 3. ICRC-21/25/49 Wallet Signer — Per-Action Consent for High-Value Burns

**What it is:** Five ICRC standards (21, 25, 27, 29, 49) define how wallets
and apps communicate. The critical one is ICRC-21: the canister exposes a
`icrc21_canister_call_consent_message` method that returns a human-readable
description of any callable function. A wallet like OISY reads this and shows
the user a dialog before executing any update call. ICRC-49 lets the wallet
then execute the approved call on behalf of the user.

**Concrete use case for COI:** Right now, when a user commits 50 ICP to vote
ADOPT, their Internet Identity session delegation signs and fires the `commit`
call silently. The user has to trust the frontend. Implementing ICRC-21 means
COI's backend can return, for any `commit(proposal_id, stance, amount)` call:
*"You are committing 50 ICP to ADOPT on NNS Proposal #14802 — The Internet
Computer's Roadmap. This ICP will be permanently burned if the threshold is
met."* Users with OISY or hardware wallets see this dialog and must explicitly
approve before any funds move. For an app where a single commit can be hundreds
of ICP, this is a meaningful trust upgrade — and it's the direction the ICP
ecosystem is moving (OISY is the flagship wallet).

**Rough complexity:** Medium — ICRC-21 is one new `update` method on the
backend (pattern-match on `canister_id` + `method` + decoded args, return a
text string). The frontend needs to construct a `Signer` from `@icp-sdk/signer`
and use `SignerAgent` instead of `HttpAgent` for write calls. Read-only queries
stay on the plain agent. The `@dfinity/icrc21-agent` npm package handles the
consent dialog flow.

**Doc:** https://docs.internetcomputer.org/guides/digital-assets/wallet-integration.md
https://docs.internetcomputer.org/references/icrc-standards.md#wallet-signer-standards

---

## 4. Canister Snapshots — Pre-Upgrade Rollback

**What it is:** The management canister can snapshot a canister's full state
(Wasm module, heap memory, stable memory, certified variables) at any point in
time. Snapshots can be restored if an upgrade goes wrong, or downloaded/uploaded
for subnet migration. Up to 10 snapshots per canister are supported.

**Concrete use case for COI:** The security doc covers access control, reentrancy,
and stable memory thoroughly — but says nothing about upgrade rollback. The backend
holds real user funds: ICP in escrow subaccounts, lottery ticket counts, neuron
registrations. If a bad upgrade corrupts the `StableBTreeMap` containing
commitments, there is currently no recovery path. The fix is three CLI commands
baked into the mainnet deploy runbook:
```bash
icp canister stop backend -e ic
icp canister snapshot create backend -e ic   # note snapshot ID
icp canister start backend -e ic
icp deploy backend -e ic                      # proceed with upgrade
# if bad: stop → snapshot restore → start
```
Zero code changes. High value for a value-holding canister.

**Rough complexity:** Easy — purely operational, not a code change. Add a
`pre-upgrade snapshot` step to `/operations/DEPLOY.md` and a rollback procedure.
The snapshot itself costs cycles proportional to canister size.

**Doc:** https://docs.internetcomputer.org/guides/canister-management/snapshots.md

---

## 5. ICRC-7 NFTs — Composable Burn Receipts ("Ash")

**What it is:** ICRC-7 is the adopted ICP standard for non-fungible tokens.
ICRC-37 adds approval and transfer-from semantics. Together they give you a
composable on-chain NFT that any ICP wallet, marketplace, or explorer can read.
Making an NFT non-transferable requires canister-level enforcement (reject
`icrc7_transfer` calls) — there's no soulbound flag in the standard, but it's
trivially enforced in code.

**Concrete use case for COI:** FABLE-IDEAS B6 introduces "Ash" as an in-app
status token minted when users burn ICP. Today that would be an internal accounting
variable. Implementing Ash as a proper ICRC-7 NFT collection (one NFT per
settlement event, with metadata: proposal ID, stance, burn amount in e8s,
timestamp, funder principal) makes it composable with all ICP NFT tooling.
OISY can display a user's governance history. The NNS dashboard can show a
neuron's burn receipts. External apps can read `icrc7_tokens_of(principal)` to
gate access or calculate reputation scores without calling the COI backend
directly. The "soulbound" constraint is one `trap` in `icrc7_transfer`.

**Rough complexity:** Medium-Hard — deploy a separate companion ICRC-7 canister
(or add a second canister to the project). The backend mints an NFT via
inter-canister call on every `settle_burn_split` success. The NFT metadata
schema needs to be designed. Using an existing ICRC-7 reference implementation
(ORIGYN's or a community one) is faster than writing from scratch.

**Doc:** https://docs.internetcomputer.org/references/digital-asset-standards.md#icrc-7-non-fungible-tokens

---

## 6. Parallel Inter-Canister Calls — Faster Settlement

**What it is:** ICP supports making multiple inter-canister calls in parallel
using `futures::join!` (Rust) or `join_n!` patterns. The calls fan out
concurrently across subnets and resolve when all complete, rather than awaiting
each one sequentially. The ic-cdk docs note this is especially valuable for
cross-subnet calls where each hop adds ~1–2 seconds.

**Concrete use case for COI:** The settlement sweep (`admin_trigger_sweep` and
the 5-minute timer) currently processes proposals sequentially. For each proposal
it: (1) fetches the NNS vote result, (2) calls the ICP ledger for each refund or
burn, (3) calls the CMC for cycle minting. With 10+ active proposals, this sweep
runs in O(n) time. The maturity sweep (harvesting neuron maturity) has the same
pattern: one `get_full_neuron` call per registered neuron, sequentially. Refactoring
both sweeps to fan-out their governance and ledger calls in parallel could bring
settlement from 30+ seconds to ~2 seconds for a full round, which matters for
user experience and means the 5-minute timer can process more proposals per tick.

**Rough complexity:** Easy — the refactoring is mostly wrapping existing
`ic_cdk::call` sequences with `futures::join!`. The main design consideration
is that locks (`ProposalLock`, `CallerGuard`) already exist for reentrancy
safety, but they need to be reviewed to make sure parallelizing the sweep calls
doesn't accidentally hold locks across awaits.

**Doc:** https://docs.internetcomputer.org/guides/canister-calls/parallel-inter-canister-calls.md

---

## 7. EVM RPC Canister — Direct Ethereum State Reads

**What it is:** The EVM RPC canister (`7hfb6-caaaa-aaaar-qadga-cai`) lets ICP
canisters call Ethereum JSON-RPC methods — `eth_getBalance`, `eth_call`, event
log queries — without bridges or oracles. It fans requests across multiple
providers (Alchemy, Ankr, BlockPi, PublicNode) and returns a `Consistent` result
only when 2/3+ agree. Supported chains: Ethereum L1, Arbitrum, Base, Optimism.

**Concrete use case for COI:** The ckETH integration (ICRC-1 token) lets people
deposit ETH-backed tokens. That's different from reading live Ethereum state.
IDEAS.md #2 proposes "Hyper-Conviction Multipliers" for ckBTC burns. A richer
version: use `eth_call` on the Aave lending pool to read a user's stETH position
size, or query an ENS name, or read a user's Ethereum NFT holdings — then
calibrate governance weight or unlock a tier. Example: a user deposits their
Ethereum address (self-declared), COI's backend calls `eth_getBalance` via EVM
RPC to verify they hold >1 ETH, and grants a "Whale Tier" badge with a 1.5×
conviction multiplier. No bridge, no custody, no trusted oracle — the IC subnet
aggregates 3 providers and returns a provably consistent answer. Also directly
enables the ckBTC/ckETH incinerator swap idea (IDEAS #10 / FABLE B3) by reading
the Uniswap pool price on-chain to calculate the optimal swap route before calling
ICPSwap.

**Rough complexity:** Medium — add `evm_rpc_types = "3"` to Cargo.toml, define
the EVM RPC canister principal, make inter-canister calls with 10B cycles
attached. The main complexity is handling the `Consistent/Inconsistent` result
types and deciding what to do when providers disagree. The address-linking flow
(user provides their ETH address for verification) needs a challenge-response
to prevent squatting.

**Doc:** https://docs.internetcomputer.org/guides/chain-fusion/ethereum.md

---

## 8. SNS Launch — Community-Governed Governance

**What it is:** An SNS (Service Nervous System) is ICP's DAO framework that
transfers control of an app's canisters from the founding team to a community of
token holders. After launch, canister upgrades, treasury spending, and config
changes all require token holder votes. The launch is triggered by an NNS proposal.

**Concrete use case for COI:** Cycles of Influence is a governance app arguing
that governance should have skin in the game. Launching an SNS would mean the
app itself is governed by conviction — people who burn ICP to vote on the
direction of a *governance tool* are deeply aligned. The token utility writes
itself: hold COI tokens → vote on COI governance → unlock lower burn thresholds
or higher conviction multipliers. Developer neurons vest over 24+ months, giving
the community confidence the team won't exit. The treasury (currently dev-withdrawable
with no timelock) becomes a DAO-controlled multisig. The meta-narrative —
"we used ICP governance to govern our ICP governance app" — is a strong launch
story. This is the natural endgame for the platform.

**Rough complexity:** Hard — irreversible, requires open-sourcing, security
review, tokenomics design, NNS community buy-in, and a testflight on mainnet
before the real launch. Admin functions need to transition from principal checks
to SNS governance canister checks. The `admin_withdraw_treasury` function noted
in the economics playbook as "currently no time-lock" would need to become a DAO
treasury transfer proposal. Plan for 3–6 months of preparation.

**Doc:** https://docs.internetcomputer.org/guides/governance/launching.md

---

## 9. Reproducible Builds — Verifiable Wasm for a Trust-Minimized Tool

**What it is:** ICP's `ic-wasm` tooling and the `icp` CLI support reproducible
Wasm builds: given the same source code, toolchain version, and build flags, the
output Wasm binary is byte-identical. Combined with `icp canister status --show-module-hash`,
anyone can verify the deployed canister Wasm matches the published source.

**Concrete use case for COI:** The security doc is solid on runtime safety —
but never mentions build verifiability. COI is asking users to burn real ICP
based on trust in the code. Any user sophisticated enough to audit the source
(`lib.rs` is open on GitHub) should also be able to verify that what's running
on mainnet is what they audited. This is table stakes for a governance tool and
a frequently-asked question from power users. It also matters before any SNS
launch (the NNS community will check). The implementation is adding a
`docs/REPRODUCIBLE_BUILD.md` with pinned toolchain versions and the verification
steps, plus ensuring the CI build uses `--locked` and a pinned Rust toolchain.

**Rough complexity:** Easy-Medium — pinning the Rust toolchain (`rust-toolchain.toml`),
ensuring `Cargo.lock` is committed, and documenting the exact `cargo build
--target wasm32-unknown-unknown --release` + `ic-wasm shrink` invocation that
produces the deployed artifact. The `icp canister install --mode=reinstall
--wasm` flow already produces a module hash visible in `icp canister status`.

**Doc:** https://docs.internetcomputer.org/guides/canister-management/reproducible-builds.md

---

## Priority Summary

| # | Feature | Value | Complexity | Prerequisite for |
|---|---------|-------|------------|-----------------|
| 4 | Canister Snapshots | Safety | Easy | Any future upgrade |
| 6 | Parallel Inter-canister Calls | Performance | Easy | — |
| 9 | Reproducible Builds | Trust | Easy | SNS launch |
| 1 | Certified Variables | Trust | Medium | SNS launch, VC credentials |
| 3 | ICRC-21 Wallet Signer | UX / Trust | Medium | — |
| 2 | Verifiable Credentials | Ecosystem | Medium | Certified variables |
| 7 | EVM RPC State Reads | Features | Medium | Hyper-Conviction tiers |
| 5 | ICRC-7 Burn Receipt NFTs | Ecosystem | Medium-Hard | Ash concept |
| 8 | SNS Launch | Governance | Hard | Reproducible builds, VCs |
