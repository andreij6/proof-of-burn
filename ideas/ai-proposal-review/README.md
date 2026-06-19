# AI Proposal Review ("AI Review" / Chat with Proposal)

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-19.

A pay-per-use **"AI Review"** button on every proposal. A signed-in user who holds
ICP confirms a small crypto fee, the canister asks **Gemini** to review the
proposal — *is this good or bad for the Internet Computer, and why* — optionally
pulling in the linked GitHub PR/release, and returns a structured verdict the
user can **share on X**.

---

## Relationship to the existing `ideas/ai-reviewer/` (PB-510)

This is a **re-scope of the same feature space**, not a fresh one. The prior
`ai-reviewer` spec (PB-510, 2026-06-14) designed a **prepaid-credit, per-turn
chatbot** ($0.05/turn, ICP-only credits, LLM behind a **Google Cloud Run
wrapper**). The user's new framing changes five things:

| Dimension | PB-510 (`ai-reviewer`) | This scope (user's ask) |
|---|---|---|
| Payment | Prepaid credit balance, $0.05 **per chat turn** | **One-shot pay-per-review**, fee **confirm dialog** |
| Tokens | ICP-only credits | **Any supported crypto** (ICP/ckBTC/ckETH/ckUSDC/ckUSDT) |
| Button gating | All authenticated users | **Users who hold ICP** in their wallet |
| LLM transport | Cloud Run wrapper holds the key | **Direct Gemini API**; key stored on-chain via **vetKeys** |
| Output | Chat bubbles | A **shareable-on-X** positive/negative verdict; GitHub-PR aware |

**Recommendation:** supersede PB-510 with this. Keep PB-510's two genuinely
valuable, still-correct findings (they're reused verbatim below):
1. **Non-replicated HTTPS outcalls** are the make-or-break for LLM calls.
2. **Canister state is not secret from node providers** — the key-secrecy
   caveat, which directly shapes the vetKeys decision here.

The user's title says "AI **Chat** with Proposal" but the body describes a
**one-shot review on fee-confirm**. This scope treats the **one-shot paid review
as the MVP** and folds the conversational follow-up chat (PB-510's vision) into
an optional **Phase 2**. → *Open question Q1.*

---

## The core technical findings (researched 2026-06-19)

1. **LLM + HTTPS outcalls = determinism problem, SOLVED by non-replicated calls.**
   A *replicated* outcall runs on ~13 replicas that must agree on the response;
   an LLM returns 13 different texts → consensus fails. **Non-replicated outcalls
   are now LIVE** (`is_replicated: false`): a single replica makes the call, **no
   transform function needed, ~100× cheaper**. Trade-off: one node sees/relays
   the response and could tamper — acceptable because the output is a
   **non-financial advisory** (no value moves on its content). This is the design.
   ([forum: non-replicated live](https://forum.dfinity.org/t/announcing-two-major-upgrades-for-https-outcalls-ipv4-support-non-replicated-calls-are-now-live/54580),
   [outcalls how-it-works](https://internetcomputer.org/docs/references/https-outcalls-how-it-works))

2. **Gemini is a direct REST call.** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`
   with header `x-goog-api-key: <KEY>`, JSON body. Supports **structured output**
   (`responseSchema`) → we get a clean `{verdict, rationale[], ic_impact}` instead
   of parsing prose. ([Gemini API ref](https://ai.google.dev/api),
   [API keys](https://ai.google.dev/gemini-api/docs/api-key))

3. **GitHub PRs via Gemini's URL context tool (GA).** Gemini can fetch up to 20
   **public** URLs and ground its answer in them — point it at the PR/release
   URL extracted from the proposal. No separate GitHub API integration required
   for public repos (dfinity/ic etc. are public). Caveat: URL-context can't be
   combined with function calling, and the URL must be public.
   ([URL context GA](https://developers.googleblog.com/url-context-tool-for-gemini-api-now-generally-available/),
   [docs](https://ai.google.dev/gemini-api/docs/url-context))

4. **On-chain API key — REVISED (Q4): doable today via confidential computing
   (SEV-SNP), not via vetKeys alone.** *(Supersedes an earlier "confirmed no" —
   that was based on the pre-TEE execution model and was wrong for SEV-SNP nodes.
   The IC founder confirmed it's doable today;
   [tweet](https://x.com/dominic_w/status/2067544176825184662) — paywalled, so
   this is reconstructed from DFINITY's TEE docs.)*

   Two separate facts:
   - **vetKeys alone is NOT enough.** vetKeys protects data only *up to
     decryption* — *"if you decrypt it in the canister, it's out in the open
     again"*
     ([vetKeys use cases](https://medium.com/dfinity/onchain-privacy-in-action-a-guide-to-vetkeys-use-cases-d733aa6f9da5)).
     It gives **encrypted-at-rest**, not in-use protection.
   - **SEV-SNP gives the in-use protection.** The IC runs replicas in **AMD
     SEV-SNP** confidential VMs: the GuestOS (replica) **RAM is hardware-encrypted
     and isolated from the host — "even if the HostOS/hypervisor is compromised,
     the confidentiality and integrity of the GuestOS is preserved."**
     ([IC TEE overview](https://learn.internetcomputer.org/hc/en-us/articles/46124920595988-Trusted-Execution-Environments))
     So a key decrypted and used in canister memory is shielded from the node
     operator by the CPU. This is the mechanism that makes it "doable today."

   **The clean on-chain pattern = vetKeys (at rest) + SEV-SNP (in use):** store the
   Gemini key as ciphertext; decrypt only inside the enclave at call time; the host
   can't read either the disk ciphertext or the in-RAM plaintext.

   **CAVEATS (must verify before trusting):**
   - **Rollout is early.** First SEV-SNP node deployed **Nov 2025**
     ([forum](https://forum.dfinity.org/t/first-sev-snp-enabled-node-deployed/59499));
     **not yet confirmed across all mainnet subnets**. → **Must confirm our
     canister's subnet is fully SEV-SNP-enabled** before relying on this.
   - **Trust shifts to AMD hardware + attestation**, and SEV-SNP has had breaks
     (e.g. RMPocalypse, 2025). Hardware-enforced ≠ unbreakable like chain-key crypto.
   - **Budget-cap + rotate the key regardless** (defense in depth).

   → **Decision D4 is now a choice (see below).** The **Cloud-Run proxy** remains
   the option that needs **zero trust in IC confidentiality** (key never on the
   IC); the **SEV-SNP + vetKeys** option keeps the key on-chain as the user wants,
   gated on confirming subnet SEV-SNP status.

---

## What ships (MVP)

- An **"AI Review"** button on each proposal card (Dashboard/voting list),
  **enabled when the signed-in user holds any supported token with a balance ≥ the
  fee** (D2); disabled/tooltipped otherwise.
- A **confirm dialog** (clone of the Explorer listing flow): pick a token, see the
  live USD-priced **$0.25** fee (D3), deposit to a per-user escrow, confirm.
- The canister charges the fee → **routes it to the treasury** → calls our
  **Cloud-Run proxy** (D4) which makes the Gemini call, seeded with the canister's
  authoritative proposal text (+ the linked PR/release URL via URL-context). The
  proxy returns a **structured response with TWO renderings** (D5): a
  **tweet-friendly** string and a **detailed** breakdown (verdict + rationale +
  IC impact). The outcall itself is **non-replicated**.
- The result is shown in-app (detailed) with a **"Share on X"** button that posts
  the **tweet-friendly** text (reuses `shareProposalOnX`). **Reviews are NOT
  stored** (D5) — the text lives only in the tweet/session.
- **Refund on failure**: a non-200/timeout/parse-failure refunds the fee
  (treasury-fronted, so also subject to the **`require_treasury_can_front` gate**).

See **[01-ux-spec.md](01-ux-spec.md)**, **[02-backend-and-tasks.md](02-backend-and-tasks.md)**,
**[03-reuse-map.md](03-reuse-map.md)**, **[04-adversarial-review.md](04-adversarial-review.md)**.

---

## Decisions (locked 2026-06-19)

- **D1 — One-shot.** Strictly one-shot paid review. No conversational chat (PB-510's
  chat vision is dropped).
- **D2 — Gating.** Button enabled when the user holds **any supported token with a
  balance ≥ the fee** (check all five token balances client-side, not just ICP).
- **D3 — Fee = $0.25.** `AI_REVIEW_FEE_USD_E8S = 25_000_000`, USD-priced via XRC.
- **D4 — Key custody: REOPENED (two viable paths; pick one).** Research revised
  the earlier "proxy-only" call — an **on-chain** key *is* safe today on SEV-SNP
  nodes (finding #4). Options:
  - **D4a — On-chain (SEV-SNP + vetKeys):** the user's preference. Key stored
    vetKeys-encrypted, decrypted/used inside the SEV-SNP enclave; never leaves the
    IC. **Gated on confirming our subnet is fully SEV-SNP-enabled** + accepting the
    AMD-hardware trust assumption. Direct Gemini call from the canister.
  - **D4b — Cloud-Run proxy:** key off-chain in the proxy; canister→proxy bearer
    token scoped/budget-capped/rotatable. Needs **zero trust in IC
    confidentiality**, but adds a trusted off-chain hop.
  - **Recommendation:** go **D4a** if the canister's subnet is verified SEV-SNP
    (matches the user's intent + keeps it pure-ICP); otherwise **D4b** as the
    no-confidentiality-assumption fallback. Either way: budget-cap + rotate. The
    proxy also conveniently solves the `responseSchema`+`url_context` combo (it can
    do the 2-call reformat off-chain) — under D4a that logic moves on-chain.
- **D5 — Don't store reviews.** The proxy/Gemini returns two renderings — a
  **tweet-friendly** string and a **detailed** in-app breakdown. We render and
  (optionally) tweet; nothing is persisted on-chain. (No `AI_REVIEWS` store → one
  fewer MemoryId; "View AI Review" / permalink dropped.)
- **D6 — Framing.** Every result shows an unmissable **"AI opinion — not financial
  or voting advice"** disclaimer (on-card and folded into the tweet), and a verdict
  never auto-applies to the user's vote/commitment. (Q6 was: should we worry the
  branded verdict looks like vote-steering / investment advice? → yes; the
  disclaimer + read-only-advisory stance is the mitigation.)

## MemoryId note (registry drifted)
PB-510 reserved `94/95`, but **94 is now taken** (`FEATURED_QUOTES`, shipped) and
`53` (treasury cache, shipped). Currently free: **26–33, 54–59, 73, 76, 95, 97+**.
With **D5 (no review store)** this feature needs **95** (`AI_REVIEW_QUOTES`) and
**97** (`AI_LAST_REVIEW_AT` cooldown); **D4a** adds **98** (vetKeys-encrypted key
cell). Claim and update the registry *before* building.
