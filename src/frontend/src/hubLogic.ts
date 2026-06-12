// Pure decision/formatting logic for the Dashboard hub — kept free of
// components so it is unit-testable and the page file stays fast-refreshable.
import type { Proposal } from "./bindings/backend";
import type { AppPage } from "./App";
import { fmtICP } from "./ui";

const DAY_NS = 86_400_000_000_000n;

// ── Pure helpers (unit-tested in test/dashboard.test.ts) ──

/** "2d 4h" / "3h 12m" / "45m" until a nanosecond timestamp; null if past/unset. */
export function countdownShort(atNs: bigint, nowMs: number): string | null {
  if (atNs <= 0n) return null;
  const ms = Number(atNs / 1_000_000n) - nowMs;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

export interface AttentionItem {
  kind: 'claim_yield' | 'draw_soon' | 'closing_votes';
  page: AppPage;
  title: string;
  detail: string;
}

/** Action-needed cards, most valuable first. Pure so the ranking is testable. */
export function attentionItems(args: {
  nowNs: bigint;
  claimableE8s: bigint;
  lottery: { nextDrawAt: bigint; myTickets: bigint } | null;
  proposals: Proposal[];
  actedProposalIds: Set<string>;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (args.claimableE8s > 0n) {
    items.push({
      kind: 'claim_yield',
      page: 'early_adopters',
      title: `${fmtICP(args.claimableE8s)} ICP ready to claim`,
      detail: 'Your Early Adopter yield share is allocated — unclaimed shares forfeit to the treasury at the next settlement.',
    });
  }
  const closing = args.proposals.filter(p =>
    p.status === 'open' &&
    p.deadline > args.nowNs &&
    p.deadline - args.nowNs <= DAY_NS &&
    !args.actedProposalIds.has(p.id.toString())
  );
  if (closing.length > 0) {
    items.push({
      kind: 'closing_votes',
      page: 'voting',
      title: closing.length === 1 ? 'A vote closes within 24h' : `${closing.length} votes close within 24h`,
      detail: 'Open proposals you haven\'t weighed in on hit their commitment cutoff soon.',
    });
  }
  if (args.lottery && args.lottery.myTickets > 0n &&
      args.lottery.nextDrawAt > args.nowNs &&
      args.lottery.nextDrawAt - args.nowNs <= DAY_NS) {
    items.push({
      kind: 'draw_soon',
      page: 'lottery',
      title: 'Lottery draw within 24h',
      detail: `You hold ${args.lottery.myTickets.toString()} tickets in the current round.`,
    });
  }
  return items;
}
