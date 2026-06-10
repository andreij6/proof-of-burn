#!/usr/bin/env bash
# Backend unit-test line coverage via cargo-llvm-cov (install once with
# `cargo install cargo-llvm-cov`). Target: ≥ 90% line coverage.
#
# Coverage is measured on the native unit tests only — the PocketIC
# integration tests execute the canister as wasm, which llvm-cov cannot
# instrument. Wasm-only plumbing (live NNS fetches, init timers, cycles
# receive) is intentionally out of scope; everything that moves value has a
# native mock seam and IS counted.
#
# Usage:
#   ./scripts/coverage.sh            # summary table
#   ./scripts/coverage.sh --html     # browsable report in target/llvm-cov/html
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--html" ]]; then
  cargo llvm-cov --lib -p backend --html --open
else
  cargo llvm-cov --lib -p backend --summary-only
fi
