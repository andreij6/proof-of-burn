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
  onSignIn: () => void;
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

export default function Payouts({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal, onSignIn, onSignOut }: PayoutsProps) {
  const signedIn = !!(principal && !principal.isAnonymous());
  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  // The Admin console moved to its own admin-only nav section (2026-07-11);
  // this page is wallet & activity only.

  useEffect(() => {
    (async () => {
      if (!actor || !signedIn) { setTxs([]); setLoaded(false); return; }
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
  }, [actor, principal, signedIn, isLocal]);

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
            {signedIn && (
              <Btn variant="danger" sm onClick={onSignOut}>
                <Icon name="x" size={13} stroke="var(--ember)" /> Sign out
              </Btn>
            )}
          </span>
          <b style={{ fontSize: 17 }}>Your wallet &amp; activity.</b>
        </div>

      </div>

      {/* ── Wallet & activity ── */}
      {!signedIn ? (
        <div className="dashboard-container">
          <div className="col" style={{ ...card, gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
              Sign in to use your wallet and see your transaction history.
            </span>
            <Btn variant="primary" sm onClick={onSignIn}>
              <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
            </Btn>
          </div>
        </div>
      ) : (
        <div className="dashboard-container">
          {/* ════ WALLET ════ */}
          <WalletSection
            actor={actor}
            principal={principal!}
            identity={identity}
            host={host}
            rootKey={rootKey}
            ledgerCanisterId={ledgerCanisterId}
            isLocal={isLocal}
          />

          {/* ════ DISSOLVING NEURONS ════ */}
          <DissolvingNeurons actor={actor} principal={principal!} isLocal={isLocal} />

          {/* ════ ACTIVITY ════ */}
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
        </div>
      )}
    </>
  );
}

// ==========================================
// Wallet — the user's token accounts plus native BTC/ETH on/off-ramps.
// ck-token balances live on the user's own principal across the five
// ledgers; native ramps talk to DFINITY's minters (mainnet only).
// ==========================================
function WalletSection({ actor, principal, identity, host, rootKey, ledgerCanisterId, isLocal }: {
  actor: Backend;
  principal: Principal;
  identity: unknown;
  host: string;
  rootKey?: Uint8Array;
  ledgerCanisterId: string;
  isLocal: boolean;
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
  useErrorImpression(error, 'payouts');
  const [balances, setBalances] = useState<Record<string, bigint | null>>({});
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
      setError(err instanceof Error ? err.message : String(err));
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
      await Promise.all(WALLET_TOKENS_META.map(async ({ token }) => {
        try {
          const l = createLedgerActor(map[token], { agentOptions: agentOpts });
          next[token] = await l.icrc1_balance_of({ owner: principal, subaccount: undefined });
        } catch { next[token] = null; }
      }));
      setBalances(next);
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
    const amount = parseUnits(wAmount, meta.decimals);
    if (!amount || amount <= 0n) { setError(`Enter a valid ${meta.label} amount.`); return null; }
    let dest: Principal;
    try { dest = Principal.fromText(wDest.trim()); }
    catch { setError('Destination is not a valid principal.'); return null; }
    const map = await loadLedgers();
    const l = createLedgerActor(map[wToken], { agentOptions: agentOpts });
    const res = await l.icrc1_transfer({ to: { owner: dest, subaccount: undefined }, amount });
    if (res.__kind__ === 'Err') {
      throw new Error(JSON.stringify(res.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    }
    setWAmount('');
    await refreshBalances();
    return `${fmtUnits(amount, meta.decimals)} ${meta.label} sent to ${formatPrincipal(dest)}.`;
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
      throw new Error(JSON.stringify(err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    } catch (e) {
      if (String(e).includes('NoNewUtxos')) return 'No new BTC found yet.';
      throw e;
    }
  });

  // ── native: BTC withdrawal (the only native off-ramp; ETH/USDC/USDT leave
  //    as their ck twins via the on-IC withdraw above) ──
  const withdrawBtc = () => run('n-withdraw', async () => {
    const map = await loadLedgers();
    const amount = parseUnits(nAmount, 8);
    if (!amount || amount <= 0n) { setError('Enter a valid BTC amount.'); return null; }
    const approver = makeApprover(map.CkBTC, agentOpts);
    await approver.icrc2_approve({
      from_subaccount: [], spender: { owner: Principal.fromText(CKBTC_MINTER_ID), subaccount: [] },
      amount: amount + 1000n, expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [],
    });
    const minter = makeCkbtcMinter(agentOpts);
    const res = await minter.retrieve_btc_with_approval({ address: nDest.trim(), amount, from_subaccount: [] });
    if ('Err' in res) throw new Error(JSON.stringify(res.Err, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    await refreshBalances();
    return `BTC withdrawal queued (block ${res.Ok.block_index}) — the minter batches retrievals to Bitcoin.`;
  });

  return (
    <>
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

      {/* Deposit — first, above withdrawals */}
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

      {/* Withdraw */}
      <div className="col" style={{ ...card, gap: 12 }}>
        <Eyebrow>Withdraw</Eyebrow>
        <div className="col" style={{ gap: 8 }}>
          <b style={{ fontSize: 13 }}>To any Internet Computer principal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {WALLET_TOKENS_META.map(({ token, label }) => (
              <Btn key={token} variant={wToken === token ? 'primary' : 'ghost'} sm onClick={() => setWToken(token)}>{label}</Btn>
            ))}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="text" placeholder="Amount" className="burn-input" style={{ ...inputStyle, maxWidth: 180 }}
              value={wAmount} onChange={e => setWAmount(e.target.value)} />
            <input type="text" placeholder="Destination principal" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
              value={wDest} onChange={e => setWDest(e.target.value)} />
            <Btn variant="primary" sm onClick={withdrawIc} disabled={busy !== null || !wAmount || !wDest}>
              {busy === 'w-ic' ? '…' : 'Withdraw'}
            </Btn>
          </div>
        </div>

        {/* Native BTC off-ramp (mainnet only) */}
        {!isLocal && (
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ fontSize: 13 }}>To a native Bitcoin address</b>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" placeholder="Amount (BTC)" className="burn-input" style={{ ...inputStyle, maxWidth: 180 }}
                value={nAmount} onChange={e => setNAmount(e.target.value)} />
              <input type="text" placeholder="Bitcoin address" className="burn-input" style={{ ...inputStyle, minWidth: 260 }}
                value={nDest} onChange={e => setNDest(e.target.value)} />
              <Btn variant="primary" sm onClick={withdrawBtc} disabled={busy !== null || !nAmount || !nDest}>
                {busy === 'n-withdraw' ? '…' : 'Withdraw BTC'}
              </Btn>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              Spends your ckBTC; the minter batches retrievals to Bitcoin. The flow asks the ledger
              for an approval first — two transactions total.
            </span>
          </div>
        )}
      </div>
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
