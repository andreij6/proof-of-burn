# X-Farm — Localization (target language & community)

> **Status: SCOPED, NOT BUILT.** Research + design only. Date: 2026-06-20.
> **Parent feature:** [X-Farm](../../src/frontend/src/XFarm.tsx) — **BUILT** (dark
> behind `x_farm` flag, not on mainnet). This is an additive enhancement — no
> change to the burn model or the proxy contract beyond one optional field.

## The gap

Every X-Farm draft is in English. But ICP's loudest, fastest-growing communities
are **not English** — Spanish (LatAm), Chinese, Japanese, Turkish, Portuguese
(Brazil) all have active CT clusters with their own trending hashtags and
dialects. An English-only farm can't reach them. Today a Spanish-speaking owner
who burns ICP gets English drafts back, which they then have to translate by hand
or just don't post.

## What this adds

A **per-farm target language**, set at creation in the persona wizard. The
language flows through to the Gemini proxy, which drafts in that language with
native, community-appropriate hashtags. The owner gets ready-to-post drafts in
the language their audience actually speaks.

- **Persona (the *voice*) stays decoupled from language (the *output tongue*).**
  You can be a *Bull* writing in Spanish, or a *Bridge Builder* writing in
  Japanese. This matches how the persona presets are written (they describe a
  stance, not a language).
- **Set once per farm** (same lifecycle as `persona` — chosen at create, fixed
  for the farm's life; a new language = a new farm, or renew with a change — see
  Q1).
- **Default English** — zero behavior change for existing farms and for owners
  who don't care.

## Why this is almost entirely reuse

- **The persona + prompt already flows end-to-end:** `Farmer.persona` →
  `FarmerInitArgs.persona` → `FarmerConfig.persona` → `TweetRequest.persona` →
  the proxy's `/v1/tweets` body → the Gemini user prompt. We thread **one more
  field** through the exact same pipe. No new transport, no new outcall, no new
  canister.
- **Proxy change is one optional field + two prompt lines** (`proxy/main.py:143`
  `/v1/tweets`): read `language` from the body; if present and non-`"en"`, append
  to the user prompt and extend `SYSTEM` to acknowledge multilingual output.
- **Frontend** reuses the persona-wizard step machinery — a dropdown is simpler
  than the persona card grid already there.
- **No money-path, timer, escrow, or stable-map change.** Language is a field on
  the existing `Farmer` struct (upgrade-safe as an `Option<String>`/default
  `"en"`).

**Net-new:** (1) one field on `Farmer` + `FarmerInitArgs` + `FarmerConfig` +
`TweetRequest`; (2) optional `language` in the `/v1/tweets` request + prompt tweak
in the proxy; (3) a language `<select>` in the wizard + a chip on `FarmerCard`.
**That's the whole feature.**

## Docs

- [01-design-and-ux.md](01-design-and-ux.md) — language set, model quality by
  language, hashtag handling, UX flow.
- [02-impl.md](02-impl.md) — struct/candid/field threading, proxy change, frontend
  touches, reuse map, upgrade safety.
- [03-risks-gates.md](03-risks-gates.md) — model quality variance, char limits
  for CJK, hallucinated hashtags, build gates, open questions.

## Sizing

**Low.** This is the smallest X-Farm enhancement — one field threaded through an
existing pipe + a prompt tweak + a dropdown. No new canister, no new stable map,
no money path. The only real risk is **model output quality in less-resourced
languages** (see `03-risks-gates.md`), which is a prompt/curation problem, not an
engineering one.