---

tags:

- design
- brief
- spec-request created: 2026-06-05 status: draft

---

# Designer Brief: Proof of Burn — Single Page Application Spec

## What We're Building

**Proof of Burn** is a DAO participation app built on the Internet Computer Protocol (ICP). Users follow a specific governance neuron and commit to burning ICP tokens to signal conviction on proposals. The primary neuron only votes once a community-wide burn threshold is met — aligning governance with genuine skin in the game.

We need a **design spec** for a single-page application (SPA) that uses **progressive disclosure**: the interface reveals more functionality as the user moves through authentication and eligibility gates. A visitor who has done nothing sees only the minimum needed to get started. A verified, eligible user sees the full experience.

---

## The Progressive Disclosure Model

The app has four eligibility tiers. Each tier unlocks the next layer of the UI. Design the page as a single continuous view that expands in place — not a multi-page flow.

### Tier 0 — Anonymous Visitor

**What they see:**

- App name, tagline, and a one-sentence explanation of the mechanism
- The primary neuron ID (with a copy button) and a prompt to follow it in the NNS
- A list of currently active NNS proposals — title, category, and deadline only
- A call-to-action to sign in

**What is hidden/locked:**

- Burn commitments
- Vote history detail
- Any personal holdings or stats

---

### Tier 1 — Authenticated (Signed In)

**Trigger:** User signs in via Internet Identity (or Plug wallet — TBD)

**Newly revealed:**

- Their connected wallet/identity displayed in the header
- Richer proposal cards: each shows current total burn committed and progress toward the threshold
- Vote history section unlocks: full log of past neuron votes, outcomes, and ICP burned per vote
- A prompt to follow the neuron if they haven't yet (verified on-chain)

**Still locked:**

- Burn commitment input

---

### Tier 2 — Verified Follower

**Trigger:** On-chain check confirms user is following the primary neuron

**Newly revealed:**

- Burn commitment UI on each proposal card: an input field and a "Commit" button
- The user's available neuron holdings displayed as context for their commitment

**Enforcement visible to user:**

- Commitment cap shown inline (cannot exceed neuron holdings)
- Threshold progress bar updates live as commitments come in
- If threshold not met by deadline: a clear "No burn, funds returned" indicator

---

### Tier 3 — Active Participant (Has Committed)

**Trigger:** User has committed to burning on at least one proposal

**Newly revealed:**

- A personal dashboard strip at the top: total ICP committed, proposals participated in, ICP burned to date
- Per-proposal status for their commitment: pending, threshold met, burned, returned
- Social share prompt when a proposal they committed to reaches threshold or gets voted on

---

## Key UI Components to Spec

### Proposal Card

The core repeating unit. Must accommodate all tiers — design states for locked, unlocked, and active. Should show:

- Proposal title and ID
- Category / topic tag
- Deadline countdown
- Burn threshold progress (amount committed vs. required)
- Burn commitment input (Tier 2+)
- Status badge (open, threshold met, voted, expired)

### Neuron Identity Block

Persistent element (header or hero). Shows:

- Neuron ID with one-click copy
- Follow status indicator (not following / following — verified on-chain)
- Link out to NNS

### Vote History Log

Tabular or card-based log. Each entry: proposal title, vote cast (yes/no/abstain), ICP burned, date.

### Personal Dashboard Strip (Tier 3)

Compact summary bar. Stats: ICP committed, ICP burned, proposals joined.

---

## Design Constraints & Principles

**Tone:** Serious, trustless, crypto-native — but not intimidating. The mechanism is novel; the UI should make it feel legible.

**Progressive disclosure method:** Use visual state changes — blur/lock overlays, collapsed sections that expand, greyed-out controls with tooltips explaining what unlocks them — rather than page redirects or separate routes.

**Single page:** Everything lives on one scrollable page. No routing. State changes driven by auth/eligibility status.

**Mobile-aware:** At minimum, the spec should note how the layout adapts to narrow viewports.

**ICP / Web3 conventions:** Users are familiar with wallet connections, neuron IDs, and on-chain concepts. No need to over-explain these; the UI should respect that literacy.

---

## Interactions to Define

1. Signing in — what happens to the page when auth state changes
2. Neuron follow verification — loading state, success, and failure
3. Committing to burn — input validation, confirmation, success state
4. Threshold reached — visual celebration / state change on the proposal card
5. Proposal expired without threshold — state change, return-of-funds notice

---

## Out of Scope for This Spec

- The actual on-chain integration / smart contract design
- Backend infrastructure
- The X/Twitter auto-post UI (nice to have, not blocking)
- Multi-neuron support (future)

---

## Deliverables Requested

1. **Information architecture diagram** — the page structure across all four tiers
2. **Annotated wireframes** — lo-fi screens for each tier state (desktop + mobile)
3. **Component inventory** — all UI components with their states (default, locked, loading, active, error)
4. **Progressive disclosure map** — a single reference diagram showing what unlocks at each tier and how
5. **Interaction notes** — written descriptions of key transitions (animations, loading patterns, error states)

---

## Open Questions for the Designer to Flag

- What is the right visual metaphor for "burning" — flame iconography, or keep it abstract?
- How do we communicate the "no burn if threshold not met" guarantee without it feeling like a warning that discourages participation?
- Should locked Tier 2/3 features be visible but clearly gated, or hidden entirely until eligible?

---

## Related Docs

- [[App Functional Overview]]
- [[Burn Mechanism]]
- [[NNS Integration]]