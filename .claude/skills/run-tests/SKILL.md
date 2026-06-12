---
name: run-tests
description: Run and interpret this project's test suites — backend unit tests, PocketIC integration tests, coverage, frontend vitest, and the local e2e burn-flow script. Use before claiming any change works, when tests fail or skip unexpectedly, or when asked to verify a fix.
---

# Running the test suites

Four layers, fastest first. Run the layers relevant to what you changed; a
backend change needs at least the unit + integration layers.

## 1. Backend unit tests (native, fast)

```bash
cargo test -p backend --lib
```

Pure-Rust tests in the `mod tests` at the bottom of `src/backend/src/lib.rs`.
All value-moving logic has native mock seams and is covered here.

## 2. Backend coverage (target ≥ 90% line)

```bash
./scripts/coverage.sh          # summary table
./scripts/coverage.sh --html   # browsable report
```

Uses `cargo-llvm-cov` (one-time: `cargo install cargo-llvm-cov`). Measures
unit tests only — wasm-only plumbing (live NNS fetches, init timers, cycles
receive) is intentionally out of scope. If you add value-moving logic, give it
a native mock seam so it counts.

## 3. PocketIC integration tests (real wasm, simulated IC)

```bash
cargo build --target wasm32-unknown-unknown --release -p backend   # REQUIRED first
POCKET_IC_BIN=~/.cache/dfinity/versions/<v>/pocket-ic \
  cargo test -p backend --test integration
```

`src/backend/tests/integration.rs` covers ingress access control, admin
guards, public queries, and the commit→settle sagas (refund path, burn
idempotency / PB-111 double-spend guard).

**Trap:** if the wasm or the PocketIC binary is missing, these tests **skip
with a message instead of failing** — `cargo test` staying green does NOT mean
they ran. Check the output for skip messages before reporting success.

## 4. Frontend tests

```bash
npm --prefix src/frontend test         # vitest run (CI mode)
npm --prefix src/frontend run lint
npm --prefix src/frontend run build    # tsc -b catches type errors vitest won't
```

## 5. E2E burn flow (optional, needs local network)

```bash
# Prereqs: local network running and canisters deployed
bash scripts/deploy-local.sh
bash scripts/e2e_burn_flow.sh
```

Drives both settlement paths against the live local replica: threshold met
(burn + NNS vote) and threshold missed (full refund). Creates `alice`/`bob`
identities itself. Known caveat: PB-148 — the local ledger records the wrong
block type for CMC `notify_top_up`, so the burn-notify step can fail locally
for reasons unrelated to your change.

## Reporting

Quote actual pass/fail counts from the output. Never report a suite as
passing if it skipped (see PocketIC trap above) or wasn't run.
