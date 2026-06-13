import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import { fmtMillis } from './engine';
import {
  BODY_COLORS, STRIPE_COLORS, WHEEL_COLORS, DEFAULT_CAR,
  LANES, LANE_WIDTH_FT, CAR_LEN_FT, RUN_MS, STAGES, STAGE_MS,
  initRace, stageIndex, steer, stepRace,
  type CarLook, type RaceState,
} from './racerEngine';
import { turboMusic } from './music';

// ==========================================
// Turbo Rush — an original Atari-era pseudo-3D lane racer: sunset horizon,
// chunky flat-shaded sprites, scanlines. One 60-second full-throttle run on
// a 3-lane highway; steer (←/→, A/D, or tap either side of the road) to
// thread through slower traffic. Every clean pass scores a point; clipping
// a car spins you out for 1.5 seconds. 5 stages of 12 s feed the
// leaderboard's per-stage point vector.
// ==========================================

const CANVAS_W = 860, CANVAS_H = 510;
const CX = CANVAS_W / 2;
const HORIZON_Y = 170;
const BASE_Y = 470;          // screen y of the player's bumper (z = 0)
const CAM_D = 40;            // perspective strength, ft
const PXF = 7;               // px per ft at z = 0

const persp = (z: number) => CAM_D / (CAM_D + Math.max(0, z));
const sx = (x: number, z: number) => CX + x * PXF * persp(z);
const syGround = (z: number) => HORIZON_Y + (BASE_Y - HORIZON_Y) * persp(z);

const ROAD_HALF_FT = (LANES * LANE_WIDTH_FT) / 2;

const PAL = {
  skyTop: '#2a1640', skyMid: '#a83a4a', skyBot: '#f2a23a',
  sun: '#ffd23e',
  mountain: '#3a2050', mountainHi: '#552d6a',
  ground: '#3a7a3a', groundDark: '#336d33',
  road: '#5a5a62', roadDark: '#52525a',
  edge: '#e8e8e8', dash: '#f2e84a',
  trafficPalette: ['#3a6ec4', '#c4953a', '#7a4ac4', '#3ab0a0'],
  trafficDark: '#22252e',
  windshield: '#cfe8f5',
  shadow: 'rgba(10, 10, 16, 0.4)',
};

type Phase = 'intro' | 'run' | 'gate' | 'done';

interface GameRef {
  race: RaceState;
  phase: Phase;
  fullAccess: boolean;
  startedAt: number;     // performance.now at green light
  lastFrameAt: number;
  finalMs: number;
  completed: boolean;
  gated: boolean;        // preview run ended at the stage-1 gate
  crashFlashUntil: number;
}

interface TurboRushProps {
  car: CarLook | null;
  fullAccess: boolean;
  onRoundComplete: (perStage: number[], millis: number) => void;
  onExit: () => void;
  onGoParticipate: () => void;
  submitNote?: string;
}

/** One-shot SFX: pass blip + crash crunch, lazy AudioContext. */
class RushSfx {
  private ctx: AudioContext | null = null;
  private ensure(): AudioContext | null {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      void this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  }
  blip() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(990, t + 0.05);
    g.gain.setValueAtTime(0.07, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + 0.09);
  }
  crash() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.35);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    src.connect(lp).connect(g).connect(ctx.destination); src.start(t);
  }
}
const sfx = new RushSfx();

export default function TurboRush({ car, fullAccess, onRoundComplete, onExit, onGoParticipate, submitNote }: TurboRushProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [passed, setPassed] = useState(0);
  const [stage, setStage] = useState(0);
  const [timeLeft, setTimeLeft] = useState(RUN_MS);
  const [perStage, setPerStage] = useState<number[]>([]);
  const [finalStats, setFinalStats] = useState({ ms: 0, crashes: 0 });
  const [musicOn, setMusicOn] = useState(turboMusic.enabled);

  const look = car ?? DEFAULT_CAR;

  const ref = useRef<GameRef>({
    race: initRace(),
    phase: 'intro',
    fullAccess,
    startedAt: 0,
    lastFrameAt: 0,
    finalMs: 0,
    completed: false,
    gated: false,
    crashFlashUntil: 0,
  });
  useEffect(() => { ref.current.fullAccess = fullAccess; }, [fullAccess]);

  const setPhaseBoth = (p: Phase) => {
    ref.current.phase = p;
    setPhase(p);
  };

  const startRun = () => {
    turboMusic.start();
    const g = ref.current;
    g.race = initRace();
    g.startedAt = performance.now();
    g.lastFrameAt = g.startedAt;
    g.completed = false;
    g.gated = false;
    setPassed(0);
    setStage(0);
    setPerStage([]);
    setTimeLeft(RUN_MS);
    setPhaseBoth('run');
  };
  useEffect(() => () => turboMusic.stop(), []);

  // ── Input: arrows / A-D / tap left-right of the canvas ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onKey = (e: KeyboardEvent) => {
      const g = ref.current;
      if (g.phase !== 'run') return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { steer(g.race, -1); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { steer(g.race, 1); e.preventDefault(); }
    };
    const onPointer = (e: PointerEvent) => {
      const g = ref.current;
      if (g.phase !== 'run') return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      steer(g.race, x < 0.5 ? -1 : 1);
    };

    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  // ── Simulation + render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const g = ref.current;

      if (g.phase === 'run') {
        const dt = Math.min(50, now - g.lastFrameAt);
        g.lastFrameAt = now;
        const ev = stepRace(g.race, dt);
        if (ev.passedNow > 0) { sfx.blip(); setPassed(g.race.passed); }
        if (ev.crashed) { sfx.crash(); g.crashFlashUntil = now + 220; }

        const sIdx = stageIndex(g.race.tMs);
        setStage(prev => (prev === sIdx ? prev : sIdx));
        const left = Math.max(0, RUN_MS - g.race.tMs);
        setTimeLeft(prev => (Math.floor(prev / 100) === Math.floor(left / 100) ? prev : left));

        // Preview drivers pull over at the end of stage 1.
        if (!g.fullAccess && g.race.tMs >= STAGE_MS) {
          g.gated = true;
          setPhaseBoth('gate');
        } else if (g.race.finished) {
          g.finalMs = Math.round(performance.now() - g.startedAt);
          setPerStage([...g.race.perStage]);
          setFinalStats({ ms: g.finalMs, crashes: g.race.crashes });
          if (!g.completed) {
            g.completed = true;
            onRoundComplete([...g.race.perStage], g.finalMs);
          }
          setPhaseBoth('done');
        }
      } else {
        g.lastFrameAt = now;
      }

      render(ctx, g, now, look);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // The loop only touches the game ref + stable setters — bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look.body, look.wheels, look.stripe, onRoundComplete]);

  const totalPoints = perStage.reduce((a, b) => a + b, 0);

  return (
    <div className="col" style={{ gap: 10, position: 'relative' }}>
      {/* HUD strip */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>Stage {Math.min(stage + 1, STAGES)}/{STAGES}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>full throttle · 60 s run</span>
        </span>
        <span className="row" style={{ gap: 10 }}>
          <Chip tone="ok"><span className="mono">Passed {passed}</span></Chip>
          <Chip tone="burn"><Icon name="clock" size={11} /><span className="mono">{(timeLeft / 1000).toFixed(1)}s</span></Chip>
          <Btn variant="ghost" sm onClick={() => setMusicOn(turboMusic.toggle())}>
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
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'pointer', background: PAL.skyTop }}
        />

        {/* Start light */}
        {phase === 'intro' && (
          <Overlay>
            <span className="mono" style={{ fontSize: 11, color: 'var(--burn)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Turbo Rush
            </span>
            <h3 style={{ margin: 0 }}>60 seconds. Full throttle.</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, textAlign: 'center', maxWidth: 400 }}>
              Steer with ← → (or tap either side of the road) and thread through traffic —
              every car you pass is a point. Clip one and you spin out for 1.5 seconds.
            </span>
            <Btn variant="primary" onClick={startRun}><Icon name="zap" size={13} stroke="var(--char-950)" /> Start engine</Btn>
          </Overlay>
        )}

        {/* Participation gate after stage 1 */}
        {phase === 'gate' && (
          <Overlay>
            <Icon name="lock" size={26} stroke="var(--haze)" />
            <h3 style={{ margin: 0 }}>That's the free preview</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, maxWidth: 380, textAlign: 'center' }}>
              Stages 2–5 (and the leaderboard) unlock for protocol participants: stake any
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
            <h3 style={{ margin: 0 }}>Checkered flag</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
              {totalPoints} cars passed · {fmtMillis(finalStats.ms)} · {finalStats.crashes} crash{finalStats.crashes === 1 ? '' : 'es'}
            </span>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 11.5, margin: '0 auto' }}>
                <tbody>
                  <tr>
                    <td style={SC_TD}>Stage</td>
                    {perStage.map((_, i) => <td key={i} style={SC_TD}>{i + 1}</td>)}
                  </tr>
                  <tr>
                    <td style={SC_TD}>Passed</td>
                    {perStage.map((p, i) => (
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
        ← → or A/D to change lanes — taps on the left/right half of the screen work too.
      </span>
    </div>
  );
}

function Overlay({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(14, 10, 20, 0.72)', backdropFilter: 'blur(3px)',
    }}>
      <div className="col" style={{
        gap: 12, alignItems: 'center', padding: '22px 26px', borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border-hi)',
        maxWidth: wide ? 560 : 440, width: 'calc(100% - 48px)',
      }}>
        {children}
      </div>
    </div>
  );
}

const SC_TD: React.CSSProperties = { padding: '3px 8px', textAlign: 'center', border: '1px solid var(--border)' };

// ── Canvas renderer ──

const laneCenterFt = (lane: number) => (lane - (LANES - 1) / 2) * LANE_WIDTH_FT;

function render(ctx: CanvasRenderingContext2D, g: GameRef, nowMs: number, look: CarLook) {
  const race = g.race;

  // Sunset sky — three flat bands + a chunky sun (2600 vibes).
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
  sky.addColorStop(0, PAL.skyTop);
  sky.addColorStop(0.62, PAL.skyMid);
  sky.addColorStop(1, PAL.skyBot);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CANVAS_W, HORIZON_Y);
  ctx.fillStyle = PAL.sun;
  ctx.fillRect(CX - 26, HORIZON_Y - 58, 52, 8);
  ctx.fillRect(CX - 34, HORIZON_Y - 50, 68, 10);
  ctx.fillRect(CX - 38, HORIZON_Y - 40, 76, 40);

  // Mountains — fixed zigzag silhouettes.
  ctx.fillStyle = PAL.mountain;
  for (let i = 0; i < 7; i++) {
    const mx = i * 140 - 30;
    ctx.beginPath();
    ctx.moveTo(mx, HORIZON_Y);
    ctx.lineTo(mx + 70, HORIZON_Y - 36 - (i % 3) * 12);
    ctx.lineTo(mx + 140, HORIZON_Y);
    ctx.fill();
  }

  // Grass.
  ctx.fillStyle = PAL.ground;
  ctx.fillRect(0, HORIZON_Y, CANVAS_W, CANVAS_H - HORIZON_Y);
  // Scroll-striped shoulder bands by odometer.
  for (let zb = 0; zb < 16; zb++) {
    const z0 = zb * 40 - (race.odoFt % 80);
    if (Math.floor((z0 + race.odoFt) / 40) % 2 === 0) continue;
    const yTop = syGround(z0 + 40), yBot = syGround(Math.max(0, z0));
    if (yBot < HORIZON_Y) continue;
    ctx.fillStyle = PAL.groundDark;
    ctx.fillRect(0, Math.max(HORIZON_Y, yTop), CANVAS_W, Math.max(0, yBot - Math.max(HORIZON_Y, yTop)));
  }

  // Road slab.
  ctx.fillStyle = PAL.road;
  ctx.beginPath();
  ctx.moveTo(sx(-ROAD_HALF_FT, 0), BASE_Y);
  ctx.lineTo(sx(ROAD_HALF_FT, 0), BASE_Y);
  ctx.lineTo(sx(ROAD_HALF_FT, 600), syGround(600));
  ctx.lineTo(sx(-ROAD_HALF_FT, 600), syGround(600));
  ctx.fill();

  // Edges.
  ctx.strokeStyle = PAL.edge;
  ctx.lineWidth = 3;
  for (const exf of [-ROAD_HALF_FT, ROAD_HALF_FT]) {
    ctx.beginPath();
    ctx.moveTo(sx(exf, 0), BASE_Y);
    ctx.lineTo(sx(exf, 600), syGround(600));
    ctx.stroke();
  }

  // Lane dashes, scrolling with the odometer.
  ctx.strokeStyle = PAL.dash;
  for (const lf of [-LANE_WIDTH_FT / 2, LANE_WIDTH_FT / 2]) {
    for (let zd = -(race.odoFt % 40); zd < 600; zd += 40) {
      const z0 = Math.max(0.1, zd), z1 = Math.max(0.1, zd + 18);
      if (z1 <= 0.2) continue;
      ctx.lineWidth = Math.max(1, 4 * persp(z0));
      ctx.beginPath();
      ctx.moveTo(sx(lf, z0), syGround(z0));
      ctx.lineTo(sx(lf, z1), syGround(z1));
      ctx.stroke();
    }
  }

  // Traffic, far to near.
  const sorted = [...race.traffic].sort((a, b) => b.z - a.z);
  for (const c of sorted) {
    if (c.z < -CAR_LEN_FT || c.z > 580) continue;
    drawCar(ctx, laneCenterFt(c.lane), c.z, PAL.trafficPalette[c.palette % PAL.trafficPalette.length], '#1f2230', WHEEL_COLORS[0], false, 0);
  }

  // Player car at z = 0, sliding lane position, spin-wobble while stunned.
  if (g.phase !== 'intro') {
    const stunned = race.tMs < race.stunUntilMs;
    const wobble = stunned ? Math.sin(nowMs / 40) * 4 : 0;
    drawCar(
      ctx,
      laneCenterFt(race.laneX),
      0.1,
      BODY_COLORS[look.body] ?? BODY_COLORS[0],
      STRIPE_COLORS[look.stripe] ?? STRIPE_COLORS[0],
      WHEEL_COLORS[look.wheels] ?? WHEEL_COLORS[0],
      true,
      wobble,
    );
  }

  // Crash flash.
  if (nowMs < g.crashFlashUntil) {
    ctx.fillStyle = 'rgba(255, 90, 60, 0.22)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // Scanlines — the retro veil.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  for (let y = 0; y < CANVAS_H; y += 3) {
    ctx.fillRect(0, y, CANVAS_W, 1);
  }
}

/** Chunky flat-shaded pixel car, scaled by distance. */
function drawCar(
  ctx: CanvasRenderingContext2D,
  xFt: number, z: number,
  body: string, stripe: string, wheels: string,
  isPlayer: boolean, wobblePx: number,
) {
  const s = persp(z);
  const w = 8.5 * PXF * s;          // car width px
  const h = w * 0.82;               // visual height
  const cx = sx(xFt, z) + wobblePx;
  const groundY = syGround(z);

  // Shadow.
  ctx.fillStyle = PAL.shadow;
  ctx.fillRect(cx - w * 0.55, groundY - h * 0.08, w * 1.1, h * 0.14);

  // Wheels poking out.
  ctx.fillStyle = wheels;
  ctx.fillRect(cx - w * 0.58, groundY - h * 0.32, w * 0.16, h * 0.3);
  ctx.fillRect(cx + w * 0.42, groundY - h * 0.32, w * 0.16, h * 0.3);

  // Body block.
  ctx.fillStyle = body;
  ctx.fillRect(cx - w / 2, groundY - h * 0.62, w, h * 0.58);
  // Racing stripe down the middle.
  ctx.fillStyle = stripe;
  ctx.fillRect(cx - w * 0.09, groundY - h * 0.62, w * 0.18, h * 0.58);
  // Cabin: windshield faces away for the player (rear view), toward us for traffic.
  ctx.fillStyle = isPlayer ? PAL.trafficDark : PAL.windshield;
  ctx.fillRect(cx - w * 0.32, groundY - h * 0.88, w * 0.64, h * 0.3);
  // Tail/head lights.
  ctx.fillStyle = isPlayer ? '#ff4a3a' : '#ffe89a';
  ctx.fillRect(cx - w * 0.44, groundY - h * 0.18, w * 0.14, h * 0.08);
  ctx.fillRect(cx + w * 0.30, groundY - h * 0.18, w * 0.14, h * 0.08);
}
