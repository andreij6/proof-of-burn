// Dashboard hub — pure helper coverage: countdown formatting and the
// "needs attention" ranking logic.
import { describe, it, expect } from 'vitest';
import { countdownShort, attentionItems } from '../hubLogic';
import type { Proposal } from '../bindings/backend';

const NOW_MS = 1_700_000_000_000;
const NOW_NS = BigInt(NOW_MS) * 1_000_000n;
const HOUR_NS = 3_600_000_000_000n;

function proposal(over: Partial<Proposal>): Proposal {
  return {
    id: 1n, status: 'open',
    reject_pot_e8s: 0n, title: 't', summary: 's', deadline: NOW_NS + 48n * HOUR_NS,
    adopt_pot_e8s: 0n, threshold_e8s: 0n, category: 'c', total_committed_e8s: 0n,
    pool_distributed: false, lossless_adopt_e8s: 0n, lossless_reject_e8s: 0n,
    ...over,
  } as Proposal;
}

describe('countdownShort', () => {
  it('formats days, hours and minutes', () => {
    expect(countdownShort(BigInt(NOW_MS + 50 * 3_600_000) * 1_000_000n, NOW_MS)).toBe('2d 2h');
    expect(countdownShort(BigInt(NOW_MS + 3 * 3_600_000 + 12 * 60_000) * 1_000_000n, NOW_MS)).toBe('3h 12m');
    expect(countdownShort(BigInt(NOW_MS + 45 * 60_000) * 1_000_000n, NOW_MS)).toBe('45m');
  });
  it('returns null when past or unscheduled', () => {
    expect(countdownShort(0n, NOW_MS)).toBeNull();
    expect(countdownShort(BigInt(NOW_MS - 1000) * 1_000_000n, NOW_MS)).toBeNull();
  });
});

describe('attentionItems', () => {
  const base = { nowNs: NOW_NS, claimableE8s: 0n, lottery: null, proposals: [] as Proposal[], actedProposalIds: new Set<string>() };

  it('empty when nothing is actionable', () => {
    expect(attentionItems(base)).toEqual([]);
  });

  it('claimable yield ranks first and routes to early_adopters', () => {
    const items = attentionItems({
      ...base,
      claimableE8s: 250_000_000n,
      lottery: { nextDrawAt: NOW_NS + HOUR_NS, myTickets: 5n },
    });
    expect(items[0].kind).toBe('claim_yield');
    expect(items[0].page).toBe('early_adopters');
    expect(items[0].title).toContain('2.5');
  });

  it('flags open proposals closing within 24h that the user has not acted on', () => {
    const items = attentionItems({
      ...base,
      proposals: [
        proposal({ id: 1n, deadline: NOW_NS + 2n * HOUR_NS }),          // closing, un-acted → counts
        proposal({ id: 2n, deadline: NOW_NS + 2n * HOUR_NS }),          // closing, acted → skipped
        proposal({ id: 3n, deadline: NOW_NS + 48n * HOUR_NS }),         // far out → skipped
        proposal({ id: 4n, status: 'voted', deadline: NOW_NS + HOUR_NS }), // settled → skipped
      ],
      actedProposalIds: new Set(['2']),
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('closing_votes');
    expect(items[0].page).toBe('voting');
    expect(items[0].title).toBe('A vote closes within 24h');
  });

  it('draw card requires tickets AND a draw inside 24h', () => {
    const drawSoon = { nextDrawAt: NOW_NS + 3n * HOUR_NS, myTickets: 10n };
    expect(attentionItems({ ...base, lottery: drawSoon })[0].kind).toBe('draw_soon');
    expect(attentionItems({ ...base, lottery: { ...drawSoon, myTickets: 0n } })).toEqual([]);
    expect(attentionItems({ ...base, lottery: { nextDrawAt: NOW_NS + 30n * HOUR_NS, myTickets: 10n } })).toEqual([]);
  });
});
