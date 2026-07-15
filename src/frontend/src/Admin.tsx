import { useState, useEffect } from 'react';
import { logRealError } from './errors';
import { ExplorerToken } from "./bindings/backend";
import { UnstakeStatus } from "./bindings/backend";
import { FlagState } from "./bindings/backend";
import type { Config, FeatureFlag, GlobalStats, LotteryInfo, EarlyAdopterInfo, StakingPoolInfo, PoolInfo, NeuronFollowStatus, AuditLogEntry, StakeTier, PendingUnstake } from "./bindings/backend";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { ModerationCandidate, UserBalanceRow, SeenUser } from "./bindings/backend";
import { Principal } from "@icp-sdk/core/principal";
import { Icon, Eyebrow, Btn, Chip, LiveDot, MoreInfo, fmtICP, formatPrincipal } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// Admin console — four tabs, money first (owner redo 2026-07-10):
//   Money        — every fund as ONE card: balance big on top, its
//                  controls directly beneath (treasury, buyback, pot,
//                  cycles). Opens with a one-line summary strip.
//   Economics    — every dial with its live value beside the input
//                  (lottery, vouchers, Golden Ticket, staking, LP stats).
//   Pools & Users— neurons, term pools, unstakes; then principals,
//                  wallet balances, course moderation.
//   System       — kill switches, wiring, sweep, audit, reference.
// EVERYTHING auto-loads on mount (Promise.allSettled — one failure never
// blanks the page); the ONLY refresh button is "Refresh all" in the header.
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
  /** Which console page renders — the NAV is the tab bar now (each section
   *  is its own page under the admin-only nav group, owner 2026-07-11). */
  section: AdminSection;
}

export type AdminSection = 'money' | 'economics' | 'neurons' | 'users' | 'system' | 'reference';

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

// Nanoseconds (IC time) → "YYYY-MM-DD HH:MM" UTC. Matches the audit-log formatting above.
function fmtSeenNs(ns: bigint): string {
  if (!ns) return '—';
  return new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 16).replace('T', ' ');
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

// A plain admin section: labeled heading with a thin bottom rule, then the
// data directly beneath — no card box (owner 2026-07-11).
function Sec({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <span className="row" style={{ gap: 8, justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
        <Eyebrow>{label}</Eyebrow>
        {right}
      </span>
      {children}
    </div>
  );
}

// Standard admin table: mono uppercase column head, border-separated rows.
function ATable({ cols, children }: { cols: { label: string; align?: 'left' | 'right' }[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: 'auto', width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="mono" style={{ textAlign: c.align ?? 'left', padding: '4px 8px', fontWeight: 500, fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase', borderBottom: '1px solid var(--border-hi)' }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Feature-off gate: renders children when the flag is on (or admin-on, so
// admins can still manage a preview), else a compact "off — enable" row wired
// to the same flag toggle used by the kill-switch table.
function FeatureGate({ flagKey, label, flags, busy, onToggle, children }: {
  flagKey: string; label: string; flags: FeatureFlag[]; busy: string | null;
  onToggle: (key: string, state: FlagState) => void; children: React.ReactNode;
}) {
  const f = flags.find(x => x.key === flagKey);
  if (f && f.state !== FlagState.Off) return <>{children}</>;
  return (
    <Sec label={label} right={<Chip tone="muted">off</Chip>}>
      <span className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{label} is off — enable it to manage its settings.</span>
        <Btn variant="primary" sm onClick={() => onToggle(flagKey, f?.state ?? FlagState.Off)} disabled={busy === `flag-${flagKey}`}>
          {busy === `flag-${flagKey}` ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="spark" size={12} stroke="var(--char-950)" />} Enable
        </Btn>
      </span>
    </Sec>
  );
}

const Li = ({ children }: { children: React.ReactNode }) => (
  <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
    <span style={{ color: 'var(--burn-ink)', lineHeight: '19px' }}>·</span>
    <span style={{ flex: 1 }}>{children}</span>
  </span>
);

export default function Admin({ actor, config, featureFlags, identity, host, rootKey, ledgerCanisterId, onChanged, openTreasury, section }: AdminProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useErrorImpression(error, 'admin');
  // Each section is its own page now — moving between them clears banners.
  useEffect(() => { setError(null); setNotice(null); }, [section]);

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
  const [nftCycles, setNftCycles] = useState<bigint | 'unavailable' | null>(null);
  const [topupAmount, setTopupAmount] = useState('1'); // T cycles
  const [lottery, setLottery] = useState<LotteryInfo | null>(null);
  const [ea, setEa] = useState<EarlyAdopterInfo | null>(null);
  const [staking, setStaking] = useState<StakingPoolInfo | null>(null);
  const [buybackFundE8s, setBuybackFundE8s] = useState<bigint | null>(null);
  const [buybackFundAmt, setBuybackFundAmt] = useState('');
  const [buybackWithdrawAmt, setBuybackWithdrawAmt] = useState('');
  // The whole market info (fund balance + voucher economics + promo campaign)
  // in one query — Funds and Lottery & Staking both read it.
  const [voucherMkt, setVoucherMkt] = useState<{
    market_fee_bps: number; min_wrap_e8s: bigint; buyback_discount_bps: number;
    buyback_fund_e8s: bigint; promo_open: boolean; promo_remaining: number; promo_claims_today: number;
  } | null>(null);
  const loadVoucherMarket = async () => {
    if (!actor) return;
    try {
      const m = await actor.get_bond_market();
      setVoucherMkt(m);
      setBuybackFundE8s(m.buyback_fund_e8s);
    } catch { /* surfaced by dash */ }
  };
  const loadBuybackFund = loadVoucherMarket;
  const [vFeeInput, setVFeeInput] = useState('');
  const [vMinWrapInput, setVMinWrapInput] = useState('');
  const setVoucherConfig = () => run('vconfig', async () => {
    const fee = vFeeInput ? parseFloat(vFeeInput) : null;
    const minWrap = vMinWrapInput ? parseUnits(vMinWrapInput, 8) : null;
    if (fee === null && minWrap === null) throw new Error('Enter a fee % and/or a minimum wrap.');
    if (fee !== null && (!isFinite(fee) || fee < 0 || fee > 100)) throw new Error('Fee must be 0-100%.');
    const res = await actor.admin_set_bond_config(fee !== null ? Math.round(fee * 100) : null, minWrap);
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    setVFeeInput(''); setVMinWrapInput('');
    await loadVoucherMarket();
    return 'Bond economics updated.';
  });
  const setPromoCampaign = (open: boolean) => run('promo', async () => {
    const res = await actor.admin_set_promo_campaign(open);
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    await loadVoucherMarket();
    return open ? 'Golden Ticket campaign OPENED — the claim page is live.' : 'Campaign closed — claims stop immediately.';
  });
  // Canister wiring (System): point the backend at NFT canisters.
  const [wireVoucherInput, setWireVoucherInput] = useState('');
  const [wireCourseInput, setWireCourseInput] = useState('');
  const wireCanister = (kind: 'voucher' | 'course') => run(`wire-${kind}`, async () => {
    const text = (kind === 'voucher' ? wireVoucherInput : wireCourseInput).trim();
    let target: Principal;
    try { target = Principal.fromText(text); } catch { throw new Error('Not a valid canister principal.'); }
    const res = kind === 'voucher'
      ? await actor.admin_set_voucher_nft_canister(target)
      : await actor.admin_set_course_nft_canister(target);
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    if (kind === 'voucher') setWireVoucherInput(''); else setWireCourseInput('');
    return `${kind === 'voucher' ? 'Bond' : 'Course'} NFT canister wired to ${formatPrincipal(target)}.`;
  });
  const fundBuyback = () => run('buybackfund', async () => {
    const icp = parseFloat(buybackFundAmt);
    if (!isFinite(icp) || icp <= 0) throw new Error('Enter a positive ICP amount.');
    const res = await actor.admin_fund_buyback_from_treasury(BigInt(Math.round(icp * 1e8)));
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    setBuybackFundAmt('');
    await loadBuybackFund();
    return `Moved ${icp} ICP from the treasury into the buyback fund.`;
  });
  const withdrawBuyback = () => run('buybackwithdraw', async () => {
    const icp = parseFloat(buybackWithdrawAmt);
    if (!isFinite(icp) || icp <= 0) throw new Error('Enter a positive ICP amount.');
    const res = await actor.admin_withdraw_buyback(identity.getPrincipal(), BigInt(Math.round(icp * 1e8)));
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    setBuybackWithdrawAmt('');
    await loadBuybackFund();
    return `Withdrew ${icp} ICP from the buyback fund to your wallet.`;
  });
  const [lpPoolStats, setLpPoolStats] = useState<{ pool: any; name: string; positions: bigint; token0_symbol: string; token0_amount: bigint; token1_symbol: string; token1_amount: bigint; usd_e8s: bigint; error?: string | null }[] | null>(null);
  const [lpStatsBusy, setLpStatsBusy] = useState(false);
  const loadLpPoolStats = async () => {
    if (!actor || lpStatsBusy) return;
    setLpStatsBusy(true);
    try {
      const res = await actor.admin_get_icp_lp_pool_stats();
      if (res.__kind__ === 'Ok') setLpPoolStats(res.Ok);
    } catch { /* surfaced by the empty state */ }
    finally { setLpStatsBusy(false); }
  };
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
      logRealError('admin', err);
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
    const [st, cy, lot, eaInfo, stk, pl, fe, nft] = await Promise.all([
      grab<GlobalStats>(() => actor.get_global_stats()),
      grab<bigint>(() => actor.get_cycle_balance()),
      grab<LotteryInfo>(() => actor.get_lottery_info()),
      grab<EarlyAdopterInfo>(() => actor.get_early_adopter_info()),
      grab<StakingPoolInfo>(() => actor.get_staking_pool_info()),
      grab<PoolInfo>(() => actor.get_pool_info()),
      grab<{ __kind__: string; Ok?: bigint; Err?: string }>(() => actor.admin_get_frontend_cycles()),
      grab<{ __kind__: string; Ok?: bigint; Err?: string }>(() => actor.admin_get_course_nft_cycles()),
    ]);
    setStats(st); setCycles(cy); setLottery(lot); setEa(eaInfo); setStaking(stk); setPool(pl);
    setFeCycles(fe === null ? null : fe.__kind__ === 'Ok' ? fe.Ok! : 'unavailable');
    setNftCycles(nft === null ? null : nft.__kind__ === 'Ok' ? nft.Ok! : 'unavailable');
  };

  // ── quick cycle top-ups (backend balance → target canister) ────────────────
  const sendCycles = (target: 'frontend' | 'course_nft') => run(`cycles-${target}`, async () => {
    const t = parseFloat(topupAmount);
    if (isNaN(t) || t <= 0) { setError('Enter a T-cycles amount above 0.'); return null; }
    const amount = BigInt(Math.round(t * 1e12));
    const res = target === 'frontend'
      ? await actor.admin_send_cycles_to_frontend(amount)
      : await actor.admin_send_cycles_to_course_nft(amount);
    if (res.__kind__ === 'Err') throw new Error(res.Err);
    await refreshHealth();
    return `Sent ${t} T cycles from the backend to the ${target === 'frontend' ? 'frontend' : 'course NFT'} canister.`;
  });

  const refreshAudit = async () => {
    if (!actor) return;
    try {
      // The log is append-only; fetch a big window and keep the newest 25.
      const entries: AuditLogEntry[] = await actor.get_audit_log(0n, 1000n);
      setAuditTail(entries.slice(-25).reverse());
    } catch { /* transient */ }
  };

  // Silent (no busy/notice) variants for the auto-load path — the owner's
  // rule: every number loads itself; no Load buttons anywhere.
  const refreshFollowing = async () => {
    if (!actor) return;
    try { setFollowStatus(await actor.admin_check_neuron_following()); } catch { /* transient */ }
  };
  const loadSeenUsersSilent = async () => {
    if (!actor) return;
    try { setSeenUsers(await actor.admin_list_seen_users()); } catch { /* transient */ }
  };
  const loadUserBalancesSilent = async () => {
    if (!actor) return;
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
      setUserProgress(null);
    } catch { /* transient */ }
  };

  // ONE loader for the whole console — fired on mount and by "Refresh all".
  // allSettled: a single failing fetch can never blank the page.
  const loadEverything = () => {
    if (!actor) return;
    void Promise.allSettled([
      refreshHealth(),
      refreshBalances(),
      loadVoucherMarket(),
      loadLpPoolStats(),
      refreshSplitNeurons(),
      refreshAudit(),
      refreshModeration(),
      refreshFollowing(),
      loadSeenUsersSilent(),
      loadUserBalancesSilent(),
    ]);
  };
  useEffect(() => {
    loadEverything();
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
    return `Base ticket grant set to ${n} per ICP per day (tiers pay ${Math.max(1, Math.floor(n / 5))}/${n}/${n * 2}/${n * 4} for 2wk/6mo/1yr/2yr).`;
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

  const refreshSplitNeurons = async () => {
    if (!actor) return;
    try {
      const all: PendingUnstake[] = await actor.admin_list_pending_unstakes();
      setSplitNeurons(all);
    } catch { /* transient */ }
  };


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

  // Every principal that has ever logged in (the backend's SEEN_USERS registry),
  // with first/last-seen timestamps. One query, zero ledger outcalls — loads
  // instantly regardless of user count. This is the "all logged-in principals"
  // view (includes zero-balance / no-action users); the balance table below is
  // the heavier per-wallet breakdown.
  const [seenUsers, setSeenUsers] = useState<[Principal, SeenUser][] | null>(null);



  // Local dev only: populate the table with fabricated rows so the layout/totals
  // can be eyeballed without real participants or funded wallets. Uses real,
  // valid principals (well-known canister IDs) purely as display placeholders.
  const loadMockUsers = () => {
    const mk = (text: string, icp: bigint, ckbtc: bigint, cketh: bigint, ckusdc: bigint, ckusdt: bigint): UserBalanceRow =>
      ({ principal: Principal.fromText(text), icp, ckbtc, cketh, ckusdc, ckusdt });
    setUserProgress(null);
    setUserRows([
      mk('ryjl3-tyaaa-aaaaa-aaaba-cai', 1_240_000_000n, 150_000n, 50_000_000_000_000_000n, 100_000_000n, 0n),
      mk('rrkah-fqaaa-aaaaa-aaaaq-cai', 310_000_000n, 0n, 0n, 50_000_000n, 25_000_000n),
      mk('rdmx6-jaaaa-aaaaa-aaadq-cai', 9_900_000_000n, 1_000_000n, 2_500_000_000_000_000_000n, 0n, 0n),
      mk('renrk-eyaaa-aaaaa-aaada-cai', 5_000_000n, 0n, 0n, 0n, 1_000_000n),
      mk('qoctq-giaaa-aaaaa-aaaea-cai', 0n, 25_000n, 0n, 250_000_000n, 0n),
    ]);
    setError(null);
    setNotice('Loaded mock users (local dev — fabricated data).');
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

  // Sections are borderless now (owner 2026-07-11): plain gap-separated
  // <Sec> blocks, no card boxes.
  const flagOn = (key: string) => {
    const f = featureFlags.find(x => x.key === key);
    return !!f && f.state !== FlagState.Off;
  };
  const inputStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', flex: 1 };
  const base = config ? Number(config.lottery_tickets_per_day) : 5;
  const treasuryIcp = balances['ICP'] ?? null;
  const floorTone = treasuryIcp === null ? undefined : treasuryIcp < TREASURY_FLOOR ? 'bad' : treasuryIcp < 2_000_000_000n ? 'warn' : 'ok';

  return (
    <div className="dashboard-container">
      {/* ── Header — one Refresh-all for the whole console ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8, width: '100%', flexWrap: 'wrap' }}>
          <Icon name="key" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Admin console</Eyebrow>
          <Btn variant="secondary" sm onClick={loadEverything} disabled={busy !== null} style={{ marginLeft: 'auto' }}>
            <Icon name="refresh" size={12} /> Refresh all
          </Btn>
        </span>
        <b style={{ fontSize: 17 }}>Money first. Everything loads itself.</b>
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

      {/* ════ MONEY — funds as plain sections: big balance + controls beneath ════ */}
      {section === 'money' && (() => {
        const pot = lottery?.pot_e8s ?? null;
        const lotteryOn = flagOn('lossless_lottery');
        const underMgmt = treasuryIcp !== null && buybackFundE8s !== null && pot !== null
          ? treasuryIcp + buybackFundE8s + pot : null;
        const big: React.CSSProperties = { fontSize: 22, lineHeight: 1.1 };
        const pending = <LiveDot size={8} color="var(--burn-ink)" />;
        return (
          <>
            {/* One-line summary strip — plain text, no tiles, no links. */}
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              Under management: <b style={{ color: 'var(--fg)' }}>{underMgmt !== null ? fmtICP(underMgmt) : '…'} ICP</b>
              {' '}(treasury {treasuryIcp !== null ? fmtICP(treasuryIcp) : '…'} · buyback {buybackFundE8s !== null ? fmtICP(buybackFundE8s) : '…'} · pot {pot !== null ? fmtICP(pot) : '…'})
              {' '}— staking TVL <b style={{ color: 'var(--fg)' }}>{staking ? fmtICP(staking.total_staked_e8s) : '…'} ICP</b>
              {' '}— {lottery ? lottery.unique_holders.toString() : '…'} players
              {' '}— {stats ? fmtICP(stats.total_burned_e8s) : '…'} ICP burned lifetime
            </span>

            {/* ── Treasury (always shown) ── */}
            <Sec label="Treasury" right={treasuryIcp !== null && treasuryIcp < TREASURY_FLOOR
              ? <Chip tone="danger">BELOW the 15 ICP floor — cycle top-ups at risk</Chip> : undefined}>
              <span className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b className="mono" style={{ ...big, color: floorTone === 'bad' ? 'var(--ember)' : 'var(--fg)' }}>
                  {treasuryIcp !== null ? fmtICP(treasuryIcp) : pending} ICP
                </b>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                  {TOKEN_META.filter(t => t.token !== ExplorerToken.ICP).map(({ token, label, decimals }) =>
                    `${balances[token] !== undefined && balances[token] !== null ? fmtUnits(balances[token]!, decimals) : '…'} ${label}`
                  ).join(' · ')}
                </span>
              </span>
              {/* Deposit */}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)', minWidth: 72 }}>Deposit</span>
                {TOKEN_META.map(({ token, label }) => (
                  <Btn key={token} variant={depToken === token ? 'primary' : 'ghost'} sm onClick={() => setDepToken(token)}>{label}</Btn>
                ))}
                <input type="text" placeholder={`Amount (${depMeta.label})`} className="burn-input" style={{ ...inputStyle, maxWidth: 160 }}
                  value={depAmount} onChange={e => setDepAmount(e.target.value)} />
                <Btn variant="secondary" sm onClick={depositToken} disabled={busy !== null || !depAmount}>
                  {busy === 't-deposit' ? <LiveDot size={7} /> : <Icon name="arrowUp" size={13} stroke="var(--burn-ink)" />} From my wallet
                </Btn>
              </div>
              {/* Withdraw */}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)', minWidth: 72 }}>Withdraw</span>
                {TOKEN_META.map(({ token, label }) => (
                  <Btn key={token} variant={txToken === token ? 'primary' : 'ghost'} sm onClick={() => setTxToken(token)}>{label}</Btn>
                ))}
                <input type="text" placeholder={`Amount (${meta.label})`} className="burn-input" style={{ ...inputStyle, maxWidth: 140 }}
                  value={txAmount} onChange={e => setTxAmount(e.target.value)} />
                <input type="text" placeholder="Destination (empty = you)" className="burn-input" style={{ ...inputStyle, minWidth: 190 }}
                  value={txDest} onChange={e => setTxDest(e.target.value)} />
                <Btn variant="primary" sm onClick={withdrawToken} disabled={busy !== null || !txAmount}>
                  {busy === 't-withdraw' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="wallet" size={13} stroke="var(--char-950)" />} Withdraw
                </Btn>
                <label className="row" style={{ gap: 6, fontSize: 12, color: overrideFloor ? 'var(--ember)' : 'var(--fg-3)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={overrideFloor} onChange={e => setOverrideFloor(e.target.checked)} />
                  Override 15 ICP floor
                </label>
              </div>
              {/* Allocate to neurons */}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)', minWidth: 72 }}>Allocate</span>
                {[['TwoWeeks', '2-wk pool'], ['SixMonths', '6-mo pool'], ['OneYear', '1-yr pool'], ['TwoYears', '2-yr pool'], ['EarlyAdopters', 'Perm']].map(([key, label]) => (
                  <Btn key={key} variant={allocTarget === key ? 'primary' : 'ghost'} sm onClick={() => setAllocTarget(key)}>{label}</Btn>
                ))}
                <input type="text" placeholder="Amount (ICP)" className="burn-input" style={{ ...inputStyle, maxWidth: 140 }}
                  value={allocAmount} onChange={e => setAllocAmount(e.target.value)} />
                <Btn variant="primary" sm onClick={allocateToNeuron} disabled={busy !== null || !allocAmount}>
                  {busy === 't-allocate' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Allocate
                </Btn>
              </div>
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                ICP is the operational reserve (cycle top-ups + fee fronting) — withdrawals and
                allocations below the 15 ICP floor are refused unless overridden. Allocations move
                treasury ICP into a neuron's stake permanently (getting it back means a dissolve);
                tier allocations boost that pool's yield → the lottery pot.{' '}
                <a onClick={openTreasury} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Legacy ICP dialog…</a>
              </span>
            </Sec>

            {/* ── Buyback wallet + Lottery pot: only when the lottery is on ── */}
            {lotteryOn ? (
              <>
                <Sec label="Bond buyback wallet">
                  <b className="mono" style={big}>{buybackFundE8s !== null ? fmtICP(buybackFundE8s) : pending} ICP</b>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="number" min="0" step="0.1" placeholder="ICP from treasury" className="burn-input" style={{ ...inputStyle, maxWidth: 170 }}
                      value={buybackFundAmt} onChange={(e) => setBuybackFundAmt(e.target.value)} />
                    <Btn variant="primary" sm onClick={fundBuyback} disabled={busy !== null || !buybackFundAmt}>
                      {busy === 'buybackfund' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="zap" size={12} stroke="var(--char-950)" />} Fund from treasury
                    </Btn>
                    <input type="number" min="0" step="0.1" placeholder="ICP to withdraw" className="burn-input" style={{ ...inputStyle, maxWidth: 170 }}
                      value={buybackWithdrawAmt} onChange={(e) => setBuybackWithdrawAmt(e.target.value)} />
                    <Btn variant="secondary" sm onClick={withdrawBuyback} disabled={busy !== null || !buybackWithdrawAmt}>
                      {busy === 'buybackwithdraw' ? <LiveDot size={7} /> : <Icon name="wallet" size={12} />} Withdraw to my wallet
                    </Btn>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    Pays instant bond exits (85% of principal); the option auto-disables for users when
                    this can't cover a sale. Replenished by dissolved principals + the fund's third of
                    fees. External top-ups: backend canister, subaccount <span className="mono">0x0a×32</span>.
                  </span>
                </Sec>

                <Sec label="Lottery pot" right={lottery && lottery.pot_e8s < lottery.min_pot_e8s
                  ? <Chip tone="pending">below the {fmtICP(lottery.min_pot_e8s)} ICP draw minimum — rolls over</Chip> : undefined}>
                  <span className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <b className="mono" style={big}>{lottery ? fmtICP(lottery.pot_e8s) : pending} ICP</b>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                      {lottery ? `${lottery.total_tickets.toString()} tickets · ${lottery.unique_holders.toString()} players · ${fmtICP(lottery.total_paid_e8s)} ICP paid lifetime` : ''}
                    </span>
                  </span>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="number" min="0" step="1" placeholder="Amount (ICP)" className="burn-input" style={{ ...inputStyle, maxWidth: 170 }}
                      value={sweetenInput} onChange={(e) => setSweetenInput(e.target.value)} />
                    <Btn variant="primary" sm onClick={sweetenPot} disabled={busy !== null || !sweetenInput}>
                      {busy === 'sweeten' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="spark" size={13} stroke="var(--char-950)" />} Sweeten from my wallet
                    </Btn>
                    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                      Straight into the jackpot (admins hold no tickets — you can never win it back).
                    </span>
                  </div>
                </Sec>
              </>
            ) : (
              <FeatureGate flagKey="lossless_lottery" label="Lottery & bonds" flags={featureFlags} busy={busy} onToggle={cycleFlag}>
                <span />
              </FeatureGate>
            )}
          </>
        );
      })()}

      {/* ════ ECONOMICS — every dial, live value beside the input ════ */}
      {/* ════ ECONOMICS — every dial, live value beside the input ════ */}
      {section === 'economics' && (
        <>
          <FeatureGate flagKey="lossless_lottery" label="Lottery & bond dials" flags={featureFlags} busy={busy} onToggle={cycleFlag}>
            <Sec label="Lottery ticket grant" right={<span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>{Math.max(1, Math.floor(base / 5))}/{base}/{base * 2}/{base * 4} per ICP/day</span>}>
              <div className="row" style={{ gap: 8 }}>
                <input type="number" min="1" step="1" placeholder="Base (6-month tier)" className="burn-input" style={inputStyle}
                  value={ticketsInput} onChange={(e) => setTicketsInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setTickets} disabled={busy !== null || !ticketsInput}>
                  {busy === 'tickets' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Tickets scale with staked ICP automatically; this sets the base (6-month) rate per
                whole ICP — 1yr pays ×2, 2yr ×4, and the 2-week taster tier pays base÷5 (floored to 1).
                Draw gates (read-only): pot ≥ {lottery ? fmtICP(lottery.min_pot_e8s) : '…'} ICP,
                ≥ {lottery ? lottery.min_unique_holders.toString() : '…'} players.
              </span>
            </Sec>

            <Sec label="Bond economics" right={<span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>{voucherMkt ? `${(voucherMkt.market_fee_bps / 100).toFixed(1)}% fee · min ${fmtICP(voucherMkt.min_wrap_e8s)} ICP · buyback 15%` : '…'}</span>}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input type="number" min="0" max="100" step="0.1" placeholder="Market fee %" className="burn-input" style={inputStyle}
                  value={vFeeInput} onChange={(e) => setVFeeInput(e.target.value)} />
                <input type="text" placeholder="Min wrap (ICP)" className="burn-input" style={inputStyle}
                  value={vMinWrapInput} onChange={(e) => setVMinWrapInput(e.target.value)} />
                <Btn variant="primary" sm onClick={setVoucherConfig} disabled={busy !== null || (!vFeeInput && !vMinWrapInput)}>
                  {busy === 'vconfig' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
                </Btn>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                Fees split 1/3 treasury · 1/3 buyback fund · 1/3 bond-canister cycles burn.
              </span>
            </Sec>

            <Sec label="Golden Ticket campaign" right={voucherMkt
              ? <Chip tone={voucherMkt.promo_open ? 'ok' : 'muted'}>{voucherMkt.promo_open ? 'OPEN' : 'closed'}</Chip>
              : <LiveDot size={8} color="var(--burn-ink)" />}>
              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                {voucherMkt ? `${voucherMkt.promo_remaining.toLocaleString()} remaining · ${voucherMkt.promo_claims_today}/500 claimed today` : ' '}
              </span>
              <Btn variant={voucherMkt?.promo_open ? 'secondary' : 'primary'} sm onClick={() => setPromoCampaign(!(voucherMkt?.promo_open ?? false))} disabled={busy !== null || !voucherMkt} style={{ alignSelf: 'flex-start' }}>
                {busy === 'promo' ? <LiveDot size={7} /> : <Icon name={voucherMkt?.promo_open ? 'x' : 'spark'} size={13} stroke={voucherMkt?.promo_open ? 'currentColor' : 'var(--char-950)'} />}
                {voucherMkt?.promo_open ? 'Close campaign' : 'Open campaign'}
              </Btn>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                The #/claim page kill switch: 5,000 cap, 500/day drip, 1 ticket/day for 60 days, tickets-only.
              </span>
            </Sec>
          </FeatureGate>

          <Sec label="Staking" right={<span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>min {config ? `${fmtICP(config.min_stake_e8s)} / ${fmtICP(config.min_unstake_e8s)}` : '…'} · pool fee {config ? fmtICP(config.pool_initiation_fee_e8s) : '…'} ICP</span>}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder="Min stake" className="burn-input" style={inputStyle}
                value={minStakeInput} onChange={(e) => setMinStakeInput(e.target.value)} />
              <input type="text" placeholder="Min unstake" className="burn-input" style={inputStyle}
                value={minUnstakeInput} onChange={(e) => setMinUnstakeInput(e.target.value)} />
              <Btn variant="primary" sm onClick={setStakingConfig} disabled={busy !== null || (!minStakeInput && !minUnstakeInput)}>
                {busy === 'stakingcfg' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
              </Btn>
              <input type="number" min="0" step="1" placeholder="Pool initiation fee (ICP)" className="burn-input" style={inputStyle}
                value={poolFeeInput} onChange={(e) => setPoolFeeInput(e.target.value)} />
              <Btn variant="primary" sm onClick={setPoolFee} disabled={busy !== null || !poolFeeInput}>
                {busy === 'poolfee' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
              </Btn>
            </div>
          </Sec>

          <Sec label="Voting threshold" right={<span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>{config
            ? (config.default_threshold_usd_e8s !== undefined && config.default_threshold_usd_e8s !== null
              ? `$${(Number(config.default_threshold_usd_e8s) / 1e8).toFixed(2)}`
              : `${fmtICP(config.default_threshold)} ICP (legacy)`)
            : '…'}</span>}>
            <div className="row" style={{ gap: 8 }}>
              <input type="number" min="0.1" step="0.5" placeholder="New threshold (USD)" className="burn-input" style={inputStyle}
                value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} />
              <Btn variant="primary" sm onClick={setThreshold} disabled={busy !== null || !thresholdInput}>
                {busy === 'threshold' ? <LiveDot size={7} color="var(--char-950)" /> : <Icon name="check" size={13} stroke="var(--char-950)" />} Set
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Dollar-denominated; re-thresholds every open proposal at the live ICP/USD rate.
            </span>
          </Sec>

          {/* ── ICP LP custody — gated behind its flag, table ── */}
          <FeatureGate flagKey="icpswap_lp_stake" label="ICP LP staked per pool" flags={featureFlags} busy={busy} onToggle={cycleFlag}>
            <Sec label="ICP LP staked per pool" right={lpStatsBusy ? <LiveDot size={8} color="var(--burn-ink)" /> : undefined}>
              {!lpPoolStats ? (
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Reading each approved pool…</span>
              ) : lpPoolStats.length === 0 ? (
                <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>No pools configured.</span>
              ) : (
                <ATable cols={[{ label: 'Pool' }, { label: 'Positions', align: 'right' }, { label: 'Custodied amounts', align: 'right' }, { label: 'Value', align: 'right' }]}>
                  {lpPoolStats.map((row) => (
                    <tr key={row.pool.toString()} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="mono" style={{ padding: '5px 8px' }}>{row.name}</td>
                      <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{Number(row.positions)}</td>
                      <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-2)' }}>
                        {row.error ? <span style={{ color: 'var(--ember)' }}>valuation failed</span>
                          : `${row.token0_amount} ${row.token0_symbol} · ${row.token1_amount} ${row.token1_symbol}`}
                      </td>
                      <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600 }}>${(Number(row.usd_e8s) / 1e8).toFixed(2)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--border-hi)', fontWeight: 700 }}>
                    <td className="mono" style={{ padding: '6px 8px' }} colSpan={3}>TOTAL</td>
                    <td className="mono" style={{ padding: '6px 8px', textAlign: 'right' }}>${(lpPoolStats.reduce((a, r) => a + Number(r.usd_e8s), 0) / 1e8).toFixed(2)}</td>
                  </tr>
                </ATable>
              )}
            </Sec>
          </FeatureGate>
        </>
      )}

      {/* ════ POOLS & USERS ════ */}
      {/* ════ POOLS & USERS ════ */}
      {section === 'neurons' && (
        <>
          <Sec label="Term pools">
            {!staking ? <LiveDot size={8} color="var(--burn-ink)" /> : (
              <ATable cols={[{ label: 'Pool' }, { label: 'Rate', align: 'right' }, { label: 'Staked', align: 'right' }, { label: 'Stakers', align: 'right' }, { label: 'Neuron', align: 'right' }]}>
                {staking.pools.map(p => (
                  <tr key={p.tier} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="mono" style={{ padding: '5px 8px' }}>{p.tier}</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>{p.daily_tickets.toString()}/ICP/day</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{fmtICP(p.total_staked_e8s)} ICP</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{p.staker_count.toString()}</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>{p.neuron_id !== undefined && p.neuron_id !== null ? `#${p.neuron_id}` : '—'}</td>
                  </tr>
                ))}
                {ea && (
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="mono" style={{ padding: '5px 8px' }}>Perm</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>40/ICP/day</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{fmtICP(ea.total_staked_e8s)} ICP</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{ea.early_adopter_count.toString()}</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>{ea.membership_closed ? 'closed' : 'open'}</td>
                  </tr>
                )}
                {pool && (
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="mono" style={{ padding: '5px 8px' }}>Neuron Syndicate</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>top-100 race</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>—</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right' }}>{pool.active_count.toString()}</td>
                    <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>active</td>
                  </tr>
                )}
              </ATable>
            )}
          </Sec>

          <Sec label="Platform neurons — live from NNS governance" right={followStatus === null ? <LiveDot size={8} color="var(--burn-ink)" /> : undefined}>
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
              Read straight from NNS governance. Every platform neuron should follow the primary on
              topics 0/4/14. Yield harvests automatically past {config ? fmtICP(config.maturity_threshold_e8s) : '1.05'} ICP
              (70/30 lottery/treasury); "Trigger sweep" on System forces a harvest check now.
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Read straight from NNS governance. Every platform neuron should follow the primary on
              topics 0/4/14. Yield harvests automatically past {config ? fmtICP(config.maturity_threshold_e8s) : '1.05'} ICP
              (70/30 lottery/treasury); "Trigger sweep" on System forces a harvest check now.
            </span>
          </Sec>

          <Sec label="Split neurons — user unstakes the canister manages" right={splitNeurons === null ? <LiveDot size={8} color="var(--burn-ink)" /> : undefined}>
            {splitNeurons !== null && splitNeurons.filter(u => u.status !== UnstakeStatus.Merged).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No unstakes yet — nothing is dissolving.</span>
            )}
            {splitNeurons !== null && splitNeurons.filter(u => u.status !== UnstakeStatus.Merged).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No unstakes yet — nothing is dissolving.</span>
            )}
            {splitNeurons !== null && splitNeurons.filter(u => u.status !== UnstakeStatus.Merged).length > 0 && (
              <div className="col" style={{ gap: 4, maxHeight: 380, overflowY: 'auto' }}>
                {[...splitNeurons]
                  .filter(u => u.status !== UnstakeStatus.Merged)
                  .sort((a, b) => {
                    const live = (u: PendingUnstake) => u.status === UnstakeStatus.Dissolving || u.status === UnstakeStatus.SplitDone ? 0 : 1;
                    return live(a) - live(b) || Number(a.dissolve_eta - b.dissolve_eta);
                  })
                  .map(u => (
                    <div key={u.id.toString()} className="row" style={{ gap: 10, fontSize: 12, flexWrap: 'wrap', alignItems: 'center', padding: '5px 8px', borderRadius: 6, background: 'var(--surface)' }}>
                      {u.status === UnstakeStatus.Disbursed ? <Chip tone="ok" style={{ height: 17, fontSize: 10 }}>disbursed</Chip>
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
              Every unstake splits its own neuron, dissolves for the tier's term, then auto-disburses.
              Restaked rows are hidden (0-stake NNS husks); disbursed rows are history.
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Every unstake splits its own neuron, dissolves for the tier's term, then auto-disburses.
              Restaked rows are hidden (0-stake NNS husks); disbursed rows are history.
            </span>
          </Sec>

        </>
      )}

      {section === 'users' && (
        <>
          <Sec label="Logged-in principals" right={seenUsers === null ? <LiveDot size={8} color="var(--burn-ink)" /> : undefined}>
            {seenUsers !== null && seenUsers.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No signed-in principals yet.</span>
            )}
            {seenUsers !== null && seenUsers.length > 0 && (
              <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--fg-3)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Principal</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>First seen</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seenUsers.map(([p, s]) => (
                      <tr key={p.toText()} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="mono" style={{ padding: '4px 8px', textAlign: 'left' }} title={p.toText()}>
                          {formatPrincipal(p)}
                        </td>
                        <td className="mono" style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--fg-3)' }}>
                          {fmtSeenNs(s.first_seen_ns)}
                        </td>
                        <td className="mono" style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--fg-3)' }}>
                          {fmtSeenNs(s.last_seen_ns)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border-hi)', fontWeight: 600 }}>
                      <td style={{ padding: '6px 8px', textAlign: 'left' }}>TOTAL ({seenUsers.length})</td>
                      <td /><td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Sec>

          <Sec label="User wallet balances" right={<span className="row" style={{ gap: 8 }}>
                {userProgress && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {userProgress.done}/{userProgress.total}
                  </span>
                )}
                {userRows === null && <LiveDot size={8} color="var(--burn-ink)" />}
                {config?.is_local && (
                  <Btn variant="secondary" sm onClick={loadMockUsers} disabled={busy !== null}>
                    <Icon name="gamepad" size={12} /> Mock users
                  </Btn>
                )}
              </span>}>
            {userRows !== null && userRows.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No participants yet.</span>
            )}
            {userRows !== null && userRows.length > 0 && (
              <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
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
          </Sec>

          <Sec label="Low-rated courses — moderation candidates">
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
            {modCandidates !== null && modCandidates.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>No low-rated courses — nothing to moderate.</span>
            )}
            {modCandidates !== null && modCandidates.length > 0 && (
              <div className="col" style={{ gap: 0 }}>
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
          </Sec>
        </>
      )}

      {/* ════ SYSTEM ════ */}
      {/* ════ SYSTEM ════ */}
      {section === 'system' && (
        <>
          <Sec label="Cycles">
            <ATable cols={[{ label: 'Canister' }, { label: 'Balance', align: 'right' }, { label: '', align: 'right' }]}>
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <td className="mono" style={{ padding: '5px 8px' }}>Backend</td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: cycles !== null && Number(cycles) < 5e12 ? 'var(--ember)' : 'var(--fg)' }}>
                  {cycles !== null ? `${(Number(cycles) / 1e12).toFixed(2)} T` : <LiveDot size={7} color="var(--burn-ink)" />}
                </td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 10.5, color: 'var(--fg-3)' }}>auto-refills below 5T</td>
              </tr>
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <td className="mono" style={{ padding: '5px 8px' }}>Frontend</td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: typeof feCycles === 'bigint' && Number(feCycles) < 1e12 ? 'var(--ember)' : 'var(--fg)' }}>
                  {feCycles === null ? <LiveDot size={7} color="var(--burn-ink)" /> : feCycles === 'unavailable' ? 'n/a' : `${(Number(feCycles) / 1e12).toFixed(2)} T`}
                </td>
                <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                  <Btn variant="secondary" sm onClick={() => sendCycles('frontend')} disabled={busy !== null}>
                    {busy === 'cycles-frontend' ? <LiveDot size={7} /> : <Icon name="zap" size={12} />} Top up
                  </Btn>
                </td>
              </tr>
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <td className="mono" style={{ padding: '5px 8px' }}>Course NFT</td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: typeof nftCycles === 'bigint' && Number(nftCycles) < 1e12 ? 'var(--ember)' : 'var(--fg)' }}>
                  {nftCycles === null ? <LiveDot size={7} color="var(--burn-ink)" /> : nftCycles === 'unavailable' ? 'n/a' : `${(Number(nftCycles) / 1e12).toFixed(2)} T`}
                </td>
                <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                  <Btn variant="secondary" sm onClick={() => sendCycles('course_nft')} disabled={busy !== null}>
                    {busy === 'cycles-course_nft' ? <LiveDot size={7} /> : <Icon name="zap" size={12} />} Top up
                  </Btn>
                </td>
              </tr>
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <td className="mono" style={{ padding: '5px 8px' }}>Bond NFT</td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--fg-3)' }}>auto</td>
                <td className="mono" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 10.5, color: 'var(--fg-3)' }}>sweep-guarded + fee-third burns</td>
              </tr>
            </ATable>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Top-up amount</span>
              <input className="burn-input" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)}
                style={{ width: 70, textAlign: 'right' }} inputMode="decimal" />
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>T cycles, sent from the backend's balance</span>
            </div>
          </Sec>

          <Sec label="Feature kill switches">
            <div className="col" style={{ gap: 0 }}>
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
          </Sec>

          <Sec label="Settlement">
            <Btn variant="secondary" sm onClick={triggerSweep} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
              {busy === 'sweep' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} stroke="var(--burn-ink)" />} Trigger sweep now
            </Btn>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Runs settlements, retries, harvest checks and cache refreshes immediately instead of waiting up to 5 minutes.
            </span>
          </Sec>

          <Sec label="Canister wiring">
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              voucher_nft {config?.voucher_nft_canister ? <span className="mono">{formatPrincipal(config.voucher_nft_canister)}</span> : '— not wired'} ·
              course_nft {config?.course_nft_canister ? <span className="mono">{formatPrincipal(config.course_nft_canister)}</span> : '— not wired'}
            </span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder="voucher_nft canister id" className="burn-input" style={{ ...inputStyle, minWidth: 200 }}
                value={wireVoucherInput} onChange={(e) => setWireVoucherInput(e.target.value)} />
              <Btn variant="secondary" sm onClick={() => wireCanister('voucher')} disabled={busy !== null || !wireVoucherInput}>
                {busy === 'wire-voucher' ? <LiveDot size={7} /> : <Icon name="key" size={12} />} Wire
              </Btn>
              <input type="text" placeholder="course_nft canister id" className="burn-input" style={{ ...inputStyle, minWidth: 200 }}
                value={wireCourseInput} onChange={(e) => setWireCourseInput(e.target.value)} />
              <Btn variant="secondary" sm onClick={() => wireCanister('course')} disabled={busy !== null || !wireCourseInput}>
                {busy === 'wire-course' ? <LiveDot size={7} /> : <Icon name="key" size={12} />} Wire
              </Btn>
            </div>
          </Sec>

          <Sec label="Audit log — latest 25 events" right={auditTail.length === 0 ? <LiveDot size={8} color="var(--burn-ink)" /> : undefined}>
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
              Append-only on-chain record of every money-moving event, newest first.
            </span>
          </Sec>

        </>
      )}

      {/* ════ REFERENCE — how each feature works ════ */}
      {section === 'reference' && (
        <>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            The exact money flows, verbatim from the canister logic.
          </span>
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

          <Section icon="zap" title="Lossless staking — four terms, one principal, zero loss">
            <Li>Four pooled NNS neurons, one per term: 2 weeks, 6 months, 1 year, 2 years. Your ICP joins the term's neuron; your principal is never spent. Every neuron is made PUBLIC on the NNS the moment it's configured — anyone can audit it on the dashboard.</Li>
            <Li>Staking grants <b>no voting power</b> — voting is burn-only. Staking's sole reward is lottery eligibility: the term length scales the daily ticket grant (2wk / 6mo / 1y / 2y → 1 / 5 / 10 / 20 tickets per ICP per day).</Li>
            <Li>The 2-week taster tier is <b>membership, not yield</b>: neurons under a 6-month dissolve earn no NNS maturity, so its pool contributes nothing to the prize pot.</Li>
            <Li>Whole-ICP amounts only. Every stake is issued as a Bond NFT; exits are bond-native (sell, instant 85% buyback, or redeem = dissolve for 100%). The treasury fronts every neuron fee.</Li>
            <Li>Neuron maturity harvests once it crosses ~1.05 ICP and is split <b>70% lottery prize pot / 30% treasury</b> — all the staking neurons feed the same pot.</Li>
          </Section>

          <Section icon="spark" title="No-Loss Lottery — dynamic odds, funded by yield">
            <Li>Stakers only — daily grant = base ({base}) × term multiplier × whole ICP staked (2-week taster tier = base÷5, floored to 1), granted server-side every UTC day (no visit needed). Exits never void already-earned tickets — they ride until the next drawing and the round only resets on a win (promotion to admin still voids them). Listed bonds pause their ticket stream until delisted. Buying a bond earns from the NEXT daily grant (no instant grant); selling or transferring a bond claws its current-round tickets back from the seller — the NFT's earnings leave with it.</Li>
            <Li>Drawings 3× a week (Mon/Wed/Sat nights US Eastern), but a drawing only runs when the pot holds at least 25 ICP AND enough unique players hold tickets — below that it rolls over. Odds are dynamic: every drawing that runs has a 1-in-13 chance of paying out regardless of ticket supply, decided by on-chain randomness (raw_rand).</Li>
            <Li>The winner takes 65% of the prize pot; 30% seeds the next round; 5% is burned to backend-canister cycles; all tickets reset.</Li>
            <Li>The pot is funded purely by staking yield — players never pay in, so nobody can lose money.</Li>
            <Li>Prize payouts are journaled and retried until the transfer lands; a win can never be paid twice or lost.</Li>
          </Section>

          <Section icon="spark" title="Perm tier — the platform's permanent stake">
            <Li>Permanent (no unstake, by design) stake into a platform-controlled 2-year neuron that follows the primary on every topic. Open to everyone, forever — no membership cap or close.</Li>
            <Li>Perm stakes earn <b>lottery tickets only</b>: a flat 40 tickets/day per whole ICP staked. No ICP yield is ever paid to Perm stakers.</Li>
            <Li>The Perm neuron's harvested yield is split <b>30% treasury / 70% lottery prize pot</b> — never distributed to users.</Li>
          </Section>

          <Section icon="star" title="Stake Bonds — the stake as an NFT">
            <Li>Staking auto-issues a Backed bond NFT for the position; tickets follow the bond's current owner (day-keyed grants — wash-trading earns nothing).</Li>
            <Li><b>Age bonus:</b> a Backed bond's daily tickets grow with the bond's age — +1% at mint → +25% at 10 years, smooth, plateau after. The age travels with the NFT on sale/transfer; while listed it decays after a 3-day grace at the growth rate (floors at the 1% mint level); redeem/buyback burns the age; unwrap→rewrap mints a new bond (age resets). Granted daily under its own breakdown source ("age_bonus").</Li>
            <Li>Exits: sell on the Bond Exchange (fee splits 1/3 treasury · 1/3 buyback fund · 1/3 bond-canister cycles burn), instant 85% house buyback (balance-gated by the buyback wallet; burns the NFT and dissolves the claim back to the fund), or redeem (dissolve for 100%).</Li>
            <Li>Golden Tickets (promo class) are tickets-only: 1/day for 60 days, soulbound, never redeemable, never buyback-eligible.</Li>
          </Section>

          <Section icon="coins" title="Payout history — every satoshi accounted for">
            <Li>Every transfer the canister makes to a user is recorded: lottery jackpots, unstake disbursements, commitment refunds, and Neuron Syndicate rewards.</Li>
            <Li>Each record carries the token, amount, timestamp and source id — the user-facing mirror of the append-only audit log.</Li>
          </Section>

          <Section icon="wallet" title="Treasury & cycles — how the lights stay on">
            <Li>Treasury inflows: 50% of burns, 30% of staking + Perm yield, bond-fee thirds, Neuron Syndicate initiation fees, and mini-golf payments.</Li>
            <Li>Cycles: 25% of each burn tops up each canister via the CMC. If the backend dips below 5T cycles, the sweep auto-converts treasury ICP into cycles (two-phase, idempotent).</Li>
            <Li>Withdrawals and neuron allocations are guarded by the 15 ICP floor (override available) — below ~10 ICP the cycle top-up silently stops.</Li>
          </Section>
        </>
      )}
    </div>
  );
}
