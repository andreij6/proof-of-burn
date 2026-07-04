---
type: idea
title: "02 — Implementation (backend + farmer wasm + proxy + frontend)"
tags: [ideas, x-farm-localization]
timestamp: 2026-06-20T01:26:49-04:00
---

# 02 — Implementation (backend + farmer wasm + proxy + frontend)

Line numbers approximate (2026-06-20) — verify before building. The
`backend-canister-dev`, `cloud-run-proxy`, and `frontend-dev` skills cover the
mechanics.

## The field, threaded through the existing pipe

One new field, `language: String`, rides the exact same path `persona` already
rides. No new transport, no new outcall, no new canister.

```
Farmer.language  (backend, lib.rs:86)
  └─ FarmerInitArgs.language   (lib.rs:148)        ── create_farmer passes it in
       └─ FarmerConfig.language (farmer wasm, lib.rs:82)  ── init() stores it
            └─ TweetRequest.language (farmer wasm, lib.rs:312) ── generate_drafts sends it
                 └─ /v1/tweets body "language"  (proxy, main.py:143)
                      └─ Gemini user prompt + SYSTEM tweak
```

## Backend (`src/backend/src/lib.rs`)

### `Farmer` struct (`lib.rs:86`)
Add:
```rust
pub language: String,   // "en" | "es" | "zh" | "ja" | "tr" | "pt" — "" or "en" = English
```

### `FarmerInitArgs` (`lib.rs:148`)
Add `pub language: String`.

### `create_farmer` (`lib.rs:18977`)
- Accept `language: String`; validate against an allowlist `["en","es","zh","ja","tr","pt"]`
  (reject others → `BAD_LANGUAGE`). Default `"en"` if empty.
- Pass into `FarmerInitArgs` when installing the farmer wasm (alongside
  `persona`).
- Store on the `Farmer` record.

### `admin_set_xfarm_tiers` / config — no change
Language is per-farm, not per-tier or per-config. No `XFarmConfig` change.

### Candid sync
Add `language: text` to `Farmer` and `farmer_init_args`, and a `language: text`
param to `create_farmer`. Regenerate `bindings/` (the `backend-canister-dev`
skill). Existing calls default the new field (see Upgrade safety below).

## Farmer wasm (`src/xfarm_farmer/src/lib.rs`)

### `FarmerConfig` (`:82`) + `FarmerInitArgs` (`:107`)
Add `pub language: String` to both. `init()` (`:265`) stores it into the config;
`placeholder_config()` (`:166`) sets `"en"`.

### `TweetRequest` (`:312`)
Add `language: &'a str` to the serialized request (it already has
`drafts_per_day`, `persona`, `history`, `caller_id`).

### `generate_drafts` (`:348`)
Set `language: &cfg.language` on the `TweetRequest`. Nothing else changes — the
HTTPS-outcall shape, deadline (`OUTCALL_TIMEOUT_SECS`), and cycle cost are
identical (the prompt is a few bytes longer).

### Upgrade safety
`FarmerConfig` is stored in a `StableCell` (`MemoryId::new(2)`, `:159`). Adding a
field to a `StableCell`-stored struct requires the post-upgrade deserializer to
tolerate the old (field-less) bytes. **Use `#[serde(default)]` on the new
`language` field** (or an `Option<String>` mapped to `"en"`) so existing farmer
canisters deserialize on reinstall. The `admin_reinstall_all_farmers` endpoint
(`lib.rs:19392`) already exists to push the new wasm to live farmers — re-run it
after deploying the upgraded farmer wasm. Existing farmers come back as
`language = "en"`.

## Proxy (`proxy/main.py`)

### `/v1/tweets` (`:143`)
Read the optional field:
```python
language = str(body.get("language", "en")).strip().lower() or "en"
```
Allowlist it (reject unknown → 422, same shape as the `persona` required check):
```python
LANGS = {"en", "es", "zh", "ja", "tr", "pt"}
if language not in LANGS:
    raise HTTPException(status_code=422, detail=f"unsupported language: {language}")
```

### Prompt composition
Append to the user prompt (after the existing PERSONA/HISTORY lines, `:162`):
```python
lang_name = {"en":"English","es":"Spanish","zh":"Chinese","ja":"Japanese","tr":"Turkish","pt":"Portuguese"}[language]
prompt += f"\nWrite every draft in {lang_name}. Use 1-3 hashtags relevant to the {lang_name}-speaking crypto community; always include $ICP."
```

### `SYSTEM` (`:71`) tweak
Add one sentence so the model honors it as a standing rule:
> *"If the user message specifies a language, write all drafts in that language
> (hashtags in that language's community conventions); the $ICP cashtag is always
> required regardless of language."*

### Char cap by script
`SYSTEM` currently says *"≤ 280 chars each."* Replace with a language-aware cap
computed in the endpoint and injected into the prompt:
```python
char_cap = 140 if language in ("zh", "ja") else 280
prompt += f"\nEach draft MUST be <= {char_cap} characters (X weights CJK chars doubly)."
```
(Keep it simple: char count, not full Twitter weight — close enough and matches
the existing English approach.)

## Frontend (`src/frontend/src/XFarm.tsx`)

### Curated language list
```ts
const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'tr', label: 'Turkish' },
  { code: 'pt', label: 'Portuguese' },
];
```

### Wizard — language step
- New `WizardStep` value `'language'` (between `'persona'` and `'tier'`), **or**
  fold the `<select>` into the persona step (cheaper — one step, two controls).
  Recommendation: fold (keeps the wizard at 4 steps — see Q3).
- New state `language: string` (default `'en'`), passed to `create_farmer`.

### `create_farmer` call (`XFarm.tsx:257`)
Pass `language` as the new arg.

### `FarmerCard`
- Show a `Chip tone="muted"` with the language label next to the persona line
  (`XFarm.tsx:775`): `persona: Bull · Spanish`. Hide if `en` (or show always —
  Q2).

### Pay-step summary
Add a `Language:` row to the review card (`XFarm.tsx:502`).

## Reuse map

| Need | Reuse | Where |
|---|---|---|
| Field pipe to proxy | `persona`'s exact path | `lib.rs:18977` → `xfarm_farmer/lib.rs:348` → `proxy/main.py:143` |
| Validated input + `Err` string | `persona` length/`BAD_PERSONA` pattern | `lib.rs:18994` |
| Push new wasm to live farmers | `admin_reinstall_all_farmers` | `lib.rs:19392` |
| StableCell upgrade tolerance | `#[serde(default)]` pattern (used elsewhere for config growth) | `xfarm_farmer/lib.rs:159` |
| Wizard step machinery | existing `WizardStep` + `selectCardStyle` | `XFarm.tsx:144` |
| UI chip | `Chip` | `ui.tsx` |

## Net-new (no precedent in the repo)

- The `language` field on 3 structs + 1 request body + 1 proxy param. Nothing
  else — no new canister, stable map, timer, escrow leg, or outcall.

## MemoryId budget

**None new.** `language` is a field on the existing `Farmer` (backend MemoryId 54)
and the existing farmer-wasm `FarmerConfig` (MemoryId 2). The farmer-wasm
`StableCell` + `#[serde(default)]` handles the upgrade in place.