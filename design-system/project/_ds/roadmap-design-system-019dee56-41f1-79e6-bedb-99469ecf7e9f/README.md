# Roadmap Design System

> A community-driven software direction platform built on the Internet Computer Protocol (ICP). Founders propose, communities stake, and the roadmap moves on-chain.

---

## ⚠️ Source Material Note

This design system was built from a **product specification only** — no codebase, Figma, or screenshots were provided. The spec describes the visual target as:

> "Dark-mode centric, high-contrast, minimal borders (Linear aesthetic)."

So this system establishes a **Linear-inspired** visual language adapted for an on-chain governance context (ICP, staking, voting). All visual decisions (exact palette, typography, motion) are interpretive — please review and request adjustments where the brand should diverge from a Linear-likeness.

**Sources used:**
- The product spec / roadmap document pasted into the project chat (Section 1–7: Project Overview, Tech Stack, User Roles, Kanban Workflow, Staking Logic, UI/UX Requirements, Security).

**Sources NOT available (please attach if you have them):**
- Existing Roadmap codebase (frontend repo / canister UI)
- Figma file or design mocks
- Logo / wordmark assets
- Brand voice or content style guide

---

## Index

```
README.md                ← you are here
SKILL.md                 ← agent skill manifest (Claude Code compatible)
colors_and_type.css      ← all design tokens (colors, type, spacing, radii, shadows)
fonts/                   ← Inter Variable + JetBrains Mono (substitutes — see note)
assets/                  ← logo, mark, brand imagery
preview/                 ← design system specimen cards (rendered in Design System tab)
ui_kits/
  app/                   ← the Roadmap product itself — Kanban board, ticket modal, sidebar
  marketing/             ← public-facing landing page
```

---

## Product Overview

**Roadmap** lets developers ("Founders") align with their community ("Board Members" + "Backers") by staking ICP tokens to propose, vote on, and track software features. Three roles, four Kanban states, weighted voting, and on-chain finality.

**Roles**
- **Founder** — project creator. Owns ticket lifecycle, GitHub integration.
- **Board Member** — staked 50+ ICP. Can propose ideas + vote.
- **Backer** — staked any amount. Can vote. Can buy influence boosts (0.1–10 ICP).

**Workflow** — a four-column Kanban:
1. **Voting** — new ideas with community sentiment bars
2. **Development** — passed quorum; linked to GitHub
3. **Done** — shipped
4. **Archived** — failed quorum / deprecated

**Voting power** — `VP = (Staked × Base Weight) + Influence Boost`

---

## Content Fundamentals

> ⚠️ Inferred from spec terminology — please confirm or override.

**Tone:** Direct, technical, slightly subversive. The product is built by developers for developers, with the politics of decentralized governance layered on top. Copy should feel like Linear's keyboard-shortcut-first confidence crossed with the matter-of-fact precision of a protocol whitepaper.

**Voice principles**

| Do | Don't |
|---|---|
| "Stake to vote." | "Get started by staking your tokens today!" |
| "Quorum reached." | "🎉 Congrats — your idea is moving forward!" |
| "0.4 ICP boosted by @nina.icp" | "Nina just supercharged your proposal!" |
| Use precise nouns: *quorum, ledger, canister, principal, stake* | Avoid web2 marketing words: *empower, unlock, supercharge* |

**Casing**
- **Sentence case** for all UI labels, buttons, menu items, headings (`New idea`, not `New Idea`).
- **Title Case** reserved for proper nouns and product surfaces (`Internet Identity`, `Board Member`, `North Star`).
- All-caps only for protocol units in tabular contexts: `ICP`, `VP`, `PR`.

**Person**
- Address the user as **you**. Refer to the system as **Roadmap** or implicit subject ("Idea moved to Development").
- Never first person ("I", "we") in product UI. OK in marketing.

**Numbers + units**
- Always show ICP amounts to one decimal minimum: `12.0 ICP`, never `12 ICP`.
- Voting power is a whole number with no unit: `VP 1,240`.
- Vote bars show absolute counts AND percentage: `412 for · 88 against (82%)`.

**Empty / error states** — short, declarative, no exclamation marks.
- Empty: `No ideas yet. Stake to propose.`
- Error: `Transaction reverted. Check your ledger balance.`
- Loading: `Syncing with canister…`

**Emoji** — **no.** This is a governance / financial product. Use icons (Lucide) instead.

---

## Visual Foundations

### Mood
**Dark, dense, fast.** Surfaces are near-black with quiet color. Borders are minimal — separation comes from elevation (subtle bg shifts) and whitespace. Color is reserved for state (vote sentiment, status pills, the on-chain accent). The page should feel like a developer's IDE more than a SaaS dashboard.

### Color
Two-tier system:

**Surfaces** — graphite scale from `#08090C` (canvas) to `#1F2227` (raised). All cool-neutral, no warmth. See `colors_and_type.css` for the full ramp.

**Accents**
- **Iris `#7B7FFF`** — primary action, links, focus rings. The "on-chain" color. Inspired by the cool-violet often associated with ICP/web3 governance UI.
- **Citrine `#F2C94C`** — staking, ICP value, boost actions. Money color.
- **Aurora `#4ADE80`** — for-vote, success, quorum-reached.
- **Magenta `#F26D9C`** — against-vote, archive, destructive.

Accents are used **sparingly** — usually as 1px borders, 8% backgrounds, or filled pills. Never as page backgrounds or large fills.

### Typography
- **Inter Variable** — UI, body, headings. Weight 400/500/600. Tight tracking on display sizes (`-0.02em`).
- **JetBrains Mono** — numerics, principal IDs, ICP amounts, ticket IDs (`ROAD-142`), code.
- No serif. No script. Inter does everything except numbers and IDs.

> **Substitution flag:** The spec doesn't name fonts. Inter + JetBrains Mono are loaded from Google Fonts as a defensible Linear-likeness. If you have brand fonts, drop the `.woff2` files into `fonts/` and I'll update.

### Spacing
4px base unit. Scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Components are dense by default (8–12px internal padding); breathing room is reserved for the page frame.

### Borders + radii
- **`1px solid var(--border)`** — barely-there hairlines (`#1F2228`).
- **No double borders.** When two surfaces meet, one wins.
- Radii: `4px` (chips, inputs), `6px` (buttons, tickets), `8px` (cards, modals), `12px` (large surfaces, sheets).

### Elevation
Three levels, all subtle:
- **0** — flat (canvas)
- **1** — `box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.4)` — tickets, inputs
- **2** — `box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)` — modals, popovers, dropdowns

No glow effects. No neon. No drop-shadow tricks for "depth."

### Backgrounds + imagery
- **No full-bleed photography.** Marketing surfaces use rendered code, schematic diagrams, or generative grain.
- **No purple-blue gradients.** A single subtle canvas gradient (`#08090C → #0B0D11`) is allowed at the page level only.
- **Grid lines welcome.** Faint 1px dotted grids (`rgba(255,255,255,0.03)`) in hero areas read as "blueprint."
- **No emoji decoration** ever.

### Motion
**Fast, mechanical, no bounce.**
- Default transition: `150ms cubic-bezier(0.16, 1, 0.3, 1)` (out-expo).
- Slide/sheet entrances: `220ms` same easing.
- Hover state: instant `background-color` shift, no transition delay.
- Drag-and-drop: 1.02× scale on lift, no rotate, no shadow boost.
- **No bounces, no spring overshoot, no parallax.**

### Hover + press
- **Hover** — bg moves up one surface tier (e.g. `--surface-1 → --surface-2`). On accent buttons, lighten by ~6%.
- **Press** — bg moves down one tier OR scales `0.98`. Pick one per component, never both.
- **Focus** — 2px iris ring with 2px offset on the outermost focusable surface only. Inputs use a 1px iris border instead of an outer ring.

### Cards + tickets
- 1px hairline border on `--surface-1`.
- `6px` radius.
- 12px internal padding.
- No box-shadow at rest. Shadow only on hover (elevation 1) and drag (elevation 2).

### Transparency + blur
Used **only** for modal scrims (`rgba(8,9,12,0.75) + backdrop-blur(8px)`) and the sticky header on scroll. Never on cards, never on buttons.

---

## Iconography

**System: [Lucide](https://lucide.dev) (CDN).**

Lucide's stroke-based, 1.5px-weight icons match Linear's icon language closely and are the de-facto icon set for modern productivity UIs. We load it from CDN rather than bundling.

**Usage rules**
- **Stroke width:** 1.5px (Lucide default). Never adjust.
- **Size:** 14px (inline, table rows), 16px (buttons, sidebar), 20px (empty states), 24px (marketing).
- **Color:** inherits `currentColor`. Default `--fg-muted` for decorative, `--fg` for actionable.
- **Spacing:** 6–8px gap from adjacent text, never 4px.

**Common icons in this product**
- `circle-dot` — voting state
- `git-branch` / `git-pull-request` — development
- `check` — done
- `archive` — archived
- `arrow-up` / `arrow-down` — vote for / against
- `zap` — boost / influence
- `coins` — stake / ICP balance
- `key-round` — Internet Identity / principal
- `north-star` (custom) → use `compass` as substitute

**Emoji** — never used.
**Unicode glyphs as icons** — never. Use Lucide.

> **Substitution flag:** No bespoke Roadmap icon set was provided. Lucide is the closest match to the "Linear aesthetic" the spec calls for. If a custom icon set exists, drop SVGs in `assets/icons/` and update this section.

---

## Logo + Brand Assets

**No logo was provided.** I've drafted a placeholder wordmark and mark in `assets/` based on the product name + on-chain motif (a graph node split into a path):

- `assets/logo-mark.svg` — square mark, monogram-style
- `assets/logo-wordmark.svg` — horizontal lockup
- `assets/logo-mark-light.svg` / `-dark.svg` — light/dark variants

These are **placeholders pending real brand assets**. Please provide:
- Final logomark + wordmark (SVG)
- Favicon
- Any approved illustrations or brand patterns
- OG / social images

---

## Open Questions / Caveats

1. **Brand identity** — palette, fonts, logo, voice are all interpretive. None confirmed against a real brand.
2. **Linear lookalike** — the spec asks for "Linear aesthetic" by name. We've taken inspiration but not copied. If you want closer adherence (or further divergence), tell me and I'll iterate.
3. **No real screens** — without a codebase or Figma, the UI kit components are recreations of the Kanban + governance flows described in the spec, not pixel-perfect recreations of an existing UI.
4. **ICP-specific UI patterns** — wallet connect, principal display, canister status — are designed from convention. If your team has established patterns, share them.
