---
slug: onboarding-tiers
question: "How do I get started / why can't I see the commit buttons yet?"
aliases:
  - "how do I sign in"
  - "what is the hotkey step"
  - "follow the leader neuron"
  - "why is everything blurred / locked"
  - "what does internet identity do here"
sources:
  - README.md                    # section 2 (progressive disclosure tiers)
  - src/frontend/src/App.tsx     # tier gating / walkthrough modal
verified_at: 27a7269ea1a13a59b20e8127c4ef9036142de8d3
verified_date: 2026-06-13
---

**Answer (Discord-ready):**

The app unlocks in stages as you complete each step — that's why some things
start blurred:

- **Just visiting:** you can see active proposal titles and copy the leader
  neuron ID. Inputs are locked.
- **Sign in with Internet Identity (II):** unlocks the full proposal cards,
  live burn progress bars, and the leader's past voting record.
- **Follow the leader:** in the NNS app, set the leader neuron as your
  followee, then add the app's canister as a **hotkey** on your neuron. The
  hotkey is what lets the app verify on-chain that you're really following — it
  can't move your funds or change your neuron. There's a guided walkthrough in
  the app that walks you through the copy-paste. Once verified, the
  **Commit ADOPT / REJECT** buttons appear.
- **After your first commit:** you get a personal dashboard strip with your
  committed total and status badges.

So if the commit buttons are missing, you're almost certainly at the
follow/hotkey step — run the in-app walkthrough and it'll unlock.

**Notes (internal, not sent):**

- Hotkey worry is common ("does this give the app control of my ICP?") —
  reassure: a hotkey grants read/vote-config visibility for follow
  verification, not custody. Be accurate, don't overpromise; if pressed on
  exact NNS hotkey permissions, point to NNS docs / a maintainer.
- Tier names map to README §2 (Tier 0–3). Frontend gating lives in App.tsx;
  re-verify wording if the tier UI changes.
