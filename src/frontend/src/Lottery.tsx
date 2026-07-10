import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { DrawStatus, ExplorerToken } from "./bindings/backend";
import type { LotteryInfo, LotteryDraw } from "./bindings/backend";
import { Icon, Eyebrow, Chip, Btn, LiveDot, Skeleton, fmtICP, formatPrincipal, usePageDevControls } from "./ui";
import { useErrorImpression } from "./analytics";

// ==========================================
// No-Loss Lottery — stake-weighted tickets, dynamic odds (one winner a month
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

/** Countdown split into DD/HH/MM/SS block values; null when passed. */
export function countdownParts(atNs: bigint, nowMs: number): { days: string; hours: string; mins: string; secs: string } | null {
  const ms = Number(atNs / 1_000_000n) - nowMs;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return {
    days: String(Math.floor(s / 86_400)).padStart(2, '0'),
    hours: String(Math.floor((s % 86_400) / 3600)).padStart(2, '0'),
    mins: String(Math.floor((s % 3600) / 60)).padStart(2, '0'),
    secs: String(s % 60).padStart(2, '0'),
  };
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
  solana_lp: 'Solana LP rewards ($ANSEM)',
  icpswap_lp: 'ICPSwap LP staking',
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
    const text = `🔥 Cycle Burn's No-Loss Lottery jackpot is ${pot} ICP${usd} — next drawing ${when}. Stake ICP for free daily tickets; nobody loses. 🔥 $ICP`;
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

  const jackpotUsd = info && icpRateE8s > 0n
    ? Number(info.pot_e8s * icpRateE8s / 100_000_000n) / 1e8
    : null;
  const winChance = info && info.my_tickets > 0n
    ? `${info.my_tickets.toLocaleString()} in ${info.odds_denominator.toLocaleString()}`
    : null;

  return (
    <div className="idea-board-container">
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



      {/* ── Hero: pot → no-loss line → countdown blocks → one CTA ── */}
      {loading && !info ? (
        <div className="col" style={{ ...card, gap: 14, width: '100%', alignItems: 'center', padding: '40px 16px' }} aria-busy="true" aria-label="Loading lottery info">
          <Skeleton width={90} height={11} />
          <Skeleton width={260} height={64} radius={10} />
          <Skeleton width={200} height={13} />
          <Skeleton width={300} height={64} radius={10} style={{ marginTop: 10 }} />
          <Skeleton width={180} height={40} radius={999} style={{ marginTop: 10 }} />
        </div>
      ) : (
      <div className="col" style={{ ...card, gap: 0, alignItems: 'center', textAlign: 'center', padding: '44px 20px 36px' }}>
        <span className="mono" style={{ fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--burn-ink)', fontWeight: 700 }}>
          Next draw
        </span>
        {/* The number IS the page. */}
        <div className="row" style={{ gap: 12, alignItems: 'baseline', justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <b style={{
            fontFamily: 'var(--font-display)', fontWeight: 700, lineHeight: 1,
            fontSize: 'clamp(56px, 14vw, 96px)', letterSpacing: '-0.03em',
            color: 'var(--burn-ink)', fontVariantNumeric: 'tabular-nums',
            textShadow: '0 0 44px color-mix(in srgb, var(--burn) 45%, transparent)',
          }}>
            {fmtICP(info?.pot_e8s ?? 0n)}
          </b>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(20px, 4vw, 30px)', fontWeight: 600, color: 'var(--burn-ink)' }}>ICP</span>
        </div>
        {jackpotUsd != null && (
          <span className="mono" style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 8 }}>
            ≈ ${jackpotUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        )}
        {/* Countdown blocks */}
        {(() => {
          const parts = info && info.next_draw_at > 0n ? countdownParts(info.next_draw_at, Date.now()) : null;
          const block = (v: string, label: string, hot: boolean) => (
            <div key={label} className="col" style={{
              alignItems: 'center', gap: 4, padding: '14px 0', width: 'clamp(64px, 18vw, 96px)',
              border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-alt)',
            }}>
              <b className="mono" style={{ fontSize: 'clamp(22px, 5vw, 32px)', lineHeight: 1, color: hot ? 'var(--burn-ink)' : 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{v}</b>
              <span className="mono" style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{label}</span>
            </div>
          );
          return (
            <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 26, flexWrap: 'wrap' }}>
              {parts ? (
                <>
                  {block(parts.days, 'days', false)}
                  {block(parts.hours, 'hours', false)}
                  {block(parts.mins, 'mins', false)}
                  {block(parts.secs, 'secs', true)}
                </>
              ) : (
                <span style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>
                  {info && info.next_draw_at > 0n
                    ? 'Drawing any moment now…'
                    : 'The countdown starts at the first ticket claim.'}
                </span>
              )}
            </div>
          );
        })()}
        {info && info.next_draw_at > 0n && (
          <span style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 10 }}>{drawDate(info.next_draw_at)}</span>
        )}

        {/* One CTA */}
        <div className="col" style={{ alignItems: 'center', gap: 10, marginTop: 30 }}>
          {!signedIn ? (
            <Btn variant="primary" onClick={onSignIn} style={{ borderRadius: 999, padding: '14px 34px', fontSize: 16, fontWeight: 700 }}>
              Get tickets
            </Btn>
          ) : info && !info.eligible && (info.my_tickets ?? 0n) === 0n && !info.admin_excluded ? (
            <Btn variant="primary" onClick={onGoStaking} style={{ borderRadius: 999, padding: '14px 34px', fontSize: 16, fontWeight: 700 }}>
              Get tickets
            </Btn>
          ) : (
            <>
              <Btn variant="primary" onClick={onGoStaking} style={{ borderRadius: 999, padding: '14px 34px', fontSize: 16, fontWeight: 700 }}>
                <Icon name="zap" size={15} stroke="var(--char-950)" /> Stake more · earn more tickets
              </Btn>
              <button onClick={shareDrawing} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--fg-2)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="share" size={13} stroke="currentColor" /> Share this drawing
              </button>
            </>
          )}
        </div>
      </div>
      )}

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
                  : "Tickets land automatically every day while staked."}
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

      </div>

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
