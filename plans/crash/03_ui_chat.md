# 03 — UI: the bustabit look, the chat box, the Casino hub

## Casino hub (C15/C16; amends poker nav)

- Nav: **Play → Casino** (single entry, `cards` icon), path `/casino`,
  visible when `poker` OR `crash` is enabled. `/poker` redirects to
  `/casino` (poker tab). Page `casino` joins AppPage; tabs keep their own
  sub-paths (`/casino` = Crash if enabled else Poker; `/casino/poker`,
  `/casino/crash`) so deep links survive.
- **Hub header banner (the doctrine, C16):**
  > **No loss of principal — ever.** Chips are voting power earned by
  > staking. Your staked ICP is never wagered, never at risk, and always
  > unstakeable in full. Go broke at the tables and your ICP is still
  > exactly where you left it.
  With a MoreInfo dialog explaining VP↔chips, the stop-loss, and the house
  burn in plain words. The same one-liner repeats under each game title and
  on every bust/stop-loss screen.
- Hub body: two big cards (Poker room status: tables live, seats; Crash:
  current round phase + last 6 multipliers) + the shared Casino chat.

## Crash screen (PB-238) — bustabit aesthetic, original art

Layout (desktop; mobile stacks graph → bet panel → players → chat):

```
┌────────────────────────────────────────────┬──────────────────┐
│              THE GRAPH                     │   CHAT (C13)     │
│   big live multiplier  2.34×               │  alice: gl all   │
│   rising curve, log-ish y axis             │  bob: 10x or bust│
│   crash ⇒ red flash + "BUSTED @ 2.41×"     │  [input · 200ch] │
├────────────────────────────────────────────┤                  │
│ [history bar: 1.00 4.20 1.13 2.41 87.21 …] │                  │
├──────────────────────────┬─────────────────┤                  │
│ BET PANEL                │ PLAYERS (live)  │                  │
│ wager [chips] target [×] │ name · bet · ✓× │                  │
│ [PLACE BET] [CASH OUT]   │ green=cashed    │                  │
│ auto-pilot: [script ▾]   │ red=riding/lost │                  │
└──────────────────────────┴─────────────────┴──────────────────┘
```

- **Graph:** canvas curve `m(t)=e^{0.06t}` from `run_started_at` (clients
  all render identically from the timestamp — no server ticks). Betting
  phase shows a 10 s countdown ring; crash plays a screen-shake + red flash
  + the crash multiplier in huge type; 100× cap rounds get a gold "MOON"
  treatment. Dark theme on the app's design tokens; original art only.
- **History bar:** last 20 rounds as colored chips (≥2× sprout, <2× ember,
  100× gold) — each opens the **verify dialog** (C14): seed, chain link,
  recomputed crash point, "verified ✓" client-side recomputation.
- **Bet panel:** wager (chips, with VP equivalent line), auto-target
  spinner (default 2.00×), big PLACE BET during betting; during the run it
  becomes **CASH OUT @ live ×** (disabled if not riding); the latency
  honesty line sits right under it (C7). Bet rails + stop-loss errors
  surface inline. One bet per round.
- **Players list:** everyone in the round: principal (formatPrincipal),
  wager, state — riding (pulsing), cashed (green, with ×), lost (dim).
  Live cashouts pop a small toast on the curve at their multiplier
  (the bustabit dopamine).
- **My result strip:** after each round: won/lost chips, running session
  P&L in VP, stop-loss distance meter.
- **Auto-pilot dock:** strategy picker (builtins/owned/licensed), running
  state (rounds played, net, next action), STOP button always visible;
  stop-condition hit shows the reason ("take-profit +50 VP reached").
- Polling: 1 s during Running (cheap query; the curve itself is local
  math), 3 s otherwise. SFX via the arcade WebAudio engine: tick on bet
  lock, rising whine during the run (pitch follows multiplier), explosion
  on crash, cash-register on cashout; same global mute.

## Chat box (C13, PB-235)

- One **global Casino chat** (shared by hub/poker/crash screens).
- Storage: ring buffer of 500 messages (MemoryId 65):
  `{ id, author, text ≤ 200 chars, at }`. Signed-in users only;
  **1 message / 5 s / principal** (canister-enforced); charset-validated
  (no control chars), rendered as plain text (no markup/links →
  zero injection surface).
- Display name = formatPrincipal (+ the poker agent's model badge when the
  author has one — fun flavor, zero extra state).
- **Moderation:** `admin_mute_chat(principal, until)` and
  `admin_delete_chat(id)`; muted users see their own messages locally
  ("only you can see this — muted") to deter instant workarounds; audit-
  logged. No automated filter in v1 (documented).
- Agents MAY chat (same rate limit); the skill doc asks bots to identify
  themselves and keep quiet by default.

## Copy rules

- The C16 doctrine sentence on: hub header, each game header, bet panel
  footer, bust screen, stop-loss screen, llms docs, and the X-share text.
- "Burned, not banked": wherever the edge is mentioned —
  *"The 1% house edge is destroyed forever, not collected."*
- Losses always paired with the restake nudge (poker R6) and the
  stop-loss distance meter.
