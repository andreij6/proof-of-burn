# Oisy Wallet Integration — Task List (PB-500)

Companion to [`oisy-wallet-integration.md`](oisy-wallet-integration.md). Tasks are
grouped by phase; each notes **dependencies**, **acceptance**, and rough **effort**
(S < 0.5d, M ~1–2d, L ~3–5d).

> **GATE — do not start any task below until the in-flight frontend feature has
> merged.** Phase 1 rewrites `App.tsx` + ~20 call sites and must land in a
> low-churn window. See plan §9.

Order: **Phase 0 → Phase 1 (solo PR) → Phase 2–4 behind the `oisy_wallet` flag.**

---

## Phase 0 — De-risk spike (throwaway; gates Phase 2)

- [ ] **0.1** Stand up a signer Agent (Oisy base `Signer` **or** IdentityKit
  `useAgent()`) and make one **authenticated `commit` round-trip** to the deployed
  backend via `Actor.createActor({ agent })`. — *Acc:* a real `commit` succeeds
  through an Oisy popup. *Effort:* M. *Dep:* none (uses staging/mainnet).
- [ ] **0.2** Sign an **ICRC-1 deposit** into a `get_deposit_address` subaccount
  via Oisy and confirm the settle balance-check passes (Pattern A end-to-end). —
  *Acc:* deposit + settle works. *Effort:* S. *Dep:* 0.1.
- [ ] **0.3** Resolve the **caller-derived-query** question (plan §6): does the
  signer Agent authenticate queries acceptably, or do we need principal-arg query
  variants? — *Acc:* decision recorded in plan §11 D2. *Effort:* S. *Dep:* 0.1.
- [ ] **0.4** **Decision D1:** hand-rolled `@dfinity/oisy-wallet-signer` vs
  `@nfid/identitykit`. — *Acc:* recorded in plan §11. *Effort:* S.
- [ ] **0.5** Verify DOCS-UNCLEAR items: exact `icrc2Approve`/`callCanister`
  signatures, query-with-identity behaviour, local sign-page + `host` setup,
  popup-blocker/reconnect. — *Acc:* notes appended to plan §12 Sources. *Effort:* S.

**Phase 0 exit:** a one-off script signs a backend `commit` + an ICRC-1 deposit via
Oisy, and D1/D2 are decided.

---

## Phase 1 — `WalletProvider` abstraction, II-only (independent; behaviour-identical)

- [ ] **1.1** Define `WalletProvider` interface + a `WalletContext` React context
  (`getPrincipal`/`getAgent`/`connect`/`disconnect`/`transfer`/`approve`). —
  *Acc:* types compile, no usage yet. *Effort:* S.
- [ ] **1.2** Implement `InternetIdentityProvider` wrapping the current
  `AuthClient` flow (`App.tsx:1218` login, `:1241` logout, `:1134` init). —
  *Acc:* II login/logout work through the provider. *Effort:* M. *Dep:* 1.1.
- [ ] **1.3** Migrate `App.tsx` to source identity/agent from the provider; replace
  the `{identity, host, rootKey}` quartet on component props with `wallet`/context. —
  *Acc:* app builds; II behaviour unchanged. *Effort:* M. *Dep:* 1.2.
- [ ] **1.4** Migrate the ~20 inline `createLedgerActor(...,{agentOptions})` sites
  (App/Arcade/Explorer/IdeaBoard/Staking/Payouts/Admin) + the `minters.ts` path to
  `wallet.getAgent()` / `wallet.transfer()` / `wallet.approve()`. — *Acc:* every
  ledger/minter call routes through the provider. *Effort:* L. *Dep:* 1.3.
- [ ] **1.5** Provider-level vitest with a mock provider (login, agent supply,
  transfer/approve). — *Acc:* green; covers the seam. *Effort:* M. *Dep:* 1.4.
- [ ] **1.6** Ship Phase 1 as a **solo PR**, II-only, no flag, behaviour-identical. —
  *Acc:* manual smoke of vote/stake/fund/customize unchanged. *Effort:* S. *Dep:* 1.5.

---

## Phase 2 — `OisyProvider` behind the `oisy_wallet` flag (default OFF)

- [ ] **2.1** Add the `oisy_wallet` feature flag (backend `FLAG_*` + `KNOWN_FEATURE_FLAGS`
  + `feature_default` OFF; `.did`; frontend lookup), per repo convention. —
  *Acc:* flag visible in Admin, default OFF. *Effort:* S. *Dep:* 1.6.
- [ ] **2.2** Implement `OisyProvider` (the Phase-0 approach): session connect,
  `accounts()` → principal, signer Agent for `getAgent()`, `icrc1Transfer`/
  `icrc2Approve` for `transfer`/`approve`. — *Acc:* implements `WalletProvider`. *Effort:* L. *Dep:* 2.1.
- [ ] **2.3** Sign-in picker: "Continue with Internet Identity" / "Connect Oisy"
  (Oisy option gated by the flag). — *Acc:* either path yields a working session. *Effort:* M. *Dep:* 2.2.
- [ ] **2.4** Apply the §6 backend query fix **iff** Phase 0 (0.3) requires it:
  additive principal-arg variants for **public deterministic** derivations only
  (deposit addresses) + `backend.did` mirror. **Do not** add anonymous
  `*_for(principal)` variants for private `get_my_*` reads — route those through
  an authenticated read/update instead. — *Acc:* deposit addresses resolve under
  Oisy; no private data exposed anonymously. *Effort:* M. *Dep:* 0.3, 2.2.
- [ ] **2.5** End-to-end: a full Pattern-A flow (vote commit = deposit popup +
  commit popup) via Oisy on a deployed canister. — *Acc:* completes; tickets/
  state update. *Effort:* M. *Dep:* 2.2–2.4.

---

## Phase 3 — UX for per-call approvals

- [ ] **3.1** Per-leg progress + "Oisy will ask you to approve N steps" hints on
  every deposit-then-notify flow (reuse `setStakeStep`/`editorStep`). — *Acc:*
  each signed leg has clear UI. *Effort:* M. *Dep:* 2.5.
- [ ] **3.2** ICP withdraw: add a **Principal-destination** path via `icrc1_transfer`
  (Oisy-compatible; also benefits II). **Keep** the legacy Account-ID `transfer`
  path (`App.tsx:762/783`) for exchange dests — `icrc1_transfer` can't target a
  one-way Account-ID hash. For Oisy + Account-ID dests, message the gap clearly
  (don't silently fail). — *Acc:* Principal withdraws work under Oisy; Account-ID
  withdraws still work under II; Oisy users see a clear notice for Account-ID. *Effort:* M. *Dep:* 2.2.
- [ ] **3.3** Persist wallet choice; attempt silent Oisy restore on reload, and on
  failure render an explicit **user-gesture "Reconnect wallet" button** (never
  auto-open the connection on mount — browsers block it as an untriggered popup).
  Handle `onDisconnect`. — *Acc:* refresh keeps the session or shows a working
  Reconnect button; no popup-blocked dead-ends. *Effort:* M. *Dep:* 2.2.
- [ ] **3.4** Dashboard **"official wallet" blue card** (plan §7.1). Two parts:
  (a) **design-system:** add an `--azure` token set + theme-aware `--azure-ink`
  (the `-ink` pattern; values must pass the WCAG check in both themes — see the
  `frontend-dev` skill) and generalize `HubCard`'s boolean `accent` to a `tone`
  prop (`'burn' | 'azure'`, default burn — existing cards unchanged); (b) add the
  card: eyebrow "Official wallet",
  `icon="wallet"`, headline "Oisy — the official wallet of Caldera", blurb + CTA to
  connect Oisy. **Gate on the `oisy_wallet` flag** (don't claim "official" before
  it ships) and run the copy through **ui-copy-in-sync**. — *Acc:* blue card shows
  only when the flag is on; all other HubCards visually unchanged; CTA connects
  Oisy. *Effort:* M. *Dep:* 2.1 (flag), 2.3 (connect flow).

---

## Phase 4 — Test, document, dark-launch

- [ ] **4.1** e2e for ≥1 flow per pattern (commit, stake, fund, customize) under
  Oisy. — *Acc:* documented runbook + green. *Effort:* M. *Dep:* Phase 3.
- [ ] **4.2** Update `llms-*.txt` + a `docs/` note for the Oisy path. — *Acc:*
  agent-facing docs cover Oisy. *Effort:* S. *Dep:* 4.1.
- [ ] **4.3** Flip `oisy_wallet` ON for a beta cohort; monitor; then GA. — *Acc:*
  beta sign-ins succeed; no error spike. *Effort:* S. *Dep:* 4.1.

---

## Cross-cutting reminders

- One signer per session — **no II-login + Oisy-funds hybrid** (refunds/withdraw
  pay `owner: caller`).
- Backend write path needs **no changes**; the only possible Rust touch is the
  additive §6 query variants (2.4) — no new stable structures, no MemoryId churn.
- Isolate **all** Oisy SDK specifics inside `OisyProvider`; don't hardcode the
  sign URL; pin the SDK version.
