---
name: add-explorer-dapp
description: Add a new dapp/project to the Dapp Explorer's curated default directory. Use when asked to "add <site> to the explorer", "list this dapp on the explorer page", or otherwise add a project card to the explorer. Covers characterizing the dapp, editing the seed in lib.rs, the Twitter handle, building, deploying locally, and verifying.
---

# Add a dapp to the Explorer default directory

The Explorer's curated cards come from `seed_default_dapps()` in
`src/backend/src/lib.rs`. Adding a dapp = appending one entry to that seed and a
verified Twitter handle. The seed re-runs on `init` and `post_upgrade`; it
**skips dapps that already exist by name and backfills** missing categories /
twitter — so re-deploying only adds the new one.

## Steps

### 1. Characterize the dapp (accurately — don't fabricate)
- Fetch the URL (`WebFetch`). Many ICP dapps are client-rendered SPAs that show
  only "Loading…" — if so, **search** instead (`WebSearch`: the project name +
  "Internet Computer", the DFINITY forum, dappradar) to learn what it does and
  **confirm it's actually on ICP**.
- Decide:
  - **name** — the product's real name.
  - **url** — the canonical site (https).
  - **description** — 1–2 sentences, **≤ 280 chars**. If you can't verify
    features (SPA, no info), write a modest line like the existing "Dyvr" entry
    ("Emerging Internet Computer dapp — visit the site for the latest…"). Do not
    invent specific features.
  - **categories** — 1–3 from `DAPP_CATEGORIES` (`lib.rs`): DeFi, DEX, Wallet,
    NFT, Gaming, Social, DAO, AI, Analytics, Infrastructure, Marketplace.

### 2. Add the seed entry (`src/backend/src/lib.rs`, `seed_default_dapps`)
- Bump the array length: `let samples: [(&str, &str, &str, &[&str]); N] = [` → `N+1`.
- Append a tuple before the closing `];`:
  ```rust
  (
      "Name",
      "https://example.com/",
      "Short, honest, ≤280-char description.",
      &["Category", "Category2"],
  ),
  ```

### 3. Twitter handle (`seed_twitter` in `lib.rs`)
- If you can find/verify the project's **X/Twitter handle**, add a match arm
  (handle **without** the leading `@`):
  ```rust
  "Name" => "theirhandle",
  ```
- **Verified handles only.** If you can't confirm it, leave it out (the card
  simply shows no handle) — a wrong handle links to the wrong/empty account.
- Already-seeded dapps get the handle backfilled on the next deploy.

### 4. Build, deploy local, verify
```bash
cd src/backend && cargo check          # must compile (array length must match)
cd ../.. && icp deploy backend -e local --identity agent-tester --yes
icp canister call backend list_dapps '()' -e local --identity dev1 | grep -i "Name"
```
The candid `DappListing` already includes `twitter : opt text` and `categories`,
so no `.did` change is needed just to add a dapp (only if you change the struct).

### 5. Commit
Commit `src/backend/src/lib.rs` (and `.did` if the struct changed). Per the
project's standing rule, **deploy to LOCAL freely but NEVER to mainnet
(`-e production`/`-e staging`) without an explicit per-deploy ask** — see the
mainnet-deploy-gate. git push is fine.

## Notes
- Cards no longer show an "added" date; the footer shows the `@handle` link (or
  nothing) on the left and the Visit button on the right.
- Community (paid) submissions come through `submit_dapp` and are admin-approved
  separately — this skill is for **curated defaults** only.
- Max curated/total listings is bounded by `MAX_DAPPS`.
