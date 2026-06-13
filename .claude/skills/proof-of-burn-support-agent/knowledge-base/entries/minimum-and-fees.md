---
slug: minimum-and-fees
question: "What's the minimum I can commit, and what fees are there?"
aliases:
  - "minimum commit"
  - "how much ICP do I need"
  - "what are the fees"
  - "does it cost anything"
sources:
  - src/backend/src/lib.rs       # MIN_COMMIT_E8S (line ~15), ledger fee 10_000 e8s
  - README.md                    # section 1
verified_at: 27a7269ea1a13a59b20e8127c4ef9036142de8d3
verified_date: 2026-06-13
---

**Answer (Discord-ready):**

The minimum commitment is **1 ICP**. On top of whatever you commit, ICP ledger
transfers carry the standard network fee of **0.0001 ICP** (this is the
Internet Computer's fee, not ours). The protocol's own fee model is being
revised right now, so I'd rather confirm the exact current protocol fee with a
maintainer than quote you a stale number — but the ledger 0.0001 and the 1 ICP
minimum are firm.

**Notes (internal, not sent):**

- `MIN_COMMIT_E8S = 100_000_000` (1 ICP); `MAX_COMMIT_E8S = 100_000_000_000_000`
  (1M ICP sanity ceiling) — both firm in lib.rs.
- Ledger transfer fee is `10_000` e8s = 0.0001 ICP — firm.
- The README's "0.005 ICP protocol fee on deposit" is **not** safe to quote:
  the commit model went zero-fee locally (project memory 2026-06-12) while
  mainnet still runs the fee'd model. Do not assert 0.005. If the user needs
  the exact protocol fee, ask which environment and/or escalate.
