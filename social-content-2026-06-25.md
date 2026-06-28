# Cycle Burn Social Content — 2026-06-25

---

## 🐦 Twitter / X

We renamed.

Caldera → **Cycle Burn** 🔥

Same mechanic: commit ICP behind a NNS vote, hit the threshold, the Leader Neuron votes and your ICP burns to cycles. Miss it, you're refunded.

Also simplified: ICP-only commits now. Less friction, same skin in the game.

https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/

#ICP #NNS #WebThree

---

## 💼 LinkedIn

Sometimes a name just doesn't fit anymore. We renamed the app from Caldera to **Cycle Burn** — and it felt right to strip things back at the same time.

The core mechanic hasn't changed: you follow a Leader Neuron on the Internet Computer, then commit ICP behind your position (ADOPT or REJECT) on any active NNS proposal. Hit the threshold, the Leader votes the winning side and the committed ICP is burned to cycles that fund the canister. Miss it, everyone gets refunded. No free rides.

What did change: we removed multi-token commit support. No more ckBTC/ckETH/ckUSDC/ckUSDT — just ICP. It was added with good intentions but added onboarding complexity without meaningfully improving participation. Simpler is better here.

Other things shipped this week alongside the rename:
- Early Adopter yield harvesting is live — Booster neuron maturity now flows into the EA yield inbox
- X-Farm launched in experimental mode (think coordinated content signals, still early)
- NNS proposal ingestion fixed to use reward status, so the right proposals actually surface

Still fully on-chain. Still self-sustaining. Still looking for feedback from anyone deep in ICP governance.

👉 https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/

#ICP #InternetComputer #Web3Governance

---

## 💬 Discord Forum Post

**Title:** Cycle Burn — we renamed + simplified (ICP-only voting now)

Hey — quick update on what shipped this week.

**The name changed.** Caldera is now **Cycle Burn**. The old name never quite landed and this one describes what actually happens: you commit ICP, it burns to cycles, the app keeps running. Straightforward.

**Multi-token commits are gone.** We had ckBTC/ckETH/ckUSDC/ckUSDT support with an internal swap to ICP. In practice it added complexity and confusion without meaningfully improving participation. ICP-only from here.

**Other things that shipped:**
- EA yield: Booster neuron maturity now harvests into the Early Adopter yield inbox
- X-Farm: experimental feature, still rough around the edges — curious if anyone here wants to poke at it
- Voting fix: proposals now ingested by reward status (ACCEPT_VOTES) instead of decision status, which means the right proposals actually show up

App is live and fully on-chain as always: https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/
Repo: https://github.com/andreij6/proof-of-burn

Feedback welcome — especially on the rename and whether dropping multi-token was the right call.
