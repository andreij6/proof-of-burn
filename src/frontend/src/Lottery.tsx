import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { DrawStatus, ExplorerToken } from "./bindings/backend";
import type { LotteryInfo, LotteryDraw } from "./bindings/backend";
import { Icon, Eyebrow, Chip, Btn, LiveDot, Skeleton, MoreInfo, fmtICP, formatPrincipal, usePageDevControls } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// Lossless Lottery — stake-weighted tickets, dynamic odds (one winner a month
// in expectation) over the staking-yield pot.
// Stakers only: the daily ticket grant scales with the staked term
// (6mo = 5, 1y = 10, 2y = 20, summed across tiers). Each ticket has the
// dynamic odds (each drawing has a 1-in-13 chance of a winner) at the three weekly
// drawings. Tickets accumulate until someone wins, then the round restarts:
// the winner takes 65% of the pot, 30% seeds the next drawing, and 5% is
// burned to backend-canister cycles.
// ==========================================

interface LotteryProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
  /** Jump to the Staking tab of the Earn page — where tickets come from. */
  onGoStaking: () => void;
}

/** "2d 14:03:22" countdown to a nanosecond timestamp; null when passed. */
function countdownLabel(atNs: bigint): string | null {
  const ms = Number(atNs / 1_000_000n) - Date.now();
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86_400);
  const hh = String(Math.floor((s % 86_400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${days > 0 ? `${days}d ` : ''}${hh}:${mm}:${ss}`;
}

function drawDate(atNs: bigint): string {
  return new Date(Number(atNs / 1_000_000n)).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Human labels for ticket-source codes (fallback: the raw code). */
const TICKET_SOURCE_LABELS: Record<string, string> = {
  daily_stake: 'Daily staking claims',
  course_play: 'Mini Golf — playing courses',
  course_owner: 'Mini Golf — your courses played',
  luckproof_ev: 'Luck-Proof daily win — skill (EV)',
  luckproof_cash: 'Luck-Proof daily win — luck (cash)',
  discussions: 'Discussion rewards',
  dev: 'Dev grants (local)',
  test: 'Test grants',
};

export default function Lottery({ actor, principal, isLocal, onSignIn, onGoStaking }: LotteryProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<LotteryInfo | null>(null);
  const [breakdown, setBreakdown] = useState<{ source: string; count: bigint }[]>([]);
  const [loading, setLoading] = useState(true);
  const [icpRateE8s, setIcpRateE8s] = useState<bigint>(0n); // USD-e8s per 1 ICP
  const [draws, setDraws] = useState<LotteryDraw[]>([]);
  const [winners, setWinners] = useState<LotteryDraw[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Local-dev control inputs.
  const [devPotIcp, setDevPotIcp] = useState('25');
  const [devHolders, setDevHolders] = useState('25');
  useErrorImpression(error, 'lottery');
  // 1-second tick so the countdown re-renders.
  const [, setTick] = useState(0);

  const refresh = async () => {
    if (!actor) return;
    try {
      const [i, d, w, rates, srcRows] = await Promise.all([
        actor.get_lottery_info(),
        actor.list_lottery_draws(),
        actor.list_recent_winners(),
        actor.get_usd_rates().catch(() => [] as { token: string; rate_usd_e8s: bigint }[]),
        actor.get_my_ticket_breakdown().catch(() => []),
      ]);
      setInfo(i);
      setBreakdown(srcRows);
      setDraws(d);
      setWinners(w);
      const icp = (rates ?? []).find((r: { token: string; rate_usd_e8s: bigint }) => r.token === ExplorerToken.ICP);
      setIcpRateE8s(icp?.rate_usd_e8s ?? 0n);
    } catch (err) {
      console.error("Failed to fetch lottery state:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [actor, principal]);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Daily ticket grant: claim automatically the first time the signed-in,
  // staked user opens the page on a new UTC day (App also claims on login).
  useEffect(() => {
    if (!actor || !signedIn || !info || !info.enabled || !info.eligible || info.claimed_today) return;
    (async () => {
      try {
        const res = await actor.claim_daily_tickets();
        if (res.__kind__ === "Ok") {
          setNotice(`Today's ${info.my_daily_tickets} tickets are in — you hold ${res.Ok}.`);
          await refresh();
        }
      } catch { /* already claimed elsewhere / flag raced off — harmless */ }
    })();
  }, [actor, signedIn, info?.enabled, info?.eligible, info?.claimed_today]);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (!actor || busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDevDraw = (forceWin: boolean) => run(forceWin ? 'devwin' : 'devdraw', async () => {
    const res = await actor.dev_run_lottery_draw(forceWin);
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice(forceWin ? "Forced drawing held — ticket #0 wins." : "Drawing held at the live dynamic odds.");
    await refresh();
  });

  // Share the next drawing — native share sheet where available (mobile/desktop
  // Web Share), falling back to an X post intent. Entices new users to join.
  const shareDrawing = async () => {
    const pot = info ? fmtICP(info.pot_e8s) : '—';
    const when = info && info.next_draw_at > 0n ? drawDate(info.next_draw_at) : 'soon';
    const usd = jackpotUsd != null ? ` (≈ $${jackpotUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })})` : '';
    const text = `🔥 Cycle Burn's lossless lottery jackpot is ${pot} ICP${usd} — next drawing ${when}. Stake ICP for free daily tickets; nobody loses. 🔥 $ICP`;
    const url = `${window.location.origin}/#/lottery`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: 'Cycle Burn lottery', text, url }); return; } catch { /* cancelled */ }
    }
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      '_blank', 'noopener,noreferrer'
    );
  };

  const handleDevGrant = () => run('devgrant', async () => {
    const res = await actor.dev_grant_lottery_tickets(10n);
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice(`Granted 10 tickets — you now hold ${res.Ok}.`);
    await refresh();
  });

  const handleDevFundPot = () => run('devpot', async () => {
    const icp = parseFloat(devPotIcp);
    if (!isFinite(icp) || icp <= 0) { setError("Enter a positive ICP amount."); return; }
    const res = await actor.dev_fund_lottery_pot(BigInt(Math.round(icp * 1e8)));
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice(`Added ${icp} ICP to the pot.`);
    await refresh();
  });

  const handleDevSimWin = () => run('devsimwin', async () => {
    const res = await actor.dev_simulate_lottery_win();
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice("Simulated a win — reloading to show the banner…");
    setTimeout(() => window.location.reload(), 700);
  });

  const handleDevSeedHolders = () => run('devholders', async () => {
    const n = parseInt(devHolders, 10);
    if (!Number.isFinite(n) || n <= 0) { setError("Enter a positive count."); return; }
    const res = await actor.dev_seed_lottery_holders(BigInt(n));
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice(`Seeded ${n} synthetic holders — the round now has ${res.Ok} unique holders.`);
    await refresh();
  });

  // Surface the lottery's local-dev controls in App's Dashboard & Controls panel.
  usePageDevControls(isLocal && signedIn, () => (
    <div className="col" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)' }}>Lottery · tickets & drawings</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Btn variant="secondary" sm onClick={handleDevGrant} disabled={busy !== null}>
          {busy === 'devgrant' ? <LiveDot size={7} /> : <Icon name="ticket" size={13} />} Grant me 10 tickets
        </Btn>
        <Btn variant="secondary" sm onClick={() => handleDevDraw(false)} disabled={busy !== null}>
          {busy === 'devdraw' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} />} Draw (real odds)
        </Btn>
        <Btn variant="secondary" sm onClick={() => handleDevDraw(true)} disabled={busy !== null}>
          {busy === 'devwin' ? <LiveDot size={7} /> : <Icon name="ticket" size={13} />} Draw (force win)
        </Btn>
        <Btn variant="secondary" sm onClick={handleDevSimWin} disabled={busy !== null}>
          {busy === 'devsimwin' ? <LiveDot size={7} /> : <Icon name="spark" size={13} />} Simulate my win (banner)
        </Btn>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        Grant adds 10 tickets to your current-round holding (no staking needed). Force-win rigs ticket #0.
      </span>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-2)', marginTop: 4 }}>Lottery · pot & players</span>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="burn-input" type="number" min="0" step="1" value={devPotIcp}
          onChange={(e) => setDevPotIcp(e.target.value)} style={{ width: 88 }} aria-label="ICP to add to pot" />
        <Btn variant="secondary" sm onClick={handleDevFundPot} disabled={busy !== null}>
          {busy === 'devpot' ? <LiveDot size={7} /> : <Icon name="zap" size={13} />} Add ICP to pot
        </Btn>
        <input className="burn-input" type="number" min="1" step="1" value={devHolders}
          onChange={(e) => setDevHolders(e.target.value)} style={{ width: 88 }} aria-label="unique holders to add" />
        <Btn variant="secondary" sm onClick={handleDevSeedHolders} disabled={busy !== null}>
          {busy === 'devholders' ? <LiveDot size={7} /> : <Icon name="ticket" size={13} />} Add unique holders
        </Btn>
      </div>
      <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
        "Add ICP to pot" tops up the pot from the canister. "Add unique holders" seeds N synthetic
        ticket-holders so you can cross the minimum-players gate.
      </span>
    </div>
  ), [busy, devPotIcp, devHolders]);

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  const countdown = info && info.next_draw_at > 0n ? countdownLabel(info.next_draw_at) : null;
  const jackpotUsd = info && icpRateE8s > 0n
    ? Number(info.pot_e8s * icpRateE8s / 100_000_000n) / 1e8
    : null;
  const winChance = info && info.my_tickets > 0n
    ? `${info.my_tickets.toLocaleString()} in ${info.odds_denominator.toLocaleString()}`
    : null;

  return (
    <div className="idea-board-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="ticket" size={16} stroke="var(--burn-ink)" />
          <Eyebrow accent>Lossless lottery</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Stake to play. Nobody loses.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          Stakers collect free tickets every day — win and the ICP lands straight in your wallet.{' '}
          <MoreInfo title="How the lossless lottery works">
            <div className="card col" style={{ gap: 8, borderColor: 'var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
              <Eyebrow accent>The gist</Eyebrow>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                <b>Nobody ever pays in.</b> The prize pool is funded by staking yield — you collect free
                tickets just for staking, and winnings land straight in your wallet.
              </p>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>Earning tickets</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Stake to qualify:</b> 5 / 10 / 20 tickets a day per ICP for 6-month / 1-year / 2-year terms (tiers add up).</li>
                <li><b>Scales with your stake:</b> 1 ICP for 6 months → 5 tickets/day; 500 ICP for 2 years → 10,000/day.</li>
                <li><b>Stay staked:</b> unstake everything and your tickets void on the spot.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The odds</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>Fixed 1-in-13 chance</b> of a winner per drawing, regardless of ticket count.</li>
                <li>Three drawings a week ≈ <b>one jackpot a month</b> on average (96% chance of one within 3 months).</li>
                <li>Your tickets are your <b>share of that chance</b>.</li>
              </ul>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <Eyebrow accent>The payout</Eyebrow>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-1)' }}>
                <li><b>65% to the winner</b> — paid automatically, nothing to claim.</li>
                <li><b>30% seeds the next round</b>; <b>5% is burned</b> to backend-canister cycles.</li>
                <li>Everyone's tickets reset and a fresh round begins.</li>
              </ul>
            </div>
          </MoreInfo>
        </span>
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

      {info?.last_winner != null && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: '1px solid var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))',
        }}>
          <Icon name="spark" size={13} stroke="var(--burn-ink)" />
          <span>
            Last jackpot: <b className="mono">{formatPrincipal(info.last_winner)}</b> won
            — lifetime paid out <b className="mono">{fmtICP(info.total_paid_e8s)} ICP</b>. Round {Number(info.round)} is live.
          </span>
        </div>
      )}

      {/* ── Next drawing + jackpot. A shimmer card stands in while the lottery
            info is still loading. ── */}
      {loading && !info ? (
        <div className="col" style={{ ...card, gap: 14, width: '100%', alignItems: 'center' }} aria-busy="true" aria-label="Loading lottery info">
          <Skeleton width={90} height={11} />
          <Skeleton width={180} height={13} />
          <Skeleton width={160} height={30} radius={8} />
          <Skeleton width={70} height={11} style={{ marginTop: 6 }} />
          <Skeleton width={150} height={30} radius={8} />
          <Skeleton width={100} height={11} style={{ marginTop: 6 }} />
          <Skeleton width={120} height={22} radius={8} />
          <Skeleton width={90} height={11} style={{ marginTop: 6 }} />
          <Skeleton width={60} height={22} radius={8} />
        </div>
      ) : (<>
      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
      <div className="col" style={{ ...card, gap: 6, flex: '3 1 0', minWidth: 320, alignItems: 'center', textAlign: 'center' }}>
        <Eyebrow>Next drawing</Eyebrow>
        {/* Date */}
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          {info && info.next_draw_at > 0n ? drawDate(info.next_draw_at) : "Scheduled at the first ticket claim."}
        </span>
        {/* Countdown */}
        <b className="mono" style={{ fontSize: 30, lineHeight: 1.15 }}>
          {loading && !info
            ? <LiveDot size={9} color="var(--burn-ink)" />
            : countdown ?? (info && info.next_draw_at > 0n ? "any moment" : "—")}
        </b>
        {/* Jackpot */}
        <Eyebrow style={{ marginTop: 8 }}>Jackpot</Eyebrow>
        <div className="row" style={{ gap: 10, alignItems: 'baseline', justifyContent: 'center' }}>
          <b className="mono" style={{ fontSize: 30, lineHeight: 1.15, color: 'var(--sprout-ink)' }}>
            {loading && !info ? <LiveDot size={9} color="var(--sprout-ink)" /> : fmtICP(info?.pot_e8s ?? 0n)}
          </b>
          <span style={{ fontSize: 13, color: 'var(--sprout-ink)' }}>ICP</span>
        </div>
        {/* Jackpot in USD */}
        <Eyebrow style={{ marginTop: 8 }}>Jackpot in USD</Eyebrow>
        <b className="mono" style={{ fontSize: 22, lineHeight: 1.15, color: 'var(--sprout-ink)' }}>
          {loading && !info
            ? <LiveDot size={8} color="var(--sprout-ink)" />
            : jackpotUsd != null ? `$${jackpotUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
        </b>
        {/* Participants */}
        <Eyebrow style={{ marginTop: 8 }}>Participants</Eyebrow>
        <b className="mono" style={{ fontSize: 22, lineHeight: 1.15 }}>
          {loading && !info
            ? <LiveDot size={8} color="var(--burn-ink)" />
            : Number(info?.unique_holders ?? 0n).toLocaleString()}
        </b>
        {/* Share — entice new users to join the next drawing */}
        <button onClick={shareDrawing} title="Share the next drawing" style={{
          background: 'transparent', border: '1px solid var(--burn)', borderRadius: 8,
          color: 'var(--burn-ink)', cursor: 'pointer', padding: '8px 14px', fontSize: 12.5,
          fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6,
        }}>
          <Icon name="share" size={13} stroke="var(--burn-ink)" /> Share this drawing
        </button>
      </div>

      {/* ── Draw thresholds — pot & players must both fill for a drawing to run ── */}
      {info && (
        <div className="col" style={{ ...card, gap: 12, flex: '2 1 0', minWidth: 220 }}>
          <Eyebrow>Draw thresholds</Eyebrow>
          <ThresholdBar
            label="Jackpot pot"
            current={Number(info.pot_e8s) / 1e8}
            target={Number(info.min_pot_e8s) / 1e8}
            unit="ICP"
            fill="var(--sprout-ink)"
          />
          <ThresholdBar
            label="Participants"
            current={Number(info.unique_holders)}
            target={Number(info.min_unique_holders)}
            unit="players"
            fill="var(--burn)"
          />
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            A drawing runs only when <b>both</b> bars are full — enough ICP in the pot and enough unique
            players in the round. Otherwise the round rolls over and the countdown restarts.
          </span>
        </div>
      )}
      </div>
      </>)}

      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ── Your tickets ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 240px', minWidth: 240 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Your tickets</Eyebrow>
            {info?.claimed_today && <Chip tone="ok"><Icon name="check" size={11} /> Claimed today</Chip>}
          </span>
          {!signedIn ? (
            <div className="col" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Sign in and stake to collect daily tickets.
              </span>
              <Btn variant="primary" sm onClick={onSignIn}>
                <Icon name="key" size={13} stroke="var(--char-950)" /> Sign in
              </Btn>
            </div>
          ) : info?.admin_excluded && (info?.my_tickets ?? 0n) === 0n ? (
            <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Admins sit this one out — the house never holds tickets. Every drawing belongs
                entirely to the community.
              </span>
              <Chip tone="muted"><Icon name="key" size={11} /> Admin — excluded</Chip>
            </div>
          ) : info && !info.eligible && (info.my_tickets ?? 0n) === 0n ? (
            <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Staking is the entry ticket: stake ICP to start collecting
                5 / 10 / 20 free tickets a day (6-month / 1-year / 2-year terms).
              </span>
              <Btn variant="primary" sm onClick={onGoStaking}>
                <Icon name="zap" size={13} stroke="var(--char-950)" /> Stake to earn tickets
              </Btn>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <b className="mono" style={{ fontSize: 24 }}>{Number(info?.my_tickets ?? 0n).toLocaleString()}</b>
                <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                  of {Number(info?.total_tickets ?? 0n).toLocaleString()} in round {Number(info?.round ?? 1n)}
                </span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                {winChance
                  ? <>Your jackpot chance this drawing: <span className="mono">{winChance}</span>.</>
                  : "Tickets land automatically on your first visit each day."}
                {info && info.my_daily_tickets > 0n && (
                  <> Your grant: <span className="mono">{Number(info.my_daily_tickets)}</span>/day.</>
                )}
              </span>
              {(info?.my_tickets ?? 0n) > 0n && (() => {
                // Where this round's tickets came from. Tickets credited
                // before source-tracking shipped show as "Earlier grants".
                const tracked = breakdown.reduce((a, r) => a + Number(r.count), 0);
                const earlier = Number(info?.my_tickets ?? 0n) - tracked;
                const rows = [
                  ...breakdown.map((r) => ({ label: TICKET_SOURCE_LABELS[r.source] ?? r.source, count: Number(r.count) })),
                  ...(earlier > 0 ? [{ label: 'Earlier grants (untracked)', count: earlier }] : []),
                ];
                return rows.length === 0 ? null : (
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
                );
              })()}
            </>
          )}
        </div>

        {/* ── Earn tickets → Staking ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 240px', minWidth: 240, border: '1px solid var(--burn)', background: 'color-mix(in srgb, var(--burn) 12%, var(--surface))' }}>
          <Eyebrow accent>Earn tickets</Eyebrow>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            Tickets come from lossless staking — your ICP keeps earning, and every
            staked day mints new chances to win.
          </span>
          <Btn variant="primary" sm style={{ alignSelf: 'flex-start' }} onClick={onGoStaking}>
            <Icon name="zap" size={13} stroke="var(--char-950)" /> Go to Staking
          </Btn>
        </div>
      </div>

      {/* ── Recent drawings (last 10) ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <Eyebrow>Recent drawings</Eyebrow>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            last 10 of {Number(info?.draws_held ?? 0n)} held
          </span>
        </span>
        {draws.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            No drawings yet — the first one runs at the next scheduled slot.
          </span>
        ) : (
          <div className="col" style={{ gap: 0 }}>
            {draws.slice(0, 10).map((d) => (
              <div key={String(d.id)} className="row" style={{
                gap: 10, padding: '8px 0', fontSize: 12.5, flexWrap: 'wrap',
                borderTop: '1px solid var(--border)', justifyContent: 'space-between',
              }}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="mono" style={{ color: 'var(--fg-3)' }}>#{String(d.id)}</span>
                  <span>{drawDate(d.drawn_at)}</span>
                  <span style={{ color: 'var(--fg-3)' }}>
                    {Number(d.total_tickets).toLocaleString()} tickets · pot {fmtICP(d.pot_e8s)} ICP
                  </span>
                </span>
                {d.winner != null ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Chip tone="ok"><Icon name="spark" size={11} /> {formatPrincipal(d.winner)} won {fmtICP(d.prize_e8s)} ICP</Chip>
                    {d.status === DrawStatus.PayoutPending && <Chip tone="pending"><LiveDot size={6} /> paying…</Chip>}
                  </span>
                ) : (
                  <Chip tone="muted">No jackpot — pot rolls over</Chip>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recent winners (last 10) ── */}
      <div className="col" style={{ ...card, gap: 10 }}>
        <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
          <Eyebrow>Recent winners</Eyebrow>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            paid instantly — no claiming
          </span>
        </span>
        {winners.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>
            No jackpots yet. Every rollover makes the next one bigger.
          </span>
        ) : (
          <div className="col" style={{ gap: 0 }}>
            {winners.map((d) => (
              <div key={String(d.id)} className="row" style={{
                gap: 10, padding: '8px 0', fontSize: 12.5, flexWrap: 'wrap',
                borderTop: '1px solid var(--border)', justifyContent: 'space-between',
              }}>
                <span className="row" style={{ gap: 8 }}>
                  <Icon name="spark" size={13} stroke="var(--burn-ink)" />
                  <b className="mono">{d.winner != null ? formatPrincipal(d.winner) : '—'}</b>
                  <span style={{ color: 'var(--fg-3)' }}>{drawDate(d.drawn_at)} · round {Number(d.round)}</span>
                </span>
                <Chip tone="ok">won {fmtICP(d.prize_e8s)} ICP</Chip>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

// Progress bar for a draw threshold (pot or unique players). Theme-token colors;
// turns green and shows ✓ once the threshold is met. target ≤ 0 = no gate.
function ThresholdBar({ label, current, target, unit, fill }: {
  label: string; current: number; target: number; unit: string; fill: string;
}) {
  const noGate = target <= 0;
  const pct = noGate ? 100 : Math.min(100, (current / target) * 100);
  const met = noGate || current >= target;
  return (
    <div className="col" style={{ gap: 5, width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{label}</span>
        <span className="mono" style={{ fontSize: 12, color: met ? 'var(--sprout-ink)' : 'var(--fg-2)' }}>
          {current.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          {noGate ? '' : ` / ${target.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} {unit}
          {met ? ' ✓' : ''}
        </span>
      </div>
      <div style={{ height: 9, borderRadius: 999, background: 'var(--bg-alt)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: met ? 'var(--sprout-ink)' : fill, borderRadius: 999, transition: 'width 300ms ease' }} />
      </div>
    </div>
  );
}
