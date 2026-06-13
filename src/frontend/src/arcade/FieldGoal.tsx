import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import { SKIN_COLORS, fmtMillis } from './engine';
import {
  AIM_WINDOW_MS, NEXT_KICK_COUNTDOWN_MS, CROSSBAR_FT, POST_HALF_GAP_FT, UPRIGHT_TOP_FT, ROUNDS_PER_GAME,
  DEFAULT_KICKER, HELMET_COLORS, JERSEY_COLORS,
  ballAt, botchedKick, dragToKick, flightTime, hashLabel, outcomeLabel,
  randomKickSpec, simulateKick, timeToPlane,
  type Kick, type KickerLook, type KickResult, type KickSpec, type Vec2,
} from './fieldgoalEngine';
import { pressureMusic } from './music';

// ==========================================
// Field Goal — behind-the-kicker stadium view, drawn with the same
// flat-shaded vector look as Mini Golf. Drag back from the ball and
// release to kick (drag length = power, drag direction = aim) — but a
// 3-second pressure clock runs from the snap: let it expire and the rushed
// kick shanks wide or comes up short. 5 kicks per game (each result counts
// down into the next snap automatically); a make scores its distance in
// yards.
// ==========================================

const CANVAS_W = 860, CANVAS_H = 510;
const CX = CANVAS_W / 2;
const HORIZON_Y = 148;
const BASE_Y = 442;          // screen y of the ball spot (z = 0)
const CAM_D = 28;            // perspective strength, ft
const PXF = 10;              // px per ft at z = 0

const persp = (z: number) => CAM_D / (CAM_D + Math.max(0, z));
const sx = (x: number, z: number) => CX + x * PXF * persp(z);
const syGround = (z: number) => HORIZON_Y + (BASE_Y - HORIZON_Y) * persp(z);
const sy = (y: number, z: number) => syGround(z) - y * PXF * persp(z);

const PAL = {
  skyTop: '#0b1020', skyBot: '#23304f',
  crowdA: '#3a4566', crowdB: '#2c3550',
  grassA: '#2f9e57', grassB: '#2a9050',
  line: 'rgba(255,255,255,0.75)', hashLine: 'rgba(255,255,255,0.45)',
  endzone: '#23484f',
  post: '#f2c038', postDark: '#c2952a',
  ball: '#8a4a22', ballDark: '#5e2f12', lace: '#f5efe0',
  shadow: 'rgba(8, 20, 12, 0.35)',
};

type Phase = 'intro' | 'live' | 'flight' | 'result' | 'gate' | 'done';

interface GameRef {
  spec: KickSpec;
  kick: Kick | null;
  result: KickResult | null;
  kickStartedAt: number;     // performance.now at release
  snapAt: number;            // performance.now at snap (clock start)
  aiming: boolean;
  drag: Vec2;
  phase: Phase;
  roundIdx: number;
  perKick: number[];
  specs: KickSpec[];
  botched: boolean;
  fullAccess: boolean;
  roundStartedAt: number;
  finalMs: number;
  completed: boolean;
  /** When (performance.now) the result countdown auto-snaps the next kick. */
  nextRoundAt: number;
}

interface FieldGoalProps {
  kicker: KickerLook | null;
  fullAccess: boolean;
  onRoundComplete: (perKick: number[], millis: number) => void;
  onExit: () => void;
  onGoParticipate: () => void;
  submitNote?: string;
}

/** Tiny one-shot SFX (kick thunk, crowd roar, groan) on a lazy context. */
class KickSfx {
  private ctx: AudioContext | null = null;
  private ensure(): AudioContext | null {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      void this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  }
  thunk() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + 0.14);
  }
  roar() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
    src.connect(lp).connect(g).connect(ctx.destination); src.start(t);
  }
  groan() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(95, t + 0.55);
    g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + 0.65);
  }
}
const sfx = new KickSfx();

export default function FieldGoal({ kicker, fullAccess, onRoundComplete, onExit, onGoParticipate, submitNote }: FieldGoalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [roundIdx, setRoundIdx] = useState(0);
  const [perKick, setPerKick] = useState<number[]>([]);
  const [clockLeft, setClockLeft] = useState(AIM_WINDOW_MS);
  const [clockMs, setClockMs] = useState(0);
  const [resultLabel, setResultLabel] = useState('');
  const [musicOn, setMusicOn] = useState(pressureMusic.enabled);

  const look = kicker ?? DEFAULT_KICKER;

  // The 5 kick situations are rolled once per game and never change.
  const [specs] = useState<KickSpec[]>(() =>
    Array.from({ length: ROUNDS_PER_GAME }, () => randomKickSpec()));

  const ref = useRef<GameRef>({
    spec: specs[0], kick: null, result: null, kickStartedAt: 0, snapAt: 0,
    aiming: false, drag: { x: 0, y: 0 }, phase: 'intro' as Phase, roundIdx: 0,
    perKick: [], specs, botched: false, fullAccess,
    roundStartedAt: 0, finalMs: 0, completed: false, nextRoundAt: 0,
  });
  useEffect(() => { ref.current.fullAccess = fullAccess; }, [fullAccess]);

  const [spec, setSpec] = useState<KickSpec>(specs[0]);
  // Seconds shown on the between-kicks countdown.
  const [nextIn, setNextIn] = useState(Math.ceil(NEXT_KICK_COUNTDOWN_MS / 1000));

  // Phase transitions write the ref SYNCHRONOUSLY — the rAF loop reads it,
  // and waiting for a React commit would let a frame re-run transition logic
  // (e.g. double-recording a kick result).
  const setPhaseBoth = (p: Phase) => {
    ref.current.phase = p;
    setPhase(p);
  };

  // The snap: pressure music + the 3-second clock start here.
  const beginRound = () => {
    pressureMusic.start();
    const g = ref.current;
    g.snapAt = performance.now();
    if (g.roundStartedAt === 0) g.roundStartedAt = g.snapAt;
    g.kick = null;
    g.result = null;
    g.botched = false;
    g.aiming = false;
    setClockLeft(AIM_WINDOW_MS);
    setPhaseBoth('live');
  };
  useEffect(() => () => pressureMusic.stop(), []);

  const launchKick = (g: GameRef, kick: Kick, botched: boolean) => {
    g.kick = kick;
    g.botched = botched;
    g.result = simulateKick(g.spec, kick);
    g.kickStartedAt = performance.now();
    sfx.thunk();
    setPhaseBoth('flight');
  };

  // Auto-advance: the next kick snaps itself when the countdown ends.
  const advanceAndSnap = () => {
    const g = ref.current;
    const next = g.roundIdx + 1;
    g.roundIdx = next;
    g.spec = g.specs[next];
    setSpec(g.specs[next]);
    setRoundIdx(next);
    beginRound();
  };

  // ── Input (drag back from the ball, golf-style) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toCanvas = (e: PointerEvent): Vec2 => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * canvas.width,
        y: ((e.clientY - r.top) / r.height) * canvas.height,
      };
    };
    const ballScreen = (g: GameRef): Vec2 => ({ x: sx(g.spec.hashOffsetFt, 0), y: BASE_Y });

    const down = (e: PointerEvent) => {
      const g = ref.current;
      if (g.phase !== 'live' || g.kick) return;
      canvas.setPointerCapture(e.pointerId);
      g.aiming = true;
      const p = toCanvas(e); const b = ballScreen(g);
      g.drag = { x: p.x - b.x, y: p.y - b.y };
    };
    const move = (e: PointerEvent) => {
      const g = ref.current;
      if (!g.aiming) return;
      const p = toCanvas(e); const b = ballScreen(g);
      g.drag = { x: p.x - b.x, y: p.y - b.y };
    };
    const up = () => {
      const g = ref.current;
      if (!g.aiming) return;
      g.aiming = false;
      if (g.phase !== 'live' || g.kick) return;
      const kick = dragToKick(g.drag);
      if (kick) launchKick(g, kick, false);
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    // launchKick only touches the game ref + stable setters — bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clock + flight + render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const g = ref.current;

      if (g.phase === 'live' && !g.kick) {
        const left = Math.max(0, AIM_WINDOW_MS - (now - g.snapAt));
        setClockLeft(prev => (Math.abs(prev - left) >= 50 ? left : prev));
        if (left <= 0) {
          // Clock expired — the rushed kick is botched and WILL miss.
          launchKick(g, botchedKick(g.spec), true);
        }
      }

      if (g.phase === 'flight' && g.kick && g.result) {
        const t = (now - g.kickStartedAt) / 1000;
        const tEnd = Math.min(timeToPlane(g.spec, g.kick), flightTime(g.kick)) + 0.25;
        if (t >= tEnd) {
          const points = g.result.points;
          const nextPerKick = [...g.perKick, points];
          g.perKick = nextPerKick;
          setPerKick(nextPerKick);
          setResultLabel(g.botched ? `TOO SLOW — ${outcomeLabel(g.result.outcome)}` : outcomeLabel(g.result.outcome));
          if (g.result.outcome === 'good') sfx.roar(); else sfx.groan();
          if (g.roundIdx === ROUNDS_PER_GAME - 1) {
            g.finalMs = g.roundStartedAt ? performance.now() - g.roundStartedAt : 0;
            setClockMs(g.finalMs);
            if (!g.completed) {
              g.completed = true;
              onRoundComplete(nextPerKick, Math.round(g.finalMs));
            }
            g.phase = 'done';
            setPhase('done');
          } else if (g.roundIdx === 0 && !g.fullAccess) {
            g.phase = 'gate';
            setPhase('gate');
          } else {
            // Show the result, then auto-snap the next kick — no button.
            g.nextRoundAt = now + NEXT_KICK_COUNTDOWN_MS;
            setNextIn(Math.ceil(NEXT_KICK_COUNTDOWN_MS / 1000));
            g.phase = 'result';
            setPhase('result');
          }
        }
      }

      if (g.phase === 'result' && g.nextRoundAt) {
        const leftN = g.nextRoundAt - now;
        if (leftN <= 0) {
          g.nextRoundAt = 0;
          advanceAndSnap();
        } else {
          const secs = Math.ceil(leftN / 1000);
          setNextIn(prev => (prev === secs ? prev : secs));
        }
      }

      if (g.roundStartedAt && g.phase !== 'done') {
        const ms = now - g.roundStartedAt;
        setClockMs(prev => (Math.floor(ms / 1000) === Math.floor(prev / 1000) ? prev : ms));
      }

      render(ctx, g, now, look);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look.helmet, look.skin, look.jersey, onRoundComplete]);

  const totalPoints = perKick.reduce((a, b) => a + b, 0);
  const clockSecs = (clockLeft / 1000).toFixed(1);

  return (
    <div className="col" style={{ gap: 10, position: 'relative' }}>
      {/* HUD strip */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>Kick {roundIdx + 1}/{ROUNDS_PER_GAME}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
            {spec.distanceYds} yds · {hashLabel(spec.hashOffsetFt)}
          </span>
        </span>
        <span className="row" style={{ gap: 10 }}>
          <Chip tone="ok"><span className="mono">Points {totalPoints}</span></Chip>
          <Chip tone="burn"><Icon name="clock" size={11} /><span className="mono">{fmtMillis(clockMs)}</span></Chip>
          <Btn variant="ghost" sm onClick={() => setMusicOn(pressureMusic.toggle())}>
            <Icon name={musicOn ? 'sound' : 'soundOff'} size={13} />
          </Btn>
          <Btn variant="ghost" sm onClick={onExit}><Icon name="x" size={12} /> Quit</Btn>
        </span>
      </div>

      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-hi)' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'crosshair', background: PAL.skyTop }}
        />

        {/* Pressure clock — front and center while live */}
        {phase === 'live' && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 38, lineHeight: 1,
            color: clockLeft <= 700 ? '#ff5546' : '#ffffff',
            textShadow: '0 2px 10px rgba(0,0,0,0.7)',
            pointerEvents: 'none',
          }}>
            {clockSecs}
          </div>
        )}

        {/* Round intro */}
        {phase === 'intro' && (
          <Overlay>
            <span className="mono" style={{ fontSize: 11, color: 'var(--burn)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Kick {roundIdx + 1} of {ROUNDS_PER_GAME}
            </span>
            <h3 style={{ margin: 0 }}>{spec.distanceYds}-yarder · {hashLabel(spec.hashOffsetFt)}</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, textAlign: 'center', maxWidth: 380 }}>
              From the snap you have <b>3 seconds</b>: drag back from the ball, release to kick.
              Hesitate and the kick gets rushed — wide or short. A make scores {spec.distanceYds} points.
            </span>
            <Btn variant="primary" onClick={beginRound}><Icon name="zap" size={13} stroke="var(--char-950)" /> Snap the ball</Btn>
          </Overlay>
        )}

        {/* Kick result — auto-advances into the next snap, no button */}
        {phase === 'result' && (
          <Overlay>
            <h3 style={{ margin: 0 }}>{resultLabel}</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
              {perKick[perKick.length - 1] > 0
                ? `+${perKick[perKick.length - 1]} points`
                : 'No points — shake it off.'}
            </span>
            <span className="mono" style={{ fontSize: 30, fontWeight: 800, color: 'var(--burn)', lineHeight: 1 }}>
              {nextIn}
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Next kick — get ready
            </span>
          </Overlay>
        )}

        {/* Participation gate after kick 1 */}
        {phase === 'gate' && (
          <Overlay>
            <Icon name="lock" size={26} stroke="var(--haze)" />
            <h3 style={{ margin: 0 }}>That's the free preview</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, maxWidth: 380, textAlign: 'center' }}>
              Kicks 2–5 (and the leaderboard) unlock for protocol participants: stake any
              amount of ICP, or vote on a proposal — a vote in the last 30 days counts.
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Btn variant="primary" onClick={onGoParticipate}><Icon name="zap" size={13} stroke="var(--char-950)" /> Stake or vote</Btn>
              <Btn variant="secondary" onClick={onExit}>Back to Arcade</Btn>
            </span>
          </Overlay>
        )}

        {/* Final scorecard */}
        {phase === 'done' && (
          <Overlay wide>
            <h3 style={{ margin: 0 }}>Final whistle</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
              {totalPoints} points · {fmtMillis(clockMs)}
            </span>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 11.5, margin: '0 auto' }}>
                <tbody>
                  <tr>
                    <td style={SC_TD}>Kick</td>
                    {specs.map((_, i) => <td key={i} style={SC_TD}>{i + 1}</td>)}
                  </tr>
                  <tr style={{ color: 'var(--fg-3)' }}>
                    <td style={SC_TD}>Yds</td>
                    {specs.map((s, i) => <td key={i} style={SC_TD}>{s.distanceYds}</td>)}
                  </tr>
                  <tr>
                    <td style={SC_TD}>Pts</td>
                    {perKick.map((p, i) => (
                      <td key={i} style={{ ...SC_TD, color: p > 0 ? 'var(--sprout)' : 'var(--haze)' }}>{p}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {submitNote && <span style={{ fontSize: 12.5, color: 'var(--burn)' }}>{submitNote}</span>}
            <Btn variant="primary" onClick={onExit}>Back to Arcade</Btn>
          </Overlay>
        )}
      </div>

      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
        Drag back from the ball and release to kick — farther drag, bigger leg. The clock starts at the snap.
      </span>
    </div>
  );
}

function Overlay({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(10, 12, 18, 0.72)', backdropFilter: 'blur(3px)',
    }}>
      <div className="col" style={{
        gap: 12, alignItems: 'center', padding: '22px 26px', borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border-hi)',
        maxWidth: wide ? 560 : 430, width: 'calc(100% - 48px)',
      }}>
        {children}
      </div>
    </div>
  );
}

const SC_TD: React.CSSProperties = { padding: '3px 8px', textAlign: 'center', border: '1px solid var(--border)' };

// ── Canvas renderer ──

function render(ctx: CanvasRenderingContext2D, g: GameRef, nowMs: number, look: KickerLook) {
  const { spec } = g;
  const distFt = spec.distanceYds * 3;

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 40);
  sky.addColorStop(0, PAL.skyTop);
  sky.addColorStop(1, PAL.skyBot);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_W, HORIZON_Y + 20);

  // Crowd — two flickering banded tiers (deterministic flicker off the clock).
  for (let band = 0; band < 2; band++) {
    const y0 = 38 + band * 46;
    ctx.fillStyle = band === 0 ? PAL.crowdA : PAL.crowdB;
    ctx.fillRect(0, y0, CANVAS_W, 42);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = 0; i < 120; i++) {
      const px = (i * 73 + band * 37) % CANVAS_W;
      const flick = Math.sin(nowMs / 700 + i * 1.7 + band) > 0.55 ? 2 : 1;
      ctx.fillRect(px, y0 + 8 + ((i * 29) % 26), flick, flick);
    }
  }

  // Field — full-width green from horizon to bottom, mowing stripes by z-band.
  ctx.fillStyle = PAL.grassA;
  ctx.fillRect(0, HORIZON_Y, CANVAS_W, CANVAS_H - HORIZON_Y);
  for (let zb = 0; zb < 20; zb++) {
    const z0 = zb * 15, z1 = z0 + 15;
    if (zb % 2 === 0) continue;
    ctx.fillStyle = PAL.grassB;
    const yTop = syGround(z1), yBot = syGround(z0);
    ctx.fillRect(0, yTop, CANVAS_W, yBot - yTop);
  }

  // End-zone band just past the posts.
  {
    const yTop = syGround(distFt + 30), yBot = syGround(distFt);
    ctx.fillStyle = PAL.endzone;
    ctx.fillRect(0, yTop, CANVAS_W, yBot - yTop);
  }

  // Yard lines every 5 yards, converging to the vanishing point.
  ctx.strokeStyle = PAL.line;
  for (let z = 0; z <= distFt; z += 15) {
    const w = 80 * PXF * persp(z); // 160 ft of field width
    ctx.lineWidth = Math.max(1, 2.4 * persp(z));
    ctx.beginPath();
    ctx.moveTo(CX - w / 2, syGround(z));
    ctx.lineTo(CX + w / 2, syGround(z));
    ctx.stroke();
  }
  // Hash ticks.
  ctx.strokeStyle = PAL.hashLine;
  for (let z = 7.5; z < distFt; z += 15) {
    for (const hx of [-9.25, 9.25]) {
      ctx.lineWidth = Math.max(1, 1.6 * persp(z));
      ctx.beginPath();
      ctx.moveTo(sx(hx - 1, z), syGround(z));
      ctx.lineTo(sx(hx + 1, z), syGround(z));
      ctx.stroke();
    }
  }

  // Goalposts at the upright plane.
  drawPosts(ctx, distFt);

  // Aim guide while dragging.
  if (g.aiming && g.phase === 'live' && !g.kick) {
    const kick = dragToKick(g.drag);
    const bx = sx(spec.hashOffsetFt, 0), by = BASE_Y;
    if (kick) {
      const power = kick.speed / 90;
      const len = 40 + power * 130;
      const ex = bx + Math.sin(kick.azimuth) * len;
      const ey = by - Math.cos(kick.azimuth * 0.3) * len * 0.9;
      ctx.strokeStyle = power > 0.85 ? '#ff7a45' : '#ffd95e';
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      // Power meter.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx - 42, by + 18, 84, 9);
      ctx.fillStyle = power > 0.85 ? '#ff7a45' : '#ffd95e';
      ctx.fillRect(bx - 40, by + 20, 80 * power, 5);
    }
    // The raw drag tail.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + g.drag.x, by + g.drag.y);
    ctx.stroke();
  }

  // Ball (and kicker until the ball is away).
  if (g.phase === 'flight' && g.kick) {
    const t = (nowMs - g.kickStartedAt) / 1000;
    const tEnd = Math.min(timeToPlane(spec, g.kick), flightTime(g.kick));
    const at = ballAt(spec, g.kick, Math.min(t, tEnd));
    drawBall(ctx, sx(at.x, at.z), sy(at.y, at.z), Math.max(3, 9 * persp(at.z)), nowMs);
    // Ground shadow.
    ctx.fillStyle = PAL.shadow;
    ctx.beginPath();
    ctx.ellipse(sx(at.x, at.z), syGround(at.z), Math.max(2, 8 * persp(at.z)), Math.max(1, 3 * persp(at.z)), 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (g.phase === 'live' || g.phase === 'intro') {
    const bx = sx(spec.hashOffsetFt, 0), by = BASE_Y;
    // Tee shadow + teed-up ball.
    ctx.fillStyle = PAL.shadow;
    ctx.beginPath();
    ctx.ellipse(bx, by + 8, 10, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    drawBall(ctx, bx, by, 9, 0);
    drawKicker(ctx, bx - 38, by - 4, look);
  }
}

function drawPosts(ctx: CanvasRenderingContext2D, distFt: number) {
  const s = persp(distFt);
  const lw = Math.max(2, 5 * s);
  const groundY = syGround(distFt);
  const barY = sy(CROSSBAR_FT, distFt);
  const topY = sy(UPRIGHT_TOP_FT, distFt);
  const lx = sx(-POST_HALF_GAP_FT, distFt);
  const rx = sx(POST_HALF_GAP_FT, distFt);

  ctx.strokeStyle = PAL.postDark;
  ctx.lineWidth = lw + 1.5;
  // Center stalk.
  ctx.beginPath(); ctx.moveTo(CX, groundY); ctx.lineTo(CX, barY); ctx.stroke();
  ctx.strokeStyle = PAL.post;
  ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(CX, groundY); ctx.lineTo(CX, barY); ctx.stroke();
  // Crossbar.
  ctx.beginPath(); ctx.moveTo(lx, barY); ctx.lineTo(rx, barY); ctx.stroke();
  // Uprights.
  ctx.beginPath(); ctx.moveTo(lx, barY); ctx.lineTo(lx, topY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(rx, barY); ctx.lineTo(rx, topY); ctx.stroke();
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, nowMs: number) {
  ctx.save();
  ctx.translate(x, y);
  if (nowMs) ctx.rotate((nowMs / 90) % (Math.PI * 2)); // tumble in flight
  ctx.fillStyle = PAL.ballDark;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.25, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAL.ball;
  ctx.beginPath();
  ctx.ellipse(-r * 0.12, -r * 0.12, r * 1.1, r * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PAL.lace;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  ctx.moveTo(-r * 0.45, 0);
  ctx.lineTo(r * 0.45, 0);
  ctx.stroke();
  ctx.restore();
}

/** Low-poly kicker mini-figure (same vector style as the golfer). */
function drawKicker(ctx: CanvasRenderingContext2D, x: number, y: number, look: KickerLook) {
  const skin = SKIN_COLORS[look.skin] ?? SKIN_COLORS[0];
  const helmet = HELMET_COLORS[look.helmet] ?? HELMET_COLORS[0];
  const jersey = JERSEY_COLORS[look.jersey] ?? JERSEY_COLORS[0];
  const pants = '#d8d8d8';

  ctx.save();
  ctx.translate(x, y);
  // shadow
  ctx.fillStyle = PAL.shadow;
  ctx.beginPath(); ctx.ellipse(11, 2, 13, 4, 0, 0, Math.PI * 2); ctx.fill();
  // legs
  ctx.fillStyle = pants;
  ctx.fillRect(4, -22, 6, 22);
  ctx.fillRect(13, -22, 6, 20);
  ctx.fillStyle = '#26211c';
  ctx.fillRect(3, -2, 8, 4);
  ctx.fillRect(13, -4, 9, 4); // kicking foot slightly forward
  // torso
  ctx.fillStyle = jersey;
  ctx.fillRect(2, -44, 19, 22);
  // arms
  ctx.strokeStyle = skin;
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(4, -40); ctx.lineTo(-4, -26); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(19, -40); ctx.lineTo(26, -28); ctx.stroke();
  // head + helmet + facemask
  ctx.fillStyle = skin;
  ctx.fillRect(5, -58, 13, 14);
  ctx.fillStyle = helmet;
  ctx.fillRect(3, -61, 17, 11);
  ctx.fillRect(3, -52, 4, 6);
  ctx.strokeStyle = '#cfcfcf';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(12, -49); ctx.lineTo(20, -49); ctx.stroke();
  ctx.restore();
}
