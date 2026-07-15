import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { TxDirection } from "./bindings/backend";
import { IdeaToken } from "./tokens";
import type { TransactionRecord } from "./bindings/backend";
import { fmtTokenAmount } from "./tokens";
import { createActor as createLedgerActor } from "./bindings/ledger";
import type { Identity } from "@icp-sdk/core/agent";
import { ExplorerToken, UnstakeStatus, type Backend, type PendingUnstake } from "./bindings/backend";
import { Icon, Eyebrow, Chip, Btn, LiveDot, fmtICP, formatPrincipal } from "./ui";
import { useErrorImpression } from "./analytics";
import { makeCkbtcMinter, makeApprover, CKBTC_MINTER_ID } from "./minters";
import { TIER_META, etaLabel } from "./Staking";
import { VouchersBody } from "./Vouchers";
import { TICKET_SOURCE_LABELS } from "./Lottery";
import { backendErr, toFriendly } from './errors';
import { useTxFlow, TxModal } from './TxModal';

// ==========================================
// Profile — your wallet (token accounts + on/off-ramps) and the full
// transaction-activity receipt trail, on one page.
// ==========================================

interface PayoutsProps {
  actor: any;
  principal: Principal | null;
  identity: unknown;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  /** Sign out — lives on the Profile page header now (no left-nav Account section). */
  onSignOut: () => void;
}

const WALLET_TOKENS_META: { token: ExplorerToken; label: string; decimals: number }[] = [
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

const TX_META: Record<string, { label: string; icon: string; blurb: string }> = {
  // In — payouts the site made to you.
  LotteryWin: { label: 'Lottery jackpot', icon: 'target', blurb: '65% of the prize pool' },
  UnstakeDisbursement: { label: 'Unstake disbursement', icon: 'zap', blurb: 'Dissolved stake returned to your wallet' },
  IdeaUpvoteShare: { label: 'Idea upvote share', icon: 'bulb', blurb: 'Legacy — upvoting is now free, no poster share' },
  CommitmentRefund: { label: 'Commitment refund', icon: 'undo', blurb: 'Escrow returned — threshold unmet' },
  PoolReward: { label: 'Neuron Syndicate reward', icon: 'arrowUp', blurb: '25% of a settled burn, split equally among the top 100 Neuron Syndicate neurons' },
  EarlyAdopterYield: { label: 'Early Adopter yield', icon: 'spark', blurb: 'Legacy — Perm-tier stakes earn lottery tickets only, no ICP yield' },
  // Out — what you put in.
  deposit: { label: 'Burn commitment', icon: 'flame', blurb: 'Escrowed behind a proposal stance' },
  add_commitment: { label: 'Commitment top-up', icon: 'flame', blurb: 'Added to an open commitment' },
  idea_post: { label: 'Idea post fee', icon: 'bulb', blurb: '1 ICP anti-spam fee to the treasury' },
  idea_upvote: { label: 'Idea upvote', icon: 'bulb', blurb: 'Legacy — upvoting is now free' },
  project_fund: { label: 'Project funding', icon: 'coins', blurb: '100% to the treasury build fund' },
  pool_register: { label: 'Pool initiation fee', icon: 'target', blurb: 'One-time neuron pool entry' },
  stake: { label: 'Stake lockup', icon: 'zap', blurb: 'Locked, not spent — returns in full on unstake' },
};

const TOKEN_DECIMALS: Record<string, { label: string; decimals: number }> = {
  [IdeaToken.ICP]: { label: 'ICP', decimals: 8 },
  [IdeaToken.CkBTC]: { label: 'ckBTC', decimals: 8 },
  [IdeaToken.CkETH]: { label: 'ckETH', decimals: 18 },
  [IdeaToken.CkUSDC]: { label: 'ckUSDC', decimals: 6 },
  [IdeaToken.CkUSDT]: { label: 'ckUSDT', decimals: 6 },
};

function payoutDate(atNs: bigint): string {
  return new Date(Number(atNs / 1_000_000n)).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Members-only (the #/auth gate guarantees a signed-in caller).
type WalletTab = 'balance' | 'deposit' | 'withdraw' | 'history';
const WALLET_TABS: { key: WalletTab; label: string; icon: string }[] = [
  { key: 'balance', label: 'Balance', icon: 'wallet' },
  { key: 'deposit', label: 'Deposit', icon: 'coins' },
  { key: 'withdraw', label: 'Withdraw', icon: 'arrowUp' },
  { key: 'history', label: 'History', icon: 'list' },
];

export default function Payouts({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal, onSignOut }: PayoutsProps) {
  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<WalletTab>('balance');

  // The Admin console moved to its own admin-only nav section (2026-07-11);
  // this page is wallet & activity only.

  useEffect(() => {
    (async () => {
      if (!actor) { setTxs([]); setLoaded(false); return; }
      try {
        let mine = await actor.get_my_transactions();
        // Local dev: seed a varied mock history on first visit so the page
        // is never empty while testing (no-op on mainnet and once seeded).
        if (isLocal && mine.length === 0) {
          const res = await actor.dev_seed_payouts();
          if (res.__kind__ === "Ok") mine = await actor.get_my_transactions();
        }
        setTxs(mine);
        setLoaded(true);
      } catch (err) {
        console.error("Failed to fetch transactions:", err);
      }
    })();
  }, [actor, principal, isLocal]);

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };


  return (
    <>
      <div className="dashboard-container" style={{ paddingBottom: 0 }}>
        {/* ── Header ── */}
        <div className="col" style={{ gap: 6 }}>
          <span className="row" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="wallet" size={16} stroke="var(--burn-ink)" />
              <Eyebrow accent>Profile</Eyebrow>
            </span>
            <Btn variant="danger" sm onClick={onSignOut}>
              <Icon name="x" size={13} stroke="var(--ember)" /> Sign out
            </Btn>
          </span>
          <b style={{ fontSize: 17 }}>Your wallet &amp; activity.</b>
        </div>

      </div>

      {/* ── Wallet & activity ── */}
      <div className="dashboard-container">
          {/* ════ WALLET TABS (Staking tier-tab idiom) ════ */}
          <div className="row" style={{ gap: 6 }}>
            {WALLET_TABS.map(({ key, label, icon }) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  style={{
                    flex: 1, padding: '7px 4px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
                    fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    border: `1px solid ${active ? 'var(--burn)' : 'var(--border)'}`,
                    background: active ? 'color-mix(in srgb, var(--burn) 14%, transparent)' : 'transparent',
                    color: active ? 'var(--burn-ink)' : 'var(--fg-2)',
                  }}
                >
                  <Icon name={icon} size={12} stroke="currentColor" /> {label}
                </button>
              );
            })}
          </div>

          {/* ════ WALLET (balance / deposit / withdraw tabs) ════ */}
          {tab !== 'history' && (
            <WalletSection
              actor={actor}
              principal={principal!}
              identity={identity}
              host={host}
              rootKey={rootKey}
              ledgerCanisterId={ledgerCanisterId}
              isLocal={isLocal}
              section={tab}
            />
          )}

          {/* ════ BALANCE TAB EXTRAS: tickets, bonds, dissolving neurons ════ */}
          {tab === 'balance' && (
            <>
              <TicketsCard actor={actor} />
              <VouchersBody
                actor={actor}
                identity={identity}
                principal={principal}
                host={host}
                rootKey={rootKey}
                ledgerCanisterId={ledgerCanisterId}
                section="mine"
                bare
              />
              <DissolvingNeurons actor={actor} principal={principal!} isLocal={isLocal} />
            </>
          )}

          {/* ════ ACTIVITY (History tab) ════ */}
          {tab === 'history' && (
          <div className="col" style={{ ...card, gap: 10 }}>
            <Eyebrow>Transaction history</Eyebrow>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Commitments, fees, stakes and upvotes on one side — jackpots, disbursements, shares and
              refunds on the other. Newest first.
            </span>
            {txs.length === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
                {loaded
                  ? "Nothing yet — commit to a proposal, stake, or post an idea and every movement shows up here."
                  : "Loading…"}
              </span>
            ) : (
              <div className="col" style={{ gap: 0 }}>
                {txs.map((tx, i) => {
                  const meta = TX_META[tx.kind] ?? { label: tx.kind, icon: 'coins', blurb: '' };
                  const tok = TOKEN_DECIMALS[tx.token];
                  const incoming = tx.direction === TxDirection.In;
                  return (
                    <div key={`${tx.kind}-${String(tx.timestamp)}-${i}`} className="row" style={{
                      gap: 10, padding: '10px 0', fontSize: 12.5, flexWrap: 'wrap',
                      borderTop: '1px solid var(--border)', justifyContent: 'space-between',
                    }}>
                      <span className="row" style={{ gap: 10 }}>
                        <Icon name={meta.icon} size={14} stroke={incoming ? 'var(--sprout-ink)' : 'var(--burn-ink)'} />
                        <span className="col" style={{ gap: 2 }}>
                          <b>{meta.label}</b>
                          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
                            {meta.blurb ? `${meta.blurb} · ` : ''}{payoutDate(tx.timestamp)}
                          </span>
                        </span>
                      </span>
                      <Chip tone={incoming ? 'ok' : 'muted'}>
                        {incoming ? '+' : '−'}{fmtTokenAmount(tx.amount, tok.decimals)} {tok.label}
                      </Chip>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}
      </div>
    </>
  );
}

// ==========================================
// Lottery tickets — this round's count + where they came from (same source
// labels as the Lottery page). Balance-tab card: tickets are a holding too.
// ==========================================
function TicketsCard({ actor }: { actor: Backend }) {
  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };
  const [info, setInfo] = useState<{ my_tickets: bigint; my_daily_tickets: bigint } | null>(null);
  const [breakdown, setBreakdown] = useState<{ source: string; count: bigint }[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [i, b] = await Promise.all([
          actor.get_lottery_info(),
          actor.get_my_ticket_breakdown().catch(() => []),
        ]);
        if (!cancelled) { setInfo(i); setBreakdown(b); }
      } catch { /* best-effort — the card shows a loading dash */ }
    })();
    return () => { cancelled = true; };
  }, [actor]);

  const tracked = breakdown.reduce((a, r) => a + Number(r.count), 0);
  const earlier = Number(info?.my_tickets ?? 0n) - tracked;
  const rows = [
    ...breakdown.map((r) => ({ label: TICKET_SOURCE_LABELS[r.source] ?? r.source, count: Number(r.count) })),
    ...(earlier > 0 ? [{ label: 'Earlier grants (untracked)', count: earlier }] : []),
  ];

  return (
    <div className="col" style={{ ...card, gap: 10 }}>
      <Eyebrow>Lottery tickets</Eyebrow>
      <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
        <b className="mono" style={{ fontSize: 24 }}>{info ? Number(info.my_tickets).toLocaleString() : '…'}</b>
        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          in this round's drawing{info && info.my_daily_tickets > 0n && <> · earning <span className="mono">{Number(info.my_daily_tickets)}</span>/day</>}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="col" style={{ gap: 4, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>
            Where they came from
          </span>
          {rows.map((r) => (
            <span key={r.label} className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
              <span style={{ color: 'var(--fg-2)' }}>{r.label}</span>
              <span className="mono">{r.count.toLocaleString()}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ==========================================
// Wallet — the user's token accounts plus native BTC/ETH on/off-ramps.
// ck-token balances live on the user's own principal across the five
// ledgers; native ramps talk to DFINITY's minters (mainnet only).
// ==========================================
function WalletSection({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal, section }: {
  actor: Backend;
  principal: Principal;
  identity: unknown;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
  /** Which wallet tab renders — the component stays mounted across the
   *  balance/deposit/withdraw tabs so balances and notices persist. */
  section: 'balance' | 'deposit' | 'withdraw';
}) {
  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };
  const inputStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', flex: 1 };
  const agentOpts = { host, identity: identity as Identity, rootKey };

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Staged-transaction modal — drives the multi-step Withdraw flows (on-IC
  // ICRC transfer and the native BTC off-ramp) so each stage shows live.
  const tx = useTxFlow();
  useErrorImpression(error, 'payouts');
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
  const [fees, setFees] = useState<Record<string, bigint>>({});
  const [ledgers, setLedgers] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  // ICP deposits go to the ledger ACCOUNT ID (what exchanges ask for), not
  // the raw principal — fetched from the backend, which derives it.
  const [accountId, setAccountId] = useState<string | null>(null);

  // ── withdraw (on-IC transfer to any principal) ──
  const [wToken, setWToken] = useState<ExplorerToken>(ExplorerToken.ICP);
  const [wAmount, setWAmount] = useState('');
  const [wDest, setWDest] = useState('');

  // ── native BTC ramp ──
  const [btcAddress, setBtcAddress] = useState<string | null>(null);
  const [nAmount, setNAmount] = useState('');
  const [nDest, setNDest] = useState('');

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const run = async (label: string, fn: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(label); setError(null); setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (err) {
      setError(toFriendly(err, 'wallet'));
    } finally {
      setBusy(null);
    }
  };

  const loadLedgers = async (): Promise<Record<string, string>> => {
    if (Object.keys(ledgers).length > 0) return ledgers;
    const info = await actor.get_explorer_info();
    const map: Record<string, string> = {
      ICP: ledgerCanisterId,
      CkBTC: info.ckbtc_ledger.toText(),
      CkETH: info.cketh_ledger.toText(),
      CkUSDC: info.ckusdc_ledger.toText(),
      CkUSDT: info.ckusdt_ledger.toText(),
    };
    setLedgers(map);
    return map;
  };

  const refreshBalances = async () => {
    try {
      const map = await loadLedgers();
      const next: Record<string, bigint | null> = {};
      const nextFees: Record<string, bigint> = {};
      await Promise.all(WALLET_TOKENS_META.map(async ({ token }) => {
        try {
          const l = createLedgerActor(map[token], { agentOptions: agentOpts });
          const [bal, fee] = await Promise.all([
            l.icrc1_balance_of({ owner: principal, subaccount: undefined }),
            l.icrc1_fee().catch(() => null),
          ]);
          next[token] = bal;
          if (fee !== null) nextFees[token] = fee;
        } catch { next[token] = null; }
      }));
      setBalances(next);
      setFees((prev) => ({ ...prev, ...nextFees }));
    } catch { /* transient */ }
  };

  // Manual refresh: show a loading indicator for at least 1s so the click has
  // visible feedback even when the ledger queries return instantly.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        refreshBalances(),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await refreshBalances();
      try {
        const id = await actor.get_account_id();
        if (!cancelled) setAccountId(id);
      } catch { /* transient */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, principal]);

  const withdrawIc = () => run('w-ic', async () => {
    const meta = WALLET_TOKENS_META.find(t => t.token === wToken)!;
    // Pre-validation stays inline guidance (never a modal stage).
    const amount = parseUnits(wAmount, meta.decimals);
    if (!amount || amount <= 0n) { setError(`Enter a valid ${meta.label} amount.`); return null; }
    let dest: Principal;
    try { dest = Principal.fromText(wDest.trim()); }
    catch { setError('Destination is not a valid principal.'); return null; }
    tx.start(['Sending', 'Confirming'], { title: `Withdrawing ${meta.label}` });
    try {
      const map = await loadLedgers();
      const l = createLedgerActor(map[wToken], { agentOptions: agentOpts });
      const res = await l.icrc1_transfer({ to: { owner: dest, subaccount: undefined }, amount });
      if (res.__kind__ === 'Err') {
        throw backendErr(res.Err, 'wallet:withdraw');
      }
      tx.next('Confirming the transfer on-chain…');
      setWAmount('');
      await refreshBalances();
      tx.succeed(`${fmtUnits(amount, meta.decimals)} ${meta.label} sent to ${formatPrincipal(dest)}.`);
    } catch (e) {
      tx.fail(toFriendly(e, 'wallet:withdraw'));
    }
    return null;
  });

  // ── native: BTC ──
  const getBtcAddress = () => run('btc-addr', async () => {
    const minter = makeCkbtcMinter(agentOpts);
    const addr: string = await minter.get_btc_address({ owner: [principal], subaccount: [] });
    setBtcAddress(addr);
    return null;
  });

  const checkBtcDeposit = () => run('btc-check', async () => {
    const minter = makeCkbtcMinter(agentOpts);
    try {
      const res = await minter.update_balance({ owner: [principal], subaccount: [] });
      if ('Ok' in res) {
        const minted = (res.Ok as Record<string, unknown>[]).filter(u => 'Minted' in u);
        await refreshBalances();
        return minted.length > 0
          ? `Minted ckBTC from ${minted.length} confirmed deposit(s) — balance updated.`
          : 'Deposits seen but still confirming — check again after more Bitcoin confirmations.';
      }
      const err = res.Err;
      if ('NoNewUtxos' in err) return 'No new BTC found yet — Bitcoin deposits need confirmations (typically ~1 hour).';
      throw backendErr(err, 'wallet:btc-check');
    } catch (e) {
      if (String(e).includes('NoNewUtxos')) return 'No new BTC found yet.';
      throw e;
    }
  });

  // ── native: BTC withdrawal (the only native off-ramp; ETH/USDC/USDT leave
  //    as their ck twins via the on-IC withdraw above) ──
  const withdrawBtc = () => run('n-withdraw', async () => {
    // Pre-validation stays inline guidance (never a modal stage).
    const amount = parseUnits(nAmount, 8);
    if (!amount || amount <= 0n) { setError('Enter a valid BTC amount.'); return null; }
    tx.start(['Approving', 'Requesting Bitcoin retrieval'], { title: 'Withdrawing to Bitcoin' });
    try {
      const map = await loadLedgers();
      const approver = makeApprover(map.CkBTC, agentOpts);
      await approver.icrc2_approve({
        from_subaccount: [], spender: { owner: Principal.fromText(CKBTC_MINTER_ID), subaccount: [] },
        amount: amount + 1000n, expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [],
      });
      tx.next('Asking the minter to retrieve BTC…');
      const minter = makeCkbtcMinter(agentOpts);
      const res = await minter.retrieve_btc_with_approval({ address: nDest.trim(), amount, from_subaccount: [] });
      if ('Err' in res) throw backendErr(res.Err, 'wallet:btc-withdraw');
      await refreshBalances();
      tx.succeed(`BTC withdrawal queued (block ${res.Ok.block_index}) — the minter batches retrievals to Bitcoin.`);
    } catch (e) {
      tx.fail(toFriendly(e, 'wallet:withdraw'));
    }
    return null;
  });

  return (
    <>
      {tx.isOpen && <TxModal flow={tx} onClose={tx.reset} />}
      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout-ink)', background: 'var(--surface)',
        }}>
          <Icon name={error ? 'x' : 'checkCircle'} size={13} stroke="currentColor" />
          <span style={{ overflowWrap: 'anywhere' }}>{error || notice}</span>
        </div>
      )}

      {/* Balances */}
      {section === 'balance' && (
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <Eyebrow>Balances</Eyebrow>
          <Btn variant="ghost" sm onClick={handleRefresh} disabled={busy !== null || refreshing}>
            {refreshing ? <LiveDot size={7} color="var(--burn-ink)" /> : <Icon name="undo" size={12} />} Refresh
          </Btn>
        </span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {WALLET_TOKENS_META.map(({ token, label, decimals }) => (
            <div key={token} className="col" style={{ gap: 2, padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8, minWidth: 120 }}>
              <span style={{ fontSize: 10.5, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</span>
              <b className="mono" style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 16 }}>
                {refreshing
                  ? <LiveDot size={7} color="var(--burn-ink)" />
                  : balances[token] !== undefined && balances[token] !== null ? fmtUnits(balances[token]!, decimals) : '…'}
              </b>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Deposit */}
      {section === 'deposit' && (
      <div className="col" style={{ ...card, gap: 12 }}>
        <Eyebrow>Deposit</Eyebrow>

        {/* ICP → account ID (what exchanges and wallets ask for) */}
        <div className="col" style={{ gap: 6 }}>
          <b style={{ fontSize: 13 }}>ICP — send to your account ID</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6, flex: '1 1 280px' }}>
              {accountId ?? '…'}
            </span>
            <button onClick={() => accountId && copyText('aid', accountId)}
              style={{ background: 'transparent', border: 'none', color: copied === 'aid' ? 'var(--sprout-ink)' : 'var(--fg-3)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
              <Icon name={copied === 'aid' ? 'check' : 'copy'} size={11} stroke="currentColor" /> {copied === 'aid' ? 'copied' : 'copy'}
            </button>
          </div>
        </div>

        {/* ck tokens → principal */}
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <b style={{ fontSize: 13 }}>ckBTC / ckETH / ckUSDC / ckUSDT — send to your principal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6, flex: '1 1 280px' }}>
              {principal.toString()}
            </span>
            <button onClick={() => copyText('pid', principal.toString())}
              style={{ background: 'transparent', border: 'none', color: copied === 'pid' ? 'var(--sprout-ink)' : 'var(--fg-3)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
              <Icon name={copied === 'pid' ? 'check' : 'copy'} size={11} stroke="currentColor" /> {copied === 'pid' ? 'copied' : 'copy'}
            </button>
          </div>
        </div>

        {/* Native BTC → ckBTC (mainnet only) */}
        {!isLocal && (
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ fontSize: 13 }}>Bitcoin — deposit real BTC, receive ckBTC</b>
            {btcAddress ? (
              <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 6 }}>
                {btcAddress}
              </span>
            ) : (
              <Btn variant="secondary" sm onClick={getBtcAddress} disabled={busy !== null} style={{ alignSelf: 'flex-start' }}>
                {busy === 'btc-addr' ? '…' : 'Get my BTC deposit address'}
              </Btn>
            )}
            {btcAddress && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Btn variant="secondary" sm onClick={checkBtcDeposit} disabled={busy !== null}>
                  {busy === 'btc-check' ? 'Checking…' : 'I sent BTC — check for deposit'}
                </Btn>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Bitcoin needs ~1h of confirmations before minting.</span>
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Withdraw */}
      {section === 'withdraw' && (() => {
        const wMeta = WALLET_TOKENS_META.find(t => t.token === wToken)!;
        const wBal = balances[wToken];
        const wFee = fees[wToken] ?? 0n;
        const wParsed = parseUnits(wAmount, wMeta.decimals);
        const wBadAmount = wAmount.trim() !== '' && (wParsed === null || wParsed <= 0n);
        // The ledger charges its fee ON TOP of the amount — the spend is
        // amount + fee, so that's what must fit in the balance.
        const wExceeds = wParsed !== null && wParsed > 0n && wBal !== null && wBal !== undefined && wParsed + wFee > wBal;
        const wMax = wBal !== null && wBal !== undefined && wBal > wFee ? wBal - wFee : 0n;
        return (
      <div className="col" style={{ ...card, gap: 12 }}>
        <Eyebrow>Withdraw</Eyebrow>
        <div className="col" style={{ gap: 8 }}>
          <b style={{ fontSize: 13 }}>To any Internet Computer principal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="burn-input"
              value={wToken}
              onChange={(e) => setWToken(e.target.value as ExplorerToken)}
              aria-label="Token to withdraw"
              style={{ maxWidth: 160 }}
            >
              {WALLET_TOKENS_META.map(({ token, label }) => (
                <option key={token} value={token}>{label}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              Available:{' '}
              <b className="mono" style={{ color: 'var(--fg)' }}>
                {wBal !== null && wBal !== undefined ? fmtUnits(wBal, wMeta.decimals) : '…'}
              </b>{' '}
              {wMeta.label}
              {wFee > 0n && <span style={{ color: 'var(--fg-3)' }}> · network fee {fmtUnits(wFee, wMeta.decimals)}</span>}
            </span>
            {wMax > 0n && (
              <button
                onClick={() => setWAmount(fmtUnits(wMax, wMeta.decimals).replace(/,/g, ''))}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--burn-ink)', fontSize: 11.5, textDecoration: 'underline' }}
              >
                Max
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="text" placeholder="Amount" className="burn-input"
              style={{ ...inputStyle, maxWidth: 180, borderColor: (wBadAmount || wExceeds) ? 'var(--ember)' : undefined }}
              value={wAmount} onChange={e => setWAmount(e.target.value)} />
            <input type="text" placeholder="Destination principal" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
              value={wDest} onChange={e => setWDest(e.target.value)} />
            <Btn variant="primary" sm onClick={withdrawIc}
              disabled={busy !== null || !wDest || wParsed === null || wParsed <= 0n || wExceeds || wBal === null || wBal === undefined}>
              {busy === 'w-ic' ? '…' : 'Withdraw'}
            </Btn>
          </div>
          {wBadAmount && (
            <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--ember)' }}>
              <Icon name="x" size={11} stroke="var(--ember)" /> That doesn't parse as a {wMeta.label} amount.
            </span>
          )}
          {wExceeds && (
            <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--ember)' }}>
              <Icon name="x" size={11} stroke="var(--ember)" />
              More than your balance — the most you can send is {fmtUnits(wMax, wMeta.decimals)} {wMeta.label} (amount + network fee must fit).
            </span>
          )}
        </div>

        {/* Native BTC off-ramp (mainnet only) */}
        {!isLocal && (() => {
          const btcBal = balances[ExplorerToken.CkBTC];
          const btcFee = fees[ExplorerToken.CkBTC] ?? 0n;
          const nParsed = parseUnits(nAmount, 8);
          const nBadAmount = nAmount.trim() !== '' && (nParsed === null || nParsed <= 0n);
          // The flow spends amount + an icrc2_approve fee + the transfer fee
          // the minter charges when it pulls the funds — two ledger fees.
          const nExceeds = nParsed !== null && nParsed > 0n && btcBal !== null && btcBal !== undefined && nParsed + btcFee * 2n > btcBal;
          return (
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ fontSize: 13 }}>To a native Bitcoin address</b>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              Available:{' '}
              <b className="mono" style={{ color: 'var(--fg)' }}>
                {btcBal !== null && btcBal !== undefined ? fmtUnits(btcBal, 8) : '…'}
              </b>{' '}ckBTC
            </span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder="Amount (BTC)" className="burn-input"
                style={{ ...inputStyle, maxWidth: 180, borderColor: (nBadAmount || nExceeds) ? 'var(--ember)' : undefined }}
                value={nAmount} onChange={e => setNAmount(e.target.value)} />
              <input type="text" placeholder="Bitcoin address" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
                value={nDest} onChange={e => setNDest(e.target.value)} />
              <Btn variant="primary" sm onClick={withdrawBtc}
                disabled={busy !== null || !nDest || nParsed === null || nParsed <= 0n || nExceeds || btcBal === null || btcBal === undefined}>
                {busy === 'n-withdraw' ? '…' : 'Withdraw BTC'}
              </Btn>
            </div>
            {nExceeds && (
              <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--ember)' }}>
                <Icon name="x" size={11} stroke="var(--ember)" /> More than your ckBTC balance (the approval + transfer fees must fit too).
              </span>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Spends your ckBTC; the minter batches retrievals to Bitcoin. The flow asks the ledger
              for an approval first — two transactions total.
            </span>
          </div>
          );
        })()}
      </div>
        );
      })()}
    </>
  );
}

// ==========================================
// Dissolving neurons — unstaked neurons still waiting out their dissolve
// term. Mirrors the "Your unstakes" card on the Lottery → Staking tab, but
// read-only: the account page surfaces what's incoming, Restake/Fast-forward
// live on the Lottery page. Auto-disburses to the wallet on completion.
// ==========================================
function DissolvingNeurons({ actor, principal, isLocal }: {
  actor: Backend;
  principal: Principal;
  isLocal: boolean;
}) {
  const [unstakes, setUnstakes] = useState<PendingUnstake[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pending = await actor.list_my_pending_unstakes();
        if (!cancelled) { setUnstakes(pending); setLoaded(true); }
      } catch { /* transient */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, principal]);

  // Merged (restaked) neurons are empty husks — hide them. Only show neurons
  // the user is still waiting on. Newest first.
  const active = unstakes
    .filter(u => u.status !== UnstakeStatus.Merged)
    .sort((a, b) => Number(b.created_at - a.created_at));

  // Nothing to show until loaded, and hide the card entirely when there are
  // no active dissolves (keeps the account page clean for most users).
  if (!loaded || active.length === 0) return null;

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  return (
    <div className="col" style={{ ...card, gap: 10 }}>
      <Eyebrow>Dissolving neurons</Eyebrow>
      <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        Neurons you've unstaked, dissolving for their full term. Your ICP lands in your wallet
        automatically when each completes — restake or manage them on the Lottery page.
      </span>
      <div className="col" style={{ gap: 8 }}>
        {active.map(u => (
          <div key={u.id.toString()} className="col" style={{
            gap: 10, padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--border)',
          }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span className="row" style={{ gap: 10, alignItems: 'center' }}>
                <b className="mono" style={{ fontSize: 16 }}>{fmtICP(u.amount_e8s)} ICP</b>
                <Chip tone="muted" style={{ height: 18, fontSize: 10.5 }}>{TIER_META[u.tier].short}</Chip>
              </span>
              {u.status === UnstakeStatus.Disbursed ? (
                <Chip tone="ok"><Icon name="checkCircle" size={11} /> In your wallet</Chip>
              ) : u.status === UnstakeStatus.Dissolving ? (
                <Chip tone="pending"><Icon name="clock" size={11} /> Dissolving · {etaLabel(u.dissolve_eta)}</Chip>
              ) : (
                <Chip tone="muted"><LiveDot size={6} /> Starting dissolve…</Chip>
              )}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, fontSize: 12.5, minWidth: 0 }}>
              <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>Dissolving neuron</span>
              {isLocal ? (
                <span className="mono" style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>#{u.split_neuron_id.toString()}</span>
              ) : (
                <a
                  className="mono"
                  href={`https://dashboard.internetcomputer.org/neuron/${u.split_neuron_id.toString()}`}
                  target="_blank" rel="noreferrer"
                  style={{ color: 'var(--sprout-ink)', overflowWrap: 'anywhere', textAlign: 'right', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  title="View the dissolving neuron on the NNS dashboard"
                >
                  #{u.split_neuron_id.toString()} <Icon name="external" size={11} stroke="var(--sprout-ink)" />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
