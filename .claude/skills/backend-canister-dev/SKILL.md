---
name: backend-canister-dev
description: Edit the Rust backend canister (src/backend/src/lib.rs). Use when adding or changing canister endpoints, data models, stable storage, timers, sagas, or admin methods — covers the lib.rs section map, candid (.did) sync, upgrade safety, and build commands.
---

# Backend canister development

The entire backend is **one file**: `src/backend/src/lib.rs` (~15k lines).
Don't try to read it whole — navigate by its numbered section banners
(`// ===== N. Title =====`):

| § | Section | starts near line |
|---|---|---|
| – | Storage quotas & validation constants | 10 |
| – | NNS Governance & Ledger types | 30 |
| 1 | Data models | 300 |
| 2 | Stable storage trait impls (Storable) | 490 |
| 3 | Persistent memory layout (MemoryId map) | 527 |
| 4 | Security guards (caller checks) | 610 |
| 5 | Init & post_upgrade hooks | 695 |
| 6 | Config & admin setters | 768 |
| 7–10 | Proposal queries, mock seeding, eligibility, vote history | 1111–1444 |
| 11 | Escrow, sagas, lifecycle (burn flow core) | 1445 |
| 12 | Feature flags & Idea Board | 3677 |
| 13 | Lossless voting / pooled staking | 4987 |
| 14 | Lossless lottery + payout history | 6660 |
| 16 | Dapp Explorer (paid listings, XRC oracle) | 7570 |
| 17 | Arcade (Mini Golf Gold, course editor) | 8468 |
| 18 | Early Adopters (permanent stake — deliberately NO unstake) | 8978 |
| 19 | Social profile (X handle) | 9890 |
| – | `mod tests` (native unit tests) | 9931 |

Add new code inside the matching section; new features get a new numbered
section in the same style.

## Candid sync is manual

`src/backend/backend.did` is **hand-maintained**, not generated. Any change to
a public endpoint's signature or to a type it uses MUST be mirrored in
`backend.did`, or frontend bindings and `icp canister call` break silently.
The frontend regenerates its TypeScript bindings from this file automatically
(vite plugin) — the `.did` is the single source of truth.

## Upgrade safety (stable structures)

State lives in `ic-stable-structures` maps keyed by `MemoryId` (§3):

- **Never reuse or renumber an existing `MemoryId`.** New collections get the
  next free id.
- Types stored in stable maps are CBOR-encoded (`ciborium`) — adding a new
  field to a stored struct requires `#[serde(default)]` (or an `Option`) so
  old bytes still decode after upgrade. Removing/renaming fields breaks decode.
- Anything seeded in `init` must also be handled in `post_upgrade` (the
  existing hooks show the pattern: seed only when empty).

## Conventions

- Guards from §4 (`require_admin`, anonymous-caller rejection) on every update
  method; queries that expose per-user data take the caller from
  `ic_cdk::api::msg_caller()`.
- Value-moving logic must have a native mock seam (see existing ledger/NNS
  mocks) so unit tests cover it — wasm-only plumbing is the only exception.
- Amounts are `u64` e8s (1 ICP = 100_000_000 e8s); ledger fee is 10_000 e8s.
- Dev/test-only endpoints are prefixed `dev_` and admin-gated.

## Build & quick checks

```bash
cargo build --target wasm32-unknown-unknown --release -p backend  # wasm build
cargo test -p backend --lib                                       # unit tests
cargo clippy -p backend --target wasm32-unknown-unknown           # lints
```

Deploy the result locally with `bash scripts/deploy-local.sh` (see the
`icp-local-deploy` skill). Never deploy to mainnet unless explicitly asked.
