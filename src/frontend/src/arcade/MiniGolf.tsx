import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, Icon } from '../ui';
import { track } from '../analytics';
import {
  STEP, MAX_POWER, DEFAULT_CHARACTER,
  initHole, stepHole, strike, dragToShot, speed, fmtMillis, scoreLabel,
  type CharacterLook, type HoleDef, type HoleState, type Vec,
} from './engine';
import { fitView, isoP, isoUn, renderHoleScene, type IsoView } from './holeRender';
import { arcadeMusic } from './music';
import { isTouchDevice } from './DropZone';

// ==========================================
// Mini Golf — game shell over the isometric voxel renderer (holeRender.ts).
// The scene (ground/walls/flag/ball/golfer) is drawn by renderHoleScene
// through a fitView camera, so any grid size frames correctly; this file owns
// the game loop, input, HUD and the screen-space overlays (aim, splash,
// power bar). The golfer vanishes the instant the ball is struck and
// reappears only once it has come to rest.
// ==========================================

const CANVAS_W = 860, CANVAS_H = 510;

type Phase = 'intro' | 'play' | 'sunk' | 'gate' | 'done';

/** Mutable game state owned by the rAF loop (kept in a React ref). */
interface GameRef {
  def: HoleDef; state: HoleState; holeClock: number; aiming: boolean; drag: Vec;
  facing: Vec; splash: number; phase: Phase; holeIdx: number;
  perHole: number[]; fullAccess: boolean; roundStartedAt: number; finalMs: number; completed: boolean;
}

interface MiniGolfProps {
  course: HoleDef[];
  character: CharacterLook | null;
  fullAccess: boolean;
  /** Fired once per hole as it's sunk (1-based hole number 1..9). PB-306. */
  onHoleSunk?: (hole: number) => void;
  /** Fired once when the final hole is sunk. */
  onRoundComplete: (perHole: number[], millis: number) => void;
  onExit: () => void;
  onGoParticipate: () => void;
  /** Status line rendered on the final scorecard (e.g. submit result). */
  submitNote?: string;
  /** Optional CTA rendered next to submitNote (e.g. "Stake ICP →"). */
  submitAction?: { label: string; onClick: () => void };
}

// onGoParticipate is kept in the props for caller compatibility; the sign-in
// gate no longer routes to Participate (2026-07-04 — play is free once signed in).
export default function MiniGolf({ course, character, fullAccess, onHoleSunk, onRoundComplete, onExit, onGoParticipate: _onGoParticipate, submitNote, submitAction }: MiniGolfProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [holeIdx, setHoleIdx] = useState(0);
  const [perHole, setPerHole] = useState<number[]>([]);
  const [strokesNow, setStrokesNow] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const [sunkLabel, setSunkLabel] = useState('');
  const [musicOn, setMusicOn] = useState(arcadeMusic.enabled);

  const look = character ?? DEFAULT_CHARACTER;
  const parTotal = course.reduce((s, h) => s + h.par, 0);

  // Latest onHoleSunk in a ref so the rAF loop never fires a stale callback.
  const onHoleSunkRef = useRef(onHoleSunk);
  onHoleSunkRef.current = onHoleSunk;

  const ref = useRef<GameRef>({
    def: course[0],
    state: initHole(course[0]),
    holeClock: 0,
    roundStartedAt: 0,
    finalMs: 0,
    aiming: false,
    drag: { x: 0, y: 0 },
    facing: { x: 0, y: -1 },
    splash: 0,
    phase: 'intro',
    holeIdx: 0,
    perHole: [],
    fullAccess,
    completed: false,
  });
  ref.current.fullAccess = fullAccess;
  ref.current.phase = phase;

  const loadHole = (idx: number) => {
    ref.current.def = course[idx];
    ref.current.state = initHole(course[idx]);
    ref.current.holeClock = 0;
    ref.current.holeIdx = idx;
    setHoleIdx(idx);
    setStrokesNow(0);
  };

  // Music starts on the Putt click (a user gesture, so autoplay is allowed).
  const beginHole = () => {
    arcadeMusic.start();
    setPhase('play');
  };
  useEffect(() => () => arcadeMusic.stop(), []);

  // ── Input ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toWorld = (e: PointerEvent): Vec => {
      const r = canvas.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * canvas.width;
      const sy = ((e.clientY - r.top) / r.height) * canvas.height;
      return isoUn(fitView(ref.current.def, CANVAS_W, CANVAS_H), sx, sy);
    };

    const down = (e: PointerEvent) => {
      const g = ref.current;
      if (g.phase !== 'play' || g.state.phase !== 'resting') return;
      canvas.setPointerCapture(e.pointerId);
      g.aiming = true;
      const w = toWorld(e);
      g.drag = { x: w.x - g.state.pos.x, y: w.y - g.state.pos.y };
    };
    const move = (e: PointerEvent) => {
      const g = ref.current;
      if (!g.aiming) return;
      const w = toWorld(e);
      g.drag = { x: w.x - g.state.pos.x, y: w.y - g.state.pos.y };
      const shot = dragToShot(g.drag);
      if (shot.x || shot.y) {
        const n = speed(shot);
        g.facing = { x: shot.x / n, y: shot.y / n };
      }
    };
    const up = () => {
      const g = ref.current;
      if (!g.aiming) return;
      g.aiming = false;
      const shot = dragToShot(g.drag);
      if (strike(g.state, shot)) {
        if (g.roundStartedAt === 0) g.roundStartedAt = performance.now();
        setStrokesNow(g.state.strokes);
      }
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
  }, []);

  // ── Simulation + render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const g = ref.current;
      const dtMs = Math.min(50, now - last);
      last = now;

      if (g.phase === 'play') {
        acc += dtMs / 1000;
        while (acc >= STEP) {
          acc -= STEP;
          g.holeClock += STEP;
          if (g.state.phase === 'rolling') {
            stepHole(g.state, g.def, g.holeClock);
            if (g.state.event === 'water') {
              g.splash = 1;
              setStrokesNow(g.state.strokes);
            }
            // Tunnel teleport: the jar-pop cue (event is set for one step only).
            if (g.state.event === 'tunnel') arcadeMusic.playPop();
            // stepHole mutates phase — widen past TS's narrowing of the guard.
            if ((g.state.phase as string) === 'sunk') {
              const strokes = g.state.strokes;
              const nextPerHole = [...g.perHole, strokes];
              g.perHole = nextPerHole;
              setPerHole(nextPerHole);
              setSunkLabel(g.state.event === 'capped' ? 'Picked up (12-stroke cap)' : scoreLabel(strokes, g.def.par));
              // PB-306: report the hole (1-based) as it's sunk, so the play
              // wrapper can call record_hole_event in order.
              onHoleSunkRef.current?.(g.holeIdx + 1);
              if (g.holeIdx === course.length - 1) {
                g.finalMs = g.roundStartedAt ? performance.now() - g.roundStartedAt : 0;
                setClockMs(g.finalMs);
                if (!g.completed) {
                  g.completed = true;
                  onRoundComplete(nextPerHole, Math.round(g.finalMs));
                  track("game_played", { game: "mini_golf", score: nextPerHole.reduce((a, b) => a + b, 0) });
                }
                setPhase('done');
              } else if (g.holeIdx === 0 && !g.fullAccess) {
                setPhase('gate');
              } else {
                setPhase('sunk');
              }
            }
          }
        }
        if (g.roundStartedAt && g.state.phase !== 'sunk') {
          const ms = performance.now() - g.roundStartedAt;
          // fmtMillis shows whole seconds — only re-render when they change.
          setClockMs(prev => (Math.floor(ms / 1000) === Math.floor(prev / 1000) ? prev : ms));
        }
      }
      g.splash = Math.max(0, g.splash - dtMs / 600);

      render(ctx, g, look);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [look.hair, look.skin, look.outfit, onRoundComplete]);

  // Mobile fullscreen: the round takes the whole screen (page chrome and
  // scrolling fight the drag-to-putt gesture); desktop layout untouched.
  const fullscreen = isTouchDevice();
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [fullscreen]);

  const totalStrokes = perHole.reduce((a, b) => a + b, 0);
  const parSoFar = course.slice(0, perHole.length).reduce((a, h) => a + h.par, 0);
  const diff = totalStrokes - parSoFar;
  const diffLabel = perHole.length === 0 ? 'E' : diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;

  const advance = () => {
    loadHole(holeIdx + 1);
    setPhase('intro');
  };

  const def = course[holeIdx];

  return (
    <div
      className="col"
      style={fullscreen
        ? {
            position: 'fixed', inset: 0, zIndex: 80, background: '#0b0f0c', gap: 6,
            padding: 'calc(env(safe-area-inset-top, 0px) + 8px) 8px calc(env(safe-area-inset-bottom, 0px) + 8px)',
            overflowY: 'auto',
          }
        : { gap: 10, position: 'relative' }}
    >
      {/* HUD strip */}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <b style={{ fontSize: 14 }}>Hole {holeIdx + 1}/{course.length} · {def.name}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>Par {def.par}</span>
        </span>
        <span className="row" style={{ gap: 10 }}>
          <Chip tone="muted"><span className="mono">Strokes {strokesNow}</span></Chip>
          <Chip tone={diff > 0 ? 'pending' : 'ok'}><span className="mono">Total {totalStrokes} ({diffLabel})</span></Chip>
          <Chip tone="burn"><Icon name="clock" size={11} /><span className="mono">{fmtMillis(clockMs)}</span></Chip>
          <Btn variant="ghost" sm onClick={() => setMusicOn(arcadeMusic.toggle())} >
            <Icon name={musicOn ? 'sound' : 'soundOff'} size={13} />
          </Btn>
          <Btn variant="ghost" sm onClick={onExit}><Icon name="x" size={12} /> Quit</Btn>
        </span>
      </div>

      <div style={fullscreen
        ? {
            position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-hi)',
            // As big as the viewport allows without breaking the aspect ratio
            // (HUD ≈ 80px); centered in the letterbox.
            width: `min(100%, calc((100dvh - 110px) * ${CANVAS_W / CANVAS_H}))`,
            margin: '0 auto',
          }
        : { position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-hi)' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'crosshair', background: '#101813' }}
        />

        {/* Hole intro card */}
        {phase === 'intro' && (
          <Overlay>
            <span className="mono" style={{ fontSize: 11, color: 'var(--burn-ink)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Hole {holeIdx + 1} of {course.length}</span>
            <h3 style={{ margin: 0 }}>{def.name}</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>Par {def.par} · drag back from the ball and release to putt</span>
            <Btn variant="primary" onClick={beginHole}><Icon name="flame" size={13} stroke="var(--char-950)" /> Putt</Btn>
          </Overlay>
        )}

        {/* Hole sunk */}
        {phase === 'sunk' && (
          <Overlay>
            <h3 style={{ margin: 0 }}>{sunkLabel}</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
              {perHole[perHole.length - 1]} stroke{perHole[perHole.length - 1] === 1 ? '' : 's'} on a par {def.par}
            </span>
            <Btn variant="primary" onClick={advance}>Next hole <Icon name="chevRight" size={13} stroke="var(--char-950)" /></Btn>
          </Overlay>
        )}

        {/* Sign-in gate after hole 1 — only anonymous visitors hit this now:
            every SIGNED-IN player has full access (2026-07-04). */}
        {phase === 'gate' && (
          <Overlay>
            <Icon name="lock" size={26} stroke="var(--haze-ink)" />
            <h3 style={{ margin: 0 }}>Sign in to keep playing</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13, maxWidth: 380, textAlign: 'center' }}>
              Holes 2–9 are free for every signed-in player. Staked players also earn
              lottery tickets while they play.
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Btn variant="secondary" onClick={onExit}>Back to Arcade</Btn>
            </span>
          </Overlay>
        )}

        {/* Final scorecard */}
        {phase === 'done' && (
          <Overlay wide>
            <h3 style={{ margin: 0 }}>Round complete</h3>
            <span style={{ color: 'var(--fg-2)', fontSize: 13 }}>
              {totalStrokes} strokes ({diffLabel} vs par {parTotal}) · {fmtMillis(clockMs)}
            </span>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 11.5, margin: '0 auto' }}>
                <tbody>
                  <tr>
                    <td style={SC_TD}>Hole</td>
                    {course.map((_, i) => <td key={i} style={SC_TD}>{i + 1}</td>)}
                  </tr>
                  <tr style={{ color: 'var(--fg-3)' }}>
                    <td style={SC_TD}>Par</td>
                    {course.map((h, i) => <td key={i} style={SC_TD}>{h.par}</td>)}
                  </tr>
                  <tr>
                    <td style={SC_TD}>You</td>
                    {perHole.map((s, i) => (
                      <td key={i} style={{ ...SC_TD, color: s < course[i].par ? 'var(--sprout-ink)' : s > course[i].par ? 'var(--haze-ink)' : 'var(--fg)' }}>{s}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {submitNote && (
              <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--burn-ink)' }}>{submitNote}</span>
                {submitAction && (
                  <Btn variant="secondary" sm onClick={submitAction.onClick}>{submitAction.label}</Btn>
                )}
              </span>
            )}
            <Btn variant="primary" onClick={onExit}>Back to Arcade</Btn>
          </Overlay>
        )}
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
        Drag back from the ball to aim — farther = harder. Sand slows, water costs a stroke, walkways carry the ball, bumpers spring it, 12-stroke pickup.
      </span>
    </div>
  );
}

const SC_TD: React.CSSProperties = { border: '1px solid var(--border)', padding: '4px 8px', textAlign: 'center' };

function Overlay({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(12, 10, 9, 0.78)', backdropFilter: 'blur(4px)',
    }}>
      <div className="col" style={{
        gap: 12, alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border-hi)',
        borderRadius: 12, padding: '24px 28px', maxWidth: wide ? 560 : 440, width: '92%', boxShadow: 'var(--elev-3)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ==========================================
// Rendering — scene via holeRender, overlays here
// ==========================================

function render(ctx: CanvasRenderingContext2D, g: GameRef, look: CharacterLook) {
  const { def, state } = g;
  const view = fitView(def, CANVAS_W, CANVAS_H);

  // Golfer — hidden the moment the ball is struck; back when it rests.
  const showGolfer = state.phase === 'resting' && (g.phase === 'play' || g.phase === 'intro');
  const stand = { x: state.pos.x - g.facing.x * 26, y: state.pos.y - g.facing.y * 26 };

  // tSec = the hole clock: windmill bars MUST stay in phase with the physics
  // (decorative water/belt animation pausing outside 'play' is acceptable).
  renderHoleScene(ctx, def, view, {
    tSec: g.holeClock,
    ball: state.phase !== 'sunk' ? state.pos : null,
    golfer: showGolfer ? { stand, look, aiming: g.aiming } : null,
  });

  // ── Effects (screen-space, on top) ──
  if (g.splash > 0) drawSplash(ctx, view, state.preShot, g.splash);
  if (state.phase === 'resting' && g.aiming) drawAim(ctx, view, g);
}

function drawSplash(ctx: CanvasRenderingContext2D, view: IsoView, at: Vec, t: number) {
  const p = isoP(view, at.x, at.y, 0);
  ctx.strokeStyle = `rgba(150, 200, 255, ${t})`;
  ctx.lineWidth = 2;
  const r = (1 - t) * 26 + 6;
  ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
}

function drawAim(ctx: CanvasRenderingContext2D, view: IsoView, g: GameRef) {
  const shot = dragToShot(g.drag);
  const power = speed(shot) / MAX_POWER;
  if (power === 0) return;
  const dirX = shot.x / speed(shot), dirY = shot.y / speed(shot);
  const ball = g.state.pos;
  // Dotted aim line in the fire direction, length ∝ power.
  const dots = Math.round(4 + power * 9);
  ctx.fillStyle = '#e8602c';
  for (let i = 1; i <= dots; i++) {
    const d = i * 14;
    const p = isoP(view, ball.x + dirX * d, ball.y + dirY * d, 2);
    const r = 3.2 - (i / dots) * 1.8;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Pull-back "rubber band" behind the ball.
  const pullLen = power * 60;
  const bp = isoP(view, ball.x, ball.y, 2);
  const back = isoP(view, ball.x - dirX * pullLen, ball.y - dirY * pullLen, 2);
  ctx.strokeStyle = 'rgba(232, 96, 44, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bp.x, bp.y); ctx.lineTo(back.x, back.y); ctx.stroke();
  // Power bar (screen space).
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(20, CANVAS_H - 26, 140, 10);
  ctx.fillStyle = power > 0.85 ? '#e2447e' : '#e8602c';
  ctx.fillRect(20, CANVAS_H - 26, 140 * power, 10);
}
