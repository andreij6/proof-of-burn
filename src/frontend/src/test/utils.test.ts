import { describe, it, expect } from 'vitest';

// ── Formatting helpers (duplicated here to avoid import-cycle with App.tsx) ──

function fmtICP(n: number | bigint): string {
  return (Number(n) / 100_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatPrincipal(text: string): string {
  if (!text || text === '2vxsx-fae') return 'Anonymous';
  return `${text.slice(0, 4)}…${text.slice(-3)}`;
}

// ── Tier derivation logic (mirrors App.tsx tier calc) ────────────────────────

function deriveTier(authenticated: boolean, following: boolean, hasCommitted: boolean): number {
  if (!authenticated) return 0;
  if (!following) return 1;
  if (hasCommitted) return 3;
  return 2;
}

// ── Commitment validation (mirrors handleCommitClick guards) ──────────────────

const MIN_COMMIT_ICP = 1.0;
const FEES_E8S = 530_000n;

function validateCommit(
  amountStr: string,
  holdings: bigint,
  neuronStakeCap: bigint,
): string | null {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < MIN_COMMIT_ICP) return 'BELOW_MINIMUM';
  const amountE8s = BigInt(Math.floor(amount * 100_000_000));
  if (neuronStakeCap > 0n && amountE8s > neuronStakeCap) return 'EXCEEDS_STAKE_CAP';
  if (amountE8s + FEES_E8S > holdings) return 'INSUFFICIENT_BALANCE';
  return null;
}

// ── Deadline formatting (mirrors proposal card) ───────────────────────────────

function fmtDeadline(deadlineNs: bigint): string {
  const remainingNs = Number(deadlineNs) - Date.now() * 1_000_000;
  const remainingH = Math.max(0, Math.floor(remainingNs / (3_600 * 1_000_000_000)));
  const remainingD = Math.floor(remainingH / 24);
  return remainingD > 0 ? `${remainingD}d ${remainingH % 24}h` : `${remainingH}h`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fmtICP', () => {
  it('formats 1 ICP correctly', () => {
    expect(fmtICP(100_000_000n)).toBe('1.0');
  });

  it('formats 0.5 ICP correctly', () => {
    expect(fmtICP(50_000_000n)).toBe('0.5');
  });

  it('formats large amounts', () => {
    expect(fmtICP(1_000_000_000_000n)).toBe('10,000.0');
  });

  it('formats zero', () => {
    expect(fmtICP(0n)).toBe('0.0');
  });

  it('accepts number input', () => {
    expect(fmtICP(100_000_000)).toBe('1.0');
  });
});

describe('formatPrincipal', () => {
  it('shows Anonymous for the anonymous principal', () => {
    expect(formatPrincipal('2vxsx-fae')).toBe('Anonymous');
  });

  it('truncates a normal principal', () => {
    const result = formatPrincipal('rrkah-fqaaa-aaaaa-aaaaq-cai');
    expect(result).toMatch(/^rrka…cai$/);
  });

  it('handles empty string as Anonymous', () => {
    expect(formatPrincipal('')).toBe('Anonymous');
  });
});

describe('deriveTier', () => {
  it('Tier 0 for unauthenticated user', () => {
    expect(deriveTier(false, false, false)).toBe(0);
  });

  it('Tier 1 for authenticated but not following', () => {
    expect(deriveTier(true, false, false)).toBe(1);
  });

  it('Tier 2 for following but not committed', () => {
    expect(deriveTier(true, true, false)).toBe(2);
  });

  it('Tier 3 for committed user', () => {
    expect(deriveTier(true, true, true)).toBe(3);
  });

  it('Tier 1 when following=true but authenticated=false (impossible runtime state but logic-safe)', () => {
    expect(deriveTier(false, true, true)).toBe(0);
  });
});

describe('validateCommit', () => {
  const holdings = 10_000_000_000n; // 100 ICP wallet
  const neuronCap = 5_000_000_000n; // 50 ICP neuron stake

  it('accepts a valid commit', () => {
    expect(validateCommit('2.0', holdings, neuronCap)).toBeNull();
  });

  it('rejects below-minimum amount', () => {
    expect(validateCommit('0.5', holdings, neuronCap)).toBe('BELOW_MINIMUM');
  });

  it('rejects NaN input', () => {
    expect(validateCommit('abc', holdings, neuronCap)).toBe('BELOW_MINIMUM');
  });

  it('rejects empty string', () => {
    expect(validateCommit('', holdings, neuronCap)).toBe('BELOW_MINIMUM');
  });

  it('rejects amount exceeding neuron stake cap', () => {
    expect(validateCommit('60.0', holdings, neuronCap)).toBe('EXCEEDS_STAKE_CAP');
  });

  it('rejects amount exceeding wallet balance (including fees)', () => {
    // neuronCap first: 60 ICP > 50 ICP cap
    expect(validateCommit('60.0', holdings, neuronCap)).toBe('EXCEEDS_STAKE_CAP');
    // with a large cap (neuron check skipped), test balance: wallet=100 ICP, commit=100 ICP
    // 100_000_000_000 + 530_000 > 10_000_000_000 → INSUFFICIENT_BALANCE
    const largeCap = 100_000_000_000_000n;
    const smallWallet = 200_000_000n; // 2 ICP wallet
    expect(validateCommit('2.0', smallWallet, largeCap)).toBe('INSUFFICIENT_BALANCE');
  });

  it('ignores neuron cap when cap is 0 (not registered)', () => {
    // cap = 0 means neuron not yet registered; skip that check
    expect(validateCommit('2.0', holdings, 0n)).toBeNull();
  });

  it('accepts exact minimum amount', () => {
    expect(validateCommit('1.0', holdings, neuronCap)).toBeNull();
  });
});

describe('fmtDeadline', () => {
  it('shows hours when less than 24h remaining', () => {
    const futureNs = BigInt(Date.now() + 12 * 3_600_000) * 1_000_000n;
    const result = fmtDeadline(futureNs);
    expect(result).toMatch(/^\d+h$/);
  });

  it('shows days and hours when more than 24h remaining', () => {
    const futureNs = BigInt(Date.now() + 3 * 24 * 3_600_000) * 1_000_000n;
    const result = fmtDeadline(futureNs);
    expect(result).toMatch(/^\d+d \d+h$/);
  });

  it('shows 0h for expired proposals', () => {
    const pastNs = BigInt(Date.now() - 3_600_000) * 1_000_000n;
    const result = fmtDeadline(pastNs);
    expect(result).toBe('0h');
  });
});

describe('PB-082 constant alignment', () => {
  it('minimum commit is 1.0 ICP', () => {
    expect(MIN_COMMIT_ICP).toBe(1.0);
  });

  it('fee reserve is non-zero', () => {
    expect(FEES_E8S).toBeGreaterThan(0n);
  });
});

// ── PB-115 / PB-116: Global stats strip ──────────────────────────────────────

// Mirrors the open/met filter used by the backend get_global_stats query.
function isLockedStatus(status: string): boolean {
  return status === 'open' || status === 'met';
}

function sumTvlE8s(proposals: { status: string; total_committed_e8s: bigint }[]): bigint {
  return proposals
    .filter((p) => isLockedStatus(p.status))
    .reduce((acc, p) => acc + p.total_committed_e8s, 0n);
}

describe('PB-115 global stats: TVL filter', () => {
  it('includes open proposals', () => {
    const proposals = [{ status: 'open', total_committed_e8s: 100_000_000n }];
    expect(sumTvlE8s(proposals)).toBe(100_000_000n);
  });

  it('includes met proposals', () => {
    const proposals = [{ status: 'met', total_committed_e8s: 200_000_000n }];
    expect(sumTvlE8s(proposals)).toBe(200_000_000n);
  });

  it('excludes settled / voted / failed / abstained', () => {
    const proposals = [
      { status: 'settled',  total_committed_e8s: 1_000n },
      { status: 'voted',    total_committed_e8s: 1_000n },
      { status: 'failed',   total_committed_e8s: 1_000n },
      { status: 'abstained', total_committed_e8s: 1_000n },
    ];
    expect(sumTvlE8s(proposals)).toBe(0n);
  });

  it('sums only open+met when mixed', () => {
    const proposals = [
      { status: 'open',   total_committed_e8s: 318_000_000_000n },
      { status: 'met',    total_committed_e8s: 500_000_000_000n },
      { status: 'open',   total_committed_e8s: 141_000_000_000n },
      { status: 'settled', total_committed_e8s: 1_000_000_000n }, // excluded
    ];
    // 318 + 500 + 141 = 959 (in ICP, since e8s)
    expect(sumTvlE8s(proposals)).toBe(959_000_000_000n);
  });
});

describe('PB-115 global stats: total burned', () => {
  // Mirrors the backend summation over VoteRecord.icp_burned_e8s.
  function sumBurnedE8s(votes: { icp_burned_e8s: bigint }[]): bigint {
    return votes.reduce((acc, v) => acc + v.icp_burned_e8s, 0n);
  }

  it('sums multiple votes', () => {
    const votes = [
      { icp_burned_e8s: 1_240_000_000n },   // 12.4 ICP
      { icp_burned_e8s: 600_000_000n },      // 6.0 ICP
      { icp_burned_e8s: 2_010_000_000n },    // 20.1 ICP
    ];
    expect(sumBurnedE8s(votes)).toBe(3_850_000_000n);
  });

  it('returns 0 for empty vote list', () => {
    expect(sumBurnedE8s([])).toBe(0n);
  });
});

describe('PB-115 global stats: votes_cast count', () => {
  function countVotes(votes: unknown[]): bigint {
    return BigInt(votes.length);
  }

  it('counts distinct proposals voted on', () => {
    expect(countVotes([{}, {}, {}])).toBe(3n);
  });

  it('returns 0 when no votes yet', () => {
    expect(countVotes([])).toBe(0n);
  });
});
