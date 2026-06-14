# Course NFT — Ratings & Reviews (PB-310, Phase 3)

> Read [`00-overview-and-architecture.md`](00-overview-and-architecture.md) first.
> Depends on **PB-305** (marketplace + `COURSE_LISTINGS`) and **PB-306** (play
> sessions, for the "completed a round" gate). Uses `COURSE_RATINGS`
> (MemoryId 81), already allocated to this spec in the overview. Smallest Phase-3
> feature — keep it lean.

---

## A. Design / UX / behaviour

### A1. Goal

Let players leave a lightweight signal of course quality on each marketplace card so
buyers/players have something beyond raw play count. One rating per user per course:
**1–5 stars + an optional short text review.** Aggregate (average + count) shows on the
card and detail view. This is a quality signal, not a social network — no threads,
replies, votes, or moderation queue.

### A2. Who may rate (decision + justification)

**Only users who have completed a full 9-hole round of the course may rate it**, gated
behind **Tier 2+** (signed-in). Justification:

- Leverages PB-306's signed play sessions: round completion is already recorded
  (the player-ticket trigger fires on full 9-hole completion). Reusing that record makes
  "completed a round" a free, already-trusted fact — no new anti-cheat surface.
- Requiring completion makes ratings expensive to farm (you must actually play the whole
  course), which is the cheapest effective anti-Sybil measure for a low-stakes feature.
- Tier 2+ matches the player-ticket gate already in PB-306, so the eligibility rule is
  identical to "could you have earned a player ticket here?" — easy to reason about.

The check: the user has at least one PB-306 session for `token_id` with
`completed_all_9 == true` (or equivalent completion flag). Define a small read helper in
PB-306's module (`has_completed_round(player, token_id) -> bool`) so this spec consumes a
clean predicate rather than reaching into session internals.

### A3. Anti-abuse rules (decisions)

- **One rating per (user, course).** Enforced by the `(token_id, Principal)` composite key.
- **Edit-in-place.** Re-rating the same course overwrites the existing row (updates stars/
  text/timestamp). No history, no extra row. This keeps aggregates simple (recompute, or
  maintain running sums — see B2) and lets users correct a rating.
- **No self-rating.** The course's `creator` (immutable, from NFT metadata) **and** the
  current owner may **not** rate it — prevents authors/owners juicing their own listing.
  Reject with `CANNOT_RATE_OWN_COURSE`.
- **Text caps.** Optional review text `<= 280` chars (matches `MAX_DAPP_DESC_LEN`), trimmed;
  empty/whitespace-only text stored as `None`. Reject over-length with `TEXT_TOO_LONG`.
- No deletion endpoint for users in v1 (edit covers correction); an admin remove exists
  for moderation (`admin_remove_rating`).

### A4. Aggregate display

- Marketplace card (PB-305) and course detail show: **★ {avg, 1 decimal} ({count})**,
  e.g. "★ 4.3 (27)". No rating yet → "No ratings yet".
- Detail view lists the most recent N (e.g. 10) text reviews with the rater's stars and
  a relative timestamp. Keep it a simple paginated/queried list; no sorting controls.
- The card aggregate must be cheap to read on a page of many courses — store the running
  aggregate on the listing (B2) so the card render does not scan all rating rows.

---

## B. Implementation

### B1. File map

- Backend `src/backend/src/lib.rs`, section `// ===== 20. Course NFT marketplace =====`
  (ratings subsection). Reuse `require_authenticated`, `feature_visible`, `current_time`,
  `impl_storable!`, the PB-301 metadata read (`creator`), PB-306 `has_completed_round`.
- Candid `src/backend/backend.did`: add `Rating`, `CourseRatingSummary`, the methods.
- Frontend: star widget + review list in the PB-305 marketplace card/detail.

### B2. Data models

```rust
// MemoryId 81: COURSE_RATINGS: (token_id, Principal) -> Rating
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RatingKey { pub token_id: u64, pub rater: Principal }

// C2: this key IS range-scanned (`COURSE_RATINGS.range(token_id..)` lists one course's
// reviews), so it must NOT use `impl_storable!` (CBOR doesn't sort by token_id first).
// Hand-roll a fixed-width big-endian Storable: token_id first, then principal.
impl Storable for RatingKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let p = self.rater.as_slice();              // <= 29 bytes
        let mut b = Vec::with_capacity(38);
        b.extend_from_slice(&self.token_id.to_be_bytes()); // [0..8]  token_id (sorts first)
        b.push(p.len() as u8);                              // [8]     principal length
        b.extend_from_slice(p);                            // [9..]   principal bytes
        b.resize(38, 0);
        Cow::Owned(b)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let token_id = u64::from_be_bytes(bytes[0..8].try_into().unwrap());
        let len = bytes[8] as usize;
        let rater = Principal::from_slice(&bytes[9..9 + len]);
        Self { token_id, rater }
    }
    const BOUND: Bound = Bound::Bounded { max_size: 38, is_fixed_size: true };
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Rating {
    pub token_id: u64,
    pub rater: Principal,
    pub stars: u8,                 // 1..=5
    pub text: Option<String>,      // <= 280 chars, None if empty
    pub created_at: u64,
    pub updated_at: u64,
}
impl_storable!(Rating);

thread_local! {
    static COURSE_RATINGS: RefCell<StableBTreeMap<RatingKey, Rating, Memory>> =
        MEMORY_MANAGER.with(|mm| RefCell::new(
            StableBTreeMap::init(mm.borrow().get(MemoryId::new(81)))));
}
```

Running aggregate for cheap card reads — add to PB-305's `CourseListing` with
`#[serde(default)]` (upgrade-safe), updated transactionally on each rate/edit/remove:

```rust
// extends CourseListing (PB-305)
#[serde(default)] pub rating_sum: u64,    // sum of stars
#[serde(default)] pub rating_count: u32,  // distinct raters
// avg = rating_sum as f64 / rating_count (computed in the summary getter / frontend)
```

On a new rating: `sum += stars; count += 1`. On edit: `sum += new - old`. On admin
remove: `sum -= old; count -= 1`. (`RatingKey`'s custom fixed-width `Storable` above
sorts by `token_id` big-endian first, so `COURSE_RATINGS.range(token_id..)` lists exactly
one course's reviews in order — see the C2 note on the struct.)

### B3. Endpoints

```rust
#[ic_cdk::update]
async fn rate_course(token_id: u64, stars: u8, text: Option<String>) -> Result<(), String> {
    require_authenticated()?;                  // Tier 2+
    require_course_market_enabled()?;
    let rater = get_caller();
    if !(1..=5).contains(&stars) { return Err("BAD_STARS".into()); }
    let text = match text {
        Some(t) => { let t = t.trim(); if t.is_empty() { None }
                     else if t.chars().count() > 280 { return Err("TEXT_TOO_LONG".into()); }
                     else { Some(t.to_string()) } }
        None => None,
    };
    let listing = COURSE_LISTINGS.with(|m| m.borrow().get(&token_id)).ok_or("NO_COURSE")?;
    // no self-rating: creator (immutable) or live owner
    if rater == listing.creator { return Err("CANNOT_RATE_OWN_COURSE".into()); }
    let owner = course_nft_owner_of(token_id).await?;
    if rater == owner { return Err("CANNOT_RATE_OWN_COURSE".into()); }
    // completion gate (PB-306)
    if !has_completed_round(rater, token_id) { return Err("MUST_COMPLETE_ROUND".into()); }

    let key = RatingKey { token_id, rater };
    let now = current_time();
    let existing = COURSE_RATINGS.with(|m| m.borrow().get(&key));
    // upsert + maintain running aggregate on the listing (B2)
    // ... insert Rating, adjust rating_sum/rating_count, persist listing ...
    Ok(())
}

#[ic_cdk::query]
fn get_course_rating_summary(token_id: u64) -> CourseRatingSummary { /* avg_x10, count, my_stars */ }

#[ic_cdk::query]
fn list_course_reviews(token_id: u64, offset: u64, limit: u64) -> Vec<Rating> {
    // range over COURSE_RATINGS for token_id, most-recent-first, limit<=50
}

#[ic_cdk::update(guard = "require_admin")]
fn admin_remove_rating(token_id: u64, rater: Principal) -> Result<(), String> {
    // remove row + decrement aggregate
}
```

`CourseRatingSummary { token_id: nat64, rating_sum: nat64, count: nat32,
avg_x10: nat32 /* avg*10, convenience */, my_stars: opt nat8 }` — the frontend renders
`avg_x10/10` (or computes `rating_sum/count` itself).

> **Review O2 — deliberately NOT using `float64`.** O2 suggests declaring
> `average_rating: float64`. We **decline**: this repo keeps candid integer-typed by
> convention (no floats cross the wire anywhere — amounts are e8s, the lottery/odds are
> integers), which avoids float-determinism and binding surprises. Exposing the exact
> integers `rating_sum` + `count` (and the `avg_x10` convenience) is lossless and lets
> the frontend format the average however it likes. This is the only review item we
> don't adopt as-written.

### B4. Candid (`backend.did`)

```candid
type Rating = record {
  token_id : nat64; rater : principal; stars : nat8;
  text : opt text; created_at : nat64; updated_at : nat64;
};
type CourseRatingSummary = record {
  token_id : nat64; rating_sum : nat64; count : nat32; avg_x10 : nat32; my_stars : opt nat8;
};
rate_course               : (nat64, nat8, opt text) -> (Result);
get_course_rating_summary : (nat64) -> (CourseRatingSummary) query;
list_course_reviews       : (nat64, nat64, nat64) -> (vec Rating) query;
admin_remove_rating       : (nat64, principal) -> (Result);
```

Error strings: `BAD_STARS`, `TEXT_TOO_LONG`, `NO_COURSE`, `CANNOT_RATE_OWN_COURSE`,
`MUST_COMPLETE_ROUND`, `FEATURE_DISABLED`.

### B5. Frontend

- Reuse `ui.tsx` primitives. A small star control (1–5) + optional textarea (280-char
  counter) in a "Rate this course" panel on the detail view, shown only when the caller is
  eligible (the panel can call `get_course_rating_summary` whose `my_stars` indicates a
  prior rating → render in edit mode). Disable with a tooltip ("Finish a round to rate")
  when not eligible.
- Card aggregate from `CourseListing.rating_sum/count` (already in the card payload) or
  `get_course_rating_summary`; render `★ 4.3 (27)` or "No ratings yet".
- Detail review list via `list_course_reviews(token_id, offset, limit)`.

### B6. Acceptance criteria

- A signed-in user who completed a 9-hole round can rate 1–5 with optional ≤280-char text;
  a second rate edits in place (no duplicate row, aggregate stays correct).
- Creator and current owner cannot rate (`CANNOT_RATE_OWN_COURSE`).
- A user who hasn't completed a round, or is anonymous, cannot rate.
- Card aggregate matches the mean of stored rows; admin remove decrements correctly.
- `list_course_reviews` returns only that course's reviews, most-recent-first, bounded.

### B7. Test plan

Unit (`cargo test -p backend --lib`; mock `has_completed_round` / seed a completed
session, mock owner via the off-wasm `course_nft_owner_of` seam):
- star bounds, text trim/length, None handling.
- self-rating (creator + owner) rejection.
- completion gate rejection vs. acceptance.
- upsert/edit keeps one row; running aggregate matches a recomputed mean across edits and
  an admin removal.
- `list_course_reviews` range correctness + limit cap.
- **(C2) `RatingKey` ordering:** seed ratings for ≥ 2 courses whose `token_id`s differ in
  their high byte, interleaved with raters whose principals would sort *before* a lower
  token_id under CBOR; assert `list_course_reviews(token_id)` returns *exactly* that
  course's rows and never bleeds into an adjacent course — the test a CBOR key fails.
  Round-trip `to_bytes`/`from_bytes`; assert fixed 38-byte length.

Integration (PocketIC): play+complete a round (PB-306) then rate; assert summary on the
listing. Manual local: two identities complete a course, rate it, see the card average
update; verify the owner cannot rate.

### B8. Out of scope

- Review voting, replies, threads, flagging/report queue, rich text/media.
- User-facing rating deletion (edit-in-place + admin remove only).
- Weighting ratings by play count / tier; rating-driven marketplace ordering (ordering is
  random per PB-305).
- Notifications to course creators.

### B9. Dependencies

- **PB-305** — `COURSE_LISTINGS` (card payload gains `rating_sum`/`rating_count`),
  marketplace card/detail UI, feature flag.
- **PB-306** — `has_completed_round(player, token_id)` predicate (completion gate).
- **PB-301** — immutable `creator` from NFT metadata; `icrc7_owner_of` for the owner check.
- Independent of PB-307 (buy/sell) and PB-308 (featured slot).
