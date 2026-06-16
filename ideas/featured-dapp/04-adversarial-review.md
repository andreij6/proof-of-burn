# Featured Dapp — Adversarial Review

> A red-team pass over the spec, verified against `src/backend/src/lib.rs`. Findings are folded back into
> README.md and 02-backend-and-tasks.md; each correction is flagged "(patched)".

## Verdict on the two load-bearing claims

- **(a) max-3-at-approval is race-safe — CONFIRMED (with a caveat).** `admin_approve_dapp` (lib.rs:10281)
  is genuinely no-`await`: `get → check → mutate` runs inside one `DAPPS.with(borrow_mut)`. The IC runs
  one message to completion, so a clone that counts and sets in one no-await body is atomic — two admins
  double-clicking into the last slot can't both win. **Caveat:** the count predicate must be
  `Active && now <= expires_at` (Finding 5). **BUT** this proof is **void if Finding 1 is fixed the safe
  way** (escrow-until-approval adds an `await` to approve — see Finding 2).
- **(b) submit_dapp-clone apply is compatible with reserve-only — REFUTED.** `submit_dapp` (lib.rs:10247)
  transfers to `TREASURY_SUBACCOUNT` *during apply*, before any approval or slot check. A clone **cannot**
  be reserve-only. The README recommended reserve-only while the backend spec specified the charging
  clone — a self-contradiction. **This is the spec's biggest hole.**

## Findings

### 1. [CRITICAL, patched] Reserve-only vs. submit_dapp-clone is a contradiction — resolved to escrow-until-approval
The README's D2/OD-3 (reserve-only) and §3/§6/task-7 (clone `submit_dapp` → charge to treasury at apply)
cannot both be true. **Resolution (now the spec):** `apply_featured` charges on apply **into the caller's
`derive_explorer_subaccount` escrow — funds stay there, NOT treasury, while Pending.** Approval is the
point where escrow sweeps to treasury. This gives safe funds (no indefinite treasury custody), a clean
refund exit, and an enforceable cap. The reserve-only language is removed; "charged when a slot frees" is
dropped from UX copy. Consequence: approval now has an `await` (Finding 2).

### 2. [HIGH, patched] Escrow-until-approval puts an await in approve → re-secure max-3
With funds sweeping escrow→treasury inside approve, approve gains an `await`, so two Pending apps could
both pass the max-3 check before either transfer completes. **Fix (now the spec):** claim-before-await —
in a synchronous pre-await step, atomically flip `Pending → Approving` and re-count treating
`Active + Approving` as occupied; only then `await` the escrow→treasury sweep; on failure revert to
`Pending` (mirrors `admin_reject_dapp`'s claim-before-await, lib.rs:10314). Backend §4 rewritten to cover
the awaiting-approve case.

### 3. [HIGH, patched] Paid-but-never-approved → funds parked indefinitely; add a hard auto-refund TTL
With charge-on-apply, an admin who never acts leaves the premium held forever (worse than `submit_dapp`:
featured premiums are ~10×/day × up to 90 days ≈ up to ~$900). **Fix (now a hard requirement):** the
`expire_featured` sweep auto-refunds any `Pending` row older than a TTL (recommend **7 days**) via the
reject-refund path (claim-before-await, −fee). With escrow-until-approval (Finding 1) the refund is just
returning the caller's own escrowed funds — even cleaner. Add a test.

### 4. [HIGH, patched] Refund vs. treasury floor — explicit policy needed
`admin_reject_dapp` (lib.rs:10324) refunds via raw `call_ledger_transfer`, **bypassing**
`treasury_floor_check` (lib.rs:3393; floor is ICP-only). For Pending refunds that's correct (returning
escrowed funds the user owns — and with escrow-until-approval the funds never entered treasury anyway).
But `admin_remove_featured`'s **pro-rata refund of an Active ICP placement** is a treasury outflow with no
floor guard and could drain ICP below cycle life-support. **Fix (now the spec):** pro-rata removal refund
is gated behind an `override_floor`-style admin acknowledgement when the token is ICP (reuse the
`admin_withdraw_treasury` floor pattern); ck-token refunds are unaffected by the ICP floor.

### 5. [MEDIUM, patched] max-3 count must use `now <= expires_at`; add the missing test
Between an expiry instant and the 300s sweep, a row is still `status == Active`. If approve counts status
alone, an expired-unswept slot blocks the 4th approval for up to 5 min. Backend §4 already says count
`Active && now <= expires_at` — promoted to a hard AC + a new test: "an Active row past `expires_at`, not
yet swept, does NOT consume a slot at approve."

### 6. [MEDIUM, patched] One buyer can corner the rotation — enforce one slot per listing/applicant
Client `Math.random()` gives each of N≤3 a 1/N share, but a buyer pays the same premium regardless, and
nothing stops one listing/applicant holding 2–3 concurrent slots (buy 3 → lock out competitors, 100%
exposure — defeating "max 3 *different* dapps"). **Fix (now the spec):** `apply_featured` rejects if the
caller/`listing_id` already has an Active or Pending featured placement (cheap synchronous check). Also
surface live occupancy in the quote/modal so late buyers know exposure is shared.

### 7. [MEDIUM, patched] Dangling featured row when the underlying listing expires/is removed
`delete_expired_dapps` (lib.rs:9875) and reject **delete the `DappListing` row**. A placement referencing
a deleted `listing_id` would break the join / render a garbage hero, and the buyer paid for a now-dead
spot. **Fix (now the spec):** (a) `get_featured_dapps` skips placements whose listing is gone AND treats
that slot as **freed** for approval accounting; (b) `delete_expired_dapps`/reject also force-expire (and,
for an Active paid placement, pro-rata refund) any featured row referencing that listing — the buyer isn't
silently charged for a dead spot.

### 8. [MEDIUM, patched] Mutable `logo_url` is a top-of-page bait-and-switch vector
`DappListing` is immutable post-submit (no `edit_dapp` exists — good), so name/url/desc can't be swapped.
But the spec adds an admin-reviewed `logo_url` and puts a user-supplied url+logo at the highest-trust spot
on the page; admin review is point-in-time and a hotlinked logo host can swap the image after approval.
**Fix (now the spec):** `logo_url` must be https + scheme/length-validated (reuse `validate_dapp_text`);
**prefer a monogram or caller-uploaded in-canister asset over a hotlinked external URL**; document that
admin review is point-in-time and `admin_remove_featured` is the kill switch; keep `rel="noopener
noreferrer"` on the CTA (UX §3a already has it).

### 9–10. [LOW, noted] CallerGuard + no impression telemetry
`apply_featured` inherits the global per-principal `CallerGuard` (lib.rs:1726) — it serializes with the
user's other escrow actions (intended; prevents double-spend). And client-side per-load random means
**no server-side impression accounting** — you can't prove rotation fairness to an advertiser. Both are
acceptable tradeoffs; noted so they're conscious, not surprises. If advertisers ever dispute the ~1/N
exposure (Finding 6), server-side impression logging would require giving up the pure-query design.

## Confirmed-good (no action)
- MemoryIds **88/89/94/95 free** (grep-verified). 78 is the course slot.
- **Upgrade-safe:** new `Config` field `#[serde(default)]` + brand-new empty maps + append-only enum.
- **Anonymous query access** correct — `inspect_message` (lib.rs:749) gates only update ingress; queries
  bypass it (PB-308 `get_featured_slot` is a plain query with no `ANON_OK` — same precedent).
- **Reject claim-before-await** real and correct (lib.rs:10314-10331); a featured clone is sound.
- **Not reusing PB-308 auction** is right (single perpetual eviction slot — wrong shape).

## The one change that matters most
Finding 1. The spec was unbuildable as written (recommended behavior contradicted specified
implementation). Now resolved to **escrow-on-the-caller-subaccount-until-approval**, with a
claim-before-await `Pending→Approving` flip protecting max-3 (Finding 2), refund as the universal exit for
every non-Active terminal state (auto-refund TTL, no-slot, listing-gone), and an ICP-floor ack on pro-rata
removal refunds. README D2 and Backend §3/§4/§6 are patched accordingly.
