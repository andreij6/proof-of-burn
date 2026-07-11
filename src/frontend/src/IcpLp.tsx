import { useEffect, useState } from 'react';
import { Principal } from '@icp-sdk/core/principal';
import { Btn, Chip, Eyebrow, Icon, LiveDot, Skeleton, MoreInfo } from './ui';

// ==========================================
// ICP LP — stake ICPSwap positions, fund the pot, earn tickets.
//
// Model B (okf/ideas/icpswap-lp-stake): the user transfers their ICPSwap
// position NFT to the app canister (the transfer IS the ownership proof),
// registers it here, and earns 10 lottery tickets automatically every
// drawing while it stays staked. The app's sweep harvests each position's
// trading fees: ICP goes 50% to the lottery pot and 50% to the cycles burn
// (split between the backend and frontend canisters); every other token
// (ckUSDC/ckUSDT/ckBTC/ckETH) accrues to the app treasury. Unstake returns
// the position — exactly as-is — to any principal the user names.
// ==========================================

/** Friendly copy for stake/unstake error codes. */
export function friendlyIcpLpErr(code: string): string {
  switch (code) {
    case 'FEATURE_DISABLED': return 'Liquidity Provider staking isn\'t open yet — check back soon.';
    case 'POOL_NOT_CONFIGURED': return 'That pool isn\'t in the qualifying list.';
    case 'POSITION_NOT_TRANSFERRED': return 'We don\'t see that position under the app\'s principal yet — complete the transfer on ICPSwap first (My Positions → Transfer Position), then try again.';
    case 'NO_RESERVATION': return 'Reserve the position here FIRST, then transfer it on ICPSwap.';
    case 'RESERVATION_EXPIRED': return 'Your reservation expired — reserve the position again, then confirm.';
    case 'RESERVED_BY_OTHER': return 'That position id is reserved by another account.';
    case 'RESERVATION_LIMIT': return 'You have too many open reservations — confirm or let one expire first.';
    case 'POSITION_ALREADY_STAKED': return 'That position is already registered.';
    case 'NOT_YOUR_POSITION': return 'Only the account that staked this position can unstake it.';
    default: return code;
  }
}

/** Parse a user-typed principal; null when empty or invalid. */
export function parsePrincipal(text: string): Principal | null {
  const t = text.trim();
  if (!t) return null;
  try { return Principal.fromText(t); } catch { return null; }
}

/** Parse a user-typed position id (a non-negative integer); null if invalid. */
export function parsePositionId(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  try { return BigInt(t); } catch { return null; }
}

interface LpPoolCfg { name: string; pool: Principal; token0_symbol: string; token0_ledger: Principal; token1_symbol: string; token1_ledger: Principal }
interface LpPosition { pool: Principal; pool_name: string; position_id: bigint; staked_at: bigint }
interface IcpLpInfo {
  enabled: boolean;
  round: bigint;
  tickets_per_usd_day: bigint;
  staked: boolean;
  backend_principal: Principal;
  my_positions: LpPosition[];
  my_reservations: { pool: Principal; pool_name: string; position_id: bigint; expires_at: bigint }[];
  pools: LpPoolCfg[];
  total_harvested_icp_e8s: bigint;
  granted_today: boolean;
}

interface IcpLpProps {
  actor: any;
  principal: Principal | null;
  onSignIn: () => void;
  /** Kept for App.tsx call-site stability; LP no longer needs an ICP stake. */
  onGoParticipate?: () => void;
}

export default function IcpLp({ actor, principal, onSignIn }: IcpLpProps) {
  const signedIn = !!principal && !principal.isAnonymous();
  const [info, setInfo] = useState<IcpLpInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Stake form.
  const [poolText, setPoolText] = useState('');
  const [posIdText, setPosIdText] = useState('');
  // Unstake flow: which position row is open + destination + confirm phase.
  const [unstakeKey, setUnstakeKey] = useState<string | null>(null);
  const [destText, setDestText] = useState('');
  const [confirming, setConfirming] = useState(false);

  const refresh = async () => {
    if (!actor) return;
    try {
      const i = await actor.get_icp_lp_info();
      setInfo(i);
      if (!poolText && i.pools.length > 0) setPoolText(i.pools[0].pool.toString());
    } catch { /* best-effort */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor, signedIn]);

  const copyPrincipal = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.backend_principal.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard denied — the mono text is selectable */ }
  };

  const reservePosition = async () => {
    if (busy) return;
    setErr(null); setNotice(null);
    const pool = parsePrincipal(poolText);
    const pid = parsePositionId(posIdText);
    if (!pool) { setErr('Pick a pool.'); return; }
    if (pid === null) { setErr('Enter the numeric position id (shown on ICPSwap under My Positions).'); return; }
    setBusy('reserve');
    try {
      const res = await actor.reserve_lp_position(pool, pid);
      if (res.__kind__ === 'Err') throw new Error(friendlyIcpLpErr(res.Err));
      setNotice(`Position #${pid} reserved for 1 hour — now transfer it on ICPSwap, then confirm below.`);
      setPosIdText('');
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const confirmStake = async (pool: Principal, pid: bigint) => {
    if (busy) return;
    setErr(null); setNotice(null);
    setBusy('stake');
    try {
      const res = await actor.stake_lp_position(pool, pid);
      if (res.__kind__ === 'Err') throw new Error(friendlyIcpLpErr(res.Err));
      setNotice(`Position #${pid} staked — tickets now land daily, scaled to your LP's value.`);
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const startUnstake = (p: LpPosition) => {
    setUnstakeKey(`${p.pool.toString()}:${p.position_id}`);
    setDestText('');
    setConfirming(false);
    setErr(null); setNotice(null);
  };

  const doUnstake = async (p: LpPosition) => {
    if (busy) return;
    const dest = parsePrincipal(destText);
    if (!dest) { setErr('Enter a valid destination principal (your ICPSwap principal).'); return; }
    if (!confirming) { setConfirming(true); return; }
    setBusy('unstake'); setErr(null);
    try {
      const res = await actor.unstake_lp_position(p.pool, p.position_id, dest);
      if (res.__kind__ === 'Err') throw new Error(friendlyIcpLpErr(res.Err));
      setNotice(`Position #${p.position_id} returned to ${dest.toString().slice(0, 12)}…`);
      setUnstakeKey(null);
      await refresh();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const fmtDate = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toLocaleDateString();

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="stack" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Earn tickets</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Stake your ICPSwap LP. Earn lottery tickets.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          Transfer an ICPSwap position to the app and earn{' '}
          <b>{Number(info?.tickets_per_usd_day ?? 40n)} lottery tickets a day for every $1
          of LP value</b> — automatically, and you can reclaim your LP whenever you
          like.{' '}
          <MoreInfo title="How Liquidity Provider staking works">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Your liquidity keeps working — and earns lottery tickets on top.</b>{' '}
                Stake an ICPSwap position here and collect{' '}
                {Number(info?.tickets_per_usd_day ?? 40n)} tickets a day for every $1 of
                LP value, hands-free. Reclaim it any time.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Staking</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Reserve first:</b> lock your position id to your account here (1 hour), so nobody can claim it but you.</li>
                <li><b>Then transfer:</b> on ICPSwap, send the position to the app principal — the transfer itself proves ownership. No signatures, no bridges.</li>
                <li><b>Confirm</b> back here and you're staked.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Earning tickets</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Scales with value:</b> {Number(info?.tickets_per_usd_day ?? 40n)} tickets per day per $1 of LP — $25 of LP is {Number(info?.tickets_per_usd_day ?? 40n) * 25} tickets every day.</li>
                <li><b>Valued live, daily:</b> your position is re-priced each day from the pool itself and live USD rates.</li>
                <li><b>Your LP is the entry:</b> a staked position earns by itself — no separate ICP stake needed.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Unstaking &amp; risk</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Unstake anytime</b> — the position returns exactly as-is to a principal you name. Nobody else can ever move it, including us.</li>
                <li><b>Impermanent loss is yours:</b> providing liquidity carries market risk, and the app is <b>not responsible for impermanent loss</b> or changes in your position's value.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
      </div>

      {!signedIn ? (
        <div className="card col" style={{ gap: 10, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>Sign in to stake</b>
          <Btn variant="primary" onClick={onSignIn}>
            <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
          </Btn>
        </div>
      ) : (
        <>
          {notice && (
            <div className="row" style={{ gap: 8, border: '1px solid var(--sprout)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--sprout-ink)' }}>
              <Icon name="checkCircle" size={14} stroke="var(--sprout-ink)" /> {notice}
            </div>
          )}
          {err && (
            <div className="row" style={{ gap: 8, border: '1px solid var(--ember)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--ember)' }}>
              <Icon name="x" size={14} stroke="var(--ember)" /> {err}
            </div>
          )}

          <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
            {/* ── How to stake ── */}
            <div className="card col" style={{ gap: 10, flex: '1 1 300px', minWidth: 300 }}>
              <Eyebrow accent>Stake a position</Eyebrow>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <li>
                  <span className="col" style={{ gap: 8, display: 'flex' }}>
                    <span><b>Reserve it here first</b> — this locks the position id to your account for 1 hour, so nobody else can claim it:</span>
                    <select
                      className="burn-input"
                      value={poolText}
                      onChange={(e) => setPoolText(e.target.value)}
                      aria-label="Pool"
                      style={{ fontSize: 12.5 }}
                    >
                      {(info?.pools ?? []).map((p) => (
                        <option key={p.pool.toString()} value={p.pool.toString()}>{p.name}</option>
                      ))}
                      {(info?.pools?.length ?? 0) === 0 && <option value="">No pools configured yet</option>}
                    </select>
                    <input
                      className="burn-input"
                      placeholder="Position ID (e.g. 42)"
                      value={posIdText}
                      onChange={(e) => setPosIdText(e.target.value)}
                      inputMode="numeric"
                      aria-label="Position ID"
                    />
                    <Btn variant="primary" onClick={reservePosition} disabled={busy !== null || (info?.pools?.length ?? 0) === 0}>
                      {busy === 'reserve' ? <LiveDot size={8} /> : <Icon name="stack" size={13} stroke="var(--char-950)" />} Reserve position
                    </Btn>
                  </span>
                </li>
                <li>
                  Then on{' '}
                  <a href="https://app.icpswap.com/liquidity" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--burn-ink)', fontWeight: 600 }}>
                    ICPSwap → My Positions
                  </a>
                  : pick the position → <b>Transfer Position</b> to the app principal:
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="mono" style={{ fontSize: 10.5, background: 'var(--bg-alt)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>
                      {info?.backend_principal?.toString() ?? '…'}
                    </span>
                    <Btn variant="secondary" sm onClick={copyPrincipal}>
                      <Icon name={copied ? 'check' : 'copy'} size={11} /> {copied ? 'Copied' : 'Copy'}
                    </Btn>
                  </span>
                </li>
                <li>
                  Come back and <b>confirm</b> the reservation below.
                </li>
              </ol>
              {(info?.my_reservations?.length ?? 0) > 0 && (
                <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>Your reservations</span>
                  {info!.my_reservations.map((r: any) => (
                    <span key={`${r.pool.toString()}-${r.position_id}`} className="row" style={{ gap: 8, justifyContent: 'space-between', fontSize: 12.5, flexWrap: 'wrap' }}>
                      <span className="mono">#{String(r.position_id)} · {r.pool_name || 'pool'} · expires {new Date(Number(r.expires_at / 1_000_000n)).toLocaleTimeString()}</span>
                      <Btn variant="primary" sm onClick={() => confirmStake(r.pool, r.position_id)} disabled={busy !== null}>
                        {busy === 'stake' ? <LiveDot size={7} /> : <Icon name="check" size={11} stroke="var(--char-950)" />} Confirm stake
                      </Btn>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ── Your staked positions ── */}
            <div className="card col" style={{ gap: 10, flex: '1 1 300px', minWidth: 300 }}>
              <Eyebrow>Your staked positions</Eyebrow>
              {info === null ? (
                <div className="col" style={{ gap: 8 }} aria-busy="true" aria-label="Loading positions">
                  <Skeleton width="100%" height={16} />
                  <Skeleton width="80%" height={16} />
                </div>
              ) : (info?.my_positions?.length ?? 0) === 0 ? (
                <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
                  Nothing staked yet. Registered positions appear here with an
                  unstake option.
                </span>
              ) : (
                info!.my_positions.map((p) => {
                  const key = `${p.pool.toString()}:${p.position_id}`;
                  const open = unstakeKey === key;
                  return (
                    <div key={key} className="col" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <span className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                        <span className="row" style={{ gap: 8 }}>
                          <Icon name="stack" size={13} stroke="var(--burn-ink)" />
                          <b style={{ fontSize: 13 }}>{p.pool_name}</b>
                          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>#{p.position_id.toString()}</span>
                        </span>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>since {fmtDate(p.staked_at)}</span>
                          {!open && (
                            <Btn variant="ghost" sm onClick={() => startUnstake(p)}>Unstake</Btn>
                          )}
                        </span>
                      </span>
                      {open && (
                        <div className="col" style={{ gap: 6 }}>
                          <input
                            className="burn-input"
                            placeholder="Destination principal (your ICPSwap principal)"
                            value={destText}
                            onChange={(e) => { setDestText(e.target.value); setConfirming(false); }}
                            aria-label="Destination principal"
                          />
                          {confirming && parsePrincipal(destText) && (
                            <span style={{ fontSize: 12, color: 'var(--haze-ink)' }}>
                              Confirm: position #{p.position_id.toString()} will be transferred to{' '}
                              <span className="mono">{parsePrincipal(destText)!.toString()}</span>. This
                              account must be able to see it on ICPSwap.
                            </span>
                          )}
                          <span className="row" style={{ gap: 6 }}>
                            <Btn variant={confirming ? 'danger' : 'secondary'} sm onClick={() => doUnstake(p)} disabled={busy !== null}>
                              {busy === 'unstake' ? <LiveDot size={7} /> : null}
                              {confirming ? 'Confirm unstake' : 'Unstake…'}
                            </Btn>
                            <Btn variant="ghost" sm onClick={() => setUnstakeKey(null)}>Cancel</Btn>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>
            Providing liquidity carries market risk, including impermanent loss.
            Your staked position's value can change; the app is not responsible for
            impermanent loss. You can unstake and reclaim your LP at any time.
          </span>

          {/* ── Qualifying pools ── */}
          <div className="card col" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <b style={{ fontSize: 13.5 }}>Qualifying pools</b>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                positions in these pools qualify
              </span>
            </span>
            {(info?.pools?.length ?? 0) === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>No pools configured yet.</span>
            ) : (
              info!.pools.map((p) => (
                <span key={p.pool.toString()} className="row" style={{ gap: 8, justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name="stack" size={12} stroke="var(--burn-ink)" /> {p.name}
                    <Chip tone="muted" style={{ height: 17, fontSize: 9.5 }}>{p.token0_symbol}/{p.token1_symbol}</Chip>
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{p.pool.toString()}</span>
                </span>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
