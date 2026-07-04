---
type: idea
title: "03 — Risks, gates & open questions"
tags: [ideas, x-farm-localization]
timestamp: 2026-06-20T01:26:49-04:00
---

# 03 — Risks, gates & open questions

## R1 — Model output quality varies by language

Gemini 3.5 Flash (`proxy/main.py:28`) is strong in EN/ES/ZH/JA but **weaker in
lower-resource languages**; output can read as stilted or unnatural in TR/PT.
This is a curation problem, not engineering. Mitigations:

- **Curated allowlist** (`01`'s six languages) — not free-text, so we only ship
  languages we've eyeballed.
- The owner **reviews every draft before posting** (X-Farm's standing rule —
  *"you're the publisher"*). A stilted draft just gets edited or skipped; nothing
  ships automatically.
- If a language consistently underperforms, drop it from the allowlist (frontend
  const + backend check) without a migration — it's just a list.

## R2 — CJK character weighting breaks the 280 cap

Twitter weights CJK characters doubly; a 280-*char* JA draft won't post. The
design halves the cap to **140 chars for `zh`/`ja`** (`01`). Residual: 140 chars
is short for a substantive tweet, and the model may not naturally hit it — the
owner may need to trim. Accepted (shorter JA/ZH tweets are normal on X). **Verify
the cap holds** in a local smoke test before shipping (`01` build gate).

## R3 — Hallucinated / wrong-community hashtags

The model may emit a hashtag that *looks* right but isn't actually trending in
that community, or mix scripts (e.g. an English hashtag in a Japanese tweet).
Same trust posture as English today (the SYSTEM prompt already trusts the model
for "trending/topical tags"). Mitigations:

- Prompt explicitly says *"hashtags relevant to the {language}-speaking crypto
  community"* — nudges toward real conventions.
- Owner reviews before posting (R1).
- **Do not** add a trending-hashtag lookup outcall — that's X-API territory
  (same defer as published-tracking Q1); not worth it for v1.

## R4 — Persona × language composition edge cases

"Bridge Builder in Japanese" should draft *Japanese* tweets about Chain Fusion.
Risk: the model writes in English anyway, or translates the persona's English
idioms literally into nonsense. Mitigation: the prompt is explicit (*"Write every
draft in {language}"*) and the SYSTEM rule reinforces it. Smoke-test a couple of
persona×language combos before shipping (build gate). If a combo is consistently
bad, document it as "recommended pairings" rather than blocking.

## R5 — Upgrade safety for live farmer canisters

Adding `language` to `FarmerConfig` (StableCell, MemoryId 2) means existing farmer
canisters must tolerate the old bytes on reinstall. `#[serde(default)]` on the
new field (or `Option<String>`→`"en"`) handles it; `admin_reinstall_all_farmers`
(`lib.rs:19392`) pushes the wasm. **Gate:** reinstall one farmer locally, confirm
it deserializes and reports `language = "en"`, before mainnet. (Mainnet-deploy
gate still applies — X-Farm is not on mainnet yet, so this is currently
theoretical, but the reinstall path must be clean before it ever is.)

## Build gates (must be true before shipping)

- [ ] `.did` regenerated + `bindings/` updated; `tsc --noEmit` clean.
- [ ] Backend rejects unknown language codes (`BAD_LANGUAGE`).
- [ ] Proxy rejects unknown language codes (422) and defaults missing→`en`.
- [ ] Local smoke: create a farm in each of ES/ZH/JA, generate drafts, confirm
  output is in-language and ≤ the CJK cap where applicable.
- [ ] Local smoke: persona×language combos (e.g. Bridge Builder × JA) read
  naturally.
- [ ] Farmer-wasm reinstall round-trip on an existing farm → `language = "en"`,
  no deserialization error.
- [ ] `x_farm` flag still gates the new field path (feature stays dark until the
  flag flips).

## Open questions

### Q1 — Change language on an existing farm (renew-with-change)?
Language is set at create and fixed for the farm's life (matches `persona`). To
switch language, an owner currently must start a new farm. **Alternative:** let
`renew_farmer` (`lib.rs:19167`) also accept a new `language` (and optionally
`persona`), reinstalling the farmer wasm with the new config. **Recommendation:
defer.** Renew is a money-path (escrow + burn re-arm); overloading it with a
config change widens the blast radius. A new farm for a new language is cheap
and keeps the money path clean. Revisit if owners complain.

### Q2 — Show the `EN` chip on English farms?
`FarmerCard` shows a language chip only when non-`en`, or always (including
`EN`)? **Recommendation:** always show — consistency beats minimalism, and it
makes the feature visible/discoverable on English farms too.

### Q3 — Language as its own wizard step, or folded into persona?
A 5th step (`persona → language → tier → lifespan → pay`) vs. a `<select>` inside
the existing persona step (stays 4 steps). **Recommendation:** fold — language is
a single dropdown, not enough to justify its own step, and 4 steps already feels
right. The "Review & pay" summary row makes the choice visible regardless.

### Q4 — Localize the *persona preset descriptions* shown in the wizard?
They're currently English (e.g. *"Cross-chain diplomat — touts Chain Fusion…"*).
For a JA-speaking owner, the example-tweet grid and descriptions are still
English. **Recommendation:** leave as-is for v1 — the descriptions are short and
the owner picking a non-English *output* language is not necessarily a
non-English *reader*. Full UI localization is a separate, larger effort (noted in
`01` "Out of scope").