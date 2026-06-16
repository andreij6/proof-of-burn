# Tao-Like Reward — Research Notes (citations)

> Condensed, citation-backed facts behind the design. Four research threads: Bittensor, ICP cycle-burn
> measurement, SNS/token/buyback, and codebase reuse.

## A. Bittensor / TAO

- **128 subnet cap**, enforced as a slot limit; a new registration **deregisters the lowest-performing
  non-immune subnet**. New subnets get **~4-month immunity (864,000 blocks)**. Registration cost is
  **burned** and set by a **dynamic auction** (doubles per registration, decays) — ~1,500–2,500 TAO range.
  [opentensor/X](https://x.com/opentensor/status/1978637991276126453) ·
  [Subnet Deregistration](https://docs.learnbittensor.org/subnets/subnet-deregistration) ·
  [registration cost](https://cryptobriefing.com/bittensor-subnet-registration-cost-rises/)
- **Emissions:** 0.5 TAO/block after the **Dec 12 2025 halving** (was 1). Cross-subnet split by **EMA of net
  TAO inflow** (Taoflow), zero for negative-flow subnets. Within-subnet **41% miners / 41% validators / 18%
  owner**, scored by **Yuma Consensus** (κ=0.5 clipping + EMA bonds).
  [Emissions](https://docs.learnbittensor.org/learn/emissions) ·
  [Yuma Consensus](https://docs.learnbittensor.org/learn/yuma-consensus)
- **21M cap + milestone halving** (first halving fired at 10.5M emitted). **dTAO** (Feb 2025) replaced
  centralized root allocation with market-driven per-subnet alpha tokens.
  [dTAO whitepaper](https://bittensor.com/dtao-whitepaper) ·
  [Grayscale: eve of first halving](https://research.grayscale.com/reports/bittensor-on-the-eve-of-the-first-halving)
- **Gaming:** weight-copying (mitigated by **commit-reveal** + liquid alpha), validator cartels (κ-clipping +
  bonds), sybil (registration burn + stake-weighting + 128 cap).
  [Weight Copying](https://docs.learnbittensor.org/concepts/weight-copying-in-bittensor)
- **Criticisms:** PoA centralization / foundation-controlled validators; **~$15M revenue vs ~$328M
  printed/yr**; **41% spent on verification**.
  [arXiv 2507.02951](https://arxiv.org/pdf/2507.02951)
- **Lessons:** copy 128-slots + escalating burn-to-enter + immunity + EMA relegation + capped/halving token +
  zero-floor; **avoid** the 41% validator tax (use cycle burn as the objective metric), centralized control,
  and emission ≫ real demand.

## B. ICP cycle-burn measurement (the crux)

- **Cycle balance is controller-only.** `canister_status` returns `cycles` + `idle_cycles_burned_per_day`
  but rejects non-controllers (kept private deliberately — low balance reveals freezing-proximity).
  [Canister settings](https://docs.internetcomputer.org/building-apps/canister-management/settings) ·
  [make canister_status public — kept controller-only](https://forum.dfinity.org/t/nns-proposal-make-canister-status-public-to-anyone/15775)
- **`canister_info`** returns module_hash/controllers/history — **no cycles**.
  [Canister history](https://internetcomputer.org/docs/building-apps/canister-management/history)
- **No total-burn counter.** `idle_cycles_burned_per_day` is **idle-only** (excludes execution burn). Burn
  must be derived by **balance-delta sampling**, distorted by top-ups/refunds/transfers.
  [idle_cycles_burned_per_day forum](https://forum.dfinity.org/t/question-what-constitutes-idle-cycles-burned-per-day-and-how-is-it-measured/22457)
- **Public dashboard/metrics-api:** cycle-burn down to **subnet** only, **no per-canister** data; centralized
  + uncertified. [metrics-api](https://metrics-api.internetcomputer.org/api/v1/docs) ·
  [dashboard APIs](https://docs.internetcomputer.org/references/dashboard-apis)
- **No reverse index** controller→canisters; app canister sets are only knowable via **opt-in registration
  with proof-of-control**.
- **Blackhole observer pattern:** an immutable canister added as controller that can only reveal status —
  the de-facto way to make cycle status auditable without ceding control.
  [ic-blackhole](https://github.com/ninegua/ic-blackhole)
- **Cycles ledger (ICRC-1/2/3):** mint/burn blocks (2025) encode the target canister in the memo → funding
  routed through it is auditable (a top-up *proxy*, not a consumption meter).
  [cycles ledger](https://internetcomputer.org/docs/defi/token-ledgers/cycles-ledger)
- **Verdict:** trustless cross-app burn measurement is **not possible today**; best practical approximation =
  **blackhole observer + registration + top-up-adjusted delta sampling** ("trustless for cooperating apps").

## C. SNS / token / buyback

- **SNS launch:** one NNS `CreateServiceNervousSystem` proposal installs root/governance/ledger/index/swap +
  runs the decentralization swap; **no fixed fee** (~25 ICP rejection risk). Dapp control is handed to SNS
  **root** — a one-way decentralization.
  [What is an SNS?](https://internetcomputer.org/docs/current/developer-docs/daos/sns/overview) ·
  [1-proposal launch](https://internetcomputer.org/docs/building-apps/governing-apps/launching/launch-summary-1proposal)
- **21M cap + emission:** native SNS voting-reward minting **inflates supply** and **rewards stakers**. For a
  fixed cap distributed to *builders*, **pre-mint 21M at genesis → release from a treasury/distribution
  canister** on your own (milestone-halving) schedule. SNS reward schedule supports quadratic decay (rmin=0
  to stop). [SNS Rewards](https://wiki.internetcomputer.org/wiki/SNS_Rewards) ·
  [tokenomics/preparation](https://docs.internetcomputer.org/building-apps/governing-apps/tokenomics/preparation)
- **NNS voting with the token is impossible.** NNS voting power = ICP staked in NNS neurons only. Buildable
  model: a **canister-controlled NNS neuron** whose single vote is steered by a token-weighted in-canister
  tally. WaterNeuron proves canister-controlled neurons are production-viable (POC reference tooling exists).
  [NNS staking/voting](https://internetcomputer.org/docs/current/tokenomics/nns/nns-staking-voting-rewards) ·
  [canister-owned-neuron (POC)](https://github.com/AegirFinance/canister-owned-neuron) ·
  [WaterNeuron](https://docs.waterneuron.fi/nicp/overview)
- **Buyback-burn:** buy token on **ICPSwap/KongSwap** (ICRC-2); "burn ICP" = **ICP → cycles via the CMC**
  (the protocol-native ICP sink, deflationary + useful). DEX trades are MEV-exposed; new-token pools thin.
  [convert ICP→cycles](https://forum.dfinity.org/t/how-to-programmatically-burn-icp-into-cycles/31868) ·
  [ICPSwap trade](https://github.com/ICPSwap-Labs/docs/blob/main/02.SwapPool/Swap/02.Executing_a_Trade.md) ·
  [KongSwap router](https://kongswap.io/kb/getting-started/kongswap-router-universal-token-swapping)
- **Precedent — Gold DAO (GOLDAO):** fixed cap, **automated buyback-and-burn** from neuron ICP + stablecoin
  revenue. The exact "fixed cap + buyback-burn" pattern.
  [Gold DAO tokenomics](https://medium.com/@GoldDAO/a-look-behind-gold-dao-tokenomics-8adc509df424)
- **ICP price support:** real but **negligible in magnitude** — alignment/narrative + small structural ICP
  buyer, not a price lever. [ICP tokenomics](https://medium.com/@iantdover/the-tokenomics-of-internet-computer-protocol-are-quite-good-463a7a5880d3)
- **No native "reward builders for cycles" mechanism** exists on the IC — this would be a novel app-defined
  incentive layer (closest precedents: dev/cycle grants, known-neuron incentives).

## D. Codebase reuse (`src/backend/src/lib.rs` unless noted)

- **App registry:** Dapp Explorer — `DappListing` ~9201, `DAPPS` (MemoryId 40) ~9271, `submit_dapp` ~10174,
  categories ~9911, admin approve/reject ~10281/10305. **Gap:** stores `url` only, **not canister IDs**.
- **NNS voting:** `PoolNeuron` ~188, `POOL_NEURONS` (MemoryId 8) ~714, `call_manage_neuron` ~6730,
  `cast_nns_vote` ~3968, `gov_follow*` ~6866, commit-tally `commit_inner` ~2987, `MAINNET_PRIMARY_NEURON_ID`
  ~21, `TOPIC_GOVERNANCE` ~39.
- **Distribution precedent:** lottery `run_lottery_draw` ~8485 (+ `raw_rand` `lottery_random_u64` ~8406),
  staking `staking_sweep` ~7602 / `distribute_yield_inbox` / `YieldDistribution` ~6472.
- **Treasury + ICP→cycles burn:** `TREASURY_SUBACCOUNT` ~1705, `settle_burn_split` ~2450,
  `call_cmc_topup_transfer` ~2229, `notify_cmc_topup` ~2507, `admin_get_frontend_cycles`→`canister_status`
  ~3432, `deposit_cycles` ~3459.
- **Oracle:** XRC `fetch_xrc_usd_rate_e8s` ~9484. **No HTTPS-outcall infra** (net-new if needed).
- **Token:** **no in-app token** today (only ICP + ck-tokens; SVPP retired). SNS token is net-new.
- **Timers:** `setup_timers` ~4612 (5-min + 15-sec). **Free MemoryIds:** 26–33, 53–59, 73, 76, 88–89, 94–95,
  97–127.
- Note: a feature blurb at lib.rs ~6172 already describes "pull cycle-consumption metrics per canister …
  surface a verifiable burn ranking" — this research shows that's only achievable via per-app opt-in
  observer access, and "verifiable" means "for cooperating apps."
