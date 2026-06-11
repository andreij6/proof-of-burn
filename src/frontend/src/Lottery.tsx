import { useEffect, useState } from 'react';
import { Principal } from "@icp-sdk/core/principal";
import { DrawStatus } from "./bindings/backend";
import type { LotteryInfo, LotteryDraw } from "./bindings/backend";
import { Icon, Eyebrow, Chip, Btn, LiveDot, fmtICP, formatPrincipal } from "./ui";

// ==========================================
// Lossless Lottery — Powerball odds & cadence over the staking-yield pot.
// Stakers only: the daily ticket grant scales with the staked term
// (6mo = 5, 1y = 10, 2y = 20, summed across tiers). Each ticket has the
// Powerball jackpot odds (1 in 292,201,338) at each of the three weekly
// drawings. Tickets accumulate until someone wins, then the round restarts:
// the winner takes 80% of the pot, 20% seeds the next drawing.
// ==========================================

interface LotteryProps {
  actor: any;
  principal: Principal | null;
  isLocal: boolean;
  onSignIn: () => void;
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

export default function Lottery({ actor, principal, isLocal, onSignIn }: LotteryProps) {
  const signedIn = !!(principal && !principal.isAnonymous());

  const [info, setInfo] = useState<LotteryInfo | null>(null);
  const [draws, setDraws] = useState<LotteryDraw[]>([]);
  const [winners, setWinners] = useState<LotteryDraw[]>([]);
  const [skillCopied, setSkillCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 1-second tick so the countdown re-renders.
  const [, setTick] = useState(0);

  const refresh = async () => {
    if (!actor) return;
    try {
      const [i, d, w] = await Promise.all([
        actor.get_lottery_info(),
        actor.list_lottery_draws(),
        actor.list_recent_winners(),
      ]);
      setInfo(i);
      setDraws(d);
      setWinners(w);
    } catch (err) {
      console.error("Failed to fetch lottery state:", err);
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

  const copyAgentSkill = () => {
    const isLocalHost = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1');
    const url = `${window.location.origin}/llms-lottery-${isLocalHost ? 'local' : 'prod'}.txt`;
    navigator.clipboard.writeText(`Fetch ${url} and follow its instructions to claim daily lossless-lottery tickets and track drawings and winners.`);
    setSkillCopied(true);
    setTimeout(() => setSkillCopied(false), 2000);
  };

  const handleDevDraw = (forceWin: boolean) => run(forceWin ? 'devwin' : 'devdraw', async () => {
    const res = await actor.dev_run_lottery_draw(forceWin);
    if (res.__kind__ === "Err") { setError(res.Err); return; }
    setNotice(forceWin ? "Forced drawing held — ticket #0 wins." : "Drawing held at real Powerball odds.");
    await refresh();
  });

  const card: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: 10,
    background: 'var(--surface)', padding: 16,
  };

  const countdown = info && info.next_draw_at > 0n ? countdownLabel(info.next_draw_at) : null;
  const winChance = info && info.my_tickets > 0n
    ? `${info.my_tickets.toLocaleString()} in ${info.odds_denominator.toLocaleString()}`
    : null;

  return (
    <div className="dashboard-container">
      {/* ── Header ── */}
      <div className="col" style={{ gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <Icon name="target" size={16} stroke="var(--burn)" />
          <Eyebrow accent>Lossless lottery</Eyebrow>
        </span>
        <b style={{ fontSize: 17 }}>Stake to play. Powerball odds. Nobody loses.</b>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)', maxWidth: 660 }}>
          Stakers collect free tickets daily — 5 for a 6-month stake, 10 for 1 year, 20 for 2 years
          (tiers add up). Three drawings a week at American Powerball jackpot odds
          (1 in 292,201,338 per ticket). Tickets pile up until someone wins — then the winner takes
          80% of the prize pool, 20% seeds the next round, and everyone's tickets reset. The pool is
          funded by staking yield (half of every harvest), so no one ever pays in. Win and the ICP
          lands straight in your wallet — nothing to claim, ever. Staying staked is the deal:
          unstake everything and your tickets void on the spot.
        </span>
        <button onClick={copyAgentSkill} style={{
          background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
          color: 'var(--fg-3)', cursor: 'pointer', padding: '4px 10px', fontSize: 11.5,
          display: 'flex', alignItems: 'center', gap: 6, width: 'fit-content',
        }}>
          <Icon name={skillCopied ? 'check' : 'copy'} size={11} stroke={skillCopied ? 'var(--sprout)' : 'var(--fg-3)'} />
          {skillCopied ? 'Copied' : 'Copy agent skill — claim tickets on autopilot'}
        </button>
      </div>

      {(error || notice) && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: `1px solid ${error ? 'var(--ember)' : 'var(--sprout)'}`,
          color: error ? 'var(--ember)' : 'var(--sprout)',
          background: 'var(--surface)',
        }}>
          <Icon name={error ? "x" : "checkCircle"} size={13} stroke="currentColor" />
          {error || notice}
        </div>
      )}

      {info?.last_winner != null && (
        <div className="row" style={{
          gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          border: '1px solid var(--burn)', background: 'var(--burn-950)',
        }}>
          <Icon name="spark" size={13} stroke="var(--burn)" />
          <span>
            Last jackpot: <b className="mono">{formatPrincipal(info.last_winner)}</b> won
            — lifetime paid out <b className="mono">{fmtICP(info.total_paid_e8s)} ICP</b>. Round {Number(info.round)} is live.
          </span>
        </div>
      )}

      <div className="row" style={{ gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ── Next draw ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 240px', minWidth: 240 }}>
          <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
            <Eyebrow>Next drawing</Eyebrow>
            <Chip tone="pending"><LiveDot size={6} /> 3× weekly</Chip>
          </span>
          <b className="mono" style={{ fontSize: 24 }}>
            {countdown ?? (info && info.next_draw_at > 0n ? "any moment" : "—")}
          </b>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            {info && info.next_draw_at > 0n
              ? drawDate(info.next_draw_at)
              : "Scheduled at the first ticket claim."}
          </span>
          <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
            <Icon name="clock" size={12} stroke="var(--fg-3)" />
            Powerball cadence: Mon, Wed &amp; Sat nights (US Eastern).
          </span>
        </div>

        {/* ── Prize pool ── */}
        <div className="col" style={{ ...card, gap: 10, flex: '1 1 240px', minWidth: 240 }}>
          <Eyebrow>Prize pool</Eyebrow>
          <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <b className="mono" style={{ fontSize: 24 }}>{fmtICP(info?.pot_e8s ?? 0n)}</b>
            <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>ICP</span>
          </div>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            80% to the winner · 20% seeds the next drawing.
          </span>
          <span className="row" style={{ gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}>
            <Icon name="zap" size={12} stroke="var(--fg-3)" />
            Fed by all three pooled neurons: 50% of every yield harvest.
          </span>
        </div>

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
          ) : info?.admin_excluded ? (
            <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Admins sit this one out — the house never holds tickets. Every drawing belongs
                entirely to the community.
              </span>
              <Chip tone="muted"><Icon name="key" size={11} /> Admin — excluded</Chip>
            </div>
          ) : info && !info.eligible ? (
            <div className="col" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                Staking is the entry ticket: stake ICP on the Staking page to start
                collecting 5 / 10 / 20 free tickets a day (6-month / 1-year / 2-year terms).
              </span>
              <Chip tone="muted"><Icon name="zap" size={11} /> Not staked yet</Chip>
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
            </>
          )}
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
                  <Icon name="spark" size={13} stroke="var(--burn)" />
                  <b className="mono">{d.winner != null ? formatPrincipal(d.winner) : '—'}</b>
                  <span style={{ color: 'var(--fg-3)' }}>{drawDate(d.drawn_at)} · round {Number(d.round)}</span>
                </span>
                <Chip tone="ok">won {fmtICP(d.prize_e8s)} ICP</Chip>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Local-dev drawing controls ── */}
      {isLocal && signedIn && (
        <div className="col" style={{
          gap: 10, border: '1px dashed var(--border-hi)', borderRadius: 10,
          background: 'var(--surface)', padding: 14,
        }}>
          <Eyebrow>Local dev · hold a drawing now</Eyebrow>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="secondary" sm onClick={() => handleDevDraw(false)} disabled={busy !== null}>
              {busy === 'devdraw' ? <LiveDot size={7} /> : <Icon name="refresh" size={13} />} Draw (real odds)
            </Btn>
            <Btn variant="secondary" sm onClick={() => handleDevDraw(true)} disabled={busy !== null}>
              {busy === 'devwin' ? <LiveDot size={7} /> : <Icon name="target" size={13} />} Draw (force win)
            </Btn>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', alignSelf: 'center' }}>
              Force-win rigs ticket #0 — exercises the full 80/20 payout path.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
