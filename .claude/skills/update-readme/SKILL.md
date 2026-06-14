---
name: update-readme
description: Update a project's README to match the current codebase without changing its format or voice. Use when asked to refresh/update a README, fix stale docs (commands, feature list, directory layout, links, versions/prerequisites), or bring a README up to date after code changes. Works for any project (Node, Rust, ICP canister, mixed).
---

# Update a README (any project)

**Goal:** make the README reflect what the project *actually is now*, while
preserving its existing structure, heading style, tone, and formatting. Fix
what's false; keep what's fine; invent nothing. "Same format, just up to date"
is the contract — honor it.

## The one rule

**The existing README is the template, not a draft to rewrite.** Match its
section order, heading depth, list style, voice (terse vs. prose), emoji/badge
use, and code-fence conventions. If you're reformatting or reordering, you've
overstepped — unless the user explicitly asked for a redesign.

## Step 1 — Read & map the existing README first

Read it whole. Note every section, its heading level, and the project's voice.
Make a mental list of every **verifiable claim** it makes: name, one-liner,
prerequisites, install/build/run/test commands, feature list, directory layout,
internal links, external URLs/badges, version numbers.

## Step 2 — Gather ground truth (verify each claim against the repo, don't trust the README)

| README claim | Source of truth to check |
|---|---|
| Name / one-liner | `package.json` `name`, `Cargo.toml`, module/canister name |
| Install / build / run / test commands | the **real** scripts: `package.json` `scripts`, `Makefile`/`justfile`, `Cargo.toml`, `scripts/`, `.github/workflows/*`. Confirm each command the README shows still exists; drop ones that don't. |
| Prerequisites / versions | `.nvmrc`, `rust-toolchain`, `engines`, lockfiles, CI matrix |
| Feature list | what's **actually in the code**: routes/pages, feature flags, CLI subcommands, exported modules, public API. Remove deleted features; add shipped ones. |
| Directory layout | `ls` the top level; confirm every path the README names exists; add significant new dirs, drop removed ones |
| Internal links (`docs/X.md`) | the file exists (`test -f`); fix or drop dead links |
| External URLs / badges | not obviously stale (old domain, dead CI badge); leave live app URLs unless you can confirm a change |

Prefer reading the actual files over recalling commands from memory.

## Step 3 — Update surgically, preserving format

- Change **only** what's false or missing. Leave accurate prose alone — don't
  reword for taste.
- Mirror the surrounding style exactly: same heading depth, list markers, code-
  fence language tags, and comment alignment in command blocks.
- **Sweep, don't spot-fix:** when you remove/rename a feature, also fix its
  mentions in the intro paragraph, the layout section, and any links — not just
  the one obvious bullet.
- Don't add badges, marketing, or sections the project never had.

## Step 4 — Verify before done

- Diff your change against the original: format preserved? nothing invented?
- Confirm every command you kept/changed actually exists; confirm every internal
  link resolves.
- If little or nothing was stale, **say so plainly.** An honest "already current
  except X, Y" is a better outcome than fabricated edits to look busy.

## Anti-patterns (don't)

- Rewrite a terse README into verbose prose (or vice versa).
- Reorder or "modernize" the structure when asked only to update content.
- Copy commands from memory instead of from the actual scripts/CI.
- List aspirational features that aren't in the code.
- Remove a feature from the list but leave it in the intro/layout/links.
