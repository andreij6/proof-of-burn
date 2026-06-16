# Contract Pre-Validation — the "geekfactory method" (and the robust equivalent)

> How to "pre-validate the existing contract" before reposting idgeek's listings. Research against
> geekfactory.app, the IC interface spec, and DFINITY docs. Citation-backed; the geekfactory-specific
> algorithm is **inferred** (their site is JS-rendered with no public spec), so we implement the robust
> ICP-native equivalent.

## 1. What geekfactory is

**Geekfactory (geekfactory.app)** is the umbrella brand for the "Geek" suite built by the **Usergeek**
team — **the publisher of idGeek** — alongside userGeek (analytics), nftGeek (NFT/token analytics),
canisterGeek (cycles/memory monitoring; open-source `canistergeek-ic-js` / `canistergeek_ic_rust`),
confiGeek, vpGeek. The site markets **"deploy and verify smart contracts on the Internet Computer"**
("decentralized by architecture, secure by code, trustless by design") and has a **Contract Templates**
page — i.e. a **template-based deploy + verify** posture, not a third-party verification registry.

Sources: [geekfactory.app](https://geekfactory.app/) · [/templates](https://geekfactory.app/templates) ·
[canistergeek-ic-js](https://github.com/usergeek/canistergeek-ic-js) ·
[Geek Factory interview](https://open.spotify.com/episode/0I5U1roSYv2QaC6DrI0B3G)

## 2. The validation method — confirmed vs inferred

**Honest limit:** geekfactory.app is fully client-rendered; no public docs describe the exact "verify"
algorithm. **The exact geekfactory steps could not be extracted from a primary source.** Mapping the
candidates to what's technically possible on ICP:

- **Module/wasm hash verification (reproducible build)** — *most likely the core.* The only thing a third
  party can read about another canister's *code* is the **SHA-256 of its Wasm module**, compared to the
  hash of a reproducible build of the published source. Matches geekfactory's "templates + verify"
  framing.
- **Controller verification** — *very likely a second pillar.* A module hash is meaningless without
  knowing **who can change it**; the certified `controllers` path reveals whether a canister is
  blackholed / SNS-controlled / single-owner.
- **Candid interface match** — possible soft check (does it expose the expected methods); **not** a
  security guarantee.
- **Certified data / response certification** — already done automatically by agents for every canister
  response; authenticates responses, not a per-contract "validation" brand.
- **Geekfactory registry/attestation** — no evidence of a published "validated contracts" list. Treat as
  unlikely/unconfirmed.

**Most likely meaning → what we implement:** "validate the contract the geekfactory way" =
**(a) read idgeek's certified `module_hash` and compare to an expected/pinned hash**, and **(b) read
idgeek's certified `controllers` and compare to an expected/pinned set.**

Sources: [Trust in canisters](https://internetcomputer.org/docs/current/developer-docs/smart-contracts/overview/trust-in-canisters) ·
[Reproducible builds](https://internetcomputer.org/docs/current/developer-docs/smart-contracts/test/reproducible-builds) ·
[IC interface spec](https://docs.internetcomputer.org/references/ic-interface-spec/)

## 3. How to do it programmatically (third party, NOT a controller)

**Key constraint:** the management-canister **`canister_status`** call (controllers + module hash +
settings) is **controller-only**. We don't control idgeek, so we must use the public, certified
**`read_state`** endpoint — these state-tree paths are readable by anyone and come with a chain-key
signature.

| Check | `read_state` path (effective_canister_id = idgeek backend) | Value | Pass |
|---|---|---|---|
| Code identity | `/canisters/<id>/module_hash` | SHA-256 of the installed Wasm (absent if empty) | == pinned expected hash |
| Ownership/mutability | `/canisters/<id>/controllers` | CBOR array of controller principals | == pinned expected set |
| (optional) metadata | `/canisters/<id>/metadata/<name>` | public metadata sections | optional candid/build-info present |

The `read_state` response carries a **certificate** (chain-key signature over the state tree), so values
are **cryptographically verifiable without trusting any intermediary** — that's what makes it
"trustless." Use an IC agent (`agent-js` `readState` in the browser, or `ic-agent` in the indexer); the
agent validates the certificate. CLI spot-check: `dfx canister --network ic info <id>` returns both
controllers and module hash from these same certified paths.

> **⚠️ CORRECTED (Round 2):** this section originally claimed validation "cannot run inside our backend
> canister." **That was wrong.** While `read_state` is indeed ingress-only and `canister_status` is
> controller-only, the management-canister method **`canister_info` is callable by any canister for any
> target (NOT controller-gated)** and returns the target's current `module_hash` + `controllers` (+
> recent change history). It's in this repo's pinned `ic-cdk` 0.19
> (`canister_info(CanisterInfoRequest) -> CanisterInfoResponse`). **So the module-hash + controller check
> SHOULD run on-chain in the backend timer**, comparing to admin-pinned expected values — the verdict is
> canister-computed, not a trusted-off-chain assertion. `read_state` via agent-js is still useful as an
> *optional* live, user-side re-check in the frontend. See [`04`](./04-adversarial-review-round2.md) A0.

Sources: [IC interface spec — read_state / certified paths](https://docs.internetcomputer.org/references/ic-interface-spec/) ·
[Management canister (canister_status is controller-only)](https://internetcomputer.org/docs/references/system-canisters/management-canister) ·
[dfx canister info](https://internetcomputer.org/docs/current/developer-docs/developer-tools/cli-tools/cli-reference/dfx-canister) ·
[Certified data](https://docs.internetcomputer.org/concepts/certified-data/)

## 4. Module-hash / reproducible-build angle

You can't download another canister's Wasm, but ICP exposes its SHA-256 at the certified
`/canisters/<id>/module_hash` path. Verification:

1. **Fetch the live hash** — `read_state` path above, or `dfx canister --network ic info <id>`.
2. **Reproduce the expected hash** — build the published source deterministically (Docker + `dfx build`,
   validated with `reprotest` per DFINITY's reproducible-builds guide) and hash the `.wasm`.
3. **Compare.** Equal ⇒ the live canister runs exactly that source.

For idgeek specifically, geekfactory's **templates** are known source whose build hash they know, so
"validate against the geekfactory method" plausibly means "idgeek's live `module_hash` matches a known
geekfactory template/published-source hash." (**Inferred**, not confirmed.) In practice, if idgeek's
source isn't reproducibly published, the realistic "expected hash" is **the hash at the moment an admin
manually approves idgeek as a source** — then we detect *changes* from that baseline rather than proving
provenance.

Sources: [Reproducible builds](https://internetcomputer.org/docs/current/developer-docs/smart-contracts/test/reproducible-builds) ·
[Verifying the II code (worked example)](https://www.joachim-breitner.de/blog/779-Verifying_the_code_of_the_Internet_Identity_service)

## 5. Trust caveats — what a "pass" does and does NOT guarantee

State these in user-facing copy; do not overclaim.

- **Hash match = only the code running *right now*.** A non-blackholed canister can `install_code` to
  different Wasm a second later. **Hash is meaningless without the controller check, and both are
  snapshots → re-validate every ingest cycle.**
- **Controller check is also a snapshot.** A "trusted-looking" controller today can transfer control or
  be compromised. Only an **empty controller set / blackhole** makes code genuinely immutable; an **SNS
  root** makes it DAO-governed.
- **idgeek is operator-controlled, NOT blackholed.** So our realistic pass condition is **"controllers
  and module hash unchanged since admin approval,"** not "immutable/safe." Our badge must say exactly
  that.
- **Immutability cuts both ways** — a blackholed canister with a bug can never be fixed.
- **Code identity ≠ honest data.** A matching hash proves what code runs, not that the listings/prices it
  serves are legitimate — only that responses are certified as coming from that canister.
- **geekfactory's exact algorithm is inferred** — implement the robust equivalent (hash + controllers via
  certified `read_state`) rather than depend on a geekfactory black box.

Sources: [Trust in canisters](https://internetcomputer.org/docs/current/developer-docs/smart-contracts/overview/trust-in-canisters) ·
[ic-blackhole](https://github.com/ninegua/ic-blackhole)

## Bottom line (corrected)

Implement validation as a **two-part check** (module_hash == pinned expected; controllers == pinned
expected) **on-chain in the backend via `canister_info`**, re-run **every ingest cycle**, with the
backend **rejecting ingest upserts when validation fails**. Optionally add a frontend `read_state` live
re-check. Treat the result as a **point-in-time attestation**. **Per the Round-2 product review (B4), do
NOT surface a "validated" badge** next to listings — at most a neutral factual line on a details page
("idgeek's canister code unchanged since [date]"). A green badge next to a *sale* creates false
confidence and liability disproportionate to what the check actually proves (code identity ≠ sale safety).
