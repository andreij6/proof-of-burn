# X-Farm — UX Spec

Companion to [README](README.md). New page `XFarm.tsx` (linked from the nav + the
voting dashboard). Primitives from `ui.tsx`; the Explorer listing modal + Idea
Board composer are the closest precedents.

## 1. Entry + "Start a Farmer"

A nav item **"X-Farm"** (and a card on the voting dashboard). Landing hero:
*"Grow pro-ICP content on autopilot. Burn ICP → your own canister drafts a daily
tweet batch you can post on X."* CTA: **Start a Farmer** (signed-in only;
disabled-with-tooltip otherwise).

## 2. Setup wizard (3 steps)

```
┌─ Step 1 · Persona ──────────────────────────────────┐
│  Pick a voice:                                      │
│   ( ) ICP developer advocate  (technical, builder)  │
│   ( ) Degen ICP maxi          (hype, price, CT)      │
│   ( ) Objective IC researcher (nuanced, cites sources) │
│   ( ) Custom: [ ...................... ] ≤ 300       │
│            [ Cancel ]  [ Next ]                      │
└─────────────────────────────────────────────────────┘
┌─ Step 2 · Tier ─────────────────────────────────────┐
│   Sprout   1 draft/day · 7d   0.50 ICP             │
│   Grow     5 drafts/day · 7d   1.00 ICP   ◉         │
│   Bloom    10 drafts/day · 7d  2.00 ICP             │
│  (admin can add/edit tiers)                          │
│            [ Back ]  [ Next ]                        │
└─────────────────────────────────────────────────────┘
┌─ Step 3 · Pay ──────────────────────────────────────┐
│  Persona: Degen ICP maxi                             │
│  Tier:    Grow — 5 drafts/day · 7 days               │
│  Price:   1.00 ICP                                   │
│    └ burned to your Farmer's 7-day cycle budget ─ 90%│
│    └ to the treasury                  ─ 10%          │
│  Your balance: 4.20 ICP                              │
│  [ ] add the "drafted by my ICP x-Farm" tag (D8)     │
│            [ Back ]  [ Pay & deploy Farmer ]         │
└─────────────────────────────────────────────────────┘
```

- **No explanatory anti-spam blurb in the dialog** (per owner convention) — just
  persona, tier, priced fee, the 90/10 split, balance, buttons.
- Two-step pay (deposit to per-user escrow → `create_farmer`), like `submit_dapp`.
- On success: a **"Your Farmer is running"** screen with the Farmer canister id,
  next-generation time, and a link to **My Farmer**.

## 3. My Farmer dashboard

```
┌─ 🌱 My Farmer · Grow tier ──────────────────────────┐
│  canister: uxxxx-…  · cycles: 1.2T · next draft: 4h │
│  budget left: ~5.2d of 7d (cycles = the timer) [Renew]│
│                                                     │
│  Today's drafts (5) ──────────────  [ Regenerate ]  │
│   ▢ "ICP just processed its Nth tx — …"   📋 ✕ on X │
│   ▢ "Why $ICP's AI-agent-economy thesis …" 📋 ✕ on X │
│   …                                                 │
│                                                     │
│  Archive (last 30 days) ▾                           │
└─────────────────────────────────────────────────────┘
```

- **Per draft:** copy (📋), **Share on X** (reuses `shareProposalOnX`'s
  `twitter.com/intent/tweet` — opens X with the draft prefilled; the user posts),
  dismiss. Drafts are plain text (escaped; no HTML) — 04 R4.
- **Status row:** live cycles + **days-of-budget left** (`get_farmer_status` —
  the cycle balance *is* the 7-day timer, D2), next generation. **Renew** = pay
  another base price → burn to cycles → re-deposit (resets the 7-day budget;
  reuses the create burn leg; no new canister).
- **Regenerate** = manual re-roll of today's batch (optional, may cost a small
  extra cycle burn — admin toggle; default free once/day).

## 4. Share on X

Reuse `shareProposalOnX`'s intent pattern. Tweet body = the chosen draft (already
≤ 280). If D8 tag kept, append ` — drafted by my ICP x-Farm canister` (fits within
270 to leave room). `url` = optional ICP proposal/news link the draft cited.

## 5. Empty / error / abuse states

- **No Farmer yet:** "You don't have a Farmer running — start one."
- **Farmer expired:** "Your Farmer ended on Jul 19. Renew to keep it growing, or
  start a new one."
- **Cycles low warning:** "Your Farmer is low on cycles — extend to avoid a gap."
- **Generation failure** (outcall/parse): the day's batch is empty with an inline
  "Couldn't generate today — the Farmer will retry tomorrow." **No charge to the
  user** (cycles already burned; the burn still happened — on-theme; the miss is a
  service gap, not a refund, since the burn is upfront D2). *Open: credit a day?*
- **Content notice (D8 / no moderation):** a one-line "Drafts are AI-generated
  suggestions. You're responsible for what you post. Admins may disable Farmers."
  near the drafts. No word filter; admin can `admin_disable_farmer(id)`.

## 6. Local-dev toggles

`usePageDevControls`: `dev_create_mock_farmer(tier, persona)` (no real
canister/outcall — seeds drafts), `dev_seed_drafts(n)`, `dev_advance_farmer_day()`
(to exercise the timer/expiry path offline). Under the shared-state fallback,
these also cover the per-user-state path.