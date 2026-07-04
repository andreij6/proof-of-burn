import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot, formatPrincipal } from '../ui';

// ==========================================
// Sklansky Trainer (Luck-Proof) — arcade game 3.
// "Your results are luck. Your decisions are skill."
//
// Gemini-reference mechanics: dual live tracks (SKILL = Sklansky dollars, EV
// credited the moment a decision is made; LUCK = actual cash), an Odds/Risk/
// Reward stats row (no prose headline), a hand log — plus:
//  · a 3-second burndown clock per hand; the clock expiring DECLINES for you
//    (hesitation is a decision too);
//  · a realtime two-line chart of both tracks, drawn per hand;
//  · verifiable replays: tap any daily-board row to see that player's exact
//    decisions against the day's shared deal (identical for everyone — the
//    deal derives from the day seed, which the replay endpoint recomputes).
//
// Competition: one attempt per UTC day, 250 decisions, no-loss-lottery
// stakers only; ranked EV → accuracy → time; the day's winner is paid
// lottery tickets equal to that day's PLAYER COUNT by the sweep.
// Keyboard: T / → take · D / ← decline. Mobile-first fluid layout.
// ==========================================

export interface LPGamble {
  odds_pct: number;
  risk: number;
  reward: number;
}

/** Sklansky EV of TAKING, bp ($1 = 10_000): P·reward − (1−P)·risk. Declining
 *  is always exactly 0. Mirrors the backend. */
export function edgeBp(g: LPGamble): number {
  const p = g.odds_pct * 100;
  return p * g.reward - (10_000 - p) * g.risk;
}

/** bp → signed dollars: "+$40.0" / "−$44.0" / "$0.0". */
export function fmtEvBp(bp: number | bigint): string {
  const v = Number(bp) / 10_000;
  const s = Math.abs(v).toFixed(1);
  return v > 0 ? `+$${s}` : v < 0 ? `−$${s}` : '$0.0';
}

/** Track display from the $1,000 base ("$1,040"). */
export function fmtTrack(startCents: number, deltaBp: number): string {
  const v = startCents / 100 + deltaBp / 10_000;
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

export const TRACK_START = 100_000; // $1,000.00 in cents
export const SHOT_CLOCK_MS = 3_000; // the burndown — expiry auto-declines
export const GET_READY_SECS = 5;   // countdown before the first hand

// Chart series colors — validated (dataviz six checks, dark surface):
// CVD ΔE 101.8 protan, contrast ≥3:1, in-band lightness.
export const SKILL_COLOR = '#E85A10';
export const LUCK_COLOR = '#2F86D9';

/** Odds readability tone: red < 40%, yellow 40–60%, green > 60%. */
export function oddsTone(odds_pct: number): string {
  return odds_pct < 40 ? 'var(--ember)' : odds_pct <= 60 ? 'var(--haze-ink)' : 'var(--sprout-ink)';
}

/** Cumulative per-hand chart series (dollars from the $1,000 base) out of a
 *  played prefix: decisions[i] with outcome[i] (undefined = pending/decline). */
export function buildSeries(
  gambles: LPGamble[],
  decisions: boolean[],
  outcomes: (boolean | undefined)[],
): { ev: number[]; cash: number[] } {
  const ev: number[] = [TRACK_START / 100];
  const cash: number[] = [TRACK_START / 100];
  for (let i = 0; i < decisions.length; i++) {
    const g = gambles[i];
    const take = decisions[i];
    ev.push(ev[i] + (take ? edgeBp(g) / 10_000 : 0));
    const won = outcomes[i];
    cash.push(cash[i] + (take && won !== undefined ? (won ? g.reward : -g.risk) : 0));
  }
  return { ev, cash };
}

/** Practice-mode generator — client mirror of the backend's balanced mix. */
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

// ── Realtime two-track line chart (SVG; hover crosshair + tooltip) ──
function TrackChart({ ev, cash, height = 150 }: { ev: number[]; cash: number[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, PAD = { l: 8, r: 52, t: 10, b: 8 };
  const n = Math.max(ev.length, 2);
  const all = [...ev, ...cash];
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(hi - lo, 10);
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
  const path = (s: number[]) => s.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const base = TRACK_START / 100;
  const hi_i = hover !== null ? Math.min(hover, ev.length - 1) : null;

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 14, fontSize: 11, color: 'var(--fg-2)' }}>
        <span className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 3, background: SKILL_COLOR, borderRadius: 2 }} /> Skill (EV)</span>
        <span className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 3, background: LUCK_COLOR, borderRadius: 2 }} /> Luck (cash)</span>
        {hi_i !== null && (
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-3)' }}>
            hand {hi_i} · EV ${Math.round(ev[hi_i])} · cash ${Math.round(cash[hi_i])}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', background: 'var(--bg-alt)', borderRadius: 8, touchAction: 'none' }}
        onMouseMove={(e) => {
          const r = (e.target as SVGElement).closest('svg')!.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* $1,000 baseline (recessive) */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(base)} y2={y(base)} stroke="var(--border)" strokeDasharray="3 4" strokeWidth={1} />
        <path d={path(cash)} fill="none" stroke={LUCK_COLOR} strokeWidth={2} strokeLinejoin="round" />
        <path d={path(ev)} fill="none" stroke={SKILL_COLOR} strokeWidth={2} strokeLinejoin="round" />
        {/* direct end labels (text tokens, colored dot carries identity) */}
        {ev.length > 1 && (
          <>
            <circle cx={x(ev.length - 1)} cy={y(ev[ev.length - 1])} r={3.5} fill={SKILL_COLOR} />
            <circle cx={x(cash.length - 1)} cy={y(cash[cash.length - 1])} r={3.5} fill={LUCK_COLOR} />
            <text x={x(ev.length - 1) + 6} y={y(ev[ev.length - 1]) + 4} fontSize={11} fill="var(--fg-2)" fontFamily="monospace">${Math.round(ev[ev.length - 1])}</text>
            <text x={x(cash.length - 1) + 6} y={y(cash[cash.length - 1]) + 4} fontSize={11} fill="var(--fg-2)" fontFamily="monospace">${Math.round(cash[cash.length - 1])}</text>
          </>
        )}
        {hi_i !== null && (
          <line x1={x(hi_i)} x2={x(hi_i)} y1={PAD.t} y2={H - PAD.b} stroke="var(--fg-3)" strokeWidth={1} opacity={0.5} />
        )}
      </svg>
    </div>
  );
}

interface LogEntry { n: number; text: string; evBp: number; outcome?: 'won' | 'lost' }

interface LuckProofProps {
  actor: any;
  onGoParticipate: () => void;
  /** Back-out target for the menu screen; omit on a dedicated page (the
   *  in-game Quit button always returns to the menu regardless). */
  onExit?: () => void;
}

type Mode = 'menu' | 'practice' | 'daily' | 'dailyDone' | 'replay';

interface DailyStatus {
  day: number;
  eligible: boolean;
  played: boolean;
  my_entry?: { ev_bp: bigint; correct: number; millis: bigint } | null;
  decisions: number;
  players_today: number;
}

interface DailyRow { rank: number; player: any; ev_bp: bigint; correct: number; millis: bigint; cash: bigint }

export default function LuckProof({ actor, onGoParticipate, onExit }: LuckProofProps) {
  const showMenuExit = !!onExit;
  const [mode, setMode] = useState<Mode>('menu');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<DailyStatus | null>(null);
  const [board, setBoard] = useState<DailyRow[]>([]);

  // Live game state.
  const [gamble, setGamble] = useState<LPGamble | null>(null);
  const [hand, setHand] = useState(0);
  const [evBp, setEvBp] = useState(0);
  const [cashBp, setCashBp] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [series, setSeries] = useState<{ ev: number[]; cash: number[] }>({ ev: [TRACK_START / 100], cash: [TRACK_START / 100] });
  const [clockPct, setClockPct] = useState(100);

  const runRef = useRef<{ id: bigint; gambles: LPGamble[]; rolls: number[]; decisions: boolean[]; startedAt: number } | null>(null);
  const roundStartRef = useRef(0);
  const decidedRef = useRef(false);
  const [result, setResult] = useState<{ ev_bp: bigint; correct: number; bankroll_delta: bigint; rank: number; outcomes: boolean[] } | null>(null);
  const [replay, setReplay] = useState<{ player: any; day: number; gambles: LPGamble[]; decisions: boolean[]; outcomes: boolean[]; ev_bp: bigint; correct: number; millis: bigint } | null>(null);

  const refreshMenu = async () => {
    try {
      const [st, rows] = await Promise.all([
        actor.get_luckproof_daily_status(),
        actor.get_luckproof_daily_board(null),
      ]);
      setStatus(st); setBoard(rows);
    } catch { /* best-effort */ }
  };
  useEffect(() => { refreshMenu(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [actor]);

  const resetTracks = () => {
    setHand(0); setEvBp(0); setCashBp(0); setLog([]);
    setSeries({ ev: [TRACK_START / 100], cash: [TRACK_START / 100] });
  };
  const armClock = () => { decidedRef.current = false; roundStartRef.current = performance.now(); setClockPct(100); };

  // How-to-play modal (practice entry) + get-ready countdown before hand 1.
  const [showHowTo, setShowHowTo] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const inCountdown = countdown !== null;

  /** 5…1, then arm the clock — and, for the daily run, start the timer only
   *  now so the countdown never eats into the ranked completion time. */
  const beginCountdown = () => {
    decidedRef.current = true; // hold the shot clock until GO
    setCountdown(GET_READY_SECS);
    let left = GET_READY_SECS;
    const iv = setInterval(() => {
      left -= 1;
      if (left > 0) { setCountdown(left); return; }
      clearInterval(iv);
      setCountdown(null);
      if (runRef.current) runRef.current.startedAt = performance.now();
      armClock();
    }, 1000);
  };

  /** Practice click → the how-to modal; the game starts from its Ready button. */
  const startPractice = () => {
    setErr(null);
    setShowHowTo(true);
  };

  const launchPractice = () => {
    setShowHowTo(false);
    resetTracks();
    runRef.current = null;
    setGamble(practiceGamble());
    setMode('practice');
    beginCountdown();
  };

  const startDaily = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await actor.start_luckproof_daily();
      if (res.__kind__ === 'Err') throw new Error(friendlyDailyErr(res.Err));
      resetTracks();
      runRef.current = {
        id: res.Ok.run_id, gambles: res.Ok.gambles, rolls: Array.from(res.Ok.rolls),
        decisions: [], startedAt: performance.now(),
      };
      setGamble(res.Ok.gambles[0]);
      setMode('daily');
      beginCountdown();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  // ── The burndown clock: 3 seconds, expiry declines for you. ──
  useEffect(() => {
    if (mode !== 'practice' && mode !== 'daily') return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (decidedRef.current || !gamble) return;
      const left = SHOT_CLOCK_MS - (performance.now() - roundStartRef.current);
      setClockPct(Math.max(0, (left / SHOT_CLOCK_MS) * 100));
      if (left <= 0) decide(false, true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, gamble]);

  const decide = (take: boolean, timedOut = false) => {
    if (!gamble || decidedRef.current || inCountdown || (mode !== 'practice' && mode !== 'daily')) return;
    decidedRef.current = true;
    const n = hand + 1;
    const e = edgeBp(gamble);
    const decisionEv = take ? e : 0;
    setEvBp((v) => v + decisionEv);
    setHand(n);

    let won: boolean | undefined;
    if (take) {
      if (mode === 'practice') {
        won = Math.random() * 100 <= gamble.odds_pct;
      } else {
        const run = runRef.current!;
        won = run.rolls[run.decisions.length] < gamble.odds_pct * 100;
      }
      setCashBp((v) => v + (won ? gamble.reward : -gamble.risk) * 10_000);
    }
    setSeries((s) => ({
      ev: [...s.ev, s.ev[s.ev.length - 1] + decisionEv / 10_000],
      cash: [...s.cash, s.cash[s.cash.length - 1] + (take ? (won ? gamble.reward : -gamble.risk) : 0)],
    }));
    setLog((l) => [{
      n,
      evBp: decisionEv,
      text: take
        ? `GAMBLE: EV ${fmtEvBp(e)}`
        : `${timedOut ? 'CLOCK — auto-' : ''}DECLINED: EV +$0.0 (${e > 0 ? 'missed ' + fmtEvBp(e) : 'correct fold'})`,
      outcome: take ? ((won ? 'won' : 'lost') as LogEntry['outcome']) : undefined,
    }, ...l].slice(0, 60));

    if (mode === 'practice') {
      setGamble(practiceGamble());
      armClock();
      return;
    }
    const run = runRef.current!;
    run.decisions.push(take);
    if (run.decisions.length < run.gambles.length) {
      setGamble(run.gambles[run.decisions.length]);
      armClock();
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
      setMode('dailyDone');
      refreshMenu();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const openReplay = async (row: DailyRow) => {
    if (!status) return;
    if (!status.played) {
      setErr('Replays unlock after you compete: play today\'s challenge to study other players\' decisions.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await actor.get_luckproof_daily_replay(status.day, row.player);
      if (!r) throw new Error('No run recorded for that player today.');
      setReplay(r);
      setMode('replay');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
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
  }, [mode, gamble, hand]);

  const inDaily = mode === 'daily';
  const total = inDaily ? (runRef.current?.gambles.length ?? 0) : null;

  return (
    <div className="col" style={{ gap: 12, maxWidth: 680, margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', borderBottom: '2px solid var(--border)', paddingBottom: 10 }}>
        <b style={{ fontSize: 14, letterSpacing: '0.04em' }}>
          SKLANSKY TRAINER <span style={{ color: 'var(--fg-3)' }}>// {mode === 'practice' ? 'PRACTICE' : mode === 'replay' ? 'REPLAY' : inDaily || mode === 'dailyDone' ? 'DAILY COMPETITION' : 'ARCADE'}</span>
        </b>
        <span className="row" style={{ gap: 10 }}>
          {(mode === 'practice' || inDaily) && (
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>Hand: {hand}{total !== null ? `/${total}` : ''}</span>
          )}
          {(mode !== 'menu' || showMenuExit) && (
            <Btn variant="ghost" sm onClick={() => (mode === 'menu' ? onExit?.() : (setMode('menu'), setGamble(null), setReplay(null), refreshMenu()))}>
              <Icon name="x" size={12} /> {mode === 'menu' ? 'Exit' : 'Quit'}
            </Btn>
          )}
        </span>
      </div>

      {/* Menu */}
      {mode === 'menu' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 10 }}>
              <Chip tone="muted" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>Practice</Chip>
              <b style={{ fontSize: 15 }}>Endless drills</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Unlimited hands, 3-second clock, instant outcomes, nothing
                recorded. The clock expiring folds for you — hesitation is a
                decision too.
              </p>
              <Btn variant="secondary" onClick={startPractice}><Icon name="clover" size={13} /> Practice</Btn>
            </div>
            <div className="card col" style={{ gap: 10, borderColor: 'var(--burn)' }}>
              <Chip tone="burn" style={{ alignSelf: 'flex-start', height: 19, fontSize: 10 }}>
                <LiveDot color="var(--burn-ink)" size={5} /> Daily competition
              </Chip>
              <b style={{ fontSize: 15 }}>{status?.decisions ?? 250} decisions · one attempt</b>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                Everyone gets the SAME deal today. TWO winners each day —
                <b> highest EV</b> (skill) and <b>highest actual cash</b> (luck) — and
                each takes <b>lottery tickets equal to the player count</b>
                {status ? ` (${Math.max(status.players_today, 1)} so far)` : ''}. EV ties
                break on accuracy, then speed. Resets 00:00 UTC.
              </p>
              {status && !status.eligible ? (
                <div className="col" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--haze-ink)' }}>
                    <Icon name="lock" size={13} stroke="var(--haze-ink)" /> Competition is for no-loss-lottery stakers.
                  </span>
                  <Btn variant="primary" onClick={onGoParticipate}><Icon name="zap" size={13} stroke="var(--char-950)" /> Stake ICP to enter</Btn>
                </div>
              ) : status?.played ? (
                <div className="col" style={{ gap: 6 }}>
                  <Chip tone="ok" style={{ alignSelf: 'flex-start' }}>
                    <Icon name="checkCircle" size={11} /> Played today{status.my_entry ? ` — EV ${fmtEvBp(status.my_entry.ev_bp)} · ${status.my_entry.correct}/${status.decisions}` : ''}
                  </Chip>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Fresh deal at 00:00 UTC.</span>
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
              <span className="row mono" style={{ gap: 5, fontSize: 10.5, color: 'var(--fg-3)' }}>
                {status && !status.played && <Icon name="lock" size={11} stroke="var(--fg-3)" />}
                {status && !status.played ? 'compete to unlock replays' : 'tap a row to verify their run'}
              </span>
            </span>
            {board.length === 0 ? (
              <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>Nobody has played today's deal yet. First mover takes rank #1.</span>
            ) : (() => {
              // The second winner slot: highest cash (ties: EV, then speed).
              const cashChamp = board.reduce((a, b) =>
                b.cash > a.cash || (b.cash === a.cash && (b.ev_bp > a.ev_bp || (b.ev_bp === a.ev_bp && b.millis < a.millis))) ? b : a);
              return (
                <div className="col" style={{ gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                  {board.map((r) => (
                    <button key={r.rank} onClick={() => openReplay(r)}
                      title={status?.played ? "View this run's every decision against the shared daily deal" : "Play today's challenge to unlock replays"}
                      style={{
                      opacity: status?.played ? 1 : 0.65,
                      display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 8px', flexWrap: 'wrap',
                      background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                      color: 'var(--fg)', cursor: 'pointer', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, textAlign: 'left',
                    }}>
                      <span className="row" style={{ gap: 6 }}>
                        #{r.rank} {formatPrincipal(r.player)}
                        {r.rank === 1 && <span style={{ fontSize: 9.5, color: SKILL_COLOR, border: `1px solid ${SKILL_COLOR}`, borderRadius: 4, padding: '0 4px' }}>EV champ</span>}
                        {r.player.toString() === cashChamp.player.toString() && <span style={{ fontSize: 9.5, color: LUCK_COLOR, border: `1px solid ${LUCK_COLOR}`, borderRadius: 4, padding: '0 4px' }}>cash champ</span>}
                      </span>
                      <span>{fmtEvBp(r.ev_bp)} · cash {Number(r.cash) >= 0 ? '+' : '−'}${Math.abs(Number(r.cash))} · {(Number(r.millis) / 60000).toFixed(1)}m</span>
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        </>
      )}

      {/* Live game */}
      {(mode === 'practice' || inDaily) && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 4, borderLeft: `4px solid ${SKILL_COLOR}` }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>Skill track (EV earned)</span>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{fmtTrack(TRACK_START, evBp)}</span>
            </div>
            <div className="card col" style={{ gap: 4, borderLeft: `4px solid ${LUCK_COLOR}` }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-3)' }}>Luck track (actual cash)</span>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{fmtTrack(TRACK_START, cashBp)}</span>
            </div>
          </div>

          {/* Realtime two-track chart */}
          {series.ev.length > 1 && <TrackChart ev={series.ev} cash={series.cash} />}

          {/* Get ready: 5-second countdown before the first hand. */}
          {inCountdown && (
            <div className="card col" style={{ gap: 8, alignItems: 'center', padding: '32px 16px' }}>
              <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>
                Get ready — 3 seconds per hand once the clock starts
              </span>
              <span className="mono" style={{ fontSize: 56, fontWeight: 700, lineHeight: 1, color: 'var(--burn-ink)' }}>
                {countdown}
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                T / → take · D / ← decline
              </span>
            </div>
          )}

          {/* Arena */}
          {!inCountdown && gamble && (
            <div className="card col" style={{ gap: 14, textAlign: 'center' }}>
              {/* Burndown: 3 s, expiry declines. */}
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-alt)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${clockPct}%`, borderRadius: 3,
                  background: clockPct > 35 ? 'var(--burn)' : 'var(--ember)',
                }} />
              </div>
              <div className="row" style={{ justifyContent: 'space-around', background: 'var(--bg-alt)', borderRadius: 8, padding: '14px 6px', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 15 }}>Win odds: <b className="mono" style={{ color: oddsTone(gamble.odds_pct) }}>{gamble.odds_pct}%</b></span>
                <span style={{ fontSize: 15 }}>Risk: <b className="mono">${gamble.risk}</b></span>
                <span style={{ fontSize: 15 }}>Reward: <b className="mono" style={{ color: 'var(--sprout-ink)' }}>${gamble.reward}</b></span>
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
                keyboard: D / ← decline · T / → take · clock runs out = decline
              </span>
            </div>
          )}
          {!gamble && inDaily && (
            <div className="card row" style={{ gap: 10, justifyContent: 'center', padding: 24 }}>
              <LiveDot size={9} color="var(--burn-ink)" /> Scoring your 250 decisions on-chain…
              {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err} <Btn variant="ghost" sm onClick={submitDaily}>Retry</Btn></span>}
            </div>
          )}

          {log.length > 0 && (
            <div className="col mono" style={{ gap: 0, maxHeight: 130, overflowY: 'auto', fontSize: 11.5 }}>
              {log.map((e) => (
                <span key={e.n} className="row" style={{ gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span>#{e.n} <span style={{ color: e.evBp > 0 ? 'var(--sprout-ink)' : e.evBp < 0 ? 'var(--ember)' : 'var(--fg-3)' }}>{e.text}</span></span>
                  <span style={{ color: e.outcome === 'won' ? 'var(--sprout-ink)' : e.outcome === 'lost' ? 'var(--ember)' : 'var(--fg-3)' }}>
                    {e.outcome === 'won' ? 'WON' : e.outcome === 'lost' ? 'LOST' : ''}
                  </span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* Daily results */}
      {mode === 'dailyDone' && result && (
        <div className="card col" style={{ gap: 14 }}>
          <h3 style={{ margin: 0 }}>Rank #{result.rank} today</h3>
          <TrackChart ev={series.ev} cash={series.cash} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div className="card col" style={{ gap: 4, borderLeft: `4px solid ${SKILL_COLOR}` }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--fg-3)' }}>Skill track (ranked)</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{fmtEvBp(result.ev_bp)} EV</span>
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{result.correct}/{result.outcomes.length} decisions correct</span>
            </div>
            <div className="card col" style={{ gap: 4, borderLeft: `4px solid ${LUCK_COLOR}` }}>
              <span style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--fg-3)' }}>Luck track (not ranked)</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>
                {Number(result.bankroll_delta) >= 0 ? '+' : '−'}${Math.abs(Number(result.bankroll_delta)).toLocaleString()}
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
            <Btn variant="secondary" onClick={launchPractice}>Keep practicing</Btn>
          </div>
        </div>
      )}

      {/* Replay: verify any player's run against the shared deal */}
      {mode === 'replay' && replay && (() => {
        const rs = buildSeries(replay.gambles, replay.decisions, replay.outcomes);
        return (
          <div className="card col" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 14 }}>{formatPrincipal(replay.player)} — day {replay.day}</b>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                {fmtEvBp(replay.ev_bp)} EV · {replay.correct}/{replay.decisions.length} · {(Number(replay.millis) / 60000).toFixed(1)}m
              </span>
            </div>
            <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--sprout-ink)' }}>
              <Icon name="checkCircle" size={13} stroke="var(--sprout-ink)" />
              Same deal as everyone: these {replay.gambles.length} scenarios derive from the day seed —
              identical for every player, recomputed on-chain for this replay.
            </span>
            <TrackChart ev={rs.ev} cash={rs.cash} />
            <div className="col mono" style={{ gap: 0, maxHeight: 260, overflowY: 'auto', fontSize: 11.5 }}>
              {replay.gambles.map((g, i) => (
                <span key={i} className="row" style={{ gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span>
                    #{i + 1} <span style={{ color: oddsTone(g.odds_pct) }}>{g.odds_pct}%</span> · risk ${g.risk} · <span style={{ color: 'var(--sprout-ink)' }}>${g.reward}</span>
                  </span>
                  <span style={{ color: replay.decisions[i] ? (replay.outcomes[i] ? 'var(--sprout-ink)' : 'var(--ember)') : 'var(--fg-3)' }}>
                    {replay.decisions[i] ? `TAKE ${fmtEvBp(edgeBp(g))} → ${replay.outcomes[i] ? 'WON' : 'LOST'}` : 'DECLINE'}
                  </span>
                </span>
              ))}
            </div>
            <Btn variant="secondary" sm onClick={() => { setMode('menu'); setReplay(null); }} style={{ alignSelf: 'flex-start' }}>
              <Icon name="chevLeft" size={12} /> Back to board
            </Btn>
          </div>
        );
      })()}

      {/* ── How to play (shown on every Practice entry) ── */}
      {showHowTo && (
        <div onClick={() => setShowHowTo(false)} style={{
          position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: 16, background: 'color-mix(in srgb, var(--char-950) 62%, transparent)',
        }}>
          <div className="card col" onClick={(e) => e.stopPropagation()} style={{
            maxWidth: 440, width: '100%', gap: 12, background: 'var(--surface)',
            border: '1px solid var(--border-hi)', boxShadow: 'var(--elev-3)',
          }}>
            <span className="row" style={{ gap: 8 }}>
              <Icon name="clover" size={16} stroke="var(--burn-ink)" />
              <b>How to play</b>
            </span>
            <div className="col" style={{ gap: 8, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              <span>
                Each hand offers a wager: <b style={{ color: 'var(--fg)' }}>risk</b> some dollars for a chance
                at a <b style={{ color: 'var(--sprout-ink)' }}>reward</b> at the stated odds.
                Taking it is worth <span className="mono">P·reward − (1−P)·risk</span>; declining
                is always exactly $0.
              </span>
              <span>
                <b style={{ color: 'var(--fg)' }}>You have 3 seconds per hand.</b> If the clock runs out,
                you decline — hesitation is a decision too.
              </span>
              <span>
                Your <b style={{ color: SKILL_COLOR }}>skill track</b> earns each decision's EV the moment
                you choose; your <b style={{ color: LUCK_COLOR }}>luck track</b> is the actual cash. Only
                skill ranks — a good decision that loses is still a good decision.
              </span>
              <span className="mono" style={{ fontSize: 11.5 }}>
                keyboard: T / → take · D / ← decline
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="primary" onClick={launchPractice} style={{ flex: 1, minHeight: 44 }}>
                I'm ready
              </Btn>
              <Btn variant="ghost" onClick={() => setShowHowTo(false)}>Not now</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
