# ICP Cycle-Burn App Ideas — Round 1 (2026-06-20)

*Generated via an ultracode multi-agent fanout (25 agents). Goal: apps on
Internet Computer where, like this repo's **X-Farm**, users spawn a per-user
canister that does valuable recurring work and burns cycles in the process.*

> **Spine of all 10:** Like X-Farm, each app has users spawn a per-user
> canister doing **recurring valuable work that burns cycles** — but value
> comes from the **output** (cycles are non-redeemable / burned), not the
> cycles themselves. The honest kernel across all 10 is *attested state +
> threshold signing + native payments* doing something a web2 server
> structurally can't — while the expensive LLM/generation work stays off-IC
> (where it's 10–100× cheaper). The red-team pass cut the "blockchain
> costume" tells (on-IC LLM judges, "trustless price history," "fraud
> reconstruction") and kept only what ICP genuinely adds.

Ideas ordered strongest-first; each already sharpened by an adversarial
red-team pass.

---

## 1. RedTeam Beacon — on-chain-anchored AI safety scorecards

**Pitch:** A lab/auditor/enterprise spawns a canister that nightly fires a
curated adversarial probe suite (jailbreak, prompt-injection, PII-leak) at a
target model via HTTPS outcall, scores each response against a deterministic
Wasm rubric, and publishes a **non-editable, timestamped safety scorecard** —
a due-diligence receipt for model-purchase and EU AI Act conformity evidence.

**Work/burn:** hundreds of non-replicated outcalls/night + deterministic
on-chain rubric scoring (refusal detection, regex policy, PII match). Only the
receipt is anchored (probe-set hash, model-id, timestamp, scores).

**The loop:** enterprise pays a USD tier in ckUSDC → ~10% treasury, rest funds
child cycles → gets a receipt with defensive legal value.

**Why ICP:** replicated state makes the receipt immutable — a web2 eval
vendor's mutable DB structurally can't offer that.

**Watch-outs:** non-replicated outcall can't prove response bytes unmodified
→ honestly downgrade to "receipt of what was run," close via signed responses
or a replicated-outcall premium tier (~13× cost). Thin TAM (regulators
self-build; labs-self-badge is vanity). Probe-set teaching-to-the-test erodes a
fixed public set.

## 2. ScrapeKeeper — provenance-anchored knowledge bases

**Pitch:** Each user owns a canister running a scheduled fetch-extract-store
pipeline over public sources they configure, producing a growing,
**provenance-anchored** structured KB. Owner is the first customer (funds the
burn because they want the dataset) — dodges BOINC/Gridcoin's "activity no one
values" failure.

**Work/burn:** HTTPS outcall fetch → proxy LLM extraction → write records
keyed by source+timestamp. Proxy Ed25519-signs over (url+timestamp+record_hash),
verified in-canister before anchoring. Honest burn = fetch + storage (only true
compounding cycle sink); extraction is off-chain fiat.

**The loop:** activation fee + per-tier top-up (USD via XRC) funds bounded
fetch ticks + storage ceiling. Verticals where lineage *is* the product: grant
deadlines, regulatory-filing watch, arXiv citation tracking, terms-change
monitoring.

**Why ICP:** tamper-evident provenance in replicated state; vetKeys encrypt
source creds at rest; hard budget isolation (canister can't overspend).

**Watch-outs:** provenance only tamper-evident *after* the anchor unless
proxy-signed responses are required (load-bearing, not a footnote).
vetKeys-at-rest doesn't cover credential-in-use → MVP is public pages only.
Shared-subnet IPv6 egress caps throughput → low-frequency verticals only.

## 3. VaultKeeper — trustless cross-chain risk management

**Pitch:** Each user spawns a canister watching their ckBTC/ckETH/ckUSDC
portfolio; when a user-signed rule fires, it auto-executes **latency-tolerant**
jobs (allocation-band rebalancing, USD-floor circuit breakers) by
**threshold-signing real BTC/ETH withdrawals** — no single node holds the key.
Explicitly *not* stop-loss (broken by minutes-latency + 50k-sat min).

**Work/burn:** recurring 5–15min heartbeat: read ckToken balances, fetch prices
via XRC + a second independent API, evaluate rule DSL, on fire → icrc2_approve
+ minter withdrawal (subnet threshold-signs). New agents run OBSERVE-only
24–48h; multi-oracle divergence gate; destination whitelist.

**The loop:** flat disclosed compute fee only (NO performance cut, NO advisory,
NO yield routing → kills the securities/managed-money characterization).
Output = executed risk mgmt + alert stream + verifiable on-chain action log.

**Why ICP:** Chain Fusion — canister-initiated ckBTC/ckETH withdrawal is
threshold-ECDSA-signed by a subnet quorum; a web2 robo-advisor can't
custody+sign cross-chain without a hot wallet.

**Watch-outs:** stop-loss is structurally broken → out of scope (shipping it =
user harm + liability). Single price-API outcall = poisoned-oracle drain
(multi-source gate mandatory). "No custodian" overclaims (ckBTC runs through
DFINITY-gatekept KYT/OFAC Checker) → copy: "threshold-custodied +
OFAC-screened." Misconfiguration fires irreversible withdrawal →
dry-run-default.

## 4. Backtest Forge — verifiable track records, not live signals

**Pitch:** Each user's canister nightly computes their technical strategy over
a subnet-attested price series, emitting signed signals + a running backtest
performance ledger a third party can verify **was not cherry-picked or
recomputed after the fact**. Sells a verifiable track record — *not* live
trading signals (cut for securities risk).

**Work/burn:** a shared Price Oracle canister snapshots XRC BTC/USD+ETH/USD
every 5min from inception; per-user Backtest canisters compute strategies
(MA-cross, RSI, vol-breakout) as pure Wasm — thousands of candles × indicator
math = billions of instructions = the deliberate compute burn. Chunked across
timer ticks (40B-instruction/update cap).

**The loop:** weekly ICP tier (USD-priced) funds the 7-day budget. Primary
revenue = a "Verifiable Track Record" READ product: strategist publishes
methodology hash + attested performance ledger as queryable state; LPs/copiers
pay ckUSDC to read the immutable record. Tiered by history depth, not
artificial compute budget.

**Why ICP:** per-canister strategy IP isolation (web2 backtester sees your code;
yours doesn't) + subnet-attested computation provenance.

**Watch-outs:** "trustless price history" is FALSE for fiat OHLC — XRC oracle
only has depth from inception forward; deep backtests must label their data as
HTTPS-outcall-trusted (audited/stamped mode, else misrepresents trust). Thin
self-pay market without the READ product — retail doesn't value cryptographic
backtest integrity; revenue base is emerging fund managers/signal sellers.

## 5. VerdictVault — tamper-evident eval-run notarization

**Pitch:** Each user owns a canister that serves as a notarization endpoint:
the owner submits their own eval runs (agent output + rubric + scores), the
canister anchors a hash receipt in replicated state that **cannot be backdated
or silently rewritten**. Buyer = the eval/RLHF pipeline operator needing
audit-grade, reproducibility-provable, compliance-ready provenance for their
*own* runs — not a third party paying for an "independent judge."

**Work/burn:** per notarization: optional fresh proxy judge pass (single
outcall), verify proxy signature vs pinned key, store
hash(pair+rubric+verdict+timestamp) as receipt. Each owner runs their own proxy
(no shared SPOF).

**The loop:** owner pays a tiny per-notarization fee covering outcall+anchoring
(the owner IS the buyer → no revenue split). Valuable for model vendors
notarizing "we evaluated agent X under rubric R at time T" for
regulators/customers, or RLHF shops proving preference-data wasn't silently
re-run with a cheaper model.

**Why ICP:** tamper-evident past-state (the one thing ICP uniquely does) +
native per-call ckUSDC micropayments (escrow-by-construction) + per-owner
rubric/model pinning.

**Watch-outs:** "model-integrity / model-swap-prevention" is fraudulent as
specified (non-replicated outcall can't deliver it) → copy must say
"existence+timestamp anchor." Owner self-call reputation sybil makes a "growing
ledger of verdicts" worthless as a third-party signal without caller-diversity
proof. Verdict hashes are indelible (content permanence).

## 6. ConsensusLabel — QA-attestation for RLHF (B2B, self-hosted)

**Pitch:** A QA-attestation protocol that **existing labeling vendors or
in-house lab teams self-host** — the canister never sources labelers,
converting a two-sided cold-start into a one-sided B2B tool sale. Runs the
consensus/agreement verification that gates payment; stores only hashes +
agreement scores + labeler IDs + round counts (never raw pairs). Buyer =
compliance buyers pulled by EU AI Act Art. 10–12 data-governance provenance.

**Work/burn:** ingest labeler responses via the vendor's existing UI; consensus
pass = pairwise agreement matrix + Fleiss' kappa (real but tiny Wasm), re-round
until threshold, sign each accepted pair's attestation as certified-variable
state. Add labeler staking/slashing (collusion detect-and-punish). LLM RLAIF
pre-screen DEFERRED.

**The loop:** lab/buyer deposits ckUSDC per batch via escrow; canister releases
payment per accepted, consensus-verified pair only (quality-gated). 10%
treasury; a slice funds the consensus cycles.

**Why ICP:** certified variables make QA state tamper-evident — a buyer
cryptographically verifies the process ran and met threshold without trusting a
labeling vendor's dashboard (the trust dep you can't escape with Scale
AI/Snorkel/Labelbox). Trustless escrow-release-on-consensus is a second real
additive.

**Watch-outs:** two-sided cold-start is near-fatal as originally specified →
the B2B-vendor-self-host reframe is load-bearing (onboard ONE vendor/lab
first). Trivial burn magnitude → lean on attested output, not "real Wasm
execution" narrative. Raw-pairs-off-chain kills IP/permanence liability.

## 7. PrefForge — auditable synthetic RLHF procurement

**Pitch:** A per-data-buyer canister that generates synthetic preference pairs
via HTTPS outcalls to a hosted LLM proxy and **anchors the procurement process**
(which outcalls, when, what params, how many the consistency filter discarded)
in a tamper-evident ICP chain paired with a proxy-side signed transparency log.
Honest about what it proves: **process attestation, not input-integrity of the
LLM output**. Sold as an auditable synthetic-data procurement trail for
regulated mid-tier model deployments.

**Work/burn:** take prompt spec → K=3 independent outcalls producing 2
completions + a preference judgment → self-consistency aggregation
(majority-vote, honestly labeled self-attested) → hash-chain each accepted
pair's attestation to the previous one → deliver signed dataset. Proxy commits
every served response to its own append-only public Merkle log; ICP chain
references each log-entry hash → end-to-end integrity = proxy-log input
integrity + ICP immutability.

**The loop:** lab deposits ckUSDC per N attested pairs. Honest split: (a) proxy
token cost paid direct to operator (real payment, not "burn"), (b) ICP cycles
for outcall+aggregation+storage+attestation (the actual burn — small, admitted
as overhead), (c) 10% treasury.

**Why ICP:** ICP is the immutability anchor the proxy operator cannot rewrite (a
web2-only vendor CAN rewrite their own log); the chain proves the process ran.

**Watch-outs:** self-defeating provenance — non-replicated outcall means the
hash chain proves immutability of what one replica *recorded*, not integrity of
what the LLM *produced* → the proxy-side signed log is load-bearing, not
optional. "Burn funds generation" is economically incoherent (LLM cost is
off-IC). Demand speculative — frontier labs self-generate, mid-tier use
Argilla/Gretel cheaply.

## 8. MintPress — portable, attested analyst newsletter bureau

**Pitch:** A per-user canister running a weekly on-chain newsletter bureau for
an analyst: gathers live NNS governance proposals + web context, drafts a
grounded long-form issue via a pluggable LLM proxy, and signs every issue into a
**portable, cryptographically-attested archive that survives deplatforming and
compounds as a reputation asset**. The archive — not the burn — is the product
and the moat.

**Work/burn:** weekly timer → inter-canister query of NNS governance for
new/changed proposals → non-replicated outcalls to a pluggable bring-your-own
proxy for web context + LLM draft → Wasm post-processing renders markdown + a
signed issue manifest (canister principal + timestamp + content hash in an
`ic-certified-map` Merkle tree, threshold-signed) → append to growing
stable-memory archive.

**The loop:** subscriber pays a USD tier in ckUSDC. **Right-sized split:** only
the actual operating cycle budget (outcall+storage, pennies) mints cycles; the
bulk routes as **liquid ICP** — ~60% analyst, ~30% treasury, ~10% reserve.
This kills the "85%-to-non-redeemable-cycles" trap. Issues must be synthesis +
curated opinion + longitudinal track record (NOT a per-proposal LLM verdict —
that's the existing AI Proposal Review's job).

**Why ICP:** attested state (every issue signed by the user's canister
principal with verifiable timestamp) → tamper-evident authorship/provenance for
reputation/disclosure; per-user canisters make the archive portable, user-owned,
censorship-resistant (for back-catalog); on-chain ICRC payments (no Stripe
freeze).

**Watch-outs:** the valuable work (LLM drafting) is off-chain fiat; on-chain
burn is ~no-op + pennies of outcall/storage → "the burn is the cost of the
deliverable" is FALSE and must not be the pitch. Single-point proxy gates
new-issue production → pluggable/BYO proxies mandatory or censorship-resistance
is a costume (holds for back-catalog only). Content/IP liability (AI governance
analysis quoting web context, owner as named publisher) needs AI-assisted
disclosure + grounded-sources manifest + content policy. Tiny TAM (NNS
readership is hundreds).

## 9. CiteChain — trustlessly-auditable "this answer is grounded" receipts

**Pitch:** A per-user canister that takes an LLM answer + the canonical sources
it cites, fetches each source, and stamps a signed on-chain receipt proving
whether the answer **literally quotes** the source — a re-verifiable grounding
certificate. Stripped of the oversold LLM-entailment claim (too weak on-IC) and
restricted to fetch-friendly canonical sources. Closes the loop **internally
first** — as the attestation layer for this project's own AI outputs (AI
Proposal Review verdicts, X-Farm drafts) where the platform is the beneficiary
of its own trust signal.

**Work/burn:** per-answer, per-cited-URL: HTTPS outcall the source (capped
bytes) → deterministic verbatim-quote check in pure Wasm (substring/fuzzy match,
fully replicated, no API key, no proxy) → hash source content + answer → store
signed receipt {answer_hash, source_url, source_content_hash, fetched_at,
verdict: quoted|partial|absent}. Hash-anchor only (never snapshot bytes →
sidesteps IP). Restricted domains: arXiv, NNS proposal text (on-IC), GitHub raw,
government/regulatory PDFs, canister state. JS-rendered SPAs/anti-bot/paywalled
explicitly excluded (surfaced as a feature: only independently re-verifiable
sources eligible).

**The loop:** folded into the existing per-product fee (proposal review / tweet
draft) as a cheap add-on rather than standalone — the cold-start
external-demand problem is never faced because it's never solved. Platform is
the beneficiary of its own trust signal.

**Why ICP:** attested state anchors source_content_hash + verdict in replicated
state (tamper-evident, re-checkable by anyone re-fetching); HTTPS outcall from
inside the canister means "what was fetched" is attested, not asserted; the
deterministic quote-check is the one path that's trustlessly auditable.

**Watch-outs:** arbitrary-URL fetch is a landmine (canisters can't render JS) →
domain restriction is load-bearing. Single-replica fetch breaks any "attested
fetch" claim beyond one replica's word → deterministic quote-check + hash-anchor
is the honest scope (a web2 transparency log achieves similar tamper-evidence →
anchoring is marginal-additive). Standalone market failure: submitters only pay
to verify answers they expect to pass (selection bias) → the internal-use reframe
avoids this. Link-rot decays re-verification.

## 10. ChainSynth — provenance-attested synthetic risk datasets

**Pitch:** A thin provenance-attestation + settlement layer for synthetic
risk-feature datasets: the canister reads **current** trustlessly-readable
cross-chain state (controlled-asset flows, UTXO/balance snapshots, ckToken index
state), binds a published dataset's Merkle root to those seed hashes + a
deterministic open-source transform id + an LLM-attestation hash, and settles
ckUSDC payment + license delivery. Expensive generation (mutation, DP
perturbation, labeling) runs **off-IC where it's 10–100× cheaper**; only the
cheap, trustlessly-valuable attestation + settlement runs on-IC. Buyer =
crypto-native risk vendors (wallet-screening, on-chain AML, MEV/fraud-detection),
not banks.

**Work/burn:** on-IC: (a) seed-bound attestation — reads what it CAN trustlessly
read (bitcoin_get_utxos for controlled addresses, ckToken index reads —
**current state, not temporal history**), binds the dataset Merkle root to seed
hashes + open-source transform id + LLM-attestation hash; (b) ckUSDC settlement
+ license delivery. Off-IC: mutation, DP, rules labeling, LLM narrative —
open-source-reproducible so attestation is re-derivable. Marketed as
"verifiably-grounded synthetic risk features," not "fraud reconstruction."

**The loop:** risk vendor pays ckUSDC per-dataset/subscription; canister
attests seed-grounding + settles; vendor resells scoring to its crypto-native end
users (external buyer values the auditability, not circularly from a treasury).
90/10 split removed (internally circular) → flat attestation/settlement fee.

**Why ICP:** seed-bound attestation binds the dataset to real on-chain state a
buyer can re-verify (the one genuinely-IC-additive property); ckUSDC settlement
removes escrow; attestation is re-derivable (open-source transform) → provenance
is valuable *and* cheap.

**Watch-outs:** trustless **temporal** fraud-graph reads do NOT exist
(bitcoin_get_utxos = current unspent set, not history; structuring/peeling-chain/
mix-and-return require a centralized indexer via outcall — the exact "trust our
private DB" the original differentiator claimed to eliminate) → scope to
verifiably-grounded risk features only. Banks are the worst-fit buyer (18-mo
procurement, SOC2/DPA, "a bank cannot sue a canister") → the crypto-native-vendor
reframe is load-bearing. Cycle economics inverted (bulk gen 10–100× cheaper on
AWS). Privacy/liability: weak DP can reconstruct identifiable activity;
mislabeling CoinJoin/mixing as fraud = defamation risk, and provenance makes the
legal exposure *provable*.

---

## Meta takeaways from the red-team pass

- **Honest burn framing:** the genuine on-IC cycle burn is almost always
  *attestation/aggregation/storage/outcall-transport* — pennies. The expensive
  "AI work" runs off-IC. Pitching "cycles fund the generation" is economically
  incoherent and gets caught. Sell the **attested output**, not the burn.
- **The load-bearing pattern that survives:** ICP as an **immutability/
  attestation anchor + native settlement** that a web2 server structurally cannot
  replicate — paired with an **off-chain signed log** to close the single-replica
  trust gap (the non-replicated outcall is the recurring crack in almost every
  idea).
- **Highest near-term feasibility:** RedTeam Beacon, VerdictVault, CiteChain,
  ScrapeKeeper (pure outcall + Wasm + attested state; no Chain-Fusion
  custody/securities surface). **Highest upside but most risk:** VaultKeeper
  (Chain-Fusion threshold signing is the strongest unique enabler, but securities
  + irreversible-action liability are sharp).