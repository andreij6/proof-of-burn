---
name: ui-copy-in-sync
description: Keep user-facing copy accurate when app behaviour changes. Use whenever you change economics, fees, rewards, ratios, thresholds, feature flags, a feature's name, or add/remove/relabel a feature — BEFORE finishing, sweep the places copy lives and fix anything now-false. Also use when asked to "review the landing page / feature text for accuracy."
---

# Keep UI copy in sync with functionality

This app's value props are spelled out in prose in many places. When you change
how something *works*, the text that *explains* it silently goes stale — a
wrong number about someone's money is worse than no number. Treat copy as part
of the change, not a follow-up.

**The rule:** any change to behaviour, economics, a ratio/fee/threshold, a
feature flag, or a feature name is not done until you've swept the copy below
and fixed every now-false claim. If you changed a backend constant, grep the
frontend for the *old* value.

## Where copy lives (sweep all of these)

| Location | What's there |
|---|---|
| `src/frontend/src/Landing.tsx` | The `SECTIONS` array (per-feature `title`/`body`/`chips`) + the hero subtitle + finale. The most-read, most-stale copy. |
| `<MoreInfo title="How … works">` dialogs | The canonical "how it works" explainers, one per feature — in `App.tsx` (vote dialog, Verified Followers), `Staking.tsx`, `Lottery.tsx`, `LotteryHub.tsx`, `IdeaBoard.tsx`, `Casino.tsx`, `Poker.tsx`. |
| Inline `setNotice` / `setError` / `setStakeStep` / chips / tooltips | Success/confirm/empty-state strings that quote amounts, ratios, ticket rates. |
| `Dashboard.tsx` | Hub cards (`HubCard`) + the onboarding checklist labels. |
| `Admin.tsx` `section === 'reference'` | "How each feature works" — verbatim money-flow claims; keep exact. |
| `Payouts.tsx` | Agent endpoint list + per-skill blurbs/instructions. |
| `src/frontend/public/llms-*.txt` | **Agent-facing skill files** describing every flow end-to-end (`llms-prod/local`, `llms-lottery-*`, `llms-rd-*`, `llms-crash-*`, `llms-early_adopters-validate`). Easy to forget — edit these too; they're shipped to AI agents as ground truth. |
| `README.md`, `docs/*.md` | Product/economics docs. |

## Recurring drift points (numbers/names that have bitten us)

- **Ticket rates:** term staking 5 / 10 / 20 per ICP/day; the **Perm** neuron 100 per ICP/day.
- **Yield split:** 50% treasury / 50% lottery — and per product decision this split is **not shown to users** (don't reintroduce the percentages in copy).
- **Verified-Follower payout:** 25% of each settled burn, split among the **top 100 neurons by voting power** (ties for the last slot → higher VP).
- **Lottery prize:** winner 80% / 20% rolls over; ~1-in-13 per draw (this is the *prize* split — distinct from the yield split, which is hidden).
- **Voting is burn-only.** Staking grants **no voting power** — never say "stake to vote / multiply your voice."
- **Upvotes are free** (no crypto, no poster cut). Project funding has **one USD goal**, any supported crypto.
- **Names:** "Boosters" → **Perm** (neuron); "Pool Neurons" → **Verified Followers**; SVP/SVPP are **retired**; the casino is **disabled**.
- Fees/thresholds/minimums: prefer rendering from `config`/query fields (e.g. `pool_initiation_fee_e8s`, `min_stake_e8s`, `lottery_tickets_per_day`) over hardcoding — a literal in prose is a guaranteed future drift point.

## Verification checklist

1. **Grep for the old value/name** you just changed across `src/frontend/src` and `src/frontend/public/llms-*.txt` (e.g. `grep -rn "top 25\|80%\|Boosters\|voting power"`). Every hit is a candidate.
2. Read the changed feature's **Landing section** and its **`<MoreInfo>` dialog** end-to-end against the new behaviour.
3. Check the **Admin Reference** entry and the relevant **`llms-*.txt`** for the same feature.
4. `cd src/frontend && npx tsc -b` (copy edits can break JSX); skim the page in the running app (`bash scripts/deploy-local.sh`).

When a number genuinely must live in prose (the backend has no query for it),
leave a brief code comment next to it noting the backing constant, so the next
change knows to update both.
