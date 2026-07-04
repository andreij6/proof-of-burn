import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon, LiveDot } from '../ui';

// ==========================================
// Luck-Proof — arcade game 3: the EV-decision trainer.
// "Your results are luck. Your decisions are skill."
//
// The server issues a run of 10 gambles (start_luckproof_run); the player
// TAKES or PASSES each under an 8-second shot clock. Decision feedback is
// instant (the client can compute the edge), but the OUTCOMES stay hidden
// until complete_luckproof_run reveals the luck track — so the contrast
// between decision quality and results lands at the end, which is the whole
// lesson. The ranked score is EV leaked vs perfect play (lower = better),
// recomputed server-side so it can't be forged.
// ==========================================

export interface LPGamble {
  p_bp: number;
  cost: number;
  payout: number;
  framing: number;
  outs: number;
  cards: number;
}

export const LP_ROUNDS = 10;
export const SHOT_CLOCK_MS = 8_000;

/** Signed EV edge in chip-basis-points (mirrors the backend exactly). */
export function edgeBp(g: LPGamble): number {
  return g.p_bp * g.payout - 10_000 * g.cost;
}

/** EV leaked by a set of decisions (bp, ≥0; 0 = perfect play). */
export function evLeakedBp(gambles: LPGamble[], decisions: boolean[]): number {
  let leaked = 0;
  gambles.forEach((g, i) => {
    const e = edgeBp(g);
    if (decisions[i] && e < 0) leaked += -e;
    if (!decisions[i] && e > 0) leaked += e;
  });
  return leaked;
}

/** Chip-basis-points → chips, one decimal ("12.4"). */
export function fmtChipsBp(bp: number | bigint): string {
  return (Number(bp) / 10_000).toFixed(1);
}

/** Scenario prose per framing — the numbers ARE the puzzle, so each framing
 *  forces a different mental conversion (percent / odds-against / outs). */
export function gambleText(g: LPGamble): string {
  switch (g.framing) {
    case 1: // odds — outs:cards reused as a:b against
      return `The odds are ${g.outs} : ${g.cards} AGAINST you. Risk ${g.cost} chips — a win pays ${g.payout} chips.`;
    case 2: // outs
      return `${g.outs} of the ${g.cards} unseen cards win it for you. Risk ${g.cost} chips — a win pays ${g.payout} chips.`;
    default: // percent
      return `You win ${(g.p_bp / 100).toFixed(g.p_bp % 100 === 0 ? 0 : 1)}% of the time. Risk ${g.cost} chips — a win pays ${g.payout} chips.`;
  }
}

/** Post-decision coaching line (client-side; the edge is computable). */
export function decisionFeedback(g: LPGamble, took: boolean): { good: boolean; text: string } {
  const e = edgeBp(g);
  const chips = fmtChipsBp(Math.abs(e));
  const good = (took && e >= 0) || (!took && e <= 0);
  if (Math.abs(e) < 5_000) {
    return { good: true, text: `Coin flip — that one was worth ±${chips} chips either way.` };
  }
  if (took) {
    return good
      ? { good, text: `Good take: +EV by ${chips} chips.` }
      : { good, text: `That leaked ${chips} chips of EV — the price was too high.` };
  }
  return good
    ? { good, text: `Good pass: taking it would have leaked ${chips} chips.` }
    : { good, text: `You passed on +${chips} chips of EV.` };
}

interface LuckProofProps {
  actor: any;
  onExit: () => void;
}

type Phase = 'intro' | 'play' | 'done';

export default function LuckProof({ actor, onExit }: LuckProofProps) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [runId, setRunId] = useState<bigint | null>(null);
  const [gambles, setGambles] = useState<LPGamble[]>([]);
  const [idx, setIdx] = useState(0);
  const [decisions, setDecisions] = useState<boolean[]>([]);
  const [feedback, setFeedback] = useState<{ good: boolean; text: string } | null>(null);
  const [clockPct, setClockPct] = useState(100);

  const [result, setResult] = useState<{
    ev_leaked_bp: bigint; optimal_ev_bp: bigint; outcomes: boolean[]; bankroll_delta: bigint; rank: number;
  } | null>(null);

  const startedAtRef = useRef(0);
  const roundStartRef = useRef(0);
  const decidedRef = useRef(false);
  const rafRef = useRef(0);

  const start = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await actor.start_luckproof_run();
      if (res.__kind__ === 'Err') throw new Error(res.Err);
      setRunId(res.Ok.run_id);
      setGambles(res.Ok.gambles);
      setIdx(0); setDecisions([]); setFeedback(null); setResult(null);
      startedAtRef.current = performance.now();
      beginRound();
      setPhase('play');
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const beginRound = () => {
    decidedRef.current = false;
    roundStartRef.current = performance.now();
    setFeedback(null);
    setClockPct(100);
  };

  // Shot clock — timeout auto-passes (which itself can leak EV: hesitation
  // has a price, just like at the table).
  useEffect(() => {
    if (phase !== 'play') return;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (decidedRef.current) return;
      const left = SHOT_CLOCK_MS - (performance.now() - roundStartRef.current);
      setClockPct(Math.max(0, (left / SHOT_CLOCK_MS) * 100));
      if (left <= 0) decide(false, true);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, idx]);

  const decide = (take: boolean, timedOut = false) => {
    if (decidedRef.current || phase !== 'play') return;
    decidedRef.current = true;
    const g = gambles[idx];
    const fb = decisionFeedback(g, take);
    setFeedback(timedOut ? { good: fb.good, text: `Clock! Auto-pass. ${fb.text}` } : fb);
    setDecisions((d) => [...d, take]);
  };

  const next = async () => {
    if (idx + 1 < gambles.length) {
      setIdx(idx + 1);
      beginRound();
      return;
    }
    // Run complete — server scores the decisions and reveals the luck track.
    if (busy || runId === null) return;
    setBusy(true); setErr(null);
    try {
      const millis = BigInt(Math.max(3_001, Math.round(performance.now() - startedAtRef.current)));
      const res = await actor.complete_luckproof_run(runId, decisions, millis);
      if (res.__kind__ === 'Err') throw new Error(res.Err);
      setResult(res.Ok);
      setPhase('done');
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const g = gambles[idx];
  const leakedSoFar = evLeakedBp(gambles.slice(0, decisions.length), decisions);

  return (
    <div className="col" style={{ gap: 12, maxWidth: 620, margin: '0 auto', width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 15 }}>Luck-Proof</b>
          {phase === 'play' && (
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
              decision {Math.min(idx + 1, LP_ROUNDS)}/{LP_ROUNDS}
            </span>
          )}
        </span>
        <span className="row" style={{ gap: 8 }}>
          {phase === 'play' && (
            <Chip tone={leakedSoFar === 0 ? 'ok' : 'pending'}>
              <span className="mono">EV leaked: {fmtChipsBp(leakedSoFar)}</span>
            </Chip>
          )}
          <Btn variant="ghost" sm onClick={onExit}><Icon name="x" size={12} /> Quit</Btn>
        </span>
      </div>

      {phase === 'intro' && (
        <div className="card col" style={{ gap: 12 }}>
          <h3 style={{ margin: 0 }}>Your results are luck. Your decisions are skill.</h3>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>
            Ten quick wagers — percentages, bookmaker odds, outs — each with a price
            and a payout. <b>Take</b> the good ones, <b>pass</b> the bad ones, in 8
            seconds each. You're scored ONLY on decision quality (<b>EV leaked</b> vs
            perfect play — 0 is perfect, lower ranks higher). Your chip results are
            shown at the end as the <i>luck track</i>… and they don't count. That's
            the poker lesson: a good decision that loses is still a good decision.
          </p>
          {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
          <Btn variant="primary" disabled={busy} onClick={start} style={{ alignSelf: 'flex-start' }}>
            {busy ? <LiveDot size={8} /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Deal me in
          </Btn>
        </div>
      )}

      {phase === 'play' && g && (
        <div className="card col" style={{ gap: 14 }}>
          {/* Shot clock */}
          <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-alt)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${clockPct}%`, borderRadius: 3,
              background: clockPct > 35 ? 'var(--burn)' : 'var(--ember)',
              transition: 'width 80ms linear',
            }} />
          </div>

          <p style={{ fontSize: 17, lineHeight: 1.6, margin: '6px 0', minHeight: 54 }}>
            {gambleText(g)}
          </p>

          {!feedback ? (
            <div className="row" style={{ gap: 10 }}>
              <Btn variant="primary" onClick={() => decide(true)} style={{ flex: 1 }}>
                <Icon name="check" size={14} stroke="var(--char-950)" /> Take it — {g.cost} chips
              </Btn>
              <Btn variant="secondary" onClick={() => decide(false)} style={{ flex: 1 }}>
                Pass
              </Btn>
            </div>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <span className="row" style={{ gap: 8, fontSize: 13.5, color: feedback.good ? 'var(--sprout-ink)' : 'var(--ember)' }}>
                <Icon name={feedback.good ? 'checkCircle' : 'x'} size={15} stroke={feedback.good ? 'var(--sprout-ink)' : 'var(--ember)'} />
                {feedback.text}
              </span>
              <Btn variant="primary" sm onClick={next} disabled={busy} style={{ alignSelf: 'flex-start' }}>
                {busy ? <LiveDot size={7} /> : null}
                {idx + 1 < gambles.length ? 'Next decision' : 'Reveal the luck track'}
              </Btn>
              {err && <span style={{ fontSize: 12, color: 'var(--ember)' }}>{err}</span>}
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result && (
        <div className="card col" style={{ gap: 14 }}>
          <h3 style={{ margin: 0 }}>
            {Number(result.ev_leaked_bp) === 0 ? 'Perfect. Zero EV leaked.' : `You leaked ${fmtChipsBp(result.ev_leaked_bp)} chips of EV.`}
          </h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Chip tone={Number(result.ev_leaked_bp) === 0 ? 'ok' : 'pending'}>
              <span className="mono">Decision score · rank #{result.rank}</span>
            </Chip>
            <Chip tone="muted">
              <span className="mono">
                captured {Number(result.optimal_ev_bp) > 0
                  ? Math.round(100 - (Number(result.ev_leaked_bp) / Number(result.optimal_ev_bp)) * 100)
                  : 100}% of available EV
              </span>
            </Chip>
          </div>

          {/* The luck track — deliberately second, deliberately unranked. */}
          <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span style={{ fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>
              The luck track (not scored)
            </span>
            <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
              {result.outcomes.map((won, i) => (
                <span key={i} title={decisions[i] ? (won ? 'took it — won' : 'took it — lost') : 'passed'} style={{
                  width: 22, height: 22, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontFamily: 'var(--font-mono, monospace)',
                  background: decisions[i] ? (won ? 'color-mix(in srgb, var(--sprout) 25%, var(--surface))' : 'color-mix(in srgb, var(--ember) 22%, var(--surface))') : 'var(--bg-alt)',
                  color: decisions[i] ? (won ? 'var(--sprout-ink)' : 'var(--ember)') : 'var(--fg-3)',
                  border: '1px solid var(--border)',
                }}>
                  {decisions[i] ? (won ? 'W' : 'L') : '–'}
                </span>
              ))}
            </div>
            <span className="mono" style={{ fontSize: 13 }}>
              Chips: {Number(result.bankroll_delta) >= 0 ? '+' : ''}{Number(result.bankroll_delta)}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              {Number(result.bankroll_delta) >= 0 && Number(result.ev_leaked_bp) > 0
                ? 'You WON chips while leaking EV — that\'s luck bailing out bad decisions. It won\'t, forever.'
                : Number(result.bankroll_delta) < 0 && Number(result.ev_leaked_bp) === 0
                ? 'You LOST chips playing perfectly — that\'s variance, not error. Keep making these decisions and the chips follow.'
                : 'Decisions and results pointed the same way this run. They won\'t always.'}
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <Btn variant="primary" onClick={start} disabled={busy}>
              {busy ? <LiveDot size={8} /> : <Icon name="zap" size={13} stroke="var(--char-950)" />} Run it again
            </Btn>
            <Btn variant="secondary" onClick={onExit}>Back to Arcade</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
