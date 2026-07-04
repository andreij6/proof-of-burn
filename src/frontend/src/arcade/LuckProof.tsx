import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot, formatPrincipal } from '../ui';

// ==========================================
// Sklansky Trainer (Luck-Proof) — arcade game 3.
// "Your results are luck. Your decisions are skill."
//
// Layout and mechanics follow the Gemini reference demo: a live dual-track
// scoreboard (SKILL = Sklansky dollars, EV earned the moment a decision is
// made; LUCK = actual cash), an arena showing Odds / Risk / Reward, and a
// running hand log. Declining is always exactly $0 EV.
//
// Two modes:
//  · PRACTICE — endless, client-side, outcomes resolve instantly (any
//    signed-in user).
//  · COMPETITION — one attempt per UTC day, 250 decisions, stakers-only.
//    Every player faces the SAME daily deal; the board ranks EV earned →
//    accuracy → time. Outcomes stay hidden until the end (the reveal is the
//    lesson); scoring is recomputed server-side, so results can't be forged.
//
// Keyboard: T / → = take · D / ← = decline. Mobile: fluid layout, big
// touch targets.
// ==========================================

export interface LPGamble {
  odds_pct: number;
  risk: number;
  reward: number;
}

/** Sklansky EV of TAKING, in basis points ($1 = 10_000): P·reward − (1−P)·risk.
 *  Mirrors the backend exactly. Declining is always 0. */
export function edgeBp(g: LPGamble): number {
  const p = g.odds_pct * 100;
  return p * g.reward - (10_000 - p) * g.risk;
}

/** bp → signed dollar string: "+$40.0" / "−$12.5" / "$0.0". */
export function fmtEvBp(bp: number | bigint): string {
  const v = Number(bp) / 10_000;
  const s = Math.abs(v).toFixed(1);
  return v > 0 ? `+$${s}` : v < 0 ? `−$${s}` : '$0.0';
}

/** Dollar display for the track cards ("$1,040"). */
export function fmtTrack(startCents: number, deltaBp: number): string {
  const v = startCents / 100 + deltaBp / 10_000;
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

export const TRACK_START = 100_000; // $1,000.00 in cents — the demo's stake

/** Practice-mode generator — client-side mirror of the backend's balanced
 *  mix (⅓ clear-take, ⅓ clear-fold, ⅓ close call). */
export function practiceGamble(rand: () => number = Math.random): LPGamble {
  const risk = 20 + Math.floor(rand() * 81);
  const odds_pct = 20 + Math.floor(rand() * 61);
  const p_bp = odds_pct * 100;
  const cls = Math.floor(rand() * 3);
  const fracBp = cls === 2 ? Math.floor(rand() * 501) : 1_500 + Math.floor(rand() * 4_501);
  const sign = cls === 0 ? 1 : cls === 1 ? -1 : rand() < 0.5 ? 1 : -1;
  const evBp = sign * fracBp * risk;
  const reward = Math.max(1, Math.floor((evBp + (10_000 - p_bp) * risk) / p_bp));
  return { odds_pct, risk, reward };
}

interface LogEntry {
  n: number;
  text: string;
  evBp: number;
  outcome?: 'won' | 'lost' | null; // undefined = decline; null = hidden (daily)
}

interface LuckProofProps {
  actor: any;
  /** Navigate to staking (the competition gate CTA). */
  onGoParticipate: () => void;
  onExit: () => void;
}

type Mode = 'menu' | 'practice' | 'daily' | 'dailyDone';

interface DailyStatus {
  day: number;
  eligible: boolean;
  played: boolean;
  my_entry?: { ev_bp: bigint; correct: number; millis: bigint } | null;
  decisions: number;
}

interface DailyRow { rank: number; player: any; ev_bp: bigint; correct: number; millis: bigint }

export default function LuckProof({ actor, onGoParticipate, onExit }: LuckProofProps) {
  const [mode, setMode] = useState<Mode>('menu');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Menu data.
  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [board, setBoard] = useState<DailyRow[]>([]);

  // Live game state (both modes).
  const [gamble, setGamble] = useState<LPGamble | null>(null);
  const [hand, setHand] = useState(0);
  const [evBp, setEvBp] = useState(0);       // skill track delta
  const [cashBp, setCashBp] = useState(0);   // luck track delta (practice live; daily at reveal)
  const [log, setLog] = useState<LogEntry[]>([]);

  // Daily run.
  const runRef = useRef<{ id: bigint; gambles: LPGamble[]; decisions: boolean[]; startedAt: number } | null>(null);
  const [result, setResult] = useState<{ ev_bp: bigint; correct: number; bankroll_delta: bigint; rank: number; outcomes: boolean[] } | null>(null);

  const refreshMenu = async () => {
    try {
      const [st, rows] = await Promise.all([
        actor.get_luckproof_daily_status(),
        actor.get_luckproof_daily_board(null),
      ]);
      setStatus(st);
      setBoard(rows);
    } catch { /* menu data is best-effort */ }
  };
  useEffect(() => { refreshMenu(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor]);

  const resetTracks = () => { setHand(0); setEvBp(0); setCashBp(0); setLog([]); };

  // ── Practice ──
  const startPractice = () => {
    resetTracks();
    setGamble(practiceGamble());
    setMode('practice');
  };

  // ── Daily competition ──
  const startDaily = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await actor.start_luckproof_daily();
      if (res.__kind__ === 'Err') throw new Error(friendlyDailyErr(res.Err));
      resetTracks();
      runRef.current = { id: res.Ok.run_id, gambles: res.Ok.gambles, decisions: [], startedAt: performance.now() };
      setGamble(res.Ok.gambles[0]);
      setMode('daily');
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = (take: boolean) => {
    if (!gamble || busy) return;
    const n = hand + 1;
    const e = edgeBp(gamble);
    const decisionEv = take ? e : 0;
    setEvBp((v) => v + decisionEv);
    setHand(n);

    if (mode === 'practice') {
      let outcome: LogEntry['outcome'];
      if (take) {
        const won = Math.random() * 100 <= gamble.odds_pct;
        outcome = won ? 'won' : 'lost';
        setCashBp((v) => v + (won ? gamble.reward : -gamble.risk) * 10_000);
      }
      setLog((l) => [{
        n,
        evBp: decisionEv,
        text: take ? `GAMBLE: EV ${fmtEvBp(e)}` : `DECLINED: EV +$0.0 (${e > 0 ? 'missed ' + fmtEvBp(e) : 'correct fold'})`,
        outcome,
      }, ...l].slice(0, 60));
      setGamble(practiceGamble());
      return;
    }

    // Daily: record the decision; outcomes stay hidden until the reveal.
    const run = runRef.current!;
    run.decisions.push(take);
    setLog((l) => [{
      n,
      evBp: decisionEv,
      text: take ? `GAMBLE: EV ${fmtEvBp(e)}` : `DECLINED: EV +$0.0 (${e > 0 ? 'missed ' + fmtEvBp(e) : 'correct fold'})`,
      outcome: take ? null : undefined,
    }, ...l].slice(0, 60));
    if (run.decisions.length < run.gambles.length) {
      setGamble(run.gambles[run.decisions.length]);
    } else {
      setGamble(null);
      void submitDaily();
    }
  };

  const submitDaily = async () => {
    const run = runRef.current;
    if (!run || busy) return;
    setBusy(true); setErr(null);
    try {
      const millis = BigInt(Math.round(performance.now() - run.startedAt));
      const res = await actor.complete_luckproof_daily(run.id, run.decisions, millis);
      if (res.__kind__ === 'Err') throw new Error(friendlyDailyErr(res.Err));
      setResult(res.Ok);
      setCashBp(Number(res.Ok.bankroll_delta) * 10_000);
      setMode('dailyDone');
      refreshMenu();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Keyboard: T/→ take · D/← decline ──
  useEffect(() => {
    if (mode !== 'practice' && mode !== 'daily') return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      const k = ev.key.toLowerCase();
      if (k === 't' || ev.key === 'ArrowRight') { ev.preventDefault(); decide(true); }
      else if (k === 'd' || ev.key === 'ArrowLeft') { ev.preventDefault(); decide(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, gamble, hand, busy]);

  const inDaily = mode === 'daily';
  const total = inDaily ? (runRef.current?.gambles.length ?? 0) : null;

  return (
    <div className="col" style={{ gap: 12, maxWidth: 680, margin: '0 auto', width: '100%' }}>
      {/* ── Header ── */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', borderBottom: '2px solid var(--border)', paddingBottom: 10 }}>
        <b style={{ fontSize: 14, letterSpacing: '0.04em' }}>
          SKLANSKY TRAINER <span style={{ color: 'var(--fg-3)' }}>// {mode === 'practice' ? 'PRACTICE' : inDaily || mode === 'dailyDone' ? 'DAILY COMPETITION' : 'ARCADE'}</span>
        </b>
        <span className="row" style={{ gap: 10 }}>
          {(mode === 'practice' || inDaily) && (
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
              Hand: {hand}{total !== null ? `/${total}` : ''}
            </span>
          )}
          <Btn variant="ghost" sm onClick={() => (mode === 'menu' ? onExit() : (setMode('menu'), setGamble(null), refreshMenu()))}>
            <Icon name="x" size={12} /> {mode === 'menu' ? 'Exit' : 'Quit'}
          </Btn>
        </span>
      </div>

      {/* ── Menu: mode select + today's board ── */}
      {mode === 'menu' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 10 }}>
              <Chip tone="muted" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>Practice</Chip>
              <b style={{ fontSize: 15 }}>Endless drills</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Unlimited hands, instant outcomes, nothing recorded. Build the
                EV reflex: <span className="mono">P·reward − (1−P)·risk</span>, take it or fold it.
              </p>
              <Btn variant="secondary" onClick={startPractice}><Icon name="target" size={13} /> Practice</Btn>
            </div>
            <div className="card col" style={{ gap: 10, borderColor: 'var(--burn)' }}>
              <Chip tone="burn" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>
                <LiveDot color="var(--burn-ink)" size={5} /> Daily competition
              </Chip>
              <b style={{ fontSize: 15 }}>{status ? `${status.decisions} decisions · one attempt` : '250 decisions · one attempt'}</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Every player gets the SAME deal today. Highest EV earned wins the
                day (ties: accuracy, then speed). Outcomes hide until the end —
                results are luck, decisions are skill. Resets 00:00 UTC.
              </p>
              {status && !status.eligible ? (
                <div className="col" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)' }}>
                    <Icon name="lock" size={13} stroke="var(--haze-ink)" />
                    Competition is for no-loss-lottery stakers.
                  </span>
                  <Btn variant="primary" onClick={onGoParticipate}><Icon name="zap" size={13} stroke="var(--char-950)" /> Stake ICP to enter</Btn>
                </div>
              ) : status?.played ? (
                <div className="col" style={{ gap: 6 }}>
                  <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                    <Icon name="checkCircle" size={11} /> Played today{status.my_entry ? ` — EV ${fmtEvBp(status.my_entry.ev_bp)} · ${status.my_entry.correct}/${status.decisions}` : ''}
                  </Chip>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Come back after 00:00 UTC for tomorrow's deal.</span>
                </div>
              ) : (
                <Btn variant="primary" disabled={busy || !status} onClick={startDaily}>
                  {busy ? <LiveDot size={8} /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Enter today's challenge
                </Btn>
              )}
            </div>
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}

          <div className="card col" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <b style={{ fontSize: 13.5 }}>Today's board</b>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>EV earned · accuracy · time</span>
            </span>
            {board.length === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Nobody has played today's deal yet. First mover takes rank #1.</span>
            ) : (
              <div className="col" style={{ gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                {board.map((r) => (
                  <span key={r.rank} className="row mono" style={{ gap: 8, fontSize: 12, justifyContent: 'space-between' }}>
                    <span>#{r.rank} {formatPrincipal(r.player)}</span>
                    <span>{fmtEvBp(r.ev_bp)} · {r.correct}/{status?.decisions ?? 250} · {(Number(r.millis) / 60000).toFixed(1)}m</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Live game (both modes) ── */}
      {(mode === 'practice' || inDaily) && (
        <>
          {/* Scoreboard — the two tracks, live. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 4, borderLeft: '4px solid var(--burn)' }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>Skill track (EV earned)</span>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{fmtTrack(TRACK_START, evBp)}</span>
            </div>
            <div className="card col" style={{ gap: 4, borderLeft: '4px solid var(--ember)' }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>Luck track (actual cash)</span>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
                {inDaily ? '· · ·' : fmtTrack(TRACK_START, cashBp)}
              </span>
              {inDaily && <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>revealed at the end</span>}
            </div>
          </div>

          {/* Arena */}
          {gamble && (
            <div className="card col" style={{ gap: 14, textAlign: 'center' }}>
              <p style={{ fontSize: 18, margin: '4px 0', lineHeight: 1.5 }}>
                Pot offers <b>${gamble.reward}</b> profit on a <b>${gamble.risk}</b> call.
              </p>
              <div className="row" style={{ justifyContent: 'space-around', background: 'var(--bg-alt)', borderRadius: 8, padding: '10px 6px', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 13 }}>Win odds: <b className="mono">{gamble.odds_pct}%</b></span>
                <span style={{ fontSize: 13 }}>Risk: <b className="mono">${gamble.risk}</b></span>
                <span style={{ fontSize: 13 }}>Reward: <b className="mono">${gamble.reward}</b></span>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <Btn variant="secondary" onClick={() => decide(false)} style={{ flex: 1, minHeight: 56, fontSize: 15 }}>
                  DECLINE <span className="mono" style={{ fontSize: 11, opacity: 0.8 }}>(EV $0)</span>
                </Btn>
                <Btn variant="primary" onClick={() => decide(true)} style={{ flex: 1, minHeight: 56, fontSize: 15 }}>
                  TAKE GAMBLE
                </Btn>
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                keyboard: D / ← decline · T / → take
              </span>
            </div>
          )}
          {!gamble && inDaily && (
            <div className="card row" style={{ gap: 10, justifyContent: 'center', padding: 24 }}>
              <LiveDot size={9} color="var(--burn-ink)" /> Scoring your 250 decisions on-chain…
              {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err} <Btn variant="ghost" sm onClick={submitDaily}>Retry</Btn></span>}
            </div>
          )}

          {/* Hand log */}
          {log.length > 0 && (
            <div className="col mono" style={{ gap: 0, maxHeight: 150, overflowY: 'auto', fontSize: 11.5 }}>
              {log.map((e) => (
                <span key={e.n} className="row" style={{ gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span>
                    #{e.n} <span style={{ color: e.evBp > 0 ? 'var(--sprout-ink)' : e.evBp < 0 ? 'var(--ember)' : 'var(--fg-3)' }}>{e.text}</span>
                  </span>
                  <span style={{ color: e.outcome === 'won' ? 'var(--sprout-ink)' : e.outcome === 'lost' ? 'var(--ember)' : 'var(--fg-3)' }}>
                    {e.outcome === 'won' ? 'WON' : e.outcome === 'lost' ? 'LOST' : e.outcome === null ? '?' : ''}
                  </span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Daily results: the reveal ── */}
      {mode === 'dailyDone' && result && (
        <div className="card col" style={{ gap: 14 }}>
          <h3 style={{ margin: 0 }}>Rank #{result.rank} today</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 4, borderLeft: '4px solid var(--burn)' }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--fg-3)' }}>Skill track (ranked)</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{fmtEvBp(result.ev_bp)} EV</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{result.correct}/{result.outcomes.length} decisions correct</span>
            </div>
            <div className="card col" style={{ gap: 4, borderLeft: '4px solid var(--ember)' }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--fg-3)' }}>Luck track (not ranked)</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>
                {Number(result.bankroll_delta) >= 0 ? '+' : '−'}${Math.abs(Number(result.bankroll_delta)).toLocaleString()}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                {result.outcomes.filter(Boolean).length} won · {result.outcomes.filter((o, i) => !o && runRef.current?.decisions[i]).length} lost
              </span>
            </div>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            {Number(result.bankroll_delta) < 0 && Number(result.ev_bp) > 0
              ? 'Positive EV, negative cash — that\'s variance doing its thing. Decisions like these print money over a lifetime of hands.'
              : Number(result.bankroll_delta) >= 0 && Number(result.ev_bp) < 0
              ? 'You made money on bad decisions. The cards bailed you out today — they won\'t keep doing that.'
              : 'Skill and luck agreed today. Enjoy it; it\'s rarer than it feels.'}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <Btn variant="primary" onClick={() => { setMode('menu'); refreshMenu(); }}>See today's board</Btn>
            <Btn variant="secondary" onClick={startPractice}>Keep practicing</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/** Friendly copy for daily-challenge error codes. */
export function friendlyDailyErr(code: string): string {
  switch (code) {
    case 'NOT_STAKED': return 'The daily competition is for no-loss-lottery stakers — stake any amount of ICP to enter.';
    case 'ALREADY_PLAYED_TODAY': return 'You\'ve used today\'s attempt — a fresh deal drops at 00:00 UTC.';
    case 'RUN_EXPIRED': return 'This run timed out (1-hour limit). Today\'s attempt was consumed.';
    case 'INVALID_TIME': return 'That run finished implausibly fast — it wasn\'t scored.';
    default: return code;
  }
}
