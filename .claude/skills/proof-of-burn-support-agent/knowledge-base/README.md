# Support knowledge base

Cached, verified answers to recurring COI / Proof of Burn questions. Built and
maintained by the `proof-of-burn-support-agent` skill. The goal: common
questions get a fast, consistent, *already-verified* answer instead of
re-deriving it from the code every time.

## Layout

- `index.md` — one line per entry: slug, the question it answers, and a hook.
  This is what the agent scans first on every message.
- `entries/<slug>.md` — one canonical Q&A per file, with the frontmatter below.

## Entry format

```markdown
---
slug: how-burn-works
question: "What actually happens to my ICP when a proposal passes?"
aliases:
  - "where does my ICP go"
  - "is the ICP really burned"
  - "what is burn to cycles"
sources:
  - src/backend/src/lib.rs       # §11 escrow/settlement
  - README.md                    # section 4
verified_at: <git sha at time of verification>
verified_date: 2026-06-13
---

**Answer (Discord-ready):**

<the exact text to send, in Discord markdown, plain language, short>

**Notes (internal, not sent):**

<why this is the answer, edge cases, what to double-check, when it goes stale>
```

## Rules

- **Verify before you cache.** Every answer's facts must be checked against the
  files in `sources` at the recorded `verified_at` commit.
- **Freshness check on reuse:** before reusing an entry, compare its
  `verified_at` to the current HEAD. If any `sources` file changed since then
  (`git log <verified_at>..HEAD -- <file>`), re-verify and bump `verified_at`.
- **One fact per entry. Update, don't duplicate.** If a question is a rephrase
  of an existing entry, add it to that entry's `aliases`.
- **Only durable facts.** No account-specific replies, no live proposal status,
  nothing time-sensitive. Those are answered live and never cached.
- **Plain language, no file paths in the Answer block.** Paths live in
  `sources`/Notes for the agent, never in the user-facing text.
- **Prefer "currently configured to…" for anything an admin can change**
  (thresholds, fees, feature flags) so a cached answer never asserts a value as
  permanent.
