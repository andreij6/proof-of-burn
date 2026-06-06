---
tags:
  - tasks
  - planning
  - icp
  - rust
created: 2026-06-06
status: active
---

# Proof of Burn — Development Task Breakdown

Engineering breakdown for building **Proof of Burn** as an Internet Computer (ICP) dapp in **Rust** (backend canister) + a static SPA frontend (asset canister). Tickets are grouped into epics; each ticket lives in its own file with acceptance criteria, dependencies, the relevant ICP skill, and crate/version pins.

> [!important] Build on ICP — authoritative source
> ICP tooling changes fast. Before writing any canister code, fetch the relevant skill from `https://skills.internetcomputer.org/.well-known/skills/index.json` and treat it as authoritative over general knowledge. Use the **`icp` CLI**, never `dfx`. Each ticket names the skill(s) to fetch.

> [!important] Frontend (Epic H) — authoritative visual source
> The hi-fi design is a Claude Design handoff bundle at `design-system/project/`. Treat it as the source of truth for the SPA's look and behaviour and **recreate it pixel-perfectly** in the SPA framework — match the visual output, don't copy the prototype's internal structure. Tokens → `_ds/incentive-layer-design-system-*/colors_and_type.css`; primitives → `pob-kit.jsx`; components → `pob-parts.jsx`; frame/assembly → `pob-page.jsx`. Each Epic-H ticket names the file + component to recreate under its **Design source** heading. Ignore the sibling `roadmap-design-system-*` bundle (another project; not wired in); the prototype's `FEED` / `ROAD-…` rows are placeholder — bind to real NNS proposals ([[PB-031]]).

## Source specs
- [[App Functional Overview]]
- [[Designer Brief — SPA Spec]]
- Hi-fi design bundle — `design-system/project/` (Claude Design handoff; see the Epic H callout above)

## Tech baseline (pinned)
| Layer | Choice | Pin |
|---|---|---|
| CLI / build | icp-cli + recipes | `@dfinity/rust@v3.2.0`, `@dfinity/asset-canister@v2.1.0` |
| Backend | Rust canister | `ic-cdk = "0.19"`, `candid = "0.10"` |
| Stable storage | ic-stable-structures | `0.7` (StableBTreeMap / StableCell / StableLog + MemoryManager) |
| Token | ICRC-1/2 (ICP ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`) | `icrc-ledger-types = "0.1"` |
| Serialization | CBOR for stable, candid for wire | `ciborium = "0.2"`, `serde = "1"` |
| Outcalls | mgmt canister `http_request` | `ic-cdk::management_canister`, `serde_json = "1"` |
| Auth | Internet Identity | `@icp-sdk/auth >= 5`, `@icp-sdk/core >= 5` |
| Bindings | TS from .did | `@icp-sdk/bindgen >= 0.3` |

## Epics
1. **A — Project Setup & Infrastructure** — PB-001…005
2. **B — Backend Core State** — PB-010…013
3. **C — Auth & Eligibility** — PB-020…023
4. **D — NNS Governance Integration** — PB-030…033
5. **E — Burn-to-Vote Mechanism** — PB-040…045
6. **H — Frontend SPA (progressive disclosure)** — PB-070…078
7. **I — Security & Hardening** — PB-080…082
8. **J — Testing & QA** — PB-090…093
9. **K — Deployment & Ops** — PB-100…102

## Suggested milestones
- **M1 — Skeleton on-chain:** A (all) + PB-010/011/012, PB-020/021, PB-031, PB-072. A signed-in user sees live proposals from a deployed canister.
- **M2 — Eligibility & history:** PB-022/023, PB-030/032, PB-073/075. Follow verification + vote history.
- **M3 — Burn core (highest risk):** PB-040…045, PB-074, PB-080. Commit → escrow → threshold → burn/refund, security-reviewed.
- **M4 — Vote execution:** PB-033.
- **M5 — Polish + mainnet:** PB-076/078, PB-081, PB-090…093, PB-100…102.

## Critical-path dependency notes
- The **burn mechanism (Epic E)** is the riskiest surface: it moves real ICP and crosses `await` boundaries. PB-045 (reentrancy/saga) and PB-080 (security review) gate any mainnet burn.
- **NNS integration (Epic D)** depends on the NNS Governance candid; resolve the interface in PB-030 before D/E vote tickets.
- **Follow verification (PB-022)** is an unresolved spec question — see Decisions below. It blocks Tier 2.

## Key decisions to lock before coding (from spec open questions)
- [ ] **Sign-in standard:** default to **Internet Identity** (Plug/OISY deferred). See PB-020.
- [ ] **How "following" is verified on-chain:** NNS `list_neurons`/`get_full_neuron` exposes `followees` per topic. Decide whether the user proves neuron ownership (hotkey/principal) or we read a public mapping. See PB-022.
- [ ] **Escrow model for burn:** ICRC-2 `approve` + `transfer_from` into a per-proposal canister subaccount (recommended) vs. direct deposit. See PB-040.
- [ ] **"Burn" semantics:** transferring ICP **to the ICP minting account** is the on-chain burn (fee = 0). Confirm the minting-account destination. See PB-042.
- [ ] **Threshold source:** flat per-proposal config (v1) vs. dynamic/governance. v1 = admin-set flat. See PB-012/041.

## Status legend
`todo` · `in-progress` · `blocked` · `review` · `done`
