---
slug: how-burn-works
question: "What actually happens to my ICP when a proposal passes?"
aliases:
  - "where does my ICP go"
  - "is the ICP really burned"
  - "what is burn to cycles"
  - "do I get my ICP back"
sources:
  - src/backend/src/lib.rs       # §11 escrow/settlement; PB-125 proceeds split
  - README.md                    # section 1, section 4
verified_at: 27a7269ea1a13a59b20e8127c4ef9036142de8d3
verified_date: 2026-06-13
---

**Answer (Discord-ready):**

It depends on whether the proposal hits its threshold:

- **Threshold met:** the leader neuron votes the community's winning side, and
  the committed ICP is taken out of your hands for good — part is converted
  into computation fuel (cycles) that keeps the app running, the rest goes to
  the project treasury that funds operations. The net effect is the same as a
  burn: that ICP leaves circulation. This is the "skin in the game."
- **Threshold missed:** the leader abstains and your committed ICP is
  **refunded**.

So your ICP is only ever spent when your side's conviction actually moved the
vote. If it didn't, you get it back.

**Notes (internal, not sent):**

- Settlement is **not** "100% to CMC" as the README prose says. Verified split
  (PB-125, lib.rs §11): committed proceeds → 50% treasury subaccount,
  25% CMC for backend cycles, 25% CMC for frontend cycles. The CMC portion
  burns ICP from ledger supply and mints cycles. The user-facing answer stays
  at the conceptual level ("leaves circulation / funds the app") because it's
  true under the split and avoids quoting percentages that may be re-tuned.
- Refund path uses treasury cover for zero-fee refunds locally; **mainnet still
  uses the older fee'd model** (see project memory 2026-06-12). If a user asks
  specifically whether refunds cost a fee, distinguish local vs mainnet and
  lean on the ledger fee entry — confirm with a maintainer if unsure which
  environment they're on.
- Threshold value itself: see `voting-threshold` entry — configurable.
