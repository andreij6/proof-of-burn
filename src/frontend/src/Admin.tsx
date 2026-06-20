import { useState, useEffect } from 'react';
import { ExplorerToken } from "./bindings/backend";
import { UnstakeStatus } from "./bindings/backend";
import { FlagState } from "./bindings/backend";
import type { Config, FeatureFlag, GlobalStats, LotteryInfo, EarlyAdopterInfo, StakingPoolInfo, PoolInfo, NeuronFollowStatus, AuditLogEntry, StakeTier, PendingUnstake } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { ModerationCandidate, UserBalanceRow } from "./bindings/backend";
import type { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, Btn, Chip, LiveDot, MoreInfo, fmtICP, formatPrincipal, usePageDevControls } from "./ui";
import { useErrorImpression } from "./analytics";
import CourseEditor from "./arcade/CourseEditor";

// ==========================================
// Admin console — sectioned: Overview (health), Treasury Management
// (multi-token, 15-ICP floor guard, neuron allocations), Governance,
// Staking & Lottery, Features (flag table), Content (course editor +
// casino seed), and the How-it-works Reference.
// ==========================================

interface AdminProps {
  actor: any;
  config: Config | null;
  featureFlags: FeatureFlag[];
  identity: any;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  /** Re-fetch config + flags after a successful change. */
  onChanged: () => void;
  openTreasury: () => void;
}

type AdminSection = 'overview' | 'treasury' | 'neurons' | 'governance' | 'staking' | 'features' | 'content' | 'moderation' | 'users' | 'reference';

const SECTIONS: { key: AdminSection; label: string; icon: string }[] = [
  { key: 'overview', label: 'Overview', icon: 'eye' },
  { key: 'treasury', label: 'Treasury', icon: 'wallet' },
  { key: 'neurons', label: 'Neurons', icon: 'target' },
  { key: 'governance', label: 'Governance', icon: 'flame' },
  { key: 'staking', label: 'Staking & Lottery', icon: 'zap' },
  { key: 'features', label: 'Features', icon: 'zap' },
  { key: 'content', label: 'Content', icon: 'gamepad' },
  { key: 'moderation', label: 'Course moderation', icon: 'eye' },
  { key: 'users', label: 'Users', icon: 'list' },
  { key: 'reference', label: 'Reference', icon: 'info' },
];

// Columns for the user-balances table: field key on UserBalanceRow + decimals.
const USER_BAL_COLS = [
  { key: 'icp', label: 'ICP', dec: 8 },
  { key: 'ckbtc', label: 'ckBTC', dec: 8 },
  { key: 'cketh', label: 'ckETH', dec: 18 },
  { key: 'ckusdc', label: 'ckUSDC', dec: 6 },
  { key: 'ckusdt', label: 'ckUSDT', dec: 6 },
] as const;

// The treasury account exists on every configured ledger — fees and shares
// accumulate per token. Decimals drive display + smallest-unit conversion.
const TOKEN_META: { token: ExplorerToken; label: string; decimals: number }[] = [
  { token: ExplorerToken.ICP, label: 'ICP', decimals: 8 },
  { token: ExplorerToken.CkBTC, label: 'ckBTC', decimals: 8 },
  { token: ExplorerToken.CkETH, label: 'ckETH', decimals: 18 },
  { token: ExplorerToken.CkUSDC, label: 'ckUSDC', decimals: 6 },
  { token: ExplorerToken.CkUSDT, label: 'ckUSDT', decimals: 6 },
];

function fmtUnits(amount: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = amount / d;
  const frac = amount % d;
  const fracStr = frac === 0n ? '' : `.${(frac + d).toString().slice(1).replace(/0+$/, '')}`;
  return `${whole.toLocaleString()}${fracStr}`;
}

function parseUnits(text: string, decimals: number): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  try { return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt(frac || '0'); } catch { return null; }
}

const TREASURY_FLOOR = 1_500_000_000n; // 15 ICP — mirrored from the backend guard

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="col" style={{
      gap: 0, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="row"
        style={{
          gap: 10, padding: '12px 14px', background: 'transparent', border: 'none',
          cursor: 'pointer', width: '100%', textAlign: 'left', color: 'var(--fg)',
        }}
      >
        <Icon name={icon} size={14} stroke="var(--burn-ink)" />
        <b style={{ fontSize: 13.5, flex: 1 }}>{title}</b>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={14} stroke="var(--fg-3)" />
      </button>
      {open && (
        <div className="col" style={{ gap: 8, padding: '0 14px 14px 38px', fontSize: 12.5, color: 'var(--fg-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

const Li = ({ children }: { children: React.ReactNode }) => (
  <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
    <span style={{ color: 'var(--burn-ink)', lineHeight: '19px' }}>·</span>
    <span style={{ flex: 1 }}>{children}</span>
  </span>
);

function StatCard({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'var(--ember)' : tone === 'warn' ? 'var(--haze)' : 'var(--fg)';
  return (
    <div className="col" style={{
      gap: 4, padding: '12px 14px', borderRadius: 10, flex: '1 1 170px', minWidth: 150,
      border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{label}</span>
      <b className="mono" style={{ fontSize: 17, color }}>{value}</b>
      {sub && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{sub}</span>}
    </div>
  );
}

export default function Admin({ actor, config, featureFlags, identity, host, rootKey, ledgerCanisterId, onChanged, openTreasury }: AdminProps) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useErrorImpression(error, 'admin');

  // ── dial inputs ──
  const [thresholdInput, setThresholdInput] = useState('');
  const [ticketsInput, setTicketsInput] = useState('');
  const [poolFeeInput, setPoolFeeInput] = useState('');
  const [sweetenInput, setSweetenInput] = useState('');
  const [minStakeInput, setMinStakeInput] = useState('');
  const [minUnstakeInput, setMinUnstakeInput] = useState('');

  // ── treasury management ──
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  // Withdraw card state (txToken/txAmount/txDest) + Deposit card state (dep*).
  const [txToken, setTxToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [txAmount, setTxAmount] = useState('');
  const [txDest, setTxDest] = useState('');
  const [depToken, setDepToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [depAmount, setDepAmount] = useState('');
  const [overrideFloor, setOverrideFloor] = useState(false);
  const [allocTarget, setAllocTarget] = useState<string>('TwoYears'); // tier name or 'EarlyAdopters'
  const [allocAmount, setAllocAmount] = useState('');

  // ── overview health ──
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [cycles, setCycles] = useState<bigint | null>(null);
  const [feCycles, setFeCycles] = useState<bigint | 'unavailable' | null>(null);
  const [lottery, setLottery] = useState<LotteryInfo | null>(null);
  const [ea, setEa] = useState<EarlyAdopterInfo | null>(null);
  const [staking, setStaking] = useState<StakingPoolInfo | null>(null);
  const [pool, setPool] = useState<PoolInfo | null>(null);

  // ── course moderation ──
  const [modCandidates, setModCandidates] = useState<ModerationCandidate[] | null>(null);

  // ── governance / diagnostics ──
  const [auditTail, setAuditTail] = useState<AuditLogEntry[]>([]);
  const [followStatus, setFollowStatus] = useState<NeuronFollowStatus[] | null>(null);
  const [splitNeurons, setSplitNeurons] = useState<PendingUnstake[] | null>(null);

  const run = async (label: string, fn: () => Promise<string | null>) => {
    if (!actor || busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  // ── data loading ──────────────────────────────────────────────────────────
  const tokenLedgerIds = async (): Promise<Record<string, string>> => {
    const info = await actor.get_explorer_info();
    return {
      ICP: ledgerCanisterId,
      CkBTC: info.ckbtc_ledger.toText(),
      CkETH: info.cketh_ledger.toText(),
      CkUSDC: info.ckusdc_ledger.toText(),
      CkUSDT: info.ckusdt_ledger.toText(),
    };
  };

  const refreshBalances = async () => {
    if (!actor) return;
    try {
      const treasuryAcct = await actor.get_treasury_deposit_address();
      const ledgers = await tokenLedgerIds();
      const next: Record<string, bigint | null> = {};
      await Promise.all(TOKEN_META.map(async ({ token }) => {
        try {
          const ledger = createLedgerActor(ledgers[token], { agentOptions: { host, identity, rootKey } });
          next[token] = await ledger.icrc1_balance_of({ owner: treasuryAcct.owner, subaccount: treasuryAcct.subaccount });
        } catch { next[token] = null; }
      }));
      setBalances(next);
    } catch { /* transient */ }
  };

  const refreshHealth = async () => {
    if (!actor) return;
    const grab = async <T,>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
    const [st, cy, lot, eaInfo, stk, pl, fe] = await Promise.all([
      grab<GlobalStats>(() => actor.get_global_stats()),
      grab<bigint>(() => actor.get_cycle_balance()),
      grab<LotteryInfo>(() => actor.get_lottery_info()),
      grab<EarlyAdopterInfo>(() => actor.get_early_adopter_info()),
      grab<StakingPoolInfo>(() => actor.get_staking_pool_info()),
      grab<PoolInfo>(() => actor.get_pool_info()),
      grab<{ __kind__: string; Ok?: bigint; Err?: string }>(() => actor.admin_get_frontend_cycles()),
    ]);
    setStats(st); setCycles(cy); setLottery(lot); setEa(eaInfo); setStaking(stk); setPool(pl);
    setFeCycles(fe === null ? null : fe.__kind__ === 'Ok' ? fe.Ok! : 'unavailable');
  };

  const refreshAudit = async () => {
    if (!actor) return;
    try {
      // The log is append-only; fetch a big window and keep the newest 25.
      const entries: AuditLogEntry[] = await actor.get_audit_log(0n, 1000n);
      setAuditTail(entries.slice(-25).reverse());
    } catch { /* transient */ }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!actor || cancelled) return;
      await Promise.all([refreshHealth(), refreshBalances()]);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  // ── treasury actions ──────────────────────────────────────────────────────
  const meta = TOKEN_META.find(t => t.token === txToken)!;
  const depMeta = TOKEN_META.find(t => t.token === depToken)!;

  const depositToken = () => run('t-deposit', async () => {
    const amount = parseUnits(depAmount, depMeta.decimals);
    if (!amount || amount <= 0n) { setError(`Enter a valid ${depMeta.label} amount.`); return null; }
    const dest = await actor.get_treasury_deposit_address();
    const ledgers = await tokenLedgerIds();
    const ledger = createLedgerActor(ledgers[depToken], { agentOptions: { host, identity, rootKey } });
    const xfer = await ledger.icrc1_transfer({ to: { owner: dest.owner, subaccount: dest.subaccount }, amount });
    if (xfer.__kind__ === 'Err') {
      setError(`Deposit failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
      return null;
    }
    const sent = depAmount;
    setDepAmount('');
    await refreshBalances();
    return `${sent} ${depMeta.label} deposited to the treasury from your wallet.`;
  });

  const withdrawToken = () => run('t-withdraw', async () => {
    const amount = parseUnits(txAmount, meta.decimals);
    if (!amount || amount <= 0n) { setError(`Enter a valid ${meta.label} amount.`); return null; }
    let dest;
    try { dest = txDest.trim() ? (await import("@icp-sdk/core/principal")).Principal.fromText(txDest.trim()) : identity.getPrincipal(); }
    catch { setError('Destination is not a valid principal.'); return null; }
    const res = await actor.admin_withdraw_treasury_token(txToken, dest, amount, overrideFloor);
    if (res.__kind__ === 'Err') {
      setError(res.Err === 'TREASURY_FLOOR'
        ? 'Blocked: this would take the ICP treasury below the 15 ICP floor (the canisters\' cycle lifeline). Tick "Override floor" to proceed anyway.'
        : res.Err);
      return null;
    }
    setTxAmount('');
    setOverrideFloor(false);
    await refreshBalances();
    return `${fmtUnits(amount, meta.decimals)} ${meta.label} withdrawn to ${formatPrincipal(dest)}.`;
  });

  const allocateToNeuron = () => run('t-allocate', async () => {
    const amount = parseUnits(allocAmount, 8);
    if (!amount || amount <= 0n) { setError('Enter a valid ICP amount.'); return null; }
    const res = allocTarget === 'EarlyAdopters'
      ? await actor.admin_fund_early_adopter_neuron(amount, overrideFloor)
      : await actor.admin_fund_tier_neuron(allocTarget as StakeTier, amount, overrideFloor);
    if (res.__kind__ === 'Err') {
      setError(res.Err === 'TREASURY_FLOOR'
        ? 'Blocked: this allocation would take the treasury below the 15 ICP floor. Tick "Override floor" to proceed anyway.'
        : res.Err);
      return null;
    }
    setAllocAmount('');
    setOverrideFloor(false);
    await Promise.all([refreshBalances(), refreshHealth()]);
    return `${fmtUnits(amount, 8)} ICP allocated to the ${allocTarget === 'EarlyAdopters' ? 'Perm' : allocTarget} neuron.`;
  });

  // ── dial actions (unchanged mechanics, new homes) ─────────────────────────
  const setThreshold = () => run('threshold', async () => {
    const usd = parseFloat(thresholdInput);
    if (isNaN(usd) || usd < 0.1) { setError("Threshold must be at least $0.10."); return null; }
    const res = await actor.admin_set_default_threshold_usd(BigInt(Math.round(usd * 100_000_000)));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setThresholdInput('');
    return `Threshold set to $${usd.toFixed(2)} — all open proposals re-thresholded by dollar value.`;
  });

  // Cycle a flag Off → On → AdminOn → Off. AdminOn enables the feature for
  // admins only (live preview/playtest without exposing it to everyone).
  const cycleFlag = (key: string, state: FlagState) => run(`flag-${key}`, async () => {
    const next = state === FlagState.Off ? FlagState.On
      : state === FlagState.On ? FlagState.AdminOn
        : FlagState.Off;
    const res = await actor.admin_set_feature_flag_state(key, next);
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    return `${key} → ${next}.`;
  });

  const setTickets = () => run('tickets', async () => {
    const n = parseInt(ticketsInput, 10);
    if (isNaN(n) || n < 1) { setError("Base grant must be at least 1 ticket."); return null; }
    const res = await actor.admin_set_lottery_config(BigInt(n));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setTicketsInput('');
    return `Base ticket grant set to ${n} per ICP per day (tiers pay ${n}/${n * 2}/${n * 4}).`;
  });

  const setPoolFee = () => run('poolfee', async () => {
    const icp = parseFloat(poolFeeInput);
    if (isNaN(icp) || icp <= 0) { setError("Fee must be above 0 ICP."); return null; }
    const res = await actor.admin_set_pool_fee(BigInt(Math.round(icp * 100_000_000)));
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setPoolFeeInput('');
    return `Pool initiation fee set to ${icp} ICP.`;
  });

  const setStakingConfig = () => run('stakingcfg', async () => {
    const minStake = minStakeInput ? parseUnits(minStakeInput, 8) : null;
    const minUnstake = minUnstakeInput ? parseUnits(minUnstakeInput, 8) : null;
    if (!minStake && !minUnstake) { setError('Enter at least one value.'); return null; }
    const res = await actor.admin_set_staking_config(minStake ?? undefined, minUnstake ?? undefined, undefined);
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    setMinStakeInput(''); setMinUnstakeInput('');
    return 'Staking config updated.';
  });

  const sweetenPot = () => run('sweeten', async () => {
    const icp = parseFloat(sweetenInput);
    if (isNaN(icp) || icp <= 0) { setError("Enter an ICP amount above 0."); return null; }
    const amount = BigInt(Math.round(icp * 100_000_000));
    const pot = await actor.get_lottery_pot_address();
    const ledger = createLedgerActor(ledgerCanisterId, { agentOptions: { host, identity, rootKey } });
    const xfer = await ledger.icrc1_transfer({ to: { owner: pot.owner, subaccount: pot.subaccount }, amount });
    if (xfer.__kind__ === "Err") {
      setError(`Transfer failed: ${JSON.stringify(xfer.Err, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`);
      return null;
    }
    setSweetenInput('');
    return `Pot sweetened with ${icp} ICP from your wallet — it's in the next jackpots.`;
  });

  const triggerSweep = () => run('sweep', async () => {
    const res = await actor.admin_trigger_sweep();
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    await refreshHealth();
    return 'Sweep triggered — settlements, retries and timers all ran.';
  });

  const seedCasino = () => run('seedcasino', async () => {
    const res = await actor.dev_seed_casino_play();
    if (res.__kind__ === "Err") { setError(res.Err); return null; }
    return (res.Ok as string) + ' — open Play → Casino.';
  });

  // Surface the casino local-playtest control in App's Dashboard & Controls panel.
  usePageDevControls(!!config?.is_local, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Casino — local playtest</span>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Grants you 5,000 ICP of dev stake (so you have SVPP) and seeds 6 auto-pilot bots
        that bet &amp; chat every round. Needs the <span className="mono">crash</span> flag on.
      </span>
      <Btn variant="secondary" sm onClick={seedCasino} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
        <Icon name="gamepad" size={12} /> Seed bots &amp; grant me SVPP
      </Btn>
    </div>
  ), [busy, config?.is_local]);

  const refreshSplitNeurons = async () => {
    if (!actor) return;
    try {
      const all: PendingUnstake[] = await actor.admin_list_pending_unstakes();
      setSplitNeurons(all);
    } catch { /* transient */ }
  };

  const checkFollowing = () => run('follow', async () => {
    const res: NeuronFollowStatus[] = await actor.admin_check_neuron_following();
    setFollowStatus(res);
    const bad = res.filter(r => !r.follows_primary);
    return bad.length === 0
      ? `All ${res.length} platform neurons follow the primary on every topic.`
      : `⚠ ${bad.length} neuron(s) NOT fully following — see the table.`;
  });

  // ── course moderation ────────────────────────────────────────────────────
  // Worst-first list of low-rated courses (avg < 2.0★ with ≥5 ratings); the
  // backend already excludes hidden courses from the public marketplace.
  const refreshModeration = async () => {
    if (!actor) return;
    try {
      const list: ModerationCandidate[] = await actor.admin_list_moderation_candidates(200);
      setModCandidates(list);
    } catch { /* transient */ }
  };

  // ── user wallet balances ─────────────────────────────────────────────────
  // Union of every known participant principal, each with its own wallet balance
  // across the five tokens. Fetched in chunks (5 outcalls/user) so a big user
  // base doesn't blow one call's outcall budget; rows accumulate as they arrive.
  const [userRows, setUserRows] = useState<UserBalanceRow[] | null>(null);
  const [userProgress, setUserProgress] = useState<{ done: number; total: number } | null>(null);

  const loadUserBalances = async () => {
    if (!actor) return;
    setBusy('users'); setError(null); setNotice(null);
    setUserRows(null); setUserProgress(null);
    try {
      const principals: Principal[] = await actor.admin_list_user_principals();
      setUserProgress({ done: 0, total: principals.length });
      const CHUNK = 8;
      const rows: UserBalanceRow[] = [];
      for (let i = 0; i < principals.length; i += CHUNK) {
        const part = await actor.admin_user_balances(principals.slice(i, i + CHUNK));
        rows.push(...part);
        setUserRows([...rows]);
        setUserProgress({ done: Math.min(i + CHUNK, principals.length), total: principals.length });
      }
      setUserRows(rows);
      setNotice(`Loaded ${rows.length} user${rows.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const hideCourse = (c: ModerationCandidate) => run(`mod-hide-${c.token_id}`, async () => {
    const res = c.hidden
      ? await actor.admin_unhide_course(c.token_id)
      : await actor.admin_hide_course(c.token_id);
    if (res.__kind__ === 'Err') { setError(res.Err); return null; }
    await refreshModeration();
    return `Course #${c.token_id} ${c.hidden ? 'unhidden — back in the marketplace' : 'hidden from the marketplace'}.`;
  });

  const burnCourse = (c: ModerationCandidate) => run(`mod-burn-${c.token_id}`, async () => {
    if (!window.confirm(`Burn course #${c.token_id}? This permanently destroys the NFT — it cannot be undone.`)) return null;
    const res = await actor.admin_burn_course(c.token_id);
    if (res.__kind__ === 'Err') { setError(res.Err); return null; }
    await refreshModeration();
    return `Course #${c.token_id} burned permanently.`;
  });

  const card: React.CSSProperties = {
    border: '1px dashed var(--burn)', borderRadius: 10,
    background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))', padding: 14,
  };
  const inputStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', flex: 1 };
  const base = config ? Number(config.lottery_tickets_per_day) : 5;
  const treasuryIcp = balances['ICP'] ?? null;
  const floorTone = treasuryIcp === null ? undefined : treasuryIcp < TREASURY_FLOOR ? 'bad' : treasuryIcp < 2_000_000_000n ? 'warn' : 'ok';

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="key" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Admin console</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Every protocol dial, grouped by job.</b>
      </div>

      {/* ── Section nav ── */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <Btn key={s.key} variant={section === s.key ? 'primary' : 'ghost'} sm onClick={() => { setSection(s.key); setError(null); setNotice(null); if (s.key === 'governance' || s.key === 'treasury') refreshAudit(); if (s.key === 'neurons') refreshSplitNeurons(); if (s.key === 'moderation') refreshModeration(); }}>
            <Icon name={s.icon} size={13} stroke={section === s.key ? 'var(--char-950)' : 'currentColor'} />
            {s.label}
          </Btn>
        ))}
      </div>

      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout-ink)',
          background: 'var(--surface)',
        }}>
          <Icon name={error ? "x" : "checkCircle"} size={13} stroke="currentColor" />
          {error || notice}
        </div>
      )}

      {/* ════ OVERVIEW ════ */}
      {section === 'overview' && (
        <>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <StatCard label="Treasury (ICP)" tone={floorTone}
              value={treasuryIcp !== null ? fmtICP(treasuryIcp) : '…'}
              sub={treasuryIcp !== null && treasuryIcp < TREASURY_FLOOR ? 'BELOW the 15 ICP floor — cycle top-ups at risk' : 'floor: 15 ICP'} />
            <StatCard label="Backend cycles" value={cycles !== null ? `${(Number(cycles) / 1e12).toFixed(2)} T` : '…'}
              tone={cycles !== null && Number(cycles) < 5e12 ? 'bad' : undefined} sub="auto top-up below 5 T" />
            <StatCard label="Frontend cycles"
              value={feCycles === null ? '…' : feCycles === 'unavailable' ? 'n/a' : `${(Number(feCycles) / 1e12).toFixed(2)} T`}
              tone={typeof feCycles === 'bigint' && Number(feCycles) < 1e12 ? 'bad' : undefined}
              sub={feCycles === 'unavailable' ? 'backend must control the frontend canister' : 'topped up by burn shares'} />
            <StatCard label="ICP burned" value={stats ? fmtICP(stats.total_burned_e8s) : '…'} sub={stats ? `${stats.votes_cast.toString()} NNS votes cast` : undefined} />
            <StatCard label="Voting TVL" value={stats ? `${fmtICP(stats.tvl_e8s)}` : '…'} sub={stats ? `pending burn ${fmtICP(stats.pending_burn_e8s)}` : undefined} />
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <StatCard label="Staking TVL" value={staking ? fmtICP(staking.total_staked_e8s) : '…'}
              sub={staking ? staking.pools.map(p => fmtICP(p.total_staked_e8s)).join(' / ') + ' by tier' : undefined} />
            <StatCard label="Lottery pot" value={lottery ? fmtICP(lottery.pot_e8s) : '…'}
              tone={lottery && lottery.pot_e8s < lottery.min_pot_e8s ? 'warn' : undefined}
              sub={lottery ? (lottery.pot_e8s < lottery.min_pot_e8s ? `below ${fmtICP(lottery.min_pot_e8s)} minimum — draws roll over` : `${lottery.total_tickets.toString()} tickets in round`) : undefined} />
            <StatCard label="Perm neuron" value={ea ? fmtICP(ea.total_staked_e8s) : '…'}
              sub={ea ? `${ea.early_adopter_count.toString()} members · ${ea.membership_closed ? 'CLOSED' : 'open'}` : undefined} />
            <StatCard label="Pool neurons" value={pool ? pool.active_count.toString() : '…'} sub="active in the top-25 race" />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" sm onClick={triggerSweep} disabled={busy !== null}>
              {busy === 'sweep' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} stroke="var(--burn-ink)" />} Run sweep now
            </Btn>
            <Btn variant="ghost" sm onClick={() => { refreshHealth(); refreshBalances(); }} disabled={busy !== null}>
              <Icon name="undo" size={13} /> Refresh
            </Btn>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            The sweep is the protocol's heartbeat (also runs every 5 minutes): settlements, failed-transfer
            retries, maturity harvests, lottery draws, cycle top-ups.
          </span>
        </>
      )}

      {/* ════ TREASURY MANAGEMENT ════ */}
      {section === 'treasury' && (
        <>
          {/* Balances */}
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <Eyebrow>Treasury balances — all supported tokens</Eyebrow>
              <Btn variant="ghost" sm onClick={refreshBalances} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
            </span>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              {TOKEN_META.map(({ token, label, decimals }) => (
                <div key={token} className="col" style={{ gap: 2, padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', minWidth: 120 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</span>
                  <b className="mono" style={{ fontSize: 14, color: token === ExplorerToken.ICP && floorTone === 'bad' ? 'var(--ember)' : 'var(--fg)' }}>
                    {balances[token] !== undefined && balances[token] !== null ? fmtUnits(balances[token]!, decimals) : '…'}
                  </b>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              One treasury account, five ledgers — upvote shares, explorer listings and arcade fees
              accumulate in their paid token. ICP is the operational reserve: it funds cycle top-ups
              and fee fronting, so it carries the 15 ICP floor.
            </span>
          </div>

          {/* Deposit + withdraw — two separate cards. */}
          <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
            {/* Deposit */}
            <div className="col" style={{ ...card, gap: 10, flex: '1 1 300px', minWidth: 280 }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="arrowUp" size={14} stroke="var(--sprout-ink)" />
                <Eyebrow>Deposit to treasury</Eyebrow>
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {TOKEN_META.map(({ token, label }) => (
                  <Btn key={token} variant={depToken === token ? 'primary' : 'ghost'} sm onClick={() => setDepToken(token)}>{label}</Btn>
                ))}
              </div>
              <input type="text" placeholder={`Amount (${depMeta.label})`} className="burn-input" style={{ ...inputStyle, maxWidth: 220 }}
                value={depAmount} onChange={e => setDepAmount(e.target.value)} />
              <Btn variant="secondary" sm onClick={depositToken} disabled={busy !== null || !depAmount} style={{ alignSelf: 'flex-start' }}>
                {busy === 't-deposit' ? <LiveDot size={7} /> : <Icon name="arrowUp" size={13} stroke="var(--burn-ink)" />} Deposit from my wallet
              </Btn>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Comes straight from your signed-in wallet on the selected token's ledger.
              </span>
            </div>

            {/* Withdraw */}
            <div className="col" style={{ ...card, gap: 10, flex: '1 1 300px', minWidth: 280 }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="wallet" size={14} stroke="var(--burn-ink)" />
                <Eyebrow>Withdraw from treasury</Eyebrow>
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {TOKEN_META.map(({ token, label }) => (
                  <Btn key={token} variant={txToken === token ? 'primary' : 'ghost'} sm onClick={() => setTxToken(token)}>{label}</Btn>
                ))}
              </div>
              <input type="text" placeholder={`Amount (${meta.label})`} className="burn-input" style={{ ...inputStyle, maxWidth: 220 }}
                value={txAmount} onChange={e => setTxAmount(e.target.value)} />
              <input type="text" placeholder="Destination principal (empty = your wallet)" className="burn-input" style={{ ...inputStyle, minWidth: 240 }}
                value={txDest} onChange={e => setTxDest(e.target.value)} />
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <Btn variant="primary" sm onClick={withdrawToken} disabled={busy !== null || !txAmount} style={{ alignSelf: 'flex-start' }}>
                  {busy === 't-withdraw' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="wallet" size={13} stroke="var(--char-950)" />} Withdraw
                </Btn>
                <label className="row" style={{ gap: 6, fontSize: 12, color: overrideFloor ? 'var(--ember)' : 'var(--fg-3)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={overrideFloor} onChange={e => setOverrideFloor(e.target.checked)} />
                  Override 15 ICP floor
                </label>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Withdrawals that would leave the ICP treasury under 15 ICP are refused unless you
                override — below ~10 ICP the cycle top-up silently stops and the canisters eventually
                go dark. <a onClick={openTreasury} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Legacy ICP dialog…</a>
              </span>
            </div>
          </div>

          {/* Allocate to neurons */}
          <div className="col" style={{ ...card, gap: 10 }}>
            <Eyebrow>Allocate ICP to a platform neuron</Eyebrow>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {[['SixMonths', '6-month pool'], ['OneYear', '1-year pool'], ['TwoYears', '2-year pool'], ['EarlyAdopters', 'Perm neuron']].map(([key, label]) => (
                <Btn key={key} variant={allocTarget === key ? 'primary' : 'ghost'} sm onClick={() => setAllocTarget(key)}>{label}</Btn>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input type="text" placeholder="Amount (ICP)" className="burn-input" style={{ ...inputStyle, maxWidth: 200 }}
                value={allocAmount} onChange={e => setAllocAmount(e.target.value)} />
              <Btn variant="primary" sm onClick={allocateToNeuron} disabled={busy !== null || !allocAmount}>
                {busy === 't-allocate' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Allocate
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Moves treasury ICP into the neuron's stake (transfer + refresh). Tier allocations boost
              that neuron's yield — and therefore the lottery pot — without belonging to any staker;
              Perm-tier allocations compound the Perm neuron's yield (split 30/70 treasury/lottery). The 15 ICP floor and
              override apply here too. Allocations are one-way: getting ICP back out means a neuron
              dissolve, so treat them as permanent.
            </span>
          </div>

          {/* ── Transactions — the protocol's money-movement log ── */}
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <Eyebrow>Transactions — money in &amp; out</Eyebrow>
              <Btn variant="ghost" sm onClick={refreshAudit} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
            </span>
            <div className="col" style={{ gap: 4, maxHeight: 360, overflowY: 'auto' }}>
              {auditTail.length === 0 && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No transactions yet (or still loading).</span>}
              {auditTail.map((e, i) => (
                <div key={i} className="row" style={{ gap: 10, fontSize: 11.5, padding: '5px 8px', borderRadius: 6, background: i % 2 ? 'transparent' : 'var(--surface)', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ color: 'var(--fg-3)', minWidth: 118 }}>
                    {new Date(Number(e.timestamp / 1_000_000n)).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>{e.event_type}</Chip>
                  <span className="mono">{fmtICP(e.amount_e8s)} ICP</span>
                  <span className="mono" style={{ color: 'var(--fg-3)' }}>{formatPrincipal(e.user)}</span>
                  <span className="mono" style={{ color: 'var(--fg-3)' }}>ref #{e.proposal_id.toString()}</span>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Append-only on-chain record of every money-moving event — burns, refunds, payouts, fees and staking. Newest first.
            </span>
          </div>
        </>
      )}

      {/* ════ NEURONS ════ */}
      {section === 'neurons' && (
        <>
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <Eyebrow>Platform neurons — live from NNS governance</Eyebrow>
              <Btn variant="secondary" sm onClick={checkFollowing} disabled={busy !== null}>
                {busy === 'follow' ? <LiveDot size={7} /> : <Icon name="eye" size={13} stroke="var(--burn-ink)" />} Check live (NNS)
              </Btn>
            </span>
            {followStatus && (
              <div className="col" style={{ gap: 4 }}>
                {followStatus.map(f => (
                  <div key={f.label} className="row" style={{ gap: 10, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    {f.follows_primary
                      ? <Chip tone="ok"><Icon name="checkCircle" size={11} /> following</Chip>
                      : <Chip tone="danger"><Icon name="x" size={11} /> NOT following</Chip>}
                    <span className="mono" style={{ minWidth: 130 }}>{f.label}</span>
                    <span className="mono" style={{ color: 'var(--fg-3)' }}>#{f.neuron_id.toString()}</span>
                    <span className="mono">stake {fmtICP(f.stake_e8s)}</span>
                    <span className="mono" style={{ color: f.maturity_e8s > 0n ? 'var(--sprout-ink)' : 'var(--fg-3)' }}>
                      yield {fmtICP(f.maturity_e8s)} uncollected
                    </span>
                    <span className="mono" style={{ color: 'var(--fg-3)' }}>topics {f.topics_following_primary.join('/')}</span>
                    {f.error !== undefined && f.error !== null && <span style={{ color: 'var(--ember)', fontSize: 11 }}>{f.error}</span>}
                  </div>
                ))}
              </div>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Reads followees, stake and uncollected maturity straight from NNS governance (bypasses
              dashboard cache). Every platform neuron should follow the primary on topics 0
              (catch-all), 4 (Governance) and 14 (SNS). Tier-neuron yield harvests automatically once
              it crosses {config ? fmtICP(config.maturity_threshold_e8s) : '1.05'} ICP (then splits
              70/30 lottery/treasury); the Perm neuron settles its yield on the same cadence. "Run
              sweep now" on the Overview forces a harvest check immediately.
            </span>
          </div>

          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <Eyebrow>Split neurons — user unstakes the canister manages</Eyebrow>
              <Btn variant="ghost" sm onClick={refreshSplitNeurons} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
            </span>
            {splitNeurons === null && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Loading…</span>}
            {splitNeurons !== null && splitNeurons.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No unstakes yet — nothing is dissolving.</span>
            )}
            {splitNeurons !== null && splitNeurons.length > 0 && (
              <div className="col" style={{ gap: 4, maxHeight: 380, overflowY: 'auto' }}>
                {[...splitNeurons]
                  .sort((a, b) => {
                    const live = (u: PendingUnstake) => u.status === UnstakeStatus.Dissolving || u.status === UnstakeStatus.SplitDone ? 0 : 1;
                    return live(a) - live(b) || Number(a.dissolve_eta - b.dissolve_eta);
                  })
                  .map(u => (
                    <div key={u.id.toString()} className="row" style={{ gap: 10, fontSize: 12, flexWrap: 'wrap', alignItems: 'center', padding: '5px 8px', borderRadius: 6, background: 'var(--surface)' }}>
                      {u.status === UnstakeStatus.Disbursed ? <Chip tone="ok" style={{ height: 17, fontSize: 10 }}>disbursed</Chip>
                        : u.status === UnstakeStatus.Merged ? <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>restaked{u.merged_into !== undefined && u.merged_into !== null ? ` · ${u.merged_into}` : ''}</Chip>
                        : u.status === UnstakeStatus.Dissolving ? <Chip tone="pending" style={{ height: 17, fontSize: 10 }}>dissolving</Chip>
                        : <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>splitting</Chip>}
                      <a className="mono" href={`https://dashboard.internetcomputer.org/neuron/${u.split_neuron_id.toString()}`}
                        target="_blank" rel="noreferrer" style={{ color: 'var(--sprout-ink)' }}>
                        #{u.split_neuron_id.toString()}
                      </a>
                      <span className="mono">{fmtICP(u.amount_e8s)} ICP</span>
                      <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>{u.tier}</Chip>
                      <span className="mono" style={{ color: 'var(--fg-3)' }}>{formatPrincipal(u.user)}</span>
                      {(u.status === UnstakeStatus.Dissolving || u.status === UnstakeStatus.SplitDone) && (
                        <span className="mono" style={{ color: 'var(--fg-3)' }}>
                          done {new Date(Number(u.dissolve_eta / 1_000_000n)).toISOString().slice(0, 10)}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Every unstake splits its own neuron, dissolving for the tier's full term, then
              auto-disburses to the owner. Restaked rows are empty husks (their stake merged back
              into a pool); disbursed rows are history. These neurons never earn maturity for the
              protocol — their dissolve belongs entirely to the user.
            </span>
          </div>
        </>
      )}

      {/* ════ GOVERNANCE ════ */}
      {section === 'governance' && (
        <>
          <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
              <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <Eyebrow>Voting threshold</Eyebrow>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                  {config
                    ? (config.default_threshold_usd_e8s !== undefined && config.default_threshold_usd_e8s !== null
                      ? `$${(Number(config.default_threshold_usd_e8s) / 1e8).toFixed(2)}`
                      : `${fmtICP(config.default_threshold)} ICP (legacy)`)
                    : '…'}
                </span>
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input type="number" min="0.1" step="0.5" placeholder="New threshold (USD)" className="burn-input" style={inputStyle}
                  value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setThreshold} disabled={busy !== null || !thresholdInput}>
                  {busy === 'threshold' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Dollar-denominated: pots are valued at the live ICP/USD rate, so the bar to settle
                stays constant as the ICP price moves. Applies to new proposals and re-thresholds
                every open one.
              </span>
            </div>
            <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
              <Eyebrow>Settlement</Eyebrow>
              <Btn variant="secondary" sm onClick={triggerSweep} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                {busy === 'sweep' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} stroke="var(--burn-ink)" />} Trigger sweep now
              </Btn>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Proposals sitting in "met" settle on the next sweep — run it manually instead of
                waiting up to 5 minutes when you want a settlement to land immediately.
              </span>
            </div>
          </div>

          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <Eyebrow>Audit log — latest 25 events</Eyebrow>
              <Btn variant="ghost" sm onClick={refreshAudit} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
            </span>
            <div className="col" style={{ gap: 4, maxHeight: 360, overflowY: 'auto' }}>
              {auditTail.length === 0 && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No events yet (or still loading).</span>}
              {auditTail.map((e, i) => (
                <div key={i} className="row" style={{ gap: 10, fontSize: 11.5, padding: '5px 8px', borderRadius: 6, background: i % 2 ? 'transparent' : 'var(--surface)', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ color: 'var(--fg-3)', minWidth: 118 }}>
                    {new Date(Number(e.timestamp / 1_000_000n)).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  <Chip tone="muted" style={{ height: 17, fontSize: 10 }}>{e.event_type}</Chip>
                  <span className="mono">{fmtICP(e.amount_e8s)} ICP</span>
                  <span className="mono" style={{ color: 'var(--fg-3)' }}>{formatPrincipal(e.user)}</span>
                  <span className="mono" style={{ color: 'var(--fg-3)' }}>ref #{e.proposal_id.toString()}</span>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Append-only on-chain record of every money-moving event. The newest events are at the top.
            </span>
          </div>
        </>
      )}

      {/* ════ STAKING & LOTTERY ════ */}
      {section === 'staking' && (
        <>
          <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
              <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <Eyebrow>Lottery ticket grant</Eyebrow>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                  {base}/{base * 2}/{base * 4} per ICP/day
                </span>
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input type="number" min="1" step="1" placeholder="Base (6-month tier)" className="burn-input" style={inputStyle}
                  value={ticketsInput} onChange={(e) => setTicketsInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setTickets} disabled={busy !== null || !ticketsInput}>
                  {busy === 'tickets' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Tickets scale with staked ICP automatically; this sets the base per whole ICP.
              </span>
            </div>

            <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
              <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <Eyebrow>Pool initiation fee</Eyebrow>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                  {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP
                </span>
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input type="number" min="0" step="1" placeholder="New fee (ICP)" className="burn-input" style={inputStyle}
                  value={poolFeeInput} onChange={(e) => setPoolFeeInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setPoolFee} disabled={busy !== null || !poolFeeInput}>
                  {busy === 'poolfee' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
            </div>

            <div className="col" style={{ ...card, gap: 10, flex: '1 1 280px', minWidth: 260 }}>
              <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <Eyebrow>Staking minimums</Eyebrow>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                  {config ? `${fmtICP(config.min_stake_e8s)} / ${fmtICP(config.min_unstake_e8s)}` : '…'} ICP
                </span>
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input type="text" placeholder="Min stake" className="burn-input" style={inputStyle}
                  value={minStakeInput} onChange={(e) => setMinStakeInput(e.target.value)} />
                <input type="text" placeholder="Min unstake" className="burn-input" style={inputStyle}
                  value={minUnstakeInput} onChange={(e) => setMinUnstakeInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setStakingConfig} disabled={busy !== null || (!minStakeInput && !minUnstakeInput)}>
                  {busy === 'stakingcfg' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Min unstake floor is 1 ICP (whole-ICP rule). Leave a field empty to keep it.
              </span>
            </div>
          </div>

          <div className="col" style={{ ...card, gap: 10 }}>
            <Eyebrow>Sweeten the lottery pot</Eyebrow>
            <div className="row" style={{ gap: 8 }}>
              <input type="number" min="0" step="1" placeholder="Amount (ICP)" className="burn-input" style={{ ...inputStyle, maxWidth: 200 }}
                value={sweetenInput} onChange={(e) => setSweetenInput(e.target.value)} />
              <Btn variant="primary" sm onClick={sweetenPot} disabled={busy !== null || !sweetenInput}>
                {busy === 'sweeten' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="spark" size={13} stroke="var(--char-950)" />} Add to pot
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Transfers ICP from YOUR wallet straight into the prize pot. Players just see a bigger
              jackpot. (Admins hold no tickets, so you can never win your own deposit back.)
            </span>
          </div>
        </>
      )}

      {/* ════ FEATURES & CONTENT ════ */}
      {section === 'features' && (
        <>
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="zap" size={13} stroke="var(--burn-ink)" />
              <Eyebrow>Feature kill switches</Eyebrow>
            </span>
            <div className="col" style={{ gap: 0 }}>
              {/* Header row */}
              <div className="row" style={{ gap: 10, padding: '6px 8px', borderBottom: '1px solid var(--border-hi)', color: 'var(--fg-3)', fontSize: 11 }}>
                <span style={{ flex: '1 1 0' }}>Feature</span>
                <span style={{ flex: '0 0 70px' }}>State</span>
                <span style={{ flex: '0 0 96px', textAlign: 'right' }}>Toggle</span>
              </div>
              {featureFlags.map((f, i) => {
                const label = f.state === FlagState.On ? 'On' : f.state === FlagState.AdminOn ? 'Admin' : 'Off';
                const variant = f.state === FlagState.On ? 'primary' : f.state === FlagState.AdminOn ? 'secondary' : 'ghost';
                const tone = f.state === FlagState.On ? 'ok' : f.state === FlagState.AdminOn ? 'pending' : 'muted';
                return (
                  <div key={f.key} className="row" style={{
                    gap: 10, padding: '6px 8px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    background: i % 2 ? 'transparent' : 'var(--surface)',
                  }}>
                    <span className="mono" style={{ flex: '1 1 0', fontSize: 12.5 }}>{f.key}</span>
                    <span style={{ flex: '0 0 70px' }}><Chip tone={tone} style={{ height: 18, fontSize: 10.5 }}>{label}</Chip></span>
                    <span style={{ flex: '0 0 96px', display: 'flex', justifyContent: 'flex-end' }}>
                      <Btn
                        variant={variant} sm
                        onClick={() => cycleFlag(f.key, f.state)}
                        disabled={busy === `flag-${f.key}`}
                      >
                        {busy === `flag-${f.key}`
                          ? <LiveDot size={7} color="var(--fg)" />
                          : <Icon name={f.state === FlagState.On ? 'check' : f.state === FlagState.AdminOn ? 'key' : 'x'} size={12} stroke={f.state === FlagState.On ? 'var(--char-950)' : 'currentColor'} />}
                        {' '}{label}
                      </Btn>
                    </span>
                  </div>
                );
              })}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Click to cycle <b>Off</b> → <b>On</b> (everyone) → <b>Admin</b> (admins only — live preview/playtest). Instant, reversible.
            </span>
          </div>
        </>
      )}

      {section === 'content' && (
        <>
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="gamepad" size={13} stroke="var(--burn-ink)" />
              <Eyebrow>Mini Golf — course editor</Eyebrow>
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Repaint any hole's voxel layout cell by cell. Saving stores the layout on-chain and
              replaces the built-in hole for every player immediately; Reset reverts to the built-in.
            </span>
            <CourseEditor actor={actor} />
          </div>

        </>
      )}

      {/* ════ COURSE MODERATION ════ */}
      {section === 'moderation' && (
        <>
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="eye" size={13} stroke="var(--burn-ink)" />
                <Eyebrow>Low-rated courses — moderation candidates</Eyebrow>
              </span>
              <Btn variant="ghost" sm onClick={refreshModeration} disabled={busy !== null}><Icon name="undo" size={12} /> Refresh</Btn>
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Courses rated below 2.0★ with at least 5 ratings, worst first.{' '}
              <MoreInfo title="Course moderation">
                <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
                  <Eyebrow accent>The gist</Eyebrow>
                  <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                    Courses are <b>surfaced for review only — nothing auto-hides</b>. Both actions below
                    are admin-discretion and taken without warning to the owner.
                  </p>
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <Eyebrow accent>Your options</Eyebrow>
                  <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                    <li><b>Hide:</b> removes the course from the public marketplace — existing owners keep the NFT. Reversible.</li>
                    <li><b>Burn:</b> <span style={{ color: 'var(--ember-ink)' }}>permanently destroys the NFT and cannot be undone.</span></li>
                  </ul>
                </div>
              </MoreInfo>
            </span>

            {modCandidates === null && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Loading…</span>}
            {modCandidates !== null && modCandidates.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No low-rated courses — nothing to moderate.</span>
            )}
            {modCandidates !== null && modCandidates.length > 0 && (
              <div className="col" style={{ gap: 0 }}>
                {/* Header row */}
                <div className="row" style={{ gap: 10, padding: '6px 8px', borderBottom: '1px solid var(--border-hi)', color: 'var(--fg-3)', fontSize: 11 }}>
                  <span style={{ flex: '0 0 70px' }}>Token</span>
                  <span style={{ flex: '1 1 0' }}>Owner</span>
                  <span style={{ flex: '0 0 80px' }}>Rating</span>
                  <span style={{ flex: '0 0 64px' }}>Ratings</span>
                  <span style={{ flex: '0 0 70px' }}>Status</span>
                  <span style={{ flex: '0 0 180px', textAlign: 'right' }}>Actions</span>
                </div>
                {modCandidates.map((c, i) => (
                  <div key={c.token_id.toString()} className="row" style={{
                    gap: 10, padding: '6px 8px', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                    background: i % 2 ? 'transparent' : 'var(--surface)',
                  }}>
                    <span className="mono" style={{ flex: '0 0 70px', fontSize: 12.5 }}>#{c.token_id.toString()}</span>
                    <span className="mono" style={{ flex: '1 1 0', fontSize: 12, color: 'var(--fg-3)' }}>
                      {c.owner ? formatPrincipal(c.owner) : 'unowned'}
                    </span>
                    <span className="mono" style={{ flex: '0 0 80px', fontSize: 12.5 }}>{(c.avg_x10 / 10).toFixed(1)} ★</span>
                    <span className="mono" style={{ flex: '0 0 64px', fontSize: 12.5, color: 'var(--fg-3)' }}>{c.rating_count}</span>
                    <span style={{ flex: '0 0 70px' }}>
                      <Chip tone={c.hidden ? 'muted' : 'ok'} style={{ height: 18, fontSize: 10.5 }}>{c.hidden ? 'hidden' : 'visible'}</Chip>
                    </span>
                    <span className="row" style={{ flex: '0 0 180px', gap: 6, justifyContent: 'flex-end' }}>
                      <Btn variant="secondary" sm onClick={() => hideCourse(c)} disabled={busy !== null}>
                        {busy === `mod-hide-${c.token_id}` ? <LiveDot size={7} /> : <Icon name={c.hidden ? 'eye' : 'x'} size={12} stroke="var(--burn-ink)" />}
                        {c.hidden ? 'Unhide' : 'Hide'}
                      </Btn>
                      <Btn variant="danger" sm onClick={() => burnCourse(c)} disabled={busy !== null}>
                        {busy === `mod-burn-${c.token_id}` ? <LiveDot size={7} color="var(--ember)" /> : <Icon name="flame" size={12} stroke="currentColor" />}
                        Burn
                      </Btn>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ════ USERS ════ */}
      {section === 'users' && (
        <>
          <div className="col" style={{ ...card, gap: 10 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span className="row" style={{ gap: 8 }}>
                <Icon name="list" size={13} stroke="var(--burn-ink)" />
                <Eyebrow>User wallet balances</Eyebrow>
              </span>
              <Btn variant="ghost" sm onClick={loadUserBalances} disabled={busy !== null}>
                <Icon name="undo" size={12} /> {userRows === null ? 'Load' : 'Reload'}
              </Btn>
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Every known participant — the union across voting, staking, lottery, ideas,
              project funding, discussions, pool neurons and X-Farm — and the balance held in
              their <b>own wallet</b> on each ledger. Fetched in batches (5 ledger reads per
              user), so a large user base takes a moment.
            </span>

            {userProgress && busy === 'users' && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                Loading balances… {userProgress.done}/{userProgress.total}
              </span>
            )}
            {userRows !== null && userRows.length === 0 && busy !== 'users' && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No participants yet.</span>
            )}

            {userRows !== null && userRows.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--fg-3)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Principal</th>
                      {USER_BAL_COLS.map(c => (
                        <th key={c.key} style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {userRows.map(r => (
                      <tr key={r.principal.toText()} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="mono" style={{ padding: '4px 8px', textAlign: 'left' }} title={r.principal.toText()}>
                          {formatPrincipal(r.principal)}
                        </td>
                        {USER_BAL_COLS.map(c => (
                          <td key={c.key} className="mono" style={{ padding: '4px 8px', textAlign: 'right' }}>
                            {fmtUnits(r[c.key], c.dec)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border-hi)', fontWeight: 600 }}>
                      <td style={{ padding: '6px 8px', textAlign: 'left' }}>TOTAL ({userRows.length})</td>
                      {USER_BAL_COLS.map(c => (
                        <td key={c.key} className="mono" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--burn-ink)' }}>
                          {fmtUnits(userRows.reduce((s, r) => s + r[c.key], 0n), c.dec)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ════ REFERENCE ════ */}
      {section === 'reference' && (
        <>
          <div className="col" style={{ gap: 6 }}>
            <Eyebrow accent>How each feature works</Eyebrow>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              The exact money flows, verbatim from the canister logic.
            </span>
          </div>

          <Section icon="flame" title="Burn voting — conviction with skin in the game">
            <Li>Users register a neuron, follow the community leader, then commit ICP to a tracked NNS proposal with an adopt or reject stance. Minimum 1 ICP; one commitment per proposal (top-ups allowed); no fees — the treasury fronts all ledger fees so refunds are exact.</Li>
            <Li>Committed ICP sits in a per-user escrow subaccount until the proposal's deadline (commits close 1 hour before).</Li>
            <Li>At cutoff, if total committed (burned) ICP meets the threshold, the side with more committed ICP decides the NNS vote (ties go to the first stance cast). Voting is burn-only — staking grants no voting power.</Li>
            <Li><b>Vote succeeds → the escrow burns:</b> 50% to the treasury, 25% to backend cycles, 25% to frontend cycles. Burns are recorded per user and power the leaderboard stats.</Li>
            <Li><b>Threshold unmet or the NNS vote fails → full refund.</b> A failed NNS call can never burn funds (F-102 invariant).</Li>
            <Li>Every transfer is journaled with per-leg block indices; the 5-minute sweep retries any failed leg without ever double-spending.</Li>
          </Section>

          <Section icon="target" title="Neuron Syndicate — earn 25% of every burn">
            <Li>Neuron owners pay a one-time initiation fee (current: {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP, split 50% treasury / 25% backend cycles / 25% frontend cycles) to register their neuron in the Neuron Syndicate.</Li>
            <Li>When a proposal settles as burned, 25% of the burned total is split equally among the owners of the top 100 Neuron Syndicate neurons by voting power (ties for the last slot go to the higher voting power), paid from the treasury.</Li>
            <Li>Each payout lands in the recipient's wallet and their payout history. Deactivating keeps the registration — reactivating never re-charges the fee.</Li>
          </Section>

          <Section icon="zap" title="Lossless staking — three terms, one principal, zero loss">
            <Li>Three pooled NNS neurons, one per term: 6 months, 1 year, 2 years. Your ICP joins the term's neuron; your principal is never spent. Every neuron is made PUBLIC on the NNS the moment it's configured — anyone can audit it on the dashboard.</Li>
            <Li>Staking grants <b>no voting power</b> — voting is burn-only. Staking's sole reward is lottery eligibility: the term length scales the daily ticket grant (6mo / 1y / 2y → 5 / 10 / 20 tickets per ICP per day).</Li>
            <Li>Whole-ICP amounts only. Unstake any time: the tier's neuron splits, the split dissolves for the full term, then the FULL amount lands back in your wallet automatically — the treasury fronts every neuron fee. Zero-loss means zero: commit X, get X back. A dissolving unstake can also be RESTAKED into any tier (merge; treasury fronts that fee too).</Li>
            <Li>Neuron maturity harvests once it crosses ~1.05 ICP and is split <b>70% lottery prize pot / 30% treasury</b> — all the staking neurons feed the same pot.</Li>
            <Li>Staking is also the lottery's eligibility gate (below).</Li>
          </Section>

          <Section icon="spark" title="Lossless lottery — dynamic odds, funded by yield">
            <Li>Stakers only — and eligibility is live: daily grant = base ({base}) × term multiplier × whole ICP staked, claimed automatically on login. Fully unstake and any tickets already held void immediately; the same happens on promotion to admin.</Li>
            <Li>Drawings 3× a week (Mon/Wed/Sat nights US Eastern), but a drawing only runs when the pot holds at least 25 ICP — below that it rolls over and the pot keeps growing. Odds are dynamic: every drawing that runs has a 1-in-13 chance of paying out regardless of ticket supply (≈ one winner a month, 96% chance within 3 months), decided by on-chain randomness (raw_rand). A user's win chance is their share of all tickets.</Li>
            <Li>Tickets accumulate round over round until someone hits. The winner takes 65% of the prize pot; 30% seeds the next round; 5% is burned to backend-canister cycles; all tickets reset.</Li>
            <Li>The pot is funded purely by staking yield — players never pay in, so nobody can lose money.</Li>
            <Li>Prize payouts are journaled and retried until the transfer lands; a win can never be paid twice or lost.</Li>
          </Section>

          <Section icon="bulb" title="Community R&D — ideas and projects">
            <Li>Posting an idea costs 1 ICP (anti-spam, 100% to treasury). Ideas die after 30 days without an upvote.</Li>
            <Li>Upvoting is <b>free</b> — no token is collected — and each user may upvote a given idea once. Every upvote resets that idea's 30-day expiry clock.</Li>
            <Li>Projects are admin-curated with a single <b>USD funding goal</b> and accept any supported token (ICP, ckBTC, ckETH); contributions go 100% to the treasury, which pays for execution.</Li>
          </Section>

          <Section icon="spark" title="Perm tier — the platform's permanent stake">
            <Li>Permanent (no unstake, by design) stake into a platform-controlled 2-year neuron that follows the primary on every topic. Open to everyone, forever — no membership cap or close.</Li>
            <Li>Perm stakes earn <b>lottery tickets only</b>: a flat 40 tickets/day per whole ICP staked. No ICP yield is ever paid to Perm stakers.</Li>
            <Li>The Perm neuron's harvested yield is split <b>30% treasury / 70% lottery prize pot</b> — never distributed to users.</Li>
          </Section>

          <Section icon="coins" title="Payout history — every satoshi accounted for">
            <Li>Every transfer the canister makes to a user is recorded: lottery jackpots, unstake disbursements, commitment refunds, and Neuron Syndicate rewards.</Li>
            <Li>Each record carries the token, amount, timestamp and source id — the user-facing mirror of the append-only audit log.</Li>
          </Section>

          <Section icon="wallet" title="Treasury & cycles — how the lights stay on">
            <Li>Treasury inflows: 50% of burns, 50% of staking yield, 50% of Perm-neuron yield, idea post fees, project funding, Neuron Syndicate initiation fees, explorer and arcade payments.</Li>
            <Li>Cycles: 25% of each burn tops up each canister via the CMC. If the backend dips below 5T cycles, the sweep auto-converts treasury ICP into cycles (two-phase, idempotent).</Li>
            <Li>Withdrawals and neuron allocations are guarded by the 15 ICP floor (override available) — below ~10 ICP the cycle top-up silently stops.</Li>
          </Section>
        </>
      )}
    </div>
  );
}
