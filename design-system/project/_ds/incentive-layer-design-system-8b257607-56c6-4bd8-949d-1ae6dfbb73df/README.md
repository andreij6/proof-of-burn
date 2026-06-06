# Incentive Layer — Design System

> A Network of Networks on ICP. We help high-performing applications succeed, and in doing so, increase the cycle burn rate of the Internet Computer.

## What is Incentive Layer?

Incentive Layer is a blockchain protocol built on the **Internet Computer (ICP)** that operates as a **Network of Networks**. The core thesis:

- ICP measures real economic activity through **cycle burn** — cycles are the compute/storage unit, and burning them is the protocol's equivalent of gas consumption.
- The more successful apps running on ICP, the higher the burn rate, the stronger the network.
- Incentive Layer aligns capital and coordination around the apps most likely to drive that burn — a programmable layer of incentives that funds, routes liquidity to, and amplifies high-performing dApps.

**Who uses it**
- **App founders / dev teams** on ICP — apply for incentives, track their burn contribution.
- **Capital allocators / stakers** — delegate to networks, earn from successful apps.
- **Network operators** — sub-networks that curate app portfolios within a vertical (DeFi, social, AI, etc).

**Products in this system**
1. **Marketing site** — explains the thesis, shows live burn metrics, recruits apps + allocators.
2. **Web dashboard** — where apps and allocators actually transact. Dense, data-rich, terminal-adjacent.
3. **Mobile app** — read-mostly companion. Burn metrics, portfolio checks, push alerts on reward epochs.

---

## Source materials

No codebase, Figma, or existing brand was provided. The system below was designed from scratch based on:
- The product description: *"Network of Networks on ICP, increasing cycle burn rate by helping high-performing apps succeed."*
- The **modern crypto** aesthetic direction (chosen by the user — clean, confident, some motion).
- **Founder-casual / builder energy** tone of voice.

When real brand assets arrive, replace: `/assets/logo-*.svg`, fonts in `/fonts/`, and the copy in UI kits.

---

## Content fundamentals

Incentive Layer speaks like a founder who ships. Direct, specific, slightly irreverent, technically precise when it matters.

**Voice rules**
- **Second person, active voice.** "You earn," not "users earn." "We ship weekly," not "our team releases regularly."
- **Plainspoken technical.** Use real terms — *cycles, burn rate, epoch, subnet, staking* — without hand-holding. This audience knows ICP.
- **No marketing fluff.** No "revolutionary," "game-changing," "seamless," "unlock." Cut every adjective that could apply to any product.
- **Numbers over adjectives.** Say "burned 4.2B cycles last week," not "driving strong usage."
- **Short sentences. Occasional fragments. Like this.**
- **Sentence case everywhere** — headlines, buttons, nav. Title Case feels corporate.
- **No emoji in product UI.** Emoji OK in informal docs and changelog. Never in buttons, headers, status chips.
- **No exclamation marks** except in error recovery ("We're back!") and celebratory moments (a new epoch closing).

**Copy examples — do**
- "Apps on Incentive Layer burned 42.8B cycles this epoch."
- "Stake cycles. Route them to apps. Earn when they burn."
- "You're in. Your first allocation unlocks at epoch 1,204."
- "Couldn't read that address. Paste it again?"
- "Earn when the network works."

**Copy examples — don't**
- ~~"Welcome to the future of decentralized app incentives!"~~
- ~~"Our revolutionary platform seamlessly unlocks value for stakeholders."~~
- ~~"Click here to get started on your journey."~~
- ~~"Users can securely manage their portfolio with ease."~~

**Casing specifics**
- Product name: **Incentive Layer** (both words capitalized, always).
- Protocol terms: `cycles`, `burn`, `epoch`, `subnet` — lowercase in prose, monospace in UI labels.
- Numbers: always format with separators (`4,218,300,000` or `4.2B`). Never raw long digits.
- Addresses: truncate to `aaaaa-bb...yyyy-zz` in UI, monospace, copy-on-click.

**Error tone**
- Blame the system, not the user. "We couldn't sign that transaction" not "Your signature failed."
- Offer the next action. Never just state what went wrong.

---

## Visual foundations

### Palette

A single **hot accent** (amber-orange, evoking burn) against a deep **char** neutral. Warm grays only — no cool blue-grays. ICP crypto tropes to reject: purple/blue gradients, neon-on-black cyberpunk, rainbow charts, glassmorphism.

- **Primary**: `--burn` — saturated amber-orange `#FF6A1F`. Used for CTAs, live data, active states. Used *sparingly* — it should always mean something.
- **Char**: `--char-950` through `--char-50` — warm near-black to warm off-white. Never pure black, never pure white.
- **Support**: `--ember` (deep red for errors/alerts), `--sprout` (muted green for confirms/growth), `--haze` (dim yellow for warnings).
- **No purple. No electric blue. No cool cyan.**

### Type

- **Display**: `Space Grotesk` — geometric, slightly tech-y, good at big sizes.
- **Body / UI**: `Inter Tight` — workhorse sans, tighter than Inter, reads smaller.
- **Mono**: `JetBrains Mono` — for addresses, hashes, numeric data, code.
- **Flagged**: No custom fonts supplied. These are Google Fonts stand-ins. Replace when real brand fonts arrive.

Type is **tight-tracked at display sizes** (`-0.02em`) and **slightly loose at small sizes** (`0.01em`). Headings get heavy weights (600–700), body stays 400/500.

### Spacing

4px base grid. Scale: 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96, 128. Layouts respect 8px vertical rhythm.

### Backgrounds

- Primary surface: `--char-950` in dark mode (default), `--char-50` in light mode.
- **Repeating horizontal-rule pattern** as a background motif — visualizes "layers." Used on hero sections, empty states, and loading states. NOT on dashboards (too noisy).
- No hero images on marketing. No stock photography. All imagery is either data visualizations, the logo, or the rule pattern.
- **Full-bleed** sections separated by a 1px `--char-800` rule. Never box-in sections with rounded containers at top-level.

### Motion

- **Fades** for enter/exit (180ms, ease-out).
- **Slide + fade** for sheets/drawers (240ms, cubic-bezier(0.2, 0.8, 0.2, 1)).
- **Number tickers** — any metric that updates live animates in 300ms with monospace tabular-nums.
- **Pulse** on the `--burn` accent only when something is genuinely live (active epoch, connected wallet). `opacity: 1 → 0.6 → 1` over 2s, infinite.
- **No bounces, no spring physics, no parallax, no scroll-triggered theater.**

### Hover / press

- **Hover**: raise surface by one step (`--char-900` → `--char-850`), or add 8% white overlay on the accent.
- **Press**: drop by 1px (`transform: translateY(1px)`), no color change.
- **Focus**: 2px `--burn` ring with 2px offset. Visible. Crypto users navigate with keyboards.
- **Disabled**: 40% opacity, no pointer events.

### Borders, radii, shadows

- Borders: **1px hairlines** in `--char-800` or `--char-200`. No 2px.
- **Radii**: `--r-sm: 4px` (inputs, chips), `--r-md: 8px` (cards, buttons), `--r-lg: 12px` (modals). Nothing over 16px. **No fully-rounded pills** except for status dots.
- **Shadows**: almost none. One subtle elevation shadow for modals/toasts: `0 12px 32px -8px rgba(0,0,0,0.45)`. Dashboards rely on borders + tone, not shadows.
- **No inner shadows.** No gradients on buttons. No glossy edges.

### Transparency & blur

- Modals backdrop: `rgba(12, 10, 9, 0.7)` with `backdrop-filter: blur(8px)`.
- Sticky nav on marketing: `rgba(12, 10, 9, 0.8)` + blur when scrolled.
- **Don't use transparency for decoration.** It's a functional tool only.

### Cards

- 1px border, no shadow, `--r-md` corners, `--char-900` fill on dark / `--char-50` fill on light.
- Hover: border brightens one step. No lift, no shadow appearance.
- A card with `--burn` border means "this is the active/live one."

### Imagery vibe

When real imagery exists: warm tones, slight grain, low-saturation. Never cool, never glossy. Lean editorial over stock. Product UI imagery should be actual UI screenshots — no mockup frames with floating shadows.

### Layout rules

- Marketing: **max 1200px** content width, 24px side gutters on mobile.
- Dashboard: **fluid full-width**, 280px left nav, 320px optional right panel.
- Fixed header: 56px tall, always. Never sticky footers.
- Data tables: zebra-striping at `--char-925`, never borders between every row.

---

## Iconography

**Approach**: stroke-based, 1.5px weight, 20px and 24px sizes, no fills. We reject plump filled crypto-style icons.

- **Library**: [Lucide Icons](https://lucide.dev/) — loaded via CDN (`https://unpkg.com/lucide@latest`). Chosen for its stroke consistency, comprehensive crypto-adjacent coverage (wallet, coins, activity, trending-up), and MIT license.
- **Substitution flag**: Since no branded icon set exists yet, Lucide is the full set. Ship a custom trimmed subset once the product stabilizes.
- **Custom icons** (in `/assets/icons/`):
  - `logo-mark.svg` — the layered horizontal-rule mark.
  - `logo-wordmark.svg` — mark + "Incentive Layer" wordmark.
  - `burn-mark.svg` — the cycle burn symbol (used as favicon-adjacent marker).
- **No emoji** in product UI. Changelogs and informal team comms only.
- **No unicode fake-icons** (no ◆, ▲, ●, etc) except for status dots, where we use a styled `<span>` instead.

---

## Index

```
/
├── README.md                    ← you are here
├── SKILL.md                     ← agent skill manifest
├── colors_and_type.css          ← all design tokens + semantic vars
├── assets/
│   ├── logo-mark.svg            ← the stacked-layers mark
│   ├── logo-wordmark.svg        ← mark + wordmark, horizontal
│   ├── logo-wordmark-light.svg  ← for dark backgrounds
│   └── pattern-layers.svg       ← repeating horizontal-rule bg
├── fonts/                       ← Google Fonts CDN references (see file)
├── preview/                     ← design system cards (typography, color, components…)
├── ui_kits/
│   ├── marketing/               ← Marketing website UI kit
│   ├── dashboard/               ← Web dashboard UI kit
│   └── mobile/                  ← Mobile app UI kit
```

See each `ui_kits/<product>/README.md` for product-specific notes.
