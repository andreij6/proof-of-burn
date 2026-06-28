# Refocusing the app on the No Loss Lottery — change plan

**Date:** 2026-06-27
**Goal:** Make the **No Loss Lottery** the primary product surface. Voting stays fully
available, just less prominent — demoted from "the point of the app" to "one of the things
you can do."
**Out of scope (owned separately):** the public **landing page** (`Landing.tsx`) — you're
redesigning it. Everything below is the *rest* of the app.

---

## Guiding principle

Today the app reads as **"burn ICP to steer NNS votes; oh, and there's also a lottery."**
After this work it should read as **"a no-loss lottery you can't lose money in; oh, and you
can also help steer governance."** Concretely, that means the lottery should own: the
**home page**, the **top of the nav**, the **hero copy**, the **share strings**, and the
**agent/SEO docs**. Voting keeps a clear, permanent home — just not the spotlight.

---

## Open decisions (need your call — they change the work)

1. **What is the signed-in home page?**
   - **(A) Lottery becomes home** — strongest refocus; `redirect('dashboard')` → `redirect('lottery')`.
   - **(B) Keep the dashboard, but make it lottery-first** — rewrite the dashboard hero/checklist to lead with the lottery (details in §2).
   - *Recommendation:* (B) short-term (less disruptive, dashboard still gives an at-a-glance overview), with the dashboard hero pointing hard at the lottery. Move to (A) if the dashboard stops earning its slot.
2. **How far to demote voting?** In-nav-but-lower vs. a quiet "More/Governance" group near the bottom. *Recommendation:* keep it in-nav directly under the lottery group for now; it's still one click.
3. **Brand name.** "Cycle Burn" is a burn/voting-flavored name (40 occurrences across the app). Keep it, or rename to something lottery-forward? *This is the one item that fans out into the most files — decide before the copy pass.*

---

## P0 — Information architecture (highest signal, lowest effort)

### 1. Reorder the navigation — lottery to the top
`src/frontend/src/App.tsx` → `renderNavLinks` (≈1843–1933)

- **Lottery is currently buried**: it sits under a `Featured` group *after* Arcade and Casino
  (`App.tsx:1878`). Pull it up to the **top**, directly under (or above) Dashboard, as the
  first real destination.
- **`Governance` group is too high** (`App.tsx:1893`) — Voting is the first item in a
  top-level group. Move the whole Governance group **below** the lottery (and ideally below
  Community), or rename to a quieter heading.
- Suggested order: `Dashboard · Lottery (+ next-draw chip) · [Featured: Arcade/X-Farm] · Community (Roadmap/Explorer) · Governance (Voting/Discussions) · Neuron Syndicate`.
- The **next-draw countdown chip** on the Lottery nav item (`App.tsx:1882`) is great — keep it; it's a live hook that pulls attention to the lottery. Consider the same treatment is *removed/way-down* from voting.
- Group label `Featured` (`App.tsx:1860`) — if Lottery leaves this group, consider renaming it `Play`/`More`.

### 2. Home page leads with the lottery
`src/frontend/src/Dashboard.tsx` + redirect logic in `App.tsx`

- **Redirect target:** signed-in users are sent to `dashboard` (`App.tsx:1094`, `App.tsx:1218`).
  If we go with decision (A), change these to `lottery`.
- **Dashboard hero is voting-first** (`Dashboard.tsx:218-221`):
  > "Welcome … Burn ICP to steer NNS votes, stake losslessly for daily lottery tickets, and fund …"
  Rewrite to lead with the lottery: pot size, your tickets, next draw, "stake → free daily
  tickets → win, never lose." Voting becomes a secondary line.
- **Onboarding checklist is voting-first** (`Dashboard.tsx:204-205`): step 1 is
  *"Cast your first vote — burn ICP to steer the leader"*, step 2 is staking. **Reorder** so the
  first 1–2 steps are lottery actions ("Stake ICP — earn daily lottery tickets", "Claim today's
  tickets"), with voting later in the list.
- **Hero stat cards / mini-charts:** make the prominent stats *pot size*, *your tickets*, and
  *next draw* (the Dashboard already fetches `get_lottery_info`, `Dashboard.tsx:143-198`) rather
  than burn/governance metrics.

---

## P1 — Make the lottery shine (it's now the centerpiece)

### 3. Fix the lottery's perceived load time
`src/frontend/src/Lottery.tsx` (+ `LotteryHub.tsx`)

This was already diagnosed earlier: the lottery refetches **all four** of its calls on every
visit and shows a skeleton each time, because the page fully unmounts on navigation
(`<Reveal key={page}>`, `App.tsx:2227`) and all state is local with `loading=true`
(`Lottery.tsx:49-86`). One of the four (`get_lottery_info`) is an **update** call (it reads the
live pot via an inter-canister ledger call), so it's also the slowest.

- Add a small **stale-while-revalidate cache** (module-level `Map`) keyed per call, **with a
  30–60s TTL**, so revisits paint the last-known pot/tickets **instantly** and refresh in the
  background. Now that the lottery is the home/most-visited page, this is worth doing.
- Optional follow-up: cache the pot balance in canister state and make `get_lottery_info` a
  pure `#[query]` so the page costs nothing to view (bigger backend change; do later).

### 4. Lottery page polish
`src/frontend/src/LotteryHub.tsx`, `Lottery.tsx`

- The hub tabs (`Drawings` / `Stake to Earn Tickets`, `LotteryHub.tsx:47-50`) are solid. As the
  primary page, consider surfacing the **how-it-works "gist"** higher and the **recent winners**
  prominently (social proof for a no-loss product).
- The **win banner** (`App.tsx:557-583`) already celebrates winners for 2 days — lean into it;
  it's a great retention hook for the now-primary feature.

---

## P1 — Copy, share, and global meta

### 5. Share strings are voting-only
`src/frontend/src/App.tsx:1035-1036`

Current share text is all governance: *"Burn ICP, move the vote. 🔥"*. Add **lottery share
strings** (e.g. "Won X ICP in a lottery I literally can't lose — pot's at Y 🎟️") wired into the
win banner and the lottery page. This is free distribution for the headline feature.

### 6. Global title + missing meta/OG tags
`src/frontend/index.html`

- `<title>Cycle Burn</title>` (`index.html:10`) — update to a lottery-forward title (pending the
  brand decision).
- **There is no `<meta name="description">` or Open Graph / Twitter card meta at all.** Since the
  lottery is the headline, add description + OG/twitter tags now (a link preview is the first
  thing people see when the app is shared). Coordinate the exact words with your new landing copy.

### 7. Mission statement
`src/frontend/src/AboutUs.tsx` — nav label is **"Mission Statement"** (`App.tsx:1856`). Review and
re-weight toward the lottery as the flagship; keep the governance mission as a supporting pillar.

---

## P2 — Agent docs & SEO (`public/llms-*.txt`)

There's already a dedicated **`llms-lottery-prod.txt`** / `llms-lottery-local.txt` — good. But the
**top-level `llms-prod.txt`** (the entry doc agents read first) leads with voting/burn. Reorder it
so the lottery is the first capability described, and link the lottery agent doc prominently.
Update the brand/description line in each `llms-*.txt` to match the new positioning.

Files: `public/llms-prod.txt`, `llms-local.txt` (entry docs) — reorder; the `-lottery-`,
`-rd-`, `-early_adopters-` variants are already feature-scoped.

---

## What NOT to change

- **Don't disable or remove voting.** It stays fully functional — backend voting logic, the
  Voting page, neuron steering, Neuron Syndicate, discussions all remain. This is a
  *prominence* change, not a teardown.
- **Don't touch the landing page** (`Landing.tsx`) — you own that redesign. (Noted only so the
  copy/brand passes above don't collide with it: the global `index.html` title/meta and the brand
  name are shared, so align those with your new landing.)
- **Don't change feature flags / backend gating** — `lossless_lottery` is already enabled; no
  backend changes are required for the refocus except the optional §3 query optimization.

---

## Suggested sequencing

1. Decide §Open-decisions (home page, voting depth, brand).
2. P0: nav reorder + home/dashboard hero & checklist (the 80/20 of perceived focus).
3. P1: lottery load fix (§3) + share strings (§5) + title/meta (§6).
4. P2: agent docs + mission statement.

Most of the visible impact is P0 and is a few hours of frontend work in `App.tsx` and
`Dashboard.tsx`. The brand-rename decision (if yes) is the only item that touches many files.
