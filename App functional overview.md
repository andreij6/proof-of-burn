---
tags:
- brainstorm
- functional-spec
- overview created: 2026-06-03 status: draft
---

# Proof of Burn — Functional Overview

> [!abstract] Concept A DAO app where users follow a primary ICP neuron and commit to burning ICP tokens as a signal of conviction. The neuron only votes on a proposal once a minimum burn threshold is met by the community — aligning votes with genuine skin in the game.

---

## Core Components

### 1. Neuron Identity & Follow CTA

The app prominently displays the primary neuron ID with a one-click **Copy** action so users can easily find and follow it in the NNS. This is the entry point — users must follow the neuron before they can participate.

### 2. Active Proposal Listings

All currently active NNS proposals are listed in the app, giving users visibility into what the community could vote on. Each listing shows enough context to understand the proposal at a glance.

### 3. Vote History

A log of all past votes cast by the neuron, including the outcome and how much ICP was burned to trigger each vote. Builds transparency and a track record over time.

### 4. Burn-to-Vote Mechanism

For each proposal, users commit to burning an amount of ICP of their choosing. The system enforces:

- A **minimum total burn threshold** per proposal — the neuron will not vote unless this floor is reached
- If the threshold is not met by the proposal deadline, **no ICP is burned** and committed funds are unlocked and returned
- Users cannot commit more ICP than they hold across their neuron(s) for a single vote

### 5. Social Broadcasting (X / Twitter)

Automated posts to X are triggered by key events:

1. A proposal reaches its burn threshold
2. A vote is cast and ICP is officially burned

> [!idea] Intent Turn on-chain governance activity into public signal — rewarding participation with visibility and keeping the broader ICP community informed.

### 6. Authentication & Eligibility Checks

Users must be signed in to participate. Before a user can commit to burning on a proposal, the app verifies:

- The user is authenticated
- The user is actively **following the primary neuron** in the NNS (verified on-chain)
- Their committed burn amount does not exceed their neuron holdings

---

## Open Questions

- [ ] What wallet/identity standard do we use for sign-in? (Internet Identity, Plug, etc.)
- [ ] How is "following" verified on-chain?
- [ ] What determines the minimum burn threshold per proposal — flat rate, governance vote, or dynamic?
- [ ] What happens to uncommitted ICP if a proposal expires without hitting the threshold?
- [ ] How is the burn transaction executed and verified on-chain?

---

## Related Notes

- [[NNS Integration]]
- [[Burn Mechanism]]
- [[X Integration]]