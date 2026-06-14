---
name: frontend-dev
description: Edit the React frontend (src/frontend). Use when building or changing UI pages (follow the established page anatomy so new pages stay consistent), calling backend canister methods from TypeScript, working with generated candid bindings, debugging "dead button" / undefined-data issues caused by candid optional decoding, or checking/fixing color contrast and light-mode accessibility (WCAG).
---

# Frontend development

React 19 + TypeScript + Vite SPA in `src/frontend`. Pages are flat files in
`src/frontend/src/`: `App.tsx` (shell/routing/auth), `Landing.tsx`,
`Dashboard.tsx`, `Staking.tsx`, `Lottery.tsx`, `Payouts.tsx`, `IdeaBoard.tsx`,
`Explorer.tsx`, `Arcade.tsx` (+ `arcade/` for Mini Golf), `EarlyAdopters.tsx`,
`Casino.tsx` (+ `Poker.tsx`), `Admin.tsx`, shared widgets in `ui.tsx`.

```bash
npm --prefix src/frontend run dev     # vite dev server (hot reload)
npm --prefix src/frontend run build   # tsc -b && vite build  → dist/
npm --prefix src/frontend run lint
npm --prefix src/frontend test        # vitest run
```

The asset canister serves `dist/`, so a change is only visible at
http://frontend.local.localhost:8000/ after `bash scripts/deploy-local.sh`
(which builds + syncs). Use the vite dev server for iteration.

## Building a new page — copy an existing one, don't compose from scratch

This is the most important rule for consistency. These pages all share the
same skeleton; **open the closest existing page** (`Lottery.tsx` is the
smallest, cleanest template; `Casino.tsx` is the newest hub layout) **and
mirror its structure** rather than assembling a page from the design-system
primitives yourself. Using the right tokens but a novel layout is exactly the
inconsistency to avoid.

### Page contract (props)

Every page is a **default-exported function** in `src/frontend/src/<Name>.tsx`
with a `interface <Name>Props` above it. Pages do **not** own routing — they
receive what they need and call back to the shell:

- Always: `actor: any`, `principal: Principal | null`, `onSignIn: () => void`.
- As needed (match a neighbor's prop names exactly): `identity`, `host`,
  `rootKey`, `isLocal`, `isAdmin`, `ledgerCanisterId`, `backendCanisterId`.
- Navigation is a callback prop named `onGo<Target>` (e.g.
  `onGoStaking: () => void`) — never import the router or mutate `page` from a
  page. See `LotteryProps`/`CasinoProps`.

### Page skeleton (mirror this exactly)

```tsx
return (
  <div className="dashboard-container">            {/* 720px, centered, col, gap — the page frame */}
    {/* ── Header ── */}
    <div className="col" style={{ gap: 6 }}>
      <span className="row" style={{ gap: 8 }}>
        <Icon name="target" size={16} stroke="var(--burn)" />
        <Eyebrow accent>Section label</Eyebrow>          {/* uppercase mono kicker */}
      </span>
      <b style={{ fontSize: 17 }}>One-line value proposition.</b>
      <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
        One sentence of context.{' '}
        <MoreInfo title="How X works">…long explanation lives here…</MoreInfo>
      </span>
    </div>

    {/* error/notice banner — row, border + color = ember (error) / sprout (ok) */}
    {/* content: .row / .col flex utilities; cards via the local `card` style or .card class */}
  </div>
);
```

Don't introduce a new top-level wrapper class, a different header arrangement,
or a bespoke "how it works" treatment. The long-form explanation goes in
`<MoreInfo>`; the page keeps a one-line subtitle.

### Reuse, don't reinvent (shared primitives in `ui.tsx`)

`Icon` (named paths in `iconPaths`), `Eyebrow`, `Chip` (tones in `CHIP_TONES`),
`Btn` (`primary | secondary | ghost | danger`, `sm`), `MoreInfo`, `LiveDot`,
`fmtICP`, `formatPrincipal`. Use these for every button/badge/icon/amount —
do not hand-roll a `<button>` or inline a color when a primitive exists.

### Tokens & utilities — never hardcode

Style with the CSS variables and utility classes in `index.css`, not literals:
- Colors: `var(--burn)`, `--fg`/`--fg-2`/`--fg-3`, `--surface`, `--border`/
  `--border-hi`, `--sprout`/`--ember`/`--haze` (+ their `-dim`/`-950` tints).
- Spacing/shape: `--sp-*`, `--r-md`, `--elev-*`, `--dur-*`/`--ease-*`.
- Layout classes: `.row`, `.col`, `.card`, `.mono`, `.dashboard-container`.

> **NEVER use raw palette tokens (`--char-0` … `--char-950`) for surfaces,
> borders, or default text.** They are **theme-invariant** — `--char-50` is always
> near-white. So `background: var(--char-50)` is a white card in *both* themes, and
> any text on it without an explicit color inherits `--fg` (white in dark mode) →
> **white-on-white** (this exact bug shipped in `Faucet.tsx`). Always use the
> theme-aware semantic tokens: surfaces `--surface`/`--bg`/`--bg-alt`; text
> `--fg`/`--fg-2`/`--fg-3`; borders `--border`/`--border-hi`; status
> `--sprout`/`--ember`; accent `--burn`. The *only* legit raw-palette use is
> fixed-contrast text on a fixed accent fill (e.g. `--char-950` label on a `--burn`
> button). And **never rely on inherited text color on a colored/`--surface` card** —
> set `color` explicitly so it's correct in both themes. After adding/altering any
> theme token, run `npx vitest run` — `src/frontend/src/test/contrast.test.ts`
> asserts the WCAG ratios and must stay green.

Note: the per-card `card` style object is currently re-declared at the top of
each page (e.g. `Lottery.tsx:124`, `Poker.tsx:22`). Match that — copy the same
const or use the `.card` class — rather than inventing new card padding/border.

### Wire it into the shell (`App.tsx`)

A page isn't reachable until all four are done — follow how an existing page
(e.g. `casino`) does each:

1. Add the page id to the `AppPage` union type (`App.tsx:50`).
2. Render it in the page-switch ternary chain (`~2294+`), passing the standard
   props and `onGo…` callbacks (`setPage('…')`).
3. Gate it on a feature flag derived from `list_feature_flags` — add a
   `<x>Enabled` const alongside the others (`App.tsx:549-557`), show its nav
   entry only when enabled, and add the redirect guard so a disabled page
   bounces (`~1172`). New games/features ship dark (flag default OFF).
4. Add the nav button/tab next to its peers (Earn/Participate/Play groups).

## Color contrast & light-mode accessibility

Low-contrast UI is almost always a **light-mode** bug here, and it has a single
structural cause worth understanding before you touch colors.

### The thresholds (WCAG 2.2 AA — the target)

- **Normal text ≥ 4.5:1** against its background.
- **Large text ≥ 3:1** — "large" = ≥ 24px, or ≥ 18.66px **bold**.
- **Non-text / UI ≥ 3:1** (SC 1.4.11): meaningful icons, the border that *is* an
  input/control, focus rings. Purely decorative hairlines are exempt.
- Disabled/inactive components are exempt from text contrast — but only if
  they're genuinely disabled.
- (AAA is 7:1 / 4.5:1. APCA is the emerging WCAG 3 successor — Lc 60 ≈ 4.5:1 —
  but WCAG 2.2 ratios are what we check today.)

### The structural trap in THIS codebase

The token system (`index.css`) defines accents — `--burn`, `--sprout`, `--haze`
— **once at `:root` and the `[data-theme="light"]` block does NOT override
them.** It remaps `--fg-*` / `--bg` / `--border`, but the accents are
theme-invariant. They're tuned for the **dark** surface (near-black), where they
have huge contrast. Flipped onto the light surface (near-white) they collapse:

| Token as text/icon | on light `--bg` | verdict |
|---|---|---|
| `--burn` #FF6A1F | 2.6:1 | fails text **and** 3:1 icon |
| `--sprout` #4CB580 | 2.3:1 | fails |
| `--haze` #D4A84B | 2.0:1 | fails (worst) |
| `--fg-3` #78716C | 4.36:1 | fails 4.5 normal (OK for large only) |
| `--fg-dim` #A8A29E | 2.3:1 | OK only as *disabled* |

So: **an accent or muted-grey that looks fine in dark mode can be unreadable in
light mode.** Always verify both themes — the app defaults to dark, so light-mode
contrast bugs hide.

### How to spot it (do all three when touching color)

1. **Toggle the theme and look.** Set `data-theme="light"` on the root (the theme
   button in the top bar) and eyeball muted text, chips, eyebrows, icons, and
   any accent-colored text.
2. **DevTools per element.** Inspect → the color swatch in the Styles pane shows
   the live contrast ratio with AA/AAA ticks and a suggested passing color; or
   run Lighthouse / axe DevTools for a page sweep.
3. **Token-level math** (fastest for the design system) — compute the ratio for a
   token pair instead of guessing:

   ```python
   def lin(c):
       c/=255; return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
   def lum(h):
       h=h.lstrip('#'); r,g,b=(int(h[i:i+2],16) for i in (0,2,4))
       return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)
   def ratio(a,b):
       la,lb=lum(a),lum(b); return (max(la,lb)+0.05)/(min(la,lb)+0.05)
   ```

   Rule: **every token used as a foreground (text or meaningful icon) must clear
   4.5 (3 if large/icon) against EVERY surface it lands on — `--bg`, `--surface`,
   `--bg-alt` — in BOTH themes.** Bright-on-dark accents need a darker `-ink`
   variant for light mode (see the fix pattern below).

### The fix pattern (don't darken the global accent)

The bright accents are correct as **fills** (e.g. a burn-filled primary button).
The problem is only the accent used as **foreground text/icon on a light
surface.** So add theme-aware `*-ink` tokens rather than changing `--burn` etc.:

```css
:root              { --burn-ink: var(--burn);   --sprout-ink: var(--sprout); --haze-ink: var(--haze); }
[data-theme=light] { --burn-ink: #AD3F0F;       --sprout-ink: #15663A;       --haze-ink: #8A5A00; }
```

Then use `--burn-ink` (not `--burn`) wherever the accent is text/icon. Verify
candidate values with the snippet above before committing.

## Candid bindings — generated, never edited

`src/frontend/src/bindings/` is generated by the `@icp-sdk/bindgen` vite
plugin from `src/backend/backend.did` and `ledger.did` (see `vite.config.ts`).
It regenerates on `dev`/`build`. **Never hand-edit these files**; to change
the API surface, change `backend.did` (and the Rust backend) instead.

Two layers exist:
- `bindings/backend.ts` — the wrapper to import. Candid `opt T` is exposed as
  `Option<T>` = `{ __kind__: "Some", value } | { __kind__: "None" }`.
- `bindings/declarations/*.did.js|d.ts` — raw agent layer where `opt T` is an
  **array**: `[] | [T]`.

## The opt-decoding trap (caused real bugs here)

If a value from the backend is unexpectedly `undefined`, an object with a
`length`, or a button does nothing after a successful call, check optional
handling first. At the raw declarations layer `opt` comes back as `[]` or
`[value]` — code that treats it as the value itself fails silently (this was
the Staking step-3 dead-button bug in `fetchMyPoolNeuron`). With the wrapper
layer, check `__kind__ === "Some"` before reading `.value`. Match whichever
layer the surrounding file already uses.

**It applies to opt INPUT args too.** The wrapper actor takes an `opt T` argument
as **`T | null`** (e.g. the generated `get_faucet_status(arg0: Principal | null)`),
NOT the raw-declarations `[]` / `[x]` array. Passing `cid ? [cid] : []` throws on
the call → the await rejects → your state stays `null` and the page renders a false
empty/closed state. This shipped as the faucet "faucet is currently closed" bug.
Pass `cid` (a `Principal | null`) directly. Check the generated signature in
`bindings/backend.ts` when in doubt.

Other decoding notes: candid `nat64`/`nat` arrive as **`bigint`**, not
`number` — convert explicitly for display math (e8s: divide by `100_000_000n`).

## Auth & gating

Sign-in is Internet Identity via `@icp-sdk/auth`. The UI uses progressive
disclosure tiers (anonymous → authenticated → verified follower → active
participant) — gate new UI the same way rather than inventing a new check.
Arcade and Early Adopters render only when their backend feature flags are on
(`list_feature_flags`); locally `deploy-local.sh` enables both.

## Tests

Vitest + Testing Library, jsdom; tests live in `src/frontend/src/test/`
(`utils.test.ts`, `ideaBoard.test.ts`, `minigolf.test.ts`, shared `setup.ts`).
Pure logic is extracted into testable functions — follow that pattern instead
of mounting whole pages against a live canister.
