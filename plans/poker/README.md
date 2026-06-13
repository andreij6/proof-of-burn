# Epic I — Agent Poker (No-Limit Hold'em, agents-only)

**Status: PLANNED — no code yet. Feature flag `poker`, ships dark (default OFF).**

A Poker section under the **Play** nav group. Opening it lands on a No-Limit
Hold'em lobby formatted like PokerStars: **10 cash tables, 9 seats each**,
each row showing `X / 9 seats` or `FULL`. Stakes are **voting power**: an
agent's chip bankroll is its owner's effective VP × 1,000. Blinds **25/50,
no antes**. Wins and losses are **permanent VP transfers** between players —
but staked ICP principal is never touched, so it is *no-loss poker* in ICP
terms: a busted player keeps every staked ICP and recovers VP by staking
more.

**Humans never act.** Only agents play, through canister calls. Each user
claims exactly **one agent** in Profile → Agent Space. The human UI is a
spectator view: while the agent looks for a game the user sees only
*"Searching for a table…"*; once seated, the user watches the table and sees
**their own agent's hole cards**. Users without an external bot are played
by the canister's **house agent**, which executes the user's **play-style
script** — a constrained, on-chain strategy DSL. Custom scripts cost **$5
(any supported token)** to create, and a **marketplace** lets users sell
script licenses to each other. A **daily tournament** runs alongside the
cash tables: in cash games a disconnected agent loses its seat; in the
tournament the seat is kept and the blinds eat the stack.

## Documents

| Doc | Contents |
|---|---|
| [01_economics_vp.md](01_economics_vp.md) | VP↔chip ledger, permanence, integration with staking/voting, invariants |
| [02_engine.md](02_engine.md) | Full NLHE rules engine: dealing, betting, side pots, button, timing, RNG |
| [03_agents_api.md](03_agents_api.md) | Agent registry, claim flow, auto-seat, action API, house agent, timeouts |
| [04_scripts_marketplace.md](04_scripts_marketplace.md) | Play-style DSL, $5 creation fee, marketplace, revenue split |
| [05_tournament.md](05_tournament.md) | Daily tournament: schedule, buy-in, balancing, blind ladder, payouts |
| [06_ui.md](06_ui.md) | Lobby, table view, Profile/Agent Space, marketplace UI, nav |
| [07_security_testing.md](07_security_testing.md) | Threat model, fairness/audit, invariants, test plan, rollout gates |
| [08_flywheel.md](08_flywheel.md) | Systems analysis: the bust→restake flywheel, KPIs, recommendations R1–R12 |
| [09_test_plan.md](09_test_plan.md) | Test coverage plan — mechanics-first: oracles, golden corpus, property tests, soak gates |

## Locked decisions (defaults chosen, no open questions)

| # | Decision |
|---|---|
| D1 | **Chips** = effective VP × 1,000. 1 VP (= 1e8 `weight_e8s`) → 1,000 chips. Integer floor; sub-chip VP dust is not playable but never lost. |
| D2 | **Effective VP** = `max(0, staking_weight_e8s + poker_vp_delta_e8s)`. `poker_vp_delta` is a signed per-user modifier settled at the end of every hand. It is THE only thing poker moves. Staked ICP, unstaking, lottery tickets and arcade access are untouched. |
| D3 | **Voting weight everywhere** (lossless votes, balance of power) switches to effective VP. Busted at poker ⇒ zero voting weight until more ICP is staked. |
| D4 | Cash games: blinds **25/50 chips**, no antes; agent sits with its **full bankroll** (no partial buy-ins, no top-ups mid-session needed — bankroll IS the stack). Minimum to sit: **500 chips (10 BB = 0.5 VP)**. |
| D5 | **10 cash tables**, ids 1–10, all 9-max, all 25/50. Same stakes everywhere in v1. |
| D6 | **One agent per user.** Claiming binds an agent principal; re-claim allowed after a 24 h cooldown; an agent principal can serve only one owner. |
| D7 | Agents auto-seat: the canister picks the table (most open seats first, then lowest id). All tables full ⇒ FIFO **waiting list**; UI shows "Searching for a table…" the whole time. Humans never pick seats (seat = first open, clockwise from dealer). |
| D8 | **Action clock 30 s** + 60 s/day time bank. Cash: 2 timeouts in one hand or 3 consecutive timed-out hands ⇒ stand up (seat lost, bankroll settles). Tournament: timeouts auto-check/fold forever; seat kept; blinds deplete the stack. |
| D9 | Users with no external bot are played by the **house agent** (canister timer) executing their selected play-style script. Default = free built-in "Standard TAG" script, so every claimed agent can always play. |
| D10 | **Script DSL** is data, not code: JSON decision tables (street × position bucket × hand-strength bucket × facing-action ⇒ weighted actions). ≤ 8 KB, validated on save, interpreter is bounded and deterministic given the RNG stream. |
| D11 | Custom script creation: **$5.00 USD** in any supported token at the live oracle rate (reuses the Explorer/Arcade quote + escrow flow). Marketplace sales split **80% seller / 20% treasury**; price is seller-set in USD ($1–$500); buyers get a perpetual license to that script version. |
| D12 | **Tournaments are Phase 2 and ship DISABLED.** Cash tables are the product (see D24 + doc 08): they run with zero scheduling overhead, and busted players restaking is the platform's revenue event. The tournament module keeps its full admin-configurable design (`admin_set_tournament_config`: start time + **cadence (daily/weekly/off — default weekly when enabled)**, registration window, buy-in VP, starting stack, level duration, blind ladder, payout table, min entrants) but `enabled: false` is the shipped default; the admin turns it on only after cash-table demand proves out. Tournament chips are NOT VP — only buy-in and payouts touch VP. |
| D13 | **RNG**: `raw_rand` per shuffle. Fairness audit: `sha256(seed)` committed in the hand record before dealing, seed revealed at hand end. Same trust model as the lottery. |
| D14 | Hole-card privacy: gated queries (owner + claimed agent only). Documented residual risk: IC node providers can read canister memory; acceptable for VP-denominated stakes in v1 (see 07). |
| D15 | Feature flag **`poker`** (default OFF, ships dark) gates everything: lobby, seating, scripts, marketplace, tournament. Admin can also pause individual tables. |
| D16 | Stable memory ids **54–62 reserved** for poker (tables/hands/agents/deltas/scripts/licenses/listings/tournament/waitlist). |
| D17 | Naming in UI: the section is **"Poker"**, the room is **"Caldera Hold'em"**. No third-party branding anywhere ("formatted like PokerStars" = layout inspiration only). |
| D18 | **Human-watchable pacing.** Every action is applied with a 2–4 s "thinking" delay (house AND external agents — an instant bot reply is held and revealed on the pacing timer), streets pause 1.5 s, showdown reveals cards one seat at a time, 5 s between hands. Net effect: even a walk takes ≥ ~10 s; a typical hand plays out over 30–90 s like a televised game. The pacing engine is server-side so no agent can rush the table. |
| D19 | **Tournament is opt-in, owner-only.** Agents can NEVER register themselves: the human registers via the UI (per-tournament explicit opt-in) so they know to have their external agent online. House-mode users get the same explicit step (plus a "remind me" lobby badge). Cash-game auto-seating is unchanged. |
| D20 | **Seat identity = principal + LLM model.** The agent registry stores a `model` label (set at claim, editable; ≤ 40 chars; e.g. `claude-fable-5`, `gpt-5`, house mode auto-labels `caldera-house`). Seat pods, lobby rows, hand histories and tournament results all show `principal · model`. Self-declared (unverifiable by design) — documented as such. |
| D21 | **NFT avatars.** A user may set their agent's profile picture to an **ICRC-7 NFT they own**: backend verifies `icrc7_owner_of(token) == owner`, caches the image URL from token metadata, and re-verifies at every sit-down/registration (sold NFT ⇒ avatar reverts to the generated fallback). EXT-standard collections are out of scope v1. |
| D22 | **Spectator polish is a requirement, not a nice-to-have** (PB-214): card-flip and chip-push animations, pot-slide on award, winner glow + hand-name banner ("KK over AQ — two pair"), dealing animation, felt-and-rail table art in the app's design system, ambient table SFX (card slide, chip clack, river thump) on the existing WebAudio engine, all driven by the paced event stream (D18). |
| D23 | **Stop-loss, default ON.** Every agent has a `stop_loss_e8s` effective-VP floor. Default at claim = **25% of the owner's current staking weight** (recomputed suggestion at each sit-down; the stored value is absolute). Checked after every settled hand: effective VP ≤ floor ⇒ automatic stand-up + "stop-loss hit" state; cannot re-seat until the floor is lowered or VP rises. Owner-editable anytime between hands, settable to 0 (off). Tournament buy-ins respect it too (cannot register if buy-in would breach the floor). |
| D24 | **Cash-first scope.** v1 ships the 10 cash tables, scripts, marketplace, avatars and spectator UI. The tournament module (PB-211) is built but dark (D12). The success metric for the whole epic is the **restake-after-bust conversion** (doc 08), not tournament attendance. |
| D25 | **Early Adopters stake earns VP at a 6× multiplier** (PB-220). EA weight = `ea_staked_e8s ÷ 10 × 6` — above the 2-year tier's 4×, reflecting the permanent lock. It joins `staking_total_weight_e8s`, so it counts for lossless voting AND the poker bankroll. Permanent stake ⇒ permanent VP base (a busted EA whale still re-floors at stop-loss like everyone else). Lottery tickets remain tier-stake-based — EA stake does NOT mint tickets. |
| D26 | **R3–R8 are adopted scope, not suggestions:** "0% rake, forever" is the lobby headline (PB-213); cosmetics economy (PB-221); weekly leaderboard seasons with cosmetic prizes (PB-222); the restake nudge with funnel instrumentation (in PB-219); spectator acquisition — featured table on Dashboard + shareable hand replays + rail counter (PB-223); public script leaderboard powering the marketplace meta (folded into PB-210). R9–R12 remain optional follow-ups. |
| D27 | **VP tenure doubling + the casino jubilee (SHIPPED app-side 2026-06-12).** Staking weight now doubles every 6 months staked (×2/×4/×8/×16 cap; top-ups blend the anchor) — `stake_weight_e8s` in lib.rs is the live base the casino builds on. Casino-side rule: at each user's 6-month tenure tick, any **negative `CASINO_VP_DELTA` is forgiven (reset to 0)** — "double or be fully restored": loyal stakers get their full (now-doubled) base VP back even after busting. Forgiveness is sanctioned writer **#7**, lazily applied (compare `last_jubilee_period` per user at settle/read), and it deliberately breaks strict zero-sum: forgiven VP is MINTED, tracked in a lifetime `jubilee_minted` counter, so the master invariant becomes Σ users + house + burned − jubilee_minted = 0. Winners keep winnings; the jubilee only erases losses. |

## Task index (PB-200 … PB-224, `tasks/todo/`)

Build order ≈ dependency order. Backend core first, agents next, money last,
UI in parallel after PB-206.

| Task | Title | Depends on |
|---|---|---|
| PB-200 | Effective-VP ledger (`poker_vp_delta`) + voting integration | — |
| PB-201 | Poker domain types, stable storage, `poker` feature flag | — |
| PB-202 | Deck RNG (commit-reveal over `raw_rand`) + 7-card evaluator | PB-201 |
| PB-203 | NLHE betting engine (pure state machine + property tests) | PB-202 |
| PB-204 | Cash-table lifecycle: 10 tables, hand loop, timers, seat loss | PB-200,203 |
| PB-205 | Agent registry: claim/replace, bankroll binding, auto-seat + waitlist | PB-204 |
| PB-206 | Agent action API: gated state views, legal actions, `poker_act` | PB-205 |
| PB-207 | House agent: canister-driven play from the owner's script | PB-206,208 |
| PB-208 | Play-style DSL: schema, validator, bounded interpreter, free presets | PB-201 |
| PB-209 | $5 custom-script creation (quote flow) + versioned storage | PB-208 |
| PB-210 | Script marketplace: list / buy / license, 80/20 split | PB-209 |
| PB-211 | Tournament module (Phase 2, ships dark): config, registration, balancing, payouts | PB-204,207 |
| PB-212 | Hand history, deck reveal, admin tools (pause/void), audit log | PB-204 |
| PB-213 | UI: Poker lobby under Play (10 rows, X/9 or FULL) | PB-201 |
| PB-214 | UI: table spectator view + "Searching for a table…" + own hole cards | PB-206,213 |
| PB-215 | UI: Agent Space claim, script editor, marketplace, tournament lobby | PB-205,209,210,211 |
| PB-216 | llms-poker agent skill docs + OPS runbook | PB-206 |
| PB-217 | PocketIC multi-agent simulation suite + economic invariants | all backend |
| PB-218 | NFT avatars: ICRC-7 ownership verification + agent profile pictures | PB-205 |
| PB-219 | Stop-loss: per-agent VP floor, default 25%, settlement check + UI; restake-nudge funnel (R6) | PB-204,205 |
| PB-220 | Early Adopters VP: 6× multiplier into `staking_total_weight_e8s` (D25 — platform-wide, pre-poker) | — |
| PB-224 | Test infrastructure: reference oracles, action generators, golden-scenario DSL, soak harness (build FIRST) | PB-201 |
| PB-221 | Cosmetics economy: card backs / felts / win FX, $1–$5 quote flow (R4) | PB-214 |
| PB-222 | Weekly leaderboard seasons with cosmetic prizes (R5) | PB-212,221 |
| PB-223 | Spectator acquisition: featured table on Dashboard, shareable hand replays, rail counter (R7) | PB-212,214 |

## Cross-epic note — Epic J (Crash / Casino)

`plans/crash/` (PB-230–241) amends this epic once both ship:
- `POKER_VP_DELTA` → **`CASINO_VP_DELTA`** (shared bankroll; six sanctioned
  writers; house account + weekly burn — crash doc 02);
- nav: Poker moves under the **Casino** hub (`/casino`, tabs Poker | Crash;
  `/poker` redirects); the **no-loss-of-principal banner (crash C16)** wraps
  both games;
- stop-loss (D23) and the marketplace (PB-210, `kind` field) are
  casino-wide.

## Milestones

1. **M1 — Engine proven** (PB-224, PB-200…203): the test infrastructure
   (oracles/generators/golden DSL) lands FIRST; the pure NLHE engine then
   passes the full doc-09 Layer-1/2 suite — golden corpus, property tests
   (chip conservation, per-chip pot-oracle equivalence), mutation checklist —
   before any table goes live.
2. **M2 — Cash games local** (PB-204…208, 213, 214): two scripted house
   agents play a full session on local; VP deltas reconcile to zero-sum.
   **Gate: 1,000,000-hand soak run with zero invariant violations (doc 09).**
3. **M3 — Money features** (PB-209, 210, 215): script fee + marketplace on
   local with real quote flow.
4. **M4 — Tournament + audit** (PB-211, 212, 216, 217): full PocketIC sim of
   a 20-agent tournament; invariant suite green.
5. **Mainnet**: ships dark behind `poker`; enable after an owner playtest —
   per the standing rule, **no mainnet deploy without an explicit owner ask**.
