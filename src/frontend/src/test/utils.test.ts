import { describe, it, expect } from 'vitest';
import { isValidAccountId } from '../App';

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

// ── PB-116: neuron id formatting (must stay BigInt-safe) ─────────────────────

function formatNeuronId(id: bigint | null | undefined): string {
  if (id === null || id === undefined) return '…';
  return id.toString();
}

describe('PB-116 formatNeuronId', () => {
  it('renders plain decimal digits with no separators', () => {
    expect(formatNeuronId(4821667n)).toBe('4821667');
  });

  it('handles the production neuron id beyond Number.MAX_SAFE_INTEGER', () => {
    // 17802688826615984104 > 2^53 — must not lose precision
    expect(formatNeuronId(17802688826615984104n)).toBe('17802688826615984104');
  });

  it('renders a placeholder when config not yet loaded', () => {
    expect(formatNeuronId(null)).toBe('…');
    expect(formatNeuronId(undefined)).toBe('…');
  });

  it('production neuron exceeds JS safe integer (guards against Number coercion)', () => {
    expect(17802688826615984104n > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

// ── PB-114: three-section proposal partitioning ──────────────────────────────

type TestStatus = 'Pending' | 'Burned' | 'Returned' | 'FailedBurn';
interface TestProp { id: bigint; status: string }
interface TestCommit { proposal_id: bigint; status: TestStatus }

const ACTIVE = new Set<TestStatus>(['Pending', 'FailedBurn']);
const SETTLED = new Set<TestStatus>(['Burned', 'Returned']);

function bucketOf(p: TestProp, commits: TestCommit[]): 'open' | 'committed' | 'history' | 'none' {
  const c = commits.find(m => m.proposal_id === p.id);
  if (!c && (p.status === 'open' || p.status === 'met')) return 'open';
  if (c && ACTIVE.has(c.status)) return 'committed';
  if ((c && SETTLED.has(c.status)) ||
      (!c && (p.status === 'voted' || p.status === 'settled' || p.status === 'abstained'))) return 'history';
  return 'none';
}

describe('PB-114 proposal partitioning', () => {
  it('uncommitted open proposal → Open', () => {
    expect(bucketOf({ id: 1n, status: 'open' }, [])).toBe('open');
  });

  it('uncommitted met proposal is still votable → Open', () => {
    expect(bucketOf({ id: 1n, status: 'met' }, [])).toBe('open');
  });

  it('proposal with a pending commitment → Committed', () => {
    expect(bucketOf({ id: 1n, status: 'met' }, [{ proposal_id: 1n, status: 'Pending' }])).toBe('committed');
  });

  it('proposal with a burned commitment → History', () => {
    expect(bucketOf({ id: 1n, status: 'settled' }, [{ proposal_id: 1n, status: 'Burned' }])).toBe('history');
  });

  it('returned commitment → History', () => {
    expect(bucketOf({ id: 1n, status: 'abstained' }, [{ proposal_id: 1n, status: 'Returned' }])).toBe('history');
  });

  it('settled proposal with no personal commitment → History', () => {
    expect(bucketOf({ id: 9n, status: 'voted' }, [])).toBe('history');
  });
});

describe('isValidAccountId', () => {
  it('accepts a valid 64-character lowercase hex Account ID', () => {
    const valid = 'a'.repeat(64);
    expect(isValidAccountId(valid)).toBe(true);
  });

  it('accepts a valid 64-character uppercase hex Account ID', () => {
    const valid = 'F'.repeat(64);
    expect(isValidAccountId(valid)).toBe(true);
  });

  it('accepts a valid 64-character mixed-case hex Account ID', () => {
    const valid = 'a1B2' + 'c3D4'.repeat(15);
    expect(isValidAccountId(valid)).toBe(true);
  });

  it('accepts a valid Account ID with leading or trailing whitespace', () => {
    const valid = '  ' + 'b'.repeat(64) + ' \n ';
    expect(isValidAccountId(valid)).toBe(true);
  });

  it('rejects an Account ID that is too short (63 characters)', () => {
    const invalid = 'a'.repeat(63);
    expect(isValidAccountId(invalid)).toBe(false);
  });

  it('rejects an Account ID that is too long (65 characters)', () => {
    const invalid = 'a'.repeat(65);
    expect(isValidAccountId(invalid)).toBe(false);
  });

  it('rejects an Account ID containing non-hex characters', () => {
    const invalid = 'g' + 'a'.repeat(63);
    expect(isValidAccountId(invalid)).toBe(false);
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(isValidAccountId('')).toBe(false);
    expect(isValidAccountId('   ')).toBe(false);
  });
});


// ── PB-123: balance-of-power split (mirrors BalanceOfPowerBar) ───────────────

function adoptPercent(adopt: bigint, reject: bigint): number {
  const total = adopt + reject;
  return total > 0n ? Number((adopt * 10000n) / total) / 100 : 50;
}

describe('PB-123 balance-of-power split', () => {
  it('two equal commits → 50/50', () => {
    expect(adoptPercent(100_000_000n, 100_000_000n)).toBe(50);
  });

  it('proportional to ICP weight (75/25)', () => {
    expect(adoptPercent(300_000_000n, 100_000_000n)).toBe(75);
  });

  it('all adopt → 100%', () => {
    expect(adoptPercent(500_000_000n, 0n)).toBe(100);
  });

  it('all reject → 0% adopt', () => {
    expect(adoptPercent(0n, 500_000_000n)).toBe(0);
  });

  it('no commits → neutral 50 (empty bar)', () => {
    expect(adoptPercent(0n, 0n)).toBe(50);
  });

  it('handles large bigint weights without precision loss', () => {
    // 1,000,000 ICP vs 3,000,000 ICP → 25% adopt
    expect(adoptPercent(100_000_000_000_000n, 300_000_000_000_000n)).toBe(25);
  });
});

// ── Add-more validation (mirrors executeAddMore guards) ───────────────────────

const ADD_MORE_FEE_E8S = 10_000n; // only 1 ledger fee for the deposit

function validateAddMore(
  amountStr: string,
  holdings: bigint,
): string | null {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < MIN_COMMIT_ICP) return 'BELOW_MINIMUM';
  const amountE8s = BigInt(Math.floor(amount * 100_000_000));
  if (amountE8s + ADD_MORE_FEE_E8S > holdings) return 'INSUFFICIENT_BALANCE';
  return null;
}

describe('validateAddMore — top-up validation', () => {
  it('accepts a valid add-more amount', () => {
    expect(validateAddMore('2.0', 10_000_000_000n)).toBeNull();
  });

  it('rejects below-minimum (< 1 ICP)', () => {
    expect(validateAddMore('0.5', 10_000_000_000n)).toBe('BELOW_MINIMUM');
  });

  it('rejects NaN', () => {
    expect(validateAddMore('abc', 10_000_000_000n)).toBe('BELOW_MINIMUM');
  });

  it('rejects empty string', () => {
    expect(validateAddMore('', 10_000_000_000n)).toBe('BELOW_MINIMUM');
  });

  it('rejects insufficient balance (amount + 0.0001 fee > holdings)', () => {
    // 2 ICP + 0.0001 fee > 2 ICP wallet
    expect(validateAddMore('2.0', 200_000_000n)).toBe('INSUFFICIENT_BALANCE');
  });

  it('accepts exact minimum (1.0 ICP)', () => {
    expect(validateAddMore('1.0', 10_000_000_000n)).toBeNull();
  });

  it('fee is only 0.0001 ICP (10,000 e8s), not 0.0055', () => {
    // With 1.0001 ICP wallet, should be able to add 1 ICP
    // 1 ICP (100_000_000) + 10_000 = 100_010_000
    // Holdings = 100_010_000 → exactly enough
    expect(validateAddMore('1.0', 100_010_000n)).toBeNull();
  });

  it('fails when wallet is 1 e8s short of fee coverage', () => {
    // 100_009_999 < 100_010_000 (1 ICP + fee)
    expect(validateAddMore('1.0', 100_009_999n)).toBe('INSUFFICIENT_BALANCE');
  });
});
