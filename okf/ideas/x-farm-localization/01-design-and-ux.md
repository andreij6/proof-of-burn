---
type: idea
title: "01 — Design & UX"
tags: [ideas, x-farm-localization]
timestamp: 2026-06-20T01:26:49-04:00
---

# 01 — Design & UX

## The language set (v1)

Curated, not free-text — free-text invites typos and languages the model handles
badly. Ship a small, high-quality set chosen for **active ICP communities**:

| code | language | why |
|---|---|---|
| `en` | English | default; zero behavior change |
| `es` | Spanish | LatAm + Spain CT clusters |
| `zh` | Chinese | large CN CT, key market |
| `ja` | Japanese | active JP ICP community |
| `tr` | Turkish | vocal Turkish CT |
| `pt` | Portuguese | Brazil crypto community |

Add more later by extending the curated list (a frontend const + an allowlist check
in the backend — see `02-impl.md`). The model (Gemini 3.5 Flash,
`proxy/main.py:28`) handles all six well.

## Decoupling voice from language

The persona presets (`PERSONA_PRESETS` in `XFarm.tsx:41`) describe a *stance*
("perma-bull," "cross-chain diplomat"). They are written in English and **stay
English** — they're instructions to the model about the voice, not the output
language. The owner picks a persona (voice) **and** a language (tongue)
independently. The proxy composes them:

```
PERSONA (data, English voice description) + LANGUAGE (output tongue)
→ drafts in {language} that sound like {persona}
```

So "Bridge Builder in Japanese" drafts Japanese tweets proposing cross-chain
collaborations. This is the cleanest factoring — no per-language persona
reauthoring.

## Hashtag handling

The `SYSTEM` prompt (`proxy/main.py:71`) already says *"Add 1-3 relevant hashtags
when they fit naturally — prefer trending/topical tags… always include #ICP or
#InternetComputer, plus a topical one."* For non-English, extend it:

- `$ICP` cashtag is **universal** (it's a ticker, not a word) — keep it in every
  language.
- The mandatory `#ICP` / `#InternetComputer` becomes **language-appropriate**
  (e.g. Japanese may prefer `#ICP` alone; Spanish may add `#Cripto`). The prompt
  should say *"include `$ICP` plus 1-3 hashtags relevant to the {language}
  community"* and trust the model — the same way English already trusts it.
- **Hallucinated hashtags** are the residual risk (R3) — the model may emit a
  plausible-sounding tag that isn't actually trending. Accepted for v1 (same
  trust as English); the owner reviews before posting.

## Char limits

Twitter counts **CJK (Chinese/Japanese) characters as 2 weight** each toward the
280 limit; Latin scripts count 1. The `SYSTEM` cap is *"≤ 280 chars each"*. For
CJK this over-counts (a 280-*character* JA draft would be ~560 Twitter weight and
fail to post). Fix:

- Tighten the per-draft cap to **≤ 140 characters for CJK languages**, ≤ 280 for
  Latin. The proxy computes the cap from the `language` code. This keeps tweets
  postable without the owner editing length.
- Document it in the wizard copy: *"Drafts in Chinese/Japanese are kept shorter
  to fit X's character weighting."*

## UX

### Persona wizard — new step (or fold into persona step)
- After "Pick a voice," a **"Output language"** `<select>` with the curated set,
  default `English`.
- Helper line: *"Drafts will be written in this language. The persona (voice) is
  separate — e.g. a Japanese Price Bull."*
- The "Review & pay" summary (`XFarm.tsx` pay step) gains a `Language:` row.

### `FarmerCard` status row
- Add a language chip next to the persona: `persona: Bull · 🇪🇸 ES` (or just
  `· Spanish`). Reuses `Chip tone="muted"`.

### Empty-state persona gallery
- Add a one-line note above the example-tweet grid: *"Each persona can draft in
  your chosen language — pick a voice, then a tongue at create time."* No need to
  localize the example tweets themselves (they're illustrative).

### Existing farms
- `language` defaults to `"en"` on upgrade — existing farms are unchanged and
  show no chip (or an `EN` chip — TBD, Q2). A new language requires a new farm
  (or renew-with-change, Q1).

## Out of scope (explicitly not doing)

- **Auto-detecting the owner's language** from browser/locale — surprising and
  often wrong; an explicit pick is clearer.
- **Translating the persona presets** into each language — unnecessary (voice ≠
  tongue; the model composes them).
- **Localized UI** (the X-Farm page itself in other languages) — separate,
  larger effort; this feature only localizes *draft output*.