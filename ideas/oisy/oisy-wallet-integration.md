# Oisy Wallet Integration — Plan & Analysis (PB-500, draft)

> Add the **Oisy** wallet as an alternative sign-in/signer alongside Internet
> Identity, so users can bring an external wallet instead of (not in addition to,
> per-session) the II-backed in-app account. This doc is the durable plan; the
> task breakdown lives in [`tasks.md`](tasks.md).

**Status: PARKED.** Design complete, not started. Held until the in-flight
frontend feature currently landing is merged — Phase 1 is a wide-touching
refactor of `App.tsx` + ~20 call sites and wants a low-churn window to avoid
conflicts (see [§9](#9-sequencing--why-this-is-parked)). No code changes yet.

Investigation method: multi-agent fan-out (Oisy docs deep-dive + two codebase
maps — auth/identity seam and value-movement flows). Findings are grounded with
`file:line` references throughout.

---

## 1. TL;DR & decisions

- **Feasible, and mostly a frontend job.** The backend write path needs **zero
  Rust changes**; the work is a signer abstraction in the frontend.
- **The hard constraint:** Oisy has **no delegation (no ICRC-34)**. With II you
  sign in once and the dapp calls silently; with Oisy **every state-changing
  call is an individual popup approval.** This shapes the entire design.
- **"Both wallets" is the wrong frame** (see [§2](#2-the-reframe-in-app-vs-external-is-a-false-dichotomy)).
  The "in-app wallet" is just an account view; the real choice is *which signer
  backs the session*. II and Oisy coexist as **sign-in options**, chosen one per
  session — never both at once.
- **Approach:** a thin `WalletProvider` abstraction (Phase 1, II-only, behaviour-
  identical) → an `OisyProvider` behind a default-OFF `oisy_wallet` feature flag
  (Phase 2). Decide hand-rolled (`@dfinity/oisy-wallet-signer`) vs multi-wallet
  (`@nfid/identitykit`) in the Phase 0 spike.

---

## 2. The reframe: "in-app vs external" is a false dichotomy

The codebase has no custodial in-app wallet. What looks like one is an **account
view + deposit/withdraw UI over the authenticated principal**: balances are
`icrc1_balance_of({owner: principal})` (`App.tsx:681`, `:889`), deposit addresses
are backend-derived from `caller` (`get_account_id` `App.tsx:736`,
`get_*_deposit_address`), and sends are frontend-signed ICRC-1 transfers using
the II identity.

So the axis is **not** "in-app wallet vs external wallet." It is **which signer
authenticates the session: Internet Identity or Oisy.** The account UI is
signer-agnostic and works for whichever principal signs in. They coexist as
sign-in choices; they cannot be mixed in one session because deposit-subaccount
derivation, refunds, and withdrawals all key off a single authenticated `caller`
([§4](#4-evidence-from-the-codebase), [§6](#6-the-one-backend-asterisk)).

---

## 3. The hard constraint + systems impact map

```
Oisy = no delegated identity → every signed op is a user-mediated popup
        │
        ├─(1) The app assumes a SILENT signer baked into one actor
        │      (createActor({agentOptions:{identity}})). Oisy holds NO key.
        │      Reconciling this inversion IS the work.
        ├─(2) "Deposit-then-notify" (the dominant idiom) = 2 signed ops:
        │      ICRC-1 transfer (popup) + backend settle call (popup).
        │      → one vote/stake/fund = 2 Oisy approvals.
        ├─(3) Reads that derive from `caller` (deposit addrs, get_my_*) can't be
        │      silently identity-authenticated under Oisy → small backend tweak (§6).
        ├─(4) Refunds/withdrawals pay `owner: caller` → Oisy must BE the identity,
        │      not a fund-source under an II login. No hybrid.
        ├─(5) ICP withdraw targets an Account-ID (App.tsx:762/783, legacy `transfer`).
        │      Account IDs are one-way hashes → icrc1Transfer CAN'T send to one.
        │      Add a Principal-dest ICP withdraw for Oisy; Account-ID dests stay II-only.
        ├─(6) No persistent delegation → reconnect-on-reload, popup-blocker
        │      handling, onDisconnect. II auto-restores; Oisy doesn't.
        └─(7) Local testing: Oisy needs a local sign page + host param; II local
               "just works" today → higher test burden.
```

Load-bearing realization: the integration is **almost entirely a frontend
signer-abstraction problem**, because the backend already treats incoming funds
as sender-agnostic deposits.

---

## 4. Evidence from the codebase

| Finding | Evidence (`file:line`) | Consequence |
|---|---|---|
| Auth = one `identity` baked into one `actor`, threaded as `{host, identity, rootKey}` everywhere | `App.tsx:370` identity state, `:1218` handleLogin, `:1241` handleLogout; factories accept `{agent}` **or** `{agentOptions}` (`bindings/backend.ts:3621`, `bindings/ledger.ts:2664`); ~20 inline `createLedgerActor(...,{agentOptions})` sites (App/Arcade/Explorer/IdeaBoard/Staking/Payouts/Admin) | The factories already take a prebuilt `agent` → the clean substitution point |
| Every value-in flow is Pattern A, sender-agnostic | `derive_subaccount` `lib.rs:1714`; settles check **balance only**: `commit_inner :2893`, `stake :6899`, `fund_project :5667`, explorer/arcade settles `:9804/:10345` | **Backend write path unchanged** |
| The "in-app wallet" = account view over the principal | `get_account_id` `App.tsx:736`, balances `:681`, withdraw `:779/:850`, ckBTC off-ramp `icrc2_approve` `Payouts.tsx:677` | Signer-agnostic; coexists trivially |
| Refunds/withdraw pay `owner: caller` | refund `lib.rs:2403`; withdraw `Payouts.tsx:633` | Oisy must be the *identity*, not a fund-source |
| Only the convenience clients are ledger-only; the base `Signer` does ICRC-49 to any canister | Oisy SDK README (ICRC-49 `call_canister`); IdentityKit `useAgent()` returns an Agent for `Actor.createActor({agent})` | Existing `actor.method()` calls work via an agent swap — each just pops up |

---

## 5. Architecture: one `WalletProvider` seam, two backends

```ts
interface WalletProvider {
  kind: 'ii' | 'oisy';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getPrincipal(): Principal;
  getAgent(): Agent;                               // → createActor({ agent })
  transfer(ledgerId, to, amount): Promise<…>;      // ICRC-1 (popup under Oisy)
  approve(ledgerId, spender, amount): Promise<…>;  // ICRC-2 (Payouts off-ramp)
}
```

- **`InternetIdentityProvider`** wraps today's `AuthClient`; `getAgent()` returns
  the delegation-backed `HttpAgent` (silent). Behaviour-identical to now.
- **`OisyProvider`** uses `@dfinity/oisy-wallet-signer`'s base `Signer` (ICRC-49)
  to build a signer Agent for `getAgent()` (each backend update = popup) and the
  wallet's `icrc1Transfer`/`icrc2Approve` for `transfer`/`approve`. **Alternative:**
  `@nfid/identitykit`'s `useAgent()` gives the same agent plus a multi-wallet
  picker (II + Oisy + Plug + NFID) — at the cost of replacing `AuthClient`.

Because both factories already accept `{ agent }`, the ~20 ledger sites and all
`actor.method()` calls migrate by **swapping the agent source** from
`{host, identity, rootKey}` to `wallet.getAgent()` — no per-call rewrites.
`Casino`/`Dashboard` need no change (they receive only `actor`/`principal`).

---

## 6. The one backend asterisk — and a privacy split

Methods that derive per-user state from `caller` in a **query** assume a
transparently-authenticated read, which Oisy can't do silently (ICRC-49 is for
*update* calls; signing a read would mean an absurd popup). But they fall into
**two categories that must be handled differently** — a distinction the PB-500
review (C1) glossed and that matters for security:

- **Public, deterministic derivations** — deposit addresses
  (`get_deposit_address` `lib.rs:2365`, `get_*_deposit_address`). The result is a
  pure function of the principal + a public domain seed; nothing secret. Fix is
  safe and clean: add **principal-argument variants**
  (`get_deposit_address_for(principal)`), callable **anonymously** — the frontend
  already has the Oisy principal from `accounts()`.
- **Private per-user reads** — `get_my_stake`, `get_my_transactions`,
  `get_my_casino`, `get_my_pool_neuron`, etc. These expose a user's own data.
  **Do NOT** add anonymous `*_for(principal)` variants — that would let anyone
  read anyone's stake/transactions (the privacy hole the review's blanket
  "expose with a principal arg" advice would open). These need a genuinely
  *authenticated* read: confirm in Phase 0 whether the Oisy signer Agent can
  authenticate query calls acceptably; if not, fetch the data via an
  authenticated **update** call, or accept that these panels require a signed
  read under Oisy.

The deposit-address variants are small, additive, **upgrade-safe** (new
optional-arg query methods, no new stable structures, no MemoryId churn → no
collision with the course-nft `76–89` reservation). Mirror any signature change
in the hand-maintained `backend.did`.

---

## 7. Phased plan

| Phase | What | Risk | Gate |
|---|---|---|---|
| **0** | De-risk spike (throwaway): prove a signer Agent drives a real backend `commit`; decide IdentityKit vs hand-rolled; settle §6 a/b; verify DOCS-UNCLEAR items | low | gates Phase 2 |
| **1** | `WalletProvider` abstraction + `InternetIdentityProvider`; migrate App.tsx + ~20 ledger sites + `minters.ts` off the raw quartet. **II-only, behaviour-identical.** | med (wide touch) | independent; safe to land alone |
| **2** | `OisyProvider` behind `oisy_wallet` flag (default OFF); sign-in picker; §6 backend fix if needed | med | needs Phase 0 + 1 |
| **3** | UX for per-call approvals: step indicators per signed leg, fix Account-ID withdraw, persist/restore wallet choice, **Dashboard "official wallet" blue card** (§7.1) | low | needs Phase 2 |
| **4** | Tests (provider mock + e2e per pattern), `llms-*.txt`/docs, dark-launch the flag to a beta cohort | low | needs Phase 3 |

Phase 1 is the load-bearing refactor and is **worth landing on its own** even if
Oisy never ships — it future-proofs for any signer.

### 7.1 Dashboard "official wallet" card (blue)

Product requirement: once Oisy is integrated, promote it as **the official
wallet of Caldera** with a new **blue** `HubCard` on the Dashboard. Grounding +
the non-obvious work this implies:

- **No blue exists yet.** The palette (`index.css`) is entirely warm — `--burn`
  (#FF6A1F), `--sprout`, `--haze`. And `HubCard` (`Dashboard.tsx:24`) only takes a
  boolean `accent` that hard-codes the burn-orange (`var(--burn-950)` bg /
  `var(--burn)` border, `:43-50`). So "blue card" = a **design-system change**, not
  a prop tweak:
  1. Add a blue token set to `index.css` — `--azure` + `--azure-950`/dim, plus a
     theme-aware **`--azure-ink`** for any blue text/icon (the `-ink` pattern from
     the contrast work — see `ideas/ui-contrast/light-mode-contrast-fix.md` and the
     `frontend-dev` skill). Pick values aligned to Oisy's brand blue **that clear
     the WCAG check in both themes** (verify with the contrast snippet — bright
     blue on a light surface will fail, so the light `--azure-ink` must be darker).
  2. Generalize `HubCard`'s `accent: boolean` to a `tone?: 'burn' | 'azure'`
     (or a color-pair prop), defaulting to today's burn so existing cards are
     unchanged. Then render the Oisy card with `tone="azure"`, using `--azure-ink`
     for its eyebrow/icon/text.
- **Content:** eyebrow "Official wallet", `icon="wallet"`, a `<Big>` headline
  ("Oisy — the official wallet of Caldera"), a one-line blurb, and a CTA that
  opens the Oisy connect flow (or links to https://oisy.com / docs). Place it
  among the feature cards (section ③), near the "Your position" wallet card.
- **Gating + honesty:** render the card **only when the `oisy_wallet` flag is
  on** (don't claim "official wallet" before the integration ships). The
  "official wallet" copy is a marketing claim → runs through the
  **ui-copy-in-sync** sweep like any other feature text.

---

## 8. Phase 0 spike checklist (do first when unparked)

- [ ] Build a signer Agent (Oisy base `Signer` **or** IdentityKit `useAgent()`)
      and make a real authenticated `commit` round-trip to the deployed backend
      → confirms `Actor.createActor({ agent })` works with Oisy.
- [ ] Sign an ICRC-1 deposit into a `get_deposit_address` subaccount via Oisy;
      confirm the settle balance-check passes (proves Pattern A end-to-end).
- [ ] Decide **IdentityKit vs hand-rolled** (record in the decision log, §11).
- [ ] Resolve §6: does the signer Agent authenticate **queries** acceptably, or
      do we need principal-arg query variants?
- [ ] Verify DOCS-UNCLEAR items: exact `icrc2Approve` method/signature; whether
      WalletConnect is a transport; local sign-page + `host` setup for testing.
- [ ] Confirm popup-blocker / reconnect behaviour and session lifecycle.

Exit criteria: a one-off script signs a backend `commit` + an ICRC-1 deposit via
Oisy on staging/mainnet, and the IdentityKit-vs-hand-rolled decision is recorded.

---

## 9. Sequencing & why this is parked

- **Blast radius.** Phase 1 rewrites how `App.tsx` and ~20 component call sites
  obtain their agent. Landing that on top of an in-flight frontend feature risks
  ugly conflicts in exactly those files. Wait for the current feature to merge,
  then land Phase 1 in a quiet window.
- **Independence.** Phase 1 is behaviour-neutral and can merge well before any
  Oisy decision — do it first to shrink the later Oisy PR to "add a provider."
- **No backend coupling to the parked feature.** The only possible backend touch
  (§6) is additive query variants with no new stable structures, so it won't
  collide with the course-nft MemoryId reservation (`76–89`).
- **Recommended order:** in-flight feature lands → Phase 0 spike → Phase 1 (solo
  PR) → Phase 2+ behind the flag.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Per-call popups change the feel of multi-step flows (no delegation) | Most of the app is read-only queries (no popups); concentrate UX work on deposit-then-notify; show "approve N steps" + per-leg progress (reuse `setStakeStep`/`editorStep`) |
| Identity/fund split breaks refunds & withdrawals | Enforce "Oisy IS the session identity"; never offer II-login + Oisy-funds hybrid |
| ICP withdraw to Account-ID dests can't use `icrc1_transfer` (one-way hash) | Add a **Principal-destination** ICP withdraw via `icrc1_transfer` (Oisy-compatible; also a cleanup for II). **Keep** legacy `transfer` for Account-ID/exchange dests (II-only). "Oisy + ICP-to-Account-ID" is an unavoidable signer-limitation gap — message it clearly, don't silently fail |
| Anonymous `*_for(principal)` query variants leak private per-user data | Only add principal-arg variants for **public deterministic** derivations (deposit addresses); never for `get_my_*` private reads (§6) |
| Session restore blocked as an untriggered popup on reload | Never auto-open the Oisy connection on mount; on failed silent restore, show an explicit **user-gesture "Reconnect wallet" button** (review C3) |
| Local Oisy testing friction | Use staging/mainnet Oisy for e2e; mock the provider for unit tests; document the local sign-page setup once |
| Wide Phase-1 refactor regressions | Ship Phase 1 II-only and behaviour-identical; provider-level vitest; no flag needed |
| SDK churn (Oisy signer URL/API changes) | Don't hardcode the sign URL; pin SDK version; isolate all Oisy specifics inside `OisyProvider` |

---

## 11. Decision log / open questions

| # | Question | Status |
|---|---|---|
| D1 | Hand-rolled `@dfinity/oisy-wallet-signer` vs `@nfid/identitykit` multi-wallet | **Open** — decide in Phase 0 against the **product goal**: multi-wallet ambition (Plug/NFID/future, one modal) → IdentityKit; Oisy-only + minimal blast radius → hand-rolled. The PB-500 review (O2) recommends IdentityKit; weigh that against IdentityKit replacing `AuthClient` wholesale (heavier provider, theming/UX lock-in) |
| D2 | §6 caller-derived queries | **Decided (direction)** — principal-arg variants for **public deterministic** derivations (deposit addresses); **authenticated read** for **private** `get_my_*` (no anonymous arg variants). Phase 0 only confirms whether Oisy can authenticate queries or we route private reads through an update |
| D3 | One signer per session (no hybrid) | **Decided** — required by refund/withdraw-to-`caller` |
| D4 | Ship behind `oisy_wallet` flag, default OFF | **Decided** — matches repo convention |
| D5 | Land Phase 1 (abstraction) independently of any Oisy decision | **Decided** — yes |
| D6 | Batch transfer+settle into one Oisy approval (review O1) | **Rejected** — Oisy docs state no batched approvals, and the settle call has a data dependency on the post-transfer balance (can't be one atomic batch). Only real popup-reducer is an ICRC-2 allowance model, which adds a backend pull path + standing-allowance risk and forfeits the zero-backend-change win — future option-with-tradeoffs, not adopted |

---

## 12. Recommendation

1. Build the **`WalletProvider` abstraction regardless** (Phase 1) — low-risk,
   future-proofs for any signer, shrinks the eventual Oisy PR.
2. For Oisy, **lean hand-rolled** (`@dfinity/oisy-wallet-signer` base `Signer`)
   for minimal deps and full control; pick **IdentityKit** only if you want a
   multi-wallet picker. Finalize in Phase 0.
3. **Set the UX expectation:** Oisy users approve each on-chain step. Design the
   deposit-then-notify flows to minimize signed legs.

Net: feasible, mostly-frontend, backend untouched on the write path bar one small
additive query tweak. The work is the signer abstraction + per-call-popup UX —
not a re-architecture.

---

## 13. PB-500 review responses (`oisy-wallet-integration-specs-review.md`)

| # | Suggestion | Verdict | Change |
|---|---|---|---|
| **C1** | Authenticated-query barrier → principal-arg variants | **Accept + sharpen** | §6 now splits **public** deterministic derivations (deposit addresses → anonymous principal-arg variant, safe) from **private** `get_my_*` reads (anonymous arg variant = privacy leak; needs an authenticated read). The review's blanket "expose with a principal arg" would have leaked per-user data. |
| **C2** | Migrate **all** withdrawals to `icrc1_transfer`, delete legacy | **Partially accept; reject "delete legacy"** | ICP withdraw targets an **Account ID** (`App.tsx:762`), a one-way hash `icrc1_transfer` cannot send to. Added a Principal-dest ICP withdraw (Oisy-compatible) but **keep** legacy `transfer` for Account-ID/exchange dests; Oisy+Account-ID is an unavoidable gap. Updated §3(5), risk register, task 3.2. |
| **C3** | Explicit "Reconnect" button; no auto-popup on mount | **Accept** | Risk register + task 3.3 now mandate a user-gesture Reconnect button on failed silent restore; never auto-open the connection. |
| **O1** | ICRC-25 batch transfer+settle into one popup | **Reject** | Oisy docs: no batched approvals; settle has a data dependency on the post-transfer balance. Recorded as D6; noted ICRC-2 allowance as the only real (tradeoff-laden) popup-reducer. |
| **O2** | Choose IdentityKit now | **Partially accept** | Kept as Phase-0 decision D1 with a crisp product-goal criterion + the review's recommendation recorded; declined to pre-commit (IdentityKit replaces `AuthClient` wholesale). |

Review grades (Completeness 9.5 / Correctness 9.0 / Creativity 9.0, **A-**)
predate these revisions.

---

## Sources

- https://docs.oisy.com/ · https://docs.oisy.com/for-developers/using-oisy-wallet-in-your-icp-dapp (supported ICRC-25/27/29/49/21; **no ICRC-34/28 delegation**; per-call approval; transport; local vs mainnet)
- https://github.com/dfinity/oisy-wallet-signer (base `Signer` ICRC-49 vs ledger-only `IcpWallet`/`IcrcWallet`; `connect`/permissions/accounts/`icrc1Transfer`; local `host`/`url`)
- https://www.npmjs.com/package/@dfinity/oisy-wallet-signer
- https://identitykit.xyz/docs/getting-started/executing-canister-calls (ACCOUNTS mode `useAgent()` → `Actor.createActor({agent})`, per-call popup)
- https://forum.dfinity.org/t/ic-js-oisy-wallet-signer-are-now-powered-by-icp-sdk-core/59635

**Verify before building (DOCS UNCLEAR):** exact `icrc2Approve`/`callCanister`
method names in `@dfinity/oisy-wallet-signer`; whether the signer Agent
authenticates query calls; whether WalletConnect is an Oisy transport.
