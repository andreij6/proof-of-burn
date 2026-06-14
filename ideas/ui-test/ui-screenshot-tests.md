# Browser Screenshot UI Tests — Vision (PB-600, draft)

> Render the real app in a headless browser, screenshot every public surface in
> **both light and dark mode**, and review the images for visual defects —
> contrast (dark-on-dark / white-on-white), badge legibility, layout breakage,
> overflow. The kind of bug jsdom unit tests structurally **cannot** catch.

Status: **idea / not scheduled, not built.** Captured for later.

---

## 1. Why

Every visual regression we've shipped — the light-mode "Needs attention" card,
dark-on-dark badges, the "Your activity" row, "The Brief" card, R&D sort pills —
slipped through because **there is no rendering in our test stack**:

- `npm test` runs **Vitest with `environment: 'jsdom'`** — a simulated DOM with
  no paint, no layout, no computed colors. It can't tell that a card is
  dark-text-on-dark-background.
- The existing test files (`utils`, `contrast`, `dashboard`, `ideaBoard`, …)
  test **extracted pure logic**. Even `contrast.test.ts` checks color-contrast
  *ratios of token values* (math), not what actually renders.
- No Playwright / Puppeteer / Cypress; no `.spec.ts`; no visual-regression or
  screenshot tooling anywhere in the repo.

Result: contrast/theme bugs are only ever found by a human clicking through both
themes by hand. A screenshot pass closes that gap and is also reviewable by an
AI agent (images can be opened and described).

## 2. What it does

1. Boots **headless Chromium (Playwright)** against the running app
   (`http://frontend.local.localhost:8000/` locally; the prod URL in CI).
2. Visits each **public surface** and captures a full-page screenshot in **dark
   mode and light mode** (toggle via the in-app theme button, or by seeding
   `localStorage.theme = 'light'` before load — note the new persisted-theme
   support added 2026-06-14).
3. Saves PNGs to an artifact dir (e.g. `src/frontend/e2e/__screenshots__/`).
4. A reviewer (human or agent) **opens the PNGs and makes observations** —
   contrast, legibility, overflow, alignment. (Optionally add pixel-diff
   baselines later for automated regression, but start with review-only.)

## 3. Scope (first pass)

Public / anonymous surfaces — no sign-in required, and exactly where the
contrast bugs live:

- Landing
- Dashboard (tier-0 / signed-out)
- Voting (proposal list + an open "Confirm Conviction Burn" dialog)
- Lottery hub (Drawings + Stake-to-Earn tabs)
- Community R&D (Ideas / Projects / "What we're looking for")
- Dapp Explorer
- Neuron Syndicate (Earn) — incl. the "Syndicate Voting Power" card

Each in **both themes** → ~14 screenshots.

## 4. The auth caveat

Most state-changing flows sit behind **Internet Identity** (a popup that's hard
to drive headlessly). Options, cheapest first:

1. **Public surfaces only** (above) — covers ~all known contrast bugs. Start here.
2. **A test/mock-auth seam** — a dev-only way to inject a signed-in identity
   without the II popup, so authed dialogs/cards (member cards, wallet, payouts)
   can be screenshotted too.
3. Manual II login once + reuse the storage state (brittle; last resort).

## 5. Mechanics / decisions to make

- **Tool:** `@playwright/test` (headless Chromium via `npx playwright install
  chromium`). Add as a `devDependency`; new `e2e/` dir + npm script
  (`npm run e2e:shots`).
- **Theme toggle:** prefer seeding `localStorage.theme` pre-navigation (now
  honored before first paint via the inline script in `index.html`) for a
  deterministic, flash-free capture.
- **Target URL:** parameterize (local default, prod/staging in CI).
- **Review-only vs. pixel-diff:** start review-only (lower maintenance); add
  Playwright's `toHaveScreenshot()` baselines later if we want hard regression
  gates.
- **CI:** wire as a **manual** GitHub workflow (like the existing
  `integration.yml`) — screenshots uploaded as build artifacts. Not a per-PR
  blocker until baselines are trusted.

## 6. Tasks (when scheduled)

- [ ] **6.1** Add `@playwright/test` devDep + `playwright.config.ts` (chromium,
  baseURL param). — *S*
- [ ] **6.2** `e2e/screenshots.spec.ts`: loop the §3 surfaces × {dark, light},
  full-page PNGs to `__screenshots__/`. — *M*
- [ ] **6.3** `npm run e2e:shots` script + short README on running it against a
  local deploy. — *S*
- [ ] **6.4** First review pass; file any contrast/layout defects found. — *S*
- [ ] **6.5** (Optional) mock-auth seam to extend coverage to authed surfaces. — *M*
- [ ] **6.6** (Optional) manual CI workflow uploading screenshots as artifacts. — *M*
- [ ] **6.7** (Optional) opt into `toHaveScreenshot()` pixel baselines for
  regression gating once the UI is stable. — *M*

## 7. Notes

- Reuses the design system's theming (`data-theme="light"` on `documentElement`,
  the `--surface`/`--fg`/`*-ink` tokens) — the screenshots validate exactly the
  theme-adaptive work done in the 2026-06-14 contrast pass.
- Keep it out of the default `npm test` (it needs a running canister + a browser
  binary); it's a separate, opt-in command.
