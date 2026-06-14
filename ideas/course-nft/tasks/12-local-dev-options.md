# Course NFT — Local Dev Options (PB-312)

> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md) first.
> Depends on **PB-305** (marketplace + `COURSE_LISTINGS`, MemoryId 77), **PB-307**
> (secondary market / `for_sale` + `price_e8s` on the listing) and **PB-308**
> (`FEATURED_SLOT`, MemoryId 78). Touches the course_nft canister's
> minter-gated surface (`mint` / `custodial_transfer` / `bump_play_count`) defined
> in **PB-301**, and (when present) `FAVORITE_COURSES` (MemoryId 86, PB-311).
>
> **This spec adds no production behaviour.** Every endpoint here is hard-gated by
> `require_local_dev()` and admin-gated, surfaced only in the **Dashboard &
> Controls** panel on the Course Marketplace page. None of it is reachable on
> mainnet or staging — `inspect_message` blocks anonymous ingress and
> `require_local_dev()` traps when `is_local == false` or the canister is wired to
> the mainnet ICP ledger.

---

## A. Design / UX / purpose

### A1. Why this exists

The Course NFT feature has many *visual states* a developer wants to eyeball
while iterating on the marketplace, the card, and the editor — but most of those
states are expensive or impossible to reach by hand locally (you'd have to mint
real courses with real burns, run a second identity to buy one, grind plays to
bump `play_count`, place a real ck-token featured bid, etc.). PB-312 gives the
developer **one-click ways to put the feature into each interesting state** so the
UI can be reviewed against real data shapes:

| State to visualise | What you want to see | Dev option |
|---|---|---|
| Busy marketplace | a full, varied grid (themes, difficulties, prices, owners) | `dev_seed_courses` |
| Empty marketplace | the empty state / "be the first" CTA | `dev_clear_courses` |
| A course **for sale** | the `For sale` chip + price line + **Buy** button | `dev_set_course_sale(id, opt price)` |
| A course **not for sale** | the muted "Not for sale" line, no Buy button | `dev_set_course_sale(id, null)` |
| Owned **by someone else** | "owned by {other}" line + Buy enabled | `dev_simulate_sale(id, buyer)` |
| Owned **by me** | "My courses" filter, **Manage** controls, Buy disabled "You own this" | `dev_give_course(id)` |
| A **popular** course | a big `play_count` chip + "N tickets earned" | `dev_set_play_count(id, n)` |
| A **featured** course | the pinned full-width card + Featured badge + "to beat" line | `dev_set_featured(id)` |
| No featured slot | the disabled "Feature your course (coming soon)" strip | `dev_clear_featured` |
| A **favourited** course | the favourite affordance lit + "My favourites" filter (PB-311) | `dev_grant_favorite(id)` |

### A2. Design principles (decisions)

- **Local-only, admin-gated, no mainnet surface.** Every endpoint calls
  `require_authenticated()` + `require_local_dev()`; the panel only renders when
  `config.is_local`. `require_local_dev()` already double-guards on the mainnet
  ICP ledger principal, so even a mis-seeded "local" config pointed at the real
  ledger is refused. These are *additional* to the arcade flag — a dev option must
  not depend on `arcade_minigolf` being on (you may want to seed state *before*
  flipping the flag), so the dev endpoints **do not** call
  `require_arcade_game_enabled` (unlike the production marketplace endpoints).
- **Reuse the real code paths.** Wherever a production path exists, the dev option
  routes through it so *what you visualise matches production behaviour*:
  - seeding a course mints via the **same** `course_nft.mint` + writes a
    `COURSE_LISTINGS` row with the **same** cached-field shape PB-304's real mint
    writes (so the card/query reads identical data);
  - "selling" to a mock owner uses the **same** `course_nft.custodial_transfer`
    the buy saga uses (and then `refresh_course_listing` reconciles the cache);
  - listing for sale sets the **same** `for_sale` / `price_e8s` fields
    `list_course_for_sale` sets;
  - featuring writes the **same** `FEATURED_SLOT` cell `bid_featured_slot` writes.
  The only thing dev options skip is the **money** (burns, ICRC-2 approves,
  ck-token bids, CMC top-ups) — they mutate state directly, never moving funds.
  This is the same trade the existing `dev_grant_lottery_tickets` /
  `dev_add_mock_maturity` make.
- **Mock principals are deterministic & self-describing.** Seeded "other owners"
  are derived from a fixed seed (`mock_principal(n)`), so a re-seed is
  reproducible and the same mock owner renders the same username every run.
- **Idempotent / safe to spam.** Re-running a seed is bounded (it tops up toward a
  target count rather than minting unboundedly); setters overwrite. Nothing here
  panics on a missing token — they return a `Result` `Err` string instead.
- **Mirror how Lottery/Staking/Admin register dev controls.** The panel section is
  registered with `usePageDevControls(isLocal, () => …, [deps])` exactly like
  `Lottery.tsx:132` and `Staking.tsx:275` (`Btn variant="secondary" sm`, a small
  section label, busy `LiveDot`, a one-line explainer) so it looks native.

---

## B. Implementation — backend

All endpoints land in `src/backend/src/lib.rs` under the existing
`// ===== 20. Course NFT marketplace =====` banner, in a clearly-fenced
**`// --- 20.x Local-dev visualisation helpers (require_local_dev) ---`**
sub-section so they're easy to find and easy to keep out of any candid that ships
to mainnet review. They are exposed in `backend.did` like the other `dev_*`
methods already are (the candid is identical local & prod; the *guard* is what
makes them inert in prod — same as `dev_run_lottery_draw` etc.).

Shared helper (host-testable, no inter-canister call off-wasm):

```rust
/// Deterministic, reproducible mock principal for seeded owners/buyers.
/// Self-derived from a small seed so the same n always renders the same
/// username in the UI. Never an admin, never the caller.
fn mock_principal(n: u8) -> Principal {
    Principal::from_slice(&[0xDE, 0xAD, 0xBE, 0xEF, n])
}
```

The dev endpoints reuse the existing course_nft seam used elsewhere in section 20
(the inter-canister calls to `mint` / `custodial_transfer` / `bump_play_count` /
`icrc7_owner_of`, which are no-ops / mockable off-wasm just like
`course_nft_owner_of`), plus the listing-cache writer that PB-304's real mint
uses, so a seeded course is indistinguishable from a really-minted one in the
query.

### B1. `dev_seed_courses(count)` — populate a busy marketplace

```rust
/// Local-dev: mint up to `count` varied courses so the marketplace grid renders
/// busy. Tops up toward `count` (idempotent-ish): mints only the shortfall vs.
/// the courses that already exist, so re-running doesn't pile up. Varies theme
/// (Desert/Ocean/Space/Forest/Custom), difficulty (par buckets Easy/Medium/Hard),
/// owner (some `caller`, some `mock_principal(n)`), for-sale state + price, and
/// play_count. Returns the number actually minted.
#[ic_cdk::update]
async fn dev_seed_courses(count: u32) -> Result<u32, String> {
    require_authenticated()?;
    require_local_dev()?;
    // bound the request so a fat-finger can't mint thousands
    let count = count.min(DEV_MAX_SEED_COURSES); // e.g. 60
    // for i in existing_len..count:
    //   - build a tiny valid CourseDataV1 blob (9 holes, par tuned into the
    //     target difficulty bucket) — reuse the editor's default-course builder
    //     / a const DEV_SAMPLE_COURSE template per theme.
    //   - to    = if i % 3 == 0 { caller } else { mock_principal((i % 7) as u8) }
    //   - creator = caller (so royalties/owner-vs-creator lines are visible)
    //   - course_nft.mint(MintArgs{ to, name, creator, course_data, par_total, mint_fee_e8s: 50_000_000 })
    //   - seed COURSE_LISTINGS row with the SAME cached shape PB-304 writes:
    //       owner, creator, play_count, par_total, theme, created_at, mint_fee_e8s,
    //       listed=true; for_sale + price_e8s varied (≈⅓ for sale at 0.1–25 ICP).
    //   - vary play_count (some 0, some hundreds) via bump_play_count + cache.
}
```

- **Guard:** `require_authenticated` + `require_local_dev`. (No arcade-flag gate —
  you seed before flipping the flag.)
- **Maps touched:** `course_nft.TOKENS`/`OWNER_TOKENS` (via `mint`), backend
  `COURSE_LISTINGS` (MemoryId 77). Reuses the real `mint` + the real cache writer.
- **Candid:** `dev_seed_courses : (nat32) -> (Result_1);` where
  `Result_1 = variant { Ok : nat32; Err : text }` (reuse if it exists, else add).

### B2. `dev_set_course_sale(token_id, opt price_e8s)` — force the Buy/for-sale state

```rust
/// Local-dev: force a course's for-sale state without an owner approve flow.
/// Some(price) => for_sale=true, price_e8s=price (visualise the Buy button +
/// price line). None => for_sale=false, price_e8s=0 (visualise "Not for sale").
/// Writes the SAME listing fields list_course_for_sale / delist_course set, so
/// the card renders exactly as it would in production.
#[ic_cdk::update]
fn dev_set_course_sale(token_id: u64, price_e8s: Option<u64>) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    // load COURSE_LISTINGS row or Err("NO_COURSE");
    // match price_e8s { Some(p) => { for_sale=true; price_e8s=p } None => { for_sale=false; price_e8s=0 } }
    // persist row.
}
```

- **Maps touched:** `COURSE_LISTINGS` (MemoryId 77) `for_sale` / `price_e8s`
  (PB-307 fields). Same write the production list/delist performs — no money.
- **Candid:** `dev_set_course_sale : (nat64, opt nat64) -> (Result);`

### B3. `dev_simulate_sale(token_id, buyer)` / `dev_give_course(token_id)` — owner state

```rust
/// Local-dev: move a token to a mock owner (visualise "owned by someone else":
/// the "owned by {other}" line, Buy enabled, Manage hidden). Routes through the
/// SAME custodial_transfer the buy saga uses; no funds move, no split is paid.
#[ic_cdk::update]
async fn dev_simulate_sale(token_id: u64, buyer: Principal) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    // course_nft.custodial_transfer(token_id, buyer)  (real path)
    // refresh_course_listing(token_id)  -> reconcile cached owner (real path)
}

/// Local-dev: give the token to the caller (visualise "owned by me": Manage
/// controls, "My courses" filter, Buy disabled "You own this"). Convenience
/// wrapper over dev_simulate_sale(token_id, caller).
#[ic_cdk::update]
async fn dev_give_course(token_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    let me = get_caller();
    dev_simulate_sale_inner(token_id, me).await
}
```

- A no-arg-principal convenience: the panel passes either the caller (Give to me)
  or a `mock_principal(n)` ("Sell to someone else"). `dev_simulate_sale` accepts an
  arbitrary `buyer` so a dev can hand it to a specific test identity too.
- **Maps touched:** `course_nft.TOKENS`/`OWNER_TOKENS` (via `custodial_transfer`),
  then `COURSE_LISTINGS.owner` via `refresh_course_listing` — exactly the
  reconciliation the real buy saga relies on, so the cache can't drift.
- **Candid:** `dev_simulate_sale : (nat64, principal) -> (Result);` /
  `dev_give_course : (nat64) -> (Result);`

### B4. `dev_set_play_count(token_id, n)` — visualise a popular course

```rust
/// Local-dev: set a course's play_count (and a proportional tickets_distributed)
/// so the card shows a "popular" course. Writes both the authoritative count on
/// course_nft (via bump_play_count, computing the delta to reach n) AND the
/// cached play_count on the listing so the query reflects it without a refresh.
#[ic_cdk::update]
async fn dev_set_play_count(token_id: u64, n: u64) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    // delta = n.saturating_sub(current); course_nft.bump_play_count(token_id, delta)
    // set COURSE_LISTINGS.play_count = n; optionally tickets_distributed ≈ n/2 (cosmetic).
}
```

- **Maps touched:** `course_nft.TOKENS.play_count` (via `bump_play_count`, real
  path), `COURSE_LISTINGS.play_count` / `tickets_distributed` cache.
- **Candid:** `dev_set_play_count : (nat64, nat64) -> (Result);`

### B5. `dev_set_featured(token_id)` / `dev_clear_featured` — visualise the featured slot

```rust
/// Local-dev: pin a course in the featured slot WITHOUT a real ck-token bid.
/// Writes the SAME FeaturedSlot cell bid_featured_slot writes, so the pinned card
/// + "to beat" line render exactly as production. Uses a plausible mock USD value.
#[ic_cdk::update]
fn dev_set_featured(token_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    // require the course exists + listed in COURSE_LISTINGS (NOT_LISTABLE otherwise),
    // matching bid_featured_slot's precondition.
    // FEATURED_SLOT.set(Some(FeaturedSlot{
    //   token_id, bidder: get_caller(), token: ExplorerToken::CkUSDC,
    //   amount: 50_000_000 /*50 ckUSDC*/, usd_value_e8s: 50 * 100_000_000, at: current_time(),
    // }))
}

/// Local-dev: vacate the featured slot (visualise the "Feature your course
/// (coming soon)" strip). Same effect as admin_clear_featured_slot, but
/// require_local_dev-gated so it shows in the dev panel alongside the setter.
#[ic_cdk::update]
fn dev_clear_featured() -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    FEATURED_SLOT.with(|c| c.borrow_mut().set(None));
    Ok(())
}
```

- **Maps touched:** `FEATURED_SLOT` (MemoryId 78, PB-308). Reuses the exact cell
  + record shape; no ck-token ledger / XRC call.
- **Candid:** `dev_set_featured : (nat64) -> (Result);` /
  `dev_clear_featured : () -> (Result);`

### B6. `dev_grant_favorite(token_id)` — visualise favourites (PB-311)

```rust
/// Local-dev: add a course to the caller's favourites so the favourite affordance
/// lights up and the "My favourites" filter is non-empty. Writes the SAME
/// FAVORITE_COURSES list the real toggle writes (capped, dedup). No-op if PB-311
/// isn't built yet — guarded behind cfg/feature presence; otherwise routes through
/// the production favourite-add path.
#[ic_cdk::update]
fn dev_grant_favorite(token_id: u64) -> Result<(), String> {
    require_authenticated()?;
    require_local_dev()?;
    // FAVORITE_COURSES (MemoryId 86): upsert FavoriteList for caller, push token_id
    // (dedup + respect the cap), reusing PB-311's add helper if present.
}
```

- **Maps touched:** `FAVORITE_COURSES` (MemoryId 86, PB-311). Ships with PB-311;
  until then this endpoint is omitted (the panel button is simply absent).
- **Candid:** `dev_grant_favorite : (nat64) -> (Result);`

### B7. `dev_clear_courses` — reset to empty / just-default

```rust
/// Local-dev: wipe all course listings + featured slot (and the seeded tokens on
/// course_nft) so the marketplace shows its empty state. Resets to "just the
/// default/system course" if PB-309 seeds one; otherwise fully empty.
#[ic_cdk::update]
async fn dev_clear_courses() -> Result<u64, String> {
    require_authenticated()?;
    require_local_dev()?;
    // collect token_ids from COURSE_LISTINGS; clear the map; FEATURED_SLOT.set(None).
    // course_nft side: call a course_nft dev_clear (require_local_dev on that crate
    // too) OR burn/transfer-to-anon each seeded token; document the chosen reset.
    // Returns how many listings were removed.
}
```

- **Maps touched:** `COURSE_LISTINGS` (77), `FEATURED_SLOT` (78), and the
  course_nft `TOKENS`/`OWNER_TOKENS` via a matching **`dev_clear` on the course_nft
  crate** (also `require_local_dev`-gated there — mirror this crate's guard, since
  there's no production "burn all" path). `COURSE_SALES` (84) sale journals and
  `FAVORITE_COURSES` (86) for removed tokens are cleared too so no stale rows
  dangle.
- **Candid:** `dev_clear_courses : () -> (Result_1);`

### B8. course_nft crate companion (only for `dev_clear_courses`)

Add a single `#[ic_cdk::update(guard = "require_minter")]` (or a local-dev guard
mirroring the backend's `require_local_dev`) `dev_clear() -> u64` on the course_nft
crate that drains `TOKENS` + `OWNER_TOKENS` and resets `NEXT_TOKEN_ID` to 0. This
is the only course_nft change PB-312 needs; everything else reuses the existing
minter-gated `mint`/`custodial_transfer`/`bump_play_count`. Gate it so it cannot
run against the deployed mainnet collection (the collection has no admin burn in
production — D2).

---

## C. Implementation — frontend

A single **"Course NFT — local dev"** section in the Dashboard & Controls panel,
registered from the marketplace page (`CourseMarketplace.tsx`) via
`usePageDevControls`, mirroring `Lottery.tsx` / `Staking.tsx` / `Admin.tsx`:

```tsx
// In CourseMarketplace.tsx — only shows on local mode, like Lottery/Staking.
usePageDevControls(isLocal && signedIn, () => (
  <div className="col" style={{ gap: 8 }}>
    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>
      Course NFT · marketplace states
    </span>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <Btn variant="secondary" sm onClick={() => handleSeed(12)} disabled={busy !== null}>
        {busy === 'seed' ? <LiveDot size={7} /> : <Icon name="flag" size={13} />} Seed 12 courses
      </Btn>
      <Btn variant="secondary" sm onClick={handleClearAll} disabled={busy !== null}>
        {busy === 'clear' ? <LiveDot size={7} /> : <Icon name="x" size={13} />} Clear all (empty state)
      </Btn>
    </div>
    {/* per-course controls operate on the focused/selected card's token_id: */}
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <input /* token_id */ /> <input /* price ICP */ />
      <Btn variant="secondary" sm onClick={handleSetSale}     disabled={busy !== null}>For sale @ price</Btn>
      <Btn variant="secondary" sm onClick={handleUnlist}      disabled={busy !== null}>Not for sale</Btn>
      <Btn variant="secondary" sm onClick={handleGiveToMe}    disabled={busy !== null}>Give to me</Btn>
      <Btn variant="secondary" sm onClick={handleSellToMock}  disabled={busy !== null}>Sell to someone</Btn>
      <input /* play count */ />
      <Btn variant="secondary" sm onClick={handleSetPlays}    disabled={busy !== null}>Set play count</Btn>
      <Btn variant="secondary" sm onClick={handleFeature}     disabled={busy !== null}>Feature this</Btn>
      <Btn variant="secondary" sm onClick={handleClearFeat}   disabled={busy !== null}>Clear featured</Btn>
      <Btn variant="secondary" sm onClick={handleFavorite}    disabled={busy !== null}>Favourite this</Btn>
    </div>
    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
      Local only. Mutates marketplace state directly (no burns / approves / bids)
      so you can eyeball each card state. Re-seed tops up to the target count.
    </span>
  </div>
), [busy, focusedTokenId]);
```

Conventions to follow (from the overview §6 + the existing panels):
- **`isLocal` gate:** the hook's `enabled` arg is `isLocal && signedIn`; the section
  never renders on mainnet. `isLocal` comes from `config.is_local` (already plumbed
  to the page props like every other page).
- **Busy/disabled:** a single `busy` state string (like Lottery's) disables every
  button mid-call and swaps the leading icon for `<LiveDot />`; on `Err` show the
  `res.Err` text in the page's existing error banner; on success refresh the
  marketplace query (and `refresh_course_listing` opportunistically).
- **Candid opt decoding:** `dev_set_course_sale` takes `opt nat64` — encode "for
  sale" as `[priceE8s]` and "not for sale" as `[]`, and read any returned `opt`/
  `Result` via the `{__kind__}` wrapper (the frontend-dev opt-decoding trap).
- **Token target:** per-course buttons act on a `focusedTokenId` (the card the dev
  clicked "dev" on, or a small token_id input) so a dev can target any card.
- Reuse `parseTokenAmount` for the ICP price input → e8s, like the Manage modal.

No production component changes: the dev panel is additive and self-contained;
the marketplace card/query already render the states these endpoints produce.

---

## D. Acceptance criteria

- Every `dev_*` endpoint rejects with `DEV_ONLY` when `config.is_local == false`
  (and when wired to the mainnet ICP ledger), and rejects anonymous callers
  (`inspect_message`).
- The dev panel section renders **only** when `config.is_local`, on the Course
  Marketplace page, inside the Dashboard & Controls panel — and is absent on
  mainnet/staging builds.
- `dev_seed_courses(n)` produces a varied, bounded set: mix of themes,
  difficulties, owners (some me / some mock), for-sale states + prices, and
  play_counts; re-running tops up toward `n` rather than duplicating; the
  marketplace query returns them with the exact card shape a real mint produces.
- `dev_clear_courses` empties the grid (or leaves just the default course) and
  vacates the featured slot; the empty-state CTA shows.
- `dev_set_course_sale(id, Some(p))` makes the card show `For sale` + price + Buy;
  `None` shows "Not for sale" and hides Buy.
- `dev_simulate_sale` / `dev_give_course` flip the rendered owner (mine vs someone
  else's) and the Manage/Buy affordances accordingly, with the listing cache
  reconciled to the authoritative owner.
- `dev_set_play_count(id, n)` shows a popular course (`play_count` chip = n) on
  both the card and the authoritative course_nft token.
- `dev_set_featured(id)` pins the card with the badge + "to beat" line;
  `dev_clear_featured` shows the "coming soon" strip.
- `dev_grant_favorite(id)` (when PB-311 is present) lights the favourite affordance
  and populates "My favourites".

## E. Test plan

- **Unit (`cargo test -p backend --lib`):**
  - **Guard tests (the critical ones):** with `is_local=false`, each `dev_*`
    endpoint returns `Err("DEV_ONLY")` and mutates **nothing** (assert
    `COURSE_LISTINGS` / `FEATURED_SLOT` unchanged after the call). With the config's
    ledger set to the mainnet principal, same rejection even if `is_local=true`.
    Mirror the existing `require_local_dev` guard tests.
  - **State-mutation correctness** (with `is_local=true` + the off-wasm course_nft
    mock seam): `dev_seed_courses(5)` yields 5 listing rows with varied
    theme/par/for_sale; a second `dev_seed_courses(5)` mints 0 (top-up is bounded);
    `dev_set_course_sale` toggles `for_sale`/`price_e8s`; `dev_set_play_count` sets
    the cached count and computes the right `bump_play_count` delta;
    `dev_set_featured` writes a `FeaturedSlot` whose `token_id` matches and
    `dev_clear_featured` resets the cell to `None`; `dev_simulate_sale` updates the
    cached owner via the mocked `course_nft_owner_of`; `dev_clear_courses` empties
    both maps and returns the removed count.
  - `mock_principal(n)` is deterministic and never equals the caller or an admin.
- **course_nft (`cargo test -p course_nft`):** `dev_clear()` drains tokens +
  indices and resets `NEXT_TOKEN_ID`; it rejects off the minter/local guard.
- **No-mainnet-exposure check:** a test asserts `require_local_dev` precedes any
  mutation in each endpoint (call with `is_local=false` and assert untouched state,
  per above); `inspect_message` rejects anonymous ingress for these methods (they
  are not in the anonymous-allow list — only `wallet_receive` is).
- **Frontend (`cd src/frontend && npx tsc -b && npx vitest run`):** the dev section
  renders only when `isLocal`; buttons disable on `busy`; `opt nat64` encodes
  `[]` vs `[price]` correctly; an `Err` surfaces in the banner.
- **Manual local (`bash scripts/deploy-local.sh`, `.claude/skills/icp-local-deploy`):**
  open the marketplace, `dev_become_admin`, open Dashboard & Controls → "Seed 12
  courses" → grid fills; toggle one card for-sale/owned-by-me/popular/featured and
  eyeball each state; "Clear all" → empty state; confirm none of the buttons exist
  in a mainnet/staging build.

## F. Out of scope

- Any production marketplace behaviour (mint/buy/bid/list/rate/play) — owned by
  PB-304/305/306/307/308/310. PB-312 only *visualises* the states they produce.
- Moving real funds (burns, ICRC-2 approves, ck-token bids, CMC top-ups) — dev
  options mutate state directly and never touch a ledger.
- Anti-cheat / play-session seeding beyond a cosmetic `play_count` /
  `tickets_distributed` bump (real session seeding, if needed for PB-310 ratings
  gating, belongs to a PB-306 dev helper, not here).
- A general admin moderation surface (`admin_clear_featured_slot`,
  `admin_remove_rating` are production admin tools defined in their own specs).

## G. Dependencies

- **PB-305** — `COURSE_LISTINGS` (MemoryId 77), the marketplace page + card +
  query the dev options populate; `refresh_course_listing`; the `is_local` page
  prop.
- **PB-307** — the `for_sale` / `price_e8s` listing fields and `COURSE_SALES`
  journal that `dev_set_course_sale` / `dev_clear_courses` touch.
- **PB-308** — `FEATURED_SLOT` (MemoryId 78) + `FeaturedSlot` shape that
  `dev_set_featured` / `dev_clear_featured` write.
- **PB-301** — course_nft `mint` / `custodial_transfer` / `bump_play_count` /
  `icrc7_owner_of` (reused by the seeders); a small `dev_clear()` added to the
  crate for the reset.
- **PB-311** — `FAVORITE_COURSES` (MemoryId 86) for `dev_grant_favorite` (omitted
  until PB-311 ships).
- Reuses existing repo machinery: `require_local_dev`, `require_authenticated`,
  `usePageDevControls` (`ui.tsx`), the Dashboard & Controls panel (`App.tsx`), and
  the `dev_*` endpoint conventions (`dev_grant_lottery_tickets` /
  `dev_add_mock_maturity` / `dev_seed_payouts`).
