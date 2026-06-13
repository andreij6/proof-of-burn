---
slug: voting-threshold
question: "How much ICP has to be committed before the leader actually votes?"
aliases:
  - "what is the threshold"
  - "is it 250 ICP"
  - "when does the leader vote"
  - "what makes a proposal pass"
sources:
  - src/backend/src/lib.rs       # §6 config: default_threshold, default_threshold_usd_e8s; threshold-met logic
  - README.md                    # section 1
verified_at: 27a7269ea1a13a59b20e8127c4ef9036142de8d3
verified_date: 2026-06-13
---

**Answer (Discord-ready):**

A proposal only triggers the leader to vote once the **combined** ICP committed
to both sides (adopt + reject) reaches a configured threshold. That threshold
isn't a fixed constant — maintainers can set it, and it can even be set in
**USD value** rather than raw ICP. If you tell me which proposal you're looking
at I can give you the number it's currently set to; the live value shown in the
app's progress bar is always the authoritative one.

**Notes (internal, not sent):**

- Do **not** quote "250 ICP" from the README — it's stale. Code default is
  `200_000_000` e8s = **2 ICP**, and `init` overrides it from init args, and
  admins can change it at runtime (`admin_set_default_threshold` /
  `admin_set_default_threshold_usd`).
- USD mode: `default_threshold_usd_e8s` / per-proposal `threshold_usd_e8s` —
  pots are valued at the cached ICP/USD (XRC) rate when set; this supersedes
  the ICP threshold.
- Because it's per-proposal and configurable, the honest answer points the user
  at the app's live progress bar rather than caching a number. Never cache the
  numeric value here.
