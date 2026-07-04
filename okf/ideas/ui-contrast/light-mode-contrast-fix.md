---
type: idea
title: "Light-mode Contrast Fix — Plan (deferred)"
tags: [ideas, ui-contrast]
timestamp: 2026-06-14T06:50:51-04:00
---

# Light-mode Contrast Fix — Plan (deferred)

> Several UI elements fail WCAG contrast **in light mode**. This is the remediation
> plan; **not started, fix later.** Detection method + the `-ink` token pattern now
> live in the `frontend-dev` skill (`.claude/skills/frontend-dev/SKILL.md` →
> "Color contrast & light-mode accessibility").

## Root cause

The `[data-theme="light"]` block in `index.css` remaps `--fg-*` / `--bg` /
`--border` but **not** the accents (`--burn` / `--sprout` / `--haze`), and `--fg-3`
sits just under threshold. Accents and mid-greys tuned for the dark surface
collapse on the near-white light surface. **Dark mode is fine — every failure is
light-mode only.** Accents as *fills* are fine (e.g. burn button + dark text ≈
7:1); only accents as *foreground text/icon* fail.

## Measured failures + verified replacements

WCAG 2.2 AA targets: text ≥ 4.5:1, large/icon/UI ≥ 3:1. Values verified with the
luminance/ratio snippet in the skill (re-run before committing).

| Token (as text/icon) | light ratio | Fix | New **light** value | New ratio |
|---|---|---|---|---|
| `--fg-3` muted text | 4.36 | darken in `[data-theme=light]` | `#645C55` | 5.96 ✓ |
| `--border-hi` meaningful dividers | 2.40 | darken in `[data-theme=light]` | `#7A736C` | 4.25 ✓ |
| `--fg-dim` disabled | 2.29 | keep (exempt) — audit for misuse | — | — |
| `--burn` as text/icon | 2.61 | new `--burn-ink` (theme-aware) | `#AD3F0F` | 5.47 ✓ |
| `--sprout` as text/icon | 2.32 | new `--sprout-ink` | `#15663A` | 6.38 ✓ |
| `--haze` as text/icon | 2.01 | new `--haze-ink` | `#8A5A00` | 5.39 ✓ |

## Plan (tiered by leverage)

### Tier 1 — one-line token fixes (huge coverage, no sweep) — do first
In the `[data-theme="light"]` block only: `--fg-3 → #645C55`, `--border-hi →
#7A736C`. Already consumed via `var(--fg-3)` / `var(--border-hi)`, so this fixes
all muted text + dividers app-wide in two edits, dark mode untouched. Then audit
`--fg-dim` usages — keep on genuinely disabled elements (exempt); switch any
*live* text off it to `--fg-3`.

### Tier 2 — accents via the `-ink` pattern + scoped sweep
Add theme-aware tokens (bright in dark, dark in light):
```css
:root              { --burn-ink: var(--burn);  --sprout-ink: var(--sprout); --haze-ink: var(--haze); }
[data-theme=light] { --burn-ink: #AD3F0F;      --sprout-ink: #15663A;       --haze-ink: #8A5A00; }
```
Migrate **foreground** accent usages → `-ink` (≈ **100 sites**: `stroke="var(--burn)"`
×67, `color: var(--burn)` ×30, sprout ×23, haze ×8). **Leave ~15 `background:`
fills alone.** Centralized spots to fix: `Eyebrow` accent (`ui.tsx:101`),
`--fg-accent` (`index.css:51/264` → point at `--burn-ink`). Audit `CHIP_TONES`
(`ui.tsx`) — chips pair accent text on `-dim` fills; verify each pair and that the
dark `-dim` chip backgrounds don't look wrong on light surfaces.

### Tier 3 — verify + guardrail
Re-run the contrast snippet over the final palette in **both** themes; spot-check
Dashboard / Lottery / Payouts in DevTools light mode. Optionally add a `vitest`
asserting each `(token, surface)` pair clears its threshold — a regression guard
so a future accent tweak can't silently re-break light mode.

## Sequencing & risk

- **Tier 1 is the high-ROI quick win** (two lines; fixes the most common
  complaint) — ship it standalone first.
- Tier 2 is ~100 mechanical edits → its own PR with the script diff as evidence.
  Risk is low: `-ink` ≡ the accent in dark mode, so **dark mode is provably
  unchanged**; only light mode shifts.
- Independent of the parked Oisy work — and the planned Oisy "blue card" should
  pick an `--azure-ink` that passes the same check.
